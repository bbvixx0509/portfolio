# FoodiGuard 운영 Terraform

이 디렉터리는 FoodiGuard GCP 인프라의 단일 Terraform 루트입니다.
이전 `example-gcp-project` 프로젝트 삭제 후 2026-10-02부터 새 `foodigard` 프로젝트에
재구축합니다. 프로젝트마다 독립된 GCS backend와 state를 사용합니다.
과거 import 목록 `imports.example-gcp-project.tf.disabled`는 기록용이며 Terraform이 읽지 않습니다.

## 관리 범위

| 소유자 | 리소스 |
| --- | --- |
| Terraform | GKE Autopilot, Cloud SQL PostgreSQL 인스턴스와 앱 DB, Artifact Registry |
| Terraform | Jenkins VM·고정 IP·IAP 전용 방화벽·서비스 계정·IAM, 필수 GCP API |
| Terraform | GKE 전용 노드 서비스 계정과 저장소 이미지 읽기 권한 |
| Terraform | 두 대시보드, 10개 경보 정책, `admin@example.com` 알림 채널 |
| Terraform | `${project_id}-foodiguard-tfstate` GCS state 버킷 |
| Jenkins + YAML | API·웹 Deployment/Service, HPA/PDB, CronJob, PodMonitoring, KSA |
| 별도 보안 설정 | Cloud SQL 사용자 비밀번호, GKE Secret, Jenkins Credentials |

기본 VPC와 서브넷은 data source로 참조합니다. GKE가 만드는 노드·방화벽·Pod IP·웹
LoadBalancer는 GKE가 관리합니다. Cloud SQL `postgres` 사용자의 비밀번호는
Terraform/state/Git에 넣지 않습니다. 다른 앱의 리소스는 관리하지 않습니다.

## 새 프로젝트 초기화

1. 새 계정으로 로그인하고 프로젝트 ID·번호·결제 연결·기존 리소스를 확인합니다.
2. 필요한 API를 활성화하고 서울 리전의 기본 VPC와 할당량을 확인합니다.
3. `PROJECT_ID-foodiguard-tfstate` 버킷을 만들고 버전 관리, 공개 접근 차단,
   균일한 IAM 접근, 7일 soft delete를 설정합니다.
4. `terraform.tfvars.example`과 `backend.hcl.example`을 각각 복사해 실제 프로젝트
   값을 넣습니다. 두 로컬 설정 파일은 Git에서 제외합니다.
5. backend를 초기화하고 방금 만든 버킷을 Terraform에 import합니다.

```bash
cd infra/gcp/terraform
gcloud auth application-default login
terraform init -backend-config=backend.hcl
terraform import google_storage_bucket.terraform_state foodigard-foodiguard-tfstate
terraform validate
terraform state list
terraform plan -out=tfplan
terraform apply tfplan
```

기존 backend가 있는 프로젝트에서는 같은 state를 이어서 사용합니다. 새 프로젝트에는
이전 프로젝트의 state나 import ID를 적용하지 않습니다. 인증은 ADC 또는 환경변수로
전달한 단기 토큰을 사용하며 backend 파일에 인증 값을 넣지 않습니다. state와 계획
파일도 Git에 올리지 않습니다.

최초 구축에서는 검토한 생성이 예상된 변경입니다. 다른 프로젝트 ID, 예상하지 않은
삭제·교체가 있으면 적용하지 않습니다. GKE와 Cloud SQL에는 삭제 방지가 설정돼 있습니다.

## DB·앱·Jenkins 복구

Terraform은 인프라만 만들며 DB 식품 데이터와 Kubernetes Secret은 복원하지 않습니다.
로컬 DB 백업을 별도로 복원하고 최신 `backend`의 `npm run db:migrate`를 실행합니다.
`foodiguard-db-secret`에는 `DB_NAME`, `DB_USER`, `DB_PASSWORD`,
`foodiguard-auth-secret`에는 `AUTH_TOKEN_SECRET`을 별도로 설정합니다.
새 인증 키를 쓰면 기존 세션은 다시 로그인해야 합니다.

Jenkins를 새로 설치하므로 관리자·플러그인·SCM Job도 다시 구성해야 합니다.
`main` 파이프라인은 이미지 빌드·테스트·push, DB 마이그레이션, GKE 배포를 수행합니다.
루트와 `infra/gcp`의 Jenkinsfile/YAML을 함께 유지합니다.

최초 구축은 `create_application_alerts=false`, `alerts_enabled=false`로 실행합니다.
새 프로젝트는 아직 수집되지 않은 앱 지표를 참조하는 PromQL 경보 생성을 거부합니다.
DB 복원·API/Web 정상 응답·Prometheus 수집을 확인한 뒤
`create_application_alerts=true`로 나머지 경보를 생성하고 `alerts_enabled=true`로 켭니다.
과거 팀원 채널은 기본적으로 만들지 않으며 경보는
`admin@example.com`만 받습니다.

```bash
gcloud compute start-iap-tunnel jenkins-vm 8080 --local-host-port=127.0.0.1:18082 --zone=asia-northeast3-a --project=foodigard
```

