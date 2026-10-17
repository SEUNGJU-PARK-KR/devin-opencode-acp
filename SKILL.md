---
name: devin-opencode-acp
description: "Connect OpenCode to Devin Desktop as an external ACP agent on Windows, and fix the 'Internal error: OpenCode service failure' that breaks prompts carrying file context (Devin emits file:///C%3A%5C... URIs that crash opencode's fileURLToPath). Ships a Go stdio proxy (proxy/main.go) that rewrites encoded separators in file:// URIs on the inbound ACP stream. Use when wiring opencode into Devin's Agent Command Center, debugging ACP spawn/PATH errors, or fixing file-attachment prompts that fail only under ACP."
---

# devin-opencode-acp

Connect **OpenCode** to **Devin Desktop** via the Agent Client Protocol (ACP) on Windows, including a workaround for the file-context crash.

## How the integration works

1. Devin Desktop reads agent entries from a **local ACP registry**:
   `%USERPROFILE%\AppData\Roaming\Code\User\acp\registry.json`
   (Command Palette → `Open Local ACP Registry Config` also opens it.)
2. Enabled agents are toggled in `%USERPROFILE%\AppData\Roaming\Devin\User\settings.json`
   under `devin.acp.enabledAgents`, or via Devin User Settings → Agents tab.
3. On Windows, Devin spawns `basename(cmd)` resolved on **PATH** — the directory part of `cmd` is ignored. If you write a full path, Devin still runs only the file name, so `opencode.exe` must literally be on PATH.
4. Once spawned (`opencode.exe acp`), it speaks JSON-RPC over stdio.

## Setup steps

```powershell
# 1. Install opencode (pin a version >= 7 days old)
npm i -g opencode-ai@<version>

# 2. Build and deploy the proxy (see "The %5C bug" below)
cd proxy && go build -o opencode-proxy.exe .
copy opencode-proxy.exe "$env:APPDATA\npm\opencode.exe"
# The proxy looks for the real binary at:
#   <its dir>\node_modules\opencode-ai\bin\opencode.exe
# or set OPENCODE_REAL=<full path>, or place opencode-real.exe next to it.
```

Or run `scripts/install.ps1`, which does all of this and also writes the registry + settings.

### Registry entry

```json
{
  "version": "1.0.0",
  "agents": [
    {
      "id": "opencode",
      "name": "OpenCode",
      "version": "<version>",
      "description": "The open source coding agent",
      "distribution": {
        "binary": {
          "windows-x86_64": {
            "archive": "",
            "cmd": "opencode.exe",
            "args": ["acp"]
          }
        }
      }
    }
  ],
  "extensions": []
}
```

Devin Desktop does **not** download `archive` — it only uses `cmd`/`args` (basename + PATH lookup).

### Enable

In `settings.json`:

```json
"devin.acp.enabledAgents": { "opencode": true }
```

The change is picked up live; no restart needed. Then select **OpenCode** in the agent selector (bottom-right) for new conversations.

## Auto-approve all permissions

Devin surfaces opencode's permission asks as "allow once / allow always" dialogs. To skip them entirely, set the wildcard rule in `%USERPROFILE%\.config\opencode\opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "*": "allow" }
}
```

`"permission"` also accepts the shorthand `"allow"`. Respawn the agent (toggle it off/on in `enabledAgents`) to reload the config.

## The `%5C` bug (why the proxy exists)

Devin Desktop sends file context as `resource_link` content blocks with URIs like
`file:///C%3A%5Cproject%5Cdir%5Cfile.ts` — Windows paths with percent-encoded backslashes.

- `packages/opencode/src/acp/content.ts` passes that URI verbatim into a `file` part.
- `SessionPrompt.resolveUserPart` calls `fileURLToPath(part.url)`, which on Windows throws
  `ERR_INVALID_FILE_URL_PATH: File URL path must not include encoded \ or / characters`.
- The whole `session/prompt` then fails with `-32603 "Internal error: OpenCode service failure"`.

Symptom: **plain text prompts work; any prompt with file context chips fails.** Reproduced on
opencode 1.18.35; identical code in 1.19.3 — upgrading does not fix it.

**Fix:** `proxy/main.go` is a tiny stdio proxy named `opencode.exe`. It rewrites
`%5C`→`/`, `%2F`→`/`, `%3A`→`:` inside `file://` spans on the inbound (client→agent) stream
and passes everything else through. Verified: the same URI that returned `-32603` completes
with `stopReason: end_turn` through the proxy.

Set `OPENCODE_PROXY_LOG=<path>` to tee inbound JSON-RPC to a file for debugging.

## Verifying

Logs live under `%APPDATA%\Devin\logs\<timestamp>\window1\exthost\`:

- `codeium.windsurf/Devin ACP.log` — spawn + init lines. Success looks like:
  `Binary "opencode.exe" found in PATH` → `Spawning process: opencode.exe acp` → `Initialization complete`
- `output_logging_*/*-Devin ACP opencode.log` — opencode's stderr / JSON-RPC errors
- `~/.local/share/opencode/log/opencode.log` — opencode's own log (`resolveUserPart` crash lands here)

Quick repro harness: send `initialize` → `session/new` → `session/prompt` with a
`resource_link` block over stdin to `opencode.exe acp` (newline-delimited JSON-RPC).
