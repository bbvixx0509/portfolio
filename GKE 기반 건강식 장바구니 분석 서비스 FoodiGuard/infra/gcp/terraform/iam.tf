locals {
  jenkins_service_account_member = var.create_jenkins ? "serviceAccount:${google_service_account.jenkins[0].email}" : null
  jenkins_admin_user_member      = "user:${var.jenkins_admin_user_email}"
}

resource "google_service_account" "jenkins" {
  count = var.create_jenkins ? 1 : 0

  account_id   = var.jenkins_service_account_id
  display_name = "FoodiGuard Jenkins deployer"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_project_iam_member" "jenkins_roles" {
  for_each = var.create_jenkins ? toset(var.jenkins_project_roles) : toset([])

  project = var.project_id
  role    = each.value
  member  = local.jenkins_service_account_member
}

resource "google_project_iam_member" "jenkins_admin_iap" {
  count = var.create_jenkins ? 1 : 0

  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = local.jenkins_admin_user_member
}
