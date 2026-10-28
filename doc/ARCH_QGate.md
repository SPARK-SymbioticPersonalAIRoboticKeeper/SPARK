# SPARK 0.0.3 — Architecture & Documentation QGate

## 0.0.3. Private main baseline — 2026-10-28

| 게이트 | 판정 | 범위·제약 |
|---|---|---|
| Private 소스·버전 0.0.3 | **SOURCE PASS** | 최신 Private `origin/main` 이력 위에 `spark_ui` 기능 병합, 제품 CLI/Manifest/Transport 0.0.3 일치. Private `main`·태그 갱신은 Git ref 검증으로 별도 확인 |
| 엄격한 계층 번호 | UNIT PASS | `N.NN.`만 하위 인식; `99. 00.`처럼 중간에 공백을 넣은 형식은 미지원 |
| UI 접기·들여쓰기·챗 정렬 | OBSERVED IN 0.0.2 WORKSPACE | Windows ChatGPT Renderer에서 확인한 이력; 0.0.3 독립 재현은 별도 증거 필요 |
| Private PNG 3개 | APPROVED FOR SOURCE | `doc/spark2_icon*.png`를 Private `main`에 커밋; Public publisher에서는 별도 검토 전까지 제외 |
| 전체 회귀·Clean clone | **PASS 363/363 (Private·Public)** | 별도의 일반 Windows Git Clone 2개에서 각 43개 테스트 파일 전체 통과. 두 Clone 모두 추적된 `ref/` 0개 |
| CII 원격 E2E·Server 수신 | NOT VERIFIED | 송신 경계·실제 수신 검증은 별도 인수 필요 |
| Public 저장소·Windows/Ubuntu Actions | **PASS** | `SPARK-SymbioticPersonalAIRoboticKeeper/SPARK` 원격 `main` = `81234a4` (parentless `public release` 1개), `ref/` 0개. Windows·Ubuntu CI 모두 SUCCESS (`40638637545`) |
| Private GitHub Actions | **PARTIAL / 2 FAIL** | Private Ubuntu PASS, Windows에서 기존 실패 2개(`AGENTS.md` 고정 해시, 오래된 Init helper 검사) 재현. 변경 전 Private 원격 CI에서도 같은 실패 확인. 새 `ref/` 제거 실패로 판정하지 않으며 해결 전 전체 CI PASS 선언 금지 |
| Wiki·리포지토리 재생성 | NOT RUN | Wiki/Repository ID 재생성은 별도 게이트. Public `main` 교체만 수행 |

이 절이 0.0.3의 현재 품질 판정입니다. 0.0.3의 품질 주장은 **Private 소스·정적/자동 회귀** 범위에 한정됩니다. 이하 0.0.2 / 6.5 / 6.4 표는 당시 시점의 실측·문서 기준선을 보존한 역사 기록으로, 0.0.3 결과로 승격하지 않습니다.

### 0.0.3.1. Local-only `ref/` exclusion and Pinned UI maintenance

| 검증 항목 | 수락 조건 | 결과 |
|---|---|---|
| Private Git 인덱스 | 추적된 `ref/` 0개, 로컬 참고자료 원본 보존 | **PASS** — Private GitHub `main` = `5790ea6`; GitHub API 트리의 `ref/` 0개; 기존 로컬 참고자료 원본 보존 |
| Public Git 스냅샷 | `ref/` 0개, `/ref/` GitIgnore, Private 부모 이력 미포함 | **PASS** — 독립 루트 `81234a4` 및 GitHub API 검증, 182개 배포 파일, `ref/` 0개, `/ref/` 포함 다섯 GitIgnore 규칙 |
| Pinned UI | 실제 대화 ID와 프로젝트 ID 매칭, 화면 접두어만 적용 | **PASS (Windows CDP)** — 기능 커밋 `7336a26` 병합, Pinned 7/7 실화면 확인. 서버 대화 이름·URL 변경 없음 |
| 로컬 검토 자료 | SHA-256 고정, 미존재·해시 불일치 시 Public 생성 중단 | **PASS** — 4개 로컬 Public projection SHA-256 검증 후 Dry-run 성공. `ref/` 원본 경로는 공개하지 않음 |
| 원격 복원 | Private·Public 기존 원격 커밋과 복구 참조 확보 | **PASS (Git refs)** — 기존 Private 원격 `69411c2`, Public 원격 `48566b7` 로컬 복구 참조와 Git 객체 확인. Public은 이전 SHA에 대한 조건부 force-with-lease로만 교체 |
| 과거 GitHub 이력·캐시 완전 삭제 | 별도 검증·복구·서비스 검토 필요 | **NOT VERIFIED** — 현재 브랜치에서의 제거와 구분 |

기존 0.0.3 태그와 6.5의 저장소 삭제·재생성 요구는 이번 참조자료 추적 해제만으로 완료 판정하지 않습니다. 관련 도구·저장소 내용의 실제 검증 결과는 최종 커밋과 원격 SHA 검증을 기준으로 판정합니다.

## 6.5. Public Documentation, Cold-start, Wiki and Repository Rebaseline

**Assessment:** SOURCE DOCUMENTATION AND INDEPENDENT PUBLIC CHECKOUT PASS; GitHub Public 저장소 삭제·재생성과 새 원격 CI 검증은 별도 게이트로 남겨 둡니다. 이 절은 0.0.2 시점의 판정이며, 아래 이전 6.4/6.3 표도 과거 실행 시점의 기록입니다.

### 6.5.1. SWE1 요구사항과 산출물

| SWE1 요구 | 산출물 | 완료 증거 |
|---|---|---|
| REQ-DOC-065-01~05: 소개·명칭·계층화 | [README](../README.md), [ARCH §0](ARCH.md), 각 모듈 매뉴얼 | 네 모듈의 소유권, 간결한 Introduction |
| REQ-DOC-065-06~08: 실제 명령, 의견 반영, 문서 동기화 | [spark_transport](TRANSPORT.md), [spark_ui](UI.md), [spark_log](LOG.md), [spark_cii](CII.md) | 소스 대조·리뷰 주석 0·모듈별 README |
| REQ-DOC-065-09~11: Cold-start·현재 Plugins | [설치 매뉴얼](TRANSPORT.md), [독립 설치/에이전트 인계](COLD_START.md), Wiki | 새 Clone에서 재현, 공식 문서와 일치 |
| REQ-DOC-065-12: 복구 | Private·Wiki·Process 각각 Git 복구 참조 | 기존 사용자 작업 보존, Runtime 변경 없음 |
| REQ-DOC-065-13~14: Public 재생성 | [RELEASE](RELEASE.md), Public Snapshot, Wiki | 새 Repository ID, 1 parentless commit, Windows/Ubuntu CI |
| SWE3DP-6.5-DELIVERY-TIMEOUT-001 | Private SWE3DP TODO | **DEFERRED / OPEN — 6.5 범위에서 수정하지 않음** |

### 6.5.2. 검증 결과와 한계

| 대상 | 판정 | 근거 / 남은 작업 |
|---|---|---|
| 사용자 README·네 모듈 명칭 | **STATIC PASS** | `spark_transport`, `spark_ui`, `spark_log`, `spark_cii` 일치 |
| 설치 매뉴얼·인증·11개 캡처 | **STATIC PASS** | 현재 Plugins/Legacy Apps 구분, 인증 Fail-closed |
| 네 모듈 매뉴얼·개발자용 README | **STATIC PASS** | 실제 CLI 옵션·소스 파일·명령 근거 |
| Wiki Home·Sidebar·11개 페이지 | **PRIVATE WIKI UPDATED / PUBLIC PENDING** | `Home.md`는 GitHub Wiki에서 필요한 첫 페이지 파일명이며 화면 제목은 SPARK |
| 상대 링크·이미지 | **STATIC PASS** | 본문 16개 + Wiki 11개, 누락 0건 |
| Node 통합 회귀 | **PASS 356/356 (Private + Public)** | Windows 로컬 Private 및 독립 일반 Git Public 클론에서 356개 실행, fail/skip/cancel 0; Public 전용 Charter 검사 적용 |
| PowerShell·JavaScript·JSON 구문 | **STATIC PASS** | PowerShell 22개, JS 94개, JSON 8개, 파싱 오류 0 (최종 배포 후보 포함) |
| 신규 일반 Git Clone 설치 | **STATIC PASS** | 별도 일반 Git Clone, 부모 없는 Public 루트, 필요한 파일·도움말·버전 0.0.2·Theme 및 전체 356개 검사 통과; 실제 인증·서비스 시작은 NOT RUN |
| 실제 ChatGPT Plugin 10개 호출 | **NOT RUN** | 외부 Workspace 권한과 인증정보 필요 |
| Windows CII 외부 서버 송신 | **NOT OBSERVED** | 문서 검증만으로 원격 전달 주장 금지 |
| Public 삭제/재생성 | **NOT RUN** | 데이터 보존·Git 복구·권한 확인 필요 |
| 새 Public Actions Windows·Ubuntu | **NOT RUN** | 최종 새 HEAD로 실측 필요 |

6.5에서는 메시지 Delivery Timeout을 분석·패치하지 않습니다. 해당 문제는 독립 SWE3DP 미해결 TODO입니다.

### 6.5.3. 증거 판정 규칙

