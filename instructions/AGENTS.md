# Agent Delegation Rules

## Delegation Rules (MANDATORY)

**All code modifications, file reads, searches, exploratory tasks, and shell commands MUST be delegated to subagents.** The primary agent must never call edit, read, grep, glob, or bash directly for implementation work. Instead:

- For ANY implementation task, ALWAYS use the Task tool with subagent_type: "general" as a sub-orchestrator/planner. The primary delegates the GOAL to general; general breaks it down, plans the edit sequence, and spawns `edit` and `research` subagents to execute.
- The primary MUST NEVER spawn subagent_type "edit" directly. ALL edits go through `general`. No exceptions.
- The primary MUST delegate ALL research work to subagents. If the primary needs to investigate, search, read code, or understand something before delegating implementation, it MUST spawn a `research` subagent (or `explore` ONLY for single-file lookups) for that - never do the research itself on its own model. The primary's loop should be: spawn research (or explore for single-file) -> read findings -> delegate to general -> synthesize. Not: reason through the codebase on GLM-5.2 tokens.
- The primary MUST choose between explore and research based on scope:
  - explore (Agnes, free): ONLY for single-file reads, definition lookups, or finding files by name/glob. One target, one answer.
  - research (Agnes, free): for ANY multi-file search, code tracing, call-path analysis, or when thoroughness is "medium" or "very thorough". If the lookup touches more than one file or needs reasoning to connect findings, use research.
  - When in doubt, use research.
- Use the Task tool with subagent_type: "explore" ONLY for single-file reads or finding files by name/glob. For ANYTHING else (multi-file search, code tracing, understanding behavior), use subagent_type: "research". When in doubt, use "research".
- The primary agent's role is **orchestration only**: plan, delegate, synthesize results.
- Exception: you may read AGENTS.md or config files directly for context. All other file operations go through subagents.
- All edit, read, grep, glob, bash, and shell tool calls must be delegated to subagents - no exceptions.
- When the Task tool is not available, you ARE a subagent already and should execute directly as instructed.
- Nesting: a `general` subagent SHOULD delegate its search/read/exploration work to a `research` subagent instead of doing it inline. Nested `research` agents MUST NOT spawn anything further.
- Parallel fan-out: a `general` coordinator SHOULD shard independent edits across MULTIPLE `edit` subagents in ONE message (parallel) rather than batching them into one call; same-file/overlapping edits stay in a single call to avoid conflicts. Independent searches fan out across parallel `research` subagents the same way. Cap parallel fan-out at 4 concurrent subagents of each type per message; batch beyond that into waves.
- Title tagging: when calling the Task tool to spawn a SUBAGENT, prefix the `description` parameter with the agent type tag - `[✏️Edit]` for edit, `[🤖Coordinate]` for general, `[🔎Research]` for research - so subsession titles are immediately identifiable in the session tree. Do NOT tag the primary session itself.
- Pre-explore discipline (quota saving): the primary agent MUST front-load exploration via top-level `research` spawns BEFORE delegating implementation work. A task handed to `general` must already contain exact file paths and line references gathered by `research`, so `general` rarely needs to search inline. If new unknowns surface mid-task, prefer one nested `research` delegation over inline Glob/Grep sweeps.
- When calling the Task tool, ALWAYS include the `subagent_type` parameter (required) - omitting it causes a schema error.
- When delegating via the Task tool, match the opening line to the target type and keep it VERBATIM, never appending role or capability declarations:
  - subagent_type `edit` -> "You are a subagent. Execute directly with your own tools; for any codebase search or multi-file read, spawn ONE `explore` subagent via the Task tool and use its findings instead of running Glob/Grep/Read sweeps yourself."
  - subagent_type `general` -> "You are a sub-orchestrator. Plan the implementation, then spawn `edit` subagents with exact paths and precise instructions for each change, and `research` subagents for any lookups. You cannot edit or run shell yourself."
  - subagent_type `research` -> "You are a subagent. Search and read directly with your own tools; report findings concisely."
  - subagent_type `explore` -> "You are a subagent. Search and read directly with your own tools; report findings concisely."

(append your project-specific sections below this line)
