# adcode-acp

[ADCode](https://github.com/bluethenics/adcode)의 어시스턴트(`@adcode/ai` 에이전트 루프)를
[ACP(Agent Client Protocol)](https://agentclientprotocol.com) 서버로 감싼 어댑터.
Devin Desktop 같은 ACP 클라이언트의 에이전트 선택지에 **ADCode**를 띄우는 게 목적이다.

## 동작 방식

```
Devin Desktop ──(ACP, stdio JSON-RPC)──> adcode-acp ──> @adcode/ai createAgent
                                                      ├─ provider: OpenAI-compatible endpoint
                                                      └─ tools: read_file / edit_file / run_command / ... (headless ToolRunner)
```

- `vendor/adcode-ai/` — ADCode `packages/ai` 소스를 Apache-2.0 라이선스로 벤더링
  (`anthropic`/`google` 프로바이더 파일만 제외. `agent.ts`에 TS narrowing 캐스트 1줄 패치)
- `src/tools-runner.ts` — 내장 툴의 headless 구현. 브라우저(view_page, open_preview, audit_page),
  팀/메모리 툴은 "사용 불가" 에러를 정직하게 반환해 모델이 우회하도록 함

## 지원하는 ACP 기능

- **모델 선택** — `session/new` 응답의 `configOptions`로 모델 드롭다운 제공,
  `session/set_config_option`으로 전환 시 대화 유지한 채 모델 교체
- **`/compact`** — 슬래시 명령(`available_commands_update`) + 자동 압축: 요청이 모델
  context window의 80%를 넘기 전에 오래된 대화를 요약하고, HTTP 413이 오면 compact 후 재시도
- **권한 승인** — `edit_file`/`propose_edit`/`move_file`/`delete_file`/`run_command` 실행 전
  `session/request_permission`(Allow/Always allow/Deny). 클라이언트 미지원 시 fail-open
- **`ask_user`** — `elicitation/create` 폼 카드로 질문 (최대 4개, 옵션은 드롭다운)
- **`usage_update`** — 컨텍스트 사용량/윈도우 크기를 매 요청마다 전송
- **`terminal_output`** — 명령 계열 툴 결과에 인라인 출력 메타데이터

### Windows 노트

- 레지스트리 경로: `%APPDATA%\Code\User\acp\registry.json`
- `install.sh`는 Windows에서 `.mjs` 래퍼를 만들고 `cmd: "node"` + `args`로 등록
  (`.sh`는 spawn 불가)
- Microsoft Store(MSIX) 설치본은 identity가
  `%LOCALAPPDATA%\Packages\bluethenics.ADCode_*\LocalCache\Roaming\@adcode\desktop\ads\ads\identity.json`에
  생기는데, `install.sh`가 이를 찾아 래퍼에 `ADCODE_IDENTITY_FILE`로 고정한다
- `run_command`는 Git Bash가 있으면 `cmd.exe` 대신 사용 (unix 명령 호환)

## 필요 환경

- Node.js 20+
- OpenAI-compatible 엔드포인트 (Ollama, LM Studio, vLLM, OpenRouter, freellmapi 등)

## 설정

| 환경 변수 | 설명 | 기본값 |
|---|---|---|
| `ADCODE_ACP_PROVIDER` | `tagflow`이면 무료 Included AI 사용 | 커스텀 엔드포인트 모드 |
| `ADCODE_ACP_MODEL` | 모델 id (커스텀 모드 필수, tagflow는 선택) | — |
| `ADCODE_ACP_BASE_URL` | OpenAI-compatible base URL | `http://127.0.0.1:11434/v1` |
| `ADCODE_ACP_API_KEY` | Bearer 토큰 (선택) | 없음 |
| `ADCODE_ACP_PROVIDER_NAME` | 표시 이름 | base URL 값 |

### 무료 Included AI (Tagflow)

`ADCODE_ACP_PROVIDER=tagflow`로 ADCode의 무료 모델 4개를 그대로 쓴다:
`tagflow-code-27b` (기본), `heabsy-qwen38`, `heabsy-glm53-flash-unc`, `heabsy-mimo-v26-flash`.

- **ADCode 계정 필요** — ADCode 앱에서 한 번 로그인하면 생기는 identity 파일
  (`~/.config/ADCode/ads/ads/identity.json`)을 읽어 Firebase 토큰을 직접 갱신한다.
  갱신으로 회전된 refresh token은 같은 파일에 다시 써서 ADCode 로그인이 끊기지 않게 한다.
- `ADCODE_ACP_MODEL`로 모델 선택, 생략 시 릴레이 기본 모델.
- 계정 없이 쓰려면 위의 OpenAI-compatible 모드로.

## 빌드 + 등록 (한 번에)

```bash
./install.sh            # 빌드 + ~/.windsurf/acp/registry.json에 ADCode 에이전트 등록
./install.sh --tagflow  # 무료 Included AI 모드로 등록 (ADCode 로그인 필요)
```

수동으로는 `npm install && npm run build` → `dist/adcode-acp.mjs`.
(`npm run build`는 `build.mjs` — esbuild API. OS 무관하게 동작)

## Devin Desktop에 등록 (수동)

`~/.windsurf/acp/registry.json` (Windows: `%USERPROFILE%\AppData\Roaming\Code\User\acp\registry.json`):

```json
{
  "version": "1.0.0",
  "agents": [
    {
      "id": "adcode-acp",
      "name": "ADCode",
      "version": "0.1.0",
      "description": "ADCode assistant via adcode-acp adapter",
      "distribution": {
        "binary": {
          "linux-x86_64": { "archive": "", "cmd": "node", "args": ["/path/to/adcode-acp/dist/adcode-acp.mjs"] },
          "linux-aarch64": { "archive": "", "cmd": "node", "args": ["/path/to/adcode-acp/dist/adcode-acp.mjs"] },
          "darwin-aarch64": { "archive": "", "cmd": "node", "args": ["/path/to/adcode-acp/dist/adcode-acp.mjs"] },
          "darwin-x86_64": { "archive": "", "cmd": "node", "args": ["/path/to/adcode-acp/dist/adcode-acp.mjs"] },
          "windows-x86_64": { "archive": "", "cmd": "node", "args": ["C:\\path\\to\\adcode-acp\\dist\\adcode-acp.mjs"] }
        }
      }
    }
  ],
  "extensions": []
}
```

환경 변수는 `args` 대신 프로필/쉘에서 설정하거나, 래퍼 스크립트로 감싼다.
그 다음 Devin Settings → Agents 탭에서 ADCode 토글 ON → 재시작 → 새 대화의 에이전트 선택지에 나타난다.

## 검증

```bash
node test/mock-server.mjs &   # :11434에 OpenAI SSE 모의 서버
ADCODE_ACP_MODEL=mock-model node dist/adcode-acp.mjs
# stdin으로 initialize → session/new → session/prompt JSON-RPC 라인을 넣으면
# agent_message_chunk / tool_call / tool_call_update 스트림과 stopReason이 나온다.
```

## 한계 / TODO

- `session/load` — 미지원 (loadSession: false). 지난 대화 재오픈 불가
- `terminal/*` 클라이언트 메서드 — `run_command`는 로컬 spawn (클라이언트 터미널 미사용)
- 멀티루트 workspace (`/add-dir` 계열) — 단일 root만 지원
- 세션 모드 — ADCode 에이전트에 모드 개념이 없음
- 팀 에이전트, 프로젝트 메모리 — 미연결
