// agnes-proxy/index.js — OpenCode V2 plugin: inline Agnes AI reverse proxy.
// Listens on 127.0.0.1:8090, key rotation, conversation tracking, Sleev passthrough.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

export default {
  id: "agnes-proxy",
  async setup(ctx) {
    const UPSTREAM = "https://apihub.agnes-ai.com";
    const HOST = "127.0.0.1";
    const PORT = 8090;
    const SLEEV_BASE = "http://127.0.0.1:17321";

    const AGNES_KEYS = [
      "wk-REDACTED",
      "sk-REDACTED",
      "sk-REDACTED",
    ];

    const conversationMap = new Map();
    const keyHealth = AGNES_KEYS.map(() => ({ healthy: true, lastError: 0 }));
    const KEY_COOLDOWN_MS = 30000;

    function fingerprintPayload(payload) {
      const msgs = payload?.messages;
      if (!Array.isArray(msgs)) return null;
      const text = (m) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.find((p) => p?.type === "text")?.text || "" : "";
      const idx = msgs.findIndex((m) => m.role === "user");
      if (idx < 0) return null;
      return createHash("md5").update(text(msgs[idx])).digest("hex").slice(0, 12);
    }

    function touchConversation(fp) {
      const s = conversationMap.get(fp);
      if (s) { conversationMap.delete(fp); conversationMap.set(fp, s); }
      return s;
    }

    function trackConversationSession(fp, session) {
      conversationMap.set(fp, session);
      if (conversationMap.size > 10000) {
        const excess = conversationMap.size - 8000;
        let i = 0;
        for (const k of conversationMap.keys()) { if (i++ >= excess) break; conversationMap.delete(k); }
      }
    }

    function pickKey(preferredIndex) {
      const now = Date.now();
      if (preferredIndex != null && preferredIndex > 0) {
        const h = keyHealth[preferredIndex];
        if (h && (h.healthy || now - h.lastError > KEY_COOLDOWN_MS)) return preferredIndex;
      }
      for (let i = 0; i < AGNES_KEYS.length; i++) {
        const h = keyHealth[i];
        if (h.healthy || now - h.lastError > KEY_COOLDOWN_MS) return i;
      }
      return 0;
    }

    async function isSleevUp() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 1500);
      try { await fetch(`${SLEEV_BASE}/`, { signal: ctl.signal }); return true; } // any HTTP response = gateway alive
      catch { return false; } finally { clearTimeout(timer); }
    }

    function collect(req) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
        req.on("error", reject);
      });
    }

    const server = createServer(async (req, res) => {
      try {
        const path = req.url || "/";

        if (req.method === "GET" && path.split("?")[0] === "/health") {
          const sleev = await isSleevUp();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", keys: AGNES_KEYS.length, healthy: keyHealth.filter((k) => k.healthy).length, sleev }));
          return;
        }

        const raw = await collect(req);
        const useSleev = await isSleevUp();

        let parsed = null;
        try { parsed = JSON.parse(raw?.toString("utf8") ?? "{}"); } catch {}
        const fingerprint = fingerprintPayload(parsed);
        const cachedSession = fingerprint != null ? touchConversation(fingerprint) : undefined;
        let usedIdx = pickKey(cachedSession ? cachedSession.tokenIndex : undefined);

        const headers = { ...req.headers };
        delete headers["host"];
        delete headers["content-length"];
        headers["authorization"] = `Bearer ${AGNES_KEYS[usedIdx]}`;

        const targetURL = useSleev ? `${SLEEV_BASE}${path}` : UPSTREAM + path;
        if (useSleev) {
          headers["sleeve-harness"] = "opencode";
          headers["sleeve-base-url"] = `${UPSTREAM}/v1`; // base only: gateway appends req path itself
        }

        const init = { method: req.method, headers };
        if (raw && raw.length && req.method !== "GET" && req.method !== "HEAD") {
          init.body = raw;
          init.duplex = "half";
        }

        let upstream = null;
        let lastErr = null;
        for (let attempt = 0; attempt < AGNES_KEYS.length; attempt++) {
          headers["authorization"] = `Bearer ${AGNES_KEYS[usedIdx]}`;
          if (useSleev) {
            headers["sleeve-harness"] = "opencode";
            headers["sleeve-base-url"] = `${UPSTREAM}/v1`; // base only: gateway appends req path itself
          }
          init.headers = headers;
          try { upstream = await fetch(targetURL, init); } catch (err) {
            lastErr = err; keyHealth[usedIdx] = { healthy: false, lastError: Date.now() }; usedIdx = pickKey(undefined); continue;
          }
          if ((upstream.status === 429 || upstream.status === 401 || upstream.status === 403) && attempt + 1 < AGNES_KEYS.length) {
            await upstream.body?.cancel?.(); keyHealth[usedIdx] = { healthy: false, lastError: Date.now() }; usedIdx = pickKey(undefined);
            if (cachedSession) cachedSession.tokenIndex = usedIdx; continue;
          }
          break;
        }

        if (!upstream) {
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
          res.end(`Proxy error: ${lastErr?.message || String(lastErr)}`); return;
        }

        if (fingerprint != null) {
          if (!cachedSession) trackConversationSession(fingerprint, { tokenIndex: usedIdx, requestCount: 1 });
          else { cachedSession.requestCount++; cachedSession.tokenIndex = usedIdx; trackConversationSession(fingerprint, cachedSession); }
        }

        const outHeaders = {};
        const ctype = upstream.headers.get("content-type");
        if (ctype) outHeaders["content-type"] = ctype;
        res.writeHead(upstream.status, outHeaders);
        if (!upstream.body) { res.end(); return; }
        const reader = upstream.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
        res.end();
      } catch (err) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        try { res.end(`Proxy error: ${err?.message || String(err)}`); } catch {}
      }
    });

    server.listen(PORT, HOST, () => {
      console.log(`[agnes-proxy] listening on http://${HOST}:${PORT} -> ${UPSTREAM} (${AGNES_KEYS.length} keys)`);
    });
  },
};
