# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Agnes for all searching,
paid DeepSeek only for code edits, free gateway for orchestration.

## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── explore.md      # all searching -> agnes-2.5-flash (free)
│   ├── general.md      # edits/shell -> DeepSeek-V4-Flash; delegates search to explore
│   └── title.md        # session titles -> agnes-2.5-flash (free)
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

## How it works

1. Primary agent = orchestrator only. All edit/read/search/shell work goes through Task subagents.
2. `general` (DeepSeek Flash, paid quota) executes edits and commands.
3. All searching lands on `explore` (Agnes, free) - top-level AND nested:
   - `subagent_depth: 2` allows one nesting level
   - `permission.task.explore: allow` on general keeps the Task tool inside subagents
   - explores have no task permission -> recursion hard-stops at depth 2
4. Pre-explore discipline: primary front-loads exploration and hands general exact paths, so paid searches approach zero.

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 'agent=explore'
# expect: providerID=agnes modelID=agnes-2.5-flash
```
