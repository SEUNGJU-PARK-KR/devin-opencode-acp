# devin-opencode-acp

Run [OpenCode](https://opencode.ai) inside [Devin Desktop](https://devin.ai)'s Agent Command
Center on Windows — including a fix for the `Internal error: OpenCode service failure`
that hits any prompt carrying file context (`file:///C%3A%5C...` URIs crash
`fileURLToPath` on Windows).

See **[SKILL.md](SKILL.md)** for the full guide. Quick path: `scripts/install.ps1`.

## Contents

- `SKILL.md` — Devin skill: setup steps, registry/settings format, the `%5C` bug, debugging
- `proxy/main.go` — stdio proxy that sanitizes `file://` URIs on the ACP stream
- `scripts/install.ps1` — installs opencode, builds + deploys the proxy, writes config
