# fakellm

A tiny local OpenAI-compatible fake LLM server for opencode. It does not generate
text — it executes a deterministic contract: parse a structured block from the
prompt, write a file to disk, and return the path. This makes the summarizer
subagent step nearly instant (~130 ms local round-trip, zero tokens, zero cost).

## What it is for

opencode's summarizer subagent normally burns a real LLM call just to paste
findings into a file. fakellm replaces that call with a mechanical write:

- **Summarizer agent** — writes `.opencode-findings/*.md` reports instantly
- **Zero token cost** — no API billing for findings writes
- **Deterministic** — no hallucinated paths, no "glued path" typos, no loops

## Architecture

```
C:\Users\User\.config\opencode\fakellm\
├── fakellm.csproj        # net10.0 minimal ASP.NET core server
├── Program.cs            # OpenAI-compatible endpoints + contract parser
├── keeper.ps1            # MCP stdio server exposing fakellm_ensure tool
├── fakellm-keeper.js     # (in ..\plugins\) opencode plugin, auto-starts server
└── bin\Release\net10.0\fakellm.exe   # the running server
```

Endpoints:

| Endpoint | Behavior |
|---|---|
| `GET /v1/models` | Lists `fake-mechanical-reader-0.0B` |
| `POST /v1/chat/completions` | Parses the contract block, writes the file, returns the path |
| streaming (`stream: true`) | Same, emitted as a single-chunk SSE stream |

## The contract

The summarizer's spawn prompt MUST end with this machine-readable block:

```
<<<FINDINGS>>>
PATH: C:\...\project\.opencode-findings\report-name.md
BODY:
# Findings title
- finding one with file:line reference
- finding two with a verbatim quote
<<<END>>>
```

fakellm:

1. Parses `PATH:` (must contain `.opencode-findings`)
2. Creates the directory if needed
3. Writes `BODY:` content verbatim (UTF-8, no BOM)
4. Replies `WRITTEN: <path> (<n> bytes)`
5. On any parse/write failure: replies `WRITE-FAILED: <path> :: <error>` or
   `ok: <echo>` if no block was found at all

The summarizer agent spec (`agents/summarizer.md`) instructs the model to just
parrot the PATH line — the server does the real work.

## Auto-start keepers

Two independent mechanisms keep the server alive:

1. **Plugin** (`~/.config/opencode/plugins/fakellm-keeper.js`):
   - Loads automatically at opencode startup
   - On `server.connected`: checks `/v1/models`, builds + starts `fakellm.exe` if dead
   - On every `task` tool call: re-checks (mid-session crash safety)
2. **MCP server** (`fakellm-keeper.ps1`, registered as `fakellm-keeper` in opencode.json):
   - Exposes a `fakellm_ensure` tool any agent can call
   - Same check → build → start → verify flow over stdio JSON-RPC

Manual run (if you ever need it):

```powershell
Start-Process "C:\Users\User\.config\opencode\fakellm\bin\Release\net10.0\fakellm.exe" -WindowStyle Hidden
# rebuild from source:
dotnet build C:\Users\User\.config\opencode\fakellm\fakellm.csproj -c Release
```

## Quick test

```powershell
$body = @{
  model = "fake-mechanical-reader-0.0B"; max_tokens = 50
  messages = @(@{ role = "user"; content = @"
<<<FINDINGS>>>
PATH: C:\tmp\test\.opencode-findings\demo.md
BODY:
# Demo
hello world
<<<END>>>
"@ })
} | ConvertTo-Json -Depth 5
(Invoke-RestMethod http://127.0.0.1:8000/v1/chat/completions -Method Post `
  -ContentType application/json -Body $body).choices[0].message.content
# -> WRITTEN: C:\tmp\test\.opencode-findings\demo.md (18 bytes)
```

## Limitations

- Replies never contain generated prose — anything needing a *written* summary
  must keep its real model. fakellm only copies BODY to PATH.
- If a spawner forgets the `<<<FINDINGS>>>` block, the summarizer returns
  `BLOCK-MISSING` (per its spec) and the caller must respawn with the block.
- The agent specs that spawn summarizer (research, detective, explore,
  coordinator) document the block shape — keep them in sync with this file.

## Model registration

`fake-mechanical-reader-0.0B` is registered under the `fakellm` provider in
`~/.config/opencode/opencode.json` (baseURL `http://127.0.0.1:8000/v1`,
context 1,000,000, output 65,536). The `summarizer` agent points at it; the
`explore` agent also uses it as a placeholder model.
