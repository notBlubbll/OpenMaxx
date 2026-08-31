// write: OVERRIDE of the built-in write tool. Accepts optional content so the call
// always passes schema validation; missing content returns guidance instead of SchemaError.

import { writeFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { tool } from "@opencode-ai/plugin"

export default tool({
  description:
    "Write a file (overwrite/create). For batch edits prefer the edit-ops tool. " +
    "If content is omitted, no file is written and guidance is returned.",
  args: {
    filePath: tool.schema.string().describe("Absolute file path"),
    content: tool.schema.string().optional().describe("Full file content written verbatim"),
  },
  async execute(args) {
    const p = String(args.filePath || "").trim()
    if (args.content === undefined || args.content === null) {
      return ("NO-CONTENT: no content provided for " + p + ". " +
        "Do NOT retry write. Use the edit-ops tool instead: edit-ops({ cwd: <project root>, ops: '[{\"op\":\"write\",\"path\":\"<relative path>\",\"content\":\"<full content>\"}]' }) " +
        "or write_findings({ path, body }) for .opencode-findings reports.")
    }
    const normalized = p.replace(/(?<![\\/])\.opencode-findings/g, "\\.opencode-findings")
    try {
      const dir = dirname(normalized)
      await mkdir(dir, { recursive: true })
      await writeFile(normalized, String(args.content), "utf8")
      return `WRITTEN: ${normalized} (${Buffer.byteLength(String(args.content), "utf8")} bytes)`
    } catch (e) {
      return "WRITE-FAILED: " + normalized + " :: " + (e && e.message ? e.message : String(e))
    }
  },
})
