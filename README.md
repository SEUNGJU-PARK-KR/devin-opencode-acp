# devin-opencode-acp

Run [OpenCode](https://opencode.ai), [CodeBuddy Code](https://www.codebuddy.ai)
(WorkBuddy) and [ADCode](https://github.com/bluethenics/adcode) inside
[Devin Desktop](https://devin.ai)'s Agent Command Center on Windows —
including fixes for the `file:///C%3A%5C...` URI bug that breaks prompts carrying file
context in **both** agents (opencode crashes with `Internal error`; CodeBuddy reads the
wrong path and reports `File does not exist`).

See **[SKILL.md](SKILL.md)** for the full guide. Quick paths: `scripts/install.ps1`
(OpenCode), `scripts/install-codebuddy.ps1` (CodeBuddy).

## Contents

- `SKILL.md` — Devin skill: setup steps, registry/settings format, the `%5C` bug, debugging
- `proxy/main.go` — stdio proxy for opencode that sanitizes `file://` URIs on the ACP stream
- `codebuddy/bin-wrapper.js` — drop-in `bin/codebuddy` patch applying the same fix to CodeBuddy
- `proxy-codebuddy/main.go` — standalone proxy alternative for CodeBuddy (separate agent id)
- `scripts/install.ps1` — installs opencode, builds + deploys the proxy, writes config
- `scripts/install-codebuddy.ps1` — installs codebuddy-code, patches `bin/codebuddy`, enables the agent
- `adcode/` — standalone ACP adapter wrapping ADCode's assistant (`@adcode/ai` vendored):
  model dropdown, `/compact`, permission prompts, `ask_user` elicitation, tagflow free
  models via ADCode sign-in. `cd adcode && ./install.sh --tagflow`
