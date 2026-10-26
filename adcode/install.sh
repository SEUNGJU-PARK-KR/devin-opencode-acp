#!/usr/bin/env bash
# adcode-acp 설치 + Devin Desktop ACP 레지스트리 등록
#
#   ./install.sh              — 빌드 후 registry.json에 ADCode 에이전트 등록
#   ./install.sh --tagflow    — 같은 작업 + 래퍼에 ADCODE_ACP_PROVIDER=tagflow 추가
#
# 등록 후: Devin Settings → Agents 탭 → ADCode 토글 → 재시작
set -euo pipefail
cd "$(dirname "$0")"

PROVIDER="${1:-}"

npm install --no-fund --no-audit
npm run build

ENTRY="$(pwd)/dist/adcode-acp.mjs"
if [ ! -f "$ENTRY" ]; then echo "build failed"; exit 1; fi

# 래퍼 스크립트: 환경 변수를 고정해 registry에서 쓰기 쉽게
WINDOWS=0
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WINDOWS=1 ;; esac

# MSIX(스토어) 설치본은 identity가 Packages\...\LocalCache\Roaming 아래에 생긴다.
IDENTITY_FILE=""
if [ "$WINDOWS" = "1" ]; then
  for d in "$LOCALAPPDATA"/Packages/bluethenics.ADCode_*/LocalCache/Roaming; do
    if [ -f "$d/@adcode/desktop/ads/ads/identity.json" ]; then
      IDENTITY_FILE="$d/@adcode/desktop/ads/ads/identity.json"
      break
    fi
  done
fi

if [ "$WINDOWS" = "1" ]; then
  # .sh는 Windows에서 spawn할 수 없다 — node로 직접 실행되는 .mjs 래퍼
  WRAPPER="$(pwd)/adcode-acp-run.mjs"
  {
    echo "process.env.ADCODE_ACP_PROVIDER ??= \"tagflow\";"
    [ -n "$IDENTITY_FILE" ] && echo "process.env.ADCODE_IDENTITY_FILE ??= \"$(echo "$IDENTITY_FILE" | sed 's/\\/\//g')\";"
    echo "await import(new URL(\"./dist/adcode-acp.mjs\", import.meta.url));"
  } > "$WRAPPER"
else
  WRAPPER="$(pwd)/adcode-acp-run.sh"
  {
    echo "#!/usr/bin/env bash"
    [ "$PROVIDER" = "--tagflow" ] && echo "export ADCODE_ACP_PROVIDER=tagflow"
    echo "exec node \"$ENTRY\""
  } > "$WRAPPER"
  chmod +x "$WRAPPER"
fi

case "$(uname -s)" in
  Linux|Darwin) REGISTRY="$HOME/.windsurf/acp/registry.json" ;;
  MINGW*|MSYS*|CYGWIN*) REGISTRY="$APPDATA/Code/User/acp/registry.json" ;;
  *) REGISTRY="$HOME/.windsurf/acp/registry.json" ;;
esac
mkdir -p "$(dirname "$REGISTRY")"

node - "$REGISTRY" "$WRAPPER" "$WINDOWS" <<'EOF'
const fs = require("fs");
const [registryPath, wrapper, windows] = process.argv.slice(2);
let doc = { version: "1.0.0", agents: [], extensions: [] };
try { doc = JSON.parse(fs.readFileSync(registryPath, "utf8")); } catch {}
doc.agents = (doc.agents ?? []).filter((a) => a.id !== "adcode-acp");
// Windows: spawn a .mjs via node; elsewhere the wrapper is an executable .sh.
const bin =
  windows === "1"
    ? { archive: "", cmd: "node", args: [wrapper.replace(/\\/g, "/")] }
    : { archive: "", cmd: wrapper, args: [] };
doc.agents.push({
  id: "adcode-acp",
  name: "ADCode",
  version: "0.1.0",
  description: "ADCode assistant via adcode-acp adapter",
  authors: ["SEUNGJU-PARK-KR"],
  license: "Apache-2.0",
  distribution: { binary: {
    "linux-x86_64": bin, "linux-aarch64": bin,
    "darwin-aarch64": bin, "darwin-x86_64": bin,
    "windows-x86_64": bin, "windows-aarch64": bin,
  } },
});
fs.writeFileSync(registryPath, JSON.stringify(doc, null, 2));
console.log(`registered adcode-acp in ${registryPath}`);
EOF

echo "done. Devin Settings -> Agents 탭에서 ADCode 토글을 켜고 재시작하세요."
