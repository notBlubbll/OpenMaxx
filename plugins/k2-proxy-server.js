// k2-proxy-server.js — stdlib-only reverse proxy fixing IFM K2-Horizon
// "missing thinking field" 400s. Listens on 127.0.0.1:8089, forwards all
// paths to https://api.ifm.ai + req.url, injects "reasoning": "" into every
// assistant message missing all thinking-ish fields, streams SSE chunk-by-chunk.
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const UPSTREAM = "https://api.ifm.ai";
const HOST = "127.0.0.1";
const PORT = 8089;

// Only `reasoning` is accepted by IFM despite the error text listing others.
// Strip every sibling thinking-ish field and always keep `reasoning` a string.
const THINK_FIELDS = ["think", "reasoning_content", "think_fast", "think_faster", "thinking"];
const IFM_KEYS = ["REPLACE_WITH_REAL_KEY"];

// Per-session key pinning: each conversation fingerprint pins one key for
// the session's lifetime; failover on 429/401/403 with a 30s key cooldown.
let rrIdx = 0; // global round-robin cursor for NEW sessions
const conversationMap = new Map(); // fingerprint -> { tokenIndex, requestCount }
const CONVERSATION_MAP_MAX = 10000;
const keyHealth = IFM_KEYS.map(() => ({ healthy: true, lastError: 0 }));
const KEY_COOLDOWN_MS = 30000;

function fingerprintPayload(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return null;
  const text = (m) => typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.find(p => p?.type === "text")?.text || "" : "");
  const idx = msgs.findIndex(m => m.role === "user");
  if (idx < 0) return null;
  return createHash("md5").update(text(msgs[idx])).digest("hex").slice(0, 12);
}

function touchConversation(fp) {
  const s = conversationMap.get(fp);
  if (s) { conversationMap.delete(fp); conversationMap.set(fp, s); } // LRU touch
  return s;
}

function trackConversationSession(fp, session) {
  conversationMap.set(fp, session);
  if (conversationMap.size > CONVERSATION_MAP_MAX) {
    const excess = conversationMap.size - Math.floor(CONVERSATION_MAP_MAX * 0.8);
    let i = 0;
    for (const k of conversationMap.keys()) { if (i++ >= excess) break; conversationMap.delete(k); }
  }
}

function pickKey(preferredIndex) {
  const now = Date.now();
  if (preferredIndex != null) {
    const h = keyHealth[preferredIndex];
    if (h && (h.healthy || now - h.lastError > KEY_COOLDOWN_MS)) return preferredIndex;
  }
  for (let attempt = 0; attempt < IFM_KEYS.length; attempt++) {
    const idx = rrIdx++ % IFM_KEYS.length;
    const h = keyHealth[idx];
    if (h.healthy || now - h.lastError > KEY_COOLDOWN_MS) return idx;
  }
  return rrIdx++ % IFM_KEYS.length; // all cooling: fall back to rr anyway
}

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on("error", reject);
  });
}

function maybePatchBody(raw, contentType) {
  if (!raw || !raw.length) return { body: raw, parsed: null };
  if (!String(contentType || "").toLowerCase().includes("json")) return { body: raw, parsed: null };
  let parsed;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { body: raw, parsed: null }; // not JSON — forward byte-identical
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return { body: raw, parsed };
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
  return { body: changed ? Buffer.from(JSON.stringify(parsed)) : raw, parsed };
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
    const { body, parsed: parsedPayload } = maybePatchBody(raw, req.headers["content-type"]);
    // Per-session pinning: MD5-12 fingerprint of the first user message.
    // No messages[] (e.g. GET /v1/models) -> fingerprint is null.
    const fingerprint = fingerprintPayload(parsedPayload);
    const cachedSession = fingerprint != null ? touchConversation(fingerprint) : undefined;
    let usedIdx = pickKey(cachedSession ? cachedSession.tokenIndex : undefined);

    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["content-length"];
    // Incoming auth passes through only when upstream is NOT api.ifm.ai.
    // The Bearer stamp is applied per-attempt inside the retry loop below.

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
        headers["authorization"] = `Bearer ${IFM_KEYS[usedIdx]}`;
        init.headers = headers;
      }
      try {
        upstream = await fetch(UPSTREAM + path, init);
      } catch (err) {
        lastErr = err;
        if (!isIfm) break;
        keyHealth[usedIdx] = { healthy: false, lastError: Date.now() };
        usedIdx = pickKey(undefined);
        continue;
      }
      const retryable = upstream.status === 429 || upstream.status === 401 || upstream.status === 403;
      if (retryable && attempt + 1 < maxAttempts) {
        await upstream.body?.cancel?.();
        keyHealth[usedIdx] = { healthy: false, lastError: Date.now() };
        usedIdx = pickKey(undefined);
        if (cachedSession) cachedSession.tokenIndex = usedIdx;
        continue;
      }
      break;
    }
    if (upstream === null) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Proxy error: ${lastErr && lastErr.message ? lastErr.message : String(lastErr)}`);
      return;
    }

    // Persist the pinned key for this conversation fingerprint.
    if (fingerprint != null) {
      if (!cachedSession) {
        trackConversationSession(fingerprint, { tokenIndex: usedIdx, requestCount: 1 });
      } else {
        cachedSession.requestCount++;
        cachedSession.tokenIndex = usedIdx;
        trackConversationSession(fingerprint, cachedSession);
      }
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
