// findings-mcp.cjs - zero-dependency MCP server (stdio) exposing the findings tool.
// V2: registered in opencode.json under mcp.servers."write" -> effective tool id
// "write_findings" (<server>_<tool> naming). Under default Code Mode, agents call it
// as tools.write.findings inside an execute block:
//   return tools.write.findings({ path: '<abs path containing .opencode-findings>', body: '<markdown>' })
// The permission action matching this tool is "write_findings" (allow-listed per agent).
const fs = require("fs");
const path = require("path");

const TOOL = {
  name: "findings",
  description: "Write a findings/report markdown file to disk in ONE call. path MUST contain .opencode-findings (aliases: file, filePath, dest). body = raw markdown (aliases: content, text, markdown). Returns WRITTEN with path and byte count.",
  inputSchema: { type: "object", properties: { path: {}, file: {}, filePath: {}, body: {}, content: {}, text: {}, markdown: {}, bodyBase64: {} }, additionalProperties: true },
};

function pickBody(args) {
  const low = {};
  for (const k of Object.keys(args || {})) low[String(k).toLowerCase()] = args[k];
  const get = (...ns) => { for (const n of ns) { const v = low[n]; if (v !== undefined && v !== null && String(v) !== "") return v; } return undefined; };
  let b64 = get("bodybase64", "base64");
  if (b64 !== undefined) {
    let s = String(b64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const m = s.length % 4;
    if (m) s += "=".repeat(4 - m);
    try {
      const dec = Buffer.from(s, "base64").toString("utf8");
      if (!/[\0\uFFFD]/.test(dec)) return dec;
    } catch {}
    return String(b64);
  }
  let body = get("body", "content", "text", "markdown", "md", "data");
  if (body === undefined) return undefined;
  if (typeof body !== "string") {
    try { body = typeof body === "object" ? JSON.stringify(body, null, 2) : String(body); }
    catch { return undefined; }
  }
  return body.replace(/^\uFEFF/, "");
}

function doWrite(args) {
  args = args && typeof args === "object" ? args : {};
  const low = {};
  for (const k of Object.keys(args)) low[String(k).toLowerCase()] = args[k];
  const get = (...ns) => { for (const n of ns) { const v = low[n]; if (v !== undefined && v !== null && String(v) !== "") return v; } return undefined; };
  let p = get("path", "filepath", "file", "filename", "dest", "output");
  if (p === undefined) return "ERROR: no path (use path/file) under .opencode-findings";
  p = String(p).trim().replace(/\//g, "\\").replace(/\\+/g, "\\");
  if (!p.includes(".opencode-findings")) return "ERROR: path must contain .opencode-findings, got: " + p;
  const body = pickBody(args);
  if (body === undefined) return "ERROR: no body (use body/content/text/markdown)";
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
    return "WRITTEN: " + p + " (" + Buffer.byteLength(body, "utf8") + " bytes)";
  } catch (e) { return "WRITE-FAILED: " + p + " :: " + (e.message || String(e)); }
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
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "write", version: "1.0.0" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [TOOL] } });
    } else if (msg.method === "tools/call") {
      const out = doWrite((msg.params || {}).arguments);
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: out }] } });
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else if (msg.id !== undefined && !String(msg.method || "").startsWith("notifications/")) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
    }
  }
});
