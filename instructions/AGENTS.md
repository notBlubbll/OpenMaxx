# Agent Delegation Rules

## Delegation Rules (MANDATORY)

**All code modifications, file reads, searches, exploratory tasks, and shell commands MUST be delegated to subagents.** The primary agent must never call edit, read, grep, glob, or bash directly for implementation work. Instead:

- For ANY implementation task, use the Task tool with subagent_type: "general" as a sub-orchestrator/planner. The primary delegates the GOAL to general; general breaks it down, plans the edit sequence, and spawns `edit` and `explore` subagents to execute. The primary does NOT spawn edit/explore directly except for trivial one-off lookups.
- Use the Task tool with subagent_type: "explore" ONLY for quick standalone lookups that don't need implementation (eg. "find all API endpoints", "where is X defined").
- The primary agent's role is **orchestration only**: plan, delegate, synthesize results.
- Exception: you may read AGENTS.md or config files directly for context. All other file operations go through subagents.
- All edit, read, grep, glob, bash, and shell tool calls must be delegated to subagents - no exceptions.
- When the Task tool is not available, you ARE a subagent already and should execute directly as instructed.
- Nesting: a `general` subagent SHOULD delegate its search/read/exploration work to an `explore` subagent instead of doing it inline. Nested `explore` agents MUST NOT spawn anything further.
- Parallel fan-out: a `general` coordinator SHOULD shard independent edits across MULTIPLE `edit` subagents in ONE message (parallel) rather than batching them into one call; same-file/overlapping edits stay in a single call to avoid conflicts. Independent searches fan out across parallel `explore` subagents the same way.
- Title tagging: when calling the Task tool to spawn a SUBAGENT, prefix the `description` parameter with the agent type tag - `[✏️Edit]` for edit, `[🔎Explore]` for explore, `[🤖Coordinate]` for general - so subsession titles are immediately identifiable in the session tree. Do NOT tag the primary session itself.
- Pre-explore discipline (quota saving): the primary agent MUST front-load exploration via top-level `explore` spawns BEFORE delegating implementation work. A task handed to `general` must already contain exact file paths and line references gathered by `explore`, so `general` rarely needs to search inline. If new unknowns surface mid-task, prefer one nested `explore` delegation over inline Glob/Grep sweeps.
- When delegating via the Task tool, match the opening line to the target type and keep it VERBATIM, never appending role or capability declarations:
  - subagent_type `general` -> "You are a sub-orchestrator. Plan the implementation, then spawn `edit` subagents with exact paths and precise instructions for each change, and `explore` subagents for any lookups. You cannot edit or run shell yourself."
  - subagent_type `explore` -> "You are a subagent. Search and read directly with your own tools; report findings concisely."

(append your project-specific sections below this line)
