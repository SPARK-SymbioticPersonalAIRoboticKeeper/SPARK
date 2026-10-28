# spark_ui — Windows ChatGPT User Interface

[SPARK 개요](../../README.md) · [사용 가이드](../../doc/UI.md) · [아키텍처](../../doc/ARCH.md)

## 1. 목적

**spark_ui**는 Windows ChatGPT 앱의 Chrome DevTools Protocol(CDP) 연결을 통해 Theme, Projects 번호별 접기, Route Monitor를 관리합니다. Theme와 Projects 접기는 표시 계층, Route Monitor는 모델·응답 Effort·메시지 흐름의 **관측** 계층을 담당합니다.

## 2. 소스 구성

| 소스 | 역할 |
|---|---|
| `src/cli.mjs` | Theme 검사·조회·적용·원복 |
| `src/theme.mjs` | JSON Theme를 CSS로 컴파일 |
| `src/cdp.mjs` | CDP 대상·스크립트 실행 |
| `src/watch.mjs` | 화면 재연결·상태 갱신 |
| `src/project-collapse.mjs` | 기존 Projects 목록의 번호 기반 접기/펼치기, Pinned의 프로젝트명/대화명 표시 및 원복 |
| `src/route-overlay.mjs` | Route Monitor 표시 |
| `src/route-response-model.mjs` | 응답 Model/Resolved Effort |
| `src/route-last-good.mjs` | Current와 Last Good 관리 |
| `src/route-flow.mjs` | 메시지 계층별 관측 |
| `src/route-recorder.mjs` | 사용자가 요청한 Metadata Recording |
| `script/start-chatgpt-ui.ps1` | Windows 앱 연동 시작 |
| `script/restore-normal.ps1` | 원래 화면으로 복원 |

## 3. 설치와 점검

공통 Windows 설정을 마친 후 SPARK 루트에서 다음을 실행합니다.

~~~powershell
npm --prefix out run chatgpt-ui:validate
node mod/spark_ui/src/cli.mjs validate --theme mod/spark_ui/config/dark-red-theme.json
node mod/spark_ui/src/cli.mjs probe --json
~~~

| 결과 | 의미 |
|---|---|
| Theme 검사 성공 | JSON·CSS 구성이 유효 |
| `probe`에서 ChatGPT 대상 발견 | 실행 중인 Windows 앱에 CDP 연결 가능 |
| 대상 없음 | Windows 앱 또는 CDP 연결을 확인해야 함 |

## 4. 운영 계약

- Selected Model/Effort는 사용자 UI 선택이며 Resolved Model/Effort는 관측된 메타데이터만 의미합니다.
- Current 값이 미관측이어도 Last Good 기록은 유지하되 혼합하지 않습니다.
- Metadata Recording은 사용자 opt-in이고 기록 대상 필드만 허용합니다.
- Theme `apply`/`restore`는 실제 앱 화면을 변경하므로 복구 계획을 확인한 뒤 실행합니다.
- Projects 목록은 `20. 이름`(상위)과 `20.00. 이름`(하위)처럼 이름의 숫자 접두어로만 묶습니다. 상위의 화살표를 누르면 해당 하위 프로젝트와 그 대화 목록이 화면에서 숨겨지고, 다시 누르면 나타납니다. 상위 폴더는 화살표 유무와 관계없이 같은 열에, 하위 폴더는 한 단계 더 들여쓰기합니다(제목 안의 보이지 않는 수동 공백은 무시). 프로젝트에 속한 대화 제목과 Show more는 해당 프로젝트 제목의 시작 열에 맞추며, 프로젝트 번호 체계가 없는 일반 목록은 변경하지 않습니다. OpenAI 프로젝트 데이터, 이름, 순서는 변경하지 않습니다. 접기 상태는 현재 Renderer 메모리에만 보존합니다.
- Pinned 대화는 같은 화면의 네이티브 내비게이션 경로에 있는 프로젝트 ID와 대화 ID가 일치하는 경우에만 `프로젝트명/대화명`으로 **화면 표시**합니다. 대화 이름·URL은 변경하지 않으며 경로를 판별할 수 없는 항목은 원래 이름을 유지합니다. ChatGPT 내부 React 경로 구조에 의존하므로 앱 업데이트 후 별도 실화면 검증이 필요합니다.
- `restore`는 Projects 접기 UI, Pinned 접두어, 숨김 표시 및 Theme를 원복합니다. 실행 중인 watcher가 있다면 먼저 중지해야 재적용되지 않습니다.
- 사용자 메시지에 Instruction Prefix를 결합하는 주입은 **spark_cii**의 소유권입니다.

자세한 Theme 값, Trace 경계, Tray·AutoStart와 장애 대응: [spark_ui 사용 가이드](../../doc/UI.md).
