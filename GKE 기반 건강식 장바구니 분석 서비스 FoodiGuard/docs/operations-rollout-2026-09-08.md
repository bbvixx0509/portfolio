# 운영 반영 기록 (2026-09-08)

> 이 문서는 2026-09-08 당시의 기록입니다. 현재 Terraform 단일 루트는
> `infra/gcp/terraform/`이며, 알림 정책은 `admin@example.com` 채널에만 연결됩니다.

## 완료된 작업

- 사용자 승인 후 팀 저장소 PR #5를 main에 병합했다.
- main 병합 커밋: `270dfdd48b6649d0697aef24a3e2b1bfa19aafde`, 구현 커밋: `b278db0ac135bab66dc43cbd0c41b90bb6341a15`.
- Cloud SQL `foodiguard-db`의 주문형 백업 `1788867291268`이 `SUCCESSFUL`로 완료됐다. 완료 시각: 2026-09-08 20:36:22 KST. DB를 비우거나 CSV를 다시 가져오지 않았다.
- 승인받은 수신자 2명의 email notification channel을 생성하고 enabled 상태를 확인했다. 이메일 주소 자체는 저장소에 기록하지 않는다.
- 기존 FoodiGuard Alert Policy 8개를 ID를 유지한 채 갱신하고 새 정책 2개를 추가했다. 총 10개 모두 두 채널과 `OPENED`, `CLOSED` 알림에 연결했다.
- 운영 변경은 해당 Monitoring API 리소스에만 적용했다. 전체 Terraform apply나 기존 Jenkins/GKE/Cloud SQL Terraform state 변경은 하지 않았다.

수신 채널 리소스:

```hcl
alert_notification_channels = [
  "projects/example-gcp-project/notificationChannels/9083225703585199989",
  "projects/example-gcp-project/notificationChannels/17442675374644271846",
]
```

동일 값은 `infra/terraform/alert-channels.tfvars.example`과 미러 경로에 있다. 경보를 수신자 없이 적용하지 않도록 기존 precondition은 유지한다.

## Jenkins 원인 확인

2026-09-08 현재 Job `foodiguard-gke-deploy`의 저장된 설정:

- 저장소: 팀 저장소 (비공개)
- 브랜치: `*/main`, Script Path: `Jenkinsfile`, Poll SCM: `H/5 * * * *`
- 마지막 완료 빌드: #4, SUCCESS. 마지막 실제 checkout은 `rudans61/kubernetes-sre`, 커밋 `3d80ae88bc4313a4801770bc9f4fa90dc7deaa90`.
- 2026-09-08 20:32 KST polling log는 여전히 위 예전 브랜치를 비교하고 `No changes`로 끝났다.

