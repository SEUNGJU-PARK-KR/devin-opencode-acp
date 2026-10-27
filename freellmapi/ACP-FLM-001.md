# FreeLLMAPI ↔ OpenCode ↔ Devin Desktop ACP 연동 기술 보고서

| 항목 | 내용 |
|---|---|
| **DOCUMENT NO.** | ACP-FLM-001 |
| **REVISION** | A |
| **EFFECTIVE DATE** | 2026-10-27 |
| **SUBJECT** | FreeLLMAPI 무료 모델 3종의 OpenCode ACP 경유 Devin Desktop 연결 |
| **PREPARED BY** | SEUNGJU PARK |
| **STATUS** | INTERNAL — CONTROLLED COPY (출력본은 통제 불가) |
| **APPLICABILITY** | Windows 10/11 x64, Devin Desktop, OpenCode v2.0.x, FreeLLMAPI 자체 호스팅 |

---

## RECORD OF REVISIONS

| REV | DATE | DESCRIPTION | AUTHOR |
|---|---|---|---|
| A | 2026-10-27 | 최초 발행. ACP 적용 한계, 모델 기준선, 결함 5건 및 시정조치, 검증 결과 수록 | SEUNGJU PARK |

---

## CONTENTS

- 1.0 PURPOSE
- 2.0 SCOPE
- 3.0 REFERENCES
- 4.0 ABBREVIATIONS
- 5.0 SYSTEM DESCRIPTION
- 6.0 TECHNICAL FINDINGS
- 7.0 MODEL BASELINE
- 8.0 CONFIGURATION
- 9.0 DEFECTS AND CORRECTIVE ACTIONS
- 10.0 VERIFICATION
- 11.0 OPERATING PROCEDURES
- 12.0 OPEN ITEMS
- 13.0 RECOMMENDATIONS
- APPENDIX A — FILE MANIFEST
- APPENDIX B — PARAMETERS AND ENVIRONMENT
- APPENDIX C — GLOSSARY

---

## 1.0 PURPOSE

1.1 본 문서는 FreeLLMAPI가 제공하는 무료 모델을 OpenCode를 경유하여 Devin Desktop의 ACP 에이전트로 사용하기 위한 구성, 제약, 결함 시정 및 검증 결과를 기록한다.

1.2 본 문서는 다음 질문에 대한 기술적 판정을 포함한다.

| 질의 | 판정 |
|---|---|
| FreeLLMAPI를 OpenCode처럼 ACP로 직접 연결할 수 있는가 | **불가 (6.1 참조)** |
| ACP로 연결되는 주체는 무엇인가 | OpenCode (에이전트). FreeLLMAPI는 모델 백엔드 |
| FreeLLMAPI를 상시 기동해야 하는가 | **예 (6.3 참조)** |
| Devin 기동 시 FreeLLMAPI를 자동 spawn할 수 있는가 | 간접적으로 가능. Devin 자체 훅은 없음 (6.3.3 참조) |

---

## 2.0 SCOPE

2.1 포함 범위

- OpenCode v2.0.30, Devin Desktop ACP 레지스트리/설정, `%5C` URI 결함 대응 프록시
- FreeLLMAPI 무료 모델 3종의 선정 기준, 사용량 한도, OpenCode provider 구성
- 설치 스크립트 결함 5건의 시정 및 시험 결과

2.2 제외 범위

- FreeLLMAPI 서버 자체의 설치·키 등록 절차 (미완료, 12.0 참조)
- CodeBuddy Code, ADCode 경로 (본 보고서 대상 외)
- 유료 모델 및 유료 게이트웨이

---

## 3.0 REFERENCES

