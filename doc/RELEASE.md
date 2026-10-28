# SPARK 0.0.3 — 릴리스·공개 저장소 운영 계약

[SPARK 개요](../README.md) · [아키텍처](ARCH.md) · [품질 게이트](ARCH_QGate.md)

## 1. 릴리스란 무엇입니까?

**SPARK 0.0.3**는 **spark_transport**, **spark_ui**, **spark_log**, **spark_cii** 네 모듈의 소스·설치 매뉴얼·자동 테스트를 재현 가능한 하나의 제품 기준선으로 묶은 버전입니다. 소스 기준선은 모든 원격 End-to-End(E2E) 기능의 인수 완료를 의미하지 않습니다. 개별 기능의 실측 결과는 [ARCH QGate](ARCH_QGate.md)에 기록합니다.

**0.0.3 Private 기준선 변경 범위:** 원격 Private `main`의 최신 6.5 문서 이력 보존, `spark_ui` 번호 기반 Project Collapse·기존 Project/Chat 들여쓰기·watcher 복원, 사용자 승인 `doc/spark2_icon*.png` 세 파일의 Private 소스 편입. 두 번호 사이의 공백은 허용하지 않으며 기존 사용자 프로젝트 이름은 변경하지 않습니다. Public 저장소 재생성과 Wiki/Actions 게시, CII 원격 E2E 인수는 **별도 검증·승인 대상**입니다. PNG 세 파일은 공개 검토 전까지 Public publisher에서 제외합니다.

