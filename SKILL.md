---
name: mind-management
description: >
  MANDATORY skill for ALL tasks when mind MCP server is available.
  Activate for any work: coding, research, debugging, design, planning,
  conversations, or any task where context should survive the session.
  Mind is always on — not optional, REQUIRED. If mind MCP tools are
  available, this skill applies. No exceptions.
license: MIT
---

# Mind Management Protocol

This skill is **MANDATORY** when mind MCP is available. Use it for every session — coding, research, planning, debugging, design reviews, conversations. If something is worth doing, it's worth remembering.

## Why This Exists

Without persistent memory: context dies when sessions end, future agents repeat solved mistakes, and decisions lack traceable rationale.

With mind: every agent inherits prior knowledge, decisions form a traceable graph, recovery from compaction is instant, and users never re-explain context.

---

## Session Lifecycle

### 1. RECOVER — Before anything else

```
checkpoint_query { space: "<project>" }
```

This returns available checkpoints. Then load the specific one:

```
checkpoint_load { space: "<project>", checkpointName: "<name>" }
```

If no checkpoints exist, the response tells you — proceed to step 2.

### 2. ORIENT — Understand what exists

```
space_get { name: "<project>" }
memory_query { space: "<project>", limit: 10 }
memory_query { space: "<project>", search: "<current-task-keywords>" }
```

`space_get` returns space details plus hot (T1+T2) memories preview. Use `memory_query` with `search` parameter for task-related context.

If the space doesn't exist:

```
space_create {
  name: "projects/<repo-name>",
  description: "Context and decisions for <repo-name>",
  tags: ["type:project"]
}
```

**Space naming**: Always use the actual repo/directory name. Future agents find memories by searching the repo name.

### 3. WORK — Persist the right state

Use checkpoints for live/ephemeral work state. Create durable memories when
knowledge is likely useful in future sessions.

### 4. CLOSE — Summarize and complete

```
checkpoint_done {
  space: "<project>",
  summary: "What was accomplished in this session"
}
```

Checkpoints hold live state; `checkpoint_done` completes the active checkpoint
and creates a same-space `session-*` summary memory in `projects/<repo>` with
`type:session` + `cat:summary` at T3. Optionally, enrich it with
`memory_update` if more detail is needed.

---

## When to Create Memories

### Durable memory threshold

Call `memory_add` or `memory_update` when the information is likely useful in
future sessions: stable decisions, verified root causes, final fixes, reusable
patterns, user preferences, or significant config/domain facts.

Keep transient observations, routine progress, and routine validation results with no new findings in checkpoints or session summaries.

Durable memories are separate from session summaries. Use durable memories when
future sessions need stable decisions, root causes, patterns, preferences,
config, or domain facts.

| Event                   | Tag              |
| ----------------------- | ---------------- |
| Decision made           | `cat:decision`   |
| Bug identified or fixed | `cat:bugfix`     |
| Non-obvious discovery   | `cat:discovery`  |
| Pattern established     | `cat:pattern`    |
| Config or env change    | `cat:config`     |
| User preference learned | `cat:preference` |

Persist verified root causes, regressions, risk decisions, or durable validation
patterns. Don't persist routine validation outcomes unless they change future
work.

### Before creating a durable memory

Confirm it meets this threshold:

- **Future utility**: Will a future session need this?
- **Novelty**: Is this new knowledge (not already captured)?
- **Evidence**: Is it verified (not speculation)?
- **Stability**: Is it settled (not likely to change soon)?

If any answer is NO, keep it in the checkpoint or session summary instead.

## Memory Types

- Checkpoint = live/ephemeral work state: goal, pending work, blockers, and
  next action.
- Session summary = chronological log/recovery record. It is evidence, not
  canonical truth.
- Durable/canonical memory = atomic actionable knowledge for future sessions.
- Living reference memory = maintained current truth map for a project, domain,
  architecture, style, or workflow.

