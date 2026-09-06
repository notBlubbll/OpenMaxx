// edit-tool-fix plugin — OpenCode V2.
//
// Fixes common edit tool failures:
//   1. Path normalization (mixed slashes, trailing quotes)
//   2. Line-ending normalization (CRLF -> LF for matching)
//   3. Fuzzy oldString matching — if exact match fails, normalize whitespace
//      in both file content and oldString to find the closest match, then
//      use the ORIGINAL bytes at that position so the edit tool gets an
//      exact hit on its first attempt.
//
// V2: uses ctx.tool.hook("execute.before") via V2 API.

export default {
  id: "edit-tool-fix",
  async setup(ctx) {
    // Hook into edit tool before execution (async — can await file reads)
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "edit") return

      const input = event.input || {}

      // 1. Normalize path (accept both `path` and legacy `filePath`)
      const rawPath = input.path ?? input.filePath
      if (typeof rawPath === "string" && rawPath.length > 0) {
        const normalized = normalizePath(rawPath)
        if (normalized !== rawPath) {
          if (input.path !== undefined) input.path = normalized
          if (input.filePath !== undefined) input.filePath = normalized
        }
      }

      // 2. Normalize line endings in oldString/newString
      if (typeof input.oldString === "string") {
        input.oldString = normalizeLineEndings(input.oldString)
      }
      if (typeof input.newString === "string") {
        input.newString = normalizeLineEndings(input.newString)
      }

      // 3. Fuzzy oldString matching: if oldString doesn't appear in the file,
      //    find the closest match via whitespace-collapsed comparison and
      //    replace oldString with the ORIGINAL bytes from the file.
      if (typeof input.oldString === "string" && input.oldString.length > 0) {
        const filePath = input.path ?? input.filePath
        if (typeof filePath === "string") {
          try {
            const { readFileSync } = await import("node:fs")
            const fileContent = readFileSync(filePath, "utf8")

            // Quick check: does oldString already appear in the file?
            if (!fileContent.includes(input.oldString)) {
              // Fuzzy: find via whitespace-collapsed matching
              const fixedOld = fuzzyFindOriginal(fileContent, input.oldString)
              if (fixedOld !== null) {
                input.oldString = fixedOld
              }
            }
          } catch (e) {
            // File read failed — let the edit tool handle it naturally
          }
        }
      }
    })

    // Also handle edit-ops tool (batch edits) when present
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "edit-ops") return

      const input = event.input || {}
      if (!input.ops) return

      try {
        const parseOps = (v) => (typeof v === "string" ? JSON.parse(v) : v)
        const stringifyOps = (v, wasString) => (wasString ? JSON.stringify(v) : v)
        const ops = parseOps(input.ops)
        let modified = false

        if (Array.isArray(ops)) {
          for (const op of ops) {
            if (op && typeof op.path === "string") {
              op.path = normalizePath(op.path)
            }
            if (op && typeof op.oldString === "string") {
              op.oldString = normalizeLineEndings(op.oldString)
            }
          }
        }

        input.ops = stringifyOps(ops, typeof input.ops === "string")
      } catch (e) {
        // Invalid JSON, let it fail naturally
      }
    })

    console.log("[edit-tool-fix] Plugin loaded successfully (with fuzzy match)")
  },
}

// --- Helpers ---

function normalizePath(path) {
  if (!path) return path
  let n = path.replace(/["']+$/, "")
  n = n.replace(/\//g, "\\")
  n = n.replace(/\\+$/, "")
  n = n.replace(/\\+/g, "\\")
  return n
}

function normalizeLineEndings(text) {
  if (!text) return text
  return text.replace(/\r\n/g, "\n")
}

/**
 * Collapse all whitespace runs (spaces, tabs, newlines) to single spaces,
 * then trim — used to find the approximate position of oldString in the file.
 */
function collapseWhitespace(s) {
  return s.replace(/[\s]+/g, " ").trim()
}

/**
 * Try to find `oldString` in `fileContent` via whitespace-collapsed matching.
 * Returns the ORIGINAL bytes from fileContent at the matching region, or null.
 */
function fuzzyFindOriginal(fileContent, oldString) {
  const collapsedOld = collapseWhitespace(oldString)
  if (collapsedOld.length < 5) return null // too short to safely fuzzy-match

  const collapsedFile = collapseWhitespace(fileContent)

  // Find the collapsed oldString in the collapsed file
  const idx = collapsedFile.indexOf(collapsedOld)
  if (idx === -1) return null

  // Map collapsed-file positions back to original file positions.
  // Walk the original file, tracking which original position maps to
  // which collapsed position.
  const origPositions = [] // origPositions[collapsedPos] = originalPos
  let collPos = 0
  let inWsRun = false

  for (let origPos = 0; origPos < fileContent.length; origPos++) {
    const ch = fileContent[origPos]
    const isWs = /\s/.test(ch)

    if (isWs) {
      if (!inWsRun) {
        // Start of a whitespace run — maps to a single space in collapsed
        origPositions[collPos] = origPos
        collPos++ // the single space
        inWsRun = true
      }
      // Skip original chars in the whitespace run
    } else {
      origPositions[collPos] = origPos
      collPos++
      inWsRun = false
    }
  }
  // Add final position
  origPositions[collPos] = fileContent.length

  // Map the match range [idx, idx+collapsedOld.length) back to original
  const origStart = origPositions[idx]
  const origEnd = origPositions[idx + collapsedOld.length]

  if (origStart === undefined || origEnd === undefined) return null

  const candidate = fileContent.substring(origStart, origEnd)

  // Sanity check: the candidate should contain all the non-whitespace tokens
  // of oldString (in order). If not, this is a false positive.
  const oldTokens = collapsedOld.split(/\s+/).filter(Boolean)
  const candTokens = collapseWhitespace(candidate).split(/\s+/).filter(Boolean)

  if (oldTokens.length !== candTokens.length) return null
  for (let i = 0; i < oldTokens.length; i++) {
    if (oldTokens[i] !== candTokens[i]) return null
  }

  return candidate
}
