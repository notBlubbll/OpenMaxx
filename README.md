# opencode multi-model subagent setup

Repo: [notBlubbll/OpenMaxx](https://github.com/notBlubbll/OpenMaxx)

Routes opencode work across providers by cost and role: GLM-5.3-Flash (hypercharm, 1M context)
for primary orchestration and detective; **airouter** (api.airouter.ch) for research + execution (api.airouter.ch) for the executors — Agnes 2.5 Flash for research (HIGH reasoning), Qwen-3.8-27B for edits (LOW, fast); Qwen3 Next 80B-A3B Instruct (hypercharm) for the implementation coordinator with LOW reasoning for rapid dispatch; GLM-5.3 (hypercharm flagship) for compaction; hypercharm/gpt-oss-120b for session
titles. Findings are saved directly via the deterministic write_findings custom tool (no subagent,
no LLM).

# tree example

Detective:

<img width="290" height="108" alt="image" src="https://github.com/user-attachments/assets/6422c671-440c-4a8a-88b0-3a79b0efcac3" />

Researching:

<img width="377" height="160" alt="image" src="https://github.com/user-attachments/assets/d59e971a-440c-4a8a-88b0-3a79b0efcac3" />

Editing:

<img width="298" height="107" alt="image" src="https://github.com/user-attachments/assets/4485f9ec-571a-4c5f-821a-149fa089a3eb" />


## Get API keys

**AI Router (executers: research + edit)** — get your key from your AI Router account and set
it in `opencode.json` under `provider.airouter.options.apiKey` (baseURL
`https://api.airouter.ch/v1`). Models: `Qwen3.8` (Qwen-3.8-27B) and `DeepSeek-V4-Flash` (DeepSeek-V4-Flash-0731).

**HyperCharm** — set your key in `opencode.json` under `provider.hypercharm.options.apiKey`
(baseURL `https://hyper.charm.land/v1`). Models: `glm-5.3-flash` (primary + detective), `qwen3-next-80b-a3b-instruct` (coordinator), `glm-5.3` (compaction, flagship), and `gpt-oss-120b` (titles — HyperCharm's low tier, trivially cheap).

## OpenAI-Compatible SDK (stability)

GLM-5.3-Flash (primary + detective) routes via the `hypercharm` provider; Agnes 2.5 Flash (research) routes via the `airouter` provider; Agnes 2.5 Flash (edit) routes via the `airouter` provider; qwen3-next-80b-a3b-instruct (coordinator), glm-5.3 (compaction) and gpt-oss-120b (titles) route via the `hypercharm` provider; agnes-research/agnes-2.5-flash (explore) points at the apihub.agnes-ai.com endpoint.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The `airouter` provider serves the executer (edit). The `hypercharm` provider serves the primary, detective, coordinator, small_model and titles. The `agnes-research` provider serves research and explore.


## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── research.md       # deep search -> agnes-research/agnes-2.5-flash#research (LOW reasoning, fast, saves via write_findings)
│   ├── research-worker.md # parallel lookups -> agnes-research/agnes-2.5-flash#research-worker (LOW reasoning)
│   ├── detective.md      # research orchestrator -> hypercharm/glm-5.3-flash (HIGH reasoning, spawns research-worker)
│   ├── edit.md           # code edits + shell/builds -> agnes-execute/agnes-2.5-flash#edit (LOW reasoning, fast, edit tool)
│   ├── coordinator.md    # implementation orchestrator -> hypercharm/qwen3-next-80b-a3b-instruct (LOW reasoning); plans + delegates, cannot edit/shell itself
│   └── title.md          # session titles -> hypercharm/gpt-oss-120b  [overrides small_model]
├── tools/            # edit-ops.js (batch file edits), write.js (schema-safe write override)
├── plugins/          # write-findings/, edit-tool-fix/, grep-fix/, mind-automation/, task-args-fixer/ (V2 native)
│   ├── write-findings/index.js
│   ├── edit-tool-fix/index.js
│   ├── grep-fix/index.js
│   ├── mind-automation/index.js
│   ├── task-args-fixer/index.js
│   ├── k2-reasoning-proxy.js
│   └── .opencode-backups/
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode2** (OpenCode V2, `subagent` tool with `agent`/`description`/`prompt`). Restart opencode after any change.

## Architecture

```
Primary (hypercharm/glm-5.3-flash, variant:high)      receives request, routes ALL research to detective
  ├── detective (hypercharm/glm-5.3-flash, high thinking)   research orchestrator (PREFERRED for lookups) [hypercharm]
  │   └── research-worker (airouter/DeepSeek-V4-Flash, variant:research-worker)   parallel research workers (LOW reasoning) [airouter]
  ├── coordinator (hypercharm/qwen3-next-80b-a3b-instruct, variant:low)   implementation orchestrator: plans + delegates, cannot edit/shell itself [hypercharm]
  │   ├── edit (airouter/Qwen3.8)     applies edits via edit tool + builds
  │   └── research (agnes-research/agnes-2.5-flash#research, variant:low) ONLY as fallback for gaps in detective findings
  └── explore (agnes-research/agnes-2.5-flash#explore)     nested lookups inside edit [agnes-research]
```

The primary NEVER spawns `edit` directly — ALL edits go through `coordinator`.
The primary spawns `detective` for ALL research needs. `research-worker` is the detective's fan-out for parallel lookups. `research` is the coordinator's fallback for gaps in detective findings — never a primary tool.

## Plugin Setup

The plugins directory uses the V2 subdirectory structure. Each plugin lives in its own folder with an `index.js` entrypoint:

- **write-findings/** — Custom tool that writes findings to `.opencode-findings/` without spawning a subagent
- **edit-tool-fix/** — Normalizes paths and line endings before edit execution
- **grep-fix/** — Fixes invalid `include` parameter shapes in grep calls
- **mind-automation/** — V2 event subscription for mind CLI checkpoint automation
- **task-args-fixer/** — V2 no-op stub (V2 native schema)
- **k2-reasoning-proxy.js** — Plugin that autostarts the k2-proxy standalone server on port 8089

The standalone `k2-proxy-server-standalone.js` is kept in `.opencode-backups/` to avoid being auto-loaded as a broken plugin.