| NO. | DOCUMENT | REMARKS |
|---|---|---|
| 3.1 | `tashfeenahmed/freellmapi` (MIT) | 카탈로그 피드 `api.freellmapi.co/v1/latest`, v2026.10.25, 444 모델 |
| 3.2 | OpenCode V2 Docs — Config / Providers / Models / Permissions | `opencode.ai/v2/docs/*` |
| 3.3 | Agent Client Protocol | JSON-RPC 2.0 over stdio |
| 3.4 | Artificial Analysis Intelligence Index | 모델 품질 기준선 |
| 3.5 | `SEUNGJU-PARK-KR/devin-opencode-acp` | 본 문서가 수록된 저장소 |

---

## 4.0 ABBREVIATIONS

| 약어 | 의미 |
|---|---|
| ACP | Agent Client Protocol — 클라이언트(에디터)가 에이전트를 spawn하는 프로토콜 |
| AII | Artificial Analysis Intelligence Index |
| RPM / RPD | Requests Per Minute / Per Day |
| TPM / TPD | Tokens Per Minute / Per Day |
| SSE | Server-Sent Events |
| URI | Uniform Resource Identifier |

---

## 5.0 SYSTEM DESCRIPTION

### 5.1 구성도

```
┌─────────────────┐   spawn    ┌──────────────────────────────┐
│ Devin Desktop   │───────────>│ opencode.exe  (ACP 프록시)    │
│ (ACP Client)    │  JSON-RPC  │  · file:// URI 정규화         │
│                 │<──────────>│  · opencode-real.exe 위임     │
└─────────────────┘   stdio    └──────────────┬───────────────┘
                                              │ spawn
                                              v
                               ┌──────────────────────────────┐
                               │ opencode-real.exe v2.0.30    │
                               │  · 에이전트 루프 / 툴 실행     │
                               └──────────────┬───────────────┘
                                              │ HTTP (OpenAI 호환)
                                              v
                               ┌──────────────────────────────┐
                               │ FreeLLMAPI  127.0.0.1:3001   │
                               │  · 라우팅 / 폴백 / 한도 추적   │
                               └──────────────┬───────────────┘
                                              │ HTTPS
                                              v
                     xKiro / UnoRouter / OVH  (무료 티어)
```

### 5.2 프로세스 모델

| 프로세스 | 기동 주체 | 수명 | 비고 |
|---|---|---|---|
| `opencode.exe acp` (프록시) | Devin | Devin 창/세션 수명 | ACP 진입점. 파일 실체 3.2 MB |
| `opencode-real.exe` | 프록시 | 프록시 수명 | 실제 에이전트. 203.6 MB |
| `opencode.exe serve --stdio` | 에이전트 | 세션 수명 | 세션 서버 |
| `opencode.exe serve` (공용) | 터미널 | 독립 | 백그라운드 서비스, 포트 동적 |
| FreeLLMAPI | **수동 또는 자동화 필요** | 독립 | 6.3 참조 |

> **NOTE** — 프로세스명만으로 프록시/실체를 구분할 수 없다. 판별은 `ExecutablePath`와 부모 PID로 한다.
> 프록시가 물린 상태에서는 `opencode-real.exe`가 `opencode.exe`의 **자식**으로 나타난다.

---

## 6.0 TECHNICAL FINDINGS

### 6.1 ACP 적용 한계 — 핵심 판정

> **WARNING** — FreeLLMAPI를 ACP 에이전트로 등록하는 구성은 **성립하지 않는다.** 시도할 경우 Devin은 응답 없는 에이전트를 spawn하고, 세션은 초기화 단계에서 정지한다.

6.1.1 ACP는 *에이전트*를 연결하는 프로토콜이다. 클라이언트는 `initialize → session/new → session/prompt` 순으로 요청하고, 에이전트는 툴 호출·파일 편집·턴 종료 판정을 포함한 **자체 루프**를 수행해야 한다.

6.1.2 FreeLLMAPI는 *모델 게이트웨이*다. OpenAI 호환 `/v1/chat/completions`를 중계하고 라우팅·폴백·쿼터를 관리할 뿐, 툴 실행 루프나 세션 상태를 갖지 않는다.

6.1.3 따라서 역할은 다음과 같이 고정된다.

