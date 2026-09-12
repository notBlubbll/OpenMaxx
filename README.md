# OpenMaxx — multi-model subagent setup for OpenCode

Routes each kind of work to the cheapest model that can do it well: paid
models orchestrate, free-tier models search and edit. The primary agent never
touches code — research fans out through detective, implementation flows
through coordinator, and every finding lands on disk via a deterministic tool.

Detective:

<img width="290" height="108" alt="image" src="https://github.com/user-attachments/assets/6422c671-440c-4a8a-88b0-3a79b0efcac3" />

Researching:

<img width="377" height="160" alt="image" src="https://github.com/user-attachments/assets/213e28da-c8ea-4a07-bd7e-42adc7d8fcd8" />

Editing:

<img width="298" height="107" alt="image" src="https://github.com/user-attachments/assets/4485f9ec-571a-4c5f-821a-149fa089a3eb" />

## Quick start

1. Add API keys in `opencode.json`: `agnes-research` + `agnes-execute`
   (https://apihub.agnes-ai.com/v1, separate keys for reads vs writes),
   `hypercharm` (https://hyper.charm.land/v1), `commandcode`.
2. Copy this repo over `%USERPROFILE%\.config\opencode\` (Windows).
3. Requires OpenCode V2 (`subagent` tool). Restart opencode after any change.

## Routing

| Role | Model |
|---|---|
| primary (orchestration) | hypercharm/glm-5.3-flash |
| detective (research orchestrator) | hypercharm/qwen3.8-flash |
| research-worker (parallel lookups) | commandcode/meta/muse-spark-1.3-contributor |
| coordinator (implementation orchestrator) | hypercharm/deepseek-v4.1-flash#high |
| edit (code edits + builds) | commandcode/meta/muse-spark-1.3-contributor |
| research (fallback only) | commandcode/meta/muse-spark-1.3-contributor |
| explore (nested lookups) | commandcode/meta/muse-spark-1.3-contributor |
| titles | hypercharm/gpt-oss-120b |
| findings saving | write_findings tool (local, zero cost) |

```
Primary (hypercharm/glm-5.3-flash)      receives request, routes ALL research to detective
  ├── detective (hypercharm/qwen3.8-flash)   research orchestrator
  │   └── research-worker (commandcode/meta/muse-spark-1.3-contributor)   parallel lookups
     ├── coordinator (hypercharm/deepseek-v4.1-flash#high)   plans + delegates, cannot edit/shell
  │   ├── edit (commandcode/meta/muse-spark-1.3-contributor)   applies edits + builds
  │   └── research (commandcode/meta/muse-spark-1.3-contributor)   fallback for gaps only
  └── explore (commandcode/meta/muse-spark-1.3-contributor)   nested lookups inside edit
```

Rules that matter: primary never spawns `edit`, never researches itself.
Coordinator can't edit — it only plans and delegates. Workers save findings
to `.opencode-findings/` and return path + one-line summary.

## Proxies (all inline, no extra processes)

- `tinyproxy` (:17300) forwards HyperCharm AND CommandCode traffic (all four providers point at 127.0.0.1:17300/v1), `agnes-proxy` (:8090)
  rotates Agnes keys. Both forward the Bearer header and route through Sleev
  when its gateway is up, direct otherwise.
- `sleev-gateway` plugin manages the Sleev gateway (:17321, compresses
  history to save tokens). Quirk: the gateway strips leading `/v1` from the
  request path, so `sleeve-base-url` must include `/v1`.

## Layout

```
~/.config/opencode/
├── AGENTS.md            # global instructions
├── opencode.json        # providers, agents, permissions, MCP servers
├── cli.json             # CLI metadata
├── package.json         # tooling metadata
├── agents/              # research, research-worker, detective, edit, coordinator, explore, title
├── plugins/            # tinyproxy, agnes-proxy, sleev-gateway, edit-tool-fix, grep-fix, rg-fix, mind-automation, task-args-fixer, sse-toolcall-fix.js, zen-responses.js, k2-reasoning-proxy.js
├── mcp/                 # findings-mcp.cjs (write_findings MCP server, reaches subagents)
├── tools/              # edit-ops.js (batch edits), write.js (schema-safe write)
├── skills/mind-management/ # memory protocol skill
└── instructions/       # AGENTS.md + mind-memory-protocol.md + opencode-v1-v2-setup.md
```

Plugin fixes worth knowing: `edit-tool-fix` fuzzy-matches oldString
(whitespace/line-endings); `rg-fix` normalizes Windows globs to forward
slashes and promotes bare `rg --files path/**` to `--glob`; `grep-fix`
validates regex balance. `sse-toolcall-fix.js` repairs SSE tool-call framing
shared by tinyproxy/agnes-proxy; `zen-responses.js` normalizes Zen-style responses.
Findings also exist as MCP tool `findings_write_findings` because plugin tools don't propagate to subagents.

## Verify

```powershell
opencode agent list
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' |
  Select-String 'agent=edit'
# expect: providerID=commandcode modelID=meta/muse-spark-1.3-contributor
```

Subagent sessions are title-tagged ([Edit], [Coordinate], [Research],
[Detective], [Explore]) for easy identification.

## Data note

Edits and research run on CommandCode; heavy agents on HyperCharm — review their terms for
training-data policies. Mind MCP memory is optional and off by default.

> **NOTE:** All API keys in this snapshot are REDACTED placeholders (opencode.json apiKey fields - hypercharm and commandcode included - and plugins/agnes-proxy AGNES_KEYS). The hypercharm model list is glm-5.3-flash (default), deepseek-v4.1-flash (coordinator), qwen3.8-flash (detective), gpt-oss-120b (titles), plus the 5 catalog extras (deepseek-v4-pro-0813, deepseek-v4-flash, glm-5.3, qwen3-next-80b-a3b-instruct, gemma-4-26b-a4b-it). Pruned providers not referenced by the live setup: airouter, camelai, freebuff, ifm, synthetic, xkiro. Restore real values from ~/.config/opencode when deploying.
