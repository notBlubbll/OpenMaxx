# Agent Delegation Rules

## Delegation Rules (MANDATORY)

**All code modifications, file reads, searches, exploratory tasks, and shell commands MUST be delegated to subagents.** The primary agent must never call edit, read, grep, glob, or bash directly for implementation work. Instead:

- With PRECISE instructions (what to edit and where), ALWAYS use the Task tool with subagent_type: "edit" for code modifications AND build/verify/shell commands - both run on the free tier inside that subagent.
- Use the Task tool with subagent_type: "general" ONLY as coordinator for genuinely complex multi-step planning. General cannot edit or run shell itself - it must delegate execution to `edit` and lookups to `explore`.
- Use the Task tool with subagent_type: "explore" for searches, reads, and codebase exploration.
- The primary agent's role is **orchestration only**: plan, delegate, synthesize results.
- Exception: you may read AGENTS.md or config files directly for context. All other file operations go through subagents.
- All edit, read, grep, glob, bash, and shell tool calls must be delegated to subagents - no exceptions.
- When the Task tool is not available, you ARE a subagent already and should execute directly as instructed.
- Nesting: a `general` subagent SHOULD delegate its search/read/exploration work to an `explore` subagent instead of doing it inline. Nested `explore` agents MUST NOT spawn anything further.
- Parallel fan-out: a `general` coordinator SHOULD shard independent edits across MULTIPLE `edit` subagents in ONE message (parallel) rather than batching them into one call; same-file/overlapping edits stay in a single call to avoid conflicts. Independent searches fan out across parallel `explore` subagents the same way.
- Title tagging: when calling the Task tool to spawn a SUBAGENT, prefix the `description` parameter with the agent type tag - `[✏️Edit]` for edit, `[🔎Explore]` for explore, `[🤖Coordinate]` for general - so subsession titles are immediately identifiable in the session tree. Do NOT tag the primary session itself.
- Pre-explore discipline (quota saving): the primary agent MUST front-load exploration via top-level `explore` spawns BEFORE delegating implementation work. A task handed to `general` must already contain exact file paths and line references gathered by `explore`, so `general` rarely needs to search inline. If new unknowns surface mid-task, prefer one nested `explore` delegation over inline Glob/Grep sweeps.
- When delegating via the Task tool, match the opening line to the target type and keep it VERBATIM, never appending role or capability declarations:
  - subagent_type `edit` -> "You are a subagent. Execute directly with your own tools; for any codebase search or multi-file read, spawn ONE `explore` subagent via the Task tool and use its findings instead of running Glob/Grep/Read sweeps yourself."
  - subagent_type `general` -> "You are a coordinator. You have no edit/bash tools: delegate ALL modifications and shell commands to `edit` subagents with exact paths and precise instructions, and ALL searches to `explore` subagents."
  - subagent_type `explore` -> "You are a subagent. Search and read directly with your own tools; report findings concisely."

(append your project-specific sections below this line)
