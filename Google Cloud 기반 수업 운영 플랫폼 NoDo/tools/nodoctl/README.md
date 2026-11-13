# nodoctl

NoDo 백엔드 설정을 배포 전에 검사하는 Go CLI입니다. 인턴 이후 개인적으로 추가한 도구입니다.

백엔드는 시작할 때 `backend/app/core/config.py`의 규칙으로 설정을 검사하고, 정해진 GCP 프로젝트·Storage 버킷·CORS 출처와 다르면 아예 시작하지 않습니다(fail-closed). `nodoctl`은 같은 규칙을 배포 전에 먼저 돌려서, 잘못된 설정이 Cloud Run까지 가기 전에 막습니다.

- 설정값만 읽습니다. Firebase나 Google Cloud에 접속하지 않고, 네트워크 패키지를 쓰지 않습니다.
- 외부 의존성 없이 Go 표준 라이브러리만 씁니다.
- 백엔드 이미지(`backend/Dockerfile`)에는 포함되지 않습니다.

## 실행

Go 1.27 이상이 필요합니다.

```bash
cd tools/nodoctl
go test ./...
go build -o nodoctl .
./nodoctl check --env-file ../../.env.example
```

| 명령 | 설명 |
| --- | --- |
| `nodoctl check --env-file PATH` | 파일의 설정만 검사 |
| `nodoctl check --with-process-env` | 현재 셸 환경 변수로 검사 (`--env-file`과 함께 쓰면 파일 값이 덮어씀) |
| `nodoctl check --json` | 결과를 JSON으로 출력 |
| `nodoctl version` | 버전 출력 |

종료 코드는 통과 0, 차단 1, 사용법 오류 2입니다. 파이프라인 단계로 넣으면 차단될 때 배포가 멈춥니다.

## 검사하는 것

| 검사 | 언제 | 예시로 막는 설정 |
| --- | --- | --- |
| `startup` | 항상 | 에뮬레이터 모드인데 실제 프로젝트 지정, 운영에 에뮬레이터 변수가 남음, 서비스 계정 키 파일 지정, 허용되지 않은 CORS 출처 |
| `storage_uploads` | `NODO_STORAGE_MODE=cloud` | 다른 버킷이나 다른 GCP 프로젝트 |
| `vertex_drafts`, `vertex_assistant` | `NODO_VERTEX_AI_MODE=vertex` | 허용되지 않은 Gemini 모델, 엔드포인트, 입력 한도 |

## 백엔드와 규칙이 어긋나지 않게

`TestBackendConstantsMatch`가 `config.py`의 고정값(프로젝트, 버킷, CORS 출처, 에뮬레이터 주소, 직원 이메일 도메인)을 읽어 이 도구의 값과 비교합니다. 백엔드 값만 바꾸고 이 도구를 고치지 않으면 테스트가 실패합니다.

`TestParityWithBackend`는 24개 설정 상황마다 실제 백엔드 검사(`config.py`)와 `nodoctl`을 함께 돌려, 통과·차단 여부와 오류 메시지가 같은지 비교합니다. 정상 설정, 다른 버킷·프로젝트, 남아 있는 에뮬레이터 변수, 서비스 계정 키 파일, 허용되지 않은 CORS 출처, 잘못된 값 형식 등을 다룹니다. 백엔드 쪽은 [`testdata/backend_check.py`](./testdata/backend_check.py)가 표준 라이브러리만으로 실행하며, Python 3.9 이상이 없으면 이 테스트는 건너뜁니다.
