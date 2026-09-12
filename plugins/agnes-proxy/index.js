// agnes-proxy/index.js — OpenCode V2 plugin: inline Agnes AI reverse proxy.
// Listens on 127.0.0.1:8090, key rotation, conversation tracking, Sleev passthrough.
// rev: stateful tool-call backfill (fix v3).

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { SseToolCallFix } from '../sse-toolcall-fix.js';

export default {
  id: "agnes-proxy",
  async setup(ctx) {
    const UPSTREAM = "https://apihub.agnes-ai.com";
    const HOST = "127.0.0.1";
    const PORT = 8090;
    const SLEEV_BASE = "http://127.0.0.1:17321";

    const AGNES_KEYS = [
      "REDACTED-AGNES-KEY-1",
      "REDACTED-AGNES-KEY-2",
      "REDACTED-AGNES-KEY-3",
    ];

    const conversationMap = new Map();
    const keyHealth = AGNES_KEYS.map(() => ({ healthy: true, lastError: 0 }));
    const KEY_COOLDOWN_MS = 30000;
    let _sleevCache = null; // { value: boolean, timestamp: number }
    const SLEEV_CACHE_TTL_MS = 30000;

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

    async function getSleevDecision() {
      const now = Date.now();
      if (_sleevCache && _sleevCache.timestamp + SLEEV_CACHE_TTL_MS > now) return _sleevCache.value;
      try {
        const value = await isSleevUp();
        _sleevCache = { value, timestamp: now };
        return value;
      } catch {
        return _sleevCache ? _sleevCache.value : false;
      }
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
          const sleev = await getSleevDecision();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", keys: AGNES_KEYS.length, healthy: keyHealth.filter((k) => k.healthy).length, sleev }));
          return;
        }

        const raw = await collect(req);
        let clientGone = false;
        let reader = null;
        req.on("close", () => { clientGone = true; try { reader?.cancel().catch(() => {}); } catch {} });
        const useSleev = await getSleevDecision();

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
          let parsed = null;
          try { parsed = JSON.parse(raw.toString("utf8")); } catch {}
          let outBody;
          if (parsed && parsed.model && parsed.model.startsWith("agnes")) {
            const minMaxTokens = parseInt(process.env.AGNES_MIN_MAX_TOKENS || "16384");
            const maxTokens = parsed.max_tokens ?? parsed.max_completion_tokens;
            if (maxTokens == null || maxTokens <= 0 || maxTokens < minMaxTokens) {
              parsed.max_tokens = Math.min(Math.max(maxTokens || 0, minMaxTokens), 65536);
              delete parsed.max_completion_tokens;
            }
            outBody = Buffer.from(JSON.stringify(parsed));
          } else {
            outBody = Buffer.from(raw);
          }
          // Enforce tool_choice: "required" when tools are defined (agnes models only)
          if (parsed && Array.isArray(parsed.tools) && parsed.tools.length > 0 && !parsed.tool_choice) {
            const model = (parsed.model || "").toLowerCase();
            if (model.startsWith("agnes")) {
              parsed.tool_choice = "required";
              outBody = Buffer.from(JSON.stringify(parsed));
            }
          }
          init.body = outBody;
          if (outBody.length > 0) init.duplex = "half";
          headers["content-length"] = String(outBody.length);
        }

        // Upstream acquisition: key rotation + pre-commit validation.
        // Client headers are NOT sent until the first valid SSE data line
        // arrives. Fast failures (throw, non-200, empty EOF, 120s without
        // data) are retried transparently; 429/401/403 rotates the API key.
        let upstream = null;
        let lastErr = null;
        let lastStatus = 0;
        let lastErrBody = "";
        let preCommit = null;
        const MAX_UP_ATTEMPTS = 3;
        const COMMIT_TIMEOUT_MS = 120000;
        for (let attempt = 1; attempt <= MAX_UP_ATTEMPTS && !preCommit; attempt++) {
          upstream = null; lastErr = null;
          for (let k = 0; k < AGNES_KEYS.length; k++) {
            headers["authorization"] = `Bearer ${AGNES_KEYS[usedIdx]}`;
            if (useSleev) {
              headers["sleeve-harness"] = "opencode";
              headers["sleeve-base-url"] = `${UPSTREAM}/v1`; // base only: gateway appends req path itself
            }
            init.headers = headers;
            try { upstream = await fetch(targetURL, init); } catch (err) {
              lastErr = err; keyHealth[usedIdx] = { healthy: false, lastError: Date.now() }; usedIdx = pickKey(undefined); continue;
            }
            if ((upstream.status === 429 || upstream.status === 401 || upstream.status === 403) && k + 1 < AGNES_KEYS.length) {
              await upstream.body?.cancel?.(); keyHealth[usedIdx] = { healthy: false, lastError: Date.now() }; usedIdx = pickKey(undefined);
              if (cachedSession) cachedSession.tokenIndex = usedIdx; continue;
            }
            break;
          }
          if (!upstream) continue;
          if (upstream.status !== 200) {
            lastStatus = upstream.status;
            lastErrBody = upstream.body ? await upstream.text().catch(() => "") : "";
            keyHealth[usedIdx] = { healthy: false, lastError: Date.now() };
            continue;
          }
          if (!upstream.body) continue;
          const tryReader = upstream.body.getReader();
          const tryFixer = new SseToolCallFix();
          const head = [];
          const deadline = Date.now() + COMMIT_TIMEOUT_MS;
          let ok = false;
          try {
            while (Date.now() < deadline) {
              const { done, value } = await tryReader.read();
              if (done) break; // EOF before any data — dead attempt
              const { lines } = tryFixer.processChunk(value);
              for (const line of lines) {
                head.push(line);
                const t = line.toString("utf8");
                if (t.startsWith("data:") || t.includes("[DONE]")) { ok = true; break; }
              }
              if (ok) break;
            }
          } catch (e) { lastErr = e; }
          if (ok) { preCommit = { reader: tryReader, fixer: tryFixer, head }; break; }
          try { await tryReader.cancel(); } catch {}
          if (attempt < MAX_UP_ATTEMPTS) console.log(`[agnes-proxy] no SSE data (attempt ${attempt}/${MAX_UP_ATTEMPTS}), retrying`);
        }

        if (!preCommit) {
          if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream" });
          const msg = lastStatus
            ? `Upstream ${lastStatus}: ${lastErrBody.substring(0, 200)}`
            : `Upstream gave no SSE data after ${MAX_UP_ATTEMPTS} attempts: ${lastErr?.message || String(lastErr) || "empty stream"}`;
          try { res.end(`data: ${JSON.stringify({ error: { message: msg, type: "proxy_error" } })}\n\ndata: [DONE]\n\n`); } catch {}
          return;
        }

        if (fingerprint != null) {
          if (!cachedSession) trackConversationSession(fingerprint, { tokenIndex: usedIdx, requestCount: 1 });
          else { cachedSession.requestCount++; cachedSession.tokenIndex = usedIdx; trackConversationSession(fingerprint, cachedSession); }
        }

        // Commit: headers + validated head, then stream the rest through
        const outHeaders = {};
        const ctype = upstream.headers.get("content-type");
        if (ctype) outHeaders["content-type"] = ctype;
        res.writeHead(200, outHeaders);
        reader = preCommit.reader;
        const fixer = preCommit.fixer;
        let sawDone = false;
        let streamErr = null;
        const frameOf = (chunk) => {
          const text = chunk.toString("utf8");
          return text.endsWith("\n\n") ? chunk : Buffer.concat([chunk, Buffer.from("\n")]);
        };
        // Write one SSE chunk, injecting a synthesized finish chunk ahead of
        // [DONE] when the upstream omitted finish_reason for the whole stream.
        const emitChunk = async (chunk) => {
          if (clientGone || res.destroyed) return false;
          const text = chunk.toString("utf8");
          if (text.includes("[DONE]")) {
            sawDone = true;
            if (fixer.needsFinishSynth()) {
              res.write(frameOf(fixer.synthFinishChunk()));
              if (!res.writableNeedDrain) { /* fall through */ }
              else {
                await new Promise((r) => { res.once("drain", r); res.once("close", r); });
                if (clientGone || res.destroyed) return false;
              }
            }
          }
          res.write(frameOf(chunk));
          if (!res.writableNeedDrain) return !(clientGone || res.destroyed);
          await new Promise((r) => { res.once("drain", r); res.once("close", r); });
          return !(clientGone || res.destroyed);
        };
        try {
          for (const chunk of preCommit.head) {
            if (!await emitChunk(chunk)) break;
          }
          for (;;) {
            const { done, value } = await reader.read();
            if (done || clientGone || res.destroyed) break;
            const { lines } = fixer.processChunk(value);
            for (const chunk of lines) {
              if (!await emitChunk(chunk)) break;
            }
          }
        } catch (e) { streamErr = e; }
        if (!clientGone && !res.destroyed) {
          const tail = fixer.flush();
          if (tail.length) await emitChunk(tail);
          // Never leave the client hanging on an unterminated stream
          if (!sawDone) {
            if (fixer.needsFinishSynth()) {
              // Upstream closed the stream but never sent finish_reason —
              // synthesize it so the client's parser sees a complete stream.
              try { res.write(frameOf(fixer.synthFinishChunk())); res.write("data: [DONE]\n\n"); } catch {}
            } else {
              const msg = streamErr
                ? `Upstream stream error: ${streamErr?.message || "unknown"}`
                : `Upstream closed the stream without [DONE]`;
              try { res.write(`data: ${JSON.stringify({ error: { message: msg, type: "proxy_error" } })}\n\ndata: [DONE]\n\n`); } catch {}
            }
          }
          res.end();
        }
      } catch (err) {
        const msg = err?.message || String(err);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          try { res.end(JSON.stringify({ error: { message: msg, type: "proxy_error" } })); } catch {}
        } else if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({ error: { message: msg, type: "proxy_error" } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
        }
      }
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`[agnes-proxy] 127.0.0.1:8090 already bound by another instance — standing down`);
        return;
      }
      console.error(`[agnes-proxy] server error:`, err);
    });

    // Hot-reload safety: a previous setup() in this process may still hold
    // the port (plugin reload does not tear it down). Destroy it first so
    // the fresh code actually binds instead of standing down on EADDRINUSE.
    // (In-flight proxied streams break once at reload — acceptable.)
    try {
      const prev = globalThis.__agnesProxyServer;
      globalThis.__agnesProxyServer = null;
      if (prev) {
        try { prev.closeAllConnections?.(); } catch {}
        await new Promise((resolve) => { try { prev.close(resolve); } catch { resolve(); } });
      }
    } catch {}
    globalThis.__agnesProxyServer = server;

    server.listen(PORT, HOST, () => {
      console.log(`[agnes-proxy] listening on http://${HOST}:${PORT} -> ${UPSTREAM} (${AGNES_KEYS.length} keys)`);
    });
  },
};
