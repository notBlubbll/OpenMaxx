// tinyproxy/index.js — OpenCode V2 plugin: inline HTTP proxy for hyper.charm.land.
// Uses native fetch (works fine — earlier failures were header bugs).
// Forwards Bearer auth. Routes through Sleev if gateway is up.

import { createServer, request as httpRequest } from "node:http";

export default {
  id: "tinyproxy",
  async setup(ctx) {
    const UPSTREAM = "https://hyper.charm.land";
    const LISTEN_HOST = "127.0.0.1";
    const PORT = 17300;
    const SLEEV_BASE = "http://127.0.0.1:17321";

    let sleevCache = false;
    let sleevLastCheck = 0;

    function checkSleev() {
      if (Date.now() - sleevLastCheck < 5000) return sleevCache;
      sleevLastCheck = Date.now();
      const req = httpRequest(`${SLEEV_BASE}/health`, { method: "GET", timeout: 1000 }, (res) => {
        sleevCache = res.statusCode >= 200 && res.statusCode < 400;
        res.resume();
      });
      req.on("error", () => { sleevCache = false; });
      req.on("timeout", () => { req.destroy(); sleevCache = false; });
      req.end();
      return sleevCache;
    }

    function collect(req) {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
        req.on("error", reject);
      });
    }

    const server = createServer(async (req, res) => {
      try {
        const reqPath = req.url || "/";

        if (req.method === "GET" && reqPath.split("?")[0] === "/health") {
          checkSleev();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", upstream: `${UPSTREAM}/v1`, sleev: sleevCache }));
          return;
        }

        const raw = await collect(req);
        const useSleev = checkSleev();

        // Clean forwarded headers — strip hop-by-hop
        const headers = { ...req.headers };
        for (const h of ["host", "content-length", "transfer-encoding", "connection", "keep-alive"]) {
          delete headers[h];
        }

        const targetURL = useSleev
          ? `${SLEEV_BASE}${reqPath}`
          : `${UPSTREAM}${reqPath}`;

        if (useSleev) {
          headers["sleeve-harness"] = "opencode";
          headers["sleeve-base-url"] = `${UPSTREAM}${reqPath}`;
        }

        const init = { method: req.method, headers };
        if (raw && raw.length && req.method !== "GET" && req.method !== "HEAD") {
          init.body = raw;
          init.duplex = "half";
        }

        const upstream = await fetch(targetURL, init);

        const outHeaders = {};
        const ct = upstream.headers.get("content-type");
        if (ct) outHeaders["content-type"] = ct;

        res.writeHead(upstream.status, outHeaders);
        if (!upstream.body) { res.end(); return; }
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (err) {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        try { res.end(`Proxy error: ${err?.message || String(err)}`); } catch {}
      }
    });

    server.listen(PORT, LISTEN_HOST, () => {
      console.log(`[tinyproxy] listening on http://${LISTEN_HOST}:${PORT} -> ${UPSTREAM}/v1`);
    });
  },
};
