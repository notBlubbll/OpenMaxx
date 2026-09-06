// write-findings plugin — OpenCode V2.
// Replaces the summarizer subagent with a deterministic, instant file-write tool.
// Uses ctx.tool.transform() (V2 API), not the V1 @opencode-ai/plugin SDK.
//
// Two ways to pass body content:
//   1. body: "markdown string" — direct, but quotes/apostrophes in markdown can break JS strings
//   2. bodyFile: "/tmp/findings-body.txt" — write body to a temp file first, pass the path (avoids all string escaping)

export default {
  id: "write-findings",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "write_findings",
        description:
          "Write a findings/report markdown file to disk. " +
          "path: absolute Windows path containing .opencode-findings. " +
          "body: markdown content (direct string). OR bodyFile: path to a temp file containing the markdown. " +
          "Use bodyFile if the markdown has quotes or apostrophes that break JS strings. " +
          "Returns WRITTEN with the path and byte count.",
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
              description: "Full markdown findings content, written verbatim. Use only if body has no quotes/apostrophes.",
            },
            bodyFile: {
              type: "string",
              description: "Path to a temp file containing the markdown body. Preferred — avoids JS string escaping issues.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: {
            output: { type: "string" },
          },
        },
        execute: async (args) => {
          const path = String(args.path || "").trim()
          if (!path.includes(".opencode-findings")) {
            return { output: "ERROR: path must contain .opencode-findings, got: " + path }
          }

          let body = ""
          if (args.bodyFile) {
            // Read body from a temp file (avoids string escaping issues)
            const { readFile } = await import("node:fs/promises")
            try {
              body = await readFile(String(args.bodyFile), "utf8")
            } catch (e) {
              return { output: "READ-FAILED: could not read bodyFile: " + args.bodyFile + " :: " + (e.message || String(e)) }
            }
          } else if (args.body) {
            body = String(args.body)
          } else {
            return { output: "ERROR: either body or bodyFile is required" }
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
