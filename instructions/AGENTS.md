# Agent Specifications & Engineering Context

This document provides technical instructions, structural assumptions, and design patterns for AI agents collaborating on or extending this project architecture.

## Delegation Rules (MANDATORY)

**All code modifications, file reads, searches, exploratory tasks, and shell commands MUST be delegated to subagents.** The primary agent must never call edit, read, grep, glob, or bash directly for implementation work. Instead:

- For ANY implementation task, ALWAYS use the Task tool with subagent_type: "general" as a sub-orchestrator/planner. The primary delegates the GOAL to general; general breaks it down, plans the edit sequence, and spawns `edit` and `explore` subagents to execute.
- The primary MUST NEVER spawn subagent_type "edit" directly. ALL edits go through `general`. No exceptions.
- The primary MAY spawn subagent_type "explore" directly ONLY for quick standalone lookups on Agnes (free): "quick" or "medium" thoroughness, simple file finds, single-file reads, definition lookups. For "very thorough" exploration or complex multi-file tracing, use subagent_type "research" instead (DeepSeek Flash, stronger reasoning).
- Use the Task tool with subagent_type: "explore" ONLY for quick standalone lookups that don't need implementation (eg. "find all API endpoints", "where is X defined").
- The primary agent's role is **orchestration only**: plan, delegate, synthesize results.
- Exception: you may read AGENTS.md or config files directly for context. All other file operations go through subagents.
- All edit, read, grep, glob, bash, and shell tool calls must be delegated to subagents - no exceptions.
- When the Task tool is not available, you ARE a subagent already and should execute directly as instructed.
- Nesting: a `general` subagent SHOULD delegate its search/read/exploration work to an `explore` subagent instead of doing it inline. Nested `explore` agents MUST NOT spawn anything further.
- Parallel fan-out: a `general` coordinator SHOULD shard independent edits across MULTIPLE `edit` subagents in ONE message (parallel) rather than batching them into one call; same-file/overlapping edits stay in a single call to avoid conflicts. Independent searches fan out across parallel `explore` subagents the same way.
- Title tagging: when calling the Task tool to spawn a SUBAGENT, prefix the `description` parameter with the agent type tag - `[✏️Edit]` for edit, `[🔎Explore]` for explore, `[🤖Coordinate]` for general - so subsession titles are immediately identifiable in the session tree. Do NOT tag the primary session itself.
- Pre-explore discipline (quota saving): the primary agent MUST front-load exploration via top-level `explore` spawns BEFORE delegating implementation work. A task handed to `general` must already contain exact file paths and line references gathered by `explore`, so `general` rarely needs to search inline. If new unknowns surface mid-task, prefer one nested `explore` delegation over inline Glob/Grep sweeps.
- When calling the Task tool, ALWAYS include the `subagent_type` parameter (required) - omitting it causes a schema error.
- When delegating via the Task tool, match the opening line to the target type and keep it VERBATIM, never appending role or capability declarations:
  - subagent_type `edit` -> "You are a subagent. Execute directly with your own tools; for any codebase search or multi-file read, spawn ONE `explore` subagent via the Task tool and use its findings instead of running Glob/Grep/Read sweeps yourself."
  - subagent_type `general` -> "You are a sub-orchestrator. Plan the implementation, then spawn `edit` subagents with exact paths and precise instructions for each change, and `research` subagents for any lookups. You cannot edit or run shell yourself."
  - subagent_type `research` -> "You are a subagent. Search and read directly with your own tools; report findings concisely."
  - subagent_type `explore` -> "You are a subagent. Search and read directly with your own tools; report findings concisely."

## Repository layout
- Sources live under `src/` (see `src/VirtualRdpLauncher.csproj`). Repo root holds only `README.md`, `AGENTS.md`, and the launch shortcut.
- **Form/window classes** (`Form`-derived: `VirtualDesktopForm` + its `.Designer.cs`, `FolderWindow`, `BrowserWindow`, `BootScreen`, `SettingsForm`, `InfoWindow`, `DragGhost`) live under `src/windows/`. Non-form controls (`Win11Taskbar`, `Win11StartMenu`, `DesktopCanvas`, `ResizeEdges`, etc.) stay in `src/`. The SDK-style glob includes all of them, so no `csproj` item edits are needed on move; keep `SubType` metadata in `src/VirtualRdpLauncher.csproj.user` in sync with the paths.
- `bin/` is produced under `src/bin`; `obj/` is **deleted after every build** by an MSBuild `AfterTargets="Build"` target (`RemoveDir` on `$(BaseIntermediateOutputPath)`). This forces a fuller rebuild next time â€” intentional.
- Target: `net11.0-windows` WinExe, Windows Forms. NuGet: `WindowsAPICodePack-Shell`, `Microsoft.Web.WebView2` 1.0.2903.40.
- The running app is branded **ZirconOS** (launcher `Text` and banner title "ðŸ’Ž ZirconOS"). The binary/namespace remain `VirtualRdpLauncher` for path stability (`C:\YourLauncherData\VirtualDesktop`, crash log, etc.).

