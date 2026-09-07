// sleev-gateway.js — OpenCode V2 plugin that manages the Sleev gateway lifecycle.
// Ensures the gateway is running on 127.0.0.1:17321. Proxies (agnes, tinyproxy)
// just check health and route through it — they don't manage the gateway.

export default {
  id: "sleev-gateway",
  async setup(ctx) {
    const { spawn, execSync } = await import("node:child_process");
    const { appendFileSync } = await import("node:fs");

    const HOST = "127.0.0.1";
    const PORT = 17321;
    const ERR_LOG = `${process.env.USERPROFILE || process.env.TEMP || "."}\\.config\\opencode\\plugins\\.sleev-gateway-errors.log`;

    function log(msg) {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      try { console.error(line.trim()); } catch {}
      try { appendFileSync(ERR_LOG, line); } catch {}
    }

    // --- Sleev binary resolution ---
    function resolveSleevBinary() {
      try {
        const which = process.platform === "win32" ? "where" : "which";
        return execSync(`${which} sleev`, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim().split(/\r?\n/)[0];
      } catch {}
      return null;
    }

    function isSleevLoggedIn(bin) {
      const useShell = bin.endsWith(".cmd") || bin.endsWith(".bat");
      try {
        const out = execSync(`"${bin}" auth status`, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 8000, shell: useShell });
        if (out.includes('"signedIn"')) return /"signedIn"\s*:\s*true/.test(out);
        return /logged in|authenticated|signed in/i.test(out);
      } catch { return false; }
    }

    function isSleevGatewayHealthy(bin) {
      const useShell = bin.endsWith(".cmd") || bin.endsWith(".bat");
      try {
        const out = execSync(`"${bin}" gateway status`, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 8000, shell: useShell });
        return /"running"\s*:\s*true/.test(out) && /"healthy"\s*:\s*true/.test(out);
      } catch { return false; }
    }

    // --- HTTP health check ---
    async function isUp() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      try {
        const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: ctl.signal });
        return res.ok;
      } catch { return false; }
      finally { clearTimeout(timer); }
    }

    // --- Gateway lifecycle ---
    async function ensureRunning() {
      try {
        if (await isUp()) return;

        const bin = resolveSleevBinary();
        if (!bin) { log("sleev binary not found"); return; }

        // Check if gateway already running (started externally)
        if (isSleevGatewayHealthy(bin)) { log("gateway already healthy (external)"); return; }

        // Ensure signed in
        if (!isSleevLoggedIn(bin)) {
          log("not signed in — run `sleev auth login` manually, then restart");
          return;
        }

        // Bind and start
        const useShell = bin.endsWith(".cmd") || bin.endsWith(".bat");
        execSync(`"${bin}" gateway bind --host ${HOST} --port ${PORT} --restart`, {
          stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 10000, shell: useShell,
        });
        const child = spawn(bin, ["gateway", "start"], {
          detached: true, stdio: "ignore", windowsHide: true, shell: useShell,
        });
        child.on("error", (e) => log(`spawn error: ${e?.message}`));
        child.on("exit", (code, sig) => log(`gateway exited code=${code} signal=${sig}`));
        child.unref();

        // Wait for health
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (await isUp()) { log(`gateway ready on http://${HOST}:${PORT}`); return; }
        }
        log("gateway did not become healthy within timeout");
      } catch (e) {
        log(`ensureRunning failed: ${e?.message || String(e)}`);
      }
    }

    await ensureRunning();
    ctx.event?.subscribe?.({}).then?.(async (iter) => {
      for await (const ev of iter) {
        if (ev.type === "server.connected") await ensureRunning();
      }
    }).catch(() => {});
  },
};
