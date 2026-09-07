# opencode V1 ↔ V2 setup (September 6, 2026)

Summary of the fix applied so this machine runs **OpenCode V2** as the default `opencode` command while keeping V1 available.

## Problem

`opencode stats --days 1` (and every other opencode command) failed with:

```
Error: Configuration is invalid at C:\Users\User\.config\opencode\opencode.json
↳ V2 permissions are not supported by OpenCode V1. Use V1 "permission" rules or run opencode2.
   agents.explore.permissions (and research, detective, edit, coordinator)
```

## Root cause

- `opencode` in PATH pointed at **OpenCode V1** (`opencode-ai@1.18.29`, installed via npm).
- The global config `C:\Users\User\.config\opencode\opencode.json` is written in **V2 format**
  (`agents.<name>.permissions` rules of `{action, resource, effect}`, `provider.npm`, etc.).
- V1 cannot parse V2 configs, so it rejected the config on startup and every command.
- V2 was not installed at all (`opencode2` missing), even though the error suggested running it.

## Fix applied

1. **Installed V2** side-by-side with V1:
   ```
   npm install -g @opencode-ai/cli@beta
   → opencode2 v0.0.0-beta-19192
   ```
   V2 intentionally installs as `opencode2`; it never replaces the V1 `opencode` binary by itself.

2. **Repointed `opencode` at V2 in cmd / npm shims** (`C:\Users\User\AppData\Roaming\npm\`):
   - Renamed V1 shims: `opencode` → `opencode1`, `opencode.cmd` → `opencode1.cmd`, `opencode.ps1` → `opencode1.ps1`
   - Created new `opencode` / `opencode.cmd` / `opencode.ps1` shims that delegate to `opencode2`.

3. **Added PowerShell profile functions** (harmless, now redundant):
   - `C:\Users\User\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`
   - `C:\Users\User\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`
   - Each defines: `function opencode { & opencode2 @args }`

## Current state (verified)

| Command | Runs |
|---|---|
| `opencode` | OpenCode V2 (`opencode2 v0.0.0-beta-19192`) |
| `opencode2` | OpenCode V2 (explicit) |
| `opencode1` | OpenCode V1 (`1.18.29`) — pre-shim-rename V1 |

`opencode stats --days 1` works again (reads V2 session data).

## Instructions loading (V2 quirk — September 6, 2026)

V2 parses the `instructions` array in `opencode.json` but does NOT load its entries (see
https://opencode.ai/v2/docs/instructions). The only instruction files V2 loads are `AGENTS.md` files:

1. The global file `~/.config/opencode/AGENTS.md` (loaded for EVERY project) — this is where the
   **Agent Delegation Rules** live now (updated for V2's `subagent` tool: `agent`/`description`/`prompt`,
   no `Task`/`subagent_type`/`task_id`).
2. Project `AGENTS.md` files, from the current location up to home/project root.

The reference copy at `~/.config/opencode/instructions/AGENTS.md` must be kept in sync with the global file.
The `instructions` config array is left in place for when V2 implements it.

## Maintenance notes

- **npm updates break the shims:** any `npm install -g opencode-ai` (reinstall/update of V1) regenerates
  `opencode`, `opencode.cmd`, `opencode.ps1` as V1 shims, resurrecting this bug. Fix: re-run
  `ren` commands on the three files (see above) or just use `opencode2` / `opencode1` directly.
- Do **not** try to make V1 parse the V2 config — convert the config to V1 format instead if V1 is ever needed.
- The user's terminal is **cmd.exe**, not PowerShell — PowerShell profile changes alone do not affect it.
- V2 docs: <https://opencode.ai/v2/docs/> (installation: `npm install -g @opencode-ai/cli@beta`).
