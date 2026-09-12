// sse-toolcall-fix.js — SSE stream rewriter for empty-string tool-call deltas.
// Shared by tinyproxy (17300) and agnes-proxy (8090).
//
// GLM-5.3 models send "id": "" and "function": {"name": ""} on streaming
// tool-call deltas. OpenCode's ToolStream.appendOrStart uses truthiness
// (if (!id || !name)) which rejects empty strings, aborting the entire stream.
// This module intercepts SSE data: lines and replaces empty-string id/name
// fields with valid generated values (call_XXXXXXXX for id, snake_case derived
// name from args for name) so OpenCode's truthiness guard passes directly.

/**
 * Stateful SSE line splitter + tool-call delta fixer.
 * Call processChunk() with each reader.read() value; call flush() on stream end.
 */
export class SseToolCallFix {
  constructor() {
    this._remainder = Buffer.alloc(0);
    // Stream-level finish tracking (upstream sometimes omits finish_reason
    // entirely — e.g. thinking-variant streams that end after reasoning
    // chunks with a usage chunk + [DONE] and no finish_reason anywhere).
    this._sawData = false;
    this._sawFinish = false;
    this._sawToolCalls = false;
    // Per-index accumulated tool-call identity. Upstream continuation
    // deltas legitimately omit id/name (OpenCode falls back to accumulated
    // state via ??) — but when the FIRST delta for an index omits them
    // there is nothing to fall back to and the stream dies. We backfill
    // from this map (mirroring OpenCode's accumulation), generating values
    // only when nothing was ever seen for the index.
    this._toolCallState = new Map();
  }

  /** Inspect a parsed SSE data object for finish/tool-call signals. */
  _inspect(obj) {
    const choices = obj?.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      if (choice?.finish_reason != null) this._sawFinish = true;
      if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
        this._sawToolCalls = true;
      }
    }
  }

  /**
   * True when this stream carried SSE data but no finish_reason — the
   * caller should inject synthFinishChunk() before [DONE]/EOF so the
   * client's parser sees a complete stream.
   */
  needsFinishSynth() {
    return this._sawData && !this._sawFinish;
  }

  /**
   * Build a minimal final chunk carrying the missing finish_reason:
   * "tool_calls" if tool-call deltas were seen, else "stop".
   */
  synthFinishChunk() {
    const finish = this._sawToolCalls ? "tool_calls" : "stop";
    const obj = {
      id: "chatcmpl-proxy-synth",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "proxy-synth",
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    };
    return Buffer.from(`data: ${JSON.stringify(obj)}\n`, "utf8");
  }

  /**
   * Feed a raw byte chunk from the upstream response stream.
   * Returns processed lines as Buffers ready for res.write().
   * Lines that need fixing are re-serialized; all others pass through verbatim.
   */
  processChunk(chunk) {
    // Fetch ReadableStream readers yield Uint8Array, not Buffer.
    // Uint8Array.toString("utf8") ignores the encoding and returns
    // comma-separated decimals, so normalize to Buffer first.
    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = this._remainder.length > 0
      ? Buffer.concat([this._remainder, chunkBuf])
      : chunkBuf;

    // Find last newline — everything before it is complete lines, after is remainder
    const lastNl = combined.lastIndexOf(0x0A); // '\n'
    const lineBytes = lastNl >= 0 ? combined.subarray(0, lastNl) : Buffer.alloc(0);
    this._remainder = lastNl >= 0 ? combined.subarray(lastNl + 1) : combined;

    const out = [];
    // Split complete lines on newline
    const text = lineBytes.toString("utf8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.length === 0) continue; // skip empty splits from trailing \n
      if (line.startsWith("data: ")) {
        const payload = line.slice(6); // strip "data: "
        if (payload === "[DONE]") {
          out.push(Buffer.from(line + "\n", "utf8"));
          continue;
        }
        try {
          const obj = JSON.parse(payload);
          this._sawData = true;
          this._inspect(obj);
          if (fixToolCallDeltas(obj, this._toolCallState)) {
            const fixed = `data: ${JSON.stringify(obj)}\n`;
            out.push(Buffer.from(fixed, "utf8"));
            continue;
          }
        } catch { /* not JSON — pass through */ }
      }
      // Non-data lines (event:, id:, blank) or unfixable data: lines — pass through
      out.push(Buffer.from(line + "\n", "utf8"));
    }
    return { lines: out };
  }

  /**
   * Flush any remaining incomplete bytes (call when the upstream stream ends).
   * Returns a single Buffer (may be empty if nothing remains).
   */
  flush() {
    const rem = this._remainder;
    this._remainder = Buffer.alloc(0);
    // Inspect a trailing unterminated data line for finish signals
    // (bytes are still returned raw — this only flips tracking flags).
    if (rem.length > 0) {
      const text = rem.toString("utf8");
      if (text.startsWith("data: ")) {
        try {
          const payload = text.slice(6).trim();
          if (payload && payload !== "[DONE]") {
            this._sawData = true;
            this._inspect(JSON.parse(payload));
          }
        } catch { /* ignore */ }
      }
    }
    return rem;
  }
}