웹 외부 IP는 새로 할당됩니다. 시뮬레이터는 새 클러스터의 port-forward를 사용하거나
`EXPO_PUBLIC_API_BASE_URL`을 새 주소로 바꿉니다. 이전 운영 증거의 성능 수치는
새 프로젝트에서 재측정하기 전까지 과거 결과입니다.

### 2026-10-02 복구 도구

`infra/gcp/scripts/recover-new-project.mjs`는 이번 `foodigard` 복구 전용입니다.
`sql-password`는 무작위 DB 비밀번호와 인증 키를 만들고, `k8s-secrets`는 새 클러스터에
없는 Secret만 생성합니다. `restore /절대/백업/경로`는 빈 public 스키마에서만
복원하며, `verify`는 백업의 7개 식품 테이블 건수를 확인합니다.
`migrate`는 로컬 Cloud SQL Proxy의 15433 포트로 최신 마이그레이션을 실행합니다.
자격 증명은 저장소의 `.foodiguard-recovery/`에 권한 0600으로 보관하며 Git에서 제외합니다.
이 파일과 식품 백업은 별도로 안전하게 보관해야 합니다. 내용을 채팅에 붙여 넣지 않습니다.

`recover-jenkins.mjs`는 새 Jenkins를 IAP 18082 터널로 설정하는 이번 복구 전용 도구입니다.
초기 비밀번호를 출력하지 않고 플러그인·새 관리자·main SCM Job을 구성합니다.
`deploy-key`는 Jenkins VM의 전용 SSH 키를 GitHub 저장소의 읽기 전용 deploy key로
등록하고 Jenkins Credentials에 연결합니다. GitHub 공식 API의 SSH 호스트 키로
서버를 검증하며 개인 키는 Git에 저장하지 않습니다. 이 작업에는 해당 저장소의
관리 권한이 필요합니다. 다른 로컬 포트를 쓰면 `JENKINS_RECOVERY_URL`로 지정합니다.
GKE 최초 노드 정리 중 `CPUS_ALL_REGIONS` 할당량 오류가 일시적으로 발생할 수 있습니다.
리전별 CPU 할당량뿐 아니라 `gcloud compute project-info describe`의 글로벌 CPU도 확인합니다.
할당량 오류가 지속되면 결제 계정 업그레이드나 구조 변경을 임의로 하지 않습니다.

### 현재 검증 결과와 남은 제한

- 새 웹 주소: `http://<EXTERNAL_IP>`. 웹, health, readiness, 식품 목록·검색 API와
  로컬 시뮬레이터 터널의 HTTP 200을 확인했습니다.
- 식품 79,041건, 원재료 901,315건 등 백업의 주요 7개 테이블 건수가 일치했습니다.
  사용자 데이터는 백업에 없으며 복원 직후 0건입니다. 백업 기준 시점은 2026-09-10입니다.
- 최신 DB 마이그레이션과 최초 알레르기 재계산이 완료됐습니다.
- API 2개, HPA min=2/max=4, 원재료 매칭·재계산 성공 시각의 실제 Prometheus 수집,
  대시보드 2개·활성 경보 10개를 확인했습니다.
- 회귀 테스트: Linux 배포 이미지에서 백엔드 98/98·모바일 41/41,
  인프라 19/19. Terraform 최종 plan은 변경 없음입니다.
- 사용자가 정식 결제로 전환한 후 글로벌 CPU 할당량 12→32,
  서울 리전 SSD 할당량 250→500GB 증설이 승인됐습니다. 할당량은 사용 가능
  상한이며 해당 수량을 모두 할당한 것은 아닙니다. 새 프로젝트에서 다시 확인합니다.
- 웹 2개가 서로 다른 노드에서 Running/Ready입니다. API도 2개가 정상 실행
  중이지만 자동 확장 최대 4개와 장애·부하 실험은 이번 복구에서 검증하지 않았습니다.
- Jenkins 첫 빌드는 비공개 저장소 인증 부재로 실패했습니다. 저장소 전용 읽기
  키를 연결한 뒤 `foodiguard-main` #2가 **SUCCESS**로 완료됐습니다(6분 40초).
  `main` 커밋 `71803b2`로 이미지 빌드, 인프라 19/19·백엔드 98/98·모바일 41/41
  테스트, Artifact Registry push, DB 마이그레이션, API·웹 롤링 배포를 확인했습니다.
  이미지 태그는 `2`이며 `*/main`과 `H/5 * * * *` SCM 감시를 사용합니다.
  배포 후 웹·health·readiness·목록·검색 API가 모두 HTTP 200입니다.
- 기존 의존성의 npm audit 경고는 별도 보안 점검 대상입니다. 이번 작업에서는
  복구와 무관한 패키지의 강제 업그레이드나 새 장애·부하 실험을 하지 않았습니다.
  도메인·HTTPS, AI 코치 실제 호출과 모바일 회원가입 전체 흐름은 이번 검증에 포함하지 않았습니다.
