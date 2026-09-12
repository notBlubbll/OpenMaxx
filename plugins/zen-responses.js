// zen-responses.js — OpenCode V2 plugin (round 3).
// Goal: force the OpenAI Responses wire for provider `commandcode` / model
// `meta/muse-spark-1.3-contributor`, so traffic reaches tinyproxy's Zen branch
// (/v1/responses) instead of /v1/chat/completions.
//
// Root cause being worked around: the project opencode.json overrides the provider's
// `package` with a NON-`aisdk:` value, so the model resolver bypasses the aisdk hook
// path entirely and the language hook can never fire. Round 3 registers a
// `ctx.catalog.transform` that rewrites the provider package via a MAPPER FUNCTION
// (provider.update(id, p => ({...p, package: "aisdk:@ai-sdk/openai"}))), then reloads
// the catalog, and keeps the aisdk `language` hook that sets `evt.language =
// evt.sdk.responses(id)`. Everything is defensive; opencode startup is never broken.

import { appendFileSync } from "node:fs";

const LOG_URL = new URL("./.zen-responses.log", import.meta.url);
const PROVIDER_ID = "commandcode";
const MODEL_ID = "meta/muse-spark-1.3-contributor";
const AISDK_OPENAI_PACKAGE = "aisdk:@ai-sdk/openai";
let hookCalls = 0;

function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg + "\n";
  try { appendFileSync(LOG_URL, line); } catch {}
  try { console.error("[zen-responses] " + msg); } catch {}
}

function err(e) {
  try { return e && e.message ? e.message : String(e); } catch { return "?"; }
}

function brief(o) {
  try {
    return JSON.stringify(o, (k, v) => (typeof v === "function" ? "[fn]" : v));
  } catch { return "[unserializable]"; }
}

function safeKeys(o, depth) {
  try {
    if (!o || typeof o !== "object") return String(o);
    const keys = Object.keys(o);
    if (depth <= 0) return keys.join(",");
    return keys.map((k) => {
      let t = typeof o[k];
      if (o[k] && typeof o[k] === "object") t = "{" + safeKeys(o[k], depth - 1) + "}";
      return k + ":" + t;
    }).join(",");
  } catch { return "?"; }
}

function norm(v) {
  if (v === null || v === undefined) return null;
  try { return String(v).toLowerCase(); } catch { return null; }
}

function providerIdOf(evt) {
  const m = evt && evt.model ? evt.model : evt;
  const candidates = [
    m && m.providerID,
    m && m.provider && m.provider.id,
    evt && evt.providerID,
    evt && evt.provider && evt.provider.id,
  ];
  for (const c of candidates) { if (c !== undefined && c !== null) return c; }
  return null;
}

function modelIdOf(evt) {
  const m = evt && evt.model ? evt.model : evt;
  const candidates = [
    m && m.api && m.api.id,
    m && m.modelID,
    m && m.id,
    evt && evt.modelID,
    evt && evt.id,
  ];
  for (const c of candidates) { if (c !== undefined && c !== null) return c; }
  return null;
}

function languageHook(evt) {
  const n = ++hookCalls;
  try {
    const providerID = providerIdOf(evt);
    const modelID = modelIdOf(evt);
    const hasResponses = !!(evt && evt.sdk && typeof evt.sdk.responses === "function");
    log("HOOK#" + n + " language provider=" + JSON.stringify(providerID) + " model=" + JSON.stringify(modelID) + " sdk.responses=" + hasResponses + " evt={" + safeKeys(evt, 2) + "}");
    if (norm(providerID) !== PROVIDER_ID) return;
    if (modelID !== MODEL_ID) { log("HOOK#" + n + " provider matched, model mismatch -> no change"); return; }
    if (!hasResponses) { log("HOOK#" + n + " sdk has no responses() -> cannot switch wire"); return; }
    evt.language = evt.sdk.responses(modelID);
    log("HOOK#" + n + " responses wire SET for " + providerID + "/" + modelID);
  } catch (e) {
    log("HOOK#" + n + " language error: " + err(e));
  }
}

