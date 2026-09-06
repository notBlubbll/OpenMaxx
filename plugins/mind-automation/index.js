// mind-automation plugin — OpenCode V2 rewrite.
// Uses V2 ctx.event.subscribe() instead of V1 event hooks.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MIND_BIN = "mind";
const STATE_VERSION = 1;
const MAX_STATE_KEYS = 400;
const MAX_NOTES_CHARS = 800;
const MIN_CHECKPOINT_INTERVAL_MS = 90_000;
const MIN_SUMMARY_INTERVAL_MS = 240_000;

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function nowIso() { return new Date().toISOString(); }
function clampText(value, maxChars) {
  const normalized = String(value ?? "").replace(/[ \t\n\r]+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}
function sanitizeSegment(value) {
  const text = String(value ?? "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || "unknown";
}
function extractSessionId(payload) {
  if (!payload || typeof payload !== "object") return "session-unknown";
  const direct = payload.sessionId ?? payload.id;
  if (typeof direct === "string" && direct.trim().length > 0) return direct;
  const nested = payload.session;
  if (nested && typeof nested === "object") {
    const nestedId = nested.id ?? nested.sessionId;
    if (typeof nestedId === "string" && nestedId.trim().length > 0) return nestedId;
  }
  return "session-unknown";
}
function buildProjectName(directory) {
  return sanitizeSegment(basename(directory) || "unknown");
}
function getProjectSpace(directory) { return "projects/" + buildProjectName(directory); }

function loadState(directory) {
  const filePath = directory + "/.mind-automation-state.json";
  if (!existsSync(filePath)) return { version: STATE_VERSION, checkpoints: {}, summaries: {}, handled: {} };
  const parsed = safeJsonParse(readFileSync(filePath, "utf-8"), null);
  if (!parsed || typeof parsed !== "object") return { version: STATE_VERSION, checkpoints: {}, summaries: {}, handled: {} };
  return {
    version: STATE_VERSION,
    checkpoints: typeof parsed.checkpoints === "object" && parsed.checkpoints ? parsed.checkpoints : {},
    summaries: typeof parsed.summaries === "object" && parsed.summaries ? parsed.summaries : {},
    handled: typeof parsed.handled === "object" && parsed.handled ? parsed.handled : {},
  };
}
function saveState(directory, state) {
  try {
    const filePath = directory + "/.mind-automation-state.json";
    mkdirSync(directory, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ ...state, version: STATE_VERSION }, null, 2));
  } catch {}
}
function hasIntervalPassed(lastByKey, key, minMs) {
  const now = Date.now();
  const previous = Number(lastByKey[key] ?? 0);
  if (Number.isFinite(previous) && previous > 0 && now - previous < minMs) return false;
  lastByKey[key] = now;
  return true;
}
function runMindCommand(args) {
  const result = spawnSync(MIND_BIN, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

export default {
  id: "mind-automation",
  async setup(ctx) {
    const directory = ctx.location?.directory ?? process.cwd();
    const state = loadState(directory);

    function checkpointForEvent(eventPayload, extra) {
      const projectSpace = getProjectSpace(directory);
      const checkpointKey = projectSpace + ":" + extractSessionId(eventPayload);
      if (!hasIntervalPassed(state.checkpoints, checkpointKey, MIN_CHECKPOINT_INTERVAL_MS)) return;
      const notes = clampText(`repo=${buildProjectName(directory)} session=${extractSessionId(eventPayload)} event=${String(eventPayload?.type ?? "unknown")} ${extra} updated=${nowIso()}`, MAX_NOTES_CHARS);
      runMindCommand(["create", projectSpace, "Managed by OpenCode prudent automation"]);
      runMindCommand(["checkpoint", "set", projectSpace, "Active OpenCode session", "Keep current goal and pending work explicit", "--notes", notes]);
    }

    function handleEvent(event) {
      if (!event || typeof event !== "object") return;
      try {
        const type = String(event.type || "");
        if (type === "session.created" || type === "SessionCreated") {
          checkpointForEvent(event, "Ensure project space and checkpoint at session start");
        } else if (type === "session.compacted" || type === "SessionCompacted") {
          checkpointForEvent(event, "Post-compaction checkpoint refresh and context recovery");
        } else if (type === "session.deleted" || type === "SessionDeleted") {
          const summary = clampText(`repo=${buildProjectName(directory)} session=${extractSessionId(event)} event=${String(event?.type ?? "unknown")} Session end summary (prudent) updated=${nowIso()}`, MAX_NOTES_CHARS);
          if (summary) runMindCommand(["add", getProjectSpace(directory), "session-summary-" + Date.now(), summary, "--tags", "type:session,cat:summary", "--tier", "3"]);
        }
      } catch {} finally { saveState(directory, state); }
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          handleEvent(event);
        }
      } catch {}
    })();
    return () => controller.abort();
  },
};
