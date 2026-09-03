// edit-ops: deterministic batch file-edit operations executed WITHOUT an LLM.
// One call = unlimited ops. Ops run in order within the call.
// Parallel tool-call invocations serialize mutations per file path (per-file locks).
// Every mutating op snapshots the previous file to .opencode-backups/ before writing.

import { readFile, writeFile, appendFile, rename, unlink, mkdir, readdir, copyFile } from "node:fs/promises"
import { setTimeout as schedule } from "node:timers"
import { existsSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { tool } from "@opencode-ai/plugin"

// ---- path normalization ----
function norm(p, cwd) {
  let s = String(p || "").trim()
  s = s.replace(/(?<![\\/])\.opencode-findings/g, "\\.opencode-findings")
  s = s.replace(/([a-zA-Z]:)[\\/]+/g, "$1\\")
  s = s.replace(/\\\\/g, "\\")
  if (cwd && !/^[a-zA-Z]:[\\/]/.test(s)) s = resolve(String(cwd), s)
  return s
}

// ---- op aliases (token-saver) ----
const ALIAS = {
  r: "replace", rd: "read", w: "write", rr: "regex_replace", a: "append",
  pre: "prepend", il: "insert_at_line", dl: "delete_lines", mv: "move",
  rm: "delete_file", md: "mkdir", ls: "list", cp: "copy",
}

// ---- per-file locks: serialize mutations to the same path across parallel calls ----
const fileLocks = new Map()
function withFileLock(p, fn) {
  const prev = fileLocks.get(p) || Promise.resolve()
  const next = prev.then(fn, fn)
  fileLocks.set(p, next)
  next.finally(() => {
    if (fileLocks.get(p) === next) fileLocks.delete(p)
  }).catch(() => {})
  return next
}

// ---- backup-on-edit (snapshot to .opencode-backups) ----
const pendingCleanups = new Map()
async function backupBeforeEdit(p) {
  if (!existsSync(p)) return
  const dir = dirname(p)
  const bdir = join(dir, ".opencode-backups")
  try { await mkdir(bdir, { recursive: true }) } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const base = p.split("\\").pop().split("/").pop()
  const bpath = join(bdir, base + "." + stamp + ".bak")
  try { await copyFile(p, bpath) } catch {}
  // cleanup: keep max 5 per file, drop timers older than 50s
  const key = p
  const prev = pendingCleanups.get(key)
  if (prev) clearTimeout(prev.timer)
  const timer = schedule(() => {
    pendingCleanups.delete(key)
    readdir(bdir).then(files => {
      const mine = files.filter(f => f.startsWith(base + ".") && f.endsWith(".bak")).sort()
      const excess = mine.slice(0, Math.max(0, mine.length - 5))
      return Promise.all(excess.map(f => unlink(join(bdir, f)).catch(() => {})))
    }).catch(() => {})
  }, 50000)
  pendingCleanups.set(key, { timer })
}

// ---- helpers ----
function lineSplit(content) {
  return content.split(/\r?\n/)
}
async function ensureDir(p) {
  const d = dirname(p)
  if (d && !existsSync(d)) await mkdir(d, { recursive: true })
}

export default tool({
  description:
    "Execute a batch of deterministic file-edit operations WITHOUT an AI model. " +
    "Pass ops as a JSON array. Supported op types: read, write, replace, regex_replace, append, prepend, " +
    "insert_at_line, delete_lines, move, delete_file, mkdir, list (1-2 char aliases accepted: rd,w,r,rr,a,pre,il,dl,mv,rm,md,ls). " +
    "replace matches oldString EXACTLY (character-for-character, including whitespace/line endings). " +
    "Ops run in order within one call. Returns per-op results: OK or FAIL with reason. " +
    "Mutating ops on the same file are serialized across parallel tool calls; every mutation is backed up first.",
  args: {
    cwd: tool.schema.string().optional().describe("Optional working directory; ops with relative paths resolve against this."),
    ops: tool.schema.string().describe(
      'JSON array of operations, e.g. [{"op":"write","path":"C:\\proj\\file.txt","content":"hello"},{"op":"replace","path":"C:\\proj\\a.cs","oldString":"int x = 1;","newString":"int x = 2;"}]'
    ),
  },
  async execute(args) {
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

    const cwd = args.cwd ? norm(args.cwd) : undefined
    const results = []
    const MUTATORS = new Set(["write", "replace", "regex_replace", "append", "prepend", "insert_at_line", "delete_lines", "move", "delete_file", "copy"])

    const runOne = async (i, o, kind) => {
      const apply = async () => {
        switch (kind) {
          case "read": {
            const p = norm(o.path, cwd)
            let content = await readFile(p, "utf8")
            if (o.offset !== undefined || o.limit !== undefined) {
              const lines = lineSplit(content)
              const start = Math.max(0, (o.offset || 1) - 1)
              const end = o.limit ? start + o.limit : lines.length
              content = lines.slice(start, end).join("\n")
            }
            results.push(`[${i}] READ OK ${p} (${content.length} chars):\n${content.length > 60000 ? content.slice(0, 60000) + "\n...[TRUNCATED " + (content.length - 60000) + " chars - re-read with offset/limit for more]" : content}`)
            break
          }
          case "write": {
            if (o.content === undefined) throw new Error('missing required key "content" for write op')
            const p = norm(o.path, cwd)
            await backupBeforeEdit(p)
            await ensureDir(p)
            await writeFile(p, String(o.content), "utf8")
            results.push(`[${i}] WRITE OK ${p} (${Buffer.byteLength(String(o.content), "utf8")} bytes)`)
            break
          }
          case "replace": {
            const p = norm(o.path, cwd)
            if (o.oldString === undefined) throw new Error('missing required key "oldString" for replace op')
            if (o.newString === undefined) throw new Error('missing required key "newString" for replace op')
            const src = await readFile(p, "utf8")
            const oldS = String(o.oldString)
            const newS = String(o.newString)
            if (oldS === "") throw new Error("oldString must be non-empty (use write for new files)")
            const count = src.split(oldS).length - 1
            if (count === 0) throw new Error(`oldString not found in ${p} — re-read the file and copy exact bytes`)
            if (count > 1 && !o.all) throw new Error(`oldString matches ${count} times in ${p} — provide more context or set "all":true`)
            const out = o.all ? src.split(oldS).join(newS) : src.replace(oldS, newS)
            await backupBeforeEdit(p)
            await writeFile(p, out, "utf8")
            results.push(`[${i}] REPLACE OK ${p} (${count} occurrence${count > 1 ? "s" : ""} replaced)`)
            break
          }
          case "regex_replace": {
            const p = norm(o.path, cwd)
            const src = await readFile(p, "utf8")
            const flags = o.all === false ? "m" : "gm"
            const re = new RegExp(o.pattern, flags)
            const out = src.replace(re, String(o.replacement ?? ""))
            if (out === src) throw new Error(`pattern /${o.pattern}/ matched nothing in ${p}`)
            await backupBeforeEdit(p)
            await writeFile(p, out, "utf8")
            results.push(`[${i}] REGEX_REPLACE OK ${p}`)
            break
          }
          case "append": {
            if (o.content === undefined) throw new Error('missing required key "content" for append op')
            const p = norm(o.path, cwd)
            await ensureDir(p)
            await appendFile(p, String(o.content), "utf8")
            results.push(`[${i}] APPEND OK ${p}`)
            break
          }
          case "prepend": {
            if (o.content === undefined) throw new Error('missing required key "content" for prepend op')
            const p = norm(o.path, cwd)
            const src = existsSync(p) ? await readFile(p, "utf8") : ""
            await writeFile(p, String(o.content) + src, "utf8")
            results.push(`[${i}] PREPEND OK ${p}`)
            break
          }
          case "insert_at_line": {
            const p = norm(o.path, cwd)
            const lines = lineSplit(await readFile(p, "utf8"))
            const line = Math.max(1, parseInt(o.line, 10))
            lines.splice(line - 1, 0, String(o.content ?? ""))
            await backupBeforeEdit(p)
            await writeFile(p, lines.join("\n"), "utf8")
            results.push(`[${i}] INSERT_AT_LINE OK ${p} (before line ${line})`)
            break
          }
          case "delete_lines": {
            const p = norm(o.path, cwd)
            const lines = lineSplit(await readFile(p, "utf8"))
            const s = Math.max(1, parseInt(o.startLine ?? o.line, 10))
            if (isNaN(s)) throw new Error('delete_lines requires "startLine" and "endLine" (1-based)')
            const e2 = Math.min(lines.length, parseInt(o.endLine ?? o.line, 10))
            const removed = e2 - s + 1
            lines.splice(s - 1, removed)
            await backupBeforeEdit(p)
            await writeFile(p, lines.join("\n"), "utf8")
            results.push(`[${i}] DELETE_LINES OK ${p} (removed ${removed} lines ${s}-${e2})`)
            break
          }
          case "copy": {
            const from = norm(o.from, cwd)
            const to = norm(o.to, cwd)
            await ensureDir(to)
            await copyFile(from, to)
            results.push(`[${i}] COPY OK ${from} -> ${to}`)
            break
          }
          case "move": {
            const from = norm(o.from, cwd)
            const to = norm(o.to, cwd)
            await ensureDir(to)
            await rename(from, to)
            results.push(`[${i}] MOVE OK ${from} -> ${to}`)
            break
          }
          case "delete_file": {
            const p = norm(o.path, cwd)
            await unlink(p)
            results.push(`[${i}] DELETE_FILE OK ${p}`)
            break
          }
          case "mkdir": {
            const p = norm(o.path, cwd)
            await mkdir(p, { recursive: true })
            results.push(`[${i}] MKDIR OK ${p}`)
            break
          }
          case "list": {
            const p = norm(o.path, cwd)
            const entries = await readdir(p)
            const filtered = o.pattern ? entries.filter(e => e.includes(String(o.pattern))) : entries
            results.push(`[${i}] LIST OK ${p}: ${filtered.join(", ")}`)
            break
          }
          default:
            results.push(`[${i}] FAIL: unknown op "${kind}" (supported: read, write, replace, regex_replace, append, prepend, insert_at_line, delete_lines, move, copy, delete_file, mkdir, list)`)
        }
      }
      if (MUTATORS.has(kind)) {
        const lockPath = norm(o.path || o.from || "", cwd)
        await withFileLock(lockPath, apply)
      } else {
        await apply()
      }
    }

    // sequential execution preserves op order (later ops see earlier results)
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i]
      const kind = ALIAS[String((o || {}).op || (o || {}).type || "").toLowerCase()] || String((o || {}).op || (o || {}).type || "").toLowerCase()
      try {
        await runOne(i, o || {}, kind)
      } catch (e) {
        results.push(`[${i}] FAIL (${kind}): ` + (e && e.message ? e.message : String(e)))
      }
    }

    const failed = results.filter(r => r.includes("FAIL")).length
    const filesTouched = new Set(results.filter(r => r.includes(" OK ")).map(r => (r.match(/OK ([^ (]+)/) || [])[1]).filter(Boolean))
    return `EDIT-OPS: ${ops.length - failed}/${ops.length} succeeded | files touched: ${filesTouched.size}\n` + results.join("\n")
  },
})