- `STATIC PASS`는 코드·명령·문서 계약 검증에 한합니다.
- `READ-ONLY OBSERVED`는 해당 시점의 로컬 상태에 한합니다.
- `NOT RUN`은 미실행, `NOT OBSERVED`는 신호 미관측, `BLOCKED`는 사전 조건 또는 안전 차단을 의미합니다.
- 최종 Git SHA·Public 저장소 ID·Wiki·CI URL은 실제 원격 검증 뒤에만 추가합니다.

## 6.4. Historical 0.0.2 source baseline record

### 6.4.1. Verification captured before 6.5 documentation work (historical)

**Scope:** Baseline the tested source, detailed CII architecture, four-module noninterference, safe source/log cleanup and separate Private/Public/Wiki delivery. Historical tables below are **point-in-time records** and must not override this current gate. A source release does not silently accept an unverified functional E2E requirement.

| Gate | Result | Evidence and acceptance limit |
|---|---|---|
| Product, package and Transport version | **PASS** | `0.0.2` release target; 4-module monorepo and versioned source |
| Full automated Node regression | **PASS 348/348** | Latest four-module regression before packaging, failure 0, skip 0; verified test runner rejects a zero-test false PASS |
| PowerShell and JavaScript/JSON static checks | **PASS** | Complete tracked source parser checks; verify actual file counts at release |
| UI theme and CDP | **PASS (read-only runtime)** | Theme schema/compiled CSS valid; running UI watcher and eligible ChatGPT CDP targets observed |
| Transport and Tunnel | **PASS (read-only runtime)** | Local loopback Transport healthy with Bearer; Tunnel identity verified and control plane ready; unrelated to actual CII receipt |
| CII egress installation | **PASS (per-window)** | Two eligible renderer windows, breakpoint installed, live gate armed and display mask registered |
| CII local call-frame Prefix insertion | **PARTIAL (live)** | One inspected window has demonstrated local `forwarded` success; another has no observed user request after the current watcher began |
| CII user-bubble visual mask | **PASS (observed window)** | Exact Prefix-bearing user bubbles visually projected with 0 mask errors; original DOM remains unchanged |
| Server receipt, 100% submit-path coverage | **NOT OBSERVED / NOT VERIFIED** | Native IPC/TLS/server request, voice/edit/resend and alternative submits require independent evidence; never mark as PASS |
| Copy, edit, export, clipboard, accessibility | **NOT VERIFIED** | Presentation CSS does not remove Prefix from stored user content |
| Four-module side effects | **PASS for tested and observed paths** | Transport policies, tool registry, UI schema, Log backup/viewer tests, lifecycle read-only health; manual reboot/Tray interaction remains separate |
| Temporary log hygiene | **PASS** | Obsolete, unreferenced test logs moved to Recycle Bin; active PID/heartbeat/Tray/Tunnel/CII logs retained |
| Public privacy guard | **REQUIRED / enforced** | Strict allowlist, reviewed screenshots, source projection for public engineering charter, no private Git parents or user data |
| Private v0.0.2 tag | **Release action** | Must target exact verified baseline commit; do not retag without explicit correction and re-verification |
| Public single-root commit | **Release action** | Commit message `public release`, exactly one commit in `main`, parent count 0; verify remote after push |
| Public GitHub Wiki | **Release action** | Verified source tree of Wiki pages, independent repository and remote verification |
| Windows reboot / manual taskbar click | **NOT VERIFIED** | Unit/supervisor process checks do not establish complete GUI/OS experience |

**Architecture contract:** [ARCH §29](ARCH.md) is the **current implementation-level CII SSOT**, replacing historical `ORIGINAL_EDITOR_INSERT` descriptions as the operational reference. [CII](CII.md) is the usage and diagnostic guide; [RELEASE](RELEASE.md) defines public/private source projection and recovery. All earlier 2026-10-26/27 records below are retained for traceability, **not** current acceptance decisions.

## Historical verification records (preserved; not the current release verdict)

## 현행 CII Prefix 비표시·Fail-Closed 검증 — 2026-10-27

**판정: 사용자 말풍선 화면 마스킹 실측 PASS / 전체 회귀 348/348 PASS / 저장·복사·편집 및 최종 서버 송신 E2E 미검증.**

| 검증 항목 | 결과 | 확인 근거 |
|---|---|---|
| Prefix 포함 말풍선 화면 표시 | **PASS 7/7 (현재 활성 대화)** | 현재 앱 DOM의 텍스트 원본을 유지하면서 CSS `font-size:0` 및 `::after`에 사용자 원문만 노출; 이전 8/8 및 10/10 검사도 PASS |
| 두 앱 창의 분리형 마스킹 | **PASS 2/2** | `displayMask.enabled=true`, 새 문서 시작 등록 창당 1개, 누적 마스킹 오류 0 |
| 사용자 입력창 보존 | **PASS (CDP 정적·실측)** | 새 DisplayMask는 편집기/React 데이터를 변경하지 않음. 현재 입력창의 Prefix 포함 원문 관측 0 |
| CII 전송 게이트 연계 | **PASS 2/2** | `EGRESS_SEND_GATE_V3`; 마스킹 부재·문서 시작 등록 누락은 정상 장착으로 인정하지 않음; 마스킹 없을 때 인식 가능한 Send 차단 단위 테스트 PASS |
| 오른쪽 Route Monitor | **PASS (실기기·회귀)** | 사용자 말풍선 표시용 `projectText`, 최소화 시 이전 본문 DOM 제거; 현재 최소화 패널 잔존 Prefix 0 |
| 전체 4모듈 회귀 | **348/348 PASS** | 실패·취소·스킵 0, 신규 표시 마스킹·재렌더·Markdown·차단·감사 테스트 포함 |
| PowerShell 구문·Git 변경 검증 | **PASS** | PowerShell 22/22 파싱, `git diff --check` 0건 |
| Electron 실제 요청 객체 Prefix 결합 | **이전 watcher에서 누적 관측, 새 watcher E2E 별도 필요** | 이전 live probe의 `forwarded=11+`; watcher 재시작으로 현재 카운터 0. 로컬 브레이크포인트 검증과 서버 수신 구별 |
| 플랫폼 저장·복사·편집·검색·내보내기 | **NOT VERIFIED** | 화면 CSS 마스킹은 서버 메시지 데이터 삭제가 아니므로 독립 검증 필요 |
| IPC/TLS/서버 수신 및 다른 송신 경로 | **NOT OBSERVED** | 입력창 UI 마스킹 성공만으로 백엔드 수신/항상 결합 보장 불가 |
| 정식 제품 릴리스·원격 push | **NOT DONE** | `0.0.2 Candidate` 유지, 승인 없는 원격 작업 없음 |

상세 설계: [CII](CII.md) §4.0.1, [ARCH](ARCH.md) §28.15, [UI](UI.md) §2.7. 아래 기존 337/337 및 322/322 기록은 **이전 시점의 자동 회귀 기록**이며 현행 수락 판정을 대체하지 않습니다.

## 현재 CII Electron 송신 경계 검증 — 2026-10-27

**판정: 구현 및 장착 PASS / 실제 사용자 요청의 Prefix 결합 E2E NOT OBSERVED / 최종 요구사항 수락 보류.**

| 확인 항목 | 결과 | 실제 증거 |
|---|---|---|
| Android와 Windows 비교 | **완료** | Android WebView의 문서 시작 `fetch` 재작성과 Windows Electron/IPC 차이를 비교 |
| Windows 송신 함수 식별 | **2/2 PASS (정적·실기기)** | 두 실제 앱 창의 `app-initial`에서 동일한 `startCompletionStream` 함수·바이트 위치·스크립트 해시 확인 |
| CII 운영 경로 교체 | **PASS (구현)** | 이전 ProseMirror 편집·Send 재호출을 사용하지 않고 `breakpoint.mjs`에서 요청 객체 복제·Prefix 검증 |
| 원문 미삽입 자동 우회 방지 | **PASS (회귀·부분 실측)** | `guard-egress.mjs`가 인식 가능한 Enter/Send에서 CDP 미장착·만료 시 차단; 모든 내부 경로가 해당 게이트를 지나는지는 미검증 |
| Windows CII watcher 교체 | **2/2 PASS (실기기)** | 두 창 모두 `stage=EGRESS_REQUEST_BOUNDARY`, `gate.armed=true`, `dispatchBreakpoint.installed=true` |
| UI watcher 교체 | **PASS (실기기)** | ChatGPT 앱 재시작 없이 새 UI watcher heartbeat `healthy=true`, 독립 감사 `UI_CII_STATE=ARMED_UNVERIFIED` |
| 단계별 CII 감사 기록 | **PASS (실기기)** | `WATCHER_STARTED`, 두 개의 `EGRESS_BOUNDARY_ARMED`, `WATCHER_STATE=ARMED_UNVERIFIED`; 본문·Prefix 비기록 |
| Node 전체 회귀 | **337/337 PASS** | 실패·스킵 0; 텍스트·첨부 보존, 멱등성, 브레이크포인트 수명주기, 차단·감사·UI 계측 포함 |
| 실제 사용자 Send 요청의 Prefix 결합 | **NOT OBSERVED** | 관측 시점의 두 창 모두 `requestBoundaryVerified=false`, `forwarded=0`; 장착만으로 송신 성공 주장 금지 |
| 네이티브 IPC / TLS / 서버 수신 | **NOT OBSERVED** | 실제 송신 본문과 수신 증거 확보 필요 |
| 모든 송신 경로 100% 커버리지 | **NOT VERIFIED** | 기본 입력 외 음성·편집·후속·대체 IPC·업데이트 경로 E2E 필요 |
| 최종 릴리스 / 원격 push / tag | **NOT DONE** | 현재 제품 `0.0.2 Candidate` 유지, 승인 없는 원격 게시 없음 |

