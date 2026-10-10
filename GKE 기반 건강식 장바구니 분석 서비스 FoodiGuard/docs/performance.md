# 성능 개선 — 검색 조회 경로

`rudans61/performance-tuning` 브랜치의 근거와 측정값을 남긴다.

## 측정 환경

로컬 도커 `postgres:17`, 상품 79,041건 · 원재료 901,315행 · 알레르기 표시 122,464행.
운영은 Cloud SQL + Cloud SQL Proxy 라 **절대 수치는 다르다.** 다만 쿼리 모양과 실행계획은
같으므로 병목의 위치와 개선 방향은 그대로 적용된다.

운영은 GKE Autopilot(`example-gcp-project` / asia-northeast3) + Cloud SQL PostgreSQL 17
(`db-custom-1-3840`, 1 vCPU · 3.75 GB) 이다. 관리형 Prometheus 수집은 2026-08-28 에 붙었고,
아래 운영 수치는 그 위에서 잰 것이다.

## 2026-08-28 정정 — 부분 인덱스가 죽어 있었다

운영에 배포하고 재측정하다가 **부분 인덱스가 로컬·운영 양쪽 모두에서 한 번도 쓰이지
않고 있었다**는 것을 발견했다. 인덱스 술어는 원본 컬럼을 보는데(`ingredient_status =
'matched'`), 앱은 `food_app_view` 를 거치므로 플래너가 보는 것은 뷰가 노출하는
`LOWER(COALESCE(ingredient_status, 'UNMATCHED'))` 였다. 술어가 그 표현식을 함의하지
못해 플래너가 인덱스를 후보에서 제외했고, 검색은 계속 79,041 건 전수 스캔이었다.

| 경로 | 실행계획 | 시간 |
|---|---|---|
| `food_products` 직접 | Index Scan | 1.8 ms |
| `food_app_view` 경유 (앱의 실제 경로) | Seq Scan 79,041 행 | 86 ms |
| 술어를 뷰 표현식에 맞춘 뒤 뷰 경유 | Index Scan | **0.65 ms** |

술어를 뷰와 같은 모양으로 바꿔 고쳤다. 아래 "개선 전/후" 표의 옛 수치는 인덱스가
쓰였을 때를 가정한 값이라 실제 배포본에서는 재현되지 않았다. 같은 어긋남이 다시
생기면 `server/schema.test.js` 가 실패한다.

## 결과

### 운영 실측 (2026-08-28, GKE + Cloud SQL)

파드 안에서 `127.0.0.1:8080` 으로 각 5회, 워밍 후 중앙값. 술어 수정 전후 모두 같은
클러스터·같은 인스턴스에서 쟀다.

| 요청 | 인덱스가 죽어 있을 때 | 고친 뒤 | |
|---|---|---|---|
| 기본 목록 (`/api/products?display=48`) | 361 ms | **24 ms** | 15배 |
| 테마 정렬 (`theme=sodium`) | 348 ms | **21 ms** | 17배 |
| 알레르기 제외 (`excludeAllergens=메밀`) | 529 ms | **180 ms** | 2.9배 |
| 키워드 검색 (`query=냉면`) | 390 ms | **305 ms** | 1.3배 |

Cloud SQL 이 1 vCPU 라 API 값은 동시 부하에 흔들린다(같은 요청이 21 ms 와 70 ms 를
오간다). 쿼리 단위가 더 안정적이므로 판단은 아래 표로 한다.

쿼리 단위(`EXPLAIN ANALYZE`, `jit=off`, 3회 중앙값):

| 쿼리 | 시간 |
|---|---|
| 기본 목록 LIST(48) | **3.2 ms** |
| 테마 정렬 LIST(48) | **2.4 ms** |
| 알레르기 제외 LIST(48) | **3.5 ms** |
| 기본 목록 COUNT | **11.4 ms** |
| 키워드 검색 LIST(48) | **168.9 ms** |

### 로컬 측정 (개선 작업 당시)

API 엔드투엔드, 각 5회 중앙값:

