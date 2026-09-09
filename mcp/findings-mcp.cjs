// findings-mcp.cjs - zero-dependency MCP server (stdio) exposing the findings tool.
// V2: registered in opencode.json under mcp.servers."write" -> effective tool id
// "write_findings" (<server>_<tool> naming). The write server runs with "codemode": false
// in opencode.json, so the tool is DIRECT-ONLY: agents call it as a direct tool, not as
// tools.write.findings inside a Code Mode execute block: write_findings({ path: '<abs path containing .opencode-findings>', body: '<markdown>' })
// The permission action matching this tool is "write_findings" (allow-listed per agent).
// Build 2026-09-09a: hardening T1-T10 per .opencode-findings\write-findings-hardening-audit.md.
// After editing this file, restart OpenCode — the running stdio server keeps the old build in memory.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const BUN_EXE = "C:\\Users\\User\\.bun\\bin\\bun.exe";
const MIND_TS = "C:\\Users\\User\\Documents\\mind\\src\\mind.ts";
const MIND_REPO = "C:\\Users\\User\\Documents\\mind";

const BUILD = "2026-09-09a";                      // T1: build stamp (stale-server detection)
const MAX_STDIN_LINE = 8 * 1024 * 1024;            // T8: 8 MB stdin line cap
const IDEMPOTENCY_MS = 60 * 1000;                  // T7: duplicate-write window
const lastWrite = new Map();                       // T7: normalized path -> last write ms (in-memory, per process)
const stamp = (s) => s + " [v" + BUILD + "]";      // T1: append [v<BUILD>] to response strings

const TOOL = {
  name: "findings",
  // T10: true alias set + response semantics (schema stays untyped, additionalProperties: true)
  description: "Write a findings/report markdown file to disk in ONE call. path MUST be ABSOLUTE and contain .opencode-findings (canonical key: path; backstop aliases: file, filePath, filename, dest, output). body = raw markdown (canonical; backstop aliases: content, text, markdown, md, data; bodyBase64/base64 for pre-encoded input). Reply starts WRITTEN: on success; ERROR:/WRITE-FAILED: are failures (isError=true); duplicate write within 60s returns ALREADY WRITTEN. Optionally: tags, space, mirror:false.",
  inputSchema: { type: "object", properties: { path: {}, file: {}, filePath: {}, filename: {}, dest: {}, output: {}, body: {}, content: {}, text: {}, markdown: {}, md: {}, data: {}, bodyBase64: {}, base64: {}, tags: {}, space: {}, mirror: {} }, additionalProperties: true },
};

// T5/T6 body resolution:
//  - bodyBase64/base64 takes priority; on failed decode (NUL/U+FFFD guard) report b64Failed — NEVER write the raw base64.
//  - an explicitly-provided empty-string body is valid (writes an empty file); error only when NO body alias key exists.
function bodyInfo(args) {
  const low = {};
  for (const k of Object.keys(args || {})) low[String(k).toLowerCase()] = args[k];
  const has = (...ns) => ns.some((n) => low[n] !== undefined && low[n] !== null);
  if (has("bodybase64", "base64")) {
    const raw = low["bodybase64"] !== undefined ? low["bodybase64"] : low["base64"];
    let s = String(raw).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const m = s.length % 4;
    if (m) s += "=".repeat(4 - m);
    try {
      const dec = Buffer.from(s, "base64").toString("utf8");
      if (!/[\0\uFFFD]/.test(dec)) return { value: dec.replace(/^\uFEFF/, "") };
    } catch {}
    return { b64Failed: true };
  }
  const BKEYS = ["body", "content", "text", "markdown", "md", "data"];
  if (has(...BKEYS)) {
    let b;
    for (const n of BKEYS) { const v = low[n]; if (v !== undefined && v !== null) { b = v; break; } }
    if (b === undefined || b === null) b = "";
    if (typeof b !== "string") {
      try { b = typeof b === "object" ? JSON.stringify(b, null, 2) : String(b); }
      catch { return {}; }
    }
    return { value: String(b).replace(/^\uFEFF/, "") };
  }
  return {};
}

// T9: async mind mirror — fire-and-forget spawn (never blocks the write path).
// Failure ladder ported to async: 'does not exist' -> create space + retry add; 'already exists' -> edit.
// Child stderr is piped (captured for the ladder, echoed to our stderr on failure) and the child is unref'd.
function mindBin() { return fs.existsSync(BUN_EXE) ? BUN_EXE : "bun"; }

