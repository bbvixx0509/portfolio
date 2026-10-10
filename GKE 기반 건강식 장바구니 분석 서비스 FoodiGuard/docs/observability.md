# 관측성 — Prometheus 계측과 GKE 수집

FoodiGuard API 의 지표 노출, GKE 수집 설정, PromQL, 대시보드, 알림 기준을 정리한다.
현재 운영 기준은 `rudans61/kubernetes-sre` 브랜치이며, 관측성 코드와 Kubernetes 설정,
Cloud SQL 증분 실행 기록 및 Jenkins 배포 단계가 들어간다.

## 1. 무엇을 어디서 내보내는가

| 항목 | 위치 |
|---|---|
| 지표 정의·계측 헬퍼 | `backend/server/metrics.js` |
| 계측 회귀 테스트 | `backend/server/metrics.test.js` |
| 미들웨어·라우트 연결 | `backend/server/index.js` |
| 수집 설정 | `k8s/pod-monitoring.yaml`, `infra/gcp/k8s/pod-monitoring.yaml` |

노출 경로는 `GET /metrics` 이고 인증이 없다. 클러스터 네트워크 경계 안에서만 닿는
ClusterIP 서비스이고, Service 에는 `/metrics` 를 뚫어 두지 않았다. 관리형 수집기는
Service 가 아니라 파드에 직접 붙으므로 외부로 열 필요가 없다.

## 2. 지표

| 지표 | 종류 | 라벨 | 뜻 |
|---|---|---|---|
| `foodiguard_http_requests_total` | Counter | method, route, status_class | 요청량·오류율 |
| `foodiguard_http_request_duration_seconds` | Histogram | method, route, status_class | API p50·p95·p99 |
| `foodiguard_http_in_flight_requests` | Gauge | — | 동시 요청 |
| `foodiguard_db_query_duration_seconds` | Histogram | operation, result | DB 조회 지연 |
| `foodiguard_db_query_errors_total` | Counter | operation | DB 오류 |
| `foodiguard_gemini_requests_total` | Counter | result | Gemini 성공·실패 |
| `foodiguard_gemini_request_duration_seconds` | Histogram | result | Gemini 지연 |
| `foodiguard_gemini_fallback_total` | Counter | — | 규칙 설명 대체 횟수 |
| `foodiguard_allergen_exclusions_total` | Counter | operation | 알레르기 제외 적용 횟수 |
| `foodiguard_ingredient_match_ratio` | Gauge | — | 원재료 매칭률 |
| `foodiguard_nutrition_missing_ratio` | Gauge | — | 영양성분 누락률 |
| `foodiguard_data_last_success_timestamp_seconds` | Gauge | — | 증분 적재 최신성 |

`operation` 값: `product_search_count`, `product_search_list`, `alternatives_source`,
`alternatives_candidates`, `alternatives_detail`, `ingredient_detail`,
`ingredient_source`, `health_counts`, `data_quality`, `data_last_success`.

### 라벨 규칙

허용은 `method` · `route` · `status_class` · `operation` · `result` 다섯 개뿐이다.
회원 id·이메일·검색어·식품명·전체 URL 은 넣지 않는다. 개인정보가 지표로 새는 문제도
있지만, 검색어처럼 값이 무한한 라벨은 시계열을 폭증시켜 수집 자체를 망가뜨린다.

`route` 는 URL 이 아니라 라우트 패턴이다. `/api/products/12345/ingredients` 를 그대로
쓰면 상품 수만큼 시계열이 생기므로 `/api/products/:id/ingredients` 로 남긴다.
매칭되지 않은 요청은 `unmatched`, SPA 폴백은 `spa` 로 접는다.
`backend/server/metrics.test.js` 가 허용 라벨 외의 값이 붙으면 실패시킨다.

### 읽을 때 주의할 점

- **`foodiguard_allergen_exclusions_total` 은 제외된 상품 수가 아니라 조회 수다.**
  제외된 상품 수를 세려면 제외 없는 `COUNT` 를 매 요청 한 번 더 돌려야 해서 비용이
  두 배가 된다.
- **`foodiguard_gemini_fallback_total` 은 서버가 관측한 Gemini 실패 수다.** 규칙 기반
  설명 자체는 앱(`mobile/App.js`)이 만든다. 서버 실패가 곧 앱의 대체 표시로 이어지므로
  같은 수를 센다. 장바구니가 비어 400 이 난 경우는 호출부 입력 문제라 세지 않는다.
- **데이터 품질 게이지 3종은 값을 알기 전까지 아예 나오지 않는다.** 라벨 없는 Gauge 를
  미리 등록하면 0 을 내보내는데, 여기서 0 은 '매칭률 0%', '마지막 적재 1970년'으로
  읽혀 기동 직후 첫 수집에서 알림을 잘못 울린다. 그래서 알림에 `absent()` 조건을
  같이 건다(8절).
- **데이터 품질 집계는 5분 캐시다**(`DATA_QUALITY_TTL_MS`). 전수 집계라 30초 수집마다
  돌리면 DB 를 갉아먹는다. `/metrics` 요청은 갱신을 걸어 두기만 하고 곧바로 응답한다.
- **`foodiguard_data_last_success_timestamp_seconds` 는 `sync_runs` 에서 읽는다.**
  `status = 'completed'` 이고 `finished_at` 이 있는 실제 Cloud SQL 작업만 성공으로 본다.
  Jenkins의 `Incremental Data Sync` 단계는 변경된 상품·원재료의 알레르기 파생값을
  갱신하고 `source_type = 'allergen_projection'` 실행 이력을 남긴다.

## 3. GKE 수집 설정

`infra/gcp/terraform/gke.tf` 는 Autopilot(`enable_autopilot = true`)이라 관리형 수집이
기본으로 켜져 있다. 다만 `monitoring_config` 가 `lifecycle.ignore_changes` 에 들어
있어 Terraform 이 이 설정을 관리하지 않는다 — 상태는 클러스터에서 직접 확인한다.

```bash
gcloud container clusters get-credentials <클러스터> --region <리전> --project example-gcp-project

# 관리형 수집기가 떠 있는지
kubectl get pods -n gmp-system

# PodMonitoring CRD 가 있는지
kubectl get crd | grep podmonitoring
```

적용:

```bash
kubectl apply -f k8s/pod-monitoring.yaml
kubectl get podmonitoring
kubectl describe podmonitoring foodiguard-api
```

정상 기준:

```text
Active Targets: 1 이상
Unhealthy Targets: 0
Health: up
```

`endpoints[].port` 는 번호가 아니라 컨테이너 포트 **이름**이다.
`k8s/backend-deployment.yaml` 의 `ports[].name: http` 와 짝이 맞아야 한다.

## 4. 배포 전 준비

`AUTH_TOKEN_SECRET` 시크릿이 없으면 파드가 뜨지 않는다(B04 세션 토큰 서명 키).

```bash
kubectl create secret generic foodiguard-auth-secret \
  --from-literal=AUTH_TOKEN_SECRET="$(openssl rand -hex 32)"
```

키가 없으면 서버는 프로세스마다 임시 키를 만들고 경고를 남긴다. 재시작하면 로그인이
풀리고 레플리카를 늘리면 서로의 토큰을 거부하므로, 배포 환경에서는 반드시 넣는다.

### Cloud SQL 증분 작업

Jenkins는 스키마 마이그레이션 다음에 `k8s/data-sync-job.yaml`을 실행한다. 첫 실행은
전체 상품을 기준선으로 처리하고, 다음 실행부터는 마지막으로 완료된
`allergen_projection` 이후 `food_products.updated_at` 또는
`ingredient_source_rows.updated_at`이 바뀐 상품만 처리한다.

```sql
SELECT id, source_type, mode, status, started_at, finished_at,
       read_count, updated_count, matched_count, unmatched_count, error_message
FROM sync_runs
ORDER BY id DESC
LIMIT 10;
```

Jenkins는 Job 성공뿐 아니라 로그의 `SYNC_RUN_RESULT`가 `completed`인지도 검사한다.
외부 공공데이터 API의 신규 원본 적재기는 아직 이 저장소에 없으므로, 이 Job은 새 원본을
다운로드하지 않고 Cloud SQL에 이미 들어온 변경분의 파생 데이터를 동기화한다.

## 5. 핵심 PromQL

요청량:

```promql
sum(rate(foodiguard_http_requests_total[5m]))
```

5xx 오류율:

```promql
sum(rate(foodiguard_http_requests_total{status_class="5xx"}[5m]))
/
sum(rate(foodiguard_http_requests_total[5m]))
```

API p95(경로별):

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (
    rate(foodiguard_http_request_duration_seconds_bucket[5m])
  )
)
```

DB p95(작업별):

```promql
histogram_quantile(
  0.95,
  sum by (le, operation) (
    rate(foodiguard_db_query_duration_seconds_bucket[5m])
  )
)
```

데이터 증분 지연(초):

```promql
time() - foodiguard_data_last_success_timestamp_seconds
```

Gemini 폴백 비율:

```promql
sum(rate(foodiguard_gemini_fallback_total[10m]))
/
sum(rate(foodiguard_gemini_requests_total[10m]))
```

DB 오류율:

```promql
sum(rate(foodiguard_db_query_errors_total[5m])) by (operation)
```

알레르기 제외 사용 빈도:

```promql
sum(rate(foodiguard_allergen_exclusions_total[5m])) by (operation)
```

## 6. 대시보드

네 영역으로 나눈다.

1. **트래픽** — RPS, 요청 수, 동시 요청(`foodiguard_http_in_flight_requests`)
2. **오류** — 4xx·5xx 비율, DB 오류율, Gemini 실패율
3. **지연** — API·DB·Gemini 의 p50/p95/p99
4. **데이터 품질** — 원재료 매칭률, 영양성분 누락률, 알레르기 커버리지,
   마지막 적재 이후 경과 시간

GKE CPU·메모리·파드 재시작과 Cloud SQL CPU·연결 수는 Cloud Monitoring 기본 지표를
같은 대시보드에 붙인다. 이 둘은 애플리케이션이 내보내는 값이 아니다.

## 7. 알림 초기값

초기값이며 24~72시간 측정한 뒤 조정한다.

| 알림 | 조건 | 기간 |
|---|---|---|
| API 장애 | `up{job="foodiguard-api"} == 0` | 3분 |
| 5xx 오류 | 5xx 비율 > 0.05 | 5분 |
| API 지연 | route별 p95 > 1s | 10분 |
| DB 지연 | operation별 p95 > 0.5s | 10분 |
| Gemini 실패 | 폴백 비율 > 0.2 | 10분 |
| 데이터 갱신 실패 | `time() - ...last_success... > 93600` (26시간) | 30분 |
| 데이터 품질 | 원재료 매칭률이 기준선 아래로 하락 | 30분 |
| 파드 장애 | 재시작 횟수 급증 (Cloud Monitoring GKE 지표) | 10분 |

데이터 갱신 알림은 '값이 아직 없는 상태'도 함께 잡아야 한다.

```promql
absent(foodiguard_data_last_success_timestamp_seconds)
or
(time() - foodiguard_data_last_success_timestamp_seconds) > 93600
```

`sync_runs` 에 성공 이력이 한 번도 없으면 이 지표는 아예 나오지 않는다. 최초 적재를
돌리기 전에 알림을 켜면 `absent()` 쪽이 계속 울리므로, 첫 적재 뒤에 켜는 편이 낫다.

## 8. 완료 기준

- [x] `/metrics` 가 200 을 반환한다
- [x] 개인정보가 지표 라벨에 없다(허용 라벨 5종만 사용, 테스트로 고정)
- [x] 요청이 발생하면 Counter 가 오른다
- [x] 검색을 호출하면 Histogram 이 갱신된다
- [x] `PodMonitoring` Active Target 이 정상이다 — `up{job="foodiguard-api"} == 1` (2026-08-28)
- [x] Cloud Monitoring 에서 PromQL 로 조회된다 — 5절 질의 전부 확인 (2026-08-28)
- [ ] Jenkins 증분 Job이 운영 Cloud SQL `sync_runs`에 `completed` 행을 남긴다 — 배포 후 확인
- [ ] API 강제 실패 시 알림이 발생하고, 복구 후 자동 해제된다 — 알림 생성 후 SRE 검증
- [ ] 대시보드 캡처를 문서에 붙인다 — 대시보드 생성 후

2026-08-28 에 `example-gcp-project` 프로젝트의 `foodiguard-cluster`(asia-northeast3, Autopilot
1.35) 에 배포하고 수집까지 확인했다. `gke-gmp-system` 의 `collector` 데몬셋이 30초
주기로 긁어 가고, `foodiguard_*` 지표가 Cloud Monitoring 에서 조회된다.

남은 두 항목은 알림 정책을 먼저 만들어야 검증할 수 있다. 7절 초기값으로 알림을 만든
뒤 SRE 담당자가 장애·롤백 시나리오를 돌린다. 임계값 자체는 7절 단서대로 24~72시간
측정한 뒤 조정한다.

## 9. 로컬에서 확인하는 법

```bash
# DB 를 띄우고
docker compose up -d db

# API 를 띄운 뒤
AUTH_TOKEN_SECRET=local npm --prefix backend start

# 트래픽을 만들고 지표를 본다
curl -s "http://localhost:8080/api/products?display=5" > /dev/null
curl -s http://localhost:8080/metrics | grep foodiguard_
```

계측 자체의 회귀는 `npm --prefix backend test` 가 확인한다.

## 10. GCP Managed Prometheus 접속

이 구성은 별도의 Prometheus 서버나 9090 웹 UI를 띄우지 않는다. GKE의 Google Managed
Service for Prometheus가 `PodMonitoring`을 통해 30초마다 API 파드의 `/metrics`를 수집한다.

Cloud Monitoring의 **Metrics Explorer**에서 언어를 `PromQL`로 선택하고 5절 쿼리를
입력한다.

```text
https://console.cloud.google.com/monitoring/metrics-explorer?project=example-gcp-project
```

원본 `/metrics`를 직접 확인할 때는 다음 터널을 연다.

```bash
gcloud container clusters get-credentials foodiguard-cluster \
  --region=asia-northeast3 \
  --project=example-gcp-project

kubectl port-forward service/foodiguard-api 19090:80
```

다른 터미널이나 브라우저에서 `http://127.0.0.1:19090/metrics`를 연다. 이 방법은 수집된
과거 시계열이 아니라 현재 파드가 내보내는 원본 값만 보여준다.