| 계층 | 담당 | 프로토콜 |
|---|---|---|
| 에이전트 | OpenCode | ACP (stdio JSON-RPC) |
| 모델 백엔드 | FreeLLMAPI | HTTP (OpenAI 호환) |
| 제공자 | xKiro / UnoRouter / OVH | HTTPS |

6.1.4 결과적으로 "FreeLLMAPI를 ACP로 붙인다"는 표현은 **"OpenCode를 ACP로 붙이고, 그 모델 공급원을 FreeLLMAPI로 둔다"**로 정정되어야 한다.

### 6.2 `%5C` URI 결함

6.2.1 Devin은 파일 첨부를 `resource_link` 블록으로 전송하며, URI가 `file:///C%3A%5Cdir%5Cfile.ts` 형태로 퍼센트 인코딩된 역슬래시를 포함한다.

6.2.2 시험 결과, 증상이 버전에 따라 변하였다.

| 대상 | 증상 | 결과 |
|---|---|---|
| OpenCode 1.x | `ERR_INVALID_FILE_URL_PATH` → `-32603 Internal error` | 프롬프트 전체 실패 |
| **OpenCode 2.0.30** | 오류 없음. 첨부가 **조용히 누락** | 모델이 파일 내용을 보지 못함 |
| CodeBuddy Code | URI가 basename으로 붕괴 → `File does not exist` | 읽기 실패 |

> **CAUTION** — 2.x에서는 오류가 발생하지 않으므로 결함이 없는 것으로 오인하기 쉽다. 첨부 누락은 응답 품질 저하로만 나타난다.

6.2.3 A/B 시험 (동일 프롬프트, 동일 파일)

| 구성 | 파일 내용 전달 |
|---|---|
| 프록시 미적용 | 미전달 |
| 프록시 적용 | **전달** |

6.2.4 시정: 프록시가 stdin의 `file://` 구간에서 `%5C`/`%2F` → `/`, `%3A` → `:`로 치환하고 나머지 바이트는 그대로 통과시킨다.

### 6.3 게이트웨이 상주 요건

6.3.1 FreeLLMAPI는 클라우드 서비스가 아니라 로컬 프로세스다. `127.0.0.1:3001`이 열려 있지 않으면 OpenCode의 `freellmapi/*` 모델 요청은 `connection refused`로 실패한다.

6.3.2 확인된 초기 상태 (REV A 시점)

| 항목 | 상태 |
|---|---|
| 포트 3001 | 폐쇄 |
| FreeLLMAPI 설치 | 미실시 |
| Docker / PM2 | 미설치 |

6.3.3 자동 기동 훅 가용성

| 훅 | 시점 | 제약 |
|---|---|---|
| 프록시 (`opencode.exe`) | Devin이 ACP 세션 시작 시 | Devin 미사용 시 미기동 |
| Windows 로그온 작업 | 로그인 시 | 상시 상주 (≈40 MB) |
| 수동 | 임의 | 운용 부담 |

> **NOTE** — Devin 애플리케이션 자체에는 시작 훅이 없다. 통제 가능한 지점은 자식 프로세스인 ACP 진입점 또는 OS 수준 자동 시작뿐이다.

---

## 7.0 MODEL BASELINE

### 7.1 선정 기준

7.1.1 기준선은 DeepSeek V4.1 Flash (AII 45, 1017 스냅샷)로 설정하였다.

7.1.2 요구조건

| 우선순위 | 조건 |
|---|---|
| 1 | 일일 호출/토큰 상한이 없거나 충분히 큼 |
| 2 | 분당 1회 제한은 허용 |
| 3 | 품질은 기준선 대비 소폭 저하 허용 |
| 4 | 서로 다른 플랫폼에 분산 (단일 제공자 장애 격리) |

### 7.2 적용 모델

