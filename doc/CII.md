# spark_cii — Custom Instruction Injector

**SPARK 0.0.3** · [프로젝트 소개](../README.md) · [모듈 소스](../mod/spark_cii/) · [상세 설계](ARCH.md)

## 1. 개요

**spark_cii**는 Custom Instruction Injector(CII) 모듈입니다. Windows ChatGPT 앱에서 사용자가 보낼 메시지의 요청 객체에 관리형 Instruction Prefix를 결합합니다. 사용자 입력창을 수정하는 방식과 전송 요청에 Prefix를 결합하는 방식은 구분됩니다.

0.0.3은 **제품 버전**입니다. 내부 CII 상태의 `implementation: "0.0.2"`는 실행 경로 호환성을 위한 기존 구현 식별자이며 제품 버전을 뜻하지 않습니다. 사용자 메시지의 실제 원격 서버 수신과 전 경로 Prefix 적용은 독립적으로 검증되어야 합니다.

~~~mermaid
sequenceDiagram
  participant User as 사용자
  participant Chat as ChatGPT 입력창
  participant Gate as spark_cii Send Gate
  participant Break as CDP Breakpoint
  participant App as ChatGPT 송신 경로
  participant View as Display Mask
  User->>Chat: 사용자 원문 작성
  Chat->>Gate: Enter / Send
  alt 준비 상태가 충족되지 않음
    Gate-->>Chat: 인식 가능한 전송 차단
  else CDP 경계 장착
    Gate->>App: 제출 계속
    App->>Break: startCompletionStream 호출
    Break->>Break: 요청 복제 + Prefix 결합 + 읽기 검증
    Break->>App: 원래 송신 함수 재개
    App->>View: 사용자 말풍선 표시
    View-->>User: 표시용 Prefix 숨김
  end
~~~

| 구성요소 | 담당 기능 |
|---|---|
| Request Interceptor | 송신 함수의 요청 객체를 복제해 Prefix를 한 번 결합 |
| Send Gate | 인식 가능한 Enter·Send에서 주입 장치 준비 상태 확인 |
| Display Mask | 사용자 말풍선의 Prefix만 시각적으로 숨김 |
| Watcher | ChatGPT 창 탐색·재접속·상태 갱신 |
| Audit | 원문이 아닌 단계별 상태·사유 기록 |

## 2. 준비와 설정

### 2.1. 전제 조건

| 항목 | 필요한 상태 |
|---|---|
| 플랫폼 | Windows 11, 설치된 Windows ChatGPT 앱 |
| 소스 | [spark_transport 설치 가이드](TRANSPORT.md)의 소스 준비 및 개인 초기화 |
| CDP | SPARK Launcher가 ChatGPT 앱에 연결할 수 있는 상태 |
| Prefix | 유효한 UTF-8 텍스트 파일, 빈 내용 불가 |

작업할 PowerShell은 SPARK 루트에서 시작합니다.

~~~powershell
Test-Path .\out\SPARK.ps1
node --version
~~~

### 2.2. 개인 Instruction Prefix 작성

spark_cii가 사용하는 개인 설정의 실제 위치는 코드에서 조회하십시오. 아래 명령은 **경로만 출력**하며 Instruction 내용을 출력하지 않습니다.

~~~powershell
$ciiPath = (node --input-type=module -e "import { DEFAULT_CONFIG_PATH } from './mod/spark_cii/src/config.mjs'; console.log(DEFAULT_CONFIG_PATH)").Trim()
$ciiPath
notepad.exe $ciiPath
~~~

메모장에서 넣을 것은 **한 번에 추가할 Instruction 원문**입니다. 다른 사용자의 Token, API key, 대화 기록을 넣지 마십시오. 설치 예시의 문장과 운영 환경의 실제 개인 규칙은 구분합니다.

설정 원문은 공개 Git, 진단 로그, Wiki에 기록하지 않습니다.

~~~powershell
node mod/spark_cii/src/cli.mjs validate
~~~