## Architecture Blueprint
The application relies on a decoupled hybrid UI model:
1. **Host Layer:** A borderless `System.Windows.Forms.Form` (`VirtualDesktopForm`) behaving as the global workspace canvas with a custom top banner (`SetBannerHeight`: 32px normal, 20px maximized; `CurrentBannerHeight` is the dynamic static read by children).
2. **Overlay Layer:** Custom-drawn taskbar (`Win11Taskbar` â€” flat Win10-style, left-aligned: Start â†’ running folders â†’ running browsers â†’ pinned â†’ clock) and start menu (`Win11StartMenu` â€” search, pinned grid, recommended, "Logged out" user tile â†’ opens `https://semantic-ui.com/examples/login.html` in a `BrowserWindow`, power button â†’ `Application.Exit()`), both painted over `AcrylicBackdropRenderer`.
3. **Execution Layer:** Embedded COM `ExplorerBrowser` instances (per `FolderWindow`) + a WebView2 `BrowserWindow` per `.url`/login, on a dedicated STA thread.

## Critical Technical Constraints
- **Do Not Use Win32 Window Swallowing for Core Desktop:** Never `SetParent` from `explorer.exe`. Always embed individual `ExplorerBrowser` controls.
- **State Boundaries:** The embedded browser must navigate strictly via `ShellFileSystemFolder` abstractions rather than raw string paths to preserve context menu stability.
- **Permissions Context:** Strict user-space. Reject `runas` / SAM database modifications in favor of UI simulation.
- **No WS_THICKFRAME on parented child windows:** It draws a visible system sizing border (the "glitching" border). Borderless resize is done **manually** via `ResizeEdges.cs` (`ResizeEdgePanel` overlays + `SetWindowPos` from `MouseMove`). `BorderlessResize.Enable(form, topInset, getClampRect)` installs it; pass the form's `ParentClientRectScreen` as the clamp rect.
- **Topbar z-order over native children:** The `BrowserWindow` topbar is forced above the WebView2 native HWND on every resize and after navigation (`BringTopBarToFront` â†’ `SetWindowPos HWND_TOP`). Both title bar panels set `CS_DBLCLKS` (0x0008) in `CreateParams` so `DoubleClick` fires reliably for the maximize gesture.
- **Opened/Activated events:** `FolderWindow`/`BrowserWindow` fire their static `Opened`/`Closed2`/`Activated2` events from `OnHandleCreated`/`OnFormClosed`/`OnActivated` **overrides** (NOT late `HandleCreated +=` subscriptions â€” `SetParent(Handle,â€¦)` in the constructor creates the handle before any late `+=`). The launcher wires these to update the taskbar and to close the start menu on focus.

## Subwindow chrome contract
Both `FolderWindow` and `BrowserWindow` implement the identical contract:
- **Topbar:** 32px normal / 20px maximized (`SetTopBarHeight`). Buttons positioned by the topbar `Resize` handler with `Height = topbar.Height`. `TitleBarPanel`/`TopBarPanel` enable `StandardDoubleClick` + `CS_DBLCLKS`; `DoubleClick` â†’ `ToggleMaximizeToParent()`.
- **Maximize-to-parent:** `ToggleMaximizeToParent` saves bounds, sets 20px topbar, `FitMaximizedToParent` fills `ParentClientRectScreen()`. `ClampInsideParent` re-fits when maximized (follows launcher resize). `WM_ENTERSIZEMOVE` restores saved bounds + 32px topbar first so drag/resize-from-max proceeds at the restored size.
- **Drag/clamp:** `WM_MOVING`/`WM_SIZING` clamp to `ParentClientRectScreen()` (top-only inset via `VirtualDesktopForm.CurrentBannerHeight`; bottom NOT inset â€” windows may go over the taskbar but never over the topbar).
- **No duplicates:** `FolderWindow.ShowFolder(parent, path)` and `BrowserWindow.ShowOnNewThread(parent, url)` restore/focus an existing window for the same path/URL instead of spawning a duplicate.
- **Minimize to taskbar:** `MinimizeToTaskbarPublic()` / `Restore()` + `FocusRestore()`; taskbar button toggles.

## Taskbar pinning & running detection
- Pinned apps live in the hidden `TaskbarPinned` folder. Drag a `.url`/`.lnk` from the desktop onto the taskbar â†’ copied to `TaskbarPinned` + `LoadApps` reloaded (`PinRequested` event; ghost drag shown over the taskbar via `DesktopCanvas.IsOverTaskbar`).
- `IsAppRunning(i, out bw, out fw)` resolves a pinned `.url` (`ReadInternetShortcut` â†’ `BrowserWindow.FindByUrl`) or `.lnk` (`ResolveShortcutTarget` â†’ `FolderWindow.FindByPath`). Running pinned icons glow with the desktop accent selection color (`DesktopCanvas.GetAccentColor`, 60-alpha fill + 220-alpha outline). Right-click shows "Close" if running, else "Open" (no "Open in outer browser").
- A browser whose URL matches a pinned app **stays in the pinned spot** â€” `AddOpenBrowser` skips adding a separate running button when `BrowserMatchesPinnedApp` is true.

## Extension Directions for Agents
- **Profile Switching:** Mutate `virtualFolderPath` and `explorerBrowser.Navigate(ShellFileSystemFolder.FromFolderPath(newPath))` at runtime.
- **Custom Shortcut Injector:** Generate `.lnk`/`.url` via `IWshRuntimeLibrary` (or `WScript.Shell` COM, see `ResolveShortcutTarget`) directly inside the active virtual path.
- **New pinned/taskbar app:** Drop a `.url`/`.lnk` into `TaskbarPinned` (hidden) and call `taskbar.LoadApps(taskbarPinnedFolder)`.
- **New start-menu pinned app:** Drop into `StartPinned` and call `startMenu.LoadApps(virtualFolderPath)`.