# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Agnes for ALL searching
AND all code edits, paid DeepSeek only for coordination reasoning, paid
DeepSeek Pro for high-stakes background summaries.

## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── explore.md      # searching -> agnes-2.5-flash (free)
│   ├── edit.md         # code edits + shell/builds -> agnes-2.5-flash (free)
│   ├── general.md      # coordinator -> DeepSeek-V4-Flash; cannot edit/bash itself
│   └── title.md        # session titles -> agnes-2.5-flash (free)  [overrides small_model]
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Set API keys first:

```
OPENFERENCE_API_KEY=...
AGNES_API_KEY=...
```

Restart opencode after any change.

## Model routing

| Role | Model | Cost |
|---|---|---|
| main + build (orchestration) | openference/GLM-5.2 | paid quota |
| edit (ALL code edits + shell/builds) | agnes/agnes-2.5-flash | free |
| explore (ALL searching, any depth) | agnes/agnes-2.5-flash | free |
| session titles | agnes/agnes-2.5-flash | free |
| general (coordinator, planning only) | openference/DeepSeek-V4-Flash-0731 | paid quota |
| small_model (compaction summaries) | openference/DeepSeek-V4-Pro-0813 | paid quota |

## What small_model does (and doesn't)

`small_model` handles opencode's internal background tasks - most importantly
**compaction summaries** (when a long session is summarized to free context,
that summary becomes the session's memory, so quality matters) and other
utility generations.

It does **NOT** handle:
- **session titles** - `agents/title.md` overrides the internal title agent
  and pins those to Agnes (free); small_model is bypassed for titles
- **exploration** - explore is a full agent with its own pinned model (Agnes)
- **edits / shell / orchestration** - those run on the edit, main and
  general models

Rationale: compaction is rare but high-stakes (a lossy summary degrades
everything after it), so it keeps the strongest summarizer; titles are frequent
but trivial, so they go to the free tier.

## How nesting + parallelization works

1. Primary orchestrates only; all work goes through Task subagents.
2. With precise instructions, every edit + shell/build unit goes to an `edit`
   subagent (free Agnes).
3. `general` (paid DeepSeek) is a pure coordinator: its own edit/bash tools are
   permission-denied, so it can ONLY delegate to `edit` and `explore`.
4. **Parallel fan-out**: `general` shards independent edits across MULTIPLE
   `edit` subagents in ONE message (parallel) rather than batching them into
   one call. Same-file/overlapping edits stay in a single call to avoid write
   conflicts. Independent searches fan out across parallel `explore`
   subagents the same way. After parallel edits return, one `edit` subagent
   builds/verifies the combined result.
5. `subagent_depth: 2` allows one nesting level; explores have no task
   permission, so recursion hard-stops at depth 2.
6. Pre-explore discipline: primary front-loads exploration and hands exact
   paths downward, so paid requests approach zero.

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=edit'
# expect: providerID=agnes modelID=agnes-2.5-flash
```
