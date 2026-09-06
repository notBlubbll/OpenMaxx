// agnes-proxy.js — OpenCode V2 plugin that autostarts agnes-proxy-server.js.
// Runs a health check at load + on server.connected; spawns detached+unref'd
// node child if down. Never throws; no per-tool hooks.

export default {
  id: "agnes-proxy",
  async setup(ctx) {
    const { spawn } = await import("node:child_process");
    const { appendFileSync } = await import("node:fs");
    const { basename, dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const HOST = "127.0.0.1";
    const PORT = 8090;
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SERVER_SCRIPT = join(HERE, "agnes-proxy-server.js");
    const ERR_LOG = join(HERE, ".agnes-proxy-errors.log");

    function logSpawnError(msg) {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      try { console.error(line.trim()); } catch {}
      try { appendFileSync(ERR_LOG, line); } catch {}
    }

    let resolvedNode = "node";
    try {
      const ep = process.execPath;
      if (ep && basename(ep).toLowerCase().includes("node")) resolvedNode = ep;
    } catch { /* fall through */ }
    const useShell = (resolvedNode === "node" && process.platform === "win32");
    const SPAWN_OPTS = { detached: true, stdio: "ignore", windowsHide: true, ...(useShell ? { shell: true } : {}) };

    async function isUp() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      try {
        const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: ctl.signal });
        return res.ok;
      } catch { return false; }
      finally { clearTimeout(timer); }
    }

    async function ensureRunning() {
      try {
        if (await isUp()) return;
        const child = spawn(resolvedNode, [SERVER_SCRIPT], SPAWN_OPTS);
        child.on("error", (err) => logSpawnError(`spawn error: ${err && err.message}`));
        child.on("exit", (code, signal) => logSpawnError(`child exited code=${code} signal=${signal}`));
        child.unref();
        await ctx.app?.log?.({ body: { service: "agnes-proxy", level: "info", message: `agnes-proxy starting (http://${HOST}:${PORT} -> https://apihub.agnes-ai.com/v1)` } }).catch(() => {});
        setImmediate(async () => {
          try {
            await new Promise((r) => setTimeout(r, 1500));
            if (!(await isUp())) {
              const hint = `health check still failing after spawn — possible EADDRINUSE: stale 127.0.0.1:8090 listener; run 'netstat -ano | findstr :8090' and restart opencode`;
              logSpawnError(hint);
            }
          } catch {}
        });
      } catch (err) {
        await ctx.app?.log?.({ body: { service: "agnes-proxy", level: "error", message: `ensureRunning failed: ${err && err.message ? err.message : String(err)}` } }).catch(() => {});
      }
    }

    await ensureRunning();
    // Re-check when server reconnects
    ctx.event?.subscribe?.({}).then?.(async (iter) => {
      for await (const ev of iter) {
        if (ev.type === "server.connected") await ensureRunning();
      }
    }).catch(() => {});
  },
};
