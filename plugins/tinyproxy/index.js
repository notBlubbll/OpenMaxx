// tinyproxy/index.js — OpenCode V2 plugin: inline HTTP proxy for hyper.charm.land.
// Uses native fetch (works fine — earlier failures were header bugs).
// Forwards Bearer auth. Routes through Sleev if gateway is up.
// rev: stateful tool-call backfill (fix v3).
// rev: multi-provider routing (v4) — model IDs prefixed "commandcode/" route to
//      api.commandcode.ai with the CommandCode Bearer key; everything else keeps
//      the hyper.charm.land / sleev path unchanged.
// rev: full-chunk commit replay (v5) — pre-commit loop no longer drops the tail
//      of the commit chunk (batched SSE events after the first "data:" line).
// rev: exact-model routing (v6) — provider models list resolves the route by
//      exact wire-model match, so opencode refs stay single-prefix
//      ("commandcode/meta/..."); prefix-routed IDs remain supported.
// rev: provider traffic via sleev (v7) — routed providers ride the gateway when
//      it's up (dashboard visibility, per-request sleeve-base-url), with a
//      direct-to-provider fallback on gateway down / final-attempt rescue.
// rev: default-path direct rescue (v9) — the final pre-commit attempt goes
//      direct to hyper.charm.land when the gateway keeps failing, so a
//      sleev-side outage/flake never takes down glm (or any default model).
// rev: per-attempt init rebuild (v10) — fetch RequestInit is rebuilt for every
//      retry; reusing an init whose body a failed attempt consumed sent
//      empty/garbled bodies upstream (client saw EMPTY / 400-BODY).
// rev: awaited sleev probe (v11) — checkSleev is async with singleflight +
//      800ms cap; the old fire-and-forget returned stale false, routing
//      traffic direct-to-hyper where chat bodies die.
// rev: explicit 100-continue (v12) — answer `Expect: 100-continue` at once;
//      curl-style clients (>1KB bodies) stalled forever waiting for it.
// rev: bulk-JSON to SSE (v13) — hyper sometimes answers stream:true with one
//      complete chat.completion JSON (typical on prompt-cache hits); waiting
//      for `data:` lines hung to the commit deadline. Convert and commit at
//      once when content-type is not event-stream.
// rev: req-close abort fix (v14) — req 'close' fires at normal upload end,
//      NOT on client abort; mapping it to clientGone dropped every successful
//      response (client hung with zero bytes) while error paths (which never
//      checked clientGone) still delivered. Only res 'close'/errors abort.
// rev: header-driven routing + key pools (v15) — upstream + prefer-first-key
//      come per-request from opencode.json options.headers; apiKey supports
//      comma pools with sticky-first failover rotation (429/401/403, 30s
//      cooldown); table is keyless fallback; agnes max_tokens floor ported.
// rev: hardening + verbose (v8) — socket error races can no longer crash the
//      service or raw-close on the client (clientError handler, req/res error
//      swallowers, guarded writes); upstream failures log status/target/route/
//      body/stack for diagnosability.

import { createServer, request as httpRequest } from "node:http";
import { SseToolCallFix } from "../sse-toolcall-fix.js";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import fs from "node:fs";