**완료 기준:** 설정 파일이 UTF-8로 해석되고 비어 있지 않으며 허용된 크기 내에 있습니다. 오류가 나면 파일을 수정한 후 `validate`를 다시 실행합니다. Prefix의 정상적인 작성 자체가 실제 메시지 전송 성공을 증명하지는 않습니다.

## 3. 시작과 조회

### 3.1. Windows SPARK 실행

SPARK 공통 Lifecycle은 [spark_transport](TRANSPORT.md)의 서버·Tunnel 설정을 먼저 완료한 상태에서 사용합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 start
~~~

기존 ChatGPT 작업을 중단할 수 있으므로 현재 세션이 진행 중일 때는 `start` 또는 `restart`를 진단용으로 반복하지 마십시오.

### 3.2. 상태 조회

~~~powershell
node mod/spark_cii/src/cli.mjs probe --json
node mod/spark_cii/src/cli.mjs audit --tail 100 --json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File mod/spark_cii/script/spark-cii.ps1 -Action status
~~~

| 상태 | 의미 | 확인할 것 |
|---|---|---|
| `EGRESS_BOUNDARY_ARMED_UNVERIFIED` | 송신 경계가 설치됨 | 해당 창에서 실제 사용자 요청은 아직 미관측 |
| `EGRESS_REQUEST_PREFIX_VERIFIED_LOCAL` | 요청 객체의 로컬 Prefix 결합·읽기 검증 | 서버 수신과 별개 |
| `DISPLAY_MASK_MISSING` | 화면 마스킹 준비 실패 | 인식 가능한 사용자 Send 차단 여부 |
| `EGRESS_FAIL_CLOSED` | CDP 또는 요청 구조가 필요한 조건을 충족하지 않음 | 오류 코드·입력창 원문 유지 |
| `MESSAGE_REPLAYED_UNCONFIRMED` | 로컬 Call Frame을 원래 흐름으로 재개 | Electron IPC·네트워크 성공으로 오인하지 않음 |

각 ChatGPT 창의 상태는 별도로 확인합니다. 한 창의 Local Verified가 다른 창의 전송 성공을 보장하지 않습니다.

## 4. Prefix 결합 계약

### 4.1. 요청 데이터

spark_cii는 Electron Renderer의 `startCompletionStream` 호출 경계에서 **마지막 User 역할의 메시지**를 찾아 요청 객체 복사본을 구성합니다.

~~~text
Outgoing user content:
[managed Instruction Prefix]

[original user message]
~~~

| 검증 | 처리 |
|---|---|
| Prefix가 없는 일반 텍스트 | Prefix + 빈 줄 + 원문 |
| 동일 Prefix가 이미 존재 | 중복 결합 방지 |
| 첨부가 있는 메시지 | 첨부 메타데이터를 보존하며 지원되는 텍스트 부분만 변환 |
| 인식할 수 없는 사용자 요청 | 성공으로 보고하지 않고 전송 경로에서 차단 |
| User 역할이 없는 내부 호출 | User 메시지 삽입으로 오인하지 않고 별도 상태 기록 |