따라서 현재 저장된 main 설정 자체가 잘못됐다는 설명은 불완전하다. Pipeline SCM Step은 마지막 빌드에서 사용한 SCM을 기억하여 폴링한다([Jenkins 공식 설명](https://plugins.jenkins.io/workflow-scm-step/)). 최초 main 빌드 후 다음 폴링 로그가 실제 `refs/heads/main`을 확인하는지 검증해야 한다.

Jenkins VM SSH/IAP와 Docker는 정상이다. 사용자가 기존 Jenkins 계정으로 로그인한 것을 확인했다. 앞선 로그인 실패의 원인은 확정하지 않았다. 익명 권한 확대·비밀번호 초기화·보안 비활성화는 하지 않았다.

최초 빌드 전 추가 보완: Jenkins `sh`의 기본 xtrace가 Secret 검사에서 base64 값을 출력할 수 있어 두 Jenkinsfile의 검사 구간에 `set +x`를 적용했다. 실제 Secret 대신 sentinel을 반환하는 셸 테스트로 값이 로그에 나오지 않고, 필수 키 네 개가 각각 누락되면 계속 실패하는 것을 확인했다. 과거 로그 유출 여부는 이 검사로 단정하지 않는다.

## 최초 main 배포 검증 완료

팀 저장소 PR #6 병합 커밋 `75f12e9205565bbe66d52805c0d4ca9a12c6e392`로 Jenkins #5를 수동 실행했다. 2026-09-08 20:59:15~21:06:01 KST, 6분 46초, **SUCCESS**.

- Console Output의 실제 결과: 백엔드 78/78, 모바일 40/40, 실패·skip 0. Secret 검사에서는 리소스 이름만 출력되고 값은 출력되지 않았다.
- API·웹 이미지 `:5`가 Artifact Registry에 push되고 두 Deployment 각각 1/1 Available, Pod 재시작 0으로 배포됐다.
- `foodiguard-db-migrate`는 Complete, 마이그레이션 결과 `ok=true`, 2.585초. 첫 Pod 대기는 GKE 노드 scale-up과 이미지 다운로드였으며 DB 마이그레이션 오류가 아니었다.
- API Service EndpointSlice는 API Pod `foodiguard-api-57bd7f859c-lltg9`의 IP만 포함한다. 완료된 마이그레이션 Pod는 포함하지 않는다.
- `foodiguard-allergen-projection` CronJob이 매일 03:00 Asia/Seoul, Forbid로 등록됐다. 등록 시점에는 아직 실행 이력이 없다.
- 외부 앱 `/`, `/api/health`, `/api/health/ready`, 상품 목록, `냉면` 검색, `메밀` 제외 요청 모두 HTTP 200. 세 상품 요청은 각각 48개를 반환했고, 무필터 목록만 `exactTotal=true`, total=79,041이었다. 이는 소수 요청 smoke test이며 부하 성능 인증이 아니다.
- PodMonitoring `ConfigurationCreateSuccess=True`. Monitoring 조회에서 `up=1`과 신규 지표 3개 실제 시계열을 확인했다. 지표 사전등록 옵션은 아래 세 정책 모두 false로 되돌린 후 재조회했다.
- 21:07 KST Poll SCM 로그는 `refs/heads/main`의 `75f12e9`를 비교했다. 예전 작업 브랜치를 계속 폴링하던 상태는 해소됐다. 후속 PR의 **자동 트리거/배포 검증은 별도**로 수행한다.

알레르기 재계산 마지막 성공은 2026-08-31 20:37:57 KST이며, 최근 24시간 실패 수는 0이다. 성공 시각이 오래됐다는 사실은 API 복구와 별개다. 최근 실패 0을 재계산 정상 운영으로 해석하지 않는다. 품질 조회 자체는 2026-09-08 21:06:05 KST에 성공했다.

## 남은 검증 및 보안 후속 작업

1. 후속 검증 PR을 main에 병합하고, 수동 Build Now 없이 Poll SCM으로 다음 빌드가 시작되어 배포되는지 확인한다.
2. 알림의 실제 수신과 복구 메일 수신을 각각 확인한다. 채널 enabled/API 저장 성공만으로 받은편지함 도착을 단정하지 않는다.
3. 재계산 dry-run → 결과 검토 → 실제 Job과 정기 실행 성공 검증, 반복 부하 시험 및 24~72시간 관측. 원본 import 자동화는 별도 미완료 항목이다.
4. 과거 빌드 #2~#4의 로그 각각에서 Secret 검사 인자가 마스킹 없이 기록된 흔적 4개를 확인했다. 값 자체는 출력하거나 이 문서에 기록하지 않았다. 접근 가능한 로그에 남았을 가능성을 고려해 DB 비밀번호와 앱 인증키 교체를 별도 승인하에 조율해야 한다. 기존 로그인 세션·GKE Secret·관련 Credentials의 영향을 확인하고 교체하며, 이번 작업에서는 임의 교체나 로그 삭제를 하지 않았다.

Secret 로그 보호 회귀 테스트는 `node --test infra/tests/jenkins-secret-logging.test.mjs`로 실행한다. 두 Jenkinsfile 각각 정상 키 및 네 개 누락 키의 10개 사례를 가짜 값으로 검증한다. 운영 Secret/클러스터 접근은 없으며 이후 Jenkins Regression Tests에도 포함했다.

## 경보 ID와 임시 사전등록 상태

아직 새 API가 지표를 내보내지 않아 3개 신규 지표를 참조하는 정책 등록은 처음에 `INVALID_ARGUMENT`으로 거절됐다. PromQL 조회 API 성공과 경보 API의 지표 존재 검증은 별개다.

공식 `disableMetricValidation=true` 옵션으로 세 정책만 사전등록했다([Google 공식 API](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies#PrometheusQueryLanguageCondition)). 이는 경보 평가를 끄는 옵션이 아니다. 배포 후 실제 시계열을 확인했고 세 정책 모두 false로 되돌려 Terraform 기본값과 일치시켰다. 두 알림 채널과 OPENED/CLOSED 설정은 유지됐다.

| Terraform key | Policy ID | 지표 사전등록 옵션 |
| --- | --- | --- |
| api_5xx | 18292910884479910481 | false |
| api_latency | 18292910884479910158 | false |
| db_latency | 5828093443642506391 | false |
| api_availability | 5828093443642504922 | false |
| container_restart | 18292910884479913608 | false |
| ingredient_match_ratio | 10564655419671972704 | false |
| nutrition_missing_ratio | 18292910884479913585 | false |
| data_freshness | 9853029188766015624 | false: 해제 완료 |
| data_quality_collection | 16564543512766950727 | false: 해제 완료 |
| sync_failure | 16564543512766950009 | false: 해제 완료 |

각 ID의 전체 이름은 `projects/example-gcp-project/alertPolicies/ID`다. 변경 전 8개 정책은 로컬 `/private/tmp/foodiguard-monitoring-before-20260908.json`에 보관했다. 임시 디렉터리의 보존은 보장되지 않는다.

팀원이 사용한 Terraform state는 이 작업에서 제공되지 않았다. 발견한 과거 로컬 state에는 Jenkins 관련 리소스만 있었고 경보는 없었다. 팀원의 실제 state와 위 ID를 대조하고, 새 정책 2개가 없다면 그 **기존 state에서** 해당 주소로 import한 뒤 계획을 검토한다. 빈 state에서 전체 apply하여 중복 경보나 다른 인프라를 만들지 않는다. 복구 알림·채널 ID 예제·Secret 보호는 PR #6으로 main 반영됐다. 후속 배포 증거와 회귀 테스트의 main 반영은 다음 PR로 추적한다.
