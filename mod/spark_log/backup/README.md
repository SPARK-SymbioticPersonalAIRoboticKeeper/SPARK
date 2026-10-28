# spark_log Backup — Raw Conversation Preservation

[상위 spark_log](../README.md) · [사용 가이드](../../../doc/LOG.md)

## 1. 목적과 데이터 흐름

Backup은 Windows ChatGPT 앱에서 사용자가 선택한 **Server Chat** 또는 지원되는 **Local Work** 자료를 별도의 JSONL 파일로 보존합니다. 저장 시 메시지를 Markdown 요약으로 대체하거나 화면 표시용 렌더링을 원본에 덮어쓰지 않습니다.

~~~mermaid
flowchart LR
  Source["선택한 대화 원본"] --> Core["ChatBackup.Core.psm1"]
  Core --> Validate["식별자 / 구조 / 완료 상태 / SHA-256"]
  Validate --> Save[("사용자 승인 JSONL")]
  Save --> Verify["저장 결과 검증"]
  Verify -.-> Archive["사용자 명시 Archive (선택)"]
~~~

## 2. 코드 및 인터페이스

| 소스 | 역할 |
|---|---|
| `ChatBackup.Core.psm1` | 수집, 검증, 보관 트랜잭션 |
| `backup_chat_gui.ps1` | 대화·저장 폴더 선택 GUI |
| `backup_chat_cli.ps1` | `-Title`·`-OutputDirectory` 인수를 받는 CLI |
| `../script/spark_log.ps1` | 공통 `chatlog` 라우팅 |

## 3. 실행

SPARK 루트에서 새 PowerShell을 열고 **out** 및 **mod** 디렉터리가 있는지 확인합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog --help
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b
~~~

CLI 사용 시에는 사용자 승인된 **이미 존재하는 출력 디렉터리**와 실제 대화 제목이 필요합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b -Title "Example Chat" -OutputDirectory "D:\ChatArchive"
~~~

예시 위치는 자신의 저장 디렉터리로 변경하십시오. 미입력/충돌 인수, 존재하지 않는 출력 경로는 오류로 처리합니다.

## 4. 품질·복구 계약

| 단계 | 성공 조건 |
|---|---|
| 대상 선택 | 정확한 대화 제목과 대상 식별 |
| 데이터 수집 | 활성 분기와 원본 메시지 구조 보존 |
| 파일 저장 | 승인된 디렉터리의 실제 JSONL 확인 |
| 무결성 검사 | SHA-256 / 원본 파일·저장 정보 확인 |
| 마지막 턴 | 진행 중 스냅샷과 완료된 Assistant final 구분 |
| Archive | 사용자 명시 옵션·Backup 검증 후에만 진행 |

보관 위치를 임시 실행 로그 디렉터리와 혼동하지 마십시오. Archive·원본 삭제는 기본 Backup 동작이 아닙니다. 저장이 실패하면 기존 원본을 그대로 유지하고 기록된 오류를 확인합니다.
