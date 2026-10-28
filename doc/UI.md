# spark_ui — Windows ChatGPT Interface and Diagnostics

**SPARK 0.0.3** · [프로젝트 소개](../README.md) · [모듈 소스](../mod/spark_ui/) · [상세 설계](ARCH.md)

## 1. 개요

**spark_ui**는 Windows ChatGPT 앱의 Chrome DevTools Protocol(CDP)을 이용해 화면 테마와 대화 상태를 관측·표시하는 모듈입니다. 앱의 설치 바이너리를 수정하지 않고 Renderer에 CSS와 진단 패널을 적용합니다.

| 기능 | 사용자에게 보이는 결과 | 구현 영역 |
|---|---|---|
| Theme | 색상·간격·대화 영역 폭·반응형 줄바꿈 | `mod/spark_ui/src/theme.mjs` |
| Project Collapse / Pinned Labels | Projects 번호별 상위/하위 접기와 Pinned 대화의 `프로젝트명/대화명` 표시 | `mod/spark_ui/src/project-collapse.mjs` |
| Route Monitor | 선택한 Model/Effort, 관측 결과, Current / Last Good | `mod/spark_ui/src/route-overlay.mjs` |
| Message Flow | 사용자 작성 원문과 로컬 제출·관측 경로 구분 | `mod/spark_ui/src/route-flow.mjs` |
| Metadata Recording | 명시적 Record/Stop으로 상태 메타데이터 기록 | UI watcher / recording 모듈 |
| Lifecycle / Tray | Windows 앱과 UI watcher의 실행·상태·복구 | 공통 `out/SPARK.ps1` |

## 2. 설치 및 준비

### 2.1. 요구 환경

| 항목 | 준비 방법 |
|---|---|
| 운영체제 | Windows 11 및 데스크톱 ChatGPT 앱 |
| 소스 | [SPARK 설치](TRANSPORT.md)의 1~3단계를 완료 |
| Node.js | 버전 20 이상 |
| 실행 조건 | Windows 앱이 실행 중이고 SPARK가 CDP 연결을 제공해야 UI 적용 가능 |
| Theme | `mod/spark_ui/config/default-theme.json` 또는 `dark-red-theme.json` |

**PowerShell 작업 디렉터리:** SPARK 루트(`out`과 `mod`가 나란히 있는 디렉터리)에서 실행합니다. 파일 탐색기에서 SPARK 폴더를 열고 주소창에 `powershell`을 입력한 후 시작하십시오.

~~~powershell
Test-Path .\out\SPARK.ps1
node --version
npm --prefix out run chatgpt-ui:validate
~~~

| 결과 | 판정 |
|---|---|
| `True` 및 Node 버전, 유효한 Theme 정보 | 소스·Theme 준비 완료 |
| `False` | 현재 PowerShell의 작업 디렉터리가 잘못됐습니다. |
| JSON/schema 오류 | Theme 값을 수정하고 다시 검증합니다. |

### 2.2. 실행과 조회

처음 시작할 때는 [spark_transport 가이드](TRANSPORT.md)의 개인 인증·Tunnel 준비를 마친 뒤 실행합니다. `start`는 실제 Windows 프로그램·서비스를 시작할 수 있는 명령입니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 start
~~~

Windows ChatGPT 앱이 열리고 UI watcher가 연결된 뒤 `probe`로 현재 CDP 대상만 조회할 수 있습니다.

~~~powershell
node mod/spark_ui/src/cli.mjs probe --json
~~~

**정상 판정:** `targetCount`가 1 이상이며 실제 ChatGPT 렌더러 대상이 확인됩니다. 0이면 테마를 강제 적용하지 말고 ChatGPT 실행 상태와 CDP 포트를 먼저 확인합니다.

## 3. Theme 관리

### 3.1. 설정 구조

| 파일 | 역할 |
|---|---|
| `mod/spark_ui/config/default-theme.json` | 기본 Theme 기준 |
| `mod/spark_ui/config/dark-red-theme.json` | Dark Red Theme |
| `mod/spark_ui/config/theme.schema.json` | 입력값·타입 검증 |
| `mod/spark_ui/src/theme.mjs` | Theme 컴파일 및 CSS 생성 |

Theme 수정은 **JSON 편집 → schema 검사 → 실제 적용** 순서입니다. 현재 실행 중인 앱을 변경하기 전에 기존 Theme 값과 복구 명령을 확인하십시오.

~~~powershell
node mod/spark_ui/src/cli.mjs validate --theme mod/spark_ui/config/dark-red-theme.json
node mod/spark_ui/src/cli.mjs inspect --theme mod/spark_ui/config/dark-red-theme.json --json
~~~

