// edit-tool-fix plugin - OpenCode V2.
//
// Fixes common edit tool failures:
//   1. Path normalization (mixed slashes, trailing quotes; accepts `path` and legacy `filePath`)
//   2. Line-ending normalization (CRLF -> LF for matching)
//   3. Fuzzy oldString matching - if exact match fails, find via
//      whitespace-collapsed comparison, then substitute the ORIGINAL bytes
//      from the file so the edit tool gets an exact hit on first attempt.
//
// IMPORTANT: after mutating `input`, we MUST reassign `event.input`
// (event.input = { ...input }). In-place mutation alone does NOT propagate
// back to the tool runtime - the hook receives a snapshot. Without the
// reassignment the fix silently never fires (observed 2026-09-07).
//
// V2: uses ctx.tool.hook("execute.before") via V2 API.

export default {
  id: "edit-tool-fix",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "edit") return

      const input = event.input || {}
      let touched = false

      // 1. Normalize path (accept both `path` and legacy `filePath`)
      const rawPath = input.path ?? input.filePath
      if (typeof rawPath === "string" && rawPath.length > 0) {
        const normalized = normalizePath(rawPath)
        if (normalized !== rawPath) {
          if (input.path !== undefined) input.path = normalized
          if (input.filePath !== undefined) input.filePath = normalized
          touched = true
        }
      }

      // 2. Normalize line endings in oldString/newString
      if (typeof input.oldString === "string") {
        const n = normalizeLineEndings(input.oldString)
        if (n !== input.oldString) { input.oldString = n; touched = true }
      }
      if (typeof input.newString === "string") {
        const n = normalizeLineEndings(input.newString)
        if (n !== input.newString) { input.newString = n; touched = true }
      }

      // 3. Fuzzy oldString matching
      if (typeof input.oldString === "string" && input.oldString.length > 0) {
        const filePath = input.path ?? input.filePath
        if (typeof filePath === "string") {
          try {
            const { readFileSync } = await import("node:fs")
            const fileContent = readFileSync(filePath, "utf8")

            if (!fileContent.includes(input.oldString)) {
              const fixedOld = fuzzyFindOriginal(fileContent, input.oldString)
              if (fixedOld !== null) {
                input.oldString = fixedOld
                touched = true
              }
            }
          } catch (e) {
            // File read failed - let the edit tool handle it naturally
          }
        }
      }

      // Propagate mutations back to the runtime (required - see header).
      if (touched) {
        event.input = { ...input }
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
              const n = normalizePath(op.path)
              if (n !== op.path) { op.path = n; modified = true }
            }
            if (op && typeof op.oldString === "string") {
              const n = normalizeLineEndings(op.oldString)
              if (n !== op.oldString) { op.oldString = n; modified = true }
            }
          }
        }

        if (modified) {
          input.ops = stringifyOps(ops, typeof input.ops === "string")
          event.input = { ...input }
        }
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
 * then trim - used to find the approximate position of oldString in the file.
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
  const origPositions = [] // origPositions[collapsedPos] = originalPos
  let collPos = 0
  let inWsRun = false

  for (let origPos = 0; origPos < fileContent.length; origPos++) {
    const ch = fileContent[origPos]
    const isWs = /\s/.test(ch)

    if (isWs) {
      if (!inWsRun) {
        origPositions[collPos] = origPos
        collPos++ // the single space
        inWsRun = true
      }
    } else {
      origPositions[collPos] = origPos
      collPos++
      inWsRun = false
    }
  }
  origPositions[collPos] = fileContent.length

  const origStart = origPositions[idx]
  const origEnd = origPositions[idx + collapsedOld.length]

  if (origStart === undefined || origEnd === undefined) return null

  const candidate = fileContent.substring(origStart, origEnd)

  // Sanity check: same non-whitespace tokens in order (rejects false positives)
  const oldTokens = collapsedOld.split(/\s+/).filter(Boolean)
  const candTokens = collapseWhitespace(candidate).split(/\s+/).filter(Boolean)

  if (oldTokens.length !== candTokens.length) return null
  for (let i = 0; i < oldTokens.length; i++) {
    if (oldTokens[i] !== candTokens[i]) return null
  }

  return candidate
}