function sdkHook(evt) {
  const n = ++hookCalls;
  try {
    log("HOOK#" + n + " sdk package=" + JSON.stringify(evt && evt.package) + " provider=" + JSON.stringify(providerIdOf(evt)) + " evt={" + safeKeys(evt, 2) + "}");
  } catch (e) {
    log("HOOK#" + n + " sdk error: " + err(e));
  }
}

function applyProviderRewrite(c) {
  try {
    if (!c || !c.provider || typeof c.provider.update !== "function") {
      log("transform: provider.update unavailable; keys=" + safeKeys(c && c.provider, 1));
      return;
    }
    const mapper = (p) => {
      try {
        log("transform: mapper input id=" + JSON.stringify(p && p.id) + " name=" + JSON.stringify(p && p.name) + " package=" + JSON.stringify(p && p.package) + " keys=[" + safeKeys(p, 1) + "]");
        if (!p || (p.id !== PROVIDER_ID && norm(p.id) !== PROVIDER_ID && p.name !== "CommandCode")) return p;
        if (p.package === AISDK_OPENAI_PACKAGE) { log("transform: package already " + AISDK_OPENAI_PACKAGE); return p; }
        const next = { ...p, package: AISDK_OPENAI_PACKAGE };
        log("transform: rewrite " + JSON.stringify(p.package) + " -> " + AISDK_OPENAI_PACKAGE + " nextKeys=[" + safeKeys(next, 1) + "]");
        return next;
      } catch (e) {
        log("transform: mapper error: " + err(e));
        return p;
      }
    };
    c.provider.update(PROVIDER_ID, mapper);
    log("transform: provider.update applied");
  } catch (e) {
    log("transform: apply error: " + err(e));
  }
}

export default {
  id: "zen-responses",
  async setup(ctx) {
    const pid = (typeof process !== "undefined" && process.pid) ? process.pid : "?";
    log("setup: pid=" + pid + " round=3");

    try {
      const catalog = ctx && ctx.catalog;
      if (catalog && typeof catalog.transform === "function") {
        let r;
        try {
          r = catalog.transform(applyProviderRewrite);
        } catch (e) {
          log("transform: registration threw: " + err(e));
        }
        if (r && typeof r.then === "function") {
          try { await r; } catch (e) { log("transform: await error: " + err(e)); }
        }
        log("transform: registered");
        try {
          if (typeof catalog.reload === "function") {
            const rr = catalog.reload();
            if (rr && typeof rr.then === "function") { try { await rr; } catch (e) { log("transform: reload await error: " + err(e)); } }
            log("transform: catalog.reload() called");
          } else {
            log("transform: catalog.reload unavailable");
          }
        } catch (e) {
          log("transform: reload error: " + err(e));
        }
      } else {
        log("transform: ctx.catalog.transform unavailable; catalog keys=" + safeKeys(catalog, 1));
      }
    } catch (e) {
      log("transform: outer error: " + err(e));
    }

    const aisdk = ctx && ctx.aisdk;
    if (!aisdk) { log("setup: ctx.aisdk unavailable"); return; }
    const registered = [];
    const attempt = async (label, fn) => {
      try { await fn(); registered.push(label); } catch (e) { log("setup: " + label + " FAILED: " + err(e)); }
    };
    if (typeof aisdk.hook === "function") {
      await attempt("aisdk.hook(language)", () => aisdk.hook("language", languageHook));
      await attempt("aisdk.hook(sdk)", () => aisdk.hook("sdk", sdkHook));
    }
    if (typeof aisdk.language === "function") await attempt("aisdk.language(cb)", () => aisdk.language(languageHook));
    if (typeof aisdk.sdk === "function") await attempt("aisdk.sdk(cb)", () => aisdk.sdk(sdkHook));
    log("setup: registered = [" + registered.join(" | ") + "]");
  },
};
