# opencode multi-model subagent setup

Routes opencode work across providers by cost: free Qwen3.8-Flash-Next (HF
endpoint) for ALL searching AND findings-writes, paid GLM-5.3-Flash
for coordination reasoning, paid GLM-5.3-Flash for primary orchestration and
high-stakes detective research (max thinking). GLM-5.3-Flash routes via the
OpenAI-compatible SDK (`openference` provider) against the OpenFerence
`/v1/chat/completions` endpoint using Bearer auth; Qwen3.8-Flash-Next routes via a
free Hugging Face inference endpoint (`qwen-hf` provider).

# tree example

Detective:

<img width="290" height="108" alt="image" src="https://github.com/user-attachments/assets/6422c671-440c-4a8a-88b0-3a79b0efcac3" />

Researching:

<img width="377" height="160" alt="image" src="https://github.com/user-attachments/assets/d59e9716-a441-4316-9480-0547c4f2ae88" />

Editing:

<img width="298" height="107" alt="image" src="https://github.com/user-attachments/assets/4485f9ec-571a-4c5f-821a-149fa089a3eb" />


## Get API keys

**OpenFerence** — sign up with this referral link to get **$5 credit**:
https://openference.com/register?ref=JTVJHCYR

**Hugging Face** — the Qwen3.8-Flash-Next endpoint is a free HF inference
endpoint; no API key required (`apiKey: "not-needed"` in `qwen-hf`).

Then set environment variables:

```
OPENFERENCE_API_KEY=...
```

## OpenAI-Compatible SDK on OpenFerence (stability)

GLM-5.3-Flash (primary + detective) routes
via the openference provider using @ai-sdk/openai-compatible against the
OpenFerence /v1/chat/completions endpoint with Bearer auth.

The OpenAI-compatible SDK handles streaming responses cleanly and returns
usage fields natively.

The openference provider (OpenAI-compatible SDK) is used for all GLM and
DeepSeek models. The free qwen-hf provider (OpenAI-compatible SDK against a
Hugging Face free inference endpoint) handles all searching and findings-writes.


## Layout

```
~/.config/opencode/
├── opencode.json
├── agents/
│   ├── research.md     # deep search -> qwen-hf/Qwen3.8-Flash-Next variant:research (free, read-only, spawns summarizer)
    │   ├── detective.md  # complex research -> GLM-5.3-Flash variant:max (paid, max thinking, spawns research workers) [OpenAI-compatible SDK via openference provider]
│   ├── summarizer.md   # writes findings to disk -> qwen-hf/Qwen3.8-Flash-Next variant:explore (free, write-only)
│   ├── edit.md         # code edits + shell/builds -> agnes/agnes-2.5-flash variant:edit (free)
│   ├── coordinator.md    # sub-orchestrator -> GLM-5.3-Flash; plans + delegates, cannot edit/bash itself [OpenAI-compatible SDK via openference provider]
│   └── title.md        # session titles -> agnes-2.5-flash variant:explore (free)  [overrides small_model]
└── instructions/
    └── AGENTS.md       # delegation rules injected into every session
```

Copy the files to `%USERPROFILE%\.config\opencode\` (Windows) or `~/.config/opencode/`.

Requires **opencode >= 1.18** (`subagent_depth`). Restart opencode after any change.

## Architecture

```
Primary (GLM-5.3-Flash, paid, openference provider)          receives request, delegates GOAL
  ├── research (Qwen3.8-Flash-Next, free)      trivial single-file lookups only
  │   └── summarizer (Qwen3.8-Flash-Next, free)     writes findings to disk
  ├── detective (GLM-5.3-Flash, paid, max thinking)    complex multi-file research (PREFERRED for lookups) [OpenAI-compatible SDK]
  │   └── research (Qwen3.8-Flash-Next, free)      spawns workers for parallel search
  │       └── summarizer (Qwen3.8-Flash-Next, free)     writes findings to disk
  └── coordinator (GLM-5.3-Flash, paid)    sub-orchestrator: plans, sequences, fans out [OpenAI-compatible SDK]
      ├── edit (Agnes, free)     applies edits + builds (parallel if independent)
      └── research (Qwen3.8-Flash-Next, free) deep code tracing inside coordinator sessions
          └── summarizer (Qwen3.8-Flash-Next, free)     writes findings to disk