| 구성 | 목적 | 이력 정책 |
|---|---|---|
| Private 개발 저장소 | 전체 개발 이력·검토·복구 | 기존 Git 커밋·태그·복구 참조 보존 |
| [SPARK Public](https://github.com/SPARK-SymbioticPersonalAIRoboticKeeper/SPARK) | 배포용 소스·테스트·매뉴얼 | **`public release` 메시지의 parentless root commit 하나**만 노출 |
| [SPARK Wiki](https://github.com/SPARK-SymbioticPersonalAIRoboticKeeper/SPARK/wiki) | 설치·사용·설계 탐색 | 소스 저장소와 별도의 Git 이력 |
| Windows 사용자 개인 상태 | 인증정보·작업 폴더·대화 | 공개 Git에 포함하지 않음 |

Public은 Private의 Git 이력을 복제하는 저장소가 아닙니다. 승인된 소스와 문서를 독립 Git 인덱스에서 구성하며, 사용자 데이터·비밀정보·로컬 로그·실행 바이너리·Private 개발 기록을 제외합니다.

### 1.1. `ref/`는 Private·Public 모두 로컬 전용입니다

- 두 Git 저장소의 `.gitignore`에 `/ref/`를 명시하고, **현재 추적 중인 모든 `ref/` 파일은 Git 인덱스에서 제거**합니다. Private 작업 폴더의 실제 참고자료는 삭제하지 않습니다.
- Public 배포기는 Private에 `ref/`가 단 1개라도 추적되어 있으면 즉시 차단합니다. 별도 로컬 `ref/public/` 입력 자료를 사용하더라도 사전에 승인된 SHA-256과 일치할 때만 공개 스냅샷 파일로 사용하며, `ref/` 경로 자체는 Public에 포함하지 않습니다.
- **원격 이력과 현재 파일 목록은 다릅니다.** 삭제 커밋으로는 과거 Private 커밋·태그·백업 브랜치의 `ref/` 접근성을 제거할 수 없습니다. Public 단일 루트 스냅샷 재게시도 GitHub 캐시·이전 SHA·외부 복제본의 완전 삭제를 보장하지 않습니다. 완전 삭제 요구는 이력 재작성·관계된 PR/캐시 검토와 별도 복구 계획이 필요합니다.
- 이전 버전 `v0.0.3` 태그는 변경하지 않습니다. `0.0.3`의 후속 유지보수 커밋을 Public 스냅샷으로 게시할 때는 태그가 HEAD의 조상이고 제품·Transport 버전이 여전히 `0.0.3`이어야 합니다. 검토 자료가 없는 일반 Clone에서는 Public 생성이 안전하게 실패하는 것이 정상입니다.

## 2. 새 Windows PC / 새로운 에이전트용 문서

| 자료 | 독자가 할 일 |
|---|---|
| [README](../README.md) | 제품 개념과 네 모듈 이해 |
| [spark_transport](TRANSPORT.md) | Git·Node.js, Clone, 개인 설정, Tunnel, Plugin, 도구 Smoke Test |
| [spark_ui](UI.md) | Windows ChatGPT Theme/CDP 상태, Route Monitor |
| [spark_log](LOG.md) | 원본 Backup, Viewer, 선택적 Archive |
| [spark_cii](CII.md) | 개인 Instruction, 요청 Prefix, Send Gate와 Display Mask |
| [ARCH](ARCH.md) | 설계·실행·권한·관측 경계 |
| [ARCH QGate](ARCH_QGate.md) | 검증 시점과 미해결 위험 |

명령은 SPARK 루트에서 새 PowerShell을 열어 실행합니다. `out/SPARK.ps1`을 인수 없이 실행하면 Windows 세션의 실제 서비스 시작을 요청하므로, 읽기 전용 진단에는 반드시 `--help` 또는 `status`를 사용합니다.

## 3. 품질 게이트

| 검증 | 필수 증거 | 실패 시 |
|---|---|---|
| 문서 정확성 | 실제 CLI 옵션·파일·JSON·실행 결과와 대조 | 잘못된 절차 수정 |
| 문서 링크·이미지 | README·매뉴얼·Wiki 상대경로/그림·승인된 SHA-256 | 게시 중단 |
| 용어 일관성 | 네 모듈의 정확한 이름과 소유권 | 잘못된 줄임말·설명 제거 |
| 독립 설치 | 일반 Git Clone에서 도움말·버전·사전점검·회귀 실행 | 숨겨진 Private 상태 의존 제거 |
| 전체 소스 검사 | `npm --prefix out test`의 실제 결과와 실패·스킵 0 | 수정 후 새 검증 |
| Public 보안 | 사용자 자료·비공개 Git·Token·불필요한 바이너리 0 | 공개 스냅샷 차단 |
| Public Git | 저장소 ID·단일 루트 커밋·부모 0개 | 완료 선언 보류 |
| Wiki | SPARK Home·네 모듈·설치·Architecture 연결 | 문서 일치까지 수정 |
| GitHub Actions | 동일 HEAD의 Windows·Ubuntu 작업 모두 SUCCESS | 출시 승인 보류 |

Workspace 권한 생성, 실제 ChatGPT Plugin 인증, 실사용자 대화 송신, Electron IPC/TLS/서버 수신, 실제 OS 재부팅은 정적 테스트만으로 증명할 수 없습니다. 미수행은 `NOT RUN`, 미관측은 `NOT OBSERVED`, 미수락은 `NOT VERIFIED`로 분리합니다.

## 4. 6.5 Public 저장소 재생성 정책

### 4.1. Force Push와 재생성은 다릅니다

기존 Public `main`을 강제로 교체하면 `git log`에 커밋이 한 개여도 GitHub의 Force Push Activity·Actions 기록은 남을 수 있습니다. **6.5의 요구는 기존 Public 저장소를 삭제하고 같은 이름의 새 저장소를 만들어 게시하는 것**입니다. 단순 Force Push로 대체하지 않습니다.

새 저장소는 **GitHub repository ID가 변경**되고 기존 Wiki, Actions 기록, Issues, Pull Requests, Releases, 권한·규칙, Fork·Star 관계 등에 영향이 있을 수 있습니다. 새 저장소 생성과 첫 Push 자체가 Activity로 기록되므로 **절대적인 Activity 0건은 보장하지 않습니다.**

### 4.2. 삭제 전 복구·권한 체크

1. Private 소스 HEAD, staged/unstaged 변경과 Git 복구 참조를 확인합니다.
2. 기존 Public 모든 브랜치·태그·Wiki를 독립 백업 참조로 보존하고 Git 객체가 실제 읽히는지 검증합니다.
3. GitHub API에서 repository ID, Issues/PR, Releases, Wiki, Actions, Rulesets, Fork, Star와 조직 권한을 조사합니다. 보존할 자료가 복구 가능하지 않으면 삭제를 중단합니다.
4. 공개 소스 트리·비밀정보·허용 이미지·라이선스를 감사하고 **일반 Git Clone**에서 Windows 회귀 검사를 실행합니다.
5. 삭제·새 저장소 생성 권한이 없다면 기존 Public을 보존하고 차단 이유를 보고합니다.

### 4.3. 새 Public에 게시할 자료

- **`public release`라는 정확한 커밋 메시지**를 가진 부모 없는 독립 루트 커밋 1개.
- 승인된 0.0.3 소스·테스트·예제 설정·Launcher·매뉴얼·공개 검토용 Engineering Charter.
- 독립 GitHub Wiki의 `Home.md`, `Getting-Started.md`, 네 개의 `spark_*.md`, Architecture/QGate/Release, Sidebar/Footer 및 승인 이미지.
- Windows와 Ubuntu에서 전체 소스 회귀를 실행하는 GitHub Actions (사용자 PC를 원격 제어·배포하지 않음).

Public에 포함되지 않는 항목은 Private 원본 `AGENTS.md`, 내부 프로세스 자료, 개인 설정·Token, 대화와 운영 로그, 미검토 캡처, 다운로드된 실행 바이너리 및 Private Git 부모 이력입니다.

### 4.4. 공개 스냅샷 Dry-run

**Private SPARK 루트**에서 다음은 원격 GitHub를 변경하지 않고 공개 파일·허용 이미지·비밀정보를 검사합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out/spark/script/publish-public.ps1
~~~

기존 배포 스크립트의 `-Publish`는 기존 저장소의 `main`을 Force-with-Lease로 변경하는 **별도 동작**입니다. **6.5 재생성에는 사용하지 않습니다.** 신규 Public에는 검증한 독립 루트 커밋을 일반 Push로 게시합니다.

## 5. 실패 시 대응

| 장애 | 조치 |
|---|---|
| 문서·설치 검증 실패 | Private와 복구 참조 유지, 해당 오류 수정 |
| 공개 스냅샷 검사 실패 | Push 전 중단, 선별 규칙·원문 검토 |
| GitHub 삭제·생성 권한 없음 | 기존 저장소 보존, 이유 기록 |
| 삭제 후 재생성 실패 | 보존된 Public/Wiki Git 객체를 근거로 복구 계획 실행 |
| CI 실패 | 실패 OS/단계/원인을 고치고 변경된 커밋으로 다시 검증 |
| 인증·연결 실패 | Token을 로그에 기록하지 않고 사용자·Workspace·Tunnel 권한 확인 |

기존 GitHub Activity, 과거 Actions 메일, 이미 복제된 Git 객체·캐시가 완전히 제거된다는 보장은 없습니다.

## 6. 문서 업데이트와 미해결 항목

6.5는 README에 남아 있던 사용자 검토 의견을 SWE1 요구사항으로 반영하고, 정확한 설치·운영·설계 문서 및 Wiki를 완성하는 문서 작업입니다. `Message delivery timed out` 원인은 별도 SWE3DP 미해결 TODO로 관리하며 이번 문서 작업에서 기능 수정이나 PASS 판정을 수행하지 않습니다.

실제 검증 결과와 릴리스 완료 여부는 [ARCH QGate](ARCH_QGate.md)에 기록합니다.
