# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Agnes for ALL searching
AND all code edits, paid DeepSeek only for coordination reasoning, paid
DeepSeek Pro for high-stakes background summaries.

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
│   ├── explore.md      # searching -> agnes-2.5-flash variant:explore (free, light thinking)
│   ├── edit.md         # code edits + shell/builds -> agnes-2.5-flash variant:edit (free, deep thinking)
│   ├── general.md      # coordinator -> DeepSeek-V4-Flash; cannot edit/bash itself
│   └── title.md        # session titles -> agnes-2.5-flash variant:explore (free)  [overrides small_model]
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Restart opencode after any change.

## Model routing

| Role | Model ID | Variant | Thinking | Output | Cost |
|---|---|---|---|---|---|
| main + build (orchestration) | openference/GLM-5.2 | max | 65,536 | 73,728 | paid quota |
| edit (ALL code edits + shell/builds) | agnes/agnes-2.5-flash | edit | 8,192 | 65,536 | free |
| explore (ALL searching, any depth) | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| session titles | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| general (coordinator, planning only) | openference/DeepSeek-V4-Flash-0731 | max | max | 16,384 | paid quota |
| small_model (compaction summaries) | openference/DeepSeek-V4-Pro-0813 | max | max | 384,000 | paid quota |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.2 (orchestrator)**: 65K thinking / 73K output — max deep reasoning,
  concise ~8K visible response. The orchestrator plans extensively but outputs
  short delegation instructions.
- **DeepSeek-V4-Flash (coordinator)**: `reasoningEffort: max` / 16K output —
  deep reasoning for task decomposition, concise delegation output.
- **agnes-2.5-flash variant:explore (searching)**: 2K thinking / 65K output —
  light reasoning (search doesn't need deep planning), full output for
  comprehensive findings. Agnes recommends 2K for regular tasks.
- **agnes-2.5-flash variant:edit (code edits)**: 8K thinking / 65K output —
  4x deeper reasoning than explore, since code changes need more
  problem-solving. Full output for large patches.
- **DeepSeek-V4-Pro (small_model)**: `reasoningEffort: max` / 384K output —
  max reasoning and full output for high-quality compaction summaries.

## How variants work

The Agnes API only knows one model ID: `agnes-2.5-flash`. We register it once
in `opencode.json` with **named variants** — each variant sets a different
thinking budget via `thinking.type: "enabled"` + `thinking.budget_tokens: N`.
The agent `.md` files select which variant to use via `variant: <name>` in
their YAML frontmatter:

```yaml
# agents/explore.md
model: agnes/agnes-2.5-flash
variant: explore    # 2,048 thinking tokens

# agents/edit.md
model: agnes/agnes-2.5-flash
variant: edit       # 8,192 thinking tokens
```

Both variants hit the same API endpoint with the same model name — only the
thinking budget sent in the request differs. No fake model IDs.

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

## Subsession title tags

Subagent sessions are tagged in their title for easy identification:
`[✏️Edit]`, `[🔎Explore]`, `[🤖Coordinate]`. Primary sessions are not tagged.

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=edit'
# expect: providerID=agnes modelID=agnes-2.5-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=explore'
# expect: providerID=agnes modelID=agnes-2.5-flash
```
