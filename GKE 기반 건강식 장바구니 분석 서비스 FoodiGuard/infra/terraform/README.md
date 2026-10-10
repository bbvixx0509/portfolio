# Terraform 경로 이전 안내

운영 FoodiGuard Terraform의 단일 루트는 [`../gcp/terraform`](../gcp/terraform)입니다.
이 디렉터리의 예전 중복 구성은 2026-09-19에 제거했습니다. 이 경로에서
`terraform init`, `plan`, `apply`를 실행하지 마세요. 기존 GCS state와 import
안내는 [`../gcp/terraform/README.md`](../gcp/terraform/README.md)에 있습니다.
