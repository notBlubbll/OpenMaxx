# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Agnes for quick lookups
AND all code edits, paid DeepSeek for coordination and deep research, paid
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
│   ├── explore.md      # quick lookups (primary direct) -> agnes-2.5-flash variant:explore (free)
│   ├── research.md     # deep search (primary or nested) -> DeepSeek-V4-Flash (paid, strong reasoning)
│   ├── edit.md         # code edits + shell/builds -> agnes-2.5-flash variant:edit (free, deep thinking)
│   ├── general.md      # sub-orchestrator -> DeepSeek-V4-Flash; plans + delegates, cannot edit/bash itself
│   └── title.md        # session titles -> agnes-2.5-flash variant:explore (free)  [overrides small_model]
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Restart opencode after any change.

## Architecture

```
Primary (GLM-5.2, paid)
  ├─ explore (Agnes, free)         quick/medium lookups only
  ├─ research (DeepSeek, paid)     very thorough multi-file tracing
  └─ general (DeepSeek, paid)      sub-orchestrator: plans, sequences, fans out
       ├─ edit (Agnes, free)       applies edits + builds (parallel if independent)
       └─ research (DeepSeek)      deep code tracing inside coordinator sessions
```

The primary NEVER spawns `edit` directly — ALL edits go through `general`.
The primary picks `explore` (Agnes, free) for quick/medium lookups and
`research` (DeepSeek, paid) for very thorough multi-file tracing.

## Model routing

| Role | Model ID | Variant | Thinking | Output | Cost |
|---|---|---|---|---|---|
| main + build (orchestration) | openference/GLM-5.2 | max | 65,536 | 73,728 | paid quota |
| general (sub-orchestrator) | openference/DeepSeek-V4-Flash-0731 | max | max | 32,768 | paid quota |
| edit (ALL code edits + shell/builds) | agnes/agnes-2.5-flash | edit | 8,192 | 65,536 | free |
| explore (quick/medium lookups) | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| research (very thorough tracing) | openference/DeepSeek-V4-Flash-0731 | max | max | 32,768 | paid quota |
| session titles | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| small_model (compaction summaries) | openference/DeepSeek-V4-Pro-0813 | max | max | 384,000 | paid quota |

## Two search agents: explore vs research

| Agent | Model | Spawned by | Use case |
|---|---|---|---|
| `explore` | Agnes (free) | Primary directly | Quick/medium lookups: file finds, single reads, definition lookups |
| `research` | DeepSeek Flash (paid) | Primary or `general`/`edit` (nested) | Very thorough: multi-file tracing, call path analysis, complex audits |

Both are read-only (edit denied). `explore` runs on free Agnes for quota
saving on simple lookups; `research` runs on DeepSeek Flash for stronger
reasoning when tracing complex call paths or doing exhaustive analysis.

The primary chooses which to spawn based on thoroughness:
- "quick" or "medium" → `explore` (Agnes, free)
- "very thorough" → `research` (DeepSeek, paid)

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.2 (orchestrator)**: 65K thinking / 73K output — max deep reasoning,
  concise ~8K visible response.
- **DeepSeek-V4-Flash (sub-orchestrator + research)**: `reasoningEffort: max`
  / 32K output — deep reasoning for task decomposition and code tracing.
- **agnes-2.5-flash variant:explore (quick lookups)**: 2K thinking / 65K
  output — light reasoning, full output for findings.
- **agnes-2.5-flash variant:edit (code edits)**: 8K thinking / 65K output —
  4x deeper reasoning for code changes. Full output for large patches.
- **DeepSeek-V4-Pro (small_model)**: `reasoningEffort: max` / 384K output —
  max reasoning for high-quality compaction summaries.

## How variants work

The Agnes API only knows one model ID: `agnes-2.5-flash`. We register it once
in `opencode.json` with **named variants** — each variant sets a different
thinking budget. The agent `.md` files select which variant to use via
`variant: <name>` in their YAML frontmatter:

```yaml
model: agnes/agnes-2.5-flash
variant: explore    # 2,048 thinking tokens
# or
variant: edit       # 8,192 thinking tokens
```

## What small_model does (and doesn't)

`small_model` handles opencode's internal background tasks - most importantly
**compaction summaries**. It does **NOT** handle session titles (overridden by
`agents/title.md` → Agnes), exploration, edits, or orchestration.

## How nesting + parallelization works

1. Primary receives the request and delegates the GOAL to `general`.
   The primary NEVER spawns `edit` directly.
2. `general` plans: breaks the goal into precise edit steps with exact file
   paths. Its own edit/bash tools are permission-denied.
3. `general` spawns `edit` subagents (free Agnes) — parallel for independent
   files, single call for same-file/overlapping edits.
4. `general` spawns `research` subagents (DeepSeek) for deep lookups.
5. After parallel edits return, one `edit` subagent builds/verifies.
6. `subagent_depth: 2` allows one nesting level; research has no task
   permission, so recursion hard-stops at depth 2.

## Subsession title tags

`[✏️Edit]`, `[🔎Explore]`, `[🤖Coordinate]`, `[🔬Research]`. Primary not tagged.

## Verify

```powershell
opencode agent list
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=edit'
# expect: providerID=agnes modelID=agnes-2.5-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=explore'
# expect: providerID=agnes modelID=agnes-2.5-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=research'
# expect: providerID=openference modelID=DeepSeek-V4-Flash-0731
```
