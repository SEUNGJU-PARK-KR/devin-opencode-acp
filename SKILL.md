---
name: devin-opencode-acp
description: "Run OpenCode and CodeBuddy Code as ACP agents in Devin Desktop on Windows, and fix the file:///C:/... URI bug that breaks file-context prompts (opencode: -32603 Internal error; CodeBuddy: basename path, File does not exist). Use when wiring either agent into Devin's Agent Command Center or debugging ACP spawn/file-attachment failures."
---

# devin-opencode-acp — brief

Devin Desktop drives external agents over ACP (JSON-RPC on stdio). Both OpenCode and CodeBuddy Code break on Devin's `file:///C:/...` attachments; each needs a URI sanitizer on the client→agent stream.

## At a glance

| | OpenCode | CodeBuddy Code |
|---|---|---|
| Agent id | `opencode` (local registry) | `codebuddy-code` (bundled) |
| Install | `npm i -g opencode-ai@<ver>` | `npm i -g @tencent-ai/codebuddy-code@<ver>` |
| Fix | `proxy/main.go` → `opencode.exe` on PATH | patch `bin/codebuddy` (`codebuddy/bin-wrapper.js`) or `proxy-codebuddy/` |
| Installer | `scripts/install.ps1` | `scripts/install-codebuddy.ps1` |
| Auth | none | thread menu → `external` |

## How Devin spawns agents

1. Registry: `%APPDATA%\Code\User\acp\registry.json` (Command Palette → `Open Local ACP Registry Config`).
2. Enable: `"devin.acp.enabledAgents": { "<id>": true }` in `%APPDATA%\Devin\User\settings.json` — live, no restart.
3. Windows quirk: only `basename(cmd)` is used and resolved on PATH; the directory part is ignored.
4. Registry additions load once at window start — Reload Window after editing. A local entry cannot override a bundled id.
5. Then `<cmd> <args>` (e.g. `opencode.exe acp`) speaks newline-delimited JSON-RPC over stdio.

## The `%5C` bug

Devin sends `resource_link` blocks whose URIs look like `file:///C:/dir/file.ts` but contain percent-encoded `%5C` backslashes.

| Agent | Symptom |
|---|---|
| opencode | `fileURLToPath` throws `ERR_INVALID_FILE_URL_PATH` → whole prompt fails with `-32603 Internal error` |
| CodeBuddy | URI collapses to basename → `Read file.ts` relative to cwd → `File does not exist` |

Plain prompts work; only prompts with file chips fail. Upgrading does not help (reproduced 1.18.35 → 1.19.3).

**Fix:** inside `file://` spans on stdin, rewrite `%5C`/`%2F` → `/`, `%3A` → `:`; pass every other byte through unchanged.

## OpenCode setup

```powershell
npm i -g opencode-ai@<ver>
cd proxy; go build -o opencode-proxy.exe .
copy opencode-proxy.exe "$env:APPDATA\npm\opencode.exe"
# Proxy resolves the real binary from node_modules\opencode-ai\bin\opencode.exe,
# or OPENCODE_REAL=<path>, or opencode-real.exe beside it.
```

Registry entry is just `cmd: "opencode.exe"`, `args: ["acp"]` — `archive` is ignored.
Auto-approve: `"permission": { "*": "allow" }` in `%USERPROFILE%\.config\opencode\opencode.jsonc`, then respawn.

## CodeBuddy setup

```powershell
npm install -g "@tencent-ai/codebuddy-code@<ver>"
# Fix A (recommended, no restart):
#   rename bin/codebuddy -> bin/codebuddy-orig
#   copy codebuddy/bin-wrapper.js -> bin/codebuddy
# Fix B: build proxy-codebuddy -> codebuddy-acp-proxy.exe, add a NEW id (e.g. codebuddy-proxy) to the local registry
```

Wrapper intercepts `--acp` only; the TUI still runs in-process. Reinstalling the package overwrites it — re-run the installer after upgrades.
Fix B env: `CODEBUDDY_ENTRY`, `CODEBUDDY_NODE`, `CODEBUDDY_PROXY_LOG`.

Devin's bundled registry pins a package version (`npx -y @tencent-ai/codebuddy-code@<ver>`). When that version bumps upstream, npx resolves the package from `%LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules` instead of `npm root -g` — a wrapper applied only to the global copy is silently bypassed. `scripts/install-codebuddy.ps1` patches both locations.

## CodeBuddy model snaps back to "Auto"

Selecting a model in Devin reverts to Auto on `session/load` because CodeBuddy persists per-session config through its CLI settings provider, which needs `%USERPROFILE%\.codebuddy\settings.json`. If missing: `Failed to read settings file for scope user: ENOENT` in the session log, and every load reports `currentValue: default-model`. Fix: create the file, e.g. `{ "model": "deepseek-v4.1-flash" }`, then toggle the agent off/on.

## Verify

- `%APPDATA%\Devin\logs\<ts>\window1\exthost\codeium.windsurf\Devin ACP.log` — expect `found in PATH` → `Spawning process` → `Initialization complete`.
- `...\output_logging_*\*-Devin ACP <agent>.log` — agent stderr / JSON-RPC errors.
- opencode: `~/.local/share/opencode/log/opencode.log`; CodeBuddy: `~/.codebuddy/logs/<date>/<workspace>__<hash>.log`.
- Repro harness: pipe `initialize` → `session/new` → `session/prompt` (with one `resource_link`) into `<agent> acp`.
- `OPENCODE_PROXY_LOG` / `CODEBUDDY_PROXY_LOG` tee the JSON-RPC stream.

## Files

`proxy/main.go` · `codebuddy/bin-wrapper.js` · `proxy-codebuddy/main.go` · `scripts/install.ps1` · `scripts/install-codebuddy.ps1`

> Full long-form version: commit `af11e9f`.
