# FoodiGuard GCP 배포 코드

이 폴더는 실제 GCP 배포에 사용한 Jenkins, GKE, Terraform 설정을 모아둔 경로입니다.
전체 프론트엔드/백엔드 소스는 저장소 루트와 `backend/`에 있으며, Jenkins는 해당 소스를 Docker 이미지로 빌드해 Artifact Registry에 업로드하고 GKE에 배포합니다.

2026-10-02: 삭제된 이전 프로젝트 대신 `foodigard`(서울 리전)에 재구축했습니다.
새 프로젝트 초기화·별도 state·DB 백업·Secret·Jenkins 복구 순서는
[Terraform 운영 안내](terraform/README.md)를 따릅니다. 모바일 터널도 새 프로젝트를 기본으로 사용합니다.

## 구성

- `Jenkinsfile`: 이미지 빌드·push, DB 마이그레이션 Job 검증, GKE 배포 파이프라인
- `k8s/deployment.yaml`: `foodiguard-web` 프론트엔드 Deployment
- `k8s/service.yaml`: `foodiguard-web` LoadBalancer Service
- `k8s/backend-deployment.yaml`: `foodiguard-api` Express Backend + Cloud SQL Proxy 사이드카 Deployment
- `k8s/backend-service.yaml`: 클러스터 내부용 Backend Service
- `k8s/backend-service-account.yaml`: Workload Identity용 Kubernetes ServiceAccount
- `k8s/migration-job.yaml`: 새 백엔드 이미지로 스키마를 갱신하는 일회성 Job
- `terraform/`: Artifact Registry, Jenkins VM, GKE, IAM, 선택형 Cloud SQL 인프라 코드

## 배포 순서

1. Jenkins가 프론트엔드와 백엔드 이미지를 빌드해 Artifact Registry에 push합니다.
2. 백엔드 이미지로 `foodiguard-db-migrate` Job을 실행합니다.
3. Job이 성공해야 API와 웹 Deployment를 롤링 업데이트합니다.
4. API는 `/api/health/live`로 프로세스를, `/api/health/ready`로 DB와 필수 스키마를 확인합니다.

마이그레이션 또는 DB 준비 확인이 실패하면 새 Deployment를 적용하지 않습니다. API 컨테이너 시작 시
마이그레이션과 데모 데이터 적재를 수행하지 않으므로 재시작과 스케일아웃이 데이터 변경을 유발하지 않습니다.

## 주의

실제 비밀번호와 API 키는 Git에 저장하지 않습니다. `foodiguard-db-secret` 같은 Secret은 GKE에 별도로 생성해야 합니다.
기존 리소스를 관리할 때만 import합니다. 새 프로젝트에는 과거 프로젝트의 import 목록이나
state를 적용하지 않습니다. `terraform plan`에서 프로젝트 ID와 생성·변경·삭제 범위를 확인합니다.
