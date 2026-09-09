// edit-tool-fix plugin - OpenCode V2.
//
// Fixes common edit tool failures:
//   1. Path normalization (mixed slashes, trailing quotes; accepts `path` and legacy `filePath`)
//   2. Line-ending normalization (CRLF -> LF for matching)
//   3. Fuzzy oldString matching - if exact match fails, find via
//      whitespace-collapsed comparison, then substitute the ORIGINAL bytes
//      from the file so the edit tool gets an exact hit on first attempt.
//   4. Longest-common-substring fallback - if fuzzy matching still fails,
//      find the longest shared substring (>= 30 chars), verify the matched
//      region covers >= 80% of oldString's non-whitespace content, and
//      substitute the surrounding line region from the file.
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
    try {
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
              let fixedOld = fuzzyFindOriginal(fileContent, input.oldString)
              if (fixedOld === null) {
                // Last-resort fallback: longest common substring, expanded
                // to line boundaries in the file.
                fixedOld = longestCommonSubstringFallback(fileContent, input.oldString)
              }
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

    // Validate hook registration
    if (!ctx.tool || typeof ctx.tool.hook !== "function") {
      const err = !ctx.tool ? "ctx.tool is undefined" : "ctx.tool.hook is not a function"
      console.warn("[edit-tool-fix] Plugin setup failed — fuzzy rescue will not be active: " + err)
    }
    } catch (e) {
      console.warn("[edit-tool-fix] Plugin setup failed — fuzzy rescue will not be active: " + (e && e.message ? e.message : String(e)))
    }
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

  // --- Line-based matching: tolerates indentation drift between oldString
  // and the file. Each oldString line is matched to a file line via
  // whitespace-collapsed comparison, and the matched lines must be
  // contiguous in the file (±1 line tolerance for extra blank lines).
  const lines = fileContent.split('\n')
  const oldLines = oldString.split('\n')
  const expectedTokens = collapsedOld.split(/\s+/).filter(Boolean)
  const collapsedOldLines = oldLines.map((l) => collapseWhitespace(l))

  for (let start = 0; start < lines.length; start++) {
    // Anchor: the first oldString line must match this file line
    if (collapseWhitespace(lines[start]) !== collapsedOldLines[0]) continue

    // Walk forward: each subsequent oldString line matches a file line at
    // most 1 line further than the previous match (blank-line tolerance)
    let fIdx = start + 1
    let last = start
    let ok = true
    for (let j = 1; j < oldLines.length; j++) {
      let found = -1
      for (let probe = fIdx; probe <= Math.min(fIdx + 1, lines.length - 1); probe++) {
        if (collapseWhitespace(lines[probe]) === collapsedOldLines[j]) {
          found = probe
          break
        }
      }
      if (found === -1) { ok = false; break }
      last = found
      fIdx = found + 1
    }
    if (!ok) continue

    // Extract the ORIGINAL bytes of the matched region
    const candidate = lines.slice(start, last + 1).join('\n')

    // Token safety check: same non-whitespace tokens in order (rejects false positives)
    const candTokens = collapseWhitespace(candidate).split(/\s+/).filter(Boolean)
    if (candTokens.length !== expectedTokens.length) continue
    let safe = true
    for (let i = 0; i < expectedTokens.length; i++) {
      if (candTokens[i] !== expectedTokens[i]) { safe = false; break }
    }
    if (safe) return candidate
  }

  // --- Fallback: full-collapsed matching (existing behavior) ---
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

/**
 * Longest common substring fallback (last resort when fuzzy matching fails).
 *
 * 1. Finds the longest substring shared between `oldString` and
 *    `fileContent` (must be at least 30 chars to be meaningful) via
 *    binary search over substring length (existence is monotone).
 * 2. Aligns all longest-length matches; the offset with the most aligned
 *    windows is where the two strings genuinely overlap.
 * 3. Extracts the surrounding region from the file (expanded to line
 *    boundaries) and checks plausibility: the region must contain at
 *    least 80% of oldString's non-whitespace tokens.
 *
 * Returns the region (an exact substring of `fileContent`) or null.
 */
function longestCommonSubstringFallback(fileContent, oldString) {
  const MIN_COMMON = 30
  if (typeof oldString !== "string" || oldString.length < MIN_COMMON) return null
  if (typeof fileContent !== "string" || fileContent.length < MIN_COMMON) return null

  // Monotone predicate: if a substring of length `len` is shared, so are
  // all shorter ones. Checked with a Set of `len`-windows over the
  // shorter side (oldString) and a sliding scan over the file.
  const hasCommon = (len) => {
    if (len > oldString.length || len > fileContent.length) return false
    const windows = new Set()
    for (let i = 0; i + len <= oldString.length; i++) {
      windows.add(oldString.substring(i, i + len))
    }
    for (let i = 0; i + len <= fileContent.length; i++) {
      if (windows.has(fileContent.substring(i, i + len))) return true
    }
    return false
  }

  const maxLen = Math.min(oldString.length, fileContent.length)
  if (!hasCommon(MIN_COMMON)) return null

  // Binary search the longest shared length.
  let lo = MIN_COMMON
  let hi = maxLen
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (hasCommon(mid)) { best = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (best < MIN_COMMON) return null

  // Collect all longest-length matches and group them by alignment offset
  // (fileStart - oldStart); the offset with the most aligned windows is
  // where oldString genuinely overlaps the file.
  const len = best
  const counts = new Map() // offset -> { count, fileStart }
  for (let i = 0; i + len <= oldString.length; i++) {
    const w = oldString.substring(i, i + len)
    let idx = fileContent.indexOf(w)
    while (idx !== -1) {
      const offset = idx - i
      const rec = counts.get(offset)
      if (rec) rec.count++
      else counts.set(offset, { count: 1, fileStart: idx })
      idx = fileContent.indexOf(w, idx + 1)
    }
  }
  let bestRec = null
  for (const rec of counts.values()) {
    if (!bestRec || rec.count > bestRec.count) bestRec = rec
  }
  if (!bestRec) return null

  // Matched region in the file, expanded to full line boundaries.
  const fileStart = bestRec.fileStart
  const fileEnd = fileStart + len
  const lineStart = fileStart === 0 ? 0 : fileContent.lastIndexOf("\n", fileStart - 1) + 1
  let lineEnd = fileContent.indexOf("\n", fileEnd)
  if (lineEnd === -1) lineEnd = fileContent.length

  const region = fileContent.substring(lineStart, lineEnd)

  // Plausibility check: the region must contain at least 80% of
  // oldString's non-whitespace content (word tokens).
  const oldTokens = oldString.split(/\s+/).filter(Boolean)
  if (oldTokens.length === 0) return null
  const regionCollapsed = collapseWhitespace(region)
  let covered = 0
  for (const t of oldTokens) {
    if (regionCollapsed.includes(t)) covered++
  }
  if (covered / oldTokens.length < 0.8) return null

  return region
}
