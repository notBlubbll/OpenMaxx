# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Agnes for all searching,
paid DeepSeek only for code edits and compaction, free gateway for orchestration.

## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── explore.md      # all searching -> agnes-2.5-flash (free)
│   ├── general.md      # edits/shell -> DeepSeek-V4-Flash; delegates search to explore
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
| main + build (orchestration) | opencode/x-preview-f-free | free |
| general (edits, shell) | openference/DeepSeek-V4-Flash-0731 | paid quota |
| explore (ALL searching, any depth) | agnes/agnes-2.5-flash | free |
| session titles | agnes/agnes-2.5-flash | free |
| small_model | openference/DeepSeek-V4-Pro-0813 | paid quota |

## What small_model does (and doesn't)

`small_model` handles opencode's internal background tasks - most importantly
**compaction summaries** (when a long session is summarized to free context,
that summary becomes the session's memory, so quality matters) and any other
utility generations.

It does **NOT** handle:
- **session titles** - `agents/title.md` overrides the internal title agent
  and pins those to Agnes (free); small_model is bypassed for titles
- **exploration** - explore is a full agent with its own pinned model (Agnes)
- **edits / shell / orchestration** - those run on the main and general models

Rationale: compaction is rare but high-stakes (a lossy summary degrades
everything after it), so it keeps the strongest summarizer; titles are frequent
but trivial, so they go to the free tier.

## How nesting works

1. Primary orchestrates only; all edit/read/search/shell work goes through Task subagents.
2. `subagent_depth: 2` allows one nesting level.
3. `permission.task.explore: allow` on general keeps the Task tool inside subagents.
4. Explores have no task permission -> recursion hard-stops at depth 2.
5. Pre-explore discipline: primary front-loads exploration and hands general
   exact paths, so paid searches approach zero.

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=explore'
# expect: providerID=agnes modelID=agnes-2.5-flash
```