| Need                                                                          | Use                                                | Result                               |
| ----------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Live goal, pending work, blockers, or next action                             | `checkpoint_save`                                  | Active checkpoint                    |
| End-of-session recovery log                                                   | `checkpoint_done`                                  | Same-space `session-*` summary at T3 |
| Stable decisions, root causes, patterns, preferences, config, or domain facts | `memory_add` / `memory_update`                     | Durable memory                       |
| Compact current truth map                                                     | `memory_add` / `memory_update` with reference tags | Living reference                     |
| Obsolete knowledge with no historical value                                   | `memory_delete`                                    | Removed memory                       |

## Status Tags

`status:*` tags are convention-only, not schema-enforced. Use well-normed tags
such as `status:proposed`, `status:validated`, `status:failed`,
`status:superseded`, `status:obsolete`, `status:final`, and `status:living`.

## Living Reference Memories

Use living references for compact current truth. Create them at T2 by default;
let reads naturally promote them to T1. Pin only 1–3 critical references when
explicitly warranted or approved.

Tags are authoritative. Required tags: `type:reference`, exactly one `ref:*`, and `status:living`.
Recommended refs: `ref:project-map`, `ref:architecture`, `ref:style`,
`ref:domain`, `ref:workflow`. The `ref:*` tag defines the reference category; the memory name is the readable identifier.

Recommended names: `architecture-overview`, `project-map`, `style-guide`, `domain-model`, and `workflow-notes`.

Recommended sections: Purpose, Current truth, Key areas/files/concepts, Active
conventions, Source memories, Last reviewed, Maintenance notes.

When current truth changes, use `memory_update` on the living reference and
link it to source memories. Sessions remain evidence/logs, not canonical truth.

### Living reference taxonomy and maintenance

**7 reference types** (required tags: `type:reference` + one `ref:*` + `status:living`):

| ref tag              | Recommended name        | Purpose                                      |
| -------------------- | ----------------------- | -------------------------------------------- |
| `ref:project-map`    | `project-map`           | Entry points, key modules, repo layout       |
| `ref:architecture`   | `architecture-overview` | Stack, layers, data flow, boundaries         |
| `ref:domain`         | `domain-model`          | Core entities, business rules, vocabulary    |
| `ref:workflow`       | `workflow-notes`        | CI/CD, release process, testing conventions  |
| `ref:style`          | `style-guide`           | Code conventions, naming, formatting         |
| `ref:key-decisions`  | `key-decisions`         | Cross-cutting architectural decisions        |
| `ref:known-pitfalls` | `known-pitfalls`        | Recurring gotchas and anti-patterns to avoid |

**Creation triggers** — create a living reference when:

- A project space is created → create `project-map` immediately.
- 3+ durable memories reference the same subsystem → create or update `architecture-overview`.
- A decision affects 2+ modules → add it to `key-decisions`.
- A debugging step or workaround repeats → add it to `known-pitfalls`.

**Update triggers** — update a living reference when:

- A decision is changed or superseded → update `key-decisions`.
- A new module, convention, or workflow is added → update the relevant reference.
- A pitfall stops applying → mark it resolved in `known-pitfalls`.
- After a major refactor or release → review all living references.

**Living reference content format:**

- Purpose — why this reference exists.
- Current truth — what is true now; this is the canonical part.
- Key areas/files/concepts — what an agent needs to know.
- Active conventions — rules currently in force.
- Source memories — links to durable memories this summarizes.
- Last reviewed — date in YYYY-MM-DD format.
- Maintenance notes — how to keep this updated.

**Living reference vs durable memory:** durable memories capture events (decisions, fixes, discoveries); living references capture state (the current truth map). When truth changes, update the living reference and link new durable memories as sources.

**Anti-staleness:** Review every living reference at least every 30 days. If unchanged, update `Last reviewed`. If truth changed, update `Current truth` and link new source memories.

**Granularity minimum:** Every project space should have at least a `ref:project-map`. Create higher-level references only when they serve future sessions.

Use `memory_delete` only when a memory is clearly obsolete, no longer
applicable, and has no historical value. Otherwise, mark it with
`status:obsolete` or `status:superseded` and link the replacement.

