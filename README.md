# opencode multi-model subagent setup

Repo: [notBlubbll/OpenMaxx](https://github.com/notBlubbll/OpenMaxx)

Routes opencode work across providers by cost and role: GLM-5.3-Flash (hypercharm, 1M context)
for primary orchestration and detective; **agnes-research** (apihub.agnes-ai.com) for research; **airouter** (api.airouter.ch) for the executors â€” DeepSeek-V4-Flash for research workers, Qwen-3.8-27B for code edits; Qwen3 Next 80B-A3B Instruct (hypercharm) for the implementation coordinator with LOW reasoning for rapid dispatch; GLM-5.3 (hypercharm flagship) for compaction; hypercharm/gpt-oss-120b for session
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

**AI Router (executers: edit)** â€” get your key from your AI Router account and set
it in `opencode.json` under `provider.airouter.options.apiKey` (baseURL
`https://api.airouter.ch/v1`). Models: `Qwen3.8` (Qwen-3.8-27B).

**HyperCharm** â€” set your key in `opencode.json` under `provider.hypercharm.options.apiKey`
(baseURL `https://hyper.charm.land/v1`). Models: `glm-5.3-flash` (primary + detective), `qwen3-next-80b-a3b-instruct` (coordinator), `glm-5.3` (compaction, flagship), and `gpt-oss-120b` (titles â€” HyperCharm's low tier, trivially cheap).

## OpenAI-Compatible SDK (stability)

GLM-5.3-Flash (primary + detective) routes via the `hypercharm` provider; agnes-2.5-flash (research) routes via the `agnes-research` provider; Qwen3.8 (edit) routes via the `airouter` provider; qwen3-next-80b-a3b-instruct (coordinator), glm-5.3 (compaction) and gpt-oss-120b (titles) route via the `hypercharm` provider; agnes-research/agnes-2.5-flash (explore) points at the apihub.agnes-ai.com endpoint.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The `airouter` provider serves the executer (edit). The `hypercharm` provider serves the primary, detective, coordinator, small_model and titles. The `agnes-research` provider serves research and explore.


## Layout

```
~/.config/opencode/
â”œâ”€â”€ opencode.json
â”œâ”€â”€ agents/
â”‚   â”œâ”€â”€ research.md       # deep search -> agnes-research/agnes-2.5-flash#research (HIGH reasoning, saves via write_findings)
â”‚   â”œâ”€â”€ research-worker.md # parallel lookups -> airouter/DeepSeek-V4-Flash#research-worker (LOW reasoning)
â”‚   â”œâ”€â”€ detective.md      # research orchestrator -> hypercharm/glm-5.3-flash (HIGH reasoning, spawns research-worker)
â”‚   â”œâ”€â”€ edit.md           # code edits + shell/builds -> airouter/Qwen3.8#edit (MEDIUM reasoning, edit tool)
â”‚   â”œâ”€â”€ coordinator.md    # implementation orchestrator -> hypercharm/qwen3-next-80b-a3b-instruct (LOW reasoning); plans + delegates, cannot edit/shell itself
â”‚   â””â”€â”€ title.md          # session titles -> hypercharm/gpt-oss-120b  [overrides small_model]
â”œâ”€â”€ tools/            # edit-ops.js (batch file edits), write.js (schema-safe write override)
â”œâ”€â”€ plugins/          # write-findings/, edit-tool-fix/, grep-fix/, mind-automation/, task-args-fixer/ (V2 native)
â”‚   â”œâ”€â”€ write-findings/index.js
â”‚   â”œâ”€â”€ edit-tool-fix/index.js
â”‚   â”œâ”€â”€ grep-fix/index.js
â”‚   â”œâ”€â”€ mind-automation/index.js
â”‚   â”œâ”€â”€ task-args-fixer/index.js
â”‚   â”œâ”€â”€ k2-reasoning-proxy.js
â”‚   â””â”€â”€ .opencode-backups/
â””â”€â”€ instructions/
    â””â”€â”€ AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode2** (OpenCode V2, `subagent` tool with `agent`/`description`/`prompt`). Restart opencode after any change.

## Architecture

```
Primary (hypercharm/glm-5.3-flash, variant:high)      receives request, routes ALL research to detective
  â”œâ”€ detective (hypercharm/glm-5.3-flash, high thinking)   research orchestrator (PREFERRED for lookups) [hypercharm]
  â”‚   â””â”€ research-worker (airouter/DeepSeek-V4-Flash, variant:research-worker)   parallel research workers (LOW reasoning) [airouter]
  â”œâ”€ coordinator (hypercharm/qwen3-next-80b-a3b-instruct, variant:low)   implementation orchestrator: plans + delegates, cannot edit/shell itself [hypercharm]
  â”‚   â”œâ”€ edit (airouter/Qwen3.8)     applies edits via edit tool + builds
  â”‚   â””â”€ research (agnes-research/agnes-2.5-flash#research, variant:high) ONLY as fallback for gaps in detective findings
  â””â”€ explore (agnes-research/agnes-2.5-flash#explore)     nested lookups inside edit [agnes-research]
```

The primary NEVER spawns `edit` directly â€” ALL edits go through `coordinator`.
The primary spawns `detective` for ALL research needs. `research-worker` is the detective's fan-out for parallel lookups. `research` is the coordinator's fallback for gaps in detective findings â€” never a primary tool.

## Plugin Setup

The plugins directory uses the V2 subdirectory structure. Each plugin lives in its own folder with an `index.js` entrypoint:

- **write-findings/** â€” Custom tool that writes findings to `.opencode-findings/` without spawning a subagent
- **edit-tool-fix/** â€” Normalizes paths and line endings before edit execution
- **grep-fix/** â€” Fixes invalid `include` parameter shapes in grep calls
- **mind-automation/** â€” V2 event subscription for mind CLI checkpoint automation
- **task-args-fixer/** â€” V2 no-op stub (V2 native schema)
- **k2-reasoning-proxy.js** â€” Plugin that autostarts the k2-proxy standalone server on port 8089

The standalone `k2-proxy-server-standalone.js` is kept in `.opencode-backups/` to avoid being auto-loaded as a broken plugin.