| 명령 | 사용 시점 |
|---|---|
| `validate` | 파일 구조 및 CSS 컴파일만 검사 |
| `probe` | CDP 대상 창 확인 |
| `inspect` / `status` | 적용 상태·표시 상태 점검 |
| `apply` | **화면 변경:** 선택 Theme 적용 |
| `restore` | **화면 변경:** 관리 대상 Theme·Progress 표시 복원 |

`apply`와 `restore`는 실제 앱의 UI 상태를 변경합니다. 독립적인 읽기 전용 검증을 원하는 경우 실행하지 마십시오.

### 3.2. 화면 폭과 줄바꿈

SPARK Theme는 대화 본문이 창 크기에 맞게 줄바꿈되도록 CSS를 조정합니다. 이 동작은 실제 앱의 DOM 구조에 의존하므로 Theme schema 검사와 창 크기별 시각 검사는 별개의 절차입니다.

### 3.3. Projects 번호별 접기

기존 ChatGPT 프로젝트에는 실제 상위/하위 데이터 관계가 없으므로 **프로젝트 이름만** 다음 규칙으로 해석합니다.

- `20. Infinite Idea`: 상위 번호 `20`.
- `20.00. LazyTrip`, `20.10. LazyShopper`: 상위 `20`의 하위 번호 `00`, `10`.
- **엄격한 번호 규칙:** `99.00. L`은 하위 프로젝트이며, `99. 00. L`처럼 두 번호 사이에 공백을 넣으면 하위 프로젝트로 인식하지 않습니다. 프로젝트 이름을 자동 수정하지 않습니다.
- 자식이 실제로 있는 상위 프로젝트 옆에만 `>` 화살표를 추가합니다. 화살표를 누르면 그 번호에 속하는 하위 프로젝트 **항목 전체(해당 프로젝트에 펼쳐진 대화 목록 포함)**를 숨기고, 다시 누르면 표시합니다.
- 번호가 같은 상위 항목이 2개 이상이거나 부모가 없는 하위 번호는 오분류를 피하도록 건드리지 않습니다. 프로젝트 정렬 순서가 바뀌어도 번호로 연결합니다.
- 기존 프로젝트/대화의 클릭 및 서버 동기화 경로에는 개입하지 않습니다. 원본 DOM 재배치와 실제 프로젝트 계층 생성은 범위에서 제외합니다.
- **아이콘 기준 자동 들여쓰기:** 접기 화살표가 없는 상위 프로젝트에도 화살표 너비에 해당하는 21 CSS px를 예약하므로 `10.`, `40.`, `99.` 등 동일 레벨의 폴더 아이콘이 정렬됩니다. `10.00.` 등 하위 프로젝트의 폴더 아이콘과 제목 영역은 42 CSS px를 들여써 상위보다 21 CSS px 깊게 배치합니다. 화면 확대 배율에 따라 실제 픽셀 값은 변경됩니다. 프로젝트 이름에 수동 삽입된 보이지 않는 공백은 건드리지 않으며, 공백 삭제 후에도 폴더 아이콘 기준 정렬은 유지됩니다.
- **프로젝트 내부 대화 정렬:** 상위 프로젝트에 직접 속한 대화와 `Show more`는 상위 프로젝트 제목 시작 위치에 맞게 21 CSS px, 번호가 `10.00.` 등인 하위 프로젝트에 속한 대화는 하위 프로젝트 제목 시작 위치에 맞게 42 CSS px를 추가 들여씁니다. 대화 목록만 국소적으로 조정하며 프로젝트 데이터와 대화 이름, Recents 리스트에는 개입하지 않습니다.
- **Pinned 대화의 프로젝트 표시:** `Pinned` 대화 행의 내비게이션 경로에서 프로젝트 ID와 대화 ID를 검사하고, 실제 Projects 목록의 같은 프로젝트 ID에 대응하는 이름을 찾으면 `10.00. SPARK/SPARK_CII`처럼 표시합니다. 현재 프로젝트가 접혀 있어도 번호·제목으로 소속을 추측하지 않습니다. 일치하는 ID가 없거나 ChatGPT의 내부 경로가 변경되면 원본 대화 제목만 표시합니다. CSS 가상 요소로 접두어만 그리므로 원본 대화 제목·메시지·URL·고정 여부·메뉴·서버 상태는 변경하지 않습니다. Pinned 목록의 갱신/프로젝트 이름 변경은 watcher가 다시 반영합니다. Pinned 메타데이터는 파일·로그에 저장하지 않으며, heartbeat에는 건수만 남깁니다.
- 접기 상태는 현재 Windows 앱 Renderer의 메모리에만 남습니다. 앱을 새로 열거나 Renderer가 재시작되면 모두 펼쳐진 상태에서 다시 시작합니다. `restore`는 삽입된 버튼·숨김 속성·CSS를 제거합니다. watcher가 동작 중이면 재적용되므로 원복 전에 먼저 중지해야 합니다.
- ChatGPT가 Projects 목록 DOM을 교체하면 별도 상위 DOM 감시가 새 목록에 화살표를 다시 연결합니다. **SPARK_UI 소스가 갱신된 경우 실행 중인 UI watcher도 새 코드로 다시 시작해야 합니다.** 테마만 적용되거나 SPARK 상태가 `active`여도 이전 watcher에는 새 기능이 로드되지 않을 수 있습니다. 전체 ChatGPT 앱/Transport 재시작은 필요하지 않습니다.

