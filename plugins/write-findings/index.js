// write-findings plugin — OpenCode V2.
// Replaces the summarizer subagent with a deterministic, instant file-write tool.
// Uses ctx.tool.transform() (V2 API), not the V1 @opencode-ai/plugin SDK.

export default {
  id: "write-findings",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "write_findings",
        description:
          "Write a findings/report markdown file to disk. Use this INSTEAD of spawning a summarizer subagent. " +
          "path must be an absolute Windows path containing .opencode-findings. body is the full markdown content written verbatim. " +
          "Returns 'WRITTEN: <path> (<n> bytes)'.",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Absolute Windows path under .opencode-findings, e.g. C:\\proj\\.opencode-findings\\report.md",
            },
            body: {
              type: "string",
              description: "Full markdown findings content, written verbatim",
            },
          },
          required: ["path", "body"],
          additionalProperties: false,
        },
        execute: async (args) => {
          const path = String(args.path || "").trim()
          const body = String(args.body || "")
          if (!path.includes(".opencode-findings")) {
            return { output: "ERROR: path must contain .opencode-findings, got: " + path }
          }
          const { mkdir, writeFile } = await import("node:fs/promises")
          const { dirname } = await import("node:path")
          const normalized = path.replace(/(?<![\/\\])\.opencode-findings/, "\\opencode-findings")
          try {
            const dir = dirname(normalized)
            await mkdir(dir, { recursive: true })
            await writeFile(normalized, body, "utf8")
            return { output: `WRITTEN: ${normalized} (${Buffer.byteLength(body, "utf8")} bytes)` }
          } catch (e) {
            return { output: "WRITE-FAILED: " + normalized + " :: " + (e && e.message ? e.message : String(e)) }
          }
        },
      })
    })
  },
}