| 별칭 | 제공자 / 모델 | AII | 컨텍스트 | 역할 |
|---|---|---|---|---|
| `freellmapi/qwen38max` | xKiro / Qwen3.8 Max | 45 | 1,000,000 | 주력 (기본값) |
| `freellmapi/glm53` | UnoRouter / GLM-5.3 | 45 | 1,000,000 | 병렬·동시성 보조 |
| `freellmapi/qwen3827b` | OVH / Qwen3.8 27B | 34 | 262,144 | 용량 백스톱 |

### 7.3 사용량 한도

| 모델 | RPM | RPD | TPD | 비고 |
|---|---|---|---|---|
| Qwen3.8 Max (xKiro) | 제한 없음 | — | 약 5M (계정 공유) | 카탈로그 표기 1M/일과 문서 표기 5M/일 불일치 |
| GLM-5.3 (UnoRouter) | **1** | — | — | 일일 총량 상한 없음. `:free` 계정 풀 공유 |
| Qwen3.8 27B (OVH) | **2** | — | — | IP 기준, 일일 상한 없음 |

> **CAUTION** — UnoRouter `:free`는 분당 계정 단위 공유 상한을 갖는다. 동일 제공자의 모델을 여러 개 물려도 상한이 합산되지 않는다.

---

## 8.0 CONFIGURATION

### 8.1 파일 배치

| 경로 | 역할 |
|---|---|
| `config/freellmapi.json` | 모델 정의(별칭·한도·ID 매칭 규칙) |
| `scripts/setup-freellmapi.ps1` | provider 구성 + 프록시 + 레지스트리 + 검증 |
| `scripts/verify-acp.mjs` | 목 업스트림 기반 ACP 전 구간 시험 |
| `scripts/lib/acp-common.ps1` | 바이너리 탐색, 안전한 프록시 배치, 설정 병합 |
| `%USERPROFILE%\.config\opencode\opencode.jsonc` | 런타임 provider 구성 |
| `%APPDATA%\Code\User\acp\registry.json` | Devin ACP 레지스트리 |
| `%APPDATA%\Devin\User\settings.json` | `devin.acp.enabledAgents` |