function mindSpawnP(args) {
  return new Promise((resolve) => {
    let ch;
    try {
      ch = spawn(mindBin(), [MIND_TS].concat(args), { cwd: MIND_REPO, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (e) { resolve({ error: e }); return; }
    let so = "", se = "", done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const t = setTimeout(() => { try { ch.kill(); } catch {} finish({ status: -1, signal: null, stdout: so, stderr: "timeout after 5000ms (killed)" }); }, 5000);
    if (t.unref) t.unref();
    ch.stdout.on("data", (d) => { so += d; if (so.length > 65536) so = so.slice(0, 65536); });
    ch.stderr.on("data", (d) => { se += d; if (se.length > 65536) se = se.slice(0, 65536); });
    ch.on("error", (e) => { clearTimeout(t); finish({ error: e }); });
    ch.on("exit", (status, signal) => { clearTimeout(t); finish({ status, signal, stdout: so, stderr: se }); });
    if (ch.unref) ch.unref();
  });
}

function mindErrA(r) {
  if (!r) return "spawn returned nothing";
  if (r.error) return "spawn error " + (r.error.code || "unknown") + ": " + (r.error.message || "");
  if (r.status === 0) return null;
  if (r.signal) return "signal " + r.signal;
  const se = String(r.stderr || "").trim();
  return "exit " + (r.status !== undefined ? r.status : "?") + " " + se.slice(0, 300);
}

async function mindMirror(p, body, extraTags, spaceOverride, skip) {
  try {
    if (skip === true) return;
    // T9: MIND_MIRROR disable values, case-insensitive: 0/false/off/no
    const mmv = String(process.env.MIND_MIRROR || "").trim().toLowerCase();
    if (["0", "false", "off", "no"].indexOf(mmv) >= 0) return;
    if (!String(p).toLowerCase().includes(".opencode-findings")) return;
    const pLower = String(p).toLowerCase();
    const idx = pLower.lastIndexOf("\\.opencode-findings");
    let proj = "project";
    if (idx > 2) {
      const segs = String(p).slice(0, idx).split("\\");
      proj = segs[segs.length - 1] || "project";
    }
    const space = spaceOverride || ("projects/" + proj);
    const name = (proj + "-" + path.basename(p).replace(/\.md$/i, "")).slice(0, 120);
    let content = String(body || "");
    if (content.length > 6000) content = content.slice(0, 6000) + "\n\n\u2026(truncated; read the findings file for the full text)";
    content += "\n\n(Full findings file: " + p + ")";
    let tags = "type:finding,source:findings-mcp,project:" + proj;
    if (extraTags) tags = tags + "," + extraTags;
    const addArgs = ["add", space, name, content, "--tags", tags, "--tier", "3"];
    let r = await mindSpawnP(addArgs);
    let err = mindErrA(r);
    if (err && /does not exist/.test(String((r && r.stderr) || ""))) {
      await mindSpawnP(["create", space, "Auto-created by findings-mcp mirror"]);
      r = await mindSpawnP(addArgs);
      err = mindErrA(r);
    }
    if (err && /already exists/.test(String((r && r.stderr) || ""))) {
      r = await mindSpawnP(["edit", space, name, content]);
      err = mindErrA(r);
    }
    if (err) {
      process.stderr.write("[findings-mcp] mind mirror failed: " + err + "\n");
      const se = String((r && r.stderr) || "").trim();
      if (se) process.stderr.write(se.slice(0, 300) + "\n");
    } else {
      process.stderr.write("[findings-mcp] mind mirror ok: " + space + ":" + name + "\n");
    }
  } catch (e) {
    process.stderr.write("[findings-mcp] mind mirror threw: " + ((e && e.message) || e) + "\n");
  }
}

function doWrite(args) {
  args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const low = {};
  for (const k of Object.keys(args)) low[String(k).toLowerCase()] = args[k];
  const PATHKEYS = ["path", "filepath", "file", "filename", "dest", "output"];
  let p;
  for (const n of PATHKEYS) { const v = low[n]; if (v !== undefined && v !== null && String(v).trim() !== "") { p = v; break; } }
  // T2: no path alias -> list the received keys; must-contain text ONLY when a path alias was present
  if (p === undefined) {
    const gotKeys = Object.keys(low).join(",");
    return { text: stamp("ERROR: no path alias found (got keys: " + gotKeys + ") \u2014 use path (absolute, containing .opencode-findings)"), isError: true };
  }
  p = String(p).trim().replace(/\//g, "\\").replace(/\\+/g, "\\");
  // T3: absolute path required (drive letter or UNC); relative would land in the server cwd
  if (!/^\\\\/.test(p) && !/^[A-Za-z]:\\/.test(p)) {
    return { text: stamp("ERROR: path must be absolute (drive letter like C:\\... or UNC \\\\server\\share) \u2014 relative paths would land in the server process cwd, not your project; got relative: " + p), isError: true };
  }
  // T3: case-insensitive .opencode-findings gate (aligned with the mirror gate)
  if (!p.toLowerCase().includes(".opencode-findings")) {
    return { text: stamp("ERROR: path must contain .opencode-findings, got: " + p), isError: true };
  }
  // T3: segment-boundary miss -> auto-promote into the nearest clean .opencode-findings segment under the same root
  let corrected = false;
  const segs = p.split("\\");
  if (segs.findIndex((s) => s.toLowerCase() === ".opencode-findings") === -1) {
    const badIdx = segs.findIndex((s) => s.toLowerCase().includes(".opencode-findings"));
    if (badIdx >= 0) { segs[badIdx] = ".opencode-findings"; p = segs.join("\\"); corrected = true; }
  }
  // T5/T6: body
  const bi = bodyInfo(args);
  if (bi.b64Failed) return { text: stamp("ERROR: bodyBase64 did not decode to text"), isError: true };
  if (bi.value === undefined) return { text: stamp("ERROR: no body (use body/content/text/markdown, or bodyBase64; an explicitly empty string writes an empty file)"), isError: true };
  const body = bi.value;
  // T7: idempotency — same absolute path written <60s ago by this process -> echo, do not rewrite
  const now = Date.now();
  const key = p.toLowerCase();
  const last = lastWrite.get(key);
  if (last !== undefined && now - last < IDEMPOTENCY_MS) {
    return { text: "ALREADY WRITTEN (unchanged): " + p + " [v" + BUILD + "] \u2014 SUCCESS - do not rewrite this file", isError: false };
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    lastWrite.set(key, now);
    const tagsArg = low["tags"] !== undefined ? low["tags"] : low["mindtags"];
    const spaceArg = low["space"] !== undefined ? low["space"] : low["mindworkspace"];
    const mirrorRaw = low["mirror"] !== undefined ? low["mirror"] : low["nomirror"];
    const skip = [false, "false", "0", "no", "off"].indexOf(String(mirrorRaw === undefined ? "" : mirrorRaw).toLowerCase()) >= 0;
    mindMirror(p, body, tagsArg, spaceArg, skip); // T9: async, fire-and-forget — never blocks the reply
    const note = corrected ? " [corrected segment to .opencode-findings]" : "";
    return { text: stamp("WRITTEN: " + p + note + " (" + Buffer.byteLength(body, "utf8") + " bytes)"), isError: false };
  } catch (e) {
    return { text: stamp("WRITE-FAILED: " + p + " :: " + (e.message || String(e))), isError: true };
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const line = raw.trim();
    if (!line) continue;
    // T8: cap a single stdin line at 8 MB (drop + stderr log)
    if (line.length > MAX_STDIN_LINE) {
      process.stderr.write("[findings-mcp] dropping stdin line over 8MB (" + line.length + " chars)\n");
      continue;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stderr.write("[findings-mcp] dropping unparseable stdin line (" + line.slice(0, 200) + ")\n");
      continue;
    }
    // T8: guard bare null/number/string/boolean/array requests -> JSON-RPC -32700, keep going
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: request must be a JSON object" } });
      continue;
    }
    if (msg.method === "initialize") {
      // T1: serverInfo.version carries the build stamp
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "write", version: BUILD } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [TOOL] } });
    } else if (msg.method === "tools/call") {
      const rawArgs = (msg.params || {}).arguments;
      let argObj = rawArgs;
      let rawStr = null; // non-empty string arguments that could not yield a key-carrying object
      if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
            argObj = parsed;
          } else {
            rawStr = rawArgs;
          }
        } catch {
          rawStr = rawArgs;
        }
      }
      const effArgs = argObj && typeof argObj === "object" && !Array.isArray(argObj) ? argObj : {};
      const out = doWrite(effArgs);
      if (out.isError && rawStr !== null && Object.keys(effArgs).length === 0) {
        out.text += " (arguments string preview: " + rawStr.slice(0, 200) + ")";
      }
      // T4: content array always present; isError=true on every ERROR:/WRITE-FAILED: response
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: out.text }], isError: !!out.isError } });
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.id !== undefined && !String(msg.method || "").startsWith("notifications/")) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
    }
  }
});
