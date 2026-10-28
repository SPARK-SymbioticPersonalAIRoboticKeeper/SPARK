# spark_log — ChatGPT Conversation Backup and Viewer

**SPARK 0.0.3** · [프로젝트 소개](../README.md) · [모듈 소스](../mod/spark_log/) · [설계](ARCH.md)

## 1. 개요

**spark_log**는 ChatGPT 대화 자료를 별도 파일로 보존하는 **Backup**과 저장된 자료를 로컬에서 탐색하는 **Viewer**로 구성됩니다. Backup은 원본 정보를 보존하는 저장 작업이고, Viewer는 저장된 파일의 **읽기 전용 표시** 작업입니다.

~~~mermaid
flowchart LR
  Chat["Windows ChatGPT 앱 / 인증된 대화"] --> Backup["spark_log Backup"]
  Work["로컬 Work 데이터"] --> Backup
  Backup --> JSONL[("사용자 승인 JSONL 파일")]
  JSONL --> Viewer["spark_log Viewer"]
  Viewer --> Browser["로컬 브라우저"]
~~~

| 기능 | 입력 | 결과 |
|---|---|---|
| Backup | 선택한 ChatGPT 대화 또는 지원되는 로컬 Work 자료 | 원본 JSONL과 메타데이터, 무결성 정보 |
| Viewer | 기존 ChatGPT JSON/JSONL | 대화 구조·Markdown·인용·표·지원하는 Widget의 표시 |
| Archive | 사용자가 명시적으로 선택하고 Backup 검증을 마친 대화 | 조건부 Archive 요청; 일반 Backup에서 자동 실행하지 않음 |

## 2. 설치와 데이터 관리

### 2.1. 준비

spark_log는 Windows PowerShell과 설치된 SPARK의 공통 Launcher를 사용합니다. ChatGPT 대화 Backup은 앱의 인증된 세션을 활용하므로 앱이 로그인된 상태여야 합니다. Viewer로 **이미 저장된 파일을 여는 작업**에는 새로운 서버 인증이 필요하지 않습니다.

SPARK 루트에서 새 PowerShell을 열어 다음을 확인하십시오.

~~~powershell
Test-Path .\out\SPARK.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog --help
~~~

| 결과 | 의미 |
|---|---|
| `True` 및 Backup/Viewer 도움말 | 실행 파일 준비 완료 |
| `False` | 저장소 루트가 아닌 위치입니다. |
| `chatlog` 대신 `log`를 입력한 경우 | 이전 명령은 지원하지 않습니다. |

### 2.2. Backup 저장 위치

Backup에는 사용자가 소유하고 **사전에 승인한 기존 디렉터리**를 사용하십시오. 새 Backup 디렉터리나 보관 정책은 사용자가 결정합니다. 원본 Chat/Work 자료, 생성된 Backup과 임시 SPARK 운영 로그를 구분해야 합니다.

| 데이터 | 취급 |
|---|---|
| 원본 Chat/Work 대화 | 원본을 수정하거나 변환하지 않는 것이 기본 |
| Backup JSONL | 사용자가 승인한 장기 보존 공간에 기록 |
| Viewer | 원본 Backup 읽기 전용, 편집·Archive를 수행하지 않음 |
| 임시 실행 로그 | Backup의 영구 보관 위치로 사용하지 않음 |

## 3. ChatGPT Backup

### 3.1. GUI Backup

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b
~~~

1. Backup 창에서 대상 대화를 선택합니다.
2. 표시된 **대화 제목**과 저장 디렉터리를 확인합니다.
3. 원본 대화를 보존할 목적이라면 Archive 옵션을 끈 상태로 Backup을 실행합니다.
4. 생성된 파일이 실제로 존재하는지 확인하고, Backup 결과의 무결성 정보를 검토합니다.

Backup 창이 열리는 것과 파일 저장이 성공한 것은 다릅니다. **저장 결과를 확인한 후에만** 완료로 판정하십시오.

### 3.2. CLI Backup

**사전 조건:** 디렉터리가 이미 존재하고 해당 사용자가 저장 권한과 충분한 공간을 확인했습니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -b -Title "Example Chat" -OutputDirectory "D:\ChatArchive"
~~~

`Example Chat`은 실제 사이드바 대화 제목으로, `D:\ChatArchive`는 사용자가 승인한 실제 저장 디렉터리로 교체해야 하는 예시입니다. 코드에 개인 경로나 대화 내용을 추가하지 마십시오.

| 인수 | 의미 |
|---|---|
| `chatlog -b` | Backup 모드 |
| `-Title` | 대상 대화 제목 |
| `-OutputDirectory` | 기존 Backup 저장 디렉터리 |
| `-ArchiveAfterBackup` | **별도 변경 작업:** Backup 검증 후 Archive를 명시적으로 요청 |

CLI는 `-Title`과 `-OutputDirectory` 중 하나만 전달하는 불완전한 요청을 거부합니다. 명시적인 Archive 요청 없이 원본을 Archive하지 않습니다.

