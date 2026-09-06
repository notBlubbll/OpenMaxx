// grep-fix plugin — OpenCode V2.
// The grep tool's `include` parameter is a SINGLE glob string. The server
// (packages/core/src/ripgrep.ts) passes it as one `--glob=` flag: arrays are
// rejected by schema validation ("Expected string") and comma-separated lists
// are treated as one literal glob. Earlier versions of this plugin merged
// exclusion globs into an ARRAY, which broke EVERY grep call.
//
// This version:
//   1. execute.before: normalizes invalid include shapes (arrays/other) into a
//      single valid glob string so calls always satisfy the tool schema.
//   2. execute.after: converts the 64KB single-match-line error (the server
//      caps JSON records at 64KB, MAX_RECORD_BYTES) into actionable text.
export default {
  id: "grep-fix",
  async setup(ctx) {
    // 1) Before grep runs, make sure include is a single string if present.
    const hook = async (event) => {
      if (event.tool !== "grep") return
      const input = event.input || {}
      const inc = input.include
      if (inc === undefined || inc === null) return // omitted: valid
      if (typeof inc === "string") return // single glob: valid
      // Invalid shape (e.g. an array the model produced): coerce to the first
      // non-negation glob, or drop include entirely if there is none.
      const list = Array.isArray(inc) ? inc.map(String) : [String(inc)]
      const positive = list.find((g) => !g.startsWith("!"))
      const next = positive ?? list[0] ?? ""
      const merged = { ...input }
      if (next) merged.include = next
      else delete merged.include
      event.input = merged
    }

    // 2) After grep, turn the opaque 64KB error into something the agent can act on.
    const after = (event) => {
      if (event.tool !== "grep") return
      if (event.status === "error") {
        const msg = String((event.error && event.error.message) || event.error || "")
        if (msg.includes("65536") || msg.includes("Ripgrep JSON record exceeded")) {
          const guide =
            "grep hit the 64KB single-match-line limit. A matching line was longer than 64KB, " +
            "which the grep tool cannot return (typically a generated JSON or minified vendor file). " +
            "To find this match, search a narrower path or include filter, or single out the file."
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
