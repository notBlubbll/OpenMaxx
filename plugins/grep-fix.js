// grep-fix plugin — OpenCode V2.
// Workaround for the grep tool's 64KB-per-match-line cap (the tool parses rg's
// JSON and errors "Ripgrep JSON record exceeded 65536 bytes" when a single
// matching line is > 64KB; ripgrep itself is fine). ripgrep runs in the server,
// so a plugin cannot raise that cap directly. Instead this plugin:
//   1. execute.before: appends negative globs so grep skips the classes of files
//      that reliably contain >64KB single lines (generated build output and
//      minified bundles), preventing the failure.
//   2. execute.after: converts a remaining 64KB error into clear, actionable text.
//
// Edit EXCLUSIONS below if you want a different set of skipped files.
export default {
  id: "grep-fix",
  async setup(ctx) {
    const EXCLUSIONS = [
      "!**/bin/**",
      "!**/obj/**",
      "!**/dist/**",
      "!**/out/**",
      "!**/node_modules/**",
      "!**/*.min.js",
      "!**/*.min.css",
      "!**/*.bundle.js",
      "!**/vendor*.js",
    ]

    // 1) Before grep runs, add exclusions to the include glob list.
    const hook = async (event) => {
      if (event.tool !== "grep") return
      const input = event.input || {}
      const existing = input.include
      const existingArr = Array.isArray(existing) ? existing : existing ? [String(existing)] : []
      const add = EXCLUSIONS.filter((g) => !existingArr.includes(g))
      if (add.length === 0) return
      // Preserve the original include shape if we can, else store an array.
      const merged =
        existing && existing.length !== 0 && !Array.isArray(existing)
          ? [String(existing)].concat(add)
          : existingArr.concat(add)
      event.input = { ...input, include: merged }
    }

    // 2) After grep, turn the opaque 64KB error into something the agent can act on.
    const after = (event) => {
      if (event.tool !== "grep") return
      if (event.status === "error") {
        const msg = String((event.error && event.error.message) || event.error || "")
        if (msg.includes("65536") || msg.includes("Ripgrep JSON record exceeded")) {
          const guide =
            "grep hit the 64KB single-match-line limit. A matching line was longer than 64KB, " +
            "which the grep tool cannot return (typically a generated JSON or minified ' .js vendor file). " +
            "Generated build output (bin/obj/dist), node_modules, and *.min.* / *.bundle.* files are excluded " +
            "automatically. To find this match, search a narrower path or include filter, or single out the file."
          if (event.result) event.result = { content: guide }
          else if (event.error) event.error.message = guide + "\n\nOriginal: " + msg
        }
      }
    }

    if (ctx.tool && typeof ctx.tool.hook === "function") {
      await ctx.tool.hook("execute.before", hook)
      await ctx.tool.hook("execute.after", after)
      console.log("[grep-fix] Plugin loaded successfully")
    } else {
      console.log("[grep-fix] WARN: ctx.tool.hook API not found")
    }
  },
}
