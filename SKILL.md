---
name: devin-opencode-acp
description: "Connect OpenCode and Tencent CodeBuddy Code to Devin Desktop as external ACP agents on Windows, and fix the file-context failures both hit on Devin's file:///C%3A%5C... URIs (opencode crashes in fileURLToPath; CodeBuddy reduces the URI to a basename and Read fails with 'File does not exist'). Ships a Go stdio proxy for opencode (proxy/main.go), a bin/codebuddy wrapper patch (codebuddy/bin-wrapper.js), and a standalone CodeBuddy proxy (proxy-codebuddy/main.go). Use when wiring either agent into Devin's Agent Command Center, debugging ACP spawn/PATH errors, or fixing file-attachment prompts that fail only under ACP."
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

---

# CodeBuddy Code (WorkBuddy) in Devin

Tencent **CodeBuddy Code** (`workbuddy.ai`) is already in Devin's bundled ACP registry as
agent id `codebuddy-code` — **no local registry entry is needed**. Devin spawns:

```
npx -y @tencent-ai/codebuddy-code@2.168.2 --acp
```

## Setup

```powershell
npm install -g "@tencent-ai/codebuddy-code@<version>"
```

then set `"devin.acp.enabledAgents": { "codebuddy-code": true }` in Devin's
`settings.json` (picked up live), or toggle **Codebuddy Code** in User Settings → Agents.
Or run `scripts/install-codebuddy.ps1` which does the install + patch + enable.

Authenticate via the thread menu → `external` (Google/GitHub login, international) —
`internal` is WeChat/China, `iOA`/`selfhosted` are enterprise. Auth state lives in
`%USERPROFILE%\.codebuddy` and is shared by every spawned process.

## The same `%5C` bug, different symptom

Devin sends attachments as `resource_link` blocks with
`file:///C%3A%5Cdir%5Cfile.ts`. CodeBuddy does not crash — it **collapses the URI to
its basename**, so the model calls `Read` on `file.ts` relative to the cwd and gets
`<tool_use_error>File does not exist.</tool_use_error>`. Plain prompts still work;
file-context prompts silently read the wrong path or nothing.

Verified on `2.168.2`: encoded URI → `Read go.work` → "File does not exist"; the same
URI sanitized to `file:///C:/dir/file.ts` → correct full-path `Read` → `end_turn`.

## Fix option A — patch `bin/codebuddy` (no restart, recommended)

When codebuddy-code is installed globally, `npx -y @tencent-ai/codebuddy-code@<ver>`
resolves the bin in `%APPDATA%\npm\node_modules\@tencent-ai\codebuddy-code\bin` — the
very file Devin ends up running. `codebuddy/bin-wrapper.js` is a drop-in replacement
for `bin/codebuddy`:

1. `rename bin/codebuddy -> bin/codebuddy-orig`
2. copy `codebuddy/bin-wrapper.js` → `bin/codebuddy`

In `--acp` mode it spawns `node codebuddy-orig --acp` and sanitizes `file://` URIs on
stdin (same `%5C`/`%2F`/`%3A` decode); every other mode loads `codebuddy-orig`
in-process, so the TUI is unaffected. Toggle the agent off/on to pick it up — no Devin
restart needed.

**Caveat:** `npm update -g` / reinstall of the package overwrites the wrapper — re-run
`scripts/install-codebuddy.ps1` after upgrading.

## Fix option B — standalone proxy agent (`proxy-codebuddy/`)

Same approach as the opencode proxy: build `proxy-codebuddy/main.go` →
`codebuddy-acp-proxy.exe` on PATH, and add a **new** agent id (e.g. `codebuddy-proxy`)
to the local registry with `cmd: "codebuddy-acp-proxy.exe"`, `args: ["--acp"]`.
It launches `node <npm root>\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy`
itself (overridable via `CODEBUDDY_ENTRY`/`CODEBUDDY_NODE`; debug log via
`CODEBUDDY_PROXY_LOG`).

### Registry caveats learned the hard way

- A local-registry entry **cannot override a bundled agent id** — Devin keeps spawning
  `npx -y @tencent-ai/codebuddy-code@...` even if `id: "codebuddy-code"` exists locally.
  Use a distinct id.
- The local registry is read **once at window startup** — after adding an agent, reload
  the window (`Ctrl+Shift+P` → Reload Window) for it to appear. `enabledAgents` toggles
  are live; registry additions are not.

## CodeBuddy logs

- `%USERPROFILE%\.codebuddy\logs\<date>\<workspace>__<hash>.log` — session log
- `Failed to read settings file for scope user: ENOENT` and missing
  `product.external.json` warnings are **non-fatal** — remote config falls back to
  `https://www.codebuddy.ai/v3/config`.
- ACP-level auth check: `authenticate` with method `external` returns the logged-in
  user info when credentials already exist.

