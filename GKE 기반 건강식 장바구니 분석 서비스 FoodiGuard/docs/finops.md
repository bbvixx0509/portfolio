# FinOps — 자원 사용 실측과 적정 크기 검토

2026-09-03 측정. 계획서 5단계(FinOps)와 6단계(데이터 품질 기준선)에 해당한다.

## 먼저: 실제 청구액은 이 문서에 없다

두 가지가 막는다.

- **결제 계정 조회 권한이 없다.** `gcloud billing accounts list` 가 빈 결과를 낸다.
  결제 계정은 프로젝트 소유자(`kolok91`)의 것이다.
- **청구 데이터 BigQuery 내보내기가 설정돼 있지 않다.** 설정해도 그 시점부터만 쌓이므로
  지난 기간은 소급되지 않는다.

따라서 금액은 콘솔의 결제 리포트에서 직접 봐야 한다. 이 문서는 **무엇이 얼마나 쓰이고
있는지**를 실측으로 남겨, 그 금액을 읽을 때 근거가 되게 한다.

## 비용 분리 준비

이 프로젝트는 결제 계정을 다른 워크로드(`icore-mysql`, Cloud Run 이미지 등)와 공유한다.
라벨이 없으면 FoodiGuard 비용만 떼어낼 수 없어서 네 리소스에 붙였다.

| 리소스 | 라벨 |
|---|---|
| GKE 클러스터 | `app=foodiguard` `env=capstone` `component=runtime` |
| Cloud SQL | `component=database` |
| Artifact Registry | `component=registry` |
| Jenkins VM | `component=ci` |

Terraform 이 관리한다(`infra/gcp/terraform/`). **라벨을 붙이기 전 기간은 분리되지 않는다.**

## 과금 대상과 실사용

### Cloud SQL — 유일하게 한계에 닿은 자원

| 항목 | 할당 | 실사용 |
|---|---|---|
| CPU | 1 vCPU (`db-custom-1-3840`) | **부하 시 91~100%** |
| 메모리 | 3.75 GB | — |
| 디스크 | 20 GB | **0.83 GB (4.2%)** |
| 가용성 | ZONAL | — |

CPU 는 포화되고 디스크는 4% 만 쓴다. **디스크를 줄일 여지가 있지만 Cloud SQL 은 디스크를
줄일 수 없다**(늘리기만 가능). 새로 만들 때만 조정할 수 있으므로 지금은 그대로 둔다.

### GKE Autopilot — 요청량이 실사용의 10배

Autopilot 은 파드가 **요청한** 양으로 과금한다. 실제로 쓰는 양이 아니다.

| 파드 | 요청 CPU | 실사용 CPU | 요청 메모리 | 실사용 메모리 |
|---|---|---|---|---|
| `foodiguard-api` | 300 m (250+50) | **2 m** | 640 Mi | 39 Mi |
| `foodiguard-web` | 100 m | **1 m** | 128 Mi | 6 Mi |

평시 사용량은 요청량의 1% 미만이다. 다만 부하 시에는 API 파드가 35 m 까지 올라갔으므로
요청을 실사용에 맞춰 극단적으로 줄이면 부하 때 스로틀링이 걸린다. **250 m → 100 m 정도가
현실적인 조정폭**이고, 그 이상은 부하 테스트로 확인한 뒤 결정할 일이다.

### Jenkins VM — 상시 가동 중이나 간헐적으로만 쓰인다

`e2-medium`, `RUNNING`. 빌드는 하루에 몇 번 돈다. **쓰지 않는 시간에 멈추면 그만큼
줄어든다.** 다만 Poll SCM 이 5분마다 깨어나야 하므로 단순 정지는 자동 배포를 끊는다.
자동 배포를 포기하고 수동 트리거로 바꿀지가 선행 판단이다.

### Artifact Registry

이미지 약 295 MB. 태그가 쌓이면 계속 는다(현재 backend 5개 + web 4개). **정리 정책이
없다.** 오래된 태그를 지우는 규칙을 넣으면 증가를 막을 수 있다.

## 관측된 이상 — 노드 12개

부하 테스트 뒤 확인하니 노드가 **12개**로 늘어 있었다. 실행 중인 앱 파드는 2개뿐이고,
나머지는 전부 시스템 파드(`kube-system` 198개)다.

원인은 부하 테스트 중 띄운 부하 생성 파드(500 m CPU / 2 Gi)와 부하 자체로 Autopilot 이
노드를 늘린 것이고, 축소가 즉시 일어나지 않는다. 일부 노드는 `SchedulingDisabled` 상태로
비워지는 중이었다.

**교훈 두 가지.**

- 부하 테스트용 파드는 끝나면 반드시 지운다. 이번에 하나를 28분 동안 남겨 뒀다.
- Autopilot 의 축소는 즉시가 아니다. 테스트 직후 노드 수로 비용을 판단하면 과대평가한다.

## 적정 크기 — 판단과 근거

| 대상 | 판단 | 근거 |
|---|---|---|
| Cloud SQL CPU | **증설하지 않는다** | 포화의 원인은 쿼리였다. 검색 정렬을 고치는 편이 싸다(`docs/performance.md`) |
| Cloud SQL 디스크 | 유지 | 4% 만 쓰지만 축소 불가 |
| API 파드 요청 | **줄일 여지 있음** | 평시 2 m / 부하 시 35 m 대 요청 300 m |
| 웹 파드 요청 | 유지 | 이미 작다 |
| Jenkins VM | **판단 보류** | 정지하면 자동 배포가 끊긴다 |
| Artifact Registry | **정리 정책 필요** | 태그가 무한히 쌓인다 |

가장 큰 절감은 **DB 를 키우지 않는 것**이다. 증설은 매달 비용이 붙지만 쿼리 개선은 한 번
고치면 끝난다. 부하 테스트에서 API 파드가 35 m 로 놀고 있는 동안 DB 가 91% 였다는 사실이
"API 를 늘려도 소용없다" 는 근거이기도 하다.

## 데이터 품질 기준선

알림 임계값은 이 값에서 잡았다(`infra/gcp/terraform/monitoring.tf`).

| 지표 | 실측 | 알림 임계 |
|---|---|---|
| 원재료 매칭률 | 1.0 (79,041건 전부) | 0.95 미만 |
| 영양성분 누락률 | 0.0025% (약 2건) | 1% 초과 |
| 마지막 증분 적재 | 63분 전 | 26시간 초과 |
| 컨테이너 재시작 | 0 | 10분 내 발생 |

## 다시 재는 법

```bash
gcloud container clusters get-credentials foodiguard-cluster \
  --region asia-northeast3 --project example-gcp-project

kubectl top pod                     # 파드 실사용
kubectl get pods -o custom-columns='POD:.metadata.name,CPU:.spec.containers[*].resources.requests.cpu'
kubectl get nodes                   # 노드 수(부하 직후에는 부풀어 있다)
```

Cloud SQL CPU·디스크는 Cloud Monitoring 의 `cloudsql.googleapis.com/database/cpu/utilization`
과 `.../disk/bytes_used` 로 본다. 데이터 품질은 `docs/observability.md` 5절의 PromQL 을 쓴다.
