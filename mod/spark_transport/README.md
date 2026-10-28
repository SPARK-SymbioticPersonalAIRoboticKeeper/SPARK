# spark_transport — MCP Local Execution Server

[SPARK 개요](../../README.md) · [전체 설치 가이드](../../doc/TRANSPORT.md) · [아키텍처](../../doc/ARCH.md)

## 1. 목적

**spark_transport**는 Model Context Protocol(MCP) 서버로, ChatGPT Plugin을 통해 Windows의 승인된 파일·명령 도구를 제공합니다. 사용자 PC에서 Loopback MCP 서버를 실행하고 OpenAI Secure MCP Tunnel로 원격 요청을 수신합니다.

~~~mermaid
flowchart LR
  Plugin["ChatGPT Plugin"] <-->|"MCP"| Tunnel["Secure MCP Tunnel"]
  Tunnel <--> Server["spark_transport : MCP/HTTP"]
  Server --> Policy["Allowed Roots + Bearer"]
  Policy --> FS["Windows 파일 / 명령"]
~~~

## 2. 주요 구성

| 경로 | 책임 |
|---|---|
| `src/server.mjs` / `src/mcp.mjs` | HTTP/MCP 요청 처리 |
| `src/auth.mjs` / `src/auth-cli.mjs` | Access Token 검증·발급 |
| `src/path-policy.mjs` / `src/file-pal.mjs` | 허용 Root, 작업별 파일 권한 |
| `src/command-runner.mjs` | 명령 실행 및 제한 시간 |
| `src/recycle-bin.mjs` | 휴지통 이동 |
| `src/operation-runtime.mjs` / `src/ledger.mjs` | 작업 상태·분할 실행·추적 |
| `src/tools.mjs` | MCP 도구 10개 등록 |
| `script/bootstrap-tunnel.ps1` | 검증된 Tunnel Client 준비 |
| `script/validate-windows.ps1` | 전용 테스트 작업 공간 검증 |
| `config/spark.example.json` | 비밀정보가 없는 설정 예제 |

## 3. MCP 도구

| 도구 이름 | 용도 |
|---|---|
| `list_directory` | 디렉터리 항목 목록 |
| `read_file` | UTF-8 파일 읽기 |
| `create_file` | 새 파일 생성 |
| `write_file` | 기존 파일 교체 |
| `modify_file` | 문자열의 정확한 단일 치환 |
| `create_directory` | 디렉터리 생성 |
| `copy_path` | 파일·폴더 복사 |
| `move_path` | 이름 변경·이동 |
| `delete_path` | Windows 휴지통 이동 |
| `run_command` | 비관리자 명령 실행 |

도구별 실제 인수는 `src/tools.mjs`와 `src/mcp.mjs`의 등록 정의를 기준으로 합니다. Root 권한의 R/W/X 조합과 원복 정책은 작업별로 검사합니다.

## 4. 설치 및 점검

새 Windows 환경에서는 [spark_transport 설치 가이드](../../doc/TRANSPORT.md)의 1~6단계를 순서대로 진행하십시오. 구동 전에 사용자 설정·Tunnel ID·서로 다른 두 인증정보가 준비되어야 합니다.

~~~powershell
# SPARK 루트에서 실행
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 --help
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 status
npm --prefix out run test:protocol
~~~

| 결과 | 확인 |
|---|---|
| `--help` | 서비스 변경 없이 명령 형식 표시 |
| `status` | 로컬 서버·Tunnel 상태 |
| `test:protocol` | 로컬 테스트 MCP 요청의 프로토콜 계약 |

실제 ChatGPT Plugin이 도구를 호출하는 End-to-End(E2E) 검증은 [설치 가이드의 Smoke Test](../../doc/TRANSPORT.md)에서 실시합니다.

## 5. 보안과 운영

- Secure MCP Tunnel 접속용 Runtime API Key와 MCP Access Token은 서로 다른 인증정보입니다.
- `transport.allowedRoot`에 필요한 실제 폴더만 지정하고 읽기(R)·쓰기(W)·실행(X)을 최소화합니다.
- `run_command`의 작업 디렉터리 제한은 운영체제 전체의 파일 접근을 격리하는 Sandbox가 아닙니다.
- 서비스의 시작·중지·재시작은 실제 프로세스 상태를 변경합니다. 상태 확인에는 `status`를 사용하십시오.
- 요청이 실패하면 원인과 작업 상태를 먼저 조회하고, 기존 설정이나 사용자 파일을 임의로 지우지 않습니다.

[전체 절차·인증·FAQ → spark_transport 설치 가이드](../../doc/TRANSPORT.md)