```

The primary NEVER spawns `edit` directly — ALL edits go through `coordinator`.
The primary spawns `detective` for multi-file lookups (PREFERRED) and `research` for trivial single-file reads only.
The `general` agent is also restricted (edit/bash/glob/grep deny, task: {research, edit} allow) as defense-in-depth — the primary should spawn `coordinator` per project rules, but if it accidentally spawns `general` (per global rules), the same deny block applies and prevents direct edits.

## Why this routing

The split is by cost, with one principle: the free tier handles all the
search work, paid models only do reasoning and orchestration.

- **Qwen3.8-Flash-Next (free, HF endpoint) for ALL searching and ALL
  findings-writes**: research deep-dives, summarizer file-writes. These
  are the bulk of the lookup work, so keeping them on the free tier keeps
  costs near zero. Code edits still go to Agnes (free) via the `edit` agent.

- **GLM-5.3-Flash (paid) for coordination**: task decomposition, edit sequencing,
  parallel fan-out planning — the strongest reasoning model for the job that
  determines the quality of all downstream work.

- **GLM-5.3-Flash (paid) for detective work**: the detective agent coordinates complex multi-file research with max thinking — high-stakes, a missed research path degrades everything after it.
- **GLM-5.3-Flash (paid) for primary orchestration + compaction (small_model)**: the primary agent receives requests and delegates goals, and small_model handles compaction summaries. GLM-5.3-Flash has 1M context and 128K output, making it ideal for high-context orchestration and high-stakes compaction. Explicitly pinned so small_model never inherits a different host session model.

## Design principle: permission-enforced rules

Rules stated in `AGENTS.md` are text — they compete for attention with growing
history and can silently stop firing. The strongest rules in this setup are NOT
text: they are **permission-denied** in `opencode.json`, so they cannot decay:

- **Primary cannot edit/search/bash**: permission denies `edit`, `glob`,
  `grep`, `bash` — the primary physically cannot do implementation work, only
  delegate.
- **Primary cannot spawn `edit`**: `task` allows only `coordinator`, `research`, and `detective` — `edit` is absent, so the primary cannot bypass the coordinator.
- **`coordinator` cannot edit/bash**: denied in its own permission block — it can
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
| main (orchestration) | openference/GLM-5.3-Flash | max | 65,536 | 128,000 | paid quota |
| coordinator (sub-orchestrator) | openference/GLM-5.3-Flash | max | 65,536 | 384,000 | paid quota |
| edit (ALL code edits + shell/builds) | agnes/agnes-2.5-flash | edit | 8,192 | 65,536 | free |
| research (deep search, all lookups) | qwen-hf/Qwen3.8-Flash-Next | research | medium | 65,536 | free |
| detective (complex research coord) | openference/GLM-5.3-Flash | max | 65,536 | 128,000 | paid quota |
| summarizer (writes findings files) | qwen-hf/Qwen3.8-Flash-Next | explore | low | 65,536 | free |
| session titles | agnes/agnes-2.5-flash | explore | 2,048 | 65,536 | free |
| small_model (compaction summaries) | openference/GLM-5.3-Flash | max | 65,536 | 128,000 | paid quota |

## Thinking and output tuning

Each model is tuned for its workload by balancing **thinking budget** (reasoning
tokens the model spends before responding) against **output limit** (total
tokens available for the response including thinking):

- **GLM-5.3-Flash (primary + small_model)**: 1M context / 128K output — large context for orchestration, delegation decisions, and high-stakes compaction summaries. Paid tier. Variants: max (65K thinking), high (32K), medium (16K), low (8K).
- **GLM-5.3-Flash (detective)**: 65K thinking / 128K output — max deep reasoning for complex multi-file research coordination.
- **GLM-5.3-Flash (sub-orchestrator)**: 65K thinking / 384K output — deep
  reasoning for task decomposition, full delegation output.
- **Qwen3.8-Flash-Next variant:explore (summarizer)**: low reasoning effort / 65K
  output — light reasoning, full output for findings file-writes.
- **Qwen3.8-Flash-Next variant:research (deep search)**: medium reasoning effort /
  65K output — balanced reasoning for tracing call paths across files.
- **agnes-2.5-flash variant:edit (code edits)**: 8K thinking / 65K output —
  4x deeper reasoning than explore for code changes. Full output for patches.
- **GLM-5.3-Flash (small_model)**: 128K output — compaction summaries on a high-context model. Explicitly pinned so it never inherits the host session model.
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
  coordinator models

Rationale: compaction is rare but high-stakes (a lossy summary degrades everything after it), so it gets GLM-5.2 — paid, with 1M context headroom and explicitly pinned so it never inherits the host session model. Titles are frequent but trivial, so they go to the free Agnes tier. Searching and findings-writes go to the free Qwen3.8-Flash-Next HF endpoint.

## How nesting + parallelization works

1. Primary receives the request and delegates the GOAL to `coordinator`
   (sub-orchestrator). The primary NEVER spawns `edit` directly — ALL edits
   go through `coordinator`. The primary spawns `detective` for multi-file lookups and `research` for trivial single-file reads.
2. `coordinator` (paid GLM-5.3-Flash) plans the implementation: breaks the goal into
   precise edit steps with exact file paths, and sequences the work. Its own
   edit/bash tools are permission-denied, so it can ONLY delegate.
3. `coordinator` spawns `edit` subagents (free Agnes) to apply each change. For
   INDEPENDENT edits (different files / non-overlapping regions), it issues
   MULTIPLE `edit` spawns in ONE message (parallel). Same-file/overlapping
   edits stay in a single call to avoid write conflicts.
4. `coordinator` spawns `research` subagents (free Agnes) for any lookups it needs,
   also parallelized when independent.
5. After parallel edits return, one `edit` subagent builds/verifies the
   combined result.
6. `subagent_depth: 3` allows deeper nesting; research has no task
   permission, so recursion hard-stops at depth 2.
7. Pre-explore discipline: primary may front-load exploration via a `detective`
   spawn (which fans out research workers) before delegating to `coordinator`,
   so the goal already contains exact paths and context.

## Snippet proof (verification, not enforcement)

Findings files from `research` must include a verbatim 1-3 line
quote from each cited `file:line` reference. This proves the subagent actually
read the file rather than confabulating a plausible-sounding reference. The
caller can grep the quoted string to verify. This is the cheapest verification
that survives compaction — it lives in the findings file on disk, not in
history that gets summarised.

The one-line summary from subagents ends with "READ BEFORE ACTING" as a
per-turn reminder that survives in history. The caller (primary or coordinator)
is instructed to read the findings file via the Read tool before acting on
any edit decision. This is text-mediated — it can decay in long sessions —
but the reminder is fresh on every turn because it's in the response, not
just in the injected instructions.

## Subsession title tags

Subagent sessions are tagged in their title for easy identification:
`[✏️Edit]`, `[🤖Coordinate]`, `[🔎Research]`, `[🕵🏼‍♂️Detective]`, `[💭Summarizer]`. Primary sessions are not tagged.

## Data retention note

All code editing in this setup runs on **Agnes 2.5 Flash** (free tier); all
searching and findings-writes run on **Qwen3.8-Flash-Next** (free HF endpoint).
Before pointing this at a private repository, review Agnes AI's data-retention
and training-usage terms at https://agnes-ai.com/ and Hugging Face's terms for
the Qwen endpoint, to confirm whether API inputs
are stored or used for model training. The paid models (GLM-5.3-Flash for primary + detective + coordination) run through OpenFerence — review their
terms separately.

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

- Main model: GLM-5.3-Flash (current)
- Coordinator (sub-orchestrator): GLM-5.3-Flash (upgraded from DeepSeek-V4-Pro-0813)
- Detective: GLM-5.3-Flash (max thinking, coordinates research workers)
- Research + Summarizer: Qwen3.8-Flash-Next via free HF endpoint (current, was Agnes)

## Verify

```powershell
opencode agent list
# run a task, then check routing in the log:
Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String
'agent=coordinator'
# expect: providerID=openference modelID=GLM-5.3-Flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=edit'
# expect: providerID=agnes modelID=agnes-2.5-flash

Select-String "$env:USERPROFILE\.local\share\opencode\log\opencode.log" -Pattern 'message=stream' | Select-String 
'agent=research'
# expect: providerID=agnes modelID=agnes-2.5-flash
```