| 요청 | 개선 전 | 개선 후 | |
|---|---|---|---|
| 기본 목록 (`/api/products?display=48`) | 422 ms | **67 ms** | 6.3배 |
| 알레르기 제외 (`excludeAllergens=메밀`) | 484 ms | **87 ms** | 5.6배 |
| 테마 정렬 (`theme=sodium`) | 415 ms | **66 ms** | 6.3배 |
| 키워드 검색 (`query=냉면`) | 79 ms | **65 ms** | 1.2배 |
| 상품 상세 (`/api/products/:id/ingredients`) | 2 ms | **1 ms** | 2배 |

쿼리 단위(`EXPLAIN ANALYZE`, `jit=off` 기준):

| 쿼리 | 개선 전 | 개선 후 |
|---|---|---|
| 기본 목록 LIST(48) | 209 ms | **0.75 ms** |
| 알레르기 제외 LIST(48) | 262 ms | **0.77 ms** |
| 기본 목록 COUNT | 125 ms | **35 ms** |
| 알레르기 제외 COUNT | 188 ms | **47 ms** |

## 무엇이 느렸나

### 1. 앱 뷰가 필터마다 상품 8만 건을 전부 훑었다

`food_app_view` 는 `ingredient_status` 와 `health_functional_decision` 을 상품마다
LATERAL 조인으로 계산했다. 앱 검색은 이 두 값을 **항상** 필터로 쓰기 때문에, 48건을
돌려주는 요청도 79,041건 전부에 대해 조인을 돌린 뒤 정렬했다.

더 나쁜 건 추정치였다. 조인 결과에 걸린 조건은 Postgres 가 선택도를 추정하지 못해
**실제 79,041행을 1행으로 봤다.** 그래서 "인덱스 순서대로 읽다가 48건 채우면 멈추는"
계획 대신 "전부 읽고 정렬하는" 계획을 골랐다. 강제로 전자를 태워 보면 1.1 ms 였다.

측정으로 확인한 사실 하나 — 현재 이 세 필터는 **한 건도 걸러내지 않는다.**
79,041건 전부가 `active` · `MATCHED` · `CLEAR` 다. 아무것도 거르지 않는 조건에
매 요청 140 ms 를 쓰고 있었다.

**고친 방법.** 판정 결과를 `food_products.health_functional_decision` 컬럼으로 두고
(이력은 `health_functional_matches` 가 계속 가진다), 뷰가 기본 컬럼에서 읽게 했다.
`ingredient_status` 와 `current_ingredient_source_id` 는 이미 상품 테이블에 있던
컬럼이라 그대로 쓰면 됐다. LATERAL 두 개가 사라지면서 조건이 상품 테이블에 직접
걸리고, 통계가 정상으로 잡히고, 부분 인덱스가 붙는다.

```sql
CREATE INDEX idx_food_products_searchable
  ON food_products (((id * 2654435761) % 4294967296))
  WHERE active AND ingredient_status = 'matched'
    AND health_functional_decision NOT IN ('EXCLUDE', 'REVIEW');
```

기본 목록의 의사 난수 정렬식을 그대로 인덱스로 만들어, 정렬 없이 앞에서 48건만 읽는다.

### 2. JIT 컴파일이 매번 헛돌았다

뷰의 상관 서브쿼리 때문에 비용 추정치가 백만 단위로 나와 모든 조회가 JIT 임계값을
넘겼다. 실제로 훑는 건 8만 행이라 컴파일 비용을 회수하지 못한다. 목록 조회 한 번에
**컴파일에만 83 ms** 를 썼다.

접속 풀에서 `-c jit=off` 로 껐다(`DB_JIT=on` 이면 서버 기본값을 쓴다).
그것만으로 목록 조회가 455 ms → 229 ms 였다.

### 3. 알레르기 제외가 필요 없는 배열을 만들었다

`NOT (allergen_codes && $1)` 는 뷰의 `allergen_codes` 를 쓰는데, 이건 상품마다
`food_allergens` 를 모아 배열을 만드는 서브쿼리다. 제외 대상이 아닌 상품까지 배열을
전부 만든 뒤 버렸다. `food_allergens` 를 직접 안티조인으로 바꿨다(90 ms → 47 ms).

```sql
NOT EXISTS (
  SELECT 1 FROM food_allergens fa
  WHERE fa.food_id = food_app_view.id AND fa.allergen_code = ANY($1::varchar[])
)
```

## 시도했지만 채택하지 않은 것

- **LATERAL 을 `DISTINCT ON` 으로 바꾸기** — 기본 목록은 46% 빨라졌지만 키워드 검색이
  37 ms → 67 ms 로 두 배 느려졌다. 선택적인 조회에서 매칭 테이블 전체를 훑게 된다.
- **표현식 통계(`CREATE STATISTICS`)** — 추정치가 그대로 1행이었다. LATERAL 출력에
  걸린 필터에는 테이블 단위 통계가 적용되지 않는다.
- ~~**테마 정렬용 부분 인덱스** — 플래너가 쓰지 않아 86 ms 에서 더 내려가지 않았다.~~
  **2026-08-28 채택으로 뒤집힘.** 플래너가 쓰지 않은 것은 술어가 뷰 표현식과 어긋나
  있었기 때문이고, 술어를 맞추자 바로 쓰인다. "남은 병목 · 판단 2" 참조.

## 남은 병목

운영 실측(2026-08-28, `EXPLAIN ANALYZE`, `jit=off`)으로 보류해 둔 두 판단을 정리했다.

### 판단 1 — COUNT 캐시는 하지 않는다

LIST 가 3.2 ms 로 내려오면서 기본 목록의 지연은 이제 **COUNT 11.9 ms** 가 정한다.
둘은 병렬이라 큰 쪽이 전체를 결정하므로, 캐시하면 API 가 24 ms 에서 10 ms 남짓
줄어든다. 다만 같은 시점에 테마 정렬이 291 ms 였다. 10 ms 를 깎는 것보다 290 ms 를
깎는 쪽이 먼저라 **캐시는 보류하고 테마 정렬을 먼저 처리했다.** 테마까지 내려온 뒤에도
COUNT 가 최대 항이면 그때 다시 본다.

### 판단 2 — 테마 정렬 부분 인덱스는 채택한다

이전에는 "플래너가 쓰지 않고, 테마 조회는 이미 66 ms 라 급하지 않다" 고 미뤄 두었다.
그 66 ms 는 기본 인덱스가 쓰인다는 전제의 수치였고, 실제로는 인덱스가 죽어 있었다.
운영에서 테마 정렬은 291 ms 로 **가장 느린 경로**였다.

테마는 정렬 키가 달라 `idx_food_products_searchable` 를 탈 수 없다. 정렬 키마다 같은
술어의 부분 인덱스를 두면 **291 ms → 0.43 ms** 로 떨어진다(실측). 인덱스 목록과
검색의 `ORDER BY` 가 갈라지면 갈라진 테마만 조용히 전수 정렬로 돌아가므로,
`themeOrderColumns` 를 `schema.js` 에서 한 번만 정의하고 인덱스와 질의가 함께 쓴다.
`server/schema.test.js` 가 그 순회를 확인한다. 적용 후 운영에서 **2.4 ms** 다.

### 다음 병목 — 키워드 검색 168.9 ms

세 경로가 3 ms 대로 내려오면서 이제 키워드 검색이 가장 느리다. `normalized_name
ILIKE '%냉면%'` 가 trigram 인덱스를 타지 못해서인데, 두 글자 검색어는 trigram 이
만들어지지 않아 구조적으로 인덱스를 못 쓴다(세 글자 이상은 탄다). 이건 인덱스
추가로는 풀리지 않고 검색 방식 자체를 손봐야 하므로 별도 작업으로 남긴다.

## 확인 방법

```bash
docker compose up -d db
npm --prefix backend run db:migrate
npm --prefix backend test          # 풀 설정 회귀 테스트 포함

curl -s -o /dev/null -w "%{time_total}\n" "http://localhost:8080/api/products?display=48"
```

수집이 붙은 뒤에는 `docs/observability.md` 5절의 PromQL 로 같은 값을 본다.
