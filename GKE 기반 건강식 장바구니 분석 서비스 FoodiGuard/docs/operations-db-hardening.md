# 운영 코드·DB 병목 개선 검증 (2026-09-08)

이 문서는 배포 전 코드/성능 검증 기록이다. 후속 main 병합·경보 연결·배포 상태는 [운영 반영 기록](operations-rollout-2026-09-08.md)을 확인한다.

## 범위와 현재 상태

기준: 팀 저장소 main `472e43ca77e0c576bc0927d7d3d266ceab11501a`.
작업 브랜치: `rudans61/operations-db-hardening`.

- Cloud SQL `foodiguard-db`: RUNNABLE, PostgreSQL 17, 1 vCPU/3.75 GiB, PD_SSD, 식품 79,041건.
- GKE `foodiguard-cluster`: RUNNING. 조회 시 API·웹 Deployment 모두 replicas=0.
- 운영 DB는 읽기 전용 세션으로만 시험했다. 운영 DDL·데이터 갱신·Terraform apply·배포는 하지 않았다.
- 코드 수정과 실제 운영 배포 완료는 구분한다. 현재 API 이미지 `foodiguard-backend:c-fix2`, 웹 `foodiguard-web:4`는 이번 개선 이미지가 아니다.

## 변경 내용

### 검색과 DB 부하

1. 한글/숫자 검색은 `LIKE`, 영문이 섞이면 기존 `ILIKE`를 유지한다. 정규화 입력은 한글 음절/ASCII 영문/숫자로 제한되므로 한글·숫자에 불필요한 대소문자 변환을 하지 않는다.
2. 정확 일치 → 접두 일치 → 짧은 이름 → ID 순의 관련도 정렬을 유지한다. 알레르기 제외·원재료 매칭·건강기능식품 노출 정책도 유지한다.
3. 검색뿐 아니라 알레르기 제외·테마 조회도 전체 `COUNT`를 생략하고 한 건 더 읽어 `hasMore`를 계산한다. `exactTotal=false`일 때 `total`은 전체 건수가 아니라 현재까지 읽은 수다. 모바일은 이미 이 계약을 지원한다.
4. 무필터 목록만 전체 건수를 유지하고 30초 캐시/동일 조회 합치기를 적용한다. 상품·원재료·알레르기 결과 자체는 캐시하지 않는다. 표시 건수만 최대 30초 이전 값일 수 있다.
5. 검색/테마/후속 페이지는 먼저 ID를 선정한 뒤 상세 뷰를 읽는다. 첫 페이지 일반 목록은 기존 단순 경로를 유지한다.
6. 검색 실행 동시성 2, 대기열 20, 대기 1.5초 제한. 초과하면 503 `SEARCH_BUSY`와 `Retry-After: 2`를 반환한다. 무한 대기로 DB를 압박하지 않는다.
7. 기존 `jit=off`, `random_page_cost=1.0`을 유지하되 과거 주석의 잘못된 "관련도 정렬도 인덱스로 조기 종료" 설명을 제거했다. 이 설정만으로 검색 병목이 해결되는 것은 아니다.

### 장애 전파와 운영 작업

