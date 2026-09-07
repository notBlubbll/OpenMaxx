// sleev-gateway plugin - OpenCode V2. Manages the Sleev gateway lifecycle.
//
// Lessons (2026-09-07):
// - The `sleev` CLI itself is broken in this env (all gateway/auth commands
//   fail with "expected value at line 1 column 1"), so NEVER gate on CLI
//   output. Signed-in state comes from config.json (auth.signedIn).
// - Start the gateway BINARY directly with --host/--port/--config/--db-path.
// - Stale sleeve-gateway.exe zombies (from dead server runs) hold no port but
//   confuse checks: liveness = TCP response on PORT, nothing else.

export default {
  id: "sleev-gateway",
  async setup(ctx) {
    const HOST = "127.0.0.1";
    const PORT = 17321;

    const { spawn } = await import("node:child_process");
    const { readFileSync, appendFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    const ERR_LOG = join(
      process.env.USERPROFILE || process.env.TEMP || ".",
      ".config", "opencode", "plugins", ".sleev-gateway-errors.log"
    );

    function log(msg) {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      try { console.error(line.trim()); } catch {}
      try { appendFileSync(ERR_LOG, line); } catch {}
    }

    function baseDir(kind) {
      // APPDATA/LOCALAPPDATA are sometimes unset in service contexts - fall back via USERPROFILE.
      const app = process.env.APPDATA;
      const local = process.env.LOCALAPPDATA;
      const home = process.env.USERPROFILE || "";
      if (kind === "roam") return app || (home ? join(home, "AppData", "Roaming") : "");
      return local || (home ? join(home, "AppData", "Local") : "");
    }

    function sleevFile(...parts) {
      return join(baseDir("roam"), "sleev", ...parts);
    }

    function readJson(p) {
      return JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
    }

    function isSignedIn() {
      try {
        const cfg = readJson(sleevFile("config.json"));
        return cfg && cfg.auth && cfg.auth.signedIn = REDACTED true;
      } catch (e) {
        log(`signin-check failed: base=${baseDir("roam")} err=${e?.message}`);
        return false;
      }
    }

    function gatewayBin() {
      try {
        const cfg = readJson(sleevFile("config.json"));
        const p = cfg && cfg.gateway && cfg.gateway.binPath;
        if (p && existsSync(p)) return p;
      } catch {}
      return null;
    }

    async function isUp() {
      const { request } = await import("node:http");
      return new Promise((resolve) => {
        const req = request(`http://${HOST}:${PORT}/`, { method: "GET", timeout: 4000 }, (res) => {
          resolve(true); // any HTTP response = alive (it 400s without harness headers)
          res.resume();
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
    }

    let starting = false; // singleflight: concurrent ensureRunning calls must not spawn twice (EADDRINUSE -> exit 255)

    async function ensureRunning() {
      try {
        if (await isUp()) return;
        if (starting) return;
        await new Promise((r) => setTimeout(r, 2000));
        if (await isUp()) return; // re-check: gateway may have just come up
        starting = true;
        if (!isSignedIn()) {
          log("not signed in (config.json auth.signedIn != true) - sign in, then restart");
          return;
        }

        const bin = gatewayBin();
        if (!bin) { log("gateway binary not found (config.json gateway.binPath)"); return; }

        const child = spawn(bin, [
          "--host", HOST,
          "--port", String(PORT),
          "--config", sleevFile("gateway.json"),
          "--db-path", join(baseDir("local"), "sleev", "sleeve.sqlite"),
        ], { detached: true, stdio: "ignore", windowsHide: true });

        child.on("error", (e) => log(`spawn error: ${e?.message}`));
        child.on("exit", (code, sig) => log(`gateway exited code=${code} signal=${sig}`));
        child.unref();

        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (await isUp()) { log(`gateway ready on http://${HOST}:${PORT}`); return; }
        }
        log("gateway did not become healthy within timeout");
      } catch (e) {
        log(`ensureRunning failed: ${e?.message || String(e)}`);
      } finally {
        starting = false;
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
