# spark_cii — Custom Instruction Injector

[SPARK 개요](../../README.md) · [전체 사용 가이드](../../doc/CII.md) · [아키텍처](../../doc/ARCH.md) §29

## 1. 역할

**spark_cii**는 Windows ChatGPT 앱의 Chrome DevTools Protocol(CDP)을 사용해 송신 요청 객체에 관리형 Instruction Prefix를 결합하는 Custom Instruction Injector(CII) 모듈입니다. 입력창의 사용자 원문, 송신 요청, 화면에 표시되는 사용자 말풍선은 서로 다른 계층으로 취급합니다.

## 2. 구현 지도

| 소스 | 역할 |
|---|---|
| `src/config.mjs` | 개인 Instruction 설정 읽기·검증 |
| `src/cli.mjs` | CDP 창 등록, Watcher, Probe, Audit |
| `src/breakpoint.mjs` | `startCompletionStream` 요청 객체 복제·Prefix 결합 |
| `src/guard-egress.mjs` | 준비되지 않은 Send/Enter의 인식 가능한 경로 차단 |
| `src/display-mask.mjs` | 사용자 말풍선의 정확한 Prefix를 시각적으로 숨김 |
| `src/audit.mjs` | 원문을 저장하지 않는 단계별 메타데이터 로그 |
| `script/spark-cii.ps1` | Windows Watcher 시작·조회·중지 |
| `config/config_cii.example.txt` | 공개 Instruction 형식 예시 |

`guard-first.mjs`, `guard.mjs` 및 `early.mjs`는 과거 실험·호환성 구현으로, 현재 운영 경로의 필수 주입 지점이 아닙니다.

## 3. 상태 확인

SPARK 루트에서 다음 순서로 확인합니다.

~~~powershell
node mod/spark_cii/src/cli.mjs validate
node mod/spark_cii/src/cli.mjs probe --json
node mod/spark_cii/src/cli.mjs audit --tail 100 --json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File mod/spark_cii/script/spark-cii.ps1 -Action status
~~~

| 단계 | 무엇을 확인하는가 |
|---|---|
| `validate` | 개인 Prefix 파일의 형식·내용 |
| `probe` | 창별 Gate/Breakpoint/Mask 준비 상태 |
| `audit` | 시도별 상태와 실패 사유 |
| `status` | Watcher 프로세스의 실행 상태 |

로컬 결합 검증과 원격 서버의 메시지 수신은 별개의 단계입니다. `probe`가 설치 상태를 표시해도 실제 User 메시지가 그 경계를 통과했는지는 별도로 확인합니다.

## 4. 입력·표시 분리

~~~mermaid
flowchart LR
    Input["사용자 원문"] --> Request["송신 요청 객체"]
    Prefix["개인 Instruction"] --> Request
    Request --> Sender["ChatGPT 송신 처리"]
    Request -.-> Mask["Display Mask"]
    Mask --> Bubble["원문만 보이는 말풍선"]
~~~

Display Mask는 **시각적 표시**에 적용됩니다. 저장된 메시지 데이터 자체를 삭제하거나 Copy/Edit/Export를 모두 변경하는 기능은 아닙니다.

[설정·운영·문제 해결 → spark_cii 사용 가이드](../../doc/CII.md)
