# opencode multi-model subagent setup

Routes opencode work across providers by cost and role: GLM-5.3-Flash (hypercharm, 1M context)
for primary orchestration and detective; **agnes-research** (apihub.agnes-ai.com) for research workers and explore;
**agnes-execute** (apihub.agnes-ai.com) for code edits — Agnes 2.5 Flash for both, different API keys,
different variants (HIGH reasoning for research, LOW for edits); Qwen3 Next 80B-A3B Instruct (hypercharm) for the
implementation coordinator with LOW reasoning for rapid dispatch; GLM-5.3 (hypercharm flagship) for compaction;
hypercharm/gpt-oss-120b for session titles. Findings are saved directly via the deterministic write_findings
custom tool (no subagent, no LLM). agnes-research and agnes-execute each point at the same
apihub.agnes-ai.com endpoint with different API keys.

# tree example

Detective:

<img width="290" height="108" alt="image" src="https://github.com/user-attachments/assets/6422c671-440c-4a8a-88b0-3a79b0efcac3" />

Researching:

<img width="377" height="160" alt="image" src="https://github.com/user-attachments/assets/213e28da-c8ea-4a07-bd7e-42adc7d8fcd8" />

Editing:

<img width="298" height="107" alt="image" src="https://github.com/user-attachments/assets/4485f9ec-571a-4c5f-821a-149fa089a3eb" />


## Get API keys

**Agnes AI (research + edit + explore)** — get your key from your Agnes AI account and set
it in `opencode.json` under `provider.agnes-research.settings.apiKey` and
`provider.agnes-execute.settings.apiKey` (both point at `https://apihub.agnes-ai.com/v1`).
Model: `agnes-2.5-flash` — variants control reasoning effort per agent.

