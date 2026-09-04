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
const IFM_KEYS = ["REPLACE_WITH_REAL_KEY"];
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
    // Sticky IFM key: reuse current key; advance only on upstream failure.
    // Incoming auth passes through only when upstream is NOT api.ifm.ai.
    if (UPSTREAM.includes("api.ifm.ai")) {
      headers["authorization"] = `Bearer ${IFM_KEYS[keyIdx]}`;
    }

    const init = { method: req.method, headers };
    if (body && body.length && req.method !== "GET" && req.method !== "HEAD") {
      init.body = body;
      init.duplex = "half";
    }

    const isIfm = UPSTREAM.includes("api.ifm.ai");
    const maxAttempts = isIfm ? IFM_KEYS.length : 1;
    let upstream = null;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isIfm) {
        headers["authorization"] = `Bearer ${IFM_KEYS[keyIdx]}`;
        init.headers = headers;
      }
      try {
        upstream = await fetch(UPSTREAM + path, init);
      } catch (err) {
        lastErr = err;
        if (!isIfm) break;
        keyIdx = (keyIdx + 1) % IFM_KEYS.length;
        continue;
      }
      const retryable = upstream.status === 429 || upstream.status === 401 || upstream.status === 403;
      if (retryable && attempt + 1 < maxAttempts) {
        await upstream.body?.cancel?.();
        keyIdx = (keyIdx + 1) % IFM_KEYS.length;
        continue;
      }
      break;
    }
    if (upstream === null) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Proxy error: ${lastErr && lastErr.message ? lastErr.message : String(lastErr)}`);
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