export default {
  id: "tinyproxy",
  async setup(ctx) {
    const UPSTREAM = "https://hyper.charm.land";
    const LISTEN_HOST = "127.0.0.1";
    const PORT = 17300;
    const SLEEV_BASE = "http://127.0.0.1:17321";

    // ---- v16.2: + chat/completions SSE finish-reason sanitizer (drops spec-violating trailing chunks) ----
    const ZEN_KEY = "REDACTED"; // API keys live ONLY in opencode.json — this mirror carries NO keys.
    const ZEN_UP_URL = "https://opencode.ai/zen/v1/responses";
    const ZEN_WIRE = "/v1/responses";
    const ZEN_MODEL = "meta/muse-spark-1.3-contributor";
    const ZEN_FREE_MODEL = "muse-spark-1.3-contributor-free";
    const ZEN_LOCK_URL = new URL("./.zen-lock.json", import.meta.url);
// v16.1: per-request leg telemetry (in-memory; resets on process start)
const zenStats = { zenServed: 0, ccFallback: 0, lastLeg: null, lastLegAt: null, lastZenStatus: null };
// v16.2: SSE terminator sentinel, built from split pieces so the literal never appears contiguously in source.
const SSE_DONE_SENTINEL = "[D" + "ONE]";
function zenLogLine(probe, leg, reason) {
  try {
    console.error("[tinyproxy] zen-leg " + JSON.stringify({
      t: new Date().toISOString(),
      route: "zen-muse",
      zenStatus: probe.status === null || probe.status === undefined ? "none" : probe.status,
      leg,
      reason,
      ms: probe.ms,
    }));
  } catch {}
}
    function nextUtcMidnight(nowMs) {
      const d = new Date(nowMs);
      let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      if (!(t > nowMs)) t += 86400000;
      return t;
    }
    function readZenLock() {
      try {
        const j = JSON.parse(readFileSync(ZEN_LOCK_URL, "utf8"));
        if (j && typeof j.until === "string" && Date.parse(j.until) > Date.now()) return j;
      } catch { return null; }
      try { unlinkSync(ZEN_LOCK_URL); } catch {}
      return null;
    }
    function writeZenLock(reason) {
      try { writeFileSync(ZEN_LOCK_URL, JSON.stringify({ until: new Date(nextUtcMidnight(Date.now())).toISOString(), reason, setAt: new Date().toISOString() }, null, 2)); } catch (e) { console.error("[tinyproxy] zen lock write failed:", e?.message || e); }
    }
    function clearZenLock() {
      try { unlinkSync(ZEN_LOCK_URL); } catch {}
    }

    // --- Provider routing table (FALLBACK ONLY) ------------------------------
    // Primary routing comes per-request from opencode.json provider entries:
    //   options.headers["x-tinyproxy-upstream"] = upstream API base incl /v1
    //   options.headers["x-tinyproxy-prefer-first-key"] = "true" enables
    //   sticky-first key rotation with failover on 429/401/403.
    // API keys live ONLY in opencode.json (settings.apiKey, comma-separated
    // for pools) — this source carries NO keys. The table below only maps
    // model IDs to upstreams when no routing header is present.
    // providers[name] = { base, stripPrefix, models }
    const HDR_UPSTREAM = "x-tinyproxy-upstream";
    const HDR_FIRST_KEY = "x-tinyproxy-prefer-first-key";
    const KEY_COOLDOWN_MS = 30000;
    // upstreamId -> { sig, keys, idx, cool[] } — pools refresh when the
    // header key set changes (config edit), no restart needed.
    const POOLS = new Map();
    const PROVIDERS = {
      commandcode: {
        base: "https://api.commandcode.ai/provider/v1",
        stripPrefix: true, // upstream expects "meta/muse-spark-1.3-contributor", not "commandcode/meta/..."
        models: ["meta/muse-spark-1.3-contributor"],
      },
      agnes: {
        base: "https://apihub.agnes-ai.com/v1",
        stripPrefix: false,
        models: ["agnes-3.0-flash", "agnes-2.0-flash", "agnes-2.5-flash", "agnes-2.5-pro", "agnes-2.5-pro-alpha", "agnes-2.5-pro-beta", "agnes-image-2.5", "agnes-image-2.0-flash", "agnes-video-2.5", "agnes-video-2.5-flash", "agnes-video-v2.0"],
      },
    };

    // Split an Authorization value ("Bearer k1, k2" or bare) into a key pool.
    function parsePool(authHeader) {
      if (typeof authHeader !== "string" || !authHeader) return [];
      return authHeader
        .replace(/^\s*Bearer\s+/i, "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
    }

    function poolFor(id, keys) {
      const sig = keys.join("|");
      let p = POOLS.get(id);
      if (!p || p.sig !== sig) {
        p = { sig, keys: keys.slice(), idx: 0, cool: keys.map(() => 0) };
        POOLS.set(id, p);
      }
      return p;
    }

    // Sticky-first pick: preferred index if healthy, else next healthy key.
    function pickKey(pool, now) {
      for (let n = 0; n < pool.keys.length; n++) {
        const i = (pool.idx + n) % pool.keys.length;
        if (pool.cool[i] <= now) { pool.idx = i; return i; }
      }
      pool.idx = (pool.idx + 1) % pool.keys.length;
      return pool.idx;
    }

    function coolKey(pool, idx) { pool.cool[idx] = Date.now() + KEY_COOLDOWN_MS; }

    // Returns { provider, upstreamModel } or null for the default route.
    // 1) Exact model-key match — clean single-prefix refs: opencode sends the
    //    model key itself ("meta/muse-spark-1.3-contributor"), which is already
    //    the upstream's form, so no rewrite is needed.
    // 2) Provider-prefix fallback — legacy "commandcode/..." wire IDs still
    //    route and get their prefix stripped for the upstream.
    // 3) Agnes family fallback — any "agnes*" model routes to apihub.
    function resolveRoute(model) {
      if (typeof model !== "string" || !model) return null;
      for (const provider of Object.values(PROVIDERS)) {
        if (provider.models.includes(model)) return { provider, upstreamModel: model };
      }
      if (model.toLowerCase().startsWith("agnes")) {
        return { provider: PROVIDERS.agnes, upstreamModel: model };
      }
      const slash = model.indexOf("/");
      if (slash <= 0) return null;
      const prefix = model.slice(0, slash);
      const rest = model.slice(slash + 1);
      const provider = PROVIDERS[prefix];
      if (!provider) return null;
      return { provider, upstreamModel: provider.stripPrefix ? rest : model };
    }

    function extractModel(raw) {
      try {
        const parsed = JSON.parse(raw.toString("utf8"));
        return parsed && typeof parsed.model === "string" ? parsed.model : null;
      } catch {}
      return null;
    }
    // Convert a complete chat.completion JSON object (bulk answer, usually
    // on cache hits) into SSE `data:` lines the client can stream-parse.
    function bulkToSSE(text) {
      let obj;
      try { obj = JSON.parse(text); } catch { return null; }
      const choice = obj && Array.isArray(obj.choices) ? obj.choices[0] : (obj.message ? { message: obj.message } : null);
      if (!choice) return null;
      const msg = choice.message || {};
      const parts = Array.isArray(msg.content) ? msg.content : (typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : []);
      const textOut = parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
      const id = obj.id || ("chatcmpl-proxy-bulk-" + Date.now().toString(36));
      const model = obj.model || "proxy-bulk";
      const created = obj.created || Math.floor(Date.now() / 1000);
      const finish = choice.finish_reason || "stop";
      const lines = [
        Buffer.from(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: textOut }, finish_reason: null }] })}\n`, "utf8"),
        Buffer.from(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n`, "utf8"),
        Buffer.from("data: [DONE]\n", "utf8"),
      ];
      return lines;
    }
    async function tryZenLeg(req, res, raw, probe) {
      try {
        const body = JSON.parse(raw.toString("utf8"));
        body.model = ZEN_FREE_MODEL;
        const bodyStr = JSON.stringify(body);
        const headers = { ...req.headers };
        delete headers["host"];
        delete headers["connection"];
        delete headers["content-length"];
        delete headers["authorization"];
        delete headers["accept-encoding"];
        headers["accept-encoding"] = "identity";
        headers["authorization"] = "Bearer " + ZEN_KEY;
        const up = await fetch(ZEN_UP_URL, { method: "POST", headers, body: bodyStr });
    if (probe) probe.status = up.status;
        if (up.status === 429) {
          try { await up.body?.cancel?.(); } catch {}
          return "429";
        }
        if (!up.ok) {
          try { await up.body?.cancel?.(); } catch {}
          console.error("[tinyproxy] zen status " + up.status);
          return "error";
        }
        const outHeaders = {};
        up.headers.forEach((v, k) => {
          const lk = k.toLowerCase();
          if (lk === "content-encoding" || lk === "content-length" || lk === "transfer-encoding" || lk === "connection") return;
          outHeaders[k] = v;
        });
        res.writeHead(up.status, outHeaders);
        try {
          if (up.body) {
            const reader = up.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.write(Buffer.from(value))) {
                await new Promise((r) => res.once("drain", r));
              }
            }
          }
          res.end();
        } catch {}
        return "ok";
  } catch (e) {
    console.error("[tinyproxy] zen leg exception:", e?.message || e);
    if (probe) probe.status = e?.code || e?.cause?.code || e?.message || "error";
    return "error";
  }
    }
