// edit-ops: deterministic file-edit operations executed WITHOUT an LLM.
// The caller (coordinator/primary) emits a structured ops plan; this tool applies it
// exactly. One call, all operations, atomic-ish per-op error reporting.
//
// Supported ops (the standard LLM edit-tool surface):
//   read            { path, offset?, limit? }                 -> returns content (or writes to nothing; result is reported)
//   write           { path, content }                         -> overwrite file (creates dirs)
//   replace         { path, oldString, newString, all? }      -> exact-string replace (first or all)
//   regex_replace   { path, pattern, replacement, all? }      -> regex replace
//   append          { path, content }                         -> append to end
//   prepend         { path, content }                         -> insert at start
//   insert_at_line  { path, line, content }                   -> 1-based insert BEFORE the line
//   delete_lines    { path, startLine, endLine }              -> 1-based inclusive removal
//   move            { from, to }                              -> rename/move file (creates dirs)
//   delete_file     { path }
//   mkdir           { path }
//   list            { path, pattern? }                        -> list directory (glob-ish by prefix)

import { readFile, writeFile, appendFile, rename, unlink, mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { tool } from "@opencode-ai/plugin"

function norm(p) {
  let s = String(p || "").trim()
  // glue-fix .opencode-findings style segments and collapse doubles
  s = s.replace(/(?<![\\/])\.opencode-findings/g, "\\.opencode-findings")
  s = s.replace(/([a-zA-Z]:)[\\/]+/g, "$1\\")
  s = s.replace(/\\\\/g, "\\")
  return s
}

async function ensureDir(p) {
  const d = dirname(p)
  if (d && !existsSync(d)) await mkdir(d, { recursive: true })
}

function lineSplit(content) {
  return content.split(/\r?\n/)
}

export default tool({
  description:
    "Execute a batch of deterministic file-edit operations WITHOUT an AI model. " +
    "Pass ops as a JSON array. Supported op types: read, write, replace, regex_replace, append, prepend, " +
    "insert_at_line, delete_lines, move, delete_file, mkdir, list. " +
    "replace matches oldString EXACTLY (character-for-character, including whitespace/line endings). " +
    "Returns per-op results: OK/<n> or FAIL:<reason>. Use this instead of spawning an edit subagent.",
  args: {
    ops: tool.schema.string().describe(
      'JSON array of operations, e.g. [{"op":"write","path":"C:\\proj\\file.txt","content":"hello"},{"op":"replace","path":"C:\\proj\\a.cs","oldString":"int x = 1;","newString":"int x = 2;"}]'
    ),
  },
  async execute(args, context) {
    let ops
    try {
      if (Array.isArray(args.ops)) {
        ops = args.ops
      } else {
        ops = JSON.parse(String(args.ops))
        if (!Array.isArray(ops)) ops = [ops]
      }
    } catch (e) {
      return "FAIL: ops is not valid JSON: " + (e && e.message ? e.message : String(e))
    }

    const results = []
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i] || {}
      const kind = String(o.op || o.type || "").toLowerCase()
      try {
        switch (kind) {
          case "read": {
            const p = norm(o.path)
            let content = await readFile(p, "utf8")
            if (o.offset !== undefined || o.limit !== undefined) {
              const lines = lineSplit(content)
              const start = Math.max(0, (o.offset || 1) - 1)
              const end = o.limit ? start + o.limit : lines.length
              content = lines.slice(start, end).join("\n")
            }
            results.push(`[${i}] READ OK ${p} (${content.length} chars): \n${content}`)
            break
          }
          case "write": {
            const p = norm(o.path)
            await ensureDir(p)
            await writeFile(p, String(o.content ?? ""), "utf8")
            results.push(`[${i}] WRITE OK ${p} (${Buffer.byteLength(String(o.content ?? ""), "utf8")} bytes)`)
            break
          }
          case "replace": {
            const p = norm(o.path)
            const src = await readFile(p, "utf8")
            const oldS = String(o.oldString ?? "")
            const newS = String(o.newString ?? "")
            if (oldS === "") throw new Error("oldString must be non-empty (use write for new files)")
            const count = src.split(oldS).length - 1
            if (count === 0) throw new Error(`oldString not found in ${p} — re-read the file and copy exact bytes`)
            if (count > 1 && !o.all) throw new Error(`oldString matches ${count} times in ${p} — provide more context or set "all":true`)
            const out = o.all ? src.split(oldS).join(newS) : src.replace(oldS, newS)
            await writeFile(p, out, "utf8")
            results.push(`[${i}] REPLACE OK ${p} (${count} occurrence${count > 1 ? "s" : ""} replaced)`)
            break
          }
          case "regex_replace": {
            const p = norm(o.path)
            const src = await readFile(p, "utf8")
            const flags = o.all === false ? "" : "g"
            const re = new RegExp(o.pattern, flags + "m")
            const out = src.replace(re, String(o.replacement ?? ""))
            if (out === src) throw new Error(`pattern /${o.pattern}/ matched nothing in ${p}`)
            await writeFile(p, out, "utf8")
            results.push(`[${i}] REGEX_REPLACE OK ${p}`)
            break
          }
          case "append": {
            const p = norm(o.path)
            await ensureDir(p)
            await appendFile(p, String(o.content ?? ""), "utf8")
            results.push(`[${i}] APPEND OK ${p}`)
            break
          }
          case "prepend": {
            const p = norm(o.path)
            const src = existsSync(p) ? await readFile(p, "utf8") : ""
            await writeFile(p, String(o.content ?? "") + src, "utf8")
            results.push(`[${i}] PREPEND OK ${p}`)
            break
          }
          case "insert_at_line": {
            const p = norm(o.path)
            const lines = lineSplit(await readFile(p, "utf8"))
            const line = Math.max(1, parseInt(o.line, 10))
            lines.splice(line - 1, 0, String(o.content ?? ""))
            await writeFile(p, lines.join("\n"), "utf8")
            results.push(`[${i}] INSERT_AT_LINE OK ${p} (before line ${line})`)
            break
          }
          case "delete_lines": {
            const p = norm(o.path)
            const lines = lineSplit(await readFile(p, "utf8"))
            const s = Math.max(1, parseInt(o.startLine, 10))
            const e2 = Math.min(lines.length, parseInt(o.endLine, 10))
            const removed = e2 - s + 1
            lines.splice(s - 1, removed)
            await writeFile(p, lines.join("\n"), "utf8")
            results.push(`[${i}] DELETE_LINES OK ${p} (removed ${removed} lines ${s}-${e2})`)
            break
          }
          case "move": {
            const from = norm(o.from)
            const to = norm(o.to)
            await ensureDir(to)
            await rename(from, to)
            results.push(`[${i}] MOVE OK ${from} -> ${to}`)
            break
          }
          case "delete_file": {
            const p = norm(o.path)
            await unlink(p)
            results.push(`[${i}] DELETE_FILE OK ${p}`)
            break
          }
          case "mkdir": {
            const p = norm(o.path)
            await mkdir(p, { recursive: true })
            results.push(`[${i}] MKDIR OK ${p}`)
            break
          }
          case "list": {
            const p = norm(o.path)
            const entries = await readdir(p)
            const filtered = o.pattern ? entries.filter(e => e.includes(String(o.pattern))) : entries
            results.push(`[${i}] LIST OK ${p}: ${filtered.join(", ")}`)
            break
          }
          default:
            results.push(`[${i}] FAIL: unknown op "${kind}" (supported: read, write, replace, regex_replace, append, prepend, insert_at_line, delete_lines, move, delete_file, mkdir, list)`)
        }
      } catch (e) {
        results.push(`[${i}] FAIL (${kind}): ` + (e && e.message ? e.message : String(e)))
      }
    }
    const failed = results.filter(r => r.includes("FAIL")).length
    const filesTouched = new Set(results.filter(r => r.includes(" OK ")).map(r => (r.match(/OK ([^ (]+)/) || [])[1]).filter(Boolean))
    return `EDIT-OPS: ${ops.length - failed}/${ops.length} succeeded | files touched: ${filesTouched.size}\n` + results.join("\n")
  },
})
