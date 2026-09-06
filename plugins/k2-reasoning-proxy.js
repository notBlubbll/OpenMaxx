// k2-reasoning-proxy.js — OpenCode V2 plugin that autostarts k2-proxy-server-standalone.js.
// Runs a health check at load + on server.connected; spawns detached+unref'd node child if down.

export default {
  id: "k2-reasoning-proxy",
  async setup(ctx) {
    const { spawn } = await import("node:child_process");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const HOST = "127.0.0.1";
    const PORT = 8089;
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SERVER_SCRIPT = join(HERE, "k2-proxy-server-standalone.js");

    async function isUp() {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 2000);
        const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: ctl.signal });
        clearTimeout(timer);
        return res.ok;
      } catch { return false; }
    }

    async function ensureRunning() {
      if (await isUp()) return;
      const child = spawn("node", [SERVER_SCRIPT], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    }

    await ensureRunning();
  },
};