### Memory Content Format

```
memory_add {
  space: "projects/mind",
  name: "MCP tool descriptions redesign",
  content: "**What**: Rewrote all MCP tool descriptions.\n**Why**: Agents weren't using link features.\n**Where**: cli/src/mcp/tools/\n**Learned**: Examples work better than rules.",
  tags: ["cat:decision", "cat:discovery"],
  links_to: ["<name-of-related-memory>"]
}
```

**Name format**: descriptive, kebab-case — `auth-jwt-token-expiry`, `mcp-tool-descriptions-redesign`

---

## Linking Memories

Links turn isolated notes into a knowledge graph. Link memories when the
relationship helps future recovery.

### When to Link

| Situation                              | Label         |
| -------------------------------------- | ------------- |
| Bugfix caused by a prior decision      | `caused_by`   |
| Discovery that updates a pattern       | `extends`     |
| New decision that overrides an old one | `contradicts` |
| Implementation of a design decision    | `implements`  |
| Two memories about the same subsystem  | `relates_to`  |

### How to Link

**At creation time** (preferred):

```
memory_add {
  space: "projects/mind",
  name: "auth-jwt-mobile-expiry-fix",
  content: "Fixed JWT early expiry on mobile...",
  tags: ["cat:bugfix"],
  links_to: ["auth-jwt-decision", "mobile-clock-skew-discovery"]
}
```

**Between existing memories** (discovered later):

```
link_create {
  sourceRef: "projects/mind:auth-jwt-mobile-expiry-fix",
  targetRef: "projects/mind:auth-jwt-decision",
  label: "caused_by"
}
```

References use `space:name` format. Bare names work for same-space memories.

When a new memory depends on, updates, or explains another memory, pass related memories in `links_to`.
After adding with `links_to`, check `links_created` and `links_failed`; retry important failed links with `link_create`.

---

## Checkpoint Discipline

Checkpoints survive context resets and compaction. Be disciplined about them.

### When to Save

| Event                       | What to save             |
| --------------------------- | ------------------------ |
| User approves a plan        | `goal` + `pending` steps |
| Complete a subtask          | Update `pending`         |
| Significant decision made   | Add to `notes`           |
| Before a risky operation    | Full state snapshot      |
| Every 15-20 minutes of work | Progress update          |

```
checkpoint_save {
  space: "projects/mind",
  goal: "Redesign MCP tool descriptions",
  pending: "Update system instructions, Regenerate test snapshots",
  notes: "User wants links more prominent.",
  linked_memories: ["mcp-descriptions-decision"]
}
```

`linked_memories` links memories to the checkpoint — when `checkpoint_load` is called, these memories are returned in enriched memory_read format.

### Checkpoint Aging

- **< 30 minutes**: Continue using the current checkpoint
- **≥ 30 minutes**: Close it with `checkpoint_done` and create a new one with `checkpoint_save`

### When to Complete

```
checkpoint_done {
  space: "projects/mind",
  summary: "Redesigned all MCP descriptions. Tests passing."
}
```

Checkpoints hold live state; `checkpoint_done` completes the active checkpoint
and creates a same-space `session-*` summary memory in `projects/<repo>` with
`type:session` + `cat:summary` at T3.

---

## Tier System

| Tier | Name | Purpose                  | Limit per space |
| ---- | ---- | ------------------------ | --------------- |
| T1   | hot  | Critical active context  | 25              |
| T2   | warm | Default for new memories | 50              |
| T3   | cold | Reference, past patterns | unlimited       |

**Behaviors:**

- New memories start at T2 unless you specify otherwise
- `memory_read` auto-promotes one tier up
- When a tier is full, least-recently-used non-pinned memory is evicted down
- `pinned` memories are immune to promotion and eviction

---

## Tool Quick Reference

