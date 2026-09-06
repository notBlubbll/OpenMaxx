// write-findings plugin — OpenCode V2.
// Uses ctx.tool.transform() (V2 API), not the V1 @opencode-ai/plugin SDK.
//
// Three ways to pass body content (in order of preference):
//   1. bodyBase64: base64-encoded markdown — safest, zero escaping issues
//   2. bodyFile: path to a temp file containing the markdown — avoids string escaping
//   3. body: direct markdown string — only for short text with no quotes/apostrophes

export default {
  id: "write-findings",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "write_findings",
        description:
          "Write a findings/report markdown file to disk. path: absolute path containing .opencode-findings. " +
          "Content via ONE OF: bodyBase64 (base64-encoded, safest), bodyFile (path to temp file), or body (direct string). " +
          "Returns WRITTEN with path and byte count.",
        input: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute Windows path under .opencode-findings",
            },
            bodyBase64: {
              type: "string",
              description: "Base64-encoded markdown content. Safest option — no escaping issues.",
            },
            bodyFile: {
              type: "string",
              description: "Path to a file containing the markdown body.",
            },
            body: {
              type: "string",
              description: "Direct markdown string. Only for short text with no quotes/apostrophes.",
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
          if (args.bodyBase64) {
            // Decode base64 — zero escaping issues
            body = Buffer.from(String(args.bodyBase64), "base64").toString("utf8")
          } else if (args.bodyFile) {
            // Read from temp file
            const { readFile } = await import("node:fs/promises")
            try {
              body = await readFile(String(args.bodyFile), "utf8")
            } catch (e) {
              return { output: "READ-FAILED: " + args.bodyFile + " :: " + (e.message || String(e)) }
            }
          } else if (args.body) {
            body = String(args.body)
          } else {
            return { output: "ERROR: one of bodyBase64, bodyFile, or body is required" }
          }

          const { mkdir, writeFile } = await import("node:fs/promises")
          const { dirname } = await import("node:path")
          const normalized = path.replace(/(?<![\/\\])\.opencode-findings/, "\\opencode-findings")
          try {
            await mkdir(dirname(normalized), { recursive: true })
            await writeFile(normalized, body, "utf8")
            return { output: `WRITTEN: ${normalized} (${Buffer.byteLength(body, "utf8")} bytes)` }
          } catch (e) {
            return { output: "WRITE-FAILED: " + normalized + " :: " + (e.message || String(e)) }
          }
        },
      })
    })
  },
}
