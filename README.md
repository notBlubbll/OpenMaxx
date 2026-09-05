# opencode multi-model subagent setup

Repo: [notBlubbll/OpenMaxx](https://github.com/notBlubbll/OpenMaxx)

Routes opencode work across providers by cost and role: GLM-5.3-Flash (hypercharm, 1M context)
for primary orchestration; DeepSeek-V4-Pro-0813 (hypercharm) as the research orchestrator
(detective); **airouter** (api.airouter.ch) for the executers — DeepSeek-V4-Flash for deep
research and Qwen-3.8-27B for code edits; Qwen3.8 Flash (hypercharm) for the implementation
coordinator; GLM-5.3 (hypercharm flagship) for compaction; hypercharm/gpt-oss-120b for session
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

**OpenFerence** — sign up with this referral link to get **$5 credit**:
https://openference.com/register?ref=JTVJHCYR

Then set environment variables:

```
OPENFERENCE_API_KEY=...
```

**AI Router (executers: research + edit)** — get your key from your AI Router account and set
it in `opencode.json` under `provider.airouter.options.apiKey` (baseURL
`https://api.airouter.ch/v1`). Models: `Qwen3.8` (Qwen-3.8-27B) and `DeepSeek-V4-Flash`
(DeepSeek-V4-Flash-0731).

**HyperCharm** — set your key in `opencode.json` under `provider.hypercharm.options.apiKey`
(baseURL `https://hyper.charm.land/v1`). Models: `glm-5.3-flash` (primary), `deepseek-v4-pro-0813`
(detective), `qwen3.8-flash` (coordinator), `glm-5.3` (compaction, flagship), and `gpt-oss-120b`
(titles — HyperCharm's low tier, trivially cheap).

## OpenAI-Compatible SDK on OpenFerence (stability)

GLM-5.3-Flash (primary) and DeepSeek-V4-Pro-0813 (detective) route via the `openference` provider;
DeepSeek-V4-Flash (research) and Qwen3.8 (edit) route via the `airouter` provider
(api.airouter.ch); qwen3.8-flash (coordinator), glm-5.3 (compaction) and gpt-oss-120b (titles)
route via the `hypercharm` provider; agnes-research/agnes-2.5-flash (explore) points at the
apihub.agnes-ai.com endpoint.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The `airouter` provider serves the executers (research + edit). The `openference` provider serves
the primary and detective. The `hypercharm` provider serves the coordinator, small_model and titles.


## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
    │   ├── research.md     # deep search -> airouter/DeepSeek-V4-Flash variant:research (saves via write_findings)
    │   ├── detective.md  # research orchestrator -> hypercharm/deepseek-v4-pro-0813 variant:high (spawns research workers)
│   ├── edit.md         # code edits + shell/builds -> airouter/Qwen3.8 variant:edit (edit-ops batch tool)
│   ├── coordinator.md    # implementation orchestrator -> hypercharm/qwen3.8-flash; plans + delegates, cannot edit/bash itself
│   └── title.md        # session titles -> hypercharm/gpt-oss-120b  [overrides small_model]
├── tools/            # edit-ops.js (batch file edits), write.js (schema-safe write override)
├── plugins/          # write-findings.js, task-args-fixer.js
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Restart opencode after any change.

## Architecture

```
Primary (hypercharm/glm-5.3-flash, variant:high)      receives request, delegates GOAL
  ├── research (airouter/DeepSeek-V4-Flash, variant:research)   deep lookups, saves via write_findings tool
  ├── detective (hypercharm/deepseek-v4-pro-0813, high thinking)   research orchestrator (PREFERRED for lookups) [hypercharm]
  │   └── research (airouter/DeepSeek-V4-Flash, variant:research)      spawns workers for parallel search
  └── coordinator (hypercharm/qwen3.8-flash, variant:high)    implementation orchestrator: plans, sequences, fans out [hypercharm]
      ├── edit (airouter/Qwen3.8)     applies edits via edit-ops batch tool + builds
      └── research (airouter/DeepSeek-V4-Flash, variant:research) deep code tracing inside coordinator sessions
```

The primary NEVER spawns `edit` directly — ALL edits go through `coordinator`.
The primary spawns `detective` for multi-file lookups (PREFERRED) and `research` for trivial single-file reads only.

## Why this routing

The split is by cost, with one principle: the free tier handles all the
search work, paid models only do reasoning and orchestration.


- **GLM-5.3-Flash (paid, openference) for primary orchestration**: receives requests and
  delegates goals — large context for delegation decisions.

- **DeepSeek-V4-Pro-0813 (paid, openference) for the research orchestrator (detective)**:
  coordinates complex multi-file research and fans out research workers — high-stakes,
  a missed research path degrades everything after it.
- **Qwen3.8 Flash (hypercharm) for the implementation coordinator**: plans and sequences
  edits, fans out edit spawns — it only delegates, its own edit/bash are permission-denied.
- **airouter for the executers**: DeepSeek-V4-Flash does the deep search (research), 
  Qwen-3.8-27B applies the code edits (edit) via the edit-ops batch tool.
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
- **`coordinator` cannot edit/bash**: denied in its own permission block — it can
  only plan and delegate to `edit` and `research`.
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

| Role | Model ID | Variant | Thinking | Output | Cost |
|---|---|---|---|---|---|
| main (orchestration) | hypercharm/glm-5.3-flash | high | high effort | 131,072 | paid credits |
| detective (research orchestrator) | hypercharm/deepseek-v4-pro-0813 | high | high effort | 262,144 | paid credits |
| coordinator (implementation orchestrator) | hypercharm/qwen3.8-flash | high | high effort | 128,000 | paid credits |
| edit (ALL code edits + shell/builds) | airouter/Qwen3.8 | edit | high effort | 65,536 | airouter flat |
| research (deep search, all lookups) | airouter/DeepSeek-V4-Flash | research | high effort | 32,768 | airouter flat |
| findings saving | write_findings custom tool | — | — | — | zero (local, deterministic) |
| session titles | hypercharm/gpt-oss-120b | low | 2,048 | 65,536 | low tier (cheap) |
| small_model (compaction summaries) | hypercharm/glm-5.3 | high | 32,768 | 128,000 | paid credits |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.3-Flash (primary, hypercharm)**: 1M context / 131K output — large context for orchestration and
  delegation decisions. Paid tier. Variants: high (as configured), matching the deepseek-pro setup.
- **DeepSeek-V4-Pro-0813 (detective)**: 1M context / 262K output — deep reasoning for research
  orchestration and parallel worker fan-out.
- **Qwen3.8 Flash (coordinator)**: 1M context / 128K output — task decomposition and edit
  sequencing on a fast lane.
- **airouter executers**: DeepSeek-V4-Flash (research) 1M context / 32K output for tracing call
  paths across files; Qwen-3.8-27B (edit) 256K context / 64K output for full patches via the
  edit-ops batch tool.
- **GLM-5.3 (small_model)**: 128K output — compaction summaries on the flagship model. Explicitly
  pinned so it never inherits the host session model.

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
variant: edit       # high effort (full edits)
```

All variants hit the same API endpoint with the same model name — only the
thinking budget sent in the request differs. No fake model IDs.

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

1. Primary receives the request and delegates the GOAL to `coordinator`
   (sub-orchestrator). The primary NEVER spawns `edit` directly — ALL edits
   go through `coordinator`. The primary spawns `detective` for multi-file lookups and `research` for trivial single-file reads.
2. `coordinator` (hypercharm/qwen3.8-flash) plans the implementation: breaks the goal into
   precise edit steps with exact file paths, and sequences the work. Its own
   edit/bash tools are permission-denied, so it can ONLY delegate.
3. `coordinator` applies changes via edit-ops batch tool calls (airouter/Qwen3.8 emits the ops). For
   INDEPENDENT edits (different files / non-overlapping regions), it issues
   MULTIPLE `edit` spawns in ONE message (parallel). Same-file/overlapping
   edits stay in a single call to avoid write conflicts.
4. `coordinator` spawns `research` subagents (airouter/DeepSeek-V4-Flash, variant:research) for any lookups it needs,
   also parallelized when independent.
5. After the edit-ops batch lands, one build/verify command (via the edit agent's bash) confirms the result.
6. `subagent_depth: 3` allows deeper nesting; research has no task
   permission, so recursion hard-stops at depth 2.
7. Pre-explore discipline: primary may front-load exploration via a `detective`
   spawn (which fans out research workers) before delegating to `coordinator`,
   so the goal already contains exact paths and context.

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

Code editing and deep research run on **AI Router** (api.airouter.ch: DeepSeek-V4-Flash for
research, Qwen-3.8-27B for edits) — review AI Router's data-retention terms. Explore lookups run
on **Agnes 2.5 Flash** (free tier via agnes-research) — review Agnes AI's terms at
https://agnes-ai.com/ to confirm whether API inputs are stored or used for model
training. The remaining models (GLM-5.3-Flash primary, DeepSeek-V4-Pro-0813 detective via
OpenFerence; qwen3.8-flash coordinator, glm-5.3 compaction, gpt-oss-120b titles via HyperCharm)
— review OpenFerence's and HyperCharm's terms separately.

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


## Current routing summary

- Main model: hypercharm/glm-5.3-flash (variant high)
- Detective (research orchestrator): hypercharm/deepseek-v4-pro-0813 variant high
- Coordinator (implementation orchestrator): hypercharm/qwen3.8-flash variant high
- small_model (compaction): hypercharm/glm-5.3
- Research (executer): airouter/DeepSeek-V4-Flash variant research
- Edit (executer): airouter/Qwen3.8 variant edit
- Titles: hypercharm/gpt-oss-120b; Explore: agnes-research/agnes-2.5-flash
- Findings saving: write_findings custom tool (deterministic, replaced the summarizer subagent)
- Batch file edits: edit-ops custom tool (replaced the edit subagent for multi-file work)

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=coordinator'
# expect: providerID=hypercharm modelID=qwen3.8-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=edit'
# expect: providerID=airouter modelID=Qwen3.8

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=research'
# expect: providerID=airouter modelID=DeepSeek-V4-Flash
```

(End of file - total 304 lines)