| Tool                  | Purpose                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `space_create`        | Create space (required before adding memories). Tags required.                                               |
| `space_get`           | Get space details + hot memories preview                                                                     |
| `space_list`          | List spaces, optionally by tag                                                                               |
| `space_update`        | Update description and/or tags                                                                               |
| `space_delete`        | Delete space + all contents permanently                                                                      |
| `memory_add`          | Add memory with tags. `links_to` is best-effort — check `links_failed` in response.                          |
| `memory_read`         | Read + auto-promote. Use `noPromote:true` for read without side effects.                                     |
| `memory_update`       | Update name, content, or replace tags                                                                        |
| `memory_delete`       | Delete memory + all its links                                                                                |
| `memory_query`        | Query by metadata. Use `search` parameter for full-text search.                                              |
| `status`              | Storage stats (counts per tier, links, spaces)                                                               |
| `link_create`         | Link two memories by `space:name` ref                                                                        |
| `link_delete`         | Remove a link between two memories                                                                           |
| `checkpoint_save`     | Save/update session state (goal, pending, notes)                                                             |
| `checkpoint_load`     | Restore a specific checkpoint by name (use checkpoint_query first)                                           |
| `checkpoint_done`     | Transform checkpoint to same-space `session-*` summary memory in `projects/<repo>` and delete the checkpoint |
| `checkpoint_query`    | Query checkpoints with filters: status, date range, tag, limit/offset                                        |
| `system_instructions` | Get full protocol documentation                                                                              |

**Code Mode naming (OpenCode V2):** the tool names above are bare MCP names. In subagent Code Mode, call the prefixed form: `memory_add` → `return tools.mind.memory_add({...})`; effective permission action is `mind_<tool>` (e.g. `mind_memory_add`). Note: every `write_findings` call auto-mirrors the findings into mind (space `projects/<repo>`, tags `type:finding,source:findings-mcp`) — mirror failures are stderr-only and never fail the write. write_findings is the exception — it is direct-only (server has codemode:false); never call tools.write.findings

---

## write_findings Contract
- Call `write_findings` with EXACTLY two keys: `path` (ABSOLUTE, containing the clean segment `.opencode-findings`) and `body` (raw markdown; bodyBase64 is legacy-accepted but no longer needed since the direct-only codemode:false config landed). Do not rely on aliases — `filePath`/`content`/`title` are tolerated by the tool as a backstop but the canonical contract is `path`+`body`.
- Success is ONLY a reply starting with `WRITTEN:`. Anything starting with `ERROR:` or `WRITE-FAILED:` is a failure: fix the named defect, retry EXACTLY once, then end with `write_findings unavailable: <summary>`. NEVER fall back to shell/node/heredoc writes. NEVER rewrite a file already answered `WRITTEN` (a second call to the same path is a bug, not a retry).

## Enforcement Checklist

1. **Session start** → `checkpoint_query` then `checkpoint_load` with specific name before any work
2. **Plan approved** → `checkpoint_save` immediately
3. **Significant event** → `memory_add` with tags NOW
4. **Related memory exists** → Link via `links_to` or `link_create`
5. **Subtask done** → Update checkpoint with `checkpoint_save`
6. **Session end** → `checkpoint_done` + session summary memory

### Anti-Patterns

| Don't                              | Do                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------- |
| Add memories without tags          | Every memory needs at least one tag                                    |
| Skip linking related memories      | Use `links_to` or `link_create`                                        |
| Let checkpoints go stale           | Update `checkpoint_save` after subtasks                                |
| Skip session recovery              | Always `checkpoint_query` + `checkpoint_load` with specific name first |
| Hoard everything in T1/T2          | Move old memories to T3                                                |
| Create memories for obvious things | Only memory non-obvious, valuable knowledge                            |

### You're breaking the rules if:

- You've done significant work without a single `memory_add`
- You created a memory without tags
- You created a memory that relates to an existing one but didn't link it
- Your checkpoint is stale (goal/pending doesn't match current state)
- The user asks "what were we working on" and you can't answer
- You reimplement something a prior session already figured out

If any of these apply: **stop and fix it before continuing.**
