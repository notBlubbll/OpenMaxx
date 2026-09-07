// mind-automation plugin — OpenCode V2 rewrite.
//
// Migrates from V1 event hooks (event, experimental.session.compacting,
// experimental.chat.system.transform) to V2 ctx.event.subscribe().
// Uses the same mind CLI checkpoint/summary logic.

import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const MIND_BIN = "C:\\Users\\User\\Documents\\mind\\mind";
const FALLBACK_MIND_BIN = "mind";
const STATE_VERSION = 1;
const MAX_STATE_KEYS = 400;
const MAX_CONTEXT_CHARS = 1600;
const MAX_NOTES_CHARS = 800;
const MIN_CHECKPOINT_INTERVAL_MS = 90_000;
const MIN_SUMMARY_INTERVAL_MS = 240_000;
const SESSION_SUMMARY_SCHEMA = "mind.session-summary/v1";
const RECOVERY_TEXT = "Prudent session detected. Call `checkpoint_load` to restore recent work and maintain continuity.";

function safeJsonParse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function nowIso() {
  return new Date().toISOString();
}

function nowSqlTimestamp() {
  return nowIso().replace("T", " ").replace("Z", "").split(".")[0];
}

function clampText(value, maxChars) {
  const normalized = String(value ?? "").replace(/[ \t\n\r]+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function sanitizeSegment(value) {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  const fromWorktree = typeof directory === "string" ? basename(directory) : "";
  return sanitizeSegment(fromWorktree || "unknown");
}

function getProjectSpace(directory) {
  return "projects/" + buildProjectName(directory);
}

function buildSessionSummaryName(sessionId) {
  return "session-" + nowIso().replace(/[:.]/g, "-") + "-" + sanitizeSegment(sessionId);
}

function getStatePath(directory) {
  return directory + "/.mind-automation-state.json";
}

function loadState(directory) {
  const filePath = getStatePath(directory);
  if (!existsSync(filePath)) {
    return { version: STATE_VERSION, checkpoints: {}, summaries: {}, handled: {} };
  }
  const parsed = safeJsonParse(readFileSync(filePath, "utf-8"), null);
  if (!parsed || typeof parsed !== "object") {
    return { version: STATE_VERSION, checkpoints: {}, summaries: {}, handled: {} };
  }
  return {
    version: STATE_VERSION,
    checkpoints: typeof parsed.checkpoints === "object" && parsed.checkpoints ? parsed.checkpoints : {},
    summaries: typeof parsed.summaries === "object" && parsed.summaries ? parsed.summaries : {},
    handled: typeof parsed.handled === "object" && parsed.handled ? parsed.handled : {},
  };
}

function compactHandledKeys(handled) {
  const keys = Object.keys(handled);
  if (keys.length <= MAX_STATE_KEYS) return handled;
  const sorted = keys
    .map((key) => ({ key, value: Number(handled[key]) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_STATE_KEYS);
  const next = {};
  for (const item of sorted) next[item.key] = item.value;
  return next;
}

function saveState(directory, state) {
  try {
    const filePath = getStatePath(directory);
    mkdirSync(directory, { recursive: true });
    const safeState = {
      ...state,
      version: STATE_VERSION,
      handled: compactHandledKeys(state.handled ?? {}),
    };
    writeFileSync(filePath, JSON.stringify(safeState, null, 2));
  } catch {
    // Non-blocking fallback
  }
}

function hasIntervalPassed(lastByKey, key, minMs) {
  const now = Date.now();
  const previous = Number(lastByKey[key] ?? 0);
  if (Number.isFinite(previous) && previous > 0 && now - previous < minMs) return false;
  lastByKey[key] = now;
  return true;
}

function runMindCommand(args) {
  const baseOptions = { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] };
  let result = spawnSync(MIND_BIN, args, baseOptions);
  if (result.status === 0) return { ok: true, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  result = spawnSync(FALLBACK_MIND_BIN, args, baseOptions);
  return { ok: result.status === 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function ensureSessionScaffold(space, checkpointNotes) {
  runMindCommand(["create", space, "Managed by OpenCode prudent automation"]);
  runMindCommand([
    "checkpoint", "set", space, "Active OpenCode session",
    "Keep the current goal, pending work, and next action explicit",
    "--notes", checkpointNotes,
  ]);
}

function buildEventNotes(directory, payload, extra) {
  const repo = buildProjectName(directory);
  const sessionId = extractSessionId(payload);
  const sections = [
    "repo=" + repo,
    "session=" + sessionId,
    "event=" + String(payload?.type ?? "unknown"),
    extra,
    "updated=" + nowIso(),
  ].filter(Boolean);
  return clampText(sections.join(" | "), MAX_NOTES_CHARS);
}

function buildSessionSummaryContent(projectSpace, payload, summary) {
  const timestamp = nowSqlTimestamp();
  return JSON.stringify({
    goal: "",
    pending: "",
    notes: summary,
    createdAt: timestamp,
    updatedAt: timestamp,
    whatWasDone: summary,
    completedAt: timestamp,
    sessionSummary: {
      schema: SESSION_SUMMARY_SCHEMA,
      writer: { id: "opencode_automation_plugin" },
      provenance: {
        projectSpace,
        sessionId: extractSessionId(payload),
        eventType: String(payload?.type ?? "unknown"),
      },
    },
  }, null, 2);
}

function persistSessionSummary(directory, payload, summary, state) {
  const projectSpace = getProjectSpace(directory);
  const sessionId = extractSessionId(payload);
  const dedupeKey = projectSpace + ":" + sessionId;
  if (!hasIntervalPassed(state.summaries, dedupeKey, MIN_SUMMARY_INTERVAL_MS)) return;
  const safeSummary = clampText(summary, MAX_NOTES_CHARS);
  if (!safeSummary) return;
  const memoryName = buildSessionSummaryName(sessionId);
  const memoryContent = buildSessionSummaryContent(projectSpace, payload, safeSummary);
  runMindCommand(["add", projectSpace, memoryName, memoryContent, "--tags", "type:session,cat:summary", "--tier", "3"]);
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
      const notes = buildEventNotes(directory, eventPayload, extra);
      ensureSessionScaffold(projectSpace, notes);
    }

    // Map V2 event types to the actions the plugin needs.
    // V2 event stream emits events like { type: "session.created", ... } etc.
    function handleEvent(event) {
      if (!event || typeof event !== "object") return;
      try {
        const type = String(event.type || "");
        if (type === "session.created" || type === "SessionCreated") {
          checkpointForEvent(event, "Ensure project space and checkpoint at session start");
        } else if (type === "session.compacted" || type === "SessionCompacted") {
          checkpointForEvent(event, "Post-compaction checkpoint refresh and context recovery");
        } else if (type === "session.deleted" || type === "SessionDeleted") {
          const summary = buildEventNotes(directory, event, "Session end summary (prudent)");
          persistSessionSummary(directory, event, summary, state);
        }
      } catch {
        // Non-blocking fallback
      } finally {
        saveState(directory, state);
      }
    }

    // Subscribe to the V2 event stream
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          handleEvent(event);
        }
      } catch {
        // Stream ended or was aborted
      }
    })();

    // Cleanup on unload
    return () => controller.abort();
  },
};