기술 계약 및 검증 단계: [CII](CII.md) §4.0, [ARCH](ARCH.md) §28.14, [UI](UI.md) §2.7. 아래 322/322와 310/310 테스트는 각 시점의 **과거 기준선 결과**이며, 현행 관측 상태를 대체하지 않습니다.

## 이전 CII 단계별 로깅 검증 — 2026-10-27

**판정: 코드·로깅 회귀 PASS / 실제 사용자 창 적용·네트워크 수신 NOT RUN.**

| 확인 항목 | 결과 | 증거 |
|---|---|---|
| 4모듈 전체 Node 회귀 | **322/322 PASS** | 실패·취소·스킵 0, 독립 Node 테스트 실행기 |
| 기존 추적 누락 결함 | **FIXED (코드)** | `guard-first.mjs`의 빈 `peekTrace()`를 실제 256개 제한 이벤트 큐와 `ackTrace()`로 교체 |
| 단계별 Prefix 삽입/실패 | **PASS (모의 송신)** | 이벤트 → 편집기 → Prefix 계획 → 실제 삽입 → 즉시 검증 → 140ms 검증 → Send 클릭/실패 원인 |
| 다중 창 및 SAFE_BYPASS | **PASS (회귀)** | 한 창이 DEGRADED여도 `persistCiiTraces()` 호출, 창별 `targetKey`/시도 ID 분리 |
| 비밀자료 누출·로그 순서 | **PASS (회귀)** | Prefix/메시지/URL/원본 창 ID 비기록, 저장 실패 시 ACK 금지, 버퍼 초과 추적 |
| UI 상태 패널 | **PASS (정적·회귀)** | 모든 단계 표시 코드 존재 및 컴파일; UI 독립 watcher의 `SAFE_BYPASS` → `DEGRADED` |
| 실제 데스크톱 사용자 Send + 지속 로그 | **NOT RUN** | 실행 중인 기존 CII watcher의 모듈 교체/재시작 미수행 |
| 네이티브/TLS/서버 수신 | **NOT OBSERVED** | 로컬 입력창 Prefix 검증과 원격 메시지 수신을 구분 |
| Prefix 입력창/말풍선 비표시 | **OPEN BUG** | 진단 추가는 기존 미해결 UI 노출 문제를 수정하지 않음 |

자세한 이벤트별 기준: [CII](CII.md) §4.5, [ARCH](ARCH.md) §28.13. 아래 310/310 및 2026-10-26 기록은 이전 기준선 검증 이력입니다.

## 현행 Source/Doc 기준선 검증 — 2026-10-27

**판정: 자동 회귀 PASS / 실제 GUI·원격 E2E 미완료 / 제품 릴리스 승인 보류.** 현재 버전은 `0.0.2 Candidate`이며, `0.0.3`이나 `v0.0.2` 정식 태그를 선언하지 않습니다.

| 검증 대상 | 결과 | 범위 및 한계 |
|---|---|---|
| 전체 4모듈 Node 회귀 | **PASS 310/310** | `npm --prefix out test`; 실패 0, 취소 0, 스킵 0. 실제 실행 결과의 TAP 집계까지 검증 |
| 테스트 실행기 자체 | **PASS 3/3** | SPARK에서 상속되는 Node 테스트 워커 상태 제거, 테스트 0개 시 성공 오판 방지, 실패·스킵 구분 |
| JavaScript / JSON / PowerShell 구문 | **PASS** | JavaScript **85/85**, JSON **7/7**, PowerShell **22/22** (신규 테스트 실행기 포함) |
| 소스·문서 경로 | **PASS (정적)** | 추적 Markdown 15개 링크 대상 존재, 손상된 문자·폐기된 모듈 경로 없음 |
| 외부 터널 실행 파일 | **Git 비추적 유지** | 로컬 도구 바이너리는 소스 커밋·배포 후보에서 제외; 실행 파일 삭제·덮어쓰기 없음 |
| CII 실제 접두사 전송 | **OPEN BUG / NOT VERIFIED** | 입력창·말풍선 Prefix 노출 결함. TLS 직전/서버 내부 수신 증거 없음. 자동 테스트 통과를 최종 기능 수락으로 간주하지 않음 |
| 실제 Windows Tray/CDP·원격 MCP·신규 설치 | **NOT RUN** | 실사용 UI 조작과 원격 인증·10개 도구 호출의 별도 E2E 필요 |
| 정식 버전 태그 / GitHub 원격 push | **NOT DONE** | 소스 커밋과 제품 릴리스·원격 게시를 분리, 사용자 승인 없이 게시하지 않음 |

이하에 있는 더 작은 테스트 수(`231/231`, `240/240` 등)는 **각 날짜의 과거 검증 기록**입니다. 현재 전체 회귀의 기준은 이 절의 최신 실행 결과입니다.

**Target:** 0.0.2 Consolidated Transport / UI / Log / CII baseline
**Inherited baselines:** `v0.0.0` private-use, `v0.0.1` multi-user / deployment
**Review date:** 2026-09-16
**Review type:** Author self-check + automated evidence — **independent peer review 아님**

## 0. 최신 문서 비노출·독립 설치 재현성 감사 — 2026-10-26

**판정: 공개용 매뉴얼 경로 표기 PASS / 전체 공개 아티팩트 BLOCKED / 실제 신규 Plugin 인증 E2E NOT RUN.**

| 감사 대상 | 실제 검사 결과 |
|---|---|
| README·TRANSPORT·ARCH·QGate·RELEASE·CII·UI·LOG·모듈 설명서 | **PASS (정적)** — 추적된 공개 문서 파일에서 내부 실제 디렉터리명·개인 절대경로·인증 저장소의 구체적 하위 구조를 없애고 목적별 `<사용자 설정 파일>`, `<MCP 인증 파일>`, `<사용자 비공개 영역>` 표기 등으로 대체 |
| 공개 후보 전체 소스 스캔 | **BLOCKED** — 현재 추적 파일 148개 중, 원본 방법론/제외 규칙의 내부 식별자 **6회**, 소스·스크립트·테스트 내 관련 식별자 **94회** 감지. 해당 파일의 불변성/런타임 계약을 우회 수정하거나 배포를 진행하지 않음 |
| 다른 에이전트의 새 PowerShell 진입 | **PASS (정적 + 읽기 전용 실행)** — 파일 탐색기에서 프로젝트 루트로 PowerShell 시작, `Test-Path .\out\SPARK.ps1=True`, 실제 설정·토큰 경로 조회 API 실행 확인. 새 터미널이 이전 변수와 CWD를 상속한다고 가정하지 않음 |
| OpenAI Platform Tunnel 권한·Workspace 연결 | **PASS (공식 문서 대조)** — 생성은 Read + Manage, 실행/선택은 Read + Use, 대상 ChatGPT Workspace 연결 필요 |
| 현행 Plugins 인증 방식 | **BLOCKED / NOT VERIFIED** — 현재 공식 안내의 고정 API-key/Bearer 입력 지원을 계정에서 실증하지 못함. 지원 메뉴가 없는 경우 `No authentication` 또는 임의 OAuth로 대체하지 않고 설치를 중단하도록 문서화 |
| Legacy Apps 설치 사진 | **PASS (정적)** — PNG 11장 각각 설치 단계 바로 아래에 유지. 실패 화면을 도구 연결 성공 증거로 사용하지 않음 |
| 문서 전용 자동 회귀 | **PASS 14/14**, 실패·스킵 0; 문서 경로 검출과 작업 디렉터리 독립성 인수조건 추가 |
| 실제 ChatGPT 신규 설치/원격 작업 | **NOT RUN** — 사용자 Workspace 인증·10개 원격 도구 E2E 미실행. 설치 완전성을 주장하지 않음 |

**변경 전 복구:** 메인 Git `refs/spark/recovery/agent-guide-audit-20261026-232506-main`, 독립 SWE1 Git `refs/spark/recovery/agent-guide-audit-20261026-232509-swe1`의 worktree/index 원본 Git 객체 해시 확인. 기존 staged/unstaged 상태 및 타 작업자의 변경 보존. **최종 전체 Node 자동 회귀 240/240 PASS(실패·취소·skip 0)**. 원격 사용자 계정의 실제 설치·MCP CRUD 호출 검증은 별도 NOT RUN으로 유지합니다.

## 설치 가이드 최신 인수 결과 — 단일 TRANSPORT 매뉴얼

**문서·자동 회귀: PASS. 배포/실사용 인수: 별도 미완료.** 사용자가 이전 README 캡처 갤러리 구성을 반려했으므로, 아래 판정이 이후의 역사적인 `0.2` README 갤러리 PASS보다 우선합니다.