/**
 * Fix tool_call deltas so every entry carries a non-empty id and
 * function.name. Handles empty strings, nulls, missing keys, missing /
 * null function objects, and null entries. Per-index state backfills
 * continuation deltas exactly like OpenCode's own ?? accumulation — and
 * covers the first-delta case where OpenCode has nothing to fall back to.
 * Returns true if any field was fixed (caller should re-serialize).
 */
function fixToolCallDeltas(obj, state) {
  const choices = obj?.choices;
  if (!Array.isArray(choices)) return false;

  let fixed = false;
  for (const choice of choices) {
    const toolCalls = choice?.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;

    for (let i = 0; i < toolCalls.length; i++) {
      let tc = toolCalls[i];
      if (tc === null || typeof tc !== "object") {
        tc = { index: i, function: { arguments: "" } };
        toolCalls[i] = tc;
        fixed = true;
      }
      const key = tc.index ?? i;
      let st = state.get(key);
      if (!st) { st = {}; state.set(key, st); }
      // id: record real ones, backfill the rest from accumulated state
      if (tc.id == null || tc.id === "") {
        tc.id = st.id || generateCallId(tc);
        fixed = true;
      } else {
        st.id = tc.id;
      }
      // function object may be missing/null entirely
      if (tc.function === null || typeof tc.function !== "object") {
        tc.function = { arguments: "" };
        fixed = true;
      }
      const nm = tc.function.name;
      if (nm == null || nm === "") {
        tc.function.name = st.name || deriveName(tc);
        fixed = true;
      } else {
        st.name = nm;
      }
    }
  }
  return fixed;
}

/** Generate a valid OpenAI-style call id: "call_" + [a-z0-9]{24} */
function generateCallId(tc) {
  // Use a counter + random mix for uniqueness across parallel tool calls
  const rand = Math.random().toString(36).slice(2, 14);
  const ts = Date.now().toString(36);
  const raw = (rand + ts).slice(0, 24);
  // Pad if short
  const padded = raw.length >= 24 ? raw : raw + "0".repeat(24 - raw.length);
  return "call_" + padded;
}

/**
 * Derive a valid function name from the tool call's argument content.
 * OpenAI names are [a-zA-Z0-9_]{1,64}.
 * Falls back to "tool_call" if no derivable content exists.
 */
function deriveName(tc) {
  const args = tc.function?.arguments;
  if (args && typeof args === "string" && args.length > 0) {
    // Try to extract a meaningful name from the arguments
    const derived = extractName(args);
    if (derived) return derived;
  }
  // Fallback: use index if available, otherwise generic
  return tc.index != null ? `tool_call_${tc.index}` : "tool_call";
}

/**
 * Extract a valid function name from argument text.
 * Strategy:
 *   1. If args parse as JSON, look for "name"/"command"/"action" string fields
 *   2. If args is text-like, take the first meaningful word sequence
 *   3. Normalize to [a-zA-Z0-9_], truncate to 64 chars
 */
function extractName(argsStr) {
  let raw = null;

  // Try JSON parse — look for name-like string fields
  try {
    const obj = JSON.parse(argsStr);
    if (typeof obj === "object" && obj !== null) {
      // Priority: name > command > action > agent > description > first string value
      for (const key of ["name", "command", "action", "agent", "description", "prompt", "query"]) {
        if (typeof obj[key] === "string" && obj[key].length > 0) {
          raw = obj[key];
          break;
        }
      }
      // Last resort: first string value in the object
      if (!raw) {
        for (const v of Object.values(obj)) {
          if (typeof v === "string" && v.length > 0) { raw = v; break; }
        }
      }
    }
  } catch {
    // Not JSON — treat as raw text
    raw = argsStr;
  }

  if (!raw) return null;

  // Take first 8 words max (enough to be descriptive, short enough for a name)
  const words = raw.trim().split(/\s+/).slice(0, 8);

  // Convert to snake_case: lowercase, keep only [a-z0-9], join with _
  const name = words
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 0)
    .join("_");

  // Truncate to 64 chars, strip trailing underscores
  const clean = name.slice(0, 64).replace(/_+$/, "");
  return clean.length > 0 ? clean : null;
}
