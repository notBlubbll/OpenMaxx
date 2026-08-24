# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Agnes for ALL searching
AND all code edits, paid DeepSeek only for coordination reasoning, paid
GLM-5.2 for high-stakes background summaries.

## Get API keys

**OpenFerence** — sign up with this referral link to get **$5 credit**:
https://openference.com/register?ref=JTVJHCYR

**Agnes AI** — create a free API key (no card required) at:
https://platform.agnes-ai.com/

Then set environment variables:

```
OPENFERENCE_API_KEY=...
AGNES_API_KEY=...
```

## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── research.md     # deep search -> agnes-2.5-flash variant:research (free, read-only, spawns summarizer)
│   ├── detective.md  # complex research -> DeepSeek-V4-Flash-0731 variant:max (paid, max thinking, spawns research workers)
│   ├── summarizer.md   # writes findings to disk -> agnes-2.5-flash (free, write-only)
│   ├── edit.md         # code edits + shell/builds -> agnes-2.5-flash variant:edit (free)
│   ├── general.md      # sub-orchestrator -> DeepSeek-V4-Pro-0813; plans + delegates, cannot edit/bash itself
│   └── title.md        # session titles -> agnes-2.5-flash variant:explore (free)  [overrides small_model]
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Restart opencode after any change.

## Architecture

```
Primary (GLM-5.2, paid)          receives request, delegates GOAL
  ├── research (Agnes, free)      deep code tracing + multi-file search
  │   └── summarizer (Agnes, free)     writes findings to disk
  ├── detective (DeepSeek Flash, paid, max thinking)    complex research coordination
  │   └── research (Agnes, free)      spawns workers for parallel search
  │       └── summarizer (Agnes, free)     writes findings to disk
  └── general (DeepSeek Pro, paid)    sub-orchestrator: plans, sequences, fans out
      ├── edit (Agnes, free)     applies edits + builds (parallel if independent)
      └── research (Agnes, free) deep code tracing inside coordinator sessions
          └── summarizer (Agnes, free)     writes findings to disk
```

The primary NEVER spawns `edit` directly — ALL edits go through `general`.
The primary spawns `research` for all lookups (single-file and multi-file).

## Why this routing

The split is by cost, with one principle: the free tier handles all the
search and edit work, paid models only do reasoning.

- **Agnes (free) for ALL searching and ALL code edits**: research deep-dives,
  edit patches, summarizer file-writes, session titles. These
  are the bulk of the work, so keeping them on the free tier keeps costs near
  zero.

- **DeepSeek Pro (paid) for coordination**: task decomposition, edit sequencing,
  parallel fan-out planning — the strongest reasoning model for the job that
  determines the quality of all downstream work.

- **GLM-5.2 (paid) for orchestration + compaction**: the primary agent's
  delegation decisions and compaction summaries are high-stakes — a bad
  summary degrades everything after it.

## Design principle: permission-enforced rules

Rules stated in `AGENTS.md` are text — they compete for attention with growing
history and can silently stop firing. The strongest rules in this setup are NOT
text: they are **permission-denied** in `opencode.json`, so they cannot decay:

- **Primary cannot edit/search/bash**: `build` permission denies `edit`, `glob`,
  `grep`, `bash` — the primary physically cannot do implementation work, only
  delegate.
- **Primary cannot spawn `edit`**: `build.task` allows only `general` and
  `research` — `edit` is absent, so the primary cannot bypass the coordinator.
- **`general` cannot edit/bash**: denied in its own permission block — it can
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
| main + build (orchestration) | openference/GLM-5.2 | max | 65,536 | 73,728 | paid quota |
| general (sub-orchestrator) | openference/DeepSeek-V4-Pro-0813 | max | max | 384,000 | paid quota |
| edit (ALL code edits + shell/builds) | agnes/agnes-2.5-flash | edit | 8,192 | 65,536 | free |
| research (deep search, all lookups) | agnes/agnes-2.5-flash | research | 4,096 | 65,536 | free |
| detective (complex research coord) | openference/DeepSeek-V4-Flash-0731 | max | max | 384,000 | paid quota |
| summarizer (writes findings files) | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| session titles | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| small_model (compaction summaries) | openference/GLM-5.2 | max | 65,536 | 73,728 | paid quota |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.2 (orchestrator)**: 65K thinking / 73K output — max deep reasoning,
  concise ~8K visible response. The orchestrator plans extensively but outputs
  short delegation instructions.
- **DeepSeek-V4-Pro-0813 (sub-orchestrator)**: `reasoningEffort: max` / 384K
  output — deep reasoning for task decomposition, full delegation output.
- **agnes-2.5-flash variant:explore (titles)**: 2K thinking / 65K output —
  light reasoning, full output for findings.
