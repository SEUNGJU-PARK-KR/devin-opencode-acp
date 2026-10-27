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
| opencode 1.x | `fileURLToPath` throws `ERR_INVALID_FILE_URL_PATH` → whole prompt fails with `-32603 Internal error` |
| opencode 2.x | no error — the attachment is **silently dropped**, the model only sees `[name](file:///C%3A%5C...)` (verified on 2.0.30) |
| CodeBuddy | URI collapses to basename → `Read file.ts` relative to cwd → `File does not exist` |

Plain prompts work; only prompts with file chips fail. Upgrading from 1.x to 2.x changes the symptom but not the outcome.

**Fix:** inside `file://` spans on stdin, rewrite `%5C`/`%2F` → `/`, `%3A` → `:`; pass every other byte through unchanged.

## OpenCode setup

```powershell
.\scripts\install.ps1                  # installs if missing, proxy, registry, Devin setting
.\scripts\install.ps1 -Freellmapi      # ...and add the three FreeLLMAPI models
```

The installer renames the real binary to `opencode-real.exe` and puts the proxy at `opencode.exe`.
That is the only layout that works for both install shapes:

| Layout | Real binary | Proxy finds it via |
| --- | --- | --- |
| V2 standalone | `%APPDATA%\npm\opencode.exe` (≈200 MB) | `opencode-real.exe` beside the proxy |
| npm package | `node_modules\opencode-ai\bin\opencode.exe` | the package path |

Earlier revisions copied the proxy over `opencode.exe` without a backup, which left a V2
install with a proxy that had nothing to forward to. The proxy now also refuses an
`OPENCODE_REAL` that points at itself (that combination recursed).

Registry entry is just `cmd: "opencode.exe"`, `args: ["acp"]` — `archive` is ignored.
Approvals: V2 defaults already allow every action (`{ "action": "*", "resource": "*", "effect": "allow" }`),
so no rule is needed. The V1 key `"permission": { "*": "allow" }` is ignored by V2 — use
`"permissions": [{ "action": "shell", "resource": "*", "effect": "allow" }]` if you want it explicit.

## FreeLLMAPI models

```powershell
.\scripts\setup-freellmapi.ps1 -FreeLLMApiUrl http://127.0.0.1:3001/v1 [-ApiKey freel-xxxx]
```

Adds a `freellmapi` provider to `~/.config/opencode/opencode.jsonc` with three aliases —
`qwen38max` (Qwen3.8 Max / xKiro), `glm53` (GLM-5.3 / UnoRouter), `qwen3827b`
(Qwen3.8 27B / OVH) — each on a different platform, so one provider's 429 does not take
the rest down. Ids are resolved from the live instance and fall back to
`config/freellmapi.json`. Devin shows them as `freellmapi/<alias>` in `/models`.

`scripts/verify-acp.mjs` proves the chain without touching the network: it starts a mock
OpenAI upstream in a temp project, drives `initialize → session/new → set_config_option →
session/prompt`, and checks the model list plus a `%5C` attachment. Run it after any
OpenCode upgrade:

```powershell
node scripts\verify-acp.mjs --proxy "$env:APPDATA\npm\opencode.exe" --opencode "$env:APPDATA\npm\opencode-real.exe"
```

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
- `node scripts/verify-acp.mjs` — initialize → session/new → session/prompt against a mock upstream.
- `OPENCODE_PROXY_LOG` / `CODEBUDDY_PROXY_LOG` tee the JSON-RPC stream.

A one-off `-32603 Internal error: Internal service failure` (`ServiceUnavailableError`) on
`session/new` right after an upgrade is the shared background service restarting — retry, or
`opencode service restart`.

## Files

`proxy/main.go` · `codebuddy/bin-wrapper.js` · `proxy-codebuddy/main.go` · `scripts/install.ps1` · `scripts/install-codebuddy.ps1` · `scripts/setup-freellmapi.ps1` · `scripts/verify-acp.mjs` · `scripts/lib/acp-common.ps1` · `config/freellmapi.json`

> Full long-form version: commit `af11e9f`.
