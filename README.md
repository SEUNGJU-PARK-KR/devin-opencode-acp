# devin-opencode-acp

Run [OpenCode](https://opencode.ai), [CodeBuddy Code](https://www.codebuddy.ai)
(WorkBuddy) and [ADCode](https://github.com/bluethenics/adcode) inside
[Devin Desktop](https://devin.ai)'s Agent Command Center on Windows —
including fixes for the `file:///C%3A%5C...` URI bug that breaks prompts carrying file
context in **both** agents (opencode crashes with `Internal error`; CodeBuddy reads the
wrong path and reports `File does not exist`).

See **[SKILL.md](SKILL.md)** for the full guide. Quick paths: `scripts/install.ps1`
(OpenCode), `scripts/install-codebuddy.ps1` (CodeBuddy),
`scripts/setup-freellmapi.ps1` (three free FreeLLMAPI models in the OpenCode picker).

## Contents

- `SKILL.md` — Devin skill: setup steps, registry/settings format, the `%5C` bug, debugging
- `proxy/main.go` — stdio proxy for opencode that sanitizes `file://` URIs on the ACP stream
- `codebuddy/bin-wrapper.js` — drop-in `bin/codebuddy` patch applying the same fix to CodeBuddy
- `proxy-codebuddy/main.go` — standalone proxy alternative for CodeBuddy (separate agent id)
- `scripts/install.ps1` — installs opencode, builds + deploys the proxy, writes config
- `scripts/install-codebuddy.ps1` — installs codebuddy-code, patches `bin/codebuddy`, enables the agent
- `scripts/setup-freellmapi.ps1` — fronts OpenCode with the proxy and adds a `freellmapi`
  provider so three free models show up in Devin's model picker
- `scripts/verify-acp.mjs` — end-to-end ACP check against a mock upstream (no network, no
  real keys); asserts the model list, model switching, and `%5C` attachments
- `scripts/lib/acp-common.ps1` — shared installer helpers (binary discovery, safe proxy
  deploy, registry + Devin settings merge)
- `config/freellmapi.json` — the three models, their aliases, limits, and id-match patterns
- `adcode/` — standalone ACP adapter wrapping ADCode's assistant (`@adcode/ai` vendored):
  model dropdown, `/compact`, permission prompts, `ask_user` elicitation, tagflow free
  models via ADCode sign-in. `cd adcode && ./install.sh --tagflow`

## FreeLLMAPI models

`scripts/setup-freellmapi.ps1` wires three models from a local
[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) instance into OpenCode, and
therefore into Devin:

| Alias | Upstream model | Why |
| --- | --- | --- |
| `freellmapi/qwen38max` | Qwen3.8 Max (xKiro) | best free quality, ~5M tokens/day account pool |
| `freellmapi/glm53` | GLM-5.3 (UnoRouter) | same quality, 1 req/min, no daily token cap |
| `freellmapi/qwen3827b` | Qwen3.8 27B (OVH) | 2 req/min, no daily cap, used as the volume backstop |

They sit on three independent platforms, so one provider's 429 does not take the others
down. Model ids are resolved from the running instance (`/v1/models?available=true`) and
fall back to `config/freellmapi.json` when it is offline.

```powershell
.\scripts\setup-freellmapi.ps1                       # proxy + provider + registry + verify
.\scripts\setup-freellmapi.ps1 -ApiKey freel-xxxx     # store the unified key in a file
.\scripts\setup-freellmapi.ps1 -SkipProxy             # config only, no %5C fix
```

Verification runs on every install:

```
PASS  initialize
PASS  model list                 3 FreeLLMAPI models
PASS  default model              freellmapi/qwen38max
PASS  model switching
PASS  file attachment (%5C URI)
PASS  no ACP protocol errors
```
