# opencode multi-model subagent setup

Repo: [notBlubbll/OpenMaxx](https://github.com/notBlubbll/OpenMaxx)

Routes opencode work across providers by cost and role: paid GLM-5.3-Flash for primary orchestration
and coordination reasoning; GLM-5.3 (flagship) for detective work and compaction; IFM/K2-Horizon-375B-A23B (524K context) for deep research
and code edits; agnes-research/agnes-2.5-flash for session titles and explore lookups; findings are saved
directly via the deterministic write_findings custom tool (no subagent, no LLM). GLM models route via the
OpenAI-compatible SDK (`openference` provider) against the OpenFerence /v1/chat/completions endpoint with
Bearer auth; IFM uses the `ifm` provider (api.ifm.ai); agnes-research and agnes-execute each point at the
same apihub.agnes-ai.com endpoint with different API keys.

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

## OpenAI-Compatible SDK on OpenFerence (stability)

GLM-5.3-Flash (primary + coordinator) and GLM-5.3 (detective + small_model) route
via the openference provider using @ai-sdk/openai-compatible against the
OpenFerence /v1/chat/completions endpoint with Bearer auth.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The openference provider (OpenAI-compatible SDK) is used for all GLM models. Deep research and code edits run on the `ifm` provider (api.ifm.ai, K2-Horizon-375B-A23B, 524K context).


## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
    │   ├── research.md     # deep search -> ifm/IFM/K2-Horizon-375B-A23B variant:research (saves via write_findings)
    │   ├── detective.md  # complex research -> GLM-5.3 (flagship) variant:high (paid, spawns research workers) [OpenAI-compatible SDK via openference provider]
│   ├── edit.md         # code edits + shell/builds -> ifm/IFM/K2-Horizon-375B-A23B variant:edit (edit-ops batch tool)
│   ├── coordinator.md    # sub-orchestrator -> GLM-5.3-Flash; plans + delegates, cannot edit/bash itself [OpenAI-compatible SDK via openference provider]
│   └── title.md        # session titles -> agnes-research/agnes-2.5-flash variant:explore (free)  [overrides small_model]
├── tools/            # edit-ops.js (batch file edits), write.js (schema-safe write override)
├── plugins/          # write-findings.js, task-args-fixer.js
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Restart opencode after any change.

## Architecture

```
Primary (GLM-5.3-Flash, paid, openference provider)          receives request, delegates GOAL
  ├── research (ifm/IFM/K2-Horizon-375B-A23B, variant:research)   deep lookups, saves via write_findings tool
  ├── detective (GLM-5.3 flagship, paid, high thinking)    complex multi-file research (PREFERRED for lookups) [OpenAI-compatible SDK]
  │   └── research (ifm/IFM/K2-Horizon-375B-A23B, variant:research)      spawns workers for parallel search
  └── coordinator (GLM-5.3-Flash, paid)    sub-orchestrator: plans, sequences, fans out [OpenAI-compatible SDK]
      ├── edit (IFM K2-Horizon)     applies edits via edit-ops batch tool + builds
      └── research (ifm/IFM/K2-Horizon-375B-A23B, variant:research) deep code tracing inside coordinator sessions
```

The primary NEVER spawns `edit` directly — ALL edits go through `coordinator`.
The primary spawns `detective` for multi-file lookups (PREFERRED) and `research` for trivial single-file reads only.

## Why this routing

The split is by cost, with one principle: the free tier handles all the
search work, paid models only do reasoning and orchestration.


- **GLM-5.3-Flash (paid) for coordination**: task decomposition, edit sequencing,
  parallel fan-out planning — the strongest reasoning model for the job that
  determines the quality of all downstream work.

- **GLM-5.3 (paid flagship) for detective work**: the detective agent coordinates complex multi-file research with high thinking — high-stakes, a missed research path degrades everything after it.
- **GLM-5.3 (paid flagship) for compaction (small_model)**: small_model handles compaction summaries. GLM-5.3 has 512K context / 128K output — a lossy summary degrades everything after it, so it gets the flagship. Explicitly pinned so small_model never inherits a different host session model.

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
| main (orchestration) | openference/GLM-5.3-Flash | max | 65,536 | 128,000 | paid credits |
| coordinator (sub-orchestrator) | openference/GLM-5.3-Flash | high | 16,384 | 128,000 | paid credits |
| edit (ALL code edits + shell/builds) | ifm/IFM/K2-Horizon-375B-A23B | edit | high effort | 32,768 | IFM credits |
| research (deep search, all lookups) | ifm/IFM/K2-Horizon-375B-A23B | research | high effort | 32,768 | IFM credits |
| detective (complex research coord) | openference/GLM-5.3 | high | 32,768 | 128,000 | paid credits |
| findings saving | write_findings custom tool | — | — | — | zero (local, deterministic) |
| session titles | agnes-research/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| small_model (compaction summaries) | openference/GLM-5.3 | high | 32,768 | 128,000 | paid credits |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.3-Flash (primary + coordinator)**: 1M context / 128K output — large context for orchestration and delegation decisions. Paid tier. Variants: max (65K thinking), high (32K), medium (16K), low (8K).
- **GLM-5.3 (detective + small_model)**: 512K context / 128K output — flagship deep reasoning for complex multi-file research coordination and high-stakes compaction summaries. Variants: max/high/medium/low.
- **GLM-5.3-Flash (sub-orchestrator)**: 65K thinking / 384K output — deep
  reasoning for task decomposition, full delegation output.
- **IFM K2-Horizon-375B-A23B (deep search + code edits)**: 524K context / 32K output —
  high-effort reasoning for tracing call paths across files and full patches (edit-ops batch tool).
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

The Agnes API knows one model ID: `agnes-2.5-flash` (titles); IFM knows `K2-Horizon-375B-A23B`
(deep research + edits). We register Agnes separately under two providers — `agnes-research`
(read-only work, research API key) and `agnes-execute` (write work, execute API key) — both pointing at the
same `https://apihub.agnes-ai.com/v1` endpoint. Each provider defines its own
named variants with different thinking budgets via `thinking.type: "enabled"` +
`thinking.budget_tokens: N`. The agent `.md` files select which variant to use via
`variant: <name>` in their YAML frontmatter:

```yaml
model: agnes-research/agnes-2.5-flash
variant: explore    # 2,048 thinking tokens (titles)

model: ifm/IFM/K2-Horizon-375B-A23B
variant: research   # high effort (deep lookups)
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
  and pins those to Agnes (free); small_model is bypassed for titles
- **exploration** - research is a full agent with its own pinned model (ifm/IFM/K2-Horizon-375B-A23B)
- **edits / shell / orchestration** - those run on the edit, main and
  coordinator models

Rationale: compaction is rare but high-stakes (a lossy summary degrades everything after it), so it gets GLM-5.3 — the flagship, with 512K context headroom and explicitly pinned so it never inherits the host session model. Titles are frequent but trivial, so they go to the free Agnes tier. Findings saves are the deterministic write_findings tool (zero cost, instant).

## How nesting + parallelization works

1. Primary receives the request and delegates the GOAL to `coordinator`
   (sub-orchestrator). The primary NEVER spawns `edit` directly — ALL edits
   go through `coordinator`. The primary spawns `detective` for multi-file lookups and `research` for trivial single-file reads.
2. `coordinator` (paid GLM-5.3-Flash) plans the implementation: breaks the goal into
   precise edit steps with exact file paths, and sequences the work. Its own
   edit/bash tools are permission-denied, so it can ONLY delegate.
3. `coordinator` applies changes via edit-ops batch tool calls (IFM K2-Horizon emits the ops). For
   INDEPENDENT edits (different files / non-overlapping regions), it issues
   MULTIPLE `edit` spawns in ONE message (parallel). Same-file/overlapping
   edits stay in a single call to avoid write conflicts.
4. `coordinator` spawns `research` subagents (ifm/IFM/K2-Horizon-375B-A23B, variant:research) for any lookups it needs,
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

Code editing and deep research run on **IFM K2-Horizon-375B-A23B** (api.ifm.ai) — review IFM's data-retention terms. Session titles and explore lookups run on **Agnes 2.5 Flash** (free tier via agnes-research) — review Agnes AI's terms at https://agnes-ai.com/. The GLM models (primary, coordinator, detective, small_model) run through OpenFerence — review their terms separately.
this at a private repository, review Agnes AI's data-retention and training-usage
terms at https://agnes-ai.com/ to confirm whether API
inputs are stored or used for model training. The paid models (GLM-5.3-Flash
for primary + coordinator + detective + small_model) run through OpenFerence — review their
terms separately.

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

- Main model: GLM-5.3-Flash (current)
- Coordinator: GLM-5.3-Flash variant high
- Detective: GLM-5.3 flagship variant high
- small_model (compaction): GLM-5.3 flagship
- Research + Edit: ifm/IFM/K2-Horizon-375B-A23B (524K context, reasoning_effort high)
- Findings saving: write_findings custom tool (deterministic, replaced the summarizer subagent)
- Batch file edits: edit-ops custom tool (replaced the edit subagent for multi-file work)

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=coordinator'
# expect: providerID=openference modelID=GLM-5.3-Flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=edit'
# expect: providerID=ifm modelID=IFM/K2-Horizon-375B-A23B

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=research'
# expect: providerID=ifm modelID=IFM/K2-Horizon-375B-A23B
```

(End of file - total 304 lines)