입력창의 ProseMirror 컨트롤러를 직접 수정하던 **구형 방식은 현행 전송 경로가 아닙니다.** 실제 코드 계약과 예외 처리는 [ARCH `29](ARCH.md)의 함수별 설명을 참조하십시오.

### 4.2. 단계별 증거

~~~mermaid
flowchart LR
  A["Gate Armed"] --> B["Breakpoint Hit"]
  B --> C["Prefix Verified · Local"]
  C --> D["Application Resume"]
  D --> E["Native IPC / Server"]
~~~

| 단계 | spark_cii가 직접 확인하는 정보 |
|---|---|
| Gate Armed | 전송 경계 등록과 상태 확인 |
| Breakpoint Hit | 실제 호출된 함수의 CDP 일시정지 |
| Prefix Verified | 요청 객체의 Prefix 결합과 로컬 읽기 검증 |
| Application Resume | 원래 함수 실행 재개 |
| Native IPC / Server | 별도 네트워크·서버 관측이 필요 |

단계 사이의 증거가 없으면 상태를 임의로 채우지 않습니다. Audit에는 사용자 원문이나 Instruction 내용을 넣지 않습니다.

## 5. 사용자 화면 표시

### 5.1. Display Mask

Display Mask는 채팅 사용자 말풍선에서 정확한 Prefix를 찾으면 CSS로 **표시만 숨기고**, 사용자가 작성한 원문만 보여 줍니다. 메시지 원본 DOM·React 상태·저장된 메시지 자체를 삭제하거나 수정하는 기능과는 다릅니다.

| 영역 | 처리 |
|---|---|
| 사용자 입력창 | 사용자 원문 유지 |
| 화면의 사용자 말풍선 | 정확히 일치하는 Prefix만 표시에서 숨김 |
| 새 메시지·화면 재렌더링 | DOM 변경 감지 후 다시 검사 |
| Route Monitor | 원문 표시용 투영을 사용 |
| 서버 저장·복사·편집·내보내기 | 별도의 데이터 소유 영역 |

화면 숨김과 실제 삭제를 혼동하지 마십시오. 메시지 복사나 편집에서 원본에 포함된 Prefix가 나타날 수 있으며, 이런 데이터 경로는 시각적 마스킹의 책임 범위가 아닙니다.

## 6. 운영·복구

| 작업 | 명령·방법 | 주의 |
|---|---|---|
| 설정 유효성 검사 | `node mod/spark_cii/src/cli.mjs validate` | 읽기 중심 |
| 현재 연결 조회 | `node mod/spark_cii/src/cli.mjs probe --json` | 메시지를 보내지 않음 |
| 상태·사유 조회 | `node mod/spark_cii/src/cli.mjs audit --tail 100 --json` | 원문 제외 메타데이터 |
| 명시적 중지 | `spark-cii.ps1 -Action stop` | **실제 기능 변경:** Gate/Mask 제거 |
| 재장착 | `spark-cii.ps1 -Action start` | ChatGPT 세션·CDP 준비 상태 검증 필요 |

상주 Watcher가 필요합니다. 일회성 `once` 실행 후 종료하면 CDP 브레이크포인트가 유지되지 않으므로 지원되지 않습니다.

## 7. 문제 해결

| 증상 | 원인 확인 | 대응 |
|---|---|---|
| 설정 없음 또는 UTF-8 오류 | `validate` 메시지 | 개인 Prefix 파일 확인 |
| CDP 대상 없음 | Windows ChatGPT 실행·`spark_ui probe` | 앱 실행과 CDP 접근 확인 |
| Unsupported Editor / Breakpoint 오류 | 앱 업데이트·송신 함수 변경 여부 | 원문을 임의 전송하지 않고 설치 오류 조사 |
| Message Blocked | Gate·Mask·Breakpoint 준비 상태 | 각 요소의 원인 코드 확인 |
| Prefix가 말풍선에 노출됨 | Display Mask 상태·렌더링 형태 | Mask 재설치 및 표시 계층 검사 |
| Local Verified인데 결과 불명확 | IPC/서버 수신 증거 부재 | Local 상태와 원격 증거를 따로 조사 |
| 새 창에서 상태 미관측 | 해당 창의 Watcher 등록·Heartbeat | 창별 `probe` 재확인 |

## 8. 문서와 소스

| 자료 | 내용 |
|---|---|
| [모듈 README](../mod/spark_cii/README.md) | 코드·Watcher 맵 |
| [ARCH `29](ARCH.md) | 실제 Request Interceptor, Trust Boundary, 오류 경로 |
| [spark_ui](UI.md) | Route Monitor와 표시 계층 |
| [ARCH QGate](ARCH_QGate.md) | 시험 증거와 기능 인수 |
