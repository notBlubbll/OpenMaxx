// k2-reasoning-proxy.js — keeper plugin: autostarts k2-proxy-server.js (127.0.0.1:8089).
// Runs a health check at load + on server.connected; spawns detached+unref'd
// node child if down. Never throws; no per-tool hooks (avoid overhead).
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8089;
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(HERE, "k2-proxy-server.js");

const ERR_LOG = join(HERE, ".k2-proxy-errors.log");

function logSpawnError(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { console.error(line.trim()); } catch {}
  try { appendFileSync(ERR_LOG, line); } catch {}
}

// NODE BINARY RESOLUTION (guards against non-PATH / non-node execPath contexts)
let resolvedNode = "node";
try {
  const ep = process.execPath;
  if (ep && basename(ep).toLowerCase().includes("node")) resolvedNode = ep;
} catch { /* fall through to "node" */ }
const useShell = (resolvedNode === "node" && process.platform === "win32");
const SPAWN_OPTS = { detached: true, stdio: "ignore", windowsHide: true, ...(useShell ? { shell: true } : {}) };

async function safeLog(client, message) {
  try {
    await client?.app?.log?.({ body: { service: "k2-proxy", level: "info", message } });
  } catch {}
}

async function isUp() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureRunning(client) {
  try {
    if (await isUp()) return;
    const child = spawn(resolvedNode, [SERVER_SCRIPT], SPAWN_OPTS);
    child.on("error", (err) => logSpawnError(`spawn error: ${err && err.message}`));
    child.on("exit", (code, signal) => logSpawnError(`child exited code=${code} signal=${signal}`));
    child.unref();
    await safeLog(client, `k2-proxy starting (http://${HOST}:${PORT} -> https://api.ifm.ai)`);
    // POST-SPAWN RE-HEALTH CHECK (fire-and-forget, never throw)
    setImmediate(async () => {
      try {
        await new Promise((r) => setTimeout(r, 1500));
        if (!(await isUp())) {
          const hint = `health check still failing after spawn — possible EADDRINUSE: stale 127.0.0.1:8089 listener; run 'netstat -ano | findstr :8089' and restart opencode (the stale 8089 listener dies with the old process)`;
          logSpawnError(hint);
          await safeLog(client, `k2-proxy still down after spawn: ${hint}`);
        }
      } catch { /* never throw */ }
    });
  } catch (err) {
    await safeLog(client, `k2-proxy ensureRunning failed: ${err && err.message ? err.message : String(err)}`);
  }
}

export const K2ReasoningProxy = async ({ client } = {}) => {
  // Top-level init: fire-and-forget, never throw.
  void ensureRunning(client);
  return {
    "server.connected": async () => {
      void ensureRunning(client);
    },
  };
};
