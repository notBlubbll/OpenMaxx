// agnes-proxy-server.js â€” reverse proxy for Agnes AI with primary + fallback key selection.
// Listens on 127.0.0.1:8090, forwards to https://apihub.agnes-ai.com/v1,
// uses primary key unless unhealthy, then falls back. Tracks conversations.
//
// Standalone script â€” no OpenCode plugin interface. Spawned by agnes-proxy.js plugin.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const UPSTREAM = "https://apihub.agnes-ai.com";
const HOST = "127.0.0.1";
const PORT = 8090;

// --- API keys (rotate on 429/auth errors) ---
const AGNES_KEYS = [
  "YOUR_WK_KEY_HERE",  // key 1 (primary)
  "YOUR_SK_KEY_1_HERE",  // key 2 (fallback)
  "YOUR_SK_KEY_2_HERE",  // key 3 (fallback)
];

const conversationMap = new Map();
const CONVERSATION_MAP_MAX = 10000;
const keyHealth = AGNES_KEYS.map(() => ({ healthy: true, lastError: 0 }));
const KEY_COOLDOWN_MS = 30000;

// --- Conversation tracking (pin key per conversation) ---

function fingerprintPayload(payload) {
  const msgs = payload?.messages;
  if (!Array.isArray(msgs)) return null;
  const text = (m) =>
    typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.find((p) => p?.type === "text")?.text || ""
        : "";
  const idx = msgs.findIndex((m) => m.role === "user");
  if (idx < 0) return null;
  return createHash("md5").update(text(msgs[idx])).digest("hex").slice(0, 12);
}

function touchConversation(fp) {
  const s = conversationMap.get(fp);
  if (s) {
    conversationMap.delete(fp);
    conversationMap.set(fp, s);
  }
  return s;
}

function trackConversationSession(fp, session) {
  conversationMap.set(fp, session);
  if (conversationMap.size > CONVERSATION_MAP_MAX) {
    const excess =
      conversationMap.size - Math.floor(CONVERSATION_MAP_MAX * 0.8);
    let i = 0;
    for (const k of conversationMap.keys()) {
      if (i++ >= excess) break;
      conversationMap.delete(k);
    }
  }
}

// --- Key selection (primary + fallbacks, no round-robin) ---
// Always use key 0 (wk-) unless it's unhealthy, then try key 1, then key 2.

function pickKey(preferredIndex) {
  const now = Date.now();
  // If preferred key is still healthy, keep using it (session pinning)
  if (preferredIndex != null && preferredIndex > 0) {
    const h = keyHealth[preferredIndex];
    if (h && (h.healthy || now - h.lastError > KEY_COOLDOWN_MS)) return preferredIndex;
  }
  // Try primary first, then fallbacks in order
  for (let i = 0; i < AGNES_KEYS.length; i++) {
    const h = keyHealth[i];
    if (h.healthy || now - h.lastError > KEY_COOLDOWN_MS) return i;
  }
  return 0; // all unhealthy â€” try primary anyway
}

// --- HTTP helpers ---

function collect(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on("error", reject);
  });
}

// --- Server ---

const server = createServer(async (req, res) => {
  try {
    const path = req.url || "/";

    // Health check
    if (req.method === "GET" && path.split("?")[0] === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          keys: AGNES_KEYS.length,
          healthy: keyHealth.filter((k) => k.healthy).length,
        })
      );
      return;
    }

    const raw = await collect(req);

    // Fingerprint for conversation-key pinning
    let parsed = null;
    try {
      parsed = JSON.parse(raw?.toString("utf8") ?? "{}");
    } catch {}
    const fingerprint = fingerprintPayload(parsed);
    const cachedSession = fingerprint != null ? touchConversation(fingerprint) : undefined;

    let usedIdx = pickKey(cachedSession ? cachedSession.tokenIndex : undefined);

    // Build upstream request
    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["content-length"];
    headers["authorization"] = `Bearer ${AGNES_KEYS[usedIdx]}`;

    const init = { method: req.method, headers };
    if (raw && raw.length && req.method !== "GET" && req.method !== "HEAD") {
      init.body = raw;
      init.duplex = "half";
    }

    // Forward with key rotation on 429/auth errors
    const maxAttempts = AGNES_KEYS.length;
    let upstream = null;
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      headers["authorization"] = `Bearer ${AGNES_KEYS[usedIdx]}`;
      init.headers = headers;
      try {
        upstream = await fetch(UPSTREAM + path, init);
      } catch (err) {
        lastErr = err;
        keyHealth[usedIdx] = { healthy: false, lastError: Date.now() };
        usedIdx = pickKey(undefined);
        continue;
      }
      const retryable =
        upstream.status === 429 ||
        upstream.status === 401 ||
        upstream.status === 403;
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
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "text/plain" });
      res.end(
        `Proxy error: ${lastErr && lastErr.message ? lastErr.message : String(lastErr)}`
      );
      return;
    }

    // Track conversation
    if (fingerprint != null) {
      if (!cachedSession) {
        trackConversationSession(fingerprint, {
          tokenIndex: usedIdx,
          requestCount: 1,
        });
      } else {
        cachedSession.requestCount++;
        cachedSession.tokenIndex = usedIdx;
        trackConversationSession(fingerprint, cachedSession);
      }
    }

    // Stream response
    const outHeaders = {};
    const ctype = upstream.headers.get("content-type");
    if (ctype) outHeaders["content-type"] = ctype;
    const upstreamKey = upstream.headers.get("x-ratelimit-remaining");
    if (upstreamKey) outHeaders["x-ratelimit-remaining"] = upstreamKey;

    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent)
      res.writeHead(502, { "content-type": "text/plain" });
    try {
      res.end(
        `Proxy error: ${err && err.message ? err.message : String(err)}`
      );
    } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[agnes-proxy] listening on http://${HOST}:${PORT} -> ${UPSTREAM} (${AGNES_KEYS.length} keys)`
  );
});
