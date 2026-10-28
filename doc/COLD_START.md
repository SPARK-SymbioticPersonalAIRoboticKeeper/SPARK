# SPARK 0.0.3 — 새 Windows 환경 설치·독립 에이전트 인계

[SPARK 소개](../README.md) · [spark_transport 설치](TRANSPORT.md) · [아키텍처](ARCH.md) · [품질 게이트](ARCH_QGate.md)

## 1. 문서의 사용 목적

이 문서는 **SPARK에 관한 이전 대화, 특정 개발자의 PC, 기존 Runtime 상태를 모르는 사용자·에이전트**가 설치 자료를 빠짐없이 찾아가고 각각의 단계가 성공했는지 검증하도록 만든 독립적인 인계 문서입니다.

**실제 클릭 절차·설정 편집·11개 캡처·FAQ의 완전한 기준 문서는 [spark_transport 설치 가이드](TRANSPORT.md)**입니다. 이 문서는 실행 순서·검증·증거·작업 중단 조건에 집중합니다.

## 2. 시스템과 책임

| 모듈 | 기능 | 설정·실행 절차 |
|---|---|---|
| **spark_transport** | Model Context Protocol(MCP) 서버, 10개 도구, 권한 정책, Secure MCP Tunnel | [spark_transport](TRANSPORT.md) |
| **spark_ui** | Windows ChatGPT 앱 Theme, Chrome DevTools Protocol(CDP) 관측, Route Monitor | [spark_ui](UI.md) |
| **spark_log** | 대화 원본 Backup, JSONL Viewer | [spark_log](LOG.md) |
| **spark_cii** | Custom Instruction Injector(CII): 송신 요청 Prefix 결합, Send Gate, Display Mask | [spark_cii](CII.md) |

~~~mermaid
flowchart TB
  A["새 Windows 11 PC"] --> B["Git·Node.js 준비"]
  B --> C["Public SPARK Clone"]
  C --> D["명령·버전·자동 테스트"]
  D --> E["사용자 개인 설정·MCP Access Token"]
  E --> F["OpenAI Platform Tunnel ID·Runtime API key"]
  F --> G["로컬 MCP/Tunnel 실행·Status"]
  G --> H["ChatGPT Plugins 연결·도구 탐색"]
  H --> I["안전한 작업 폴더에서 Smoke Test"]
  I --> J["필요한 다른 모듈 설정"]
~~~

## 3. 새 PC에서 실행하는 단계

### 3.1. 필수 프로그램 준비

Windows 11의 일반 사용자 계정에서 Git과 Node.js 20 이상을 준비합니다. Node.js 24 LTS를 권장합니다.

~~~powershell
git --version
node --version
npm --version
~~~

