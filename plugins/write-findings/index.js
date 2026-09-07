// write-findings/index.js — OpenCode V2 plugin: scoped findings writer.
// Least-privilege write: ONLY paths under .opencode-findings are allowed.
//
// Hardened for first-try success (like edit-tool-fix / grep-fix):
// - Accepts alias param names (content/text/markdown, file/filePath/dest...)
// - additionalProperties open + NO required keys, so aliases never die at schema validation
// - Case-insensitive arg keys, surrounding-quote stripping, type coercion
// - Sloppy base64 (whitespace/URL-safe/padding/data-URL tolerant, garbage fallback to raw)
// - Path normalization (slashes, %ENV%, ~, quote stripping) with actionable errors

export default {
  id: "write-findings",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "write_findings",
        description:
          "Write a findings/report markdown file to disk in ONE call. " +
          "Path param: path (aliases: file, filePath, filename, dest, output). MUST contain .opencode-findings. " +
          "Content param: body (aliases: content, text, markdown, data). " +
          "Or bodyBase64 (whitespace/padding tolerant), or bodyFile (temp file path). " +
          "Aliases and case variations are accepted. Returns WRITTEN with path and byte count.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute path under .opencode-findings" },
            file: { type: "string", description: "Alias for path" },
            filePath: { type: "string", description: "Alias for path" },
            filename: { type: "string", description: "Alias for path" },
            dest: { type: "string", description: "Alias for path" },
            output: { type: "string", description: "Alias for path" },
            body: { type: "string", description: "Raw markdown content" },
            content: { type: "string", description: "Alias for body" },
            text: { type: "string", description: "Alias for body" },
            markdown: { type: "string", description: "Alias for body" },
            data: { type: "string", description: "Alias for body (object is JSON-stringified)" },
            bodyBase64: { type: "string", description: "Base64 markdown (tolerant)" },
            base64: { type: "string", description: "Alias for bodyBase64" },
            bodyFile: { type: "string", description: "Temp file holding the markdown" },
            inputFile: { type: "string", description: "Alias for bodyFile" },
          },
          required: [],
          additionalProperties: true,
        },
        output: {
          type: "object",
          properties: {
            output: { type: "string" },
          },
        },
        execute: async (rawArgs) => {
          let args = rawArgs;
          // 1. Agent passed a JSON string instead of an object
          if (typeof args === "string") {
            const t = args.trim();
            if (t.startsWith("{")) {
              try { args = JSON.parse(t); }
              catch { return { output: "ERROR: args string is not valid JSON (first 120 chars): " + t.slice(0, 120) }; }
            } else {
              return { output: "ERROR: expected an object with path + body; got a bare string. Example: { path: 'C:\\proj\\.opencode-findings\\topic.md', body: '# ...' }" };
            }
          }
          args = args && typeof args === "object" ? args : {};

          // 2. Case-insensitive key lookup + aliases
          const low = {};
          for (const k of Object.keys(args)) low[String(k).toLowerCase()] = args[k];
          const pick = (...names) => {
            for (const n of names) {
              const v = low[n];
              if (v !== undefined && v !== null && String(v) !== "") return v;
            }
            return undefined;
          };

          let path = pick("path", "filepath", "file", "filename", "dest", "destination", "output", "outfile", "outpath");
          let b64 = pick("bodybase64", "base64", "body_b64", "contentbase64", "content_base64");
          let body = b64 !== undefined ? undefined : pick("body", "content", "text", "markdown", "md", "report", "findings", "data");
          let bodyFile = pick("bodyfile", "body_file", "inputfile", "input_file", "src", "source", "tmpfile");

          const stripQuotes = (s) => {
            s = String(s).trim();
            if (s.length >= 2) {
              const a = s[0], b = s[s.length - 1];
              if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === "`" && b === "`")) return s.slice(1, -1);
            }
            return s;
          };

          // 3. bodyFile support (with path normalization attempts)
          if (body === undefined && b64 === undefined && bodyFile !== undefined) {
            const { readFile } = await import("node:fs/promises");
            const cands = [String(bodyFile), String(bodyFile).replace(/\//g, "\\")];
            let ok = false;
            for (const c of cands) {
              try { body = await readFile(stripQuotes(c), "utf8"); ok = true; break; }
              catch {}
            }
            if (!ok) return { output: "READ-FAILED: " + bodyFile + " :: file not readable. Write the markdown inline via body instead." };
          }

          // 4. Sloppy base64 (whitespace/URL-safe/padding/data-URL tolerant)
          if (b64 !== undefined) {
            let s = stripQuotes(b64).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
            const dm = s.match(/^data:[^,]*,(.*)$/s);
            if (dm) s = dm[1];
            const m = s.length % 4;
            if (m) s += "=".repeat(4 - m);
            try {
              const dec = Buffer.from(s, "base64").toString("utf8");
              // Garbage input decodes to garbage: fall back to raw text
              body = /[\0\uFFFD]/.test(dec) ? stripQuotes(b64) : dec;
            } catch {
              body = stripQuotes(b64);
            }
          }

          if (body === undefined) {
            return { output: "ERROR: no content. Pass body (raw markdown), bodyBase64, or bodyFile. Got keys: " + Object.keys(args).join(",") };
          }

          // 5. Coerce body types, strip BOM
          if (typeof body !== "string") {
            try { body = typeof body === "object" ? JSON.stringify(body, null, 2) : String(body); }
            catch { return { output: "ERROR: body is not coercible to string." }; }
          }
          body = body.replace(/^\uFEFF/, "");

          // 6. Path normalization
          if (path === undefined) {
            return { output: "ERROR: no path. Pass path (aliases: file, filePath, dest). It MUST contain .opencode-findings, e.g. C:\\proj\\.opencode-findings\\topic.md" };
          }
          path = stripQuotes(path).replace(/\//g, "\\");
          path = path.replace(/%([^%]+)%/g, (_, n) => process.env[n] || "%" + n + "%");
          if (path.startsWith("~")) path = (process.env.USERPROFILE || process.env.HOME || "") + path.slice(1);
          path = path.replace(/\\\\+/g, "\\");

          if (!path.includes(".opencode-findings")) {
            return { output: "ERROR: path must contain .opencode-findings, got: " + path + " :: add the segment, e.g. ...\\.opencode-findings\\<slug>.md" };
          }

          const { mkdir, writeFile } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          try {
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, body, "utf8");
            return { output: "WRITTEN: " + path + " (" + Buffer.byteLength(body, "utf8") + " bytes)" };
          } catch (e) {
            return { output: "WRITE-FAILED: " + path + " :: " + (e.message || String(e)) };
          }
        },
      });
    });
  },
};