function makeResponsesTranslator() {
  const hex = (n) => { let s = ""; for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)]; return s; };
  const responseId = "resp_" + hex(16);
  const msgItemId = "msg_" + hex(16);
  const createdAt = Math.floor(Date.now() / 1000);
  let started = false, textStarted = false, textBuf = "", msgOutputIndex = null, nextOutputIndex = 0, usage = null, finished = false, closed = false, buf = "";
  const toolCalls = new Map();
  const frame = (type, obj) => "event: " + type + "\ndata: " + JSON.stringify(obj) + "\n\n";
  const created = () => { started = true; return frame("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: createdAt, status: "in_progress", model: ZEN_MODEL, output: [] } }); };
  const closeItems = () => {
    if (closed) return [];
    closed = true;
    const out = [];
    if (textStarted) {
      out.push(frame("response.output_text.done", { type: "response.output_text.done", item_id: msgItemId, output_index: msgOutputIndex, content_index: 0, text: textBuf }));
      out.push(frame("response.output_item.done", { type: "response.output_item.done", output_index: msgOutputIndex, item: { type: "message", id: msgItemId, status: "completed", role: "assistant", content: [{ type: "output_text", text: textBuf, annotations: [] }] } }));
    }
    for (const tc of [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      out.push(frame("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: tc.itemId, output_index: tc.outputIndex, arguments: tc.argsBuf }));
      out.push(frame("response.output_item.done", { type: "response.output_item.done", output_index: tc.outputIndex, item: { type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: tc.argsBuf, status: "completed" } }));
    }
    return out;
  };
  const completed = () => {
    const i = usage?.prompt_tokens ?? 0, o = usage?.completion_tokens ?? 0;
    return frame("response.completed", { type: "response.completed", response: { id: responseId, object: "response", created_at: createdAt, status: "completed", model: ZEN_MODEL, output: [], usage: { input_tokens: i, output_tokens: o, total_tokens: usage?.total_tokens ?? (i + o) } } });
  };
  const handleChunk = (chunk) => {
    const out = [];
    if (!started) out.push(created());
    if (chunk.usage) usage = chunk.usage;
    const ch = chunk.choices && chunk.choices[0];
    if (!ch) return out;
    const d = ch.delta || {};
    if (typeof d.content === "string" && d.content.length) {
      if (msgOutputIndex === null) {
        msgOutputIndex = nextOutputIndex++;
        out.push(frame("response.output_item.added", { type: "response.output_item.added", output_index: msgOutputIndex, item: { type: "message", id: msgItemId, status: "in_progress", role: "assistant", content: [] } }));
      }
      textStarted = true; textBuf += d.content;
      out.push(frame("response.output_text.delta", { type: "response.output_text.delta", item_id: msgItemId, output_index: msgOutputIndex, content_index: 0, delta: d.content }));
    }
    if (Array.isArray(d.tool_calls)) {
      for (const raw of d.tool_calls) {
        const idx = typeof raw.index === "number" ? raw.index : 0;
        let tc = toolCalls.get(idx);
        if (!tc) {
          tc = { outputIndex: nextOutputIndex++, itemId: "fc_" + hex(16), callId: raw.id || ("call_" + hex(16)), name: raw.function?.name || "", argsBuf: "" };
          toolCalls.set(idx, tc);
          out.push(frame("response.output_item.added", { type: "response.output_item.added", output_index: tc.outputIndex, item: { type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: "", status: "in_progress" } }));
        } else {
          if (!tc.callId && raw.id) tc.callId = raw.id;
          if (!tc.name && raw.function?.name) tc.name = raw.function.name;
        }
        const arg = raw.function?.arguments;
        if (typeof arg === "string" && arg.length) {
          tc.argsBuf += arg;
          out.push(frame("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: tc.itemId, output_index: tc.outputIndex, delta: arg }));
        }
      }
    }
    if (ch.finish_reason) out.push(...closeItems());
    return out;
  };
  const feed = (text) => {
    const out = [];
    try {
      buf += String(text);
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[D" + "ONE]") { out.push(...closeItems()); continue; }
        let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
        if (!chunk || typeof chunk !== "object") continue;
        out.push(...handleChunk(chunk));
      }
    } catch (e) { try { console.error("[tinyproxy] responses translator feed error:", e?.message || e); } catch {} }
    return out;
  };
  const finish = () => {
    if (finished) return [];
    finished = true;
    const out = [];
    try {
      if (buf.trim().startsWith("data:")) { const tail = buf; buf = ""; out.push(...feed(tail + "\n")); }
      if (!started) out.push(created());
      out.push(...closeItems());
      out.push(completed());
    } catch (e) {
      try { console.error("[tinyproxy] responses translator finish error:", e?.message || e); } catch {}
      try {
        if (!started) out.push(created());
        out.push(frame("response.failed", { type: "response.failed", response: { id: responseId, object: "response", created_at: createdAt, status: "failed", model: ZEN_MODEL, error: { code: "proxy_translation_error", message: String(e?.message || e) } } }));
      } catch {}
    }
    return out;
  };
  return { feed, finish };
}
    function responsesToChat(body) {
      const out = {};
      out.model = ZEN_MODEL;
      const msgs = [];
      if (typeof body.instructions === "string" && body.instructions.length > 0) {
        msgs.push({ role: "system", content: body.instructions });
      }
      const input = body.input;
      if (typeof input === "string") {
        msgs.push({ role: "user", content: input });
      } else if (Array.isArray(input)) {
        for (const item of input) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "function_call") {
            const call = { id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}) } };
            const prev = msgs[msgs.length - 1];
            if (prev && prev.role === "assistant" && Array.isArray(prev.tool_calls)) prev.tool_calls.push(call);
            else msgs.push({ role: "assistant", content: null, tool_calls: [call] });
          } else if (item.type === "function_call_output") {
            msgs.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
          } else if (item.type === "reasoning") {
            continue;
          } else if (item.role && item.content !== undefined) {
            let content = "";
            if (typeof item.content === "string") content = item.content;
            else if (Array.isArray(item.content)) {
              const parts = [];
              for (const p of item.content) {
                if (!p || typeof p !== "object") continue;
                if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") parts.push(p.text);
              }
              content = parts.join("");
            } else continue;
            msgs.push({ role: item.role, content });
          } else {
            continue;
          }
        }
      }
      out.messages = msgs;
      if (Array.isArray(body.tools)) {
        out.tools = body.tools
          .filter((t) => t && t.type === "function")
          .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      }
      if (body.tool_choice !== undefined) {
        const tc = body.tool_choice;
        if (typeof tc === "string") out.tool_choice = tc;
        else if (tc && typeof tc === "object") {
          if (typeof tc.name === "string") out.tool_choice = { type: "function", function: { name: tc.name } };
        }
      }
      if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
      if (body.temperature !== undefined) out.temperature = body.temperature;
      if (body.top_p !== undefined) out.top_p = body.top_p;
      if (body.stream !== undefined) out.stream = body.stream;
      return out;
    }
    function writeResponsesError(res, msg) {
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "tinyproxy: " + msg, type: "proxy_error" } }));
      } catch {}
    }
    // -----------------------------------------------------------------------

    let sleevCache = false;
    let sleevLastCheck = 0;
    let sleevInflight = null;

    // ---- nudge filter + context meter (A/B) -------------------------------
    const contextMeter = { model: null, estTokens: null, limitContext: null, fillPct: null, stripped: 0, updatedAt: null, _lastSig: null };
    const MODELS_DEV_PATH = "C:\\Users\\User\\AppData\\Local\\sleev\\models.dev.json";
    let _modelsDevCache = { catalog: null, mtimeMs: 0 };
    function loadModelsDev() {
      try {
        const st = fs.statSync(MODELS_DEV_PATH);
        if (_modelsDevCache.catalog && _modelsDevCache.mtimeMs === st.mtimeMs) return _modelsDevCache.catalog;
        const catalog = JSON.parse(fs.readFileSync(MODELS_DEV_PATH, "utf8"));
        _modelsDevCache = { catalog, mtimeMs: st.mtimeMs };
        return catalog;
      } catch { return null; }
    }
    function lookupContextLimit(model) {
      try {
        if (typeof model !== "string" || !model) return null;
        let m = model;
        const hash = m.indexOf("#");
        if (hash >= 0) m = m.slice(0, hash);
        m = m.trim();
        if (!m) return null;
        const ml = m.toLowerCase();
        for (const p of ["commandcode/", "hypercharm/"]) {
          if (ml.startsWith(p)) { m = m.slice(p.length); break; }
        }
        const catalog = loadModelsDev();
        if (!catalog || typeof catalog !== "object") return null;
        const names = Object.keys(catalog);
        const ctxOf = (n) => {
          try {
            const raw = n && typeof n === "object" && n.limit && typeof n.limit === "object" ? n.limit.context : undefined;
            if (raw == null) return null;
            const v = Number(raw);
            return Number.isFinite(v) ? v : null;
          } catch { return null; }
        };
        const modelsOf = (p) => (p && typeof p === "object" && p.models && typeof p.models === "object") ? p.models : null;
        if (catalog[m] && typeof catalog[m] === "object") {
          const c = ctxOf(catalog[m]);
          if (c != null) return c;
        }
        const mLow = m.toLowerCase();
        for (const k of names) {
          if (k.toLowerCase() === mLow && catalog[k] && typeof catalog[k] === "object") {
            const c = ctxOf(catalog[k]);
            if (c != null) return c;
          }
        }
        for (const k of names) {
          const kl = k.toLowerCase();
          if (kl === "commandcode" || kl === "hypercharm") continue;
          const models = modelsOf(catalog[k]);
          if (!models) continue;
          if (models[m] && typeof models[m] === "object") {
            const c = ctxOf(models[m]);
            if (c != null) return c;
          }
          const slash = m.indexOf("/");
          if (slash > 0 && m.slice(0, slash).toLowerCase() === kl) {
            const rest = m.slice(slash + 1);
            if (models[rest] && typeof models[rest] === "object") {
              const c = ctxOf(models[rest]);
              if (c != null) return c;
            }
          }
        }
        for (const k of names) {
          const kl = k.toLowerCase();
          if (kl === "commandcode" || kl === "hypercharm") continue;
          const models = modelsOf(catalog[k]);
          if (!models) continue;
          for (const id of Object.keys(models)) {
            if (id.toLowerCase() === mLow && models[id] && typeof models[id] === "object") {
              const c = ctxOf(models[id]);
              if (c != null) return c;
            }
          }
          const slash = m.indexOf("/");
          if (slash > 0 && m.slice(0, slash).toLowerCase() === kl) {
            const restLow = m.slice(slash + 1).toLowerCase();
            for (const id of Object.keys(models)) {
              if (id.toLowerCase() === restLow && models[id] && typeof models[id] === "object") {
                const c = ctxOf(models[id]);
                if (c != null) return c;
              }
            }
          }
        }
        return null;
      } catch { return null; }
    }
    function estimateRequestTokens(body) {
      try {
        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return 0;
        let chars = 0;
        let count = 0;
        for (const msg of body.messages) {
          if (!msg || typeof msg !== "object") continue;
          count++;
          const c = msg.content;
          if (typeof c === "string") chars += c.length;
          else if (Array.isArray(c)) {
            for (const part of c) {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") chars += part.text.length;
            }
          }
        }
        return Math.ceil(chars / 4) + 4 * count;
      } catch { return 0; }
    }
    const NUDGE_SPAN_RE = /<sle[a-z-]*-system-reminder[^>]*>[\s\S]*?<\/sle[a-z-]*-system-reminder>/g;
    function stripNudgeText(text) {
      if (typeof text !== "string" || text.indexOf("Context emergency") < 0) return { text, stripped: 0 };
      let stripped = 0;
      const out = text.replace(NUDGE_SPAN_RE, (span) => {
        if (span.indexOf("Context emergency") >= 0) { stripped++; return ""; }
        return span;
      });
      return { text: out, stripped };
    }

    // Awaited gateway probe with singleflight: concurrent requests share one
    // in-flight probe; result cached 5s. Never fire-and-forget — a stale
    // false routes traffic direct-to-hyper where chat bodies die.
    function checkSleev() {
      if (Date.now() - sleevLastCheck < 5000) return Promise.resolve(sleevCache);
      if (sleevInflight) return sleevInflight;
      sleevLastCheck = Date.now();
      sleevInflight = new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; sleevCache = v; sleevInflight = null; resolve(v); } };
        const timer = setTimeout(() => finish(sleevCache), 800);
        try {
          const req = httpRequest(`${SLEEV_BASE}/health`, { method: "GET", timeout: 700 }, (res) => {
            clearTimeout(timer);
            finish(true); // any HTTP response = gateway alive (it 400s without harness headers)
            res.resume();
          });
          req.on("error", () => { clearTimeout(timer); finish(false); });
          req.on("timeout", () => { try { req.destroy(); } catch {} clearTimeout(timer); finish(false); });
          req.end();
        } catch { clearTimeout(timer); finish(false); }
      });
      return sleevInflight;
    }

    function collect(req) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
        req.on("error", reject);
      });
    }

    const server = createServer();
    // Explicit 100-continue: clients sending `Expect: 100-continue`
    // (curl for bodies >1KB) stall forever if the interim response is not
    // sent promptly — answer immediately, then run the normal handler.
    const onRequest = async (req, res) => {
      let clientGone = false;
      try {
        const reqPath = req.url || "/";

        // Async socket errors (client aborts, RST races) must never surface as
        // unhandled 'error' events — that would take the whole service down.
        // NOTE: do NOT map req 'close' to clientGone — IncomingMessage emits
        // 'close' when the upload simply FINISHES (after 'end'), long before
        // any response is sent; treating it as an abort drops every successful
        // response (client hangs with zero bytes). Only res 'close' (response
        // torn down) and real errors mark the client gone (v14 fix).
        req.on("error", () => { clientGone = true; });
        res.on("error", (e) => { clientGone = true; console.error(`[tinyproxy] response socket error:`, e?.message || e); });
        res.on("close", () => { clientGone = true; });

        if (req.method === "GET" && reqPath.split("?")[0] === "/health") {
          checkSleev().catch(() => {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            status: "ok",
            rev: "v16.2",
            upstream: `${UPSTREAM}/v1`,
            sleev: sleevCache,
            pools: Object.fromEntries(
              [...POOLS.entries()].map(([k, p]) => [k, { size: p.keys.length, idx: p.idx }])
            ),
            routes: Object.fromEntries(
              Object.entries(PROVIDERS).map(([name, p]) => [name, { base: p.base, models: p.models }])
            ),
            zen: { primary: ZEN_FREE_MODEL, wire: ZEN_WIRE },
    zenStats,
            zenLock: (() => { const l = readZenLock(); return { active: !!l, until: l ? l.until : null }; })(),
            context: { model: contextMeter.model, estTokens: contextMeter.estTokens, limitContext: contextMeter.limitContext, fillPct: contextMeter.fillPct, stripped: contextMeter.stripped, updatedAt: contextMeter.updatedAt },
          }));
          return;
        }

        let raw = await collect(req);
        const reqPathOnly = reqPath.split("?")[0];
        let zenFallback = false;
        let respTx = null;
        if (reqPathOnly === ZEN_WIRE) {
          const zenModel = extractModel(raw);
          if (zenModel !== ZEN_MODEL) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: `tinyproxy: no route for model ${zenModel} on ${ZEN_WIRE}`, type: "invalid_request_error" } }));
    return;
  }
  const tele = { probe: { status: null }, leg: "zen", reason: null, t0: Date.now(), done: false };
  const emitZenTelemetry = () => {
    if (tele.done) return;
    tele.done = true;
    tele.probe.ms = Date.now() - tele.t0;
    zenStats.lastLeg = tele.leg;
    zenStats.lastLegAt = new Date().toISOString();
    zenStats.lastZenStatus = tele.probe.status;
    if (tele.leg === "zen") zenStats.zenServed++; else zenStats.ccFallback++;
    zenLogLine(tele.probe, tele.leg, tele.reason || "unknown");
  };
  res.once("finish", emitZenTelemetry);
  res.once("close", emitZenTelemetry);
  const lock = readZenLock();
  if (lock) {
    tele.leg = "commandcode"; tele.reason = "lock-active";
    console.error(`[tinyproxy] zen locked until ${lock.until} (${lock.reason}) -> CommandCode fallback`);
    zenFallback = true;
  } else {
    const outcome = await tryZenLeg(req, res, raw, tele.probe);
    if (outcome === "ok") { tele.reason = "primary-ok"; return; }
    if (outcome === "429") { tele.leg = "commandcode"; tele.reason = "429-lock-set"; writeZenLock("429 free usage exceed"); console.error("[tinyproxy] zen 429 -> lock written until " + new Date(nextUtcMidnight(Date.now())).toISOString()); }
    else { tele.leg = "commandcode"; tele.reason = "zen-" + (tele.probe.status === null ? "error" : tele.probe.status) + "-fallback"; console.error("[tinyproxy] zen leg error -> CommandCode fallback"); }
    zenFallback = true;
  }
          if (zenFallback) {
            try {
              raw = Buffer.from(JSON.stringify(responsesToChat(JSON.parse(raw.toString("utf8")))), "utf8");
              respTx = makeResponsesTranslator();
            } catch (e) {
              console.error("[tinyproxy] responses->chat translation failed:", e?.message || e);
              writeResponsesError(res, e?.message || "request translation failed");
              return;
            }
          }
        }
        const upstreamPath = zenFallback ? "/v1/chat/completions" : reqPath;
        const route = resolveRoute(extractModel(raw));
        const useSleev = await checkSleev();

        // Clean forwarded headers — strip hop-by-hop
        const headers = { ...req.headers };
        for (const h of ["host", "content-length", "transfer-encoding", "connection", "keep-alive"]) {
          delete headers[h];
        }

        // Header-driven routing (v15): opencode.json provider entries steer
        // per request. Never forward routing metadata upstream.
        const hdrUpstream = (headers[HDR_UPSTREAM] || "").trim();
        const preferFirst = (headers[HDR_FIRST_KEY] || "").toLowerCase() === "true";
        delete headers[HDR_UPSTREAM];
        delete headers[HDR_FIRST_KEY];

        // Effective upstream: explicit header wins, else table base, else null
        // (default hyper path). Header value already includes /v1 (it doubles
        // as the sleeve-base-url).
        const effUpstream = hdrUpstream || (route ? route.provider.base : null);
        // Key pool identity follows the effective upstream (falls back to the
        // default hyper upstream so unrouted models pool sanely too).
        const poolId = effUpstream || `${UPSTREAM}/v1`;
        const keyPool = parsePool(headers["authorization"]);
        const pool = keyPool.length ? poolFor(poolId, keyPool) : null;
        // Sticky-first rotation only with the flag; otherwise first key only.
        const rotate = preferFirst && !!pool && pool.keys.length > 1;
        let curIdx = pool ? pickKey(pool, Date.now()) : -1;
        const applyKey = (h) => {
          if (pool && curIdx >= 0) h["authorization"] = `Bearer ${pool.keys[curIdx]}`;
        };
        applyKey(headers);

        // Compute the upstream target + auth headers for this request.
        // effUpstream (header override or table base) doubles as the
        // sleeve-base-url when riding the gateway. Direct targets strip the
        // local /v1 mount (effUpstream already ends in /v1).
        const applyTarget = (headers, effUp, viaSleev, reqPath) => {
          if (effUp && viaSleev) {
            headers["sleeve-harness"] = "opencode";
            headers["sleeve-base-url"] = effUp;
            return `${SLEEV_BASE}${upstreamPath}`;
          }
          if (effUp && !viaSleev) {
            const suffix = upstreamPath.replace(/^\/v1(?=\/)/, "");
            return `${effUp}${suffix}`;
          }
          if (viaSleev) {
            headers["sleeve-harness"] = "opencode";
            headers["sleeve-base-url"] = `${UPSTREAM}/v1`; // gateway strips leading /v1 from req path, so base MUST include it
            return `${SLEEV_BASE}${upstreamPath}`;
          }
          return `${UPSTREAM}${upstreamPath}`;
        };

        let viaSleev = useSleev;
        let targetURL = applyTarget(headers, effUpstream, viaSleev, upstreamPath);

        // Build the (possibly model-rewritten) body for an attempt.
        // Includes the agnes max_tokens floor (ported from agnes-proxy):
        // agnes upstreams reject tiny/absent max_tokens.
        const bodyBufOf = (rawBody, r) => {
          if (!rawBody || !rawBody.length || req.method === "GET" || req.method === "HEAD") return undefined;
          try {
            const parsed = JSON.parse(rawBody.toString("utf8"));
            if (r && parsed.model !== r.upstreamModel) parsed.model = r.upstreamModel;
            const model = (parsed.model || "");
            if (/^agnes/i.test(model) || (effUpstream && /agnes-ai\.com/i.test(effUpstream))) {
              const MIN = parseInt(process.env.AGNES_MIN_MAX_TOKENS || "16384", 10);
              const mt = parsed.max_tokens ?? parsed.max_completion_tokens;
              if (mt == null || mt <= 0 || mt < MIN) {
                parsed.max_tokens = Math.min(Math.max(mt || 0, MIN), 65536);
                delete parsed.max_completion_tokens;
              }
            }
            if (Array.isArray(parsed.tools) && parsed.tools.length > 0 && !parsed.tool_choice) {
              if (model.toLowerCase().startsWith("agnes")) parsed.tool_choice = "required";
            }
            // ---- nudge filter + context meter (A/B): never throws ----
            try {
              let stripped = 0;
              if (Array.isArray(parsed.messages)) {
                const kept = [];
                for (const msg of parsed.messages) {
                  if (!msg || typeof msg !== "object") { kept.push(msg); continue; }
                  let msgStripped = 0;
                  const mc = msg.content;
                  if (typeof mc === "string") {
                    const r = stripNudgeText(mc);
                    msgStripped = r.stripped;
                    msg.content = r.stripped > 0 ? r.text.replace(/\s+$/, "") : r.text;
                  } else if (Array.isArray(mc)) {
                    for (const part of mc) {
                      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
                        const r = stripNudgeText(part.text);
                        msgStripped += r.stripped;
                        if (r.stripped > 0) part.text = r.text.replace(/\s+$/, "");
                        else part.text = r.text;
                      }
                    }
                  }
                  stripped += msgStripped;
                  if (msg.role === "system" && msgStripped > 0) {
                    const cc = msg.content;
                    let empty = false;
                    if (typeof cc === "string") empty = cc.trim() === "";
                    else if (Array.isArray(cc)) empty = cc.length === 0 || cc.every((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string" && p.text.trim() === "");
                    if (empty) continue;
                  }
                  kept.push(msg);
                }
                parsed.messages = kept;
              }
              const meterModel = (typeof parsed.model === "string") ? parsed.model : null;
              const est = estimateRequestTokens(parsed);
              let lim = null;
              try { lim = lookupContextLimit(meterModel); } catch { lim = null; }
              if (!Number.isFinite(lim)) lim = null;
              const fill = (lim && lim > 0) ? (Math.round((est / lim) * 1000) / 10) : null;
              contextMeter.model = meterModel;
              contextMeter.estTokens = est;
              contextMeter.limitContext = lim;
              contextMeter.fillPct = fill;
              contextMeter.stripped = stripped;
              contextMeter.updatedAt = new Date().toISOString();
              const sig = `${meterModel}|${est}|${stripped}`;
              if (contextMeter._lastSig !== sig) {
                contextMeter._lastSig = sig;
                console.log(`[tinyproxy] context: model=${meterModel} est=${est} tokens, limit=${lim}, fill=${fill}% , stripped=${stripped} reminder block(s)`);
              }
            } catch {}
            return Buffer.from(JSON.stringify(parsed));
          } catch {}
          return Buffer.from(rawBody);
        };

        // Rebuild init per attempt: reusing a fetch RequestInit whose body was
        // already consumed by a failed attempt can resend empty/garbled bodies.
        const buildInit = () => {
          const h = { ...headers };
          applyKey(h);
          const i = { method: req.method, headers: h };
          const bb = bodyBufOf(raw, route);
          if (bb) {
            i.body = bb;
            i.duplex = "half";
          }
          return i;
        };

        // Pre-commit retry: client headers are NOT sent until the first
        // valid SSE data line arrives from upstream. Fast failures
        // (refused/reset, non-200, empty EOF, 120s without data) are
        // retried transparently with a fresh connection. Once committed
        // we stream through (retry-after-partial-send is impossible).
        const MAX_ATTEMPTS = 3;
        const COMMIT_TIMEOUT_MS = 120000;
        let committed = null;
        let lastStatus = 0;
        let lastErrBody = "";
        let lastErr = null;
        let init = buildInit();
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !committed; attempt++) {
          let up = null;
          try {
            // Rescue: if a request keeps failing through the gateway (base
            // not permitted, auth mangled, model unresolvable), spend the
            // final attempt going direct. Covers provider routes AND the
            // default hyper path (sleev outages must not take down glm).
            if (attempt === MAX_ATTEMPTS && viaSleev) {
              viaSleev = false;
              delete headers["sleeve-harness"];
              delete headers["sleeve-base-url"];
              targetURL = applyTarget(headers, effUpstream, viaSleev, upstreamPath);
              console.log(`[tinyproxy] final attempt direct: ${targetURL}`);
            }
            init = buildInit();
            up = await fetch(targetURL, init);
            if (up.status !== 200) {
              lastStatus = up.status;
              lastErrBody = up.body ? await up.text().catch(() => "") : "";
              try { await up.body?.cancel?.(); } catch {}
              // Sticky-first failover: on auth/rate errors rotate to the next
              // healthy pool key (30s cooldown on the failed one) and retry.
              if ((up.status === 429 || up.status === 401 || up.status === 403) && rotate && pool.keys.length > 1) {
                coolKey(pool, curIdx);
                curIdx = pickKey(pool, Date.now());
                headers["authorization"] = `Bearer ${pool.keys[curIdx]}`;
                console.log(`[tinyproxy] key rotate pool=${poolId} idx=${curIdx}`);
              }
              continue;
            }
            if (!up.body) continue;
            // Bulk-JSON short-circuit (v13): hyper sometimes answers
            // stream:true with ONE complete chat.completion JSON object
            // (typical on prompt-cache hits) instead of SSE. It arrives as
            // application/json — waiting for `data:` lines would hang until
            // the commit deadline. Convert to SSE and commit immediately.
            const upCtype = (up.headers.get("content-type") || "").toLowerCase();
            if (!upCtype.includes("text/event-stream")) {
              const full = await up.text().catch(() => "");
              const conv = bulkToSSE(full);
              if (conv) { committed = { bulk: conv }; break; }
              // Not a convertible completion — treat as dead attempt.
              lastErrBody = full.substring(0, 200);
              continue;
            }
            const reader = up.body.getReader();
            const fixer = new SseToolCallFix();
            const head = [];
            const deadline = Date.now() + COMMIT_TIMEOUT_MS;
            let ok = false;
            while (Date.now() < deadline) {
              const { done, value } = await reader.read();
              if (done) break; // EOF before any data — dead attempt
              const { lines } = fixer.processChunk(value);
              // Consume the WHOLE commit chunk into head. Upstreams often batch
              // several SSE events (role delta + first content deltas) into one
              // network chunk; breaking at the first "data:" line discarded the
              // rest of that chunk and the response began mid-word
              // ("riting" instead of "Writing"). Commit on the flag, replay all.
              for (const line of lines) {
                head.push(line);
                const t = line.toString("utf8");
                if (t.startsWith("data:") || t.includes("[DONE]")) ok = true;
              }
              if (ok) break;
            }
            if (ok) { committed = { reader, fixer, head }; break; }
            try { await reader.cancel(); } catch {}
            if (attempt < MAX_ATTEMPTS) console.log(`[tinyproxy] no SSE data (attempt ${attempt}/${MAX_ATTEMPTS}), retrying`);
          } catch (e) { lastErr = e; }
        }
        if (!committed) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const msg = lastStatus
            ? `Upstream ${lastStatus}: ${lastErrBody.substring(0, 200)}`
            : `Upstream gave no SSE data after ${MAX_ATTEMPTS} attempts: ${lastErr?.message || "empty stream"}`;
          res.end(`data: ${JSON.stringify({ error: { message: msg, type: "proxy_error" } })}\n\ndata: [DONE]\n\n`);
          return;
        }

        res.writeHead(200, { "content-type": "text/event-stream" });
        // Bulk-JSON commit: pre-built SSE lines, no live reader/fixer.
        if (committed.bulk) {
          for (const line of committed.bulk) {
            if (shouldDropTrailing(line)) continue;
            const text = line.toString("utf8");
            if (respTx) {
              for (const f of respTx.feed(text.endsWith("\n") ? text : text + "\n")) {
                if (clientGone || res.destroyed) break;
                if (!res.write(f)) {
                  await new Promise((r) => { res.once("drain", r); res.once("close", r); });
                }
              }
            } else if (!res.write(text.endsWith("\n\n") ? line : Buffer.concat([line, Buffer.from("\n")]))) {
              await new Promise((r) => { res.once("drain", r); res.once("close", r); });
            }
            if (clientGone || res.destroyed) break;
          }
          if (respTx && !clientGone && !res.destroyed) {
            try { for (const f of respTx.finish()) res.write(f); } catch {}
          }
          try { res.end(); } catch {}
          return;
        }
        const reader = committed.reader;
        const fixer = committed.fixer;
        let sawDone = false;
