# spark_log — Conversation Backup and Viewer

[SPARK 개요](../../README.md) · [전체 사용 가이드](../../doc/LOG.md) · [아키텍처](../../doc/ARCH.md)

## 1. 개요

**spark_log**는 ChatGPT 대화의 **Backup**과 JSON/JSONL 파일의 **Viewer**를 제공합니다. Backup 결과의 원본 메시지·메타데이터와 Viewer의 표시용 결과를 분리합니다.

~~~mermaid
flowchart LR
  Chat["ChatGPT / Work 자료"] --> Backup["spark_log Backup"]
  Backup --> JSONL[("원본 JSONL")]
  JSONL --> Viewer["spark_log Viewer"]
  Viewer --> Screen["로컬 브라우저"]
~~~

## 2. 구성 요소

| 소스 | 역할 |
|---|---|
| `script/spark_log.ps1` | 공통 `chatlog` 진입점 |
| `backup/ChatBackup.Core.psm1` | 대화 수집·원본 검증·저장 트랜잭션 |
| `backup/backup_chat_gui.ps1` | 대화 제목과 저장 경로를 선택하는 GUI |
| `backup/backup_chat_cli.ps1` | 명시 인수를 받는 CLI Backup |
| `viewer/viewer_cli.ps1` | Viewer 실행 및 파일 선택 |
| `viewer/parser.js` | 대화 구조·활성 분기 해석 |
| `viewer/dil-renderer.js` | 저장된 UI 정의 표시 어댑터 |
| `viewer/index.html` / `viewer/viewer.js` | 읽기 전용 로컬 Viewer |
| `viewer/THIRDPARTY.md` | Viewer 외부 라이브러리와 라이선스 |

## 3. 실행

~~~powershell
# SPARK 루트에서 실행
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog --help
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v
~~~

| 기능 | 필수 정보 | 결과 |
|---|---|---|
| Backup GUI | 선택할 대화·저장 폴더 | 사용자 승인 JSONL |
| Backup CLI | `-Title` 및 `-OutputDirectory` | 파일과 검증 결과 |
| Viewer | `-InputFile` 선택 또는 GUI 파일 열기 | 읽기 전용 표시 |
| Archive | 별도 `-ArchiveAfterBackup` | Backup 검증 후에만 수행 |

## 4. 안전 계약

원본 자료는 저장 형식을 임의 변경하지 않습니다. Backup 경로는 장기 보존에 적합한 사용자 승인 공간을 사용하고, Archive는 명시적으로 선택해야만 실행됩니다. Viewer가 일부 동적 Widget을 완전 재현하지 못해도 원본 payload를 삭제하거나 자동 실행하지 않습니다.

- [Backup 구현·검증](backup/README.md)
- [Viewer 구성·보안](viewer/README.md)
- [전체 사용 가이드](../../doc/LOG.md)
