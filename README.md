# opencode multi-model subagent setup

Repo: [notBlubbll/OpenMaxx](https://github.com/notBlubbll/OpenMaxx)

Routes opencode work across providers by cost and role: GLM-5.3-Flash (hypercharm, 1M context)
for primary orchestration and detective; **airouter** (api.airouter.ch) for the executers — DeepSeek-V4-Flash for research workers, Qwen-3.8-27B for code edits; Qwen3 Next 80B-A3B Instruct (hypercharm) for the implementation coordinator with LOW reasoning for rapid dispatch; GLM-5.3 (hypercharm flagship) for compaction; hypercharm/gpt-oss-120b for session
titles. Findings are saved directly via the deterministic write_findings custom tool (no subagent,
no LLM). agnes-research and agnes-execute each point at the same apihub.agnes-ai.com endpoint with
different API keys.

# tree example

Detective:

<img width="290" height="108" alt="image" src="https://github.com/user-attachments/assets/6422c671-440c-4a8a-88b0-3a79b0efcac3" />

Researching:

<img width="377" height="160" alt="image" src="https://github.com/user-attachments/assets/d59e9716-a441-4316-9480-0547c4f2ae88" />

Editing:

<img width="298" height="107" alt="image" src="https://github.com/user-attachments/assets/4485f9ec-571a-4c5f-821a-149fa089a3eb" />


## Get API keys

**AI Router (executers: research + edit)** — get your key from your AI Router account and set
it in `opencode.json` under `provider.airouter.options.apiKey` (baseURL
`https://api.airouter.ch/v1`). Models: `Qwen3.8` (Qwen-3.8-27B) and `DeepSeek-V4-Flash`
(DeepSeek-V4-Flash-0731).

**HyperCharm** — set your key in `opencode.json` under `provider.hypercharm.options.apiKey`
(baseURL `https://hyper.charm.land/v1`). Models: `glm-5.3-flash` (primary + detective), `qwen3-next-80b-a3b-instruct` (coordinator), `glm-5.3` (compaction, flagship), and `gpt-oss-120b` (titles — HyperCharm's low tier, trivially cheap).

## OpenAI-Compatible SDK (stability)

GLM-5.3-Flash (primary + detective) routes via the `hypercharm` provider; DeepSeek-V4-Flash (research-worker + research) and Qwen3.8 (edit) route via the `airouter` provider (api.airouter.ch); qwen3-next-80b-a3b-instruct (coordinator), glm-5.3 (compaction) and gpt-oss-120b (titles) route via the `hypercharm` provider; agnes-research/agnes-2.5-flash (explore) points at the apihub.agnes-ai.com endpoint.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The `airouter` provider serves the executers (research-worker + research + edit). The `hypercharm` provider serves the primary, detective, coordinator, small_model and titles.


## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
    │   ├── research.md       # deep search -> airouter/DeepSeek-V4-Flash#research (HIGH reasoning, saves via write_findings)
    │   ├── research-worker.md # parallel lookups -> airouter/DeepSeek-V4-Flash#research-worker (LOW reasoning)
    │   ├── detective.md      # research orchestrator -> hypercharm/glm-5.3-flash (HIGH reasoning, spawns research-worker)
│   ├── edit.md             # code edits + shell/builds -> airouter/Qwen3.8#edit (MEDIUM reasoning, edit tool)
│   ├── coordinator.md      # implementation orchestrator -> hypercharm/qwen3-next-80b-a3b-instruct (LOW reasoning); plans + delegates, cannot edit/shell itself
│   └── title.md            # session titles -> hypercharm/gpt-oss-120b  [overrides small_model]
├── tools/            # edit-ops.js (batch file edits), write.js (schema-safe write override)
├── plugins/          # write-findings.js, mind-automation.js, grep-fix.js, edit-tool-fix.js (V2 native, no translation shims)
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode2** (OpenCode V2, `subagent` tool with `agent`/`description`/`prompt`). Restart opencode after any change.

## Architecture

```
Primary (hypercharm/glm-5.3-flash, variant:high)      receives request, routes ALL research to detective
  ├── detective (hypercharm/glm-5.3-flash, high thinking)   research orchestrator (PREFERRED for lookups) [hypercharm]
  │   └── research-worker (airouter/DeepSeek-V4-Flash, variant:research-worker)   parallel research workers (LOW reasoning) [airouter]
  └── coordinator (hypercharm/qwen3-next-80b-a3b-instruct, variant:low)   implementation orchestrator: plans + delegates, cannot edit/shell itself [hypercharm]
      ├── edit (airouter/Qwen3.8)     applies edits via edit-ops batch tool + builds
      └── research (airouter/DeepSeek-V4-Flash, variant:research) ONLY as fallback for gaps in detective findings
```

The primary NEVER spawns `edit` directly — ALL edits go through `coordinator`.
The primary spawns `detective` for ALL research needs. `research-worker` is the detective's fan-out for parallel lookups. `research` is the coordinator's fallback for gaps in detective findings — never a primary tool.

## Why this routing

The split is by cost, with one principle: the free tier handles all the
search work, paid models only do reasoning and orchestration.


- **GLM-5.3-Flash (paid, hypercharm) for primary + detective**: receives requests and
  delegates goals — large context for orchestration and research planning.

- **Qwen3 Next 80B-A3B Instruct (paid, hypercharm) for the coordinator**: plans and sequences
  edits, fans out edit spawns — LOW reasoning for rapid dispatch without extended thinking phases. Its own edit/bash are permission-denied.

- **DeepSeek-V4-Flash (airouter) for the research orchestrator (detective)**:
  coordinates complex multi-file research and fans out `research-worker` agents — high-stakes,
  a missed research path degrades everything after it.

- **airouter for the executers**: DeepSeek-V4-Flash (`research-worker`) does parallel fast lookups (LOW reasoning for speed), while DeepSeek-V4-Flash (`research`) does deep fallback searches (HIGH reasoning). Qwen-3.8-27B applies code edits (MEDIUM reasoning) via the edit-ops batch tool.

- **GLM-5.3 (paid flagship, hypercharm) for compaction (small_model)**: small_model handles
  compaction summaries. A lossy summary degrades everything after it, so it gets the flagship.
  Explicitly pinned so small_model never inherits a different host session model.

## Design principle: permission-enforced rules

Rules stated in `AGENTS.md` are text — they compete for attention with growing
history and can silently stop firing. The strongest rules in this setup are NOT
text: they are **permission-denied** in `opencode.json`, so they cannot decay:

- **Primary cannot edit/search/bash**: permission denies `edit`, `glob`,
  `grep`, `bash` — the primary physically cannot do implementation work, only
  delegate.
- **Primary cannot spawn `edit`**: `task` allows only `coordinator`, `research`, and `detective` — `edit` is absent, so the primary cannot bypass the coordinator.
- **`coordinator` cannot edit/bash/edit-ops**: all denied in its own permission block — it can
  only plan and delegate to `edit` (implementation) and `research` (fallback lookups).
- **`edit` owns edit-ops**: only the edit agent holds `edit-ops: allow` — all file mutations
  flow through edit subagent spawns.
- **`research` cannot bash**: denied — read-only search, no side effects.

Text-mediated rules that CAN decay over long sessions:
- Pre-explore discipline (research before delegating)
- Parallel fan-out cap and self-check
- Title tagging
- Findings-to-disk (mitigated by making it a subagent rule, not a primary rule)

These text-mediated rules are the ones to watch in long sessions. If compliance
drops, the fix is a session restart (fresh context, rules at full strength) or
converting the rule to a permission-denied enforcement if possible.

## Model routing

| Role | Model ID | Variant | Reasoning | Output | Cost |
|---|---|---|---|---|---|
| main (orchestration) | hypercharm/glm-5.3-flash | high | high effort | 131,072 | paid credits |
| detective (research orchestrator) | hypercharm/glm-5.3-flash | high | high effort | 131,072 | paid credits |
| research-worker (parallel lookups) | airouter/DeepSeek-V4-Flash | research-worker | **low** | 32,768 | airouter flat |
| coordinator (implementation orchestrator) | hypercharm/qwen3-next-80b-a3b-instruct | low | **low** | 131,072 | paid credits |
| edit (ALL code edits + shell/builds) | airouter/Qwen3.8 | edit | **medium** | 65,536 | airouter flat |
| research (fallback for coordinator) | airouter/DeepSeek-V4-Flash | research | **high** | 32,768 | airouter flat |
| findings saving | write_findings custom tool | — | — | — | zero (local, deterministic) |
| session titles | hypercharm/gpt-oss-120b | low | 2,048 | 65,536 | low tier (cheap) |
| small_model (compaction summaries) | hypercharm/glm-5.3 | high | 32,768 | 128,000 | paid credits |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.3-Flash (primary + detective, hypercharm)**: 1M context / 131K output — large context for orchestration and research planning. Paid tier. Variants: high (as configured).
- **Qwen3 Next 80B-A3B Instruct (coordinator, hypercharm)**: 1M context / 131K output — **LOW reasoning** for rapid task dispatching, clean schema adherence, token efficiency. Avoids extended thinking phases on simple orchestration tasks.
- **DeepSeek-V4-Flash (airouter)**: 920K context / 32K output
  - **research-worker variant (LOW)**: fast parallel lookups spawned by detective — minimal thinking, maximum throughput
  - **research variant (HIGH)**: fallback for coordinator when detective findings are insufficient
- **Qwen-3.8-27B (edit, airouter)**: 262K context / 65K output — **MEDIUM reasoning** for code edits. Avoids "overthinking" loops (Qwen's default is xhigh which triggers massive thinking blocks). Medium provides enough reasoning for clean syntax and context bounds without stalling generation. Preserves precision over low which can occasionally lead to syntax slips on complex multi-file refactors.
- **GLM-5.3 (small_model)**: 128K output — compaction summaries on the flagship model. Explicitly pinned so it never inherits the host session model.

## write_findings tool

Findings/reports are saved with the `write_findings` custom tool (`plugins/write-findings.js`):
args `path` (absolute, must contain .opencode-findings) + `body` (verbatim markdown). It creates the
directory, writes the file, and returns `WRITTEN: <path> (<n> bytes)`. No subagent, no LLM call.

## edit-ops tool

Code edits go through the `edit-ops` custom tool (`tools/edit-ops.js`): one call executes a batch of
deterministic ops (read, write, replace, regex_replace, append, prepend, insert_at_line, delete_lines,
move, copy, delete_file, mkdir, list; aliases rd/w/r/rr/a/pre/il/dl/mv/cp/rm/md/ls). Ops run in order;
parallel tool calls serialize mutations per file; every mutation is backed up to .opencode-backups/.
No LLM is involved in applying the edits — the calling model just emits the structured ops array.

## How variants work

The Agnes API knows one model ID: `agnes-2.5-flash` (explore); airouter knows `Qwen3.8`
(edit) and `DeepSeek-V4-Flash` (research). We register Agnes separately under two providers —
`agnes-research` (read-only work, research API key) and `agnes-execute` (write work, execute API
key) — both pointing at the same `https://apihub.agnes-ai.com/v1` endpoint. Each provider defines
its own named variants via `reasoningEffort`. The agent `.md` files select which variant to use
via `variant: <name>` in their YAML frontmatter:

```yaml
model: agnes-research/agnes-2.5-flash
variant: explore    # low thinking (explore)

model: airouter/DeepSeek-V4-Flash
variant: research   # high effort (deep lookups)

model: airouter/Qwen3.8
variant: edit       # medium effort (balanced precision/speed for edits)
```

All variants hit the same API endpoint with the same model name — only the
thinking budget sent in the request differs. No fake model IDs.

**Line ending fix:** The `edit-ops.js` tool now normalizes line endings (CRLF ↔ LF) during `replace` operations, so `oldString` matching works regardless of whether the source file uses Windows (CRLF) or Unix (LF) line endings. The `edit-tool-fix` plugin also normalizes paths and line endings before tool execution for additional safety.

## What small_model does (and doesn't)

`small_model` handles opencode's internal background tasks - most importantly
**compaction summaries** (when a long session is summarized to free context,
that summary becomes the session's memory, so quality matters) and other
utility generations.

It does **NOT** handle:
- **session titles** - `agents/title.md` overrides the internal title agent
  and pins those to HyperCharm gpt-oss-120b (cheap); small_model is bypassed for titles
- **exploration** - research is a full agent with its own pinned model (airouter/DeepSeek-V4-Flash)
- **edits / shell / orchestration** - those run on the edit, main and
  coordinator models

Rationale: compaction is rare but high-stakes (a lossy summary degrades everything after it), so it gets GLM-5.3 — the flagship, with 512K context headroom and explicitly pinned so it never inherits the host session model. Titles are frequent but trivial, so they go to gpt-oss-120b — cheap on HyperCharm. Findings saves are the deterministic write_findings tool (zero cost, instant).

## How nesting + parallelization works

1. Primary receives the request, front-loads ALL research through `detective`
   (which fans out `research-worker` agents), then delegates the GOAL plus findings to
   `coordinator`. The primary NEVER spawns `edit` directly — ALL edits
   go through `coordinator`. The primary NEVER does research itself and never
   spawns `research` — `research` is the coordinator's fallback, not a primary tool.
2. `coordinator` (hypercharm/qwen3-next-80b-a3b-instruct, **LOW reasoning**) plans the implementation: breaks the goal into
   precise edit steps using the detective findings in its goal, and sequences the work. Its own
   edit/bash tools are permission-denied, so it can ONLY delegate. LOW reasoning ensures rapid dispatch without extended thinking phases.
3. `coordinator` delegates the changes: it spawns `edit` subagents (airouter/Qwen3.8#edit, **MEDIUM reasoning**) which apply the
     edits via their edit-ops batch tool calls — coordinator itself has edit-ops DENIED and never
     touches files. Edit spawns are UNLIMITED — for INDEPENDENT edits (different files / non-overlapping
     regions) it issues as many `edit` spawns as the plan needs in ONE message; coordinator does the
     hard planning (goal decomposition, file resolution, exact anchors, edit ordering), the edit
     subagents do the mechanical application. Same-file/overlapping
     edits stay in a single spawn to avoid write conflicts.
  4. `coordinator` spawns `research` subagents (airouter/DeepSeek-V4-Flash, variant:research, HIGH reasoning) ONLY as a
      fallback when the detective findings are insufficient (missing paths/context) — it must state
      exactly what info is missing in the spawn prompt. Capped at 3 concurrent spawns — combine searches
      into at most 3 multi-topic tasks when possible, else waves of 3.
5. After the edit spawns land, one final `edit` subagent runs the build/verify command (edit agents have bash; coordinator does not).
6. `subagent_depth: 4` allows deeper nesting; research has no task
   permission, so recursion hard-stops at depth 2.
  7. Pre-explore discipline: the primary MUST front-load exploration via a `detective`
     spawn (which fans out `research-worker` agents in parallel) before delegating to `coordinator`,
     so the goal already contains exact paths and context. Coordinator should rarely
     need its research fallback.

## Snippet proof (verification, not enforcement)

Findings files from `research` must include a verbatim 1-3 line
quote from each cited `file:line` reference. This proves the subagent actually
read the file rather than confabulating a plausible-sounding reference. The
caller can grep the quoted string to verify. This is the cheapest verification
that survives compaction — it lives in the findings file on disk, not in
history that gets summarised.

The one-line summary from subagents ends with "READ BEFORE ACTING" as a
per-turn reminder that survives in history. The caller (primary or coordinator)
is instructed to read the findings file via the Read tool before acting on
any edit decision. This is text-mediated — it can decay in long sessions —
but the reminder is fresh on every turn because it's in the response, not
just in the injected instructions.

## Subsession title tags

Subagent sessions are tagged in their title for easy identification:
`[✏️Edit]`, `[🤖Coordinate]`, `[🔎Research]`, `[🕵🏼‍♂️Detective]`, `[💭Summarizer]`. Primary sessions are not tagged.

## Data retention note

Code editing and deep research run on **AI Router** (api.airouter.ch: DeepSeek-V4-Flash for research-worker/research, Qwen-3.8-27B for edits) — review AI Router's data-retention terms. Explore lookups run
on **Agnes 2.5 Flash** (free tier via agnes-research) — review Agnes AI's terms at
https://agnes-ai.com/ to confirm whether API inputs are stored or used for model
training. The remaining models (GLM-5.3-Flash primary + detective + qwen3-next-80b-a3b-instruct coordinator + glm-5.3 compaction + gpt-oss-120b titles via HyperCharm; DeepSeek-V4-Flash research-worker + research + Qwen-3.8-27B edit via AI Router) — review HyperCharm's and AI Router's terms separately.

## Mind MCP server (persistent memory, optional)

This setup optionally includes the [mind](https://github.com/) MCP server for
persistent cross-session memory. It is **disabled by default** (`enabled: false`)
because it requires a separate installation.

To enable it:
1. Install the mind binary on your machine.
2. Update the path in `opencode.json` under `mcp.mind.command` to point to
    your mind installation.
3. Change `mcp.mind.enabled` from `false` to `true`.
4. Restart opencode.
5. Add `"~/.config/opencode/instructions/mind-memory-protocol.md"` to the `instructions` array in `opencode.json` so 
   agents learn how to use mind tools.

When enabled, opencode auto-launches the mind server on startup. The
`mind-memory-protocol.md` instruction (in `instructions/`) teaches agents how
to use checkpoints, durable memories, and living references so context
survives compaction and session resets. The instruction is harmless even
without the MCP server — it only activates when mind tools are available.


## OpenCode V2 notes (Sept 2026)

V2 installs as `opencode2` (`npm install -g @opencode-ai/cli@beta`) and runs **side-by-side** with V1 —
it never replaces the V1 `opencode` binary. Both share `~/.config/opencode/opencode.json`.

- **V1 rejects V2-format configs.** If your config uses V2 shapes (`agents.*.permissions`
  arrays, `provider.npm`, etc.), the V1 `opencode` binary fails every command with
  "V2 permissions are not supported by OpenCode V1. Use V1 permission rules or run opencode2."
- This machine maps `opencode` → `opencode2` (V1 kept as `opencode1` via renamed npm shims in
  `%APPDATA%\npm`). Re-running `npm i -g opencode-ai` regenerates the V1 shims and undoes that.
- Plugin gotchas fixed in this repo (see `plugins/` and `tools/`):
  - **grep-fix.js**: the grep tool's `include` parameter is a **single glob string** — the server
    passes it as one `--glob=` flag (no array, no comma lists; `MAX_RECORD_BYTES` = 64KB per match
    line). Merging exclusion globs into an array breaks **every** grep call with
    `include: Expected string`. The plugin now only coerces invalid shapes (arrays) to the first
    positive glob and keeps the 64KB-error → actionable-text conversion.
  - **edit-tool-fix.js**: load as a plain `.js` entrypoint with no SDK import. The npm
    `@opencode-ai/plugin` package (1.14.x/1.18.x line) is the **V1 SDK** and exports no `Plugin`
    symbol — a directory plugin doing `import { Plugin } from "@opencode-ai/plugin"` fails to load
    ("Export named 'Plugin' not found"). Uses the edit tool's `path` field (not `filePath`).
    Also normalizes line endings (CRLF→LF) in oldString/newString for better matching.
  - **edit-ops.js**: The `replace` op now normalizes line endings internally (both source file
    and oldString are converted to LF for matching, then original line endings are restored in
    output). This fixes "oldString not found" errors when the plugin normalizes CRLF→LF but
    the file on disk still has CRLF.

## Current routing summary

- Main model: hypercharm/glm-5.3-flash (variant high, reasoning effort high)
- Detective (research orchestrator): hypercharm/glm-5.3-flash (variant high, reasoning effort high)
- Research-worker (parallel lookups): airouter/DeepSeek-V4-Flash#research-worker (variant research-worker, reasoning effort **low**)
- Coordinator (implementation orchestrator): hypercharm/qwen3-next-80b-a3b-instruct (variant low, reasoning effort **low**)
- Research (fallback): airouter/DeepSeek-V4-Flash#research (variant research, reasoning effort high)
- Edit (code edits + shell/builds): airouter/Qwen3.8#edit (variant edit, reasoning effort **medium**)
- small_model (compaction): hypercharm/glm-5.3
- Titles: hypercharm/gpt-oss-120b; Explore: agnes-research/agnes-2.5-flash
- Findings saving: write_findings custom tool (deterministic, replaced the summarizer subagent)
- Batch file edits: edit-ops custom tool (replaced the edit subagent for multi-file work)

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=coordinator'
# expect: providerID=hypercharm modelID=qwen3-next-80b-a3b-instruct

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=edit'
# expect: providerID=airouter modelID=Qwen3.8

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=research-worker'
# expect: providerID=airouter modelID=DeepSeek-V4-Flash (LOW reasoning)

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=research'
# expect: providerID=airouter modelID=DeepSeek-V4-Flash (HIGH reasoning, fallback only)
```

(End of file - total 349 lines)