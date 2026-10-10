resource "google_artifact_registry_repository" "docker_repo" {
  location      = var.region
  repository_id = var.artifact_registry_repository
  format        = "DOCKER"
  labels        = merge(var.resource_labels, { component = "registry" })

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      cleanup_policy_dry_run,
      docker_config,
      labels,
    ]
  }
}
