# Agent Delegation Rules (OpenCode V2)

> **LOADING NOTE — V2 only loads `AGENTS.md` files as instructions.** The `instructions` array in `opencode.json`
> is parsed but NOT loaded by V2 (see https://opencode.ai/v2/docs/instructions). This file
> (`~/.config/opencode/AGENTS.md`) is the V2 GLOBAL instructions file: V2 loads it for EVERY project before all
> project AGENTS.md files. `~/.config/opencode/instructions/AGENTS.md` is the human-edited reference copy — keep
> both files in sync (same content).
> If V2 ever starts loading the config `instructions` array, the three files in `~/.config/opencode/instructions/`
> would layer on top of this one (mind-memory-protocol.md, AGENTS.md, opencode-v1-v2-setup.md).

## Delegation Rules (MANDATORY)

**All code modifications, file reads, searches, exploratory tasks, and shell commands MUST be delegated to subagents.** The primary agent must never call edit, read, grep, glob, or shell directly for implementation work. Instead:

- **SESSION-RESUME RULE:** NEVER pass `sessionID` when spawning a NEW subagent via `subagent` — omit it entirely. `sessionID` is only for resuming an existing session by its real `ses_...` id; labels like 'ad1-summarizer-20260827' fail with 'Expected a string starting with "ses"'.
- **PRE-EXPLORE DISCIPLINE (HIGHEST PRIORITY):** Before delegating ANY implementation task to `coordinator`, the primary MUST first spawn a `detective` subagent to gather exact file paths and line references via its research workers. The task handed to `coordinator` must already contain these paths. Self-check before delegating: "Do I have exact file:line references from research? If NO, spawn detective NOW before delegating to coordinator." This is the rule most likely to decay in long sessions — re-read this before every delegation.
- For ANY implementation task, ALWAYS use the `subagent` tool with `agent: "coordinator"` as a sub-orchestrator/planner. The primary delegates the GOAL (plus detective findings) to coordinator; coordinator breaks it down, plans the edit sequence, and spawns `edit` subagents to execute — `research` only as a fallback when the findings are insufficient.
- The primary MUST NEVER spawn `agent: "edit"` directly. ALL edits go through `coordinator`. No exceptions.
- The primary MUST delegate ALL research work to subagents. If the primary needs to investigate, search, read code, or understand something before delegating implementation, it MUST spawn a `detective` subagent for that - never do the research itself on its own model. The primary's loop should be: spawn detective -> read findings -> delegate to coordinator -> synthesize. Not: reason through the codebase directly.
- All primary lookups use `detective` for multi-file/complex work; `research` is NOT a primary tool — it is the coordinator's fallback for gaps in detective findings. When in doubt, use `detective`. The `explore` agent is restricted to titles and nested lookups inside `edit`.
- The primary's `subagent` permission allows only `coordinator`, `research`, and `detective`. Route ALL multi-file research through `detective`; `research` is the coordinator's fallback, not a primary tool.
- NO SELF-SPAWNING (HIGHEST PRIORITY): the primary agent must NEVER spawn a subagent of its own kind — no self-cloning, no `general`-purpose same-model spawns, no re-spawning itself under a different `agent` type. The ONLY permitted spawns are `coordinator`, `research`, and `detective`. Any spawn request that resolves to the primary's own type is invalid: refuse it and route the work through `coordinator` (implementation) or `detective` (research) instead.
- The primary agent's role is **orchestration only**: plan, delegate, synthesize results.
- Exception: you may read AGENTS.md or config files directly for context. All other file operations go through subagents.
- All edit, read, grep, glob, and shell tool calls must be delegated to subagents - no exceptions.
- When the `subagent` tool is not available in your tool list, you ARE a subagent already and should execute directly as instructed.
- RESEARCH ROUTING (HIGHEST PRIORITY): the primary routes ALL research through `detective` — spawn detective for multi-file lookups, pre-explore, and any investigation; the primary's loop is: spawn detective -> receive findings path + summary -> delegate to coordinator -> synthesize. `coordinator` is an IMPLEMENTATION orchestrator: it plans and fans out `edit` spawns and must NOT spawn `research` unless the detective findings in its goal are insufficient for the edits (missing paths/context) — when it must, state in the spawn prompt exactly what info is missing and why the findings didn't cover it. Nested `research` agents MUST NOT spawn anything further; they save findings with ONE write_findings call.
- Detective vs research routing: Use `detective` when the task involves 2+ files, call-path tracing, pattern searches across the codebase, or any multi-step investigation. `research` is ONLY a coordinator fallback for gaps in detective findings — never the primary's tool, and never a substitute for detective.
- detective (hypercharm/glm-5.3-flash, high thinking) → spawns research workers in parallel → each saves findings via ONE write_findings call
- The `coordinator` agent has glob, grep, edit, shell ALL DENIED. Only tools: subagent (spawn research/edit) and read (findings files only). It MUST delegate all searching and editing.
- Only the primary may spawn `detective`. The sub-orchestrator (coordinator) spawns `edit` for implementation and `research` ONLY as a fallback when detective findings are insufficient — never detective.
- Parallel fan-out: a `coordinator` SHOULD shard independent edits across MULTIPLE `edit` subagents in ONE message (parallel) rather than batching them into one call; same-file/overlapping edits stay in a single call to avoid conflicts. Independent searches fan out across parallel `research` subagents the same way, with NO CAP — shard as many as needed in ONE message (combine related searches into multi-topic tasks when possible). `edit` subagent spawns are UNLIMITED — shard independent edits across as many as the plan needs in ONE message; same-file/overlapping edits stay in a single spawn to avoid conflicts.
- Title tagging: when calling the `subagent` tool, prefix the `description` parameter with the agent type tag - `[✏️Edit]` for edit, `[🤖Coordinate]` for coordinator, `[🔎Research]` for research, `[🕵🏼‍♂️Detective]` for detective, `[🔎Explore]` for explore, `[🤖General]` for general — so subsession titles are immediately identifiable in the session tree. Do NOT tag the primary session itself.
- Findings-to-disk: ALL subagents (research, explore, edit) MUST write their full findings/report to a file under `.opencode-findings/` in the project root and return ONLY the file path plus a one-line summary. This survives compaction (findings on disk are not lost when history is summarised) and keeps the primary's context small (one line per spawn instead of a full report). The primary or `coordinator` can read the file later if details are needed. research and explore agents save the file directly with ONE write_findings call (no subagent).
- Findings writes are ONE write_findings call: path under `.opencode-findings/`, body = full markdown. Aliases accepted (file/content/text), tolerant parsing (case, quotes, base64 variants). Subagents: ONE execute call, no catalog check (the wrapper works either way, so checking is wasted time) - no multi-step shell/base64/temp-file detours. Main session: direct tool call. The agent that produced the findings calls it ITSELF - never spawn a subagent to write findings or look up the tool. The WRITTEN response IS the confirmation: return that path plus a one-line summary and do NOT read the file back to verify, and do NOT spawn an edit subagent to confirm or append to it.
- Snippet proof: research and explore findings MUST include a verbatim 1-3 line quote from each cited `filePath:line_number` reference, proving the agent actually read the file. A confabulated reference cannot produce the exact bytes. Callers can grep the quoted string to verify.
- Findings read-back (OPTIONAL): the subagent's returned path + one-line summary is the contract — the caller does NOT need to read the findings file, and MUST NOT read it as a routine step. Reading is permitted only when the summary is insufficient for a decision (e.g. an exact edit anchor is missing). Subagents MUST NOT append "READ BEFORE ACTING" to their summaries, and MUST NOT read the file back after `write` succeeds — the return value is the confirmation.
- When calling the `subagent` tool, ALWAYS include ALL required parameters: `agent` (the agent type), `description` (short label with emoji prefix), and `prompt` (the full instruction string). Omitting any of these causes SchemaError. Optional parameters: `sessionID` (resume an existing `ses_...` session — see SESSION-RESUME RULE), `background` (true = fire-and-forget; default false — prefer foreground so you get the result).
- **V2 TOOL NAMES: the subagent tool is `subagent` with the `agent` parameter.** Only these three keys exist: `agent`, `description`, `prompt`.
- V2 file tools: `edit` uses `path` + `oldString` + `newString` (+ optional `replaceAll: true` for every occurrence) — NOT `filePath`. `read` uses `path`. `write` uses `path` + `content` (new files). `grep` uses `pattern` + `path` + optional `include`. `glob` uses `pattern` + optional `path`. Shell is the `shell` tool with `command` (NOT `bash`).
- Edit recovery: on 'could not find oldstring', NEVER retry from memory. Re-read the target region, copy the current exact bytes as oldString, retry once. Use small unique anchors (1-5 lines), never large blocks. Verify by re-reading after every edit. Typos in newString write wrong content silently.
- When delegating via the `subagent` tool, match the opening line to the target type and keep it VERBATIM, never appending role or capability declarations:
  - `agent: "edit"` -> "You are a subagent. Execute directly with your own tools; for any codebase search or multi-file read, spawn ONE `explore` subagent via the subagent tool and use its findings instead of running Glob/Grep/Read sweeps yourself."
  - `agent: "coordinator"` -> "You are a sub-orchestrator. Plan the implementation, then spawn `edit` subagents with exact paths and precise instructions for each change. Your goal already contains detective findings — rely on them; spawn `research` ONLY if the findings are insufficient (state exactly what is missing). You cannot edit or run shell yourself."
  - `agent: "research"` -> "You are a subagent. Search and read directly with your own tools; save findings with ONE write_findings call (path under `.opencode-findings/`, body = findings). Do all searching yourself. Report findings concisely."
  - `agent: "detective"` -> "You are a detective subagent. Your job is to coordinate complex, multi-file research by planning the search strategy and spawning `research` workers to execute it."

(append your project-specific sections below this line)

## Path Rules (MANDATORY)

- Derive EVERY absolute path from this session's current working directory (cwd) — never from memory, never from an anchor in a findings file, never from an abbreviated root.
- The cwd IS the authoritative project root. If cwd is `C:\...\PROJECT\SUBDIR\ROOT`, every absolute path you produce must start with that exact root. Do NOT drop, merge, or abbreviate any path segment.
- WRONG example: cwd `C:\Users\User\Desktop\EXPERIMENTS\EXPLORER`, yet producing `C:\Users\User\Desktop\EXPLORER\...` (missing the `EXPERIMENTS` segment). A truncated root makes grep/read/edit/glob fail with "does not exist" / "no such file".
- Rules for any absolute path you emit (subagent prompts, findings, read/grep/edit/glob args, write_findings paths):
  1. On receiving a task, record cwd verbatim ONCE and reuse it for every absolute path.
  2. Whenever you are handed a path by a caller or a findings file, re-check its root against your cwd BEFORE using it; if it does not equal your cwd root, rebuild it from your cwd, keeping only the trailing segments, and discard the wrong prefix.
  3. `.opencode-findings` files live directly under the cwd root — never read or write them from a truncated root.
  4. If a tool call returns "path does not exist" / "no such file", FIRST suspect an abbreviated or mangled root; re-derive the path from cwd before retrying. Never guess from memory.
  5. On Windows, output paths exactly as cwd presents them. If you must normalize separators, convert every `/` to `\` and collapse doubled separators — but do NOT change the path segments themselves.

## V2 compatibility notes

- OpenCode V2 (`opencode2`, beta-19192) is the default `opencode` command on this machine. V1 (`opencode1`) still exists for reference.
- Config `instructions` entries are NOT loaded by V2. Loaded instruction sources are: this global AGENTS.md, then project AGENTS.md files from the Location up to home/project root.
- Agents are defined in `~/.config/opencode/opencode.json` (`agents` key, V2 permission rules) AND `~/.config/opencode/agents/*.md` (file-based agents). Keep the agent md bodies in V2 vocabulary (see the files themselves).

## Planned upgrades
- Coordinator (sub-orchestrator): airouter/Qwen3.8#max
- Detective: hypercharm/qwen3.8-flash (coordinates research workers) — the primary spawns it for ALL research needs
- Edit: agnes-execute/agnes-2.5-flash#edit
- Research: agnes-research/agnes-2.5-flash#research
- Explore: agnes-research/agnes-2.5-flash#explore