### 3.3. Backup 결과 판정

| 확인 대상 | 확인 방법 |
|---|---|
| 파일 | 사용자가 선택한 위치에서 JSONL의 존재·크기 검사 |
| 무결성 | 백업 결과에 있는 SHA-256 또는 해시 검증 결과 확인 |
| 대화 식별 | 제목·대상 대화·Active branch가 의도한 것인지 대조 |
| 완료 상태 | 최신 사용자 턴에 대응하는 완료된 Assistant final 존재 여부 검사 |
| Archive | 실행하도록 선택했다면 Backup 검증 완료 후 별도 결과 확인 |

메시지 개수나 원본 해시가 일치해도 **진행 중인 대화를 완료된 대화로 오인하지 않아야 합니다.** Viewer가 INCOMPLETE SNAPSHOT을 표시하면 원본 자료를 덮어쓰지 말고 대화 완료 후 다시 Backup하십시오.

## 4. Offline Viewer

### 4.1. GUI 실행

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v
~~~

Viewer는 기본 브라우저에 로컬 화면을 열고 사용자가 대화 파일을 선택하도록 합니다. 별도의 원본 로그인이나 OpenAI API 키를 요구하지 않습니다.

### 4.2. 파일 지정 실행

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v -InputFile "D:\ChatArchive\example.jsonl"
~~~

`-Headless` 옵션은 `-InputFile`과 함께 사용할 때만 유효합니다. 저장된 원본 파일을 덮어쓰지 않으며, 외부 서비스에 메시지를 전송하지 않습니다.

### 4.3. 표시 범위와 원본 보존

Viewer는 원본 JSONL과 표시용 렌더링 결과를 구별합니다.

| 자료 | 원칙 |
|---|---|
| 대화의 User/Assistant 분기 | 활성 대화 분기를 재구성하되 원본 메시지 순서를 보존 |
| Markdown·표·코드 | 저장된 텍스트를 가능한 범위에서 렌더링; 코드 실행 금지 |
| Writing Block | 원본 텍스트/메타데이터 보존과 읽기·복사 제공 |
| Citation·Widget payload | 원본 참조·데이터는 변형하지 않고 보존 |
| 서버 인증이나 실시간 작업이 필요한 위젯 | 원본 데이터만 설명 가능하며 임의 액션을 호출하지 않음 |

**원본 포맷은 손실 없이 보존하는 것이 우선**입니다. Viewer가 일부 동적 위젯을 원래 UI처럼 표시하지 못하더라도 저장 데이터를 제거하거나 다른 형식으로 고쳐 저장해서는 안 됩니다.

## 5. Archive 및 복구

Archive는 Backup과 다른 사용자 변경 작업입니다. 다음을 모두 충족하는 경우에만 선택하십시오.

1. 저장된 Backup 파일이 읽히며 무결성 검증을 통과합니다.
2. 해당 대화와 현재 완료 상태를 확인했습니다.
3. Archive가 원래 ChatGPT 대화에 미치는 영향을 이해하고 명시적으로 선택했습니다.
4. Archive 결과를 검증하고 원복 경로를 확보했습니다.

**기본 Backup 또는 Viewer 실행은 Archive 동작을 포함하지 않습니다.** 원본 보존이 목적이라면 Archive 옵션을 사용하지 마십시오.

## 6. 문제 해결

| 증상 | 원인 확인 | 대응 |
|---|---|---|
| Backup 대화가 검색되지 않음 | ChatGPT 로그인·사이드바 제목·대화 종류 | 대상 선택을 다시 확인 |
| 저장 경로 오류 | 디렉터리 존재·권한·용량 | 승인된 기존 디렉터리로 수정 |
| 파일은 있지만 최신 답변 누락 | Backup 순간의 대화 진행 상태 | 원본 유지 후 완료 시 다시 Backup |
| Viewer가 파일을 열지 못함 | 실제 JSON/JSONL, 인코딩, 읽기 권한 | 원본 파일을 별도로 보존하고 오류 진단 |
| 위젯이 원본 UI와 다름 | 저장된 UI 정의와 Viewer 지원 범위 | 원문 보기를 통해 데이터 보존 여부 확인 |
| 브라우저가 열리지 않음 | Windows 기본 브라우저와 파일 연결 | 로컬 Viewer HTML을 수동으로 열어 파일 선택 |
| Backup이 의도치 않게 Archive됨 | 명시 옵션·실행 내역 | 검증된 Backup으로 복구 경로 확인 |

## 7. 소스와 관련 문서

| 문서 | 내용 |
|---|---|
| [spark_log 모듈](../mod/spark_log/README.md) | 구현 구조·실행 명령 |
| [Backup 내부 구조](../mod/spark_log/backup/README.md) | 데이터 수집·검증 절차 |
| [Viewer 내부 구조](../mod/spark_log/viewer/README.md) | 로컬 렌더러·보안 |
| [아키텍처](ARCH.md) | 설계 계약 |
| [품질 게이트](ARCH_QGate.md) | 세부 검증과 릴리스 판정 |