### 8.2 OpenCode provider 구성 (요지)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "freellmapi/qwen38max",
  "providers": {
    "freellmapi": {
      "name": "FreeLLMAPI",
      "env": ["FREELMAPI_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:3001/v1" },
      "models": {
        "qwen38max":  { "modelID": "qwen/qwen3.8-max:free", "limit": { "context": 1000000, "output": 32768 } },
        "glm53":      { "modelID": "glm-5.3:free",          "limit": { "context": 1000000, "output": 32768 } },
        "qwen3827b":  { "modelID": "Qwen3.8-27B",           "limit": { "context": 262144,  "output": 16384 } }
      }
    }
  }
}
```

> **NOTE** — 모델 식별자는 `modelID`가 아니라 `models` 맵의 **키**로 선택된다(`freellmapi/<키>`). FreeLLMAPI 인스턴스의 실제 ID는 `/v1/models?available=true`에서 조회하며, 미기동 시 `config/freellmapi.json` 값으로 대체된다.

### 8.3 프록시 배치

| 레이아웃 | 실체 위치 | 프록시 탐색 경로 |
|---|---|---|
| OpenCode 2.x 단독 | `%APPDATA%\npm\opencode.exe` → `opencode-real.exe`로 개명 | 동일 디렉터리의 `opencode-real.exe` |
| npm 패키지 | `node_modules\opencode-ai\bin\opencode.exe` | 패키지 경로 |

> **WARNING** — 프록시를 실체 위에 백업 없이 덮어쓰면 에이전트가 기동되지 않는다. 반드시 실체를 보존한 후 배치한다.

---

## 9.0 DEFECTS AND CORRECTIVE ACTIONS

| NO. | 결함 | 원인 | 시정 | 시험 |
|---|---|---|---|---|
| 9.1 | 설치 스크립트가 OpenCode를 무력화 | 프록시를 `opencode.exe`에 무백업 덮어쓰기. V2 레이아웃에는 전달 대상 없음 | 실체를 `opencode-real.exe`로 이동 후 프록시 배치, 스모크 실패 시 자동 복구 | `--version` 정상, 자식 `opencode-real.exe` 확인 |
| 9.2 | 기존 설치 강제 다운그레이드 | `npm i -g opencode-ai@1.18.35` 무조건 실행 | 설치 부재 시에만 설치, 버전 고정 제거 | 기존 v2.0.30 유지 확인 |
| 9.3 | 프록시 자기참조 무한 재귀 | `OPENCODE_REAL`이 프록시 자신을 지시 | 자기참조 감지 후 무시 | `initialize` 45 s 타임아웃 → 2 s 내 응답 |
| 9.4 | `adcode` 타입검사 무효 | `tsconfig.json` 부재로 `tsc`가 도움말만 출력 | tsconfig 추가, 타입 오류 2건 및 `@types/picomatch` 보완 | `npm run typecheck` 통과 |
| 9.5 | PS 5.1 선언 스크립트에 PS7 전용 문법 | 삼항 연산자 사용 | 분기문으로 치환 | 스크립트 실행 정상 |
| 9.6 | 문서화된 증상과 실제 불일치 | 2.x에서 `-32603`이 아닌 무음 누락 | SKILL/README 정정, A/B 시험 근거 수록 | 10.2 참조 |

---

## 10.0 VERIFICATION

### 10.1 시험 방법

10.1.1 `scripts/verify-acp.mjs`는 네트워크·실키 없이 다음을 수행한다.

1. 임시 프로젝트에 `opencode.json`(freellmapi provider, 목 업스트림) 생성
2. 목 OpenAI 호환 서버 기동 (`/v1/models`, `/v1/chat/completions` SSE)
3. `opencode acp`(또는 프록시) 기동 후 `initialize → session/new → session/set_config_option → session/prompt` 수행
4. 모델 목록, 기본값, 전환, `%5C` 첨부 전달 여부 판정

### 10.2 시험 결과

| 순번 | 항목 | 기준 | 결과 |
|---|---|---|---|
| 1 | initialize | 응답 수신 | PASS |
| 2 | model list | 3개 별칭 노출 | PASS |
| 3 | default model | `freellmapi/qwen38max` | PASS |
| 4 | model switching | 3개 전환 일치 | PASS |
| 5 | file attachment (`%5C`) | 파일 내용 전달 | PASS (프록시 적용 시) / FAIL (미적용 시) |
| 6 | ACP protocol error | `-32603` 부재 | PASS |

소요 시간 2.0 s, 6/6 통과.

### 10.3 판정

> **NOTE** — REV A 시점의 구성은 시험 항목 전부를 만족한다. 단, 5번 항목은 **프록시 경유 시에만** 성립하며, 프록시 미적용 구성은 동일 시험에서 FAIL로 판정된다.

---

## 11.0 OPERATING PROCEDURES

### 11.1 정상 운용

| 단계 | 조작 | 확인 |
|---|---|---|
| 1 | FreeLLMAPI 기동 | `127.0.0.1:3001` 응답 |
| 2 | Devin Reload Window | ACP 프로세스 재기동 |
| 3 | 새 대화에서 OpenCode 선택 | 모델 목록에 `freellmapi/*` 표시 |
| 4 | `/models`에서 대상 선택 | 기본값 `qwen38max` |

### 11.2 이상 상태

| 증상 | 원인 | 조치 |
|---|---|---|
| `connection refused` | 게이트웨이 미기동 | FreeLLMAPI 기동 또는 자동화 적용 (12.1) |
| 모델 목록에 `freellmapi` 없음 | config 미반영 / provider 비활성 | `setup-freellmapi.ps1` 재실행, Devin 재기동 |
| 첨부가 모델에 전달되지 않음 | 프록시 미적용 | `opencode-real.exe` 자식 존재 확인, 재설치 |
| `-32603 ServiceUnavailableError` | 공용 서비스 재시작 중 | 재시도 또는 `opencode service restart` |

### 11.3 복구 (롤백)

| 대상 | 조작 |
|---|---|
| 프록시 제거 | `opencode.exe` 삭제 후 `opencode-real.exe`를 `opencode.exe`로 개명 |
| provider 제거 | `opencode.jsonc`에서 `providers.freellmapi` 및 `model` 항목 삭제 |
| Devin 등록 해제 | `devin.acp.enabledAgents.opencode = false` |

---

## 12.0 OPEN ITEMS

| NO. | 항목 | 상태 | 비고 |
|---|---|---|---|
| 12.1 | FreeLLMAPI 설치 및 제공자 키 등록 | **미완료** | 본 문서 작성 시점 미설치 |
| 12.2 | 게이트웨이 자동 기동(프록시 훅) | 미구현 | 설계만 완료 (6.3.3) |
| 12.3 | 실게이트웨이 연동 시험 | 미실시 | 목 업스트림으로만 검증 |
| 12.4 | 다중 ACP 프로세스 동시 기동 시 포트 경합 | 미검증 | 포트 검사로 회피 예정 |

---

## 13.0 RECOMMENDATIONS

13.1 FreeLLMAPI 설치 후 `/v1/models?available=true`로 실제 모델 ID를 재해석하고 `setup-freellmapi.ps1`을 재실행할 것을 권고한다.

13.2 게이트웨이 상주 부담을 줄이려면 프록시 훅(지연 기동, detach) 방식을, 무조건 가용성을 원하면 Windows 로그온 작업 방식을 적용한다. 두 방식을 동시에 적용할 경우 포트 검사로 중복 기동을 방지한다.

13.3 OpenCode 업그레이드 시마다 `verify-acp.mjs`를 실행하여 `%5C` 결함의 재발 및 모델 노출 여부를 확인한다.

13.4 무료 티어는 제공자 정책에 따라 예고 없이 변경된다. 한도 값은 3개월 주기로 재확인할 것을 권고한다.

---

## APPENDIX A — FILE MANIFEST

| 파일 | 기능 |
|---|---|
| `config/freellmapi.json` | 모델 정의 및 ID 매칭 규칙 |
| `scripts/setup-freellmapi.ps1` | 통합 설치 (provider·프록시·레지스트리·검증) |
| `scripts/install.ps1` | OpenCode ACP 설치 (결함 9.1~9.3 시정 반영) |
| `scripts/verify-acp.mjs` | ACP 시험 하네스 |
| `scripts/lib/acp-common.ps1` | 공통 함수 (탐색·배치·병합) |
| `proxy/main.go` | stdio URI 정규화 프록시 |

## APPENDIX B — PARAMETERS AND ENVIRONMENT

| 변수 | 기본값 | 설명 |
|---|---|---|
| `FREELMAPI_API_KEY` | (없음) | 게이트웨이 통합 키. 미설정 시 `-ApiKey`로 파일 저장 |
| `FREELMAPI_BASE_URL` | `http://127.0.0.1:3001/v1` | 게이트웨이 엔드포인트 |
| `OPENCODE_REAL` | (자동 탐색) | 프록시가 위임할 실체 경로 |
| `OPENCODE_PROXY_LOG` | (없음) | JSON-RPC 스트림 기록 경로 |

## APPENDIX C — GLOSSARY

| 용어 | 정의 |
|---|---|
| ACP | 클라이언트가 에이전트 프로세스를 spawn하여 JSON-RPC로 제어하는 프로토콜 |
| 게이트웨이 | 다수 제공자의 API를 단일 엔드포인트로 중계하는 서버 |
| 프록시 (본 문서) | stdin의 URI를 정규화한 뒤 실체 프로세스에 위임하는 중간 실행 파일 |
| 목 업스트림 | 시험용으로 대체 투입되는 OpenAI 호환 서버 |

---

*END OF DOCUMENT — ACP-FLM-001 REV A*