- **agnes-2.5-flash variant:research (deep search)**: 4K thinking / 65K
  output — double the explore budget for tracing call paths across files.
- **agnes-2.5-flash variant:edit (code edits)**: 8K thinking / 65K output —
  4x deeper reasoning than explore for code changes. Full output for patches.
- **GLM-5.2 (small_model)**: 65K thinking / 73K output —
  deep reasoning and full output for high-quality compaction summaries.
## How variants work

The Agnes API only knows one model ID: `agnes-2.5-flash`. We register it once
in `opencode.json` with **named variants** — each variant sets a different
thinking budget via `thinking.type: "enabled"` + `thinking.budget_tokens: N`.
The agent `.md` files select which variant to use via `variant: <name>` in
their YAML frontmatter:

```yaml
model: agnes/agnes-2.5-flash
variant: explore    # 2,048 thinking tokens
# or
variant: research   # 4,096 thinking tokens
# or
variant: edit       # 8,192 thinking tokens
```

All three variants hit the same API endpoint with the same model name — only
the thinking budget sent in the request differs. No fake model IDs.

## What small_model does (and doesn't)

`small_model` handles opencode's internal background tasks - most importantly
**compaction summaries** (when a long session is summarized to free context,
that summary becomes the session's memory, so quality matters) and other
utility generations.

It does **NOT** handle:
- **session titles** - `agents/title.md` overrides the internal title agent
  and pins those to Agnes (free); small_model is bypassed for titles
- **exploration** - research is a full agent with its own pinned model (Agnes)
- **edits / shell / orchestration** - those run on the edit, main and
  general models

Rationale: compaction is rare but high-stakes (a lossy summary degrades
everything after it), so it keeps the strongest summarizer; titles are frequent
but trivial, so they go to the free tier.

## How nesting + parallelization works

1. Primary receives the request and delegates the GOAL to `general`
   (sub-orchestrator). The primary NEVER spawns `edit` directly — ALL edits
   go through `general`. The primary spawns `research` for all lookups.
2. `general` (paid DeepSeek Pro) plans the implementation: breaks the goal into
   precise edit steps with exact file paths, and sequences the work. Its own
   edit/bash tools are permission-denied, so it can ONLY delegate.
3. `general` spawns `edit` subagents (free Agnes) to apply each change. For
   INDEPENDENT edits (different files / non-overlapping regions), it issues
   MULTIPLE `edit` spawns in ONE message (parallel). Same-file/overlapping
   edits stay in a single call to avoid write conflicts.
4. `general` spawns `research` subagents (free Agnes) for any lookups it needs,
   also parallelized when independent.
5. After parallel edits return, one `edit` subagent builds/verifies the
   combined result.
6. `subagent_depth: 2` allows one nesting level; research has no task
   permission, so recursion hard-stops at depth 2.
7. Pre-explore discipline: primary may front-load exploration via a quick
   `research` spawn before delegating to `general`, so the goal already contains
   exact paths and context.

## Snippet proof (verification, not enforcement)

Findings files from `research` must include a verbatim 1-3 line
quote from each cited `file:line` reference. This proves the subagent actually
read the file rather than confabulating a plausible-sounding reference. The
caller can grep the quoted string to verify. This is the cheapest verification
that survives compaction — it lives in the findings file on disk, not in
history that gets summarised.

The one-line summary from subagents ends with "READ BEFORE ACTING" as a
per-turn reminder that survives in history. The caller (primary or general)
is instructed to read the findings file via the Read tool before acting on
any edit decision. This is text-mediated — it can decay in long sessions —
but the reminder is fresh on every turn because it's in the response, not
just in the injected instructions.

## Subsession title tags

Subagent sessions are tagged in their title for easy identification:
`[✏️Edit]`, `[🤖Coordinate]`, `[🔎Research]`, `[💭Summarizer]`. Primary sessions are not tagged.

## Data retention note

All code editing and searching in this setup runs on **Agnes 2.5 Flash** (free tier).
Before pointing this at a private repository, review Agnes AI's data-retention
and training-usage terms at https://agnes-ai.com/ to confirm whether API inputs
are stored or used for model training. The paid models (GLM-5.2, DeepSeek Pro)
run through OpenFerence — review their terms separately.

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


## Planned upgrades

- Main model: GLM-5.2 → GLM-5.3 once released
- General (sub-orchestrator): currently DeepSeek-V4-Pro-0813

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=general'
# expect: providerID=openference modelID=DeepSeek-V4-Pro-0813

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=edit'
# expect: providerID=agnes modelID=agnes-2.5-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=research'
# expect: providerID=agnes modelID=agnes-2.5-flash
```
