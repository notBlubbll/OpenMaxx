// grep-fix plugin — OpenCode V2.
// The grep tool's `include` parameter is a SINGLE glob string.
// This version normalizes invalid include shapes into a single valid glob string.

export default {
  id: "grep-fix",
  async setup(ctx) {
    const hook = async (event) => {
      if (event.tool !== "grep") return
      const input = event.input || {}
      const inc = input.include
      if (inc === undefined || inc === null) return
      if (typeof inc === "string") return
      const list = Array.isArray(inc) ? inc.map(String) : [String(inc)]
      const positive = list.find((g) => !g.startsWith("!"))
      const next = positive ?? list[0] ?? ""
      const merged = { ...input }
      if (next) merged.include = next
      else delete merged.include
      event.input = merged
    }
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
    await ctx.tool.hook("execute.before", hook)
    await ctx.tool.hook("execute.after", after)
    console.log("[grep-fix] Plugin loaded successfully")
  },
}
