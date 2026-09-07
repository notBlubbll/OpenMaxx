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
   `hypercharm` (https://hyper.charm.land/v1), plus IFM/camelai/airouter if used.
2. Copy this repo over `%USERPROFILE%\.config\opencode\` (Windows).
3. Requires OpenCode V2 (`subagent` tool). Restart opencode after any change.

## Routing

| Role | Model |
|---|---|
| primary (orchestration) | hypercharm/glm-5.3-flash |
| detective (research orchestrator) | hypercharm/qwen3.8-flash |
| research-worker (parallel lookups) | agnes-research/agnes-3.0-flash |
| coordinator (implementation orchestrator) | hypercharm/qwen3-next-80b-a3b-instruct |
| edit (code edits + builds) | agnes-execute/agnes-3.0-flash |
| research (fallback only) | agnes-research/agnes-3.0-flash |
| explore (nested lookups) | agnes-research/agnes-3.0-flash |
| titles / compaction | hypercharm/gpt-oss-120b / hypercharm/glm-5.3 |
| findings saving | write_findings tool (local, zero cost) |

```
Primary (hypercharm/glm-5.3-flash)      receives request, routes ALL research to detective
  ├── detective (hypercharm/qwen3.8-flash)   research orchestrator
  │   └── research-worker (agnes-research/agnes-3.0-flash)   parallel lookups
  ├── coordinator (hypercharm/qwen3-next-80b-a3b-instruct)   plans + delegates, cannot edit/shell
  │   ├── edit (agnes-execute/agnes-3.0-flash)   applies edits + builds
  │   └── research (agnes-research/agnes-3.0-flash)   fallback for gaps only
  └── explore (agnes-research/agnes-3.0-flash)   nested lookups inside edit
```

Rules that matter: primary never spawns `edit`, never researches itself.
Coordinator can't edit — it only plans and delegates. Workers save findings
to `.opencode-findings/` and return path + one-line summary.

## Proxies (all inline, no extra processes)

- `tinyproxy` (:17300) forwards HyperCharm traffic, `agnes-proxy` (:8090)
  rotates Agnes keys. Both forward the Bearer header and route through Sleev
  when its gateway is up, direct otherwise.
- `sleev-gateway` plugin manages the Sleev gateway (:17321, compresses
  history to save tokens). Quirk: the gateway strips leading `/v1` from the
  request path, so `sleeve-base-url` must include `/v1`.

## Layout

```
~/.config/opencode/
├── opencode.json        # providers, agents, permissions, MCP servers
├── agents/              # research, research-worker, detective, edit, coordinator, explore, title
├── plugins/            # tinyproxy, agnes-proxy, sleev-gateway, write-findings, edit-tool-fix, grep-fix, rg-fix, mind-automation, task-args-fixer
├── findings-mcp.cjs    # write_findings as MCP server (reaches subagents; plugin version is the fallback)
├── tools/              # edit-ops.js (batch edits), write.js (schema-safe write)
└── instructions/       # AGENTS.md reference copy (V2 loads root AGENTS.md)
```

Plugin fixes worth knowing: `edit-tool-fix` fuzzy-matches oldString
(whitespace/line-endings); `rg-fix` normalizes Windows globs to forward
slashes and promotes bare `rg --files path/**` to `--glob`; `grep-fix`
validates regex balance. Findings also exist as MCP tool
`findings_write_findings` because plugin tools don't propagate to subagents.

## Verify

```powershell
opencode agent list
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' |
  Select-String 'agent=edit'
# expect: providerID=agnes-execute modelID=agnes-3.0-flash
```

Subagent sessions are title-tagged ([Edit], [Coordinate], [Research],
[Detective], [Explore]) for easy identification.

## Data note

Edits and research run on Agnes AI and HyperCharm — review their terms for
training-data policies. Mind MCP memory is optional and off by default.

> **NOTE:** All API keys in this snapshot are REDACTED placeholders (opencode.json apiKey fields and plugins/agnes-proxy AGNES_KEYS). Pruned providers not referenced by the live setup: airouter, camelai, freebuff, ifm, synthetic, xkiro. Restore real values from ~/.config/opencode when deploying.
