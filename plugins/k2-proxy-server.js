// k2-proxy-server.js — stdlib-only reverse proxy fixing IFM K2-Horizon
// "missing thinking field" 400s. Listens on 127.0.0.1:8089, forwards all
// paths to https://api.ifm.ai + req.url, injects "reasoning": "" into every
// assistant message missing all thinking-ish fields, streams SSE chunk-by-chunk.
import { createServer } from "node:http";

const UPSTREAM = "https://api.ifm.ai";
const HOST = "127.0.0.1";
const PORT = 8089;

// Only `reasoning` is accepted by IFM despite the error text listing others.
// Strip every sibling thinking-ish field and always keep `reasoning` a string.
const THINK_FIELDS = ["think", "reasoning_content", "think_fast", "think_faster", "thinking"];
const IFM_KEYS = ["IFM-N1OMJQgibClSySgc", "IFM-H2QWzUSsbrtigGh5VM308:22", "IFM-CglW7k9J2LIxrCAj", "IFM-tHLE9W7XUbFrKDV8VM469:22", "IFM-gU636-PDVxsktWtaVM469:22", "IFM-Ply9JKAW0U42yd82", "IFM-dYsvh4ZjQfc1ipf2VM594:22", "IFM-RUKxi2JN3gLKOUm-VM594:22", "IFM-y7spoMkCQilLu_SA", "IFM-5_biyYYyYiebHEhGVM734:22", "IFM-aAB_HlJBG49y0aIyVM734:22", "IFM-zaFPj7tKPIGVXkJS", "IFM-xi-DvFCiBjxLoFZCVM929:22", "IFM-kUOmYlhy4iyr8GdGVM929:22", "IFM-0qodOyjTmT0YZpJp", "IFM-DImaEad86FTmb4RfVM988:22", "IFM-NgOVFT7vUqhjEgttVM988:22", "IFM-AYksVclQCc8VoZcK", "IFM-GAPTWa2uW5oUqTb5VM1040:22", "IFM-xFGLGgxQ0EFgNtKHVM1040:22", "IFM-wOkggoTQiczGsEkA", "IFM-sFbXZhcO40aucnb9VM1092:22", "IFM-3zEeW15dS1QkT9ifVM1092:22", "IFM-B7_ZvcC3tBKUp4AZ", "IFM-Ro95rV7IGFhyngRzVM1140:22", "IFM-w8SA5yubd0EcFyXPVM1140:22", "IFM-IJVX17Sk5_ZMnJdA", "IFM-Zscd1tQg3MvU8rA1VM1191:22", "IFM-NxoYgVu8SM_q4pvaVM1191:22", "IFM-UfiMxQ81VGid6Nl1"];
let keyIdx = 0;

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on("error", reject);
  });
}

function maybePatchBody(raw, contentType) {
  if (!raw || !raw.length) return raw;
  if (!String(contentType || "").toLowerCase().includes("json")) return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return raw; // not JSON — forward byte-identical
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return raw;
  let changed = false;
  for (const m of parsed.messages) {
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    let mutated = false;
    for (const f of THINK_FIELDS) {
      if (f in m) {
        delete m[f];
        mutated = true;
      }
    }
    if (typeof m.reasoning !== "string") {
      m.reasoning = "";
      mutated = true;
    }
    if (mutated) changed = true;
  }
  return changed ? Buffer.from(JSON.stringify(parsed)) : raw;
}

const server = createServer(async (req, res) => {
  try {
    const path = req.url || "/";
    if (req.method === "GET" && path.split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
      return;
    }

    const raw = await collect(req);
    const body = maybePatchBody(raw, req.headers["content-type"]);

    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["content-length"];
    // Rotate IFM keys round-robin on EVERY upstream request (incl. /v1/models).
    // Incoming auth passes through only when upstream is NOT api.ifm.ai.
    if (UPSTREAM.includes("api.ifm.ai")) {
      headers["authorization"] = `Bearer ${IFM_KEYS[keyIdx++ % IFM_KEYS.length]}`;
    }

    const init = { method: req.method, headers };
    if (body && body.length && req.method !== "GET" && req.method !== "HEAD") {
      init.body = body;
      init.duplex = "half";
    }

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + path, init);
    } catch (err) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Proxy error: ${err && err.message ? err.message : String(err)}`);
      return;
    }

    const outHeaders = {};
    const ctype = upstream.headers.get("content-type");
    if (ctype) outHeaders["content-type"] = ctype;
    res.writeHead(upstream.status, outHeaders);

    if (!upstream.body) {
      res.end();
      return;
    }
    // Stream chunk-by-chunk without buffering (large SSE safe).
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    try {
      res.end(`Proxy error: ${err && err.message ? err.message : String(err)}`);
    } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[k2-proxy] listening on http://${HOST}:${PORT} -> ${UPSTREAM}`);
});