| 검사 항목 | 실측 결과 |
|---|---|
| 설치 문서 역할 분담 | **PASS** — README는 제품 소개·TRANSPORT 링크만 유지하고 중복 캡처 표·설치 명령 제거 |
| 사용자 실행 순서 | **PASS** — TRANSPORT를 1 준비 → 2 Tunnel → 3 Windows 설치 → 4 시작/검사 → 5 ChatGPT 연결 → 6 실사용 Smoke Test → 7 FAQ → 8 운영으로 재구성 |
| 화면 선택 오류 방지 | **PASS (문서)** — Plugins의 `Add custom MCP server`와 Apps `Create → Draft → Publish → Connect`를 사용자 화면에 따라 1개 경로만 선택하도록 안내 |
| 실제 PNG 배치 | **PASS** — `Picture1.png`~`Picture11.png` 각각 **TRANSPORT `5.3.1~5.3.11 바로 아래 1장씩**, 클릭 확대 가능; README에는 단계별 PNG 0개 |
| 실패 사진 오인 방지 | **PASS** — Picture7 `No actions are available`, Picture9 `None enabled`를 실패/미완료로 구별 |
| 필드·인증·권한·명령 | **PASS (코드/문서 대조)** — Tunnel ID/Workspace, 생성 Read+Manage, 실행 Read+Use, 별도 Runtime API key와 `spk_...` MCP Token, `init`, 상태 `healthy`/`identity=verified`/`control-plane=ok`, 10개 도구, FAQ 8개 |
| Markdown 실제 렌더링 및 이미지 무결성 | **PASS 13/13** — 설치 단계별 PNG 순서·링크·파일 SHA-256·서명·크기·메타데이터/끝부분 검증, 렌더링 HTML `<img>` 11개 확인 |
| 최종 4모듈 Node 회귀 | **PASS 231/231** — 최종 `npm --prefix out test` 재실행, 실패 0·취소 0·스킵 0 |
| 변경 전 복구 기준점 | **PASS** — 메인 Git `refs/spark/recovery/install-guide-20261026-223654-main`, 프로세스 독립 Git `refs/spark/recovery/install-guide-20261026-223657-swe1`; 각각 staged/unstaged Git 객체 해시 검증 |
| 외부 계정에서 실제 신규 설치·MCP 호출 | **NOT RUN** — 현재 사용자 Workspace의 버튼·연결·원격 CRUD를 새 PC에서 실증한 것은 아님 |
| 최종 공개 준비 | **BLOCKED** — 상위 방법론 원본과 배포 정책의 내부 이름 충돌이 별도로 미해결; 공개 게시·태그·서비스 변경 없음 |

**주의:** 여기서의 PASS는 설치 매뉴얼의 정합성, 로컬 소스와 자동 검증 범위에 한합니다. 실제 타인 PC에서 단독으로 설치 완료한 사용자 시험은 수행하지 않았으므로 무조건적인 '초등학생도 100% 설치 가능' 판정을 하지 않습니다. 이후 `0.2`에 남은 README 11장 갤러리 기록은 **이전 폐기된 구성의 역사적 증거**이며, 현재 수용 기준이 아닙니다.

## 0.0.1. Stop → Start 수동 인수시험 사전 점검 — 2026-10-26

**판정: 코드·격리 시험 PASS / 실제 Tray 클릭 시나리오 NOT RUN.** 사용자가 직접 Windows Tray Stop → Explorer 또는 Tray Start 시험을 수행하기 전에, 기존 Stop 누락 사항을 수정했습니다.

- **정적·비간섭 회귀 PASS:** 4개 모듈의 30개 파일, **219/219 PASS** (실제 휴지통 삭제/재부팅 시험은 제외). 별도 가상 Windows 환경 종료 시험 **5/5 PASS**, PowerShell 구문 오류 0.
- **Stop 수정:** `stop-all.ps1`에서 CII 감시기를 CDP 종료 이전에 멈추고, UI watcher·모든 ChatGPT.exe·소유권 확인된 Tunnel·Transport의 종료를 계속 시도합니다. 단계별 오류를 집계하고 CII/UI/ChatGPT/Tunnel 잔존 프로세스 및 Transport/Tunnel endpoint까지 확인합니다. 하나라도 남으면 Stop은 FAIL이며 Tray는 종료하지 않습니다.
- **실제 프로세스 식별 (읽기 전용):** 수정된 프로세스 검색 함수로 CII watcher PID `18940`, UI watcher PID `4548`, Tunnel PID `17040`, ChatGPT.exe 12개를 식별했습니다. 이 조회에서 실제 종료는 수행하지 않았습니다.
- **새 CII 버전 검증:** 최신 Guard/CLI는 `EGRESS_ONLY_V4`이며 CII 회귀 22/22 PASS입니다. 하지만 기존 사용자 세션의 read-only Probe는 구형 `EGRESS_ONLY_V3` 두 대상을 보고해 `active=false`였습니다. Stop → 새 Start 이후 V4 및 `dryRunVerified=true`와 CII 활성화를 실제 재검사해야 합니다. Hooks arm/readiness와 서버 메시지 접수는 별개입니다.
- **Explorer 직접 더블클릭:** 현재 `.ps1` 파일 연결 UserChoice는 AppX packaged-app 핸들러입니다. `powershell.exe -File` 경로는 앞서 실제 시험했지만, Explorer의 일반 더블클릭이 PowerShell로 실행되는지는 검증하지 않았습니다. Tray Start 또는 `out/SPARK.vbs`가 등록 의존성이 없는 시작 경로입니다.
- **보증 경계:** 실제 사용자 Tray 메뉴 마우스 클릭 및 완전 종료 후 V4 UI/CII 재실행은 이 변경 이후 수행하지 않았습니다. 시험 전에는 100% 통과 보증이나 E2E PASS를 선언하지 않습니다. 사용자 인수 후 실제 로그·프로세스·CDP/CII 결과로 PASS/FAIL 판정합니다.

## 0.0.2. 6.3 Tray AutoStart 하위 메뉴 간소화 — 2026-10-26

**판정: 코드/격리 WinForms/Tray-only reload PASS · 실제 사용자 메뉴 클릭 미검증.**

- 최상위 Tray 메뉴에서 AutoStart는 한 줄의 하위 메뉴 항목이며, 하위 옵션은 `ON`/`OFF` 두 개입니다. 실제 Windows 사용자 Startup 단축아이콘을 조회하여 하나에만 체크하며, 열 때와 선택 직후 다시 검증합니다. 충돌/조회 오류는 OFF로 오인하지 않고 두 옵션을 비활성화합니다.
- 독립 WinForms 테스트가 실제 Tray의 `Update-AutostartStatus`·`Set-AutostartMode` 함수로 **OFF → ON → OFF → CONFLICT** 상태와 체크 표기를 검증했습니다. 실제 Windows Startup 설정은 변경하지 않았습니다.
- 4모듈 전체 비간섭 회귀 **223/223 PASS**, 테스트 파일 30개, 실패·건너뜀 0건. PowerShell Tray 파서 오류 0.
- 기존 Tray PID `33948`만 검증 후 종료, 기존 supervisor PID `28552`에 의해 새 Tray PID `10436`이 자동 기동. 실제 Shell 등록 `main` 확인. ChatGPT PID 집합과 Tunnel PID 불변. AutoStart 실제 상태 `OFF` 유지.
- 사용자가 직접 Tray를 열고 하위 메뉴의 체크와 클릭 결과를 확인하는 GUI 마우스 시험은 **NOT RUN**입니다. 전체 Transport/Tunnel/UI/CII 재시작은 수행하지 않았습니다.

## 0.1. SWE1 §6.3 (REQ-S2-Q-018) — Windows reliability revalidation · 2026-10-26

**현행 판정: PARTIAL PASS.** 이 절은 아래 0.0.2 통합 중 이전 상태의 195/195 및 "FAIL / 재검토 필요" 기록 이후의 새 실행 증거입니다. 정적 테스트 수치만으로 전체 운영 안정성을 단정하지 않습니다.

| 대상 | 2026-10-26 현재 증거 및 판정 |
|---|---|
| 계획된 Windows 재부팅 원인 | **CONFIRMED** — Windows System Event ID 1074, `MoUsoCoreWorker.exe`가 계획된 Windows 업데이트 재시작 요청; 6006/6005 종료·시작 이벤트 관측 |
| Explorer PowerShell 무인수 클릭 | **FIXED / LIVE PATH PASS** — 이전 `SPARK.ps1` 기본값 `help`→ 종료를 수정하여 숨김 `SPARK.vbs start` 호출; 실제 무인수 PowerShell 실행 성공 및 자식 lifecycle 완료 |
| Tray Stop 이후 Start·테마·CII 복구 | **LIVE E2E PASS** — VBS Stop 완료·Transport Health 하락 확인, Tray/감시기 생존, 무인수 PowerShell 실행→Transport Bearer Health/Tunnel Control Plane/UI CDP/CII 훅/Tray 검증, `spark-lifecycle.log` start exitCode=0 |
| Tray 감시기 실제 자동 재생성 | **LIVE PASS** — 검증된 이전 Tray PID `26316`만 강제 종료; supervisor PID `28552`가 새 Tray PID `33948` 생성·등록; Shell heartbeat `main`→`overflow` 관측 |
| Tray 메뉴 Start/Stop/Restart·AutoStart | **PARTIAL** — 실제 Stop과 Start의 *동일한 VBS action 경로* 테스트 PASS; Tray UI 메뉴 클릭 위치·Autostart 메뉴 마우스 클릭은 수행하지 않음 |
| AutoStart 사용자 로그인 ON/OFF | **PASS for user Startup registration** — 실제 `autostart on` 등록 후 `status=ON`, 격리 Startup fixture ON/ON/OFF/OFF/STATUS 7단계 및 다른 사용자 링크 충돌 방지 PASS |
| Windows 재부팅·로그인 자동 재생성 | **NOT RUN** — 실제 재부팅·로그아웃/로그인 시뮬레이션은 수행하지 않았음; 로그인 전 GUI/Tray 시작은 설계 범위 밖 |
| Tray 화면 표시·고정 | **PARTIAL** — Shell API와 heartbeat에서 `main` 및 `overflow` 모두 등록 확인; overflow는 숨겨진 아이콘 영역이므로 화면 작업 표시줄에 항상 표시되거나 사용자가 아이콘을 육안 확인했다고 주장하지 않음 |
| CII 접두어 실제 서버 전송 | **NOT RUN** — 재시작 뒤 `EGRESS HOOKS ARMED`, 독립 `probe active=true`, 대상 1–2개 확인; 실제 사용자 메시지를 자동 전송하거나 서버 수신 payload를 검증하지 않음 |
| 현행 전체 비간섭 Node 회귀 | **PASS 205/205** (4개 모듈·29개 테스트 파일, 실패·skip 0). 기존 위험한 무인수 help 테스트는 명시적 `--help`로 수정. 휴지통 실제 삭제와 OS 재부팅·포커스 변경 테스트는 제외 |
| Public Wiki 6.3 문서 갱신 | **PASS** — 11개 허용 Markdown, 내부 링크 누락 0, 보안 패턴 0, Private Wiki 조상 커밋 없이 Public Wiki fast-forward 커밋 `34b4d02` 게시 |

**검증 경계:** 통합 시험의 첫 실행은 stop 완료 로그를 기다리지 않아 시험 도구 FAIL, 두 번째 실행은 `active.json` UTF-8 BOM을 처리하지 않아 시험 도구에서 잘못된 판정이 발생했습니다. 수정한 세 번째 격리된 실행 기록은 `<검증 결과 기록>`의 `status=PASS` (UTC `2026-10-26T17:38:14.870Z`)로, Stop 완료 후 실제 서비스 상태·Tray 생존·CDP/CII를 별도로 확인했습니다. 최초 두 시험의 FAIL을 제품 버그 수정 성공으로 둔갑시키지 않습니다.

**릴리스 결론:** 6.3의 명시적 Stop→재실행 장애는 재현·수정됐으나, 실제 Windows 재부팅 이후 로그인, 메뉴 마우스 클릭, 아이콘 주 작업 표시줄 고정, CII 서버 메시지 전송은 별도 QGate입니다. 0.0.2 정식 릴리스/태그/공개 소스 갱신은 아직 승인되지 않았습니다.

## 0.2. README PNG · 비간섭 전체 회귀 재검증 — 2026-10-26

**현재 판정: PASS (문서·정적·격리 회귀), 출시 QGate는 여전히 BLOCKED.** 이전 195/195 및 6.3의 205/205 결과를 삭제하거나 현재 소스의 검증으로 재사용하지 않습니다.

| 검사 | 현재 확인 결과 |
|---|---|
| 사용자 캡처의 README 직접 활용 | **PASS** — `doc/png/Picture1.png`~`Picture11.png` 모두 README에 실제 `<img src>`로 표시, 클릭 시 원본 PNG 링크 및 화면별 목적·판정 설명. 이전의 대표 이미지 1장만 표시하던 문제 수정 |
| TRANSPORT 설치 가이드와 캡처 일치 | **PASS (정적)** — 기존 11개 PNG의 상대경로·파일 시그니처·크기·SHA-256, 최초 설치·인증·FAQ 8개·MCP 도구 10개·Legacy UI 문구 검사 |
| 최신 OpenAI 안내와 구 UI 구분 | **PASS (문서)** — 현재 Plugins → Add custom MCP server → Create as a plugin 및 2026-09의 Apps/Draft/Publish 절차 분리; 공식 안내 2026-10-26 조회 |
| 최종 전체 Node 회귀 | **PASS 221/221** — `npm --prefix out test` 실패 0, 취소 0, 스킵 0. 위험한 PowerShell 무인수 실행은 도움말 테스트에서 제거; 독립 런처 경로 검사는 별도 수행 |
| Windows PowerShell 구문 검사 | **PASS** — 현행 추적 스크립트 및 신규 스크립트 총 22개 정적 ParseFile 검사, 오류 0 |
| UI 테마·Git 변경 검사 | **PASS** — `npm --prefix out run chatgpt-ui:validate`(schemaVersion 4), `git diff --check`(오류 0) |
| 변경 전 원복 검증 | **PASS** — 메인 Git `refs/spark/recovery/png-regression-20261026-193651`, 비공개 프로세스 Git `refs/spark/recovery/png-regression-20261026-193701`, staged/unstaged 원본 Git 객체 해시 확인 |
| Windows UI·Tray 메뉴 클릭·재부팅 E2E | **별도 판정 유지** — 기존 §0.1에서 실측한 부분 외의 실제 재부팅/메뉴 클릭은 NOT RUN |
| CII 실제 송신·서버 수신, 원격 MCP CRUD | **NOT RUN** — 로컬 단위 테스트로 성공을 대체하지 않음 |
| **2026-10-26 실제 CII 실행 버전 일치성** | **CURRENT: ACTIVE 2/2 (훅 설치 검증 범위)** — 최초 읽기 전용 검사에서는 데스크톱 두 페이지 모두 V3 훅으로 DEGRADED였으나, 이후 재조회에서 **두 대상 모두 `EGRESS_ONLY_V4`, nativeView=true, dryRunVerified=true, probe active=true**를 확인함. `outboundModified=0`으로 실제 사용자 메시지 변환·서버 수신은 여전히 미검증. 이번 문서·회귀 작업은 CII watcher를 강제 재시작하지 않았으며 시점별 관측을 별도로 보존함 |
| 최종 Public Snapshot 개인 경로명 무노출 | **BLOCKED** — 내부 원본 방법론/로컬 제외 정책의 식별자 충돌이 미해결이므로 공개 배포 금지 |

**회귀 방지:** 문서 테스트는 README에 PNG 11개를 실제 인라인 렌더링하는 HTML 태그·원본 링크뿐 아니라 로컬 Markdown 렌더러가 출력한 HTML 이미지 11개와 표 구조를 검사하여, 상세 매뉴얼에만 이미지가 남고 README는 텍스트로 축약되는 퇴행을 실패 처리합니다. 독립 HTML/브라우저/Obsidian 실화면 렌더링과 사용자 Workspace의 화면 캡처 검증은 미수행입니다.

## 0. SPARK 0.0.2 Consolidation QGate — 2026-10-26

**현재 판정: IN PROGRESS.** 아래 0.0.1 실증 기록은 이전 기준선에 대한 역사적 검증이며 현재 0.0.2 전체를 입증하지 않습니다.

| 검증 범위 | 0.0.2 현재 판정 |
|---|---|
| **6.3 이전의 과거 회귀 (Historical FAIL)** | 직전 VBS/PS1 무인수 실행 의미가 바뀌며 Log help 테스트가 실제 사용자 세션 시작을 발생시켰던 과거 실패 기록입니다. 현재 안전한 명시적 `--help` 검사로 수정했고 현행 6.3 결과 **205/205 PASS**를 이 절보다 위에 기재했습니다. |
| **2026-10-26 README/Transport 재구성 및 회귀** | **PASS (정적)** — Git 복구 ref 검증, 현행 Plugins와 기존 Apps 설치 분리, 11개 Legacy 캡처 실제 화면/링크/SHA-256 확인, 기존 설치 단계·FAQ·10개 MCP 도구 안내 보존 |
| **6.3 이전 Node 회귀 (Historical PASS)** | 당시 파일 상태에서 195/195 PASS 기록입니다. 현재 수정된 파일의 합격 근거는 상단 6.3의 **205/205 PASS**이며 두 결과를 혼동하지 않습니다. |
| **Public 전체 아티팩트 내부 경로명 무노출** | **BLOCKED** — 사용자용 모듈 매뉴얼은 내부 경로를 추상화했지만 원본 방법론 문서와 로컬 Git 제외 규칙은 아직 내부 작업 공간명을 포함합니다. 두 원본은 별도 불변성 계약이 있어 무단 변경 금지; Public 전체 검사 및 배포 정책 확정 전 게시 불가 |
| **현재 ChatGPT Plugins 원격 설치·실사용 E2E** | **NOT RUN** — 최신 공식 절차 문서 확인과 실제 사용자의 Workspace에서 생성/Connect/10-tool 원격 CRUD 인수시험은 별개이며, 이번 작업에서 원격 설치·GUI·서비스 재시작을 실행하지 않음 |
| Source/CLI/manifest 제품 버전 | PASS — `0.0.2` 3중 검사; 확정 `v0.0.2` 태그는 보류 |
| <internal-methodology> AGENTS exact copy | PASS — SHA-256 `16c33a51e1b26dff0b43892264a7100a9cbcb654a4c26fb2bcc3f3380f129c28` |
| Transport/UI/Log/CII 분리 문서 | PASS — README, TRANSPORT/UI/LOG/CII 매뉴얼 작성 |
| 영속 자료를 `<사용자 비공개 영역>`·`log` 밖으로 분리 | PASS — ChatLog 4개·감사 1개·UI 기준선 3개·녹화 2개를 사용자 데이터 폴더로 SHA-256 검증 이전; `<과거 비공개 데이터 영역>` 제거 후 새 감사 이력 증가 실측 |
| `log/` 영속 데이터 제거 | PASS — 레거시 PAL 스냅샷 513개·감사 이력 디렉터리 정리, 새로운 Transport 구 복구 폴더 재생성 없음 |
| Tunnel 프로필 자동 백업 금지 | PASS (정적·로컬) — 자동 프로필 백업 함수 및 `init --force` 제거, 기존 프로필 SHA-256과 활성 Tunnel identity 일치, 레거시 YAML 3개 Windows 휴지통 정리; 전체 데몬 재시작은 미실시 |
| 전체 Node/PowerShell 테스트 | PASS — 재시작 후 비간섭 182/182, PowerShell 20/20 구문 검사, UI/CII 개별 동작 검증; Windows 휴지통 이전은 데이터 정리 과정에서 실증 |
| 0.0.2 Windows/Linux GitHub CI | NOT RUN |
| 실제 UI metadata/wrapping, signed-in CII send | PARTIAL — 재시작 후 UI CDP 활성, CII `ACTIVE`·2개 대상 주입 검증; 실제 외부 메시지 송신 및 화면 폭 변경 E2E는 수행하지 않음 |
| 0.0.2 데몬·Tunnel·ChatGPT 재시작 | PASS (실제 프로세스/건강 상태) — Transport 0.0.2, Tunnel Identity Verified/Control Plane OK, ChatGPT 전체 13개 프로세스 교체, UI CDP 활성; 시작 실행기의 time-limit 표시 불일치는 별도 점검 항목 |
| 0.0.2 Public 소스 단일 루트 커밋 | NOT RUN — Public `main`은 여전히 기존 기준선 `8c6e2e6`; Source 0.0.2 발표/배포 보류 |
| Public Wiki 0.0.2 문서 게시 | **PASS** — 6.3 신뢰성·AutoStart 문서 포함 11개 페이지, 원격 Wiki `master=34b4d022eed50cc1b01b684ed61b05c4a9c23e57`, Private Wiki 이력 미포함. Public 소스 `main`은 미변경. |

**Release rule:** 필수 QGate에 NOT RUN이 남아 있으면 제품 후보를 태그/게시하지 않고 다음 단계로 이월합니다. 이 아래 0.0.1 리뷰는 역사적 증거입니다.

## Historical 0.0.1 review (preserved)

| 항목 | 결과 |
|---|---|
| 0.0.0 Brain Gateway / Agent Core / Body Port separation | PASS — inherited |
| MCP standard / no proprietary protocol extension | PASS |
| 10-tool CRUD/process surface unchanged | PASS |
| traversal / absolute / symlink / Windows junction containment | PASS |
| write/modify recovery + Windows Recycle Bin / no permanent fallback | PASS |
| command output bound + process-tree timeout cleanup | PASS |
| synchronous command/tool/request/lifecycle waits bounded | PASS |
| timed-out mutation `stateUncertain` + overlapping mutation fail-closed | PASS |
| per-instance Bearer authorization positive/negative regression | PASS |
| `Access_token` excluded from config; stored only in `<MCP 인증 파일>`; digest derived in memory only | PASS |
| access-key generator = 32 CSPRNG bytes / 256 bits | PASS |
| `SPARK init` refuses existing config overwrite | PASS |
| new-install requires `<MCP 인증 파일>`; config contains no auth key/digest/path; missing token cannot start an MCP server | PASS |
| distinct per-user/device tunnel + per-instance credential architecture | PASS — architecture/implementation boundary documented |
| central SPARK payload relay absent | PASS |
| ChatGPT UI progress overlay source regression | PASS |
| ChatGPT Windows DOM progress experiment | PASS — sidebar top/bottom panels remain visible without covering Search/Update; Brain/SPARK states update live |
| popup-free provider usage telemetry | PASS — authenticated ChatGPT Desktop background `GET /wham/usage` source read without opening the Usage popup; live values `5H 100%`, `WK 76%` matched the provider popup |
| provider-usage failure behavior | PASS — 30-second cache/fail-soft refresh with local/model/chat fallback; no fabricated quota values |
| ChatGPT UI PowerShell-BOM runtime JSON compatibility | PASS |
| tunnel-readiness console progress suppression | PASS — PowerShell web-request progress UI hidden while polling/watchdogs remain active |
| auth-aware tunnel readiness | PASS — `ready (mcp initialize requires auth: ...)` accepted as ready rather than timing out |
| `SPARK.cmd restart` label simplification | PASS — recursive `call`/`:restart` dependency removed; direct stop → start lifecycle path |
| private config/runtime excluded from Git | PASS |
| 과거 Git 제외 정책 및 Private 구성 | PASS — 당시의 별도 기록이며 현재 Public 비공개 경계 검증과 구분합니다 |
| auth-hardening Node regression | PASS — head `e001537cbf80cb7a71595d49b6a9d4a05c1efb8e`; 48 tests / 46 pass / 2 platform skips / 0 fail |
| `auth:none` production startup prohibition | PASS — automated regression proves startup failure |
| ChatGPT UI validate | PASS — candidate source |
| PowerShell parser gate | PASS — start/stop/init/bootstrap/validator/ChatGPT UI out/spark/script |
| integrated 0.0.1 runtime stop/start + Transport/Tunnel/ChatGPT UI recovery | PASS — live runtime restored and SPARK tools/UI watcher remained usable |
| Windows live `SPARK.cmd validate` after restart onto active 0.0.1 source | PASS — CRUD/write/modify/copy/move/run_command/traversal rejection/Recycle Bin file+directory completed on the live runtime |
| ChatGPT `Access_token` own-token success / missing-or-wrong-token denial | PASS — live own-token call succeeded; missing token HTTP 401; wrong token HTTP 401 |
| Ubuntu Node 24 CI on exact 0.0.1 baseline head | PASS — exact SHA/run recorded in local-only SWE3 |
| Windows Node 24 CI on exact 0.0.1 baseline head | PASS — exact SHA/run recorded in local-only SWE3 |
| ProcessService filesystem/network confinement outside FileService roots | **TBD / KNOWN GAP** — current `X` gates cwd only; child authority remains ambient OS-user authority |
| hostile process on the same local PC calling loopback SPARK | **TBD** — explicitly outside 0.0.1 remote/workspace-user isolation scope |
| Independent Architecture Peer | DEFERRED / NOT 0.0.1 BLOCKER — author self-check is not represented as independent review |

## 1. 0.0.1 Acceptance Evidence

Baseline acceptance requires all of the following before the final `v0.0.1` tag is created or moved:

- package/runtime/launcher version all report `0.0.1`.
- `npm test` full regression PASS.
- `npm run chatgpt-ui:validate` PASS.
- PowerShell lifecycle/parser PASS.
- tracked repository hygiene/privacy/secret check PASS.
- `SPARK auth generate` produces a 256-bit prefixed token and a matching SHA-256 digest.
- `SPARK init` creates a new private config/access-key secret but refuses to overwrite existing state.
- runtime startup requires a valid `<MCP 인증 파일>`; config contains no auth key, digest, or secret path, and missing/invalid token fails closed.
- bearer-auth MCP requests reject missing/wrong keys and accept the configured instance key.
- watchdog regressions prove tool/request/lifecycle control returns within declared bounds.
- experimental progress UI renders on the real ChatGPT Windows DOM and remains removable/recoverable.
- after runtime restart, Windows `SPARK.cmd validate` PASS on the 0.0.1 source.
- ChatGPT custom app configured with `Access_token` + Bearer succeeds with its own SPARK instance value and returns HTTP 401 for a missing or different value.
- GitHub Actions Ubuntu Node 24 PASS.
- GitHub Actions Windows Node 24 PASS.

Exact candidate SHA, CI run IDs and final live runtime acceptance belong in the non-public verification backlog.

## 2. Findings / Debt

- **DEBT-001:** Native Windows Job Object remains the preferred stronger long-term process-ownership backend.
- **DEBT-002 / TBD:** `run_command` cwd containment is not an OS filesystem/network sandbox. If a root grants `X`, the launched process may access other locations allowed by the ambient OS account. FileService R/W and Recycle Bin semantics do not constrain arbitrary child-process I/O. Provider-native ProcessService confinement remains deferred.
- **DEBT-003 / RESEARCH:** Cygwin remains only a possible Windows POSIX/ACL File/Permission PAL helper; it is not a ProcessService sandbox.
- **DEBT-004 / TBD:** same-PC hostile local-process isolation remains deferred; 0.0.1 prioritizes remote/workspace-user cross-access prevention.
- **DEPLOY-001:** 0.0.1 uses one distinct Secure MCP Tunnel and one high-entropy bearer credential per SPARK instance. It intentionally has no SPARK-operated central payload relay or OAuth service.
- **DEPLOY-001A / KNOWN TRUST BOUNDARY:** OpenAI Secure MCP Tunnel forwards the ChatGPT `Authorization` header but does not validate SPARK's `Access_token` for SPARK. The local SPARK MCP server is the enforcement point. If an attacker can modify/replace the SPARK server code or execution environment, that compromised instance can remove authentication checks and accept unauthenticated requests. Distributed 0.0.1 source removes the `auth=none` runtime path and fails closed, but it does not provide tamper-resistant code attestation. This does not by itself bypass another intact user's SPARK instance.
- **DEPLOY-002:** `Access_token` is a per-instance connection secret stored only in `<MCP 인증 파일>`; normal SPARK config contains no token, digest, or secret path. SPARK derives the SHA-256 digest only in memory for comparison. Manual generation/rotation remains possible with `SPARK auth generate`.
- **UX-001 / EXPERIMENTAL:** Brain working indication is a ChatGPT DOM heuristic and may require adaptation when the provider UI changes. SPARK watchdog progress is measured locally. ChatGPT quota telemetry currently reuses the provider's authenticated internal `/wham/usage` client/query and therefore may break when the desktop app changes; it must fail soft and never fabricate quota values. The usage integration is UX-only and is not part of the Agent Core or authorization boundary.
- **PROCESS-001 / DEFERRED:** Independent Architecture Peer review has not been executed in this authoring context. Author self-check is not represented as independent review, and this remains a deferred process gate rather than a 0.0.1 blocker.

## 3. Gate Conclusion

**0.0.1 baseline gate: PASS when the exact baseline head has passed Ubuntu/Windows Node 24 CI, local/full validation, live Windows validation, and ChatGPT `Access_token` own-token success plus missing/wrong-token HTTP 401. Exact release evidence is recorded in local-only SWE3.**

`v0.0.1` may be created only on the merged `main` commit that satisfies those gates. Independent Architecture Peer review remains explicitly deferred and is not represented as completed. ProcessService filesystem/network confinement, same-PC hostile-process isolation, and the authentication code-integrity trust boundary remain documented non-blocking gaps rather than implied guarantees.

## 2026-10-25 Maintenance — Runtime Separation and Non-interference Gate

This section is a **maintenance verification supplement**; historical 2026-09 release/CI evidence above is not a new 2026-10 live E2E claim. It does not upgrade author self-check to independent peer review.

| Current maintenance obligation | Verification |
|---|---|
| `<사용자 비공개 영역>` reserved for private user config, authentication keys and SSH material, not PID/ledger/recovery/logs | PASS — runtime root and secret names inspected after cleanup; non-secret runtime directories and stale PID state recycled with verified destination/restore copies |
| Git-ignored `<임시 운영 진단 영역>` is the approved operational state/log root, distinct from user `log/*.jsonl` chat archives | PASS — current private config, source paths, state files and tracked `.gitignore` inspected |
| Existing recovery/ledger migrated without record loss | PASS — 4,344 recovery/profile files byte-verified; 11,676 unique ledger entries preserved during merge |
| Windows on-disk operational data protected from ordinary Users/Authenticated Users | PASS — ACL restricted to current user/SYSTEM/Administrators and inspected recursively by samples; prechange ACL export verified |
| No arbitrary new rollback/recovery directory and no focus-stealing ChatGPT GUI restart | PASS — user-approved existing `<임시 운영 진단 영역>` reused; backend, Tunnel, watcher, tray independently transitioned without ChatGPT app restart |
| Transport bearer health, Tunnel identity/Control Plane, ChatGPT UI theme and watcher | PASS — read-only `SPARK.cmd status` exited 0 with identity verified, Control Plane OK and healthy `dark-red` watcher |
| Full automated source regression | PASS — `npm test` 108/108 at the migration implementation checkpoint; rerun on the final committed documentation/source candidate before claiming final gate |
| Independent architecture peer review and foreground GUI lifecycle E2E | NOT RUN — no such claim, GUI-disruptive test requires separate explicit user approval |

Version/tag `0.0.1` is unchanged. No public GitHub push is implied by this local maintenance gate.


## 2026-10-25 Route Monitor Evidence Logger QGate (SWE2 §4.2)

| Gate / 구분 | 결과 | 관측 근거 |
|---|---|---|
| 기록 버튼은 `Details`를 대체하고 실제 start/stop 명령을 생성 | PASS — 소스 및 독립 unit test | `route-overlay.mjs`, `route-recorder.test.mjs` |
| 실제 기록 이전에 성공 표시를 하지 않음 | PASS — 소스 계약 | command sequence / watcher ack / panel `Saving...`; 성공 시만 active |
| Record 이전에 사용자 대화별 JSONL 미생성 | PASS | 단위 검증으로 미조작 상태 파일 0건 |
| 대화 제목 + UTC 시각 단위 JSONL / 제목 변경 시 분리 | PASS | 기록·제목 변경·중복 명령 테스트 |
| 종료·한도 초과·쓰기 오류가 관측 가능 | PASS (unit) | 16MiB 상한, error status, stop / fail-closed test |
| 메타데이터 이름·출처·허용값 보관, 비밀값 redaction | PASS (unit) | message body, URL, email, token, request-id 미기록 검사 |
| GUI의 `Message delivery timed out`를 UI 관측 오류로 구별 | PASS (unit) | 타임아웃 이벤트 JSONL 기록, 원인 미확정 표기 |
| 수신/송신/독립 resolved/provenance가 분리된 패널 | PASS (static compile/unit) | 새 compact overview, advanced details 및 기존 route/model 회귀 |
| 채팅 제목은 확인된 활성 대화에 한정, 다른 대화 캐시와 혼합 금지 | PASS (unit) | `route-response-model.test.mjs` 활성 대화 제목 검증 |
| 전체 source regression | **121/121 PASS** | 실제 `npm test`, Node 24, Windows |
| 실행 중인 패널 버튼·요약·접힌 근거 DOM | PASS (read-only CDP) | 앱 PID 76692 유지, watcher 48880 -> 51944 -> 62472 교체, Record/8개 요약 행/advanced 기본 접힘 확인 |
| PAL 레거시 복구 4,426개 / 2,128개 폴더 | 과거 검증 기록 | 과거 비공개 보관본의 SHA-256 및 휴지통 이동 증거로 관리합니다. 현재의 백업 경로·정책으로 사용하지 않습니다 |
| 역사적 baseline/전환 로그 37개 | PASS | 제한 ACL ZIP에 원본별 SHA256 검증 후 Recycle Bin 이동, 향후 baseline 2개 고정 파일 이름으로 제한 |
| Transport/Tunnel/UI 상태 유지 | PASS | Transport PID 75476 healthy, Tunnel Ready, watcher 62472 healthy, 앱 76692 유지, opt-in 전 route JSONL 0개 |
| ChatGPT Work 플랫폼 메시지 delivery timeout 원인/해결 | **NOT VERIFIED** | native IPC·서버 request ID/서버 오류 원인이 독립적으로 확인되지 않음 |
| ChatGPT 앱 GUI를 사용해 실제로 Record 클릭 / Stop 클릭 | **NOT RUN** | 사용자의 활성 세션·포커스 보호. 읽기 전용 watcher 상태 관측은 별도 결과로 기록 |
| 별도 독립 Architecture Peer | **NOT RUN** | 이 표는 구현/검증 Agent의 자체 결과. 독립 검토를 가장하지 않음 |

**출시/변경 정책:** 0.0.1 버전은 그대로 유지하며, 원격 GitHub push·tag/release는 명시적인 추가 지시 전에는 금지됩니다. 로컬 Git 커밋은 source/doc 근거를 보존하기 위한 체크포인트입니다. 사용자 대화·실제 기록 파일은 `<임시 운영 진단 영역>`에만 남고 Git에는 올라가지 않습니다.

## 2026-10-25 SWE2 4.3 Layout QGate (historical; superseded by SWE2 §5.1)

| Acceptance | Verified status |
|---|---|
| 공개 모듈 디렉터리와 비공개 프로세스 공간의 분리 | PASS at historical checkpoint; 현재 Public 배포 보안 검사는 별도 필요 |
| Module script ownership, shared out/spark/script, launcher out/package.json | PASS: static tests and read-only commands |
| Reference at ref/transport and chat_history under log/ | PASS: per-file SHA-256 and file existence |
| Private process Git and Wiki Git copied to canonical folders | PASS: matching HEAD, user SWE2 SHA-256 and Git archive |
| Full Windows Node regression and PowerShell parser | **125/125 PASS**; all 11 PowerShell scripts parse |
| Transport/Tunnel health, watcher, tray, ChatGPT app | PASS in live read-only local status |
| Move <사용자 비공개 영역> credentials to canonical H1 | BLOCKED: cannot complete ACL-preserving SSH backup |
| Recycle legacy <internal-process> directory | BLOCKED: actively open Obsidian vault, Windows sharing violation |
| Platform message timeout fix or user-driven Record E2E | NOT VERIFIED |
| GitHub push, tag or release | NOT RUN |

Note: no ordinary root code/artifact is left. Git internals remain required and the two nonconforming H1 folders are explicit TODOs, not evidence of a full cleanup pass.

## SWE2 §5.1 — 프로세스 위치 / PowerShell 통합 / Log 모듈 품질 게이트

**CLI 명칭 변경 확인:** 운영 기록 폴더 `log/`와 혼동하지 않도록 사용자 명령은 `chatlog -b` / `chatlog -v`를 사용합니다. 인수 없음·`--help`는 전 명령 목록, `chatlog --help`는 세부 옵션을 출력합니다. 기존 `log` 명령은 오류와 새 명령 안내만 반환하며 기능은 실행하지 않습니다.

**현재 코드·설계 기준:** 프로세스 문서는 외부에 노출되지 않는 독립 Git으로 유지하고, 공개 소스는 `doc`, `ref`, `mod`, `out`, 임시 `log` 등의 역할을 구분합니다. 3글자 Level1 이름을 선호하지만 폴더 수를 고정하지 않습니다. 잘못 생성된 중복 프로세스 자료는 원본 검증 후 정리되었습니다.

| 검증 항목 | 인수 기준 / 현재 판정 |
|---|---|
| 프로세스 문서의 단일 정식 위치 | 별도 비공개 독립 Git이며 요구사항·설계·이행 및 기존 사용자 원문을 유지합니다 |
| Level0 / Level1 정책 | Level1은 가능한 3글자로 명명하지만 폴더 수를 강제로 고정하지 않습니다. `<사용자 비공개 영역>`은 사용자 수동 검토 영역이므로 이동·변경하지 않습니다 |
| 중복된 프로세스 경로 | 잘못 생성된 비공개 작업 사본은 원본 검증 후 정리되었으며 원본 독립 Git을 유지합니다 |
| Log 모듈 코드·라이선스 | `mod/spark_log/{backup,viewer,script,test}`로 이전, 원본 24개 소스 파일의 SHA-256을 확인했습니다 |
| 통합 PowerShell 실행 | `out/SPARK.ps1`으로 모든 CLI를 제공하고 Log는 `-b`/`-v`로 분기합니다. VBS는 콘솔 숨김/트레이용 1개만 예외로 허용합니다 |
| 중복 CMD/BAT 래퍼 | `SPARK.cmd`, `spark_log_backup.cmd`, `spark_log_viewer.cmd` 등은 실제 새 SPARK 실행 트리에서 제외해야 합니다 |
| Transport | Bearer, Tunnel identity/control-plane, R/W/X·장시간 명령의 기존 기능을 유지해야 합니다 |
| UI | 기존 CDP watcher 및 Opt-in metadata/Record 기능을 유지하며 앱 포커스/재시작을 강제하지 않습니다 |
| Log | Backup 원문 JSONL·SHA-256·선택적 Archive 순서 및 Viewer의 read-only 제약을 유지해야 합니다 |
| 비공개 역사 | 원본 독립 Log 모듈의 비공개 Git 전체 refs와 ignored SWE/보고서를 별도 복구 가능한 비공개 백업에 보존합니다 |
| GUI / 실제 Chat API 호환성 | 활성 사용자 앱에 영향을 주는 Backup/Archive/Viewer 실시간 테스트는 **의도적으로 실행하지 않음**으로 기록합니다 |
| 최종 회귀 검증 및 Git | 전체 Node 테스트 / PowerShell syntax / JS syntax / 라이브 read-only 상태 / 공개·비공개 Git clean을 최종 커밋 직전에 확인합니다 |

세부 Log 설계: [LOG.md](LOG.md). 기술 책임 분리: [ARCH.md](ARCH.md) §27. 미검증 GUI 결과나 외부 플랫폼 timeout의 원인을 검증 완료로 승격하지 않습니다.

**Node 24 / Windows 현행 §5.1 전수 회귀:** `npm --prefix out test` **129/129 PASS** (Transport, UI, Log 포함). 명령행 도움말·로그 모드 충돌·저장소 경계와 라이선스 fixture를 검증했습니다. **실제 사용자 GUI Backup/Archive/Viewer E2E는 미실시**입니다.

## 2026-10-25 ChatLog real-file E2E follow-up

This later check updates the earlier NOT RUN status only for user-authorized Chat Backup and Viewer. Archive, Work Viewer, the UI Record/Stop feature and upstream message timeout are separate, unverified scopes.

| Requirement | Verified result |
|---|---|
| Exact current server chat selected | PASS — server ID and recent user request matched, without switching the current ChatGPT app window |
| JSONL backup under log/chatlog | PASS — 8,899,982 bytes, 2,595 mapping nodes, title/ID/request/SHA-256 verified |
| Read-only Viewer load | PASS — both headless and visible Edge render 1,279/1,279 visible messages |
| Rich content | PASS — 19 HTML tables, 1,171 code blocks, four assets |
| Input immutability | PASS — SHA-256 identical before and after both Viewer runs |
| Fixes verified | PASS — optimistic duplicate sidebar row filtered; stale CDP node replaced by live objectId; retry bounded |
| Source tests | PASS — 134/134 Windows Node tests including three new sidebar/Viewer regressions |
| Activity isolation | PASS — ChatGPT app/Transport/Tunnel were not restarted; failed disposable Edge instance recycled and working Viewer remains open |
| Native Archive / Work Viewer / message timeout | NOT RUN — not part of this requested demonstration |

See LOG.md section 16. The exact private chat identity and SHA-256 are documented in the user-private SWE3 file, not public source.

## 2026-10-25 ChatLog backup completeness + default-browser correction

The earlier 2026-10-25 `1279/1279` Viewer test only showed that the file contents rendered. It was **not evidence that the live server conversation had finished**, and the initial snapshot was incomplete. This correction supersedes that inference.

| Acceptance | Latest verification |
|---|---|
| Previous full assistant final captured | **PASS**: refreshed server raw active branch contains the previously missing finished final response |
| User's new backup complaint included | **PASS**: newest user message is present in refreshed raw JSONL |
| Stored JSONL integrity | **PASS**: 2,699 mapping nodes, 9,455,934 bytes, previous file preserved by SHA-256-verified `.bak` |
| Latest ongoing response accurately labeled | **PASS**: `SnapshotStatus=latest-user-turn-not-finished` and Viewer `INCOMPLETE SNAPSHOT` instead of a false full-success claim |
| User-facing Viewer filtering | **PASS**: tool code, hidden reasoning and incomplete assistant fragments are not displayed; 91/91 user-visible messages rendered |
| Default browser | **PASS (headless + visible)**: Windows HTTPS/.html UserChoice is BraveHTML; Viewer runs in `brave.exe`, not Edge. The existing visible Brave Viewer was reloaded without launching another window, rendered 91/91, and displayed the latest user message after the prior completed final |
| Focus safety | **PASS**: source checks and headless browser do not restart or foreground ChatGPT |
| Regression test suite | **PASS**: full Windows Node test suite **139/139**, including browser choice, metadata completeness and GUI warnings |
| Unverified after this correction | **Pending**: current assistant response cannot be included as completed while it is still being generated; native Archive and Work Viewer not exercised |

Source details: [LOG.md](LOG.md) §17. Existing historical Edge E2E and the original SHA-256 remain archived as evidence, not presented as latest results.

## 2026-10-25 Offline ChatLog widget fidelity QGate

| Requirement | Result |
|---|---|
| Backup raw `client_defined_widget` data | PASS — 10 widget references in the existing private JSONL active branch, source unmodified |
| PowerShell code blocks | PASS — **9/9**, exact code text, correct language label and Copy controls; never executes saved code |
| Writing block | PASS — **1/1**, original Markdown rendered safely and copied losslessly; 9 list items in actual rendered document |
| Legacy reference mismatch | PASS — `:::writing` vs actual `<WritingBlock id="...">` matched by unique ID and exact source body |
| Generic unsupported widgets | PASS — saved structured data exposed in read-only details instead of a blank placeholder; original live interaction is **not** claimed |
| XSS / code safety | PASS — code uses DOM `textContent`; writing Markdown passes DOMPurify; synthetic HTML/script-looking content did not create a script element |
| Actual visible browser | PASS — original dedicated default Brave Viewer reloaded; **10/10 widget references rendered, 0 fallback cards, 10 Copy buttons** |
| Regression suite | PASS — full Windows Node suite **145/145** including six new widget fidelity tests |
| Source/privacy/isolation | PASS — raw private JSONL untouched, no public Git content leak, ChatGPT app not restarted or focused |

Unverified: arbitrary future widget formats requiring ChatGPT's private interactive runtime, disconnected external image assets, native server interactions. `N/N` message rendering is not proof that the ongoing ChatGPT response finished (see [LOG.md](LOG.md) §17).

## 2026-10-25 Third-party OpenUI runtime and archived action preservation

| Acceptance criterion | Verified state |
|---|---|
| Original JSONL and host callback expressions | PASS — raw source untouched; `onClick` preserved in DIL AST and original-message source view |
| Third-party runtime rather than reimplementing widgets | PASS — pinned MIT `@openuidev/browser-bundle@0.2.1` running in existing Brave Viewer; 84 component definitions available |
| Source content widgets | PASS — nine saved CodeBlock payloads + one WritingBlock using upstream OpenUI components; no default placeholder substitutions |
| Native OpenUI event channel | PASS — `onAction` event propagated through the bridge; no implicit live ChatGPT API invocation |
| Archived DIL copy action | PASS — original `GenUI.copy` expression retained; action-bearing button visible and enabled; exact copied value verified against a fake clipboard |
| Original saved markup inspection | PASS — `Original UI source` toggle exposes unchanged archived text and actions |
| Responsive static DIL layout | PASS — actual backup's 3-column grid, colored progress bar and badges validated in Brave; dynamic-only features not misrepresented as live |
| Non-interference | PASS — no ChatGPT restart, foreground change, Archive/Delete, GitHub push or modification of `<사용자 비공개 영역>` |
| Automated Windows regression | PASS — **157/157** |
| True all-widget DIL runtime equivalence | **NOT VERIFIED / NOT CLAIMED** — OpenUI Lang is not the consumer ChatGPT DIL bytecode/compiler and cannot reproduce private host services unaided |

See `LOG.md` §19 and `mod/spark_log/viewer/THIRDPARTY.md` for architecture, vendor versions and exact source/behavioral gaps.