let sseFinished = false; // v16.2: flips true once any choice carries a non-null finish_reason
        // Frame helper: SSE-spec blank-line event terminator
        const frameOf = (line) => {
          const text = line.toString("utf8");
          return text.endsWith("\n\n") ? line : Buffer.concat([line, Buffer.from("\n")]);
        };
        // Write one SSE line, injecting a synthesized finish chunk ahead of
        // [DONE] when the upstream omitted finish_reason for the whole stream.
        // v16.2: drop spec-violating chunks that arrive AFTER a non-null finish_reason.
// Returns true when the frame must be DROPPED. Everything else (usage-only frames,
// empty-choices frames, the DONE sentinel, unparseable frames) passes through unchanged.
const shouldDropTrailing = (line) => {
  try {
    const text = line.toString("utf8");
    const trimmed = text.trim();
    if (!trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice(5).trim();
    if (!payload) return false;
    if (payload === SSE_DONE_SENTINEL) return false;
    let obj;
    try { obj = JSON.parse(payload); } catch { return false; }
    const choices = obj && obj.choices;
    if (!Array.isArray(choices) || choices.length === 0) return false;
    const hasFinish = choices.some((c) => c && c.finish_reason != null);
    if (sseFinished) {
      const hasTrailing = choices.some((c) => {
        const d = (c && c.delta) || {};
        const tc = Array.isArray(d.tool_calls) && d.tool_calls.length > 0;
        const ct = typeof d.content === "string" && d.content.length > 0;
        return tc || ct;
      });
      if (hasTrailing) return true;
    }
    if (hasFinish) sseFinished = true;
    return false;
  } catch {
    return false;
  }
};
const emitLine = async (line) => {
  if (shouldDropTrailing(line)) return true;
          if (clientGone || res.destroyed) return false;
          const text = line.toString("utf8");
          if (respTx) {
            try {
              for (const f of respTx.feed(text.endsWith("\n") ? text : text + "\n")) {
                if (clientGone || res.destroyed) return false;
                if (!res.write(frameOf(f))) {
                  await new Promise((r) => { res.once("drain", r); res.once("close", r); });
                }
              }
            } catch (e) { console.error(`[tinyproxy] translator write failed:`, e?.message || e); return false; }
            if (text.includes("[DONE]")) sawDone = true;
            return !(clientGone || res.destroyed);
          }
          if (text.includes("[DONE]")) {
            sawDone = true;
            if (fixer.needsFinishSynth()) {
              try {
                if (!res.write(frameOf(fixer.synthFinishChunk()))) {
                  await new Promise((r) => { res.once("drain", r); res.once("close", r); });
                }
              } catch (e) { console.error(`[tinyproxy] synth write failed:`, e?.message || e); return false; }
              if (clientGone || res.destroyed) return false;
            }
          }
          try {
            if (!res.write(frameOf(line))) {
              await new Promise((r) => { res.once("drain", r); res.once("close", r); });
            }
          } catch (e) { console.error(`[tinyproxy] write failed:`, e?.message || e); return false; }
          return !(clientGone || res.destroyed);
        };
        try {
          // Forward the pre-commit head first (already validated SSE)
          // >>> v16 translator hook <<<
          for (const line of committed.head) {
            if (!await emitLine(line)) break;
          }
          // >>> v16 translator hook <<<
          for (;;) {
            if (clientGone || res.destroyed) break;
            const { done, value } = await reader.read();
            if (done) {
              const tail = fixer.flush();
              if (tail.length) await emitLine(tail);
              break;
            }
            const { lines } = fixer.processChunk(value);
            for (const line of lines) {
              if (!await emitLine(line)) break;
            }
          }
        } catch (streamErr) {
          console.error(`[tinyproxy] stream error:`, streamErr?.message);
          lastErr = streamErr;
        }
        // Never leave the client hanging on an unterminated stream.
        if (!clientGone && !res.destroyed) {
          if (respTx) {
            for (const f of respTx.finish()) {
              try { res.write(frameOf(f)); } catch {}
            }
          } else if (!sawDone) {
            if (fixer.needsFinishSynth()) {
              // Upstream closed the stream but never sent finish_reason —
              // synthesize it so the client's parser sees a complete stream.
              try { res.write(frameOf(fixer.synthFinishChunk())); res.write("data: [DONE]\n\n"); } catch {}
            } else {
              const msg = lastErr
                ? `Upstream stream error: ${lastErr?.message || "unknown"}`
                : `Upstream closed the stream without [DONE]`;
              try { res.write(`data: ${JSON.stringify({ error: { message: msg, type: "proxy_error" } })}\n\ndata: [DONE]\n\n`); } catch {}
            }
          }
          res.end();
        }
        return;
      } catch (err) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        try { res.end(`Proxy error: ${err?.message || String(err)}`); } catch {}
      }
    };
    server.on("request", onRequest);
    server.on("checkContinue", (req, res) => {
      try { res.writeContinue(); } catch {}
      onRequest(req, res);
    });

    // Hot-reload safety: a previous setup() in this process may still hold
    // the port (plugin reload does not tear it down). Destroy it first so
    // the fresh code actually binds instead of dying with EADDRINUSE.
    // (In-flight proxied streams break once at reload — acceptable.)
    try {
      const prev = globalThis.__tinyproxyServer;
      globalThis.__tinyproxyServer = null;
      if (prev) {
        try { prev.closeAllConnections?.(); } catch {}
        await new Promise((resolve) => { try { prev.close(resolve); } catch { resolve(); } });
      }
    } catch {}
    globalThis.__tinyproxyServer = server;

    server.listen(PORT, LISTEN_HOST, () => {
      console.log(`[tinyproxy] listening on http://${LISTEN_HOST}:${PORT} -> ${UPSTREAM}/v1`);
    });

    // Hot-reload safety: a previous setup() in this process may still hold
    // the port (plugin reload does not tear it down). Close it first so the
    // fresh code actually binds instead of dying with EADDRINUSE.
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        console.error(`[tinyproxy] port ${PORT} busy — old listener was not released; restart OpenCode to load fresh code`);
      } else {
        console.error(`[tinyproxy] server error:`, err);
      }
    });
  },
};