**HyperCharm** — set your key in `opencode.json` under `provider.hypercharm.settings.apiKey`
(baseURL `https://hyper.charm.land/v1`). Models: `glm-5.3-flash` (primary + detective), `qwen3-next-80b-a3b-instruct` (coordinator), `glm-5.3` (compaction, flagship), and `gpt-oss-120b` (titles — HyperCharm's low tier, trivially cheap).

## OpenAI-Compatible SDK (stability)

GLM-5.3-Flash (primary + detective) routes via the `hypercharm` provider; Agnes 2.5 Flash
(research + research-worker + explore) routes via the `agnes-research` provider;
Agnes 2.5 Flash (edit) routes via the `agnes-execute` provider; qwen3-next-80b-a3b-instruct
(coordinator), glm-5.3 (compaction) and gpt-oss-120b (titles) route via the `hypercharm` provider.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The `agnes-research` provider serves read-only work (research-worker, research, explore).
The `agnes-execute` provider serves write work (edit). The `hypercharm` provider serves
the primary, detective, coordinator, small_model and titles.


## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── research.md       # deep search -> agnes-research/agnes-2.5-flash#research (HIGH reasoning, saves via write_findings)
│   ├── research-worker.md # parallel lookups -> agnes-research/agnes-2.5-flash#research-worker (LOW reasoning)
│   ├── detective.md      # research orchestrator -> hypercharm/glm-5.3-flash (HIGH reasoning, spawns research-worker)
│   ├── edit.md           # code edits + shell/builds -> agnes-execute/agnes-2.5-flash#edit (LOW reasoning, fast, edit tool)
│   ├── coordinator.md    # implementation orchestrator -> hypercharm/qwen3-next-80b-a3b-instruct (LOW reasoning); plans + delegates, cannot edit/shell itself
│   ├── explore.md        # nested lookups inside edit -> agnes-research/agnes-2.5-flash#explore (LOW reasoning)
│   └── title.md          # session titles -> hypercharm/gpt-oss-120b  [overrides small_model]
├── tools/            # edit-ops.js (batch file edits), write.js (schema-safe write override)
├── plugins/          # write-findings/, edit-tool-fix/, grep-fix/, mind-automation/, task-args-fixer/, rg-fix/ (V2 native)
│   ├── write-findings/index.js
│   ├── edit-tool-fix/index.js
│   ├── grep-fix/index.js
│   ├── mind-automation/index.js
│   ├── task-args-fixer/index.js
│   ├── rg-fix/index.js
│   ├── k2-reasoning-proxy.js
│   └── .opencode-backups/
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode2** (OpenCode V2, `subagent` tool with `agent`/`description`/`prompt`). Restart opencode after any change.

## Architecture

```
Primary (hypercharm/glm-5.3-flash, variant:high)      receives request, routes ALL research to detective
  ├── detective (hypercharm/glm-5.3-flash, high thinking)   research orchestrator (PREFERRED for lookups) [hypercharm]
  │   └── research-worker (agnes-research/agnes-2.5-flash, variant:research-worker)   parallel research workers (LOW reasoning) [agnes-research]
  ├── coordinator (hypercharm/qwen3-next-80b-a3b-instruct, variant:low)   implementation orchestrator: plans + delegates, cannot edit/shell itself [hypercharm]
  │   ├── edit (agnes-execute/agnes-2.5-flash#edit)     applies edits via edit tool + builds
  │   └── research (agnes-research/agnes-2.5-flash#research, variant:low) ONLY as fallback for gaps in detective findings
  └── explore (agnes-research/agnes-2.5-flash#explore)     nested lookups inside edit [agnes-research]
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

- **Agnes 2.5 Flash (agnes-research) for the research orchestrator (detective)**:
  coordinates complex multi-file research and fans out `research-worker` agents — high-stakes,
  a missed research path degrades everything after it. Note: the detective itself uses
  hypercharm/glm-5.3-flash, but it delegates lookups to agnes-research workers.

- **Agnes 2.5 Flash (agnes-research + agnes-execute) for the executers**: agnes-research
  (`research-worker`) does parallel fast lookups (LOW reasoning for speed), while agnes-research
  (`research`) does deep fallback searches (HIGH reasoning). agnes-execute (`edit`) applies code
  edits (LOW reasoning) via the edit tool. Both providers hit the same API endpoint with
  different API keys — read-only key for agnes-research, write key for agnes-execute.

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
- **`research-worker` cannot spawn subagents**: denied — leaf agent, parallel lookups only.

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
| research-worker (parallel lookups) | agnes-research/agnes-2.5-flash | research-worker | **low** | 1,024 | agnes free tier |
| coordinator (implementation orchestrator) | hypercharm/qwen3-next-80b-a3b-instruct | low | **low** | 131,072 | paid credits |
| edit (ALL code edits + shell/builds) | agnes-execute/agnes-2.5-flash | edit | **low** | 2,048 | agnes free tier |
| research (fallback for coordinator) | agnes-research/agnes-2.5-flash | research | **high** | 16,384 | agnes free tier |
| explore (nested lookups) | agnes-research/agnes-2.5-flash | explore | **low** | 2,048 | agnes free tier |
| findings saving | write_findings custom tool | — | — | — | zero (local, deterministic) |
| session titles | hypercharm/gpt-oss-120b | low | 2,048 | 65,536 | low tier (cheap) |
| small_model (compaction summaries) | hypercharm/glm-5.3 | high | 32,768 | 128,000 | paid credits |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.3-Flash (primary + detective, hypercharm)**: 1M context / 131K output — large context for orchestration and research planning. Paid tier. Variants: high (as configured).
- **Qwen3 Next 80B-A3B Instruct (coordinator, hypercharm)**: 1M context / 131K output — **LOW reasoning** for rapid task dispatching, clean schema adherence, token efficiency. Avoids extended thinking phases on simple orchestration tasks.
- **Agnes 2.5 Flash (agnes-research)**: 200K context
  - **research-worker variant (LOW)**: fast parallel lookups spawned by detective — minimal thinking (1K output), maximum throughput
  - **research variant (HIGH)**: fallback for coordinator when detective findings are sufficient — deep analysis (16K output)
  - **explore variant (LOW)**: nested lookups inside edit — minimal thinking (2K output)
- **Agnes 2.5 Flash (agnes-execute)**: 200K context / 2K output — **LOW reasoning** for code edits. Fast, deterministic, edit-tool focused.
- **GLM-5.3 (small_model)**: 128K output — compaction summaries on the flagship model. Explicitly pinned so it never inherits the host session model.

## write_findings tool

Findings/reports are saved with the `write_findings` custom tool (`plugins/write-findings/index.js`):
args `path` (absolute, must contain .opencode-findings) + `body` (verbatim markdown). It creates the
directory, writes the file, and returns `WRITTEN: <path> (<n> bytes)`. No subagent, no LLM call.

## How variants work

The Agnes API knows one model ID: `agnes-2.5-flash`. We register it under two providers —
`agnes-research` (read-only work, research API key) and `agnes-execute` (write work, execute API
key) — both pointing at the same `https://apihub.agnes-ai.com/v1` endpoint. Each provider defines
its own named variants via `reasoningEffort`. The agent `.md` files select which variant to use
via `variant: <name>` in their YAML frontmatter:

```yaml
model: agnes-research/agnes-2.5-flash
variant: explore    # low thinking (explore)

model: agnes-research/agnes-2.5-flash
variant: research-worker   # low thinking (fast lookups)

model: agnes-research/agnes-2.5-flash
variant: research   # high effort (deep lookups)

model: agnes-execute/agnes-2.5-flash
variant: edit       # low effort (fast edits)
```

All variants hit the same API endpoint with the same model name — only the
thinking budget sent in the request differs. No fake model IDs.

**Line ending fix:** The `edit-tool-fix` plugin normalizes paths and line endings before tool execution.
The `rg-fix` plugin normalizes rg.exe glob patterns on Windows (forward slashes → backslashes,
semicolons → separate `-g` flags).

## What small_model does (and doesn't)

`small_model` handles opencode's internal background tasks - most importantly
**compaction summaries** (when a long session is summarized to free context,
that summary becomes the session's memory, so quality matters) and other
utility generations.

It does **NOT** handle:
- **session titles** - `agents/title.md` overrides the internal title agent
  and pins those to HyperCharm gpt-oss-120b (cheap); small_model is bypassed for titles
- **exploration** - explore is a full agent with its own pinned model (agnes-research/agnes-2.5-flash)
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
3. `coordinator` delegates the changes: it spawns `edit` subagents (agnes-execute/agnes-2.5-flash#edit, **LOW reasoning**) which apply the
     edits via their edit tool calls — coordinator itself has edit DENIED and never
     touches files. Edit spawns are UNLIMITED — for INDEPENDENT edits (different files / non-overlapping
     regions) it issues as many `edit` spawns as the plan needs in ONE message; coordinator does the
     hard planning (goal decomposition, file resolution, exact anchors, edit ordering), the edit
     subagents do the mechanical application. Same-file/overlapping
     edits stay in a single spawn to avoid write conflicts.
  4. `coordinator` spawns `research` subagents (agnes-research/agnes-2.5-flash, variant:research, HIGH reasoning) ONLY as a
      fallback when the detective findings are insufficient (missing paths/context) — it must state
      exactly what info is missing in the spawn prompt.
5. After the edit spawns land, one final `edit` subagent runs the build/verify command (edit agents have shell; coordinator does not).
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
`[✏️Edit]`, `[🤖Coordinate]`, `[🔎Research]`, `[🕵🏼‍♂️Detective]`, `[🔎Explore]`. Primary sessions are not tagged.

## Data retention note

Code editing and deep research run on **Agnes AI** (apihub.agnes-ai.com) — review Agnes AI's terms at
https://agnes-ai.com/ to confirm whether API inputs are stored or used for model training. Explore lookups run
on the same endpoint with a read-only API key. The remaining models (GLM-5.3-Flash primary + detective + qwen3-next-80b-a3b-instruct coordinator + glm-5.3 compaction + gpt-oss-120b titles via HyperCharm) — review HyperCharm's terms separately.

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
- Plugin gotchas fixed in this repo (see `plugins/`):
  - **write-findings/**: V2 plugin using `ctx.tool.transform()` API. Returns `{ output: "..." }` with declared output schema. Replaces the summarizer subagent with a deterministic, instant file-write tool.
  - **edit-tool-fix/**: normalizes paths and line endings (CRLF→LF) in oldString/newString for better matching. Uses the edit tool's `path` field (not `filePath`).
  - **grep-fix/**: coerces invalid `include` parameter shapes (arrays) to the first positive glob. Keeps the 64KB-error → actionable-text conversion.
  - **rg-fix/**: hooks `shell` tool's `execute.before` to normalize rg.exe glob patterns on Windows — forward slashes → backslashes, semicolons → separate `-g` flags.
  - **mind-automation/**: V2 event subscription for mind CLI checkpoint automation.
  - **task-args-fixer/**: V2 no-op stub (V2 native schema).
  - **k2-reasoning-proxy.js**: plugin that autostarts the k2-proxy standalone server on port 8089 (IFM proxy for key rotation).

## Current routing summary

- Main model: hypercharm/glm-5.3-flash (variant high, reasoning effort high)
- Detective (research orchestrator): hypercharm/glm-5.3-flash (variant high, reasoning effort high)
- Research-worker (parallel lookups): agnes-research/agnes-2.5-flash#research-worker (variant research-worker, reasoning effort **low**)
- Coordinator (implementation orchestrator): hypercharm/qwen3-next-80b-a3b-instruct (variant low, reasoning effort **low**)
- Research (fallback): agnes-research/agnes-2.5-flash#research (variant research, reasoning effort **high**)
- Edit (code edits + shell/builds): agnes-execute/agnes-2.5-flash#edit (variant edit, reasoning effort **low**)
- Explore (nested lookups): agnes-research/agnes-2.5-flash#explore (variant explore, reasoning effort **low**)
- small_model (compaction): hypercharm/glm-5.3
- Titles: hypercharm/gpt-oss-120b
- Findings saving: write_findings custom tool (deterministic, replaced the summarizer subagent)

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=coordinator'
# expect: providerID=hypercharm modelID=qwen3-next-80b-a3b-instruct

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=edit'
# expect: providerID=agnes-execute modelID=agnes-2.5-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=research-worker'
# expect: providerID=agnes-research modelID=agnes-2.5-flash (LOW reasoning)

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=research'
# expect: providerID=agnes-research modelID=agnes-2.5-flash (HIGH reasoning, fallback only)
```
