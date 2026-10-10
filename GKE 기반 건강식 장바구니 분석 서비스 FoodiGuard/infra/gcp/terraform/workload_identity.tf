# 백엔드 파드가 쓰는 서비스 계정. Cloud SQL Proxy 사이드카가 Cloud SQL 에 붙을 때와
# 백엔드가 Vertex AI 를 호출할 때 이 계정의 권한을 쓴다. k8s/backend-service-account.yaml
# 의 KSA 가 Workload Identity 로 이 계정을 대신한다.
resource "google_service_account" "foodiguard_api" {
  account_id   = var.api_service_account_id
  display_name = "FoodiGuard API workload identity"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_iam_member" "foodiguard_api_roles" {
  for_each = toset(var.api_service_account_roles)

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.foodiguard_api.email}"
}

resource "google_service_account_iam_member" "foodiguard_api_workload_identity" {
  service_account_id = google_service_account.foodiguard_api.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[${var.api_kubernetes_namespace}/${var.api_kubernetes_service_account}]"

  # Identity Pool 은 클러스터가 만들어질 때 생긴다.
  depends_on = [google_container_cluster.foodiguard]
}