- 일반 DB 풀 최대 5개, readiness 전용 풀 최대 1개. 일반 SQL 제한 5초, readiness 서버 제한 750ms. 중첩 readiness는 한 번의 조회를 공유한다. 시간 초과된 readiness 연결은 재사용하지 않는다.
- `foodiguard_db_pool_wait_seconds`로 검색/품질 조회의 연결 대기와 SQL 실행시간을 분리한다. 기존 다른 경로의 `observeDbQuery(pool.query(...))`는 아직 풀 대기를 포함할 수 있다.
- Job의 `app` 라벨을 `foodiguard-maintenance`로 변경하고 API Service/PodMonitoring에 `component: api` 선택자를 추가한다. 기존 Service가 아직 적용된 첫 배포에서도 마이그레이션 Job을 API 대상으로 선택하지 않는다. Deployment의 immutable selector는 변경하지 않는다.
- 새로운 API Pod가 준비된 후 Service/PodMonitoring 선택자를 적용한다. 첫 전환 중 기존 Pod가 선택자에서 먼저 빠져 트래픽이 끊기는 것을 피한다.
- 매 배포마다 하던 알레르기 재계산을 `foodiguard-allergen-projection` CronJob으로 분리한다. 매일 한국시간 03:00, 중복 실행 금지, 지연 시작 제한 1시간, 최대 실행 30분. 원본 수집이 아닌 **기존 원재료 재계산**이다.
- 같은 DB 연결에서 세션 advisory lock을 보유해 수동 실행과 CronJob도 겹치지 않게 한다. 배치 쓰기는 같은 연결의 트랜잭션으로 처리한다.
- 로컬 PGlite 종료 과정에서 실패 종료 코드가 0으로 바뀌는 문제를 실패 주입 시험으로 확인했다. 정리 이후 실패 종료 코드를 설정해 CLI 결과와 실패 기록이 일치하도록 했다.
- 증분 하한은 이전 성공 실행의 `finished_at` 대신 `started_at`, 상한은 현재 실행 시작으로 잡는다. 이전 실행 중 변경된 행을 다음 실행에서 다시 확인한다. 실패 시 성공 커서를 전진시키지 않는다.
- 이 커서는 변경 시 `updated_at` 갱신이 전제다. 원본 수집기가 오래 열린 트랜잭션을 뒤늦게 커밋하거나 원재료 연결을 바꾸면서 관련 타임스탬프를 갱신하지 않는 경우까지 보장하지 않는다. 원본 수집 구현 시 별도 원본 커서/겹침 구간과 변경 계약이 필요하다.
- Job은 `DB_STATEMENT_TIMEOUT_MS=900000`을 명시해 API용 5초 제한과 분리한다.
- Jenkinsfile에 main 체크, 5분 SCM 폴링, 백엔드·모바일 테스트를 추가했다. 실제 Jenkins Job의 SCM 브랜치도 `*/main`이어야 한다. Jenkinsfile은 자신을 읽어 오는 잘못된 UI SCM 설정까지 수정할 수 없다.

### 지표와 경보

- 작업별 성공 시각/24시간 실패 수를 분리한다. 다른 작업의 성공이 알레르기 재계산 중단을 가리지 않는다.
- 품질 조회가 실패하면 30초 뒤 재시도하고, 마지막 품질 수집 성공 시각 지표로 수집 중단을 감지한다.
- API 부재, 5xx 분자 부재, 클러스터/네임스페이스 범위, 재시작 경보의 지속시간을 보완했다.
- Terraform에 기존 수신 채널 ID 목록 `alert_notification_channels`를 추가했다. 운영에서 수신자 없는 경보를 적용하지 못하게 사전 조건을 둔다. `allow_unrouted_alerts=true`는 명시적으로 알림을 보내지 않는 시험 환경에만 사용한다.
- 2026-09-08 Monitoring API 조회 결과 **notificationChannels=0**, 기존 경보 8개 모두 수신 채널이 비어 있었다. 새 이메일은 추정해서 등록하지 않았다.
- 이번 코드에는 경보 10개가 정의되어 있다. 정책이 평가되는 것, 알림이 사람에게 전달되는 것, 복구 알림이 전달되는 것은 각각 별도 검증 대상이다.
- 10개 PromQL은 실제 [Google Monitoring 조회 API](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v1/projects.location.prometheus.api.v1/query)에서 HTTP 200/success로 평가됐다. 현재 API가 없으므로 가용성 부재 조건이 반환됐고, 아직 배포하지 않은 신규 품질/재계산 지표도 부재 조건이 반환됐다. 이는 알림 발송 시험이 아니다.

## 성능 비교

로컬에서 기존/개선 Express API를 각각 실행하고 같은 운영 Cloud SQL에 Proxy로 연결했다. 모든 DB 세션에 `default_transaction_read_only=on`을 강제하고 확인했다. 각 시나리오는 3초 동안 요청을 생성한 뒤 진행 중 요청까지 집계했다. GKE ingress를 포함한 시험도, 장시간 최대 처리량 인증도 아니다. 기존 버전부터 순서대로 측정했으므로 캐시·측정 순서 영향이 있다.

동시 요청 10개, `display=48`, 검색어 `냉면`, 알레르기 제외 `메밀`:

| 시나리오 | 기존 RPS | 개선 RPS | 기존 p95 | 개선 p95 |
| --- | ---: | ---: | ---: | ---: |
| 기본 목록 | 72.2 | 86.2 | 225ms | 189ms |
| 키워드 검색 | 5.1 | 11.3 | 2,101ms | 1,116ms |
| 알레르기 제외 | 4.7 | 81.4 | 2,206ms | 199ms |

단일 동시 요청의 검색 p50은 227ms → 97ms였다. 상품 요청 오류는 양쪽 모두 0건. 부하 중 readiness는 기존 알레르기 제외 시험에서 1회 실패했고, 개선 버전은 모두 0회였다. 해당 readiness p95는 2,002ms → 73ms였다.

별도 SQL 비교는 9개 시나리오에서 전체 반환 행과 순서가 동일했다. `EXPLAIN (ANALYZE, BUFFERS)`를 기존/개선 교차 3회 실행한 warm 중앙값:

| 목록 SQL | 기존 | 개선 |
| --- | ---: | ---: |
| 면 | 221.8ms | 79.8ms |
| 냉면 | 207.0ms | 76.9ms |
| 우유 | 212.1ms | 81.5ms |
| 초코파이 | 8.7ms | 7.8ms |
| 면 + 밀 제외 + 후속 페이지 | 229.3ms | 100.6ms |

알레르기 제외 목록 SQL 자체는 약 1.9ms로 비슷했지만, 기존에는 따로 약 294ms의 전체 COUNT가 필요했다. COUNT 제거가 이 경로 개선의 핵심이다. 최초 cold COUNT 약 2.4초는 정상 반복 성능처럼 사용하지 않는다.

검색 동시성 10의 p95가 여전히 약 1.1초이므로 완전 해결이나 1초 SLO 충족으로 결론내리지 않는다. 정렬 품질을 낮추거나 DB를 증설하지 않고 개선한 1차 결과다. 다음 단계는 배포 후 45~60초씩 반복한 혼합 트래픽 시험, CPU·풀 대기·SQL 시간·503 비율과 24~72시간 실사용 관측이다. 부하 재개 전 시간/상한을 정한다. DB가 포화되는 동안 HPA만 늘리는 것은 해결책이 아니다.

## 원본 수집 경로 조사

- 과거 `backend/scripts/import-naver-csv.js`가 `naver_ingredients_v3.csv`, `naver_nutrition_v1.csv`를 읽어 원본 테이블에 넣었다.
- 커밋 `42230abc763e0c398a55f9dd859033e4d4f6f178`(2026-08-17)에서 입력 CSV가 없어진 미사용 파이프라인이라는 이유로 제거됐다.
- 로컬의 `tmp/gb-matching/backend/data/`에는 이전 CSV 사본 두 개가 남아 있다. 이 파일이 최신 원본이라는 증거는 없다.
- 이전 스크립트는 원본 테이블을 TRUNCATE 후 COMMIT하고 파일을 읽는다. 입력 오류/실패 시 빈 테이블·부분 적재가 남을 수 있으므로 그대로 복원하거나 운영에서 실행하지 않았다.
- 현재 main에 외부 원본을 새로 수집하는 스크립트가 없는 것은 확인했다. 별도 팀원 PC/다른 시스템의 존재 여부는 미확인이다.
- 향후에는 입력 존재·해시·스키마 검증 → staging 적재 → 품질 검증 → 안정적 키 기반 upsert → 원재료 연결/정규화 → 성공 커서 기록으로 구현해야 한다. 신뢰할 원본 공급처와 최신 파일을 먼저 확정한다.

## 재현과 배포 체크리스트

