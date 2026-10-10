# FoodiGuard 운영 API 다중화와 DB 부하 관리

## 운영 설정

- 기존 GKE `default/foodiguard-api`를 변경한다. 별도 테스트용 API가 아니다.
- HPA: 최소 2, 최대 4 Pod. API 컨테이너의 CPU 요청량(250m) 대비 65%.
- 증가: 30초 안정화 후 60초당 최대 1개. 감소: 300초 안정화 후 60초당 최대 1개.
- SQL Proxy CPU는 HPA 기준에서 제외한다. CPU 부족이 아닌 DB 대기는 CPU HPA로 해결되지 않는다.
- Pod별 주 DB 풀 3개 + readiness 전용 1개, 검색/대체 후보 조회 동시 1개, 대기 10개, 대기 제한 1초.
- 정상 상태 최대 4 Pod의 API 연결 예산은 16개다. 롤링 배포 surge 1개일 때 20개지만 종료 중인 Pod, CronJob, 마이그레이션, 관리 연결은 별도다. **DB 전체에 대한 하드 전역 제한이 아니다.**
- 연결 획득 및 SQL 실행 제한 시간을 유지한다. DB 인스턴스 사양과 max_connections는 변경하지 않는다.
- 제품 조회의 SQL/바인드 값이 같은 동시 요청만 병합한다. 페이지, 검색어, 테마, 알레르기 제외 조건이 다르면 공유하지 않는다. 완료된 상품/알레르기 결과를 저장하지 않아 이후 요청은 DB를 다시 조회한다.
- 기존 전체 상품 COUNT의 30초 캐시는 유지한다. 개인 프로필/인증/AI 응답은 병합하지 않는다.

## 배포 안정성

- Deployment `replicas`는 선언하지 않는다. 이후 Jenkins 배포가 HPA의 개수를 덮어쓰지 않는다.
- `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 10`.
- PDB `minAvailable: 1`은 자발적 축출에 대한 최소 보호다. 노드 장애나 직접 Pod 삭제, Deployment 롤링 업데이트까지 막는 것은 아니다.
- API 종료 유예 45초: preStop 5초, SIGTERM 후 HTTP/DB 정리 최대 35초.
- Cloud SQL Proxy는 native sidecar이므로 API 종료 후 종료한다.
- hostname 기준 soft topology spread로 노드 분산을 선호한다. 강제적인 멀티존/노드 장애 내성을 보장하지 않는다.
- 기본 Pod 수 증가로 상시 자원 요청량과 비용이 증가한다. Redis/새 DB/VM은 추가하지 않는다.

## 측정 지표와 중단 기준

### 웹 진입 경로 가용성 보완 (2026-09-10)

- 웹 2개, hostname topology spread `maxSkew: 1`, `minDomains: 2`, `DoNotSchedule`. 적격 노드가 부족하면 함께 배치하지 않고 Pending 상태가 된다.
- 웹 PDB `minAvailable: 1`. 자발적 축출에 대한 보호이며 갑작스러운 장애나 직접 삭제에 대한 무중단 보장은 아니다.
- 웹 rollout `maxUnavailable: 0`, `maxSurge: 1`, `minReadySeconds: 10`.
- 종료 유예 60초, preStop 30초 대기 후 `nginx -s quit`, 5초 대기. 기존 LB 검사 8초 간격·실패 3회에 여유를 둔다. 네트워크 제어면의 수렴 시간에 상한을 보장하지 않는다.
- **현재 외부 정책은 Local이다.** 첫 전환은 접속 공백 때문에 Cluster로 원복했다. 이후 사용자가 접속 중단 가능한 유지보수 시간을 승인하여 재전환했고, 웹 노드 2개만 LB HEALTHY인 상태와 외부 HTTP 200이 60초 이상 유지됨을 확인했다. 기존 IP <EXTERNAL_IP>과 Service UID는 유지됐다.
- Local은 웹 실행 노드로만 외부 패킷을 보낸다. 이 환경에서는 정책 변경 시 GKE가 target pool을 재구성하므로 무중단 작업이 아니다. 후속 정책 변경은 유지보수 승인을 받고 전환/원복 시간을 모두 계획한다. 점검 중 실패 기록은 보존하며, 부하 실험의 3초 외부 readiness 중단 기준과 분리한다.
- Jenkins는 웹 2개 rollout 확인 뒤 검증된 Local Service를 적용한다. 양쪽 매니페스트·PDB·Jenkins 설정을 함께 관리하여 이후 배포에서 Cluster로 되돌아가지 않게 한다.
- 웹 기본 자원 요청량이 100m/128Mi 한 개에서 두 개로 증가한다. Autopilot에서 anti-affinity는 추가 최소 CPU가 필요해, 리소스를 늘리는 대신 topology spread를 사용한다.
- 코드 반영 파일은 양쪽 k8s 디렉터리와 Jenkinsfile이다. 운영 직접 적용과 별개로 Git main 반영 및 Jenkins 재배포를 검증하고 그 이후 이미지·설정이 안정된 상태에서 부하 시험을 시작한다.

참고: [GKE 외부 트래픽 정책](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer), [Topology spread](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/).

### 기존 혼합 트래픽 계획

동일 실제 Cloud SQL 상품, 동일 GET 혼합(목록 40%, 검색 40%, 알레르기 제외 20%), 동일 생성기로 변경 전후를 비교한다. 응답 상품 해시도 확인한다. 5/10/20 RPS, 30초씩 3회. 20 RPS 이전 단계가 실패하면 중단한다. 운영 DB를 포화시키기 위한 무제한 증가는 하지 않는다.

- DB CPU 75% 이상, 지표 4분 이상 지연/조회 불가, readiness 실패, 연속 5개 오류/2초 초과 시 중단한다.
- p50/p95, 2초 내 정상 처리 비율, HTTP 오류, 생성기 누락, DB CPU, API 자원, HPA 상태를 분리한다.
- 중단된 구간의 처리량을 예정된 30초로 나눠 최대 RPS라고 보고하지 않는다.
- 시간순 전후 측정이므로 DB 캐시·외부 트래픽·백그라운드 작업 차이가 남는다. GKE 자체와 VM의 동등 자원 비교가 아니다.
- HPA가 실제 확장하지 않았다면 자동 확장 성능은 미검증으로 표시한다. 수치를 만들기 위해 운영 CPU를 소모하거나 HPA 기준을 낮추지 않는다.
- 일회성 측정 결과는 24/72시간 실사용 가용성이나 추천 정확도의 증거가 아니다.

## 관측과 복구

추가 지표: `foodiguard_search_coalescing_total{result}`, `foodiguard_search_active`, `foodiguard_search_queued`, `foodiguard_db_pool_connections`, `foodiguard_db_pool_idle`, `foodiguard_db_pool_waiting`. 검색어/프로필/개인 식별자는 라벨에 넣지 않는다.

이상 시 먼저 생성기 트래픽을 중단한다. 기존 정상 이미지와 Deployment 스냅샷을 확인하고, 필요한 경우 승인된 이전 버전으로 롤링 복구한다. HPA가 개수를 계속 조절하므로 단순 scale 명령만으로 되돌리지 않는다. Git의 변경도 함께 되돌려 다음 Jenkins 실행에서 재적용되지 않게 한다. Secret, DB 데이터와 기존 알림 정책은 롤백 대상에 포함하지 않는다.

참고: [HPA](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/), [Native sidecar 종료 순서](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/), [PDB 범위](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/).
