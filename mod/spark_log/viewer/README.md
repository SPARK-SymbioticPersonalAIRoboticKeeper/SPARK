# spark_log Viewer — Offline JSONL Reader

[상위 spark_log](../README.md) · [사용 가이드](../../../doc/LOG.md) · [Third-party Notices](THIRDPARTY.md)

## 1. 목적

Viewer는 spark_log Backup에서 저장한 ChatGPT JSON/JSONL을 **읽기 전용**으로 열어 대화 구조와 지원 가능한 Presentation 정보를 제공합니다. 원본은 표시용 변환과 별도로 보존합니다.

## 2. 처리 구조

~~~mermaid
flowchart LR
  Source[("JSONL / JSON")] --> Parser["parser.js"]
  Parser --> State["메시지 분기·메타데이터"]
  State --> Renderer["dil-renderer.js"]
  Renderer --> View["viewer.js · index.html"]
~~~

| 파일 | 기능 |
|---|---|
| `viewer_cli.ps1` | Viewer 파일 선택·호출 |
| `parser.js` | 저장 형식 해석·대화 분기 |
| `dil-renderer.js` | Widget 정의·메타데이터를 표시용으로 변환 |
| `openui-runtime.js` | 허용된 인터랙션 어댑터 |
| `viewer.js` / `viewer.css` / `index.html` | 독립 Viewer GUI |
| `vendor/` 및 `THIRDPARTY.md` | 외부 라이브러리·라이선스 고지 |

## 3. 사용

SPARK 루트에서 다음을 실행합니다.

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v
powershell.exe -NoProfile -ExecutionPolicy Bypass -File out\SPARK.ps1 chatlog -v -InputFile "D:\ChatArchive\example.jsonl"
~~~

| 경우 | 동작 |
|---|---|
| 파일 지정 없음 | 로컬 Viewer 실행 후 파일 선택 |
| 파일 지정 | 지정한 JSON/JSONL 로딩 |
| 완료되지 않은 대화 | INCOMPLETE SNAPSHOT 같은 경고를 표시 |
| 지원되지 않는 Widget | 원본 데이터/메타데이터를 보존하며 미지원 상태 표시 |

## 4. 보안·무결성

Viewer는 원본 JSONL을 변경하지 않습니다. 저장된 코드·HTML을 사용자의 동의 없이 실행하거나 ChatGPT 인증 상태를 대신 사용해 외부 액션을 호출하지 않습니다. 렌더러는 안전한 Markdown/HTML 처리 및 서드파티 라이선스 정책을 따릅니다.

### 4.1. 보존과 표시의 차이

| 항목 | 원본 보존 | Viewer 표시 |
|---|---|---|
| User/Assistant 메시지·메타데이터 | 그대로 보존 | 지원 |
| Markdown·코드·표 | 그대로 보존 | 지원되는 렌더링 |
| Writing/Code Block | 정의·내용 보존 | 지원되는 부분만 |
| Dynamic Chart/Map/Host Action | 원본 정의 보존 | 외부 런타임/인증 필요 시 표시 제한 |
| 원격 링크·미디어 | 원본 URL 보존 | 네트워크 정책에 따라 제한 |

모든 Widget이 ChatGPT 원래 환경과 동일하게 동작한다고 주장하지 않습니다. 데이터 표시 문제가 있으면 먼저 원본 JSONL이 변하지 않았는지 검증하고, Renderer를 수정하되 저장 파일은 고치지 마십시오.

[전체 사용 가이드 → spark_log](../../../doc/LOG.md)