## 4. Route Monitor

### 4.1. Model과 Effort

| 표시 | 의미 |
|---|---|
| Selected Model / Effort | 화면에서 사용자가 선택한 항목 |
| Resolved Model / Effort | 실제 메시지 메타데이터에서 추출된 값 |
| Current | 마지막 응답의 현재 관측 결과 |
| Last Good | 이전 응답에서 유효한 값을 관측한 마지막 기록 |
| Not Observed | 해당 데이터 원본에서 값을 찾지 못함 |

`finished_successfully`는 메시지 완료 상태이지, Resolved Effort 값이 아닙니다. Selected와 Resolved를 같은 값으로 간주하거나 미관측 값을 추정하지 않습니다.

### 4.2. 송신 Message Flow

~~~mermaid
flowchart TB
  User["사용자 입력 DOM"] --> Submit["ChatGPT 제출 동작"]
  Submit --> React["React 메시지 계층"]
  React --> CDP["관측 가능한 Renderer 요청"]
  CDP --> Native["Electron IPC / 네이티브 네트워크"]
  Native --> Server["원격 서비스"]
  React -.-> UI["Route Monitor 표시"]
  CDP -.-> UI
~~~

spark_ui는 **관측된 구간만** 출처와 함께 표시합니다. React 인자 관측, CDP HTTP/WS 본문 관측, Electron IPC, TLS 직전 데이터, 원격 수신은 서로 다른 증거입니다. 사용자가 실제 입력한 문장과 CII가 송신 계층에 결합한 Instruction Prefix도 구분합니다. 주입 메커니즘 자체는 [spark_cii](CII.md)에서 설명합니다.

### 4.3. Metadata Recording

Recording은 사용자가 **Record**를 명시적으로 켰을 때에만 상태·메타데이터를 지속 기록하고 **Stop**에서 중지합니다. 기록할 수 있는 필드, 원문 차단, 디스크 보관은 구현 및 [아키텍처](ARCH.md)의 정책을 따릅니다. 대화 원문을 장기간 보관하려면 Recording 대신 [spark_log Backup](LOG.md)을 사용하십시오.

## 5. Tray와 AutoStart

공통 Launcher는 Windows 사용자 세션에서 Tray 상태를 제어합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 --help
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 autostart status
~~~

| 명령 | 영향 |
|---|---|
| `status` | 현재 모듈들의 상태 조회 |
| `autostart status` | 현재 사용자 로그인 자동 시작 설정 조회 |
| `autostart on` / `off` | Windows 시작 프로그램 항목 변경 |
| `start` / `stop` / `restart` | 앱 및 SPARK 소유 서비스 실행 상태 변경 |

AutoStart는 **Windows 사용자 로그인 이후** 실행됩니다. 서버 부팅 전 서비스 시작을 의미하지 않습니다. Tray 아이콘이 Windows 숨겨진 아이콘 영역에 표시될 수 있으므로 프로세스 상태와 작업 표시줄 위치를 구별하십시오.

## 6. 문제 해결

| 증상 | 확인 순서 | 조치 |
|---|---|---|
| CDP 대상 0개 | Windows ChatGPT 실행 → `probe --json` → SPARK 상태 | 앱 연결 준비 후 다시 조회 |
| Theme 검사 실패 | JSON 파서 → schema → `validate` | 잘못된 속성·색상 값 수정 |
| 화면에 Theme가 적용되지 않음 | watcher 실행 상태 → DOM 재로드 여부 | 기존 Theme 원복 수단 확인 후 재적용 |
| Resolved Effort 미표시 | Selected·Current·Last Good·실제 관측 출처 비교 | 임의 값을 입력하지 않고 Not Observed 유지 |
| Tray 아이콘이 안 보임 | `status` → 숨겨진 아이콘 영역 → supervisor | 아이콘이 보이지 않는 것과 서비스 실패를 구분 |
| 앱이 실행 중인데 상태가 오래됨 | watcher PID·CDP 연결·새 창 등록 | 소유 프로세스 확인 후 복구 |

## 7. 구현·검증 자료

| 자료 | 용도 |
|---|---|
| [모듈 README](../mod/spark_ui/README.md) | 개발자용 파일·명령 맵 |
| [아키텍처](ARCH.md) | 화면/메시지 계층 및 실행 계약 |
| [품질 게이트](ARCH_QGate.md) | 검증 결과·재현 조건 |
| [spark_cii](CII.md) | 주입과 표시 마스킹의 소유권 |
