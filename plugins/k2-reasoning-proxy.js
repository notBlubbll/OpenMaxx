// k2-reasoning-proxy.js — keeper plugin: autostarts k2-proxy-server.js (127.0.0.1:8089).
// Runs a health check at load + on server.connected; spawns detached+unref'd
// node child if down. Never throws; no per-tool hooks (avoid overhead).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 8089;
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(HERE, "k2-proxy-server.js");

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
    const child = spawn("node", [SERVER_SCRIPT], { detached: true, stdio: "ignore" });
    child.unref();
    await safeLog(client, `k2-proxy starting (http://${HOST}:${PORT} -> https://api.ifm.ai)`);
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
