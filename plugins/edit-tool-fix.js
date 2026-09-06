// edit-tool-fix plugin — OpenCode V2.
//
// Fixes common edit tool failures BEFORE execution:
//   1. Path normalization (mixed slashes, trailing quotes)
//   2. Line-ending normalization (CRLF -> LF for matching)
//
// Notes:
//   - Loaded as a plain .js entrypoint (same pattern as grep-fix.js). The old
//     directory version (edit-tool-fix/index.ts) imported `Plugin` from
//     @opencode-ai/plugin, but the installed npm package is the V1 SDK
//     (1.14.31) which does not export `Plugin` — the loader rejected it.
//   - The edit tool's path parameter is `path` (not `filePath`); both are
//     handled below for compatibility.
//   - Never add extra keys to event.input: the tool schema is validated after
//     before-hooks run, and unknown keys can fail strict decoding.

export default {
  id: "edit-tool-fix",
  async setup(ctx) {
    // Hook into edit tool before execution
    await ctx.tool.hook("execute.before", (event) => {
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

      // 2. Normalize line endings for better exact matching
      if (typeof input.oldString === "string") {
        input.oldString = normalizeLineEndings(input.oldString)
      }
      if (typeof input.newString === "string") {
        input.newString = normalizeLineEndings(input.newString)
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
              const normalized = normalizePath(op.path)
              if (normalized !== op.path) {
                op.path = normalized
                modified = true
              }
            }
            // Normalize line endings in replace ops
            if (op && typeof op.oldString === "string") {
              const normalized = normalizeLineEndings(op.oldString)
              if (normalized !== op.oldString) {
                op.oldString = normalized
                modified = true
              }
            }
          }
        }

        if (modified) {
          input.ops = stringifyOps(ops, typeof input.ops === "string")
        }
      } catch (e) {
        // Invalid JSON, let it fail naturally
      }
    })

    console.log("[edit-tool-fix] Plugin loaded successfully")
  },
}

/**
 * Normalize file path:
 * - Fix mixed slashes (convert all to backslashes on Windows)
 * - Remove trailing quotes
 * - Normalize multiple slashes
 */
function normalizePath(path) {
  if (!path) return path

  // Remove trailing quotes
  let normalized = path.replace(/["']+\s*$/, "")

  // Normalize slashes (Windows prefers backslashes)
  normalized = normalized.replace(/\//g, "\\")

  // Remove trailing backslash
  normalized = normalized.replace(/\\+$/, "")

  // Normalize multiple backslashes
  normalized = normalized.replace(/\\+/g, "\\")

  return normalized
}

/**
 * Normalize line endings:
 * - Convert CRLF to LF for consistent matching
 */
function normalizeLineEndings(text) {
  if (!text) return text
  return text.replace(/\r\n/g, "\n")
}