세 명령이 버전을 표시하지 않으면 [Git 공식 다운로드](https://git-scm.com/downloads) 또는 [Node.js 공식 다운로드](https://nodejs.org/en/download)에서 설치 후 **새 PowerShell**에서 확인합니다.

### 3.2. Public 소스 Clone

파일 탐색기에서 사용자가 승인한 **기존 빈 설치 상위 폴더**를 열고 주소 표시줄에 `powershell`을 입력합니다. 아래 명령은 **그 상위 폴더에서** 실행합니다.

~~~powershell
git clone https://github.com/SPARK-SymbioticPersonalAIRoboticKeeper/SPARK.git
Set-Location .\SPARK
Test-Path .\out\SPARK.ps1
node -p "require('./out/package.json').version"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 --help
~~~

기대 결과는 `True`, `0.0.3`와 정상 도움말입니다. `False`이면 저장소 루트가 아니므로 중단하십시오. **`out/SPARK.ps1`을 인수 없이 실행하지 마십시오.** 실제 실행 중인 앱·서비스를 시작하는 명령입니다.

### 3.3. 읽기 전용·격리 소스 테스트

이 단계는 사용자의 운영 중인 ChatGPT 창, Tunnel, 기존 작업 자료를 수정하지 않습니다. **새 Git Clone의 자동 검사용 임시 디렉터리는 테스트 실행기가 필요할 때 생성**합니다. 사용자 인증정보·영구 데이터 폴더는 생성하거나 변경하지 않습니다.

~~~powershell
npm --prefix out test
npm --prefix out run test:protocol
npm --prefix out run chatgpt-ui:validate
node mod/spark_ui/src/cli.mjs validate --theme mod/spark_ui/config/dark-red-theme.json
~~~

각 명령의 종료 코드가 0이고, 테스트에서는 TAP 요약의 `fail 0`을 확인합니다. 개수가 0인 테스트는 PASS가 아닙니다. 기능의 실제 외부 ChatGPT 서버 연결도 여기에서 입증되지 않습니다.

### 3.4. 개인 설정 초기화 — 실제 파일 생성

소스와 자동 테스트가 정상이면 아래 **상태 변경 명령을 한 번** 실행합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 init
~~~

기대 결과는 개인 설정과 `MCP Access Token` 생성의 `PASS`입니다. 일부 파일만 존재하는 경우 자동 삭제·덮어쓰기를 요청하지 말고 오류 원인을 확인하십시오.

실제 설정 파일은 코드를 통해 PC별 위치를 구하고, 본문을 노출하지 않은 채 메모장으로 엽니다.

~~~powershell
$configPath = (node --input-type=module -e "import { RUNTIME_CONFIG_PATH } from './mod/spark_transport/src/config.mjs'; console.log(RUNTIME_CONFIG_PATH)").Trim()
notepad.exe $configPath
~~~

`transport.allowedRoot`는 사용자가 승인한 실제 존재하는 폴더, `tunnel.id`는 OpenAI Platform에서 생성한 ID로 바꿉니다. 실행 권한 `X`는 `run_command`를 허용할 때에만 부여합니다. 기존 다른 사용자의 폴더를 예시 경로로 그대로 쓰지 마십시오.

### 3.5. 별도의 Tunnel 인증

[OpenAI Secure MCP Tunnel 공식 안내](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)에 따라 ChatGPT Workspace와 연결되는 Tunnel을 생성합니다. 이 작업에는 실제 Platform/Workspace 권한이 필요합니다.

- **Runtime API key**: 로컬 Tunnel Client가 OpenAI에 인증할 때 사용합니다.
- **MCP Access Token**: ChatGPT Plugin이 spark_transport의 MCP 요청에 인증할 때 사용하는 별도 값입니다.
- 두 값을 혼동하거나 키를 채팅·Git·테스트 로그에 출력하지 않습니다.

키 파일의 실제 위치와 토큰 존재 여부는 [spark_transport `3.4–3.5](TRANSPORT.md)에서 안전하게 조회합니다.

### 3.6. 로컬 서버·Tunnel 실행

신규 설치이고 Private 설정·키·Tunnel ID가 검증됐을 때만 실행합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 start -SkipChatGPTUi
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 status
~~~

| 결과 | 판정 |
|---|---|
| spark_transport 실행·Bearer 인증, Tunnel identity verified/control-plane ok | **로컬 연결 준비** |
| Not running/Not ready/Identity mismatch | 준비 실패; 원인 검토 후 별도 재시도 |
| Status만 정상 | 실제 ChatGPT Plugin 도구 호출 성공으로 취급하지 않음 |

**기존 사용 중인 PC에서는** `start`/`restart`가 실행 상태를 변경하므로 기존 프로세스와 복구 계획을 확인하기 전에는 실행하지 않습니다.

### 3.7. ChatGPT Plugins 등록

[OpenAI의 현행 Custom MCP 연결 안내](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)에서 실제 Workspace 권한을 먼저 확인하십시오.

1. Plugins에서 `+ → Add custom MCP server`를 선택합니다.
2. Connection = Secure MCP Tunnel, 실제 `tunnel_id`를 지정합니다.
3. **고정 Access Token / Bearer 인증을 지원하는지 확인**합니다. 지원되지 않으면 연결을 중단합니다. OAuth만 보이거나 `No authentication`만 보이는 경우 임의로 인증을 낮추지 않습니다.
4. 위험 안내를 확인한 후 `Create as a plugin`, 도구 검색, 설치를 진행합니다.
5. `@SPARK`를 선택한 새 ChatGPT 대화에서 도구 10개의 이름과 접근 권한을 확인합니다.

Legacy Apps 인터페이스의 `Draft → Publish → Connect`와 화면별 이미지는 [spark_transport `5.3](TRANSPORT.md)에 따로 보관되어 있습니다. 현재 UI와 혼용하지 않습니다.

### 3.8. 안전한 실제 도구 시험

3.4에서 지정한 사용자 소유의 **독립 테스트 폴더**에서만 [spark_transport `6](TRANSPORT.md)의 순서로 실행합니다.

| 시험 | 기대 결과 |
|---|---|
| `create_file` | 이름 충돌 없는 테스트 파일 생성 |
| `read_file` | 생성한 내용과 정확히 일치 |
| `modify_file` | 지정 문자열만 정확히 한 번 변경 |
| `read_file` 재실행 | 변경 내용을 다시 확인 |
| `run_command` | 실행 코드 0과 명시한 Echo 문자열 |
| `delete_path` | 방금 생성한 파일만 Windows 휴지통 이동 |

도구 목록만 보이는 것은 성공한 설치가 아닙니다. 실제 6개 요청과 그 결과를 확인한 경우에만 Plugin 검증을 PASS로 기록합니다.

### 3.9. 필요한 다른 모듈 사용

- [spark_ui](UI.md): Windows ChatGPT 앱 및 CDP 연결 후 Theme·Route Monitor를 설정합니다.
- [spark_log](LOG.md): 본인이 승인한 대화·기존 폴더에서 Backup을 생성하고 JSONL을 Viewer로 검토합니다.
- [spark_cii](CII.md): 개인 Instruction 파일을 작성하고 `validate`, `probe`, `audit`로 단계별 증거를 구분합니다.

이 단계들은 서로 독립적으로 검증합니다. **spark_cii Prefix Verified · Local은 실제 서버 수신의 근거가 아닙니다.**

## 4. 실패·중단 조건

| 상황 | 에이전트에게 요구되는 동작 |
|---|---|
| 설치 파일·명령 없음 | 저장소 루트·버전·파일 존재를 다시 확인 |
| 테스트 1개 이상 실패 | 실패 이름·출력·실행 환경을 기록하고 성공 주장 금지 |
| 권한·Tunnel ID·Token 불명확 | 사용자에게 실제 권한 확보 요청; Token 본문 출력 금지 |
| Plugin Bearer 방식 미지원 | 연결 중단; `No authentication`으로 다운그레이드 금지 |
| 기존 앱·서비스 실행 중 | 상태 조회만 실시, 소유자 확인 없이 Stop/Restart 금지 |
| CII 외부 송신 근거 부재 | `NOT OBSERVED`; 응답 말풍선을 서버 송신 패킷이라고 해석하지 않음 |
| 원본 Backup 저장·Archive | 사용자 승인과 무결성 확인 후에만 변경 |
| 메시지 Delivery Timeout | 6.5 밖의 **SWE3DP 미해결 TODO**로 이월; 임의 재전송 금지 |

## 5. 외부 에이전트 인수 기준

Claude, OpenCode 등 다른 에이전트에 **이 공개 저장소와 본 문서만** 제공하고 다음 항목을 독립 검토하도록 요청할 수 있습니다. 개인 인증정보나 기존 ChatGPT 대화 내용을 전달할 필요는 없습니다.

- [ ] 실제 CLI·JSON과 안내 문서의 옵션/경로가 일치합니다.
- [ ] 새 Git Clone에서 `--help`, 버전·정적 검사를 실행할 수 있습니다.
- [ ] 사용자 개인 데이터 없이 테스트를 수행하고 PASS/FAIL을 보고할 수 있습니다.
- [ ] 키 2개의 역할, 보안 경계, Root R/W/X 정책을 구분합니다.
- [ ] Windows 앱과 Plugin 관리 화면의 차이를 설명합니다.
- [ ] 네 모듈의 서로 다른 기능과 실행 조건을 설명합니다.
- [ ] 원격 Workspace/ChatGPT 연결이 안 된 경우 **정확히 무엇을 미검증으로 남겨야 하는지** 설명합니다.
- [ ] 오염된 사용자 PC나 기존 Git 작업 트리를 임의로 초기화하지 않습니다.

**결과 보고 형식:** 검사 ID | 환경(Windows/Node) | 실제 명령 또는 화면 | 예상 결과 | 실제 결과 | PASS/FAIL/NOT RUN | 근거. 실측하지 않은 항목은 질문 없이 PASS로 승격하지 않습니다.
