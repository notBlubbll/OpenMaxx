// write-findings plugin: custom tool that replaces the summarizer subagent.
// The model calls write_findings({ path, body }) and the file is written directly —
// no subagent spawn, no LLM call, instant and deterministic.

import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { tool } from "@opencode-ai/plugin"

export const WriteFindings = async () => {
  return {
    tool: {
      write_findings: tool({
        description:
          "Write a findings/report markdown file to disk. Use this INSTEAD of spawning a summarizer subagent. " +
          "path must be an absolute Windows path containing \\.opencode-findings\\. body is the full markdown content written verbatim. " +
          "Returns 'WRITTEN: <path> (<n> bytes)'.",
        args: {
          path: tool.schema.string().describe("Absolute Windows path under .opencode-findings, e.g. C:\\proj\\.opencode-findings\\report.md"),
          body: tool.schema.string().describe("Full markdown findings content, written verbatim"),
        },
        async execute(args) {
          const path = String(args.path || "").trim()
          const body = String(args.body || "")
          if (!path.includes(".opencode-findings")) {
            return "ERROR: path must contain .opencode-findings — got: " + path
          }
          const normalized = path.replace(/(?<![\\/])\.opencode-findings/, "\\.opencode-findings")
          try {
            const dir = dirname(normalized)
            await mkdir(dir, { recursive: true })
            await writeFile(normalized, body, "utf8")
            return `WRITTEN: ${normalized} (${Buffer.byteLength(body, "utf8")} bytes)`
          } catch (e) {
            return "WRITE-FAILED: " + normalized + " :: " + (e && e.message ? e.message : String(e))
          }
        },
      }),
    },
  }
}
