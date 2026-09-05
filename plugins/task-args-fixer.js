// task-args-fixer plugin: repairs malformed Task tool calls instead of failing them.
// If the model omits "subagent_type" (SchemaError: Missing key), infer it from the
// description prefix ([💭Summarizer] -> summarizer, [✏️Edit] -> edit, [🔎Research] -> research,
// [🕵🏻‍♂️Detective] -> detective, [🤖Coordinate] -> coordinator) or from prompt content.

export const TaskArgsFixer = async () => {
  const TYPE_MARKERS = [
    ["[💭Summarizer]", "research"],
    ["[✏️Edit]", "edit"],
    ["[🔎Research]", "research"],
    ["[🕵🏻‍♂️Detective]", "detective"],
    ["[🕵🏼‍♂️Detective]", "detective"],
    ["[🤖Coordinate]", "coordinator"],
  ]

  const TAG_PREFIX = {
    coordinator: "[🤖Coordinate] ",
    edit: "[✏️Edit] ",
    research: "[🔎Research] ",
    detective: "[🕵🏼‍♂️Detective] ",
    general: "[🤖General] ",
    explore: "[🔎Explore] ",
    title: "[🏷️Title] ",
  }

  function inferType(args) {
    const desc = String(args.description || "")
    for (const [marker, type] of TYPE_MARKERS) {
      if (desc.includes(marker) || desc.toLowerCase().includes(marker.replace(/[^\w]/g, "").toLowerCase())) return type
    }
    const d = desc.toLowerCase()
    if (d.includes("summarizer")) return "research"
    if (d.includes("edit")) return "edit"
    if (d.includes("research")) return "research"
    if (d.includes("detective")) return "detective"
    if (d.includes("coordinator") || d.includes("coordinate")) return "coordinator"
    // prompt-based fallback
    const p = String(args.prompt || "")
    if (p.includes("<<<FINDINGS>>>") || p.includes(".opencode-findings")) return "research"
    return undefined
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") return
      const args = output.args
      if (args == null) return
      // normalize: opencode may pass subagentType vs subagent_type
      if (!args.subagent_type && args.subagentType) {
        args.subagent_type = args.subagentType
        delete args.subagentType
      }
      if (!args.subagent_type) {
        const t = inferType(args)
        if (t) {
          args.subagent_type = t
          console.error(`[task-args-fixer] injected missing subagent_type="${t}" (description: ${String(args.description || "").slice(0, 60)})`)
        }
      }
      // ensure the description always carries the correct emoji tag prefix for its type
      const description = String(args.description || "")
      if (description && !/^\[\S+\] /.test(description)) {
        const tag = TAG_PREFIX[args.subagent_type] || "[🤖Sub] "
        args.description = tag + description
        console.error(`[task-args-fixer] prefixed description with "${tag}" (subagent_type: ${args.subagent_type || "unknown"})`)
      }
    },
  }
}

