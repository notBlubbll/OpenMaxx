// edit-tool-fix plugin — OpenCode V2.
//
// Fixes common edit tool failures BEFORE execution:
//   1. Path normalization (mixed slashes, trailing quotes)
//   2. Line-ending normalization (CRLF -> LF for matching)
//
// V2: uses ctx.tool.hook("execute.before") for pre-execution transforms.

export default {
  id: "edit-tool-fix",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "edit") return
      const input = event.input || {}
      const rawPath = input.path ?? input.filePath
      if (typeof rawPath === "string" && rawPath.length > 0) {
        const normalized = normalizePath(rawPath)
        if (normalized !== rawPath) {
          if (input.path !== undefined) input.path = normalized
          if (input.filePath !== undefined) input.filePath = normalized
        }
      }
      if (typeof input.oldString === "string") input.oldString = normalizeLineEndings(input.oldString)
      if (typeof input.newString === "string") input.newString = normalizeLineEndings(input.newString)
    })
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
              if (normalized !== op.path) { op.path = normalized; modified = true }
            }
            if (op && typeof op.oldString === "string") {
              const normalized = normalizeLineEndings(op.oldString)
              if (normalized !== op.oldString) { op.oldString = normalized; modified = true }
            }
          }
        }
        if (modified) input.ops = stringifyOps(ops, typeof input.ops === "string")
      } catch (e) {}
    })
    console.log("[edit-tool-fix] Plugin loaded successfully")
  },
}

function normalizePath(path) {
  if (!path) return path
  let normalized = path.replace(/["']+$/ , "")
  normalized = normalized.replace(/\//g, "\\")
  normalized = normalized.replace(/\\+$/, "")
  normalized = normalized.replace(/\\+/g, "\\")
  return normalized
}

function normalizeLineEndings(text) {
  if (!text) return text
  return text.replace(/\r\n/g, "\n")
}