1. Node 22를 사용한다(`.nvmrc`, 운영 Docker 기준). 백엔드 `npm ci && npm test`, 모바일 `node --test "src/**/*.test.js"`.
2. 백엔드 78/78, 모바일 40/40 통과. 실제 SQL fixture에서 페이지 경계·한영 검색·알레르기 제외·증분 창을 검증했다. 로컬 일회용 PGlite DB에서 재계산 CLI dry-run → 의도적 쓰기 실패/배치 롤백 → apply → 재실행의 무중복 결과도 검증했다. 운영 DB에 apply한 시험이 아니다.
3. 변경 Terraform 파일 format 검사와 `terraform validate` 통과. 기존 미수정 `gke.tf`, `monitoring_dashboard.tf`에는 이전부터 format 차이가 있어 전체 디렉터리 format 검사와 구분한다. 적용 계획/상태 파일 동기화는 아직 하지 않았다.
4. Kubernetes YAML 파싱, Service/Job 선택자 검사, API Deployment/Service/PodMonitoring/CronJob의 client dry-run 통과. 실제 admission/rollout 결과를 대신하지 않는다.
5. SQL 재현: 승인된 시험 시간에 Proxy를 localhost:15432로 띄운 후 `node backend/scripts/check-search-performance.js --production-readonly`. Kubernetes Secret을 메모리에서만 읽고 결과 행/비밀번호는 출력하지 않는다.
6. HTTP 재현: 이전 커밋의 별도 checkout과 그 backend 의존성을 준비한 후 `node backend/scripts/check-http-performance.js --production-readonly --baseline-dir /absolute/path/to/baseline --output /absolute/path/to/aggregate.json`. 집계 증거는 [JSON](evidence/operations-db-http-2026-09-08.json)에 있다.
7. Jenkins 로그인 후 대상 저장소/브랜치 `*/main`/Script Path `Jenkinsfile` 확인. main 반영 후 최초 한 번 정상 실행되어야 코드의 Poll SCM 설정도 활성화된다. 현재 GitHub 쓰기 권한과 Jenkins 로그인/IAP 권한은 서로 다르다.
8. 리뷰 후 운영 활성화 여부를 정하고 배포한다. 현재 replicas=0이므로 이 manifest 배포는 API·웹을 각 1개로 활성화하는 변경이다. 이미지 빌드는 Docker 데몬이 없어 로컬에서 검증하지 못했으며 Jenkins에서 확인해야 한다.
9. 수신 이메일을 확정해 알림 채널을 만들고 Terraform에 ID를 지정한다. 기존 Terraform state에 경보가 이미 관리되는지 먼저 확인해 중복 생성/리소스 교체를 방지한다. 임의로 전체 Terraform apply하지 않는다.
10. 배포 후 엔드포인트가 API Pod만 가리키는지, readiness/제품/검색/제외 API 응답, 새 지표, CronJob 성공/중복 방지, 경보 발생·수신·복구를 각각 검증한다. 첫 운영 재계산 전 dry-run과 백업 상태 확인이 필요하다.
11. API 최대 DB 연결은 Pod당 6개(일반 5 + readiness 1), Job은 실행당 한 연결을 사용한다. 복제본/실행 동시성을 늘릴 때 Cloud SQL 전체 연결 예산도 다시 계산한다.

롤백은 이전 API 이미지로 되돌리는 것만으로 끝나지 않는다. 이전 Pod 템플릿에 `component: api`가 없으면 Service/PodMonitoring 선택자도 이전 상태로 되돌리거나 Pod 템플릿 라벨을 유지해야 한다. CronJob은 먼저 suspend하고 실행 중인 Job은 별도 확인한다. 이번 개선 자체는 새 운영 DB migration/인덱스를 요구하지 않는다.

개발 환경의 Node 23.11에서는 PGlite 초기화가 간헐적으로 멈췄다. 테스트를 생략하지 않고 운영과 같은 Node 22.23.2에서 전체 통과를 확인했다. Node 24에서도 당시 전체 테스트를 통과했지만 기준 런타임은 Node 22다.
