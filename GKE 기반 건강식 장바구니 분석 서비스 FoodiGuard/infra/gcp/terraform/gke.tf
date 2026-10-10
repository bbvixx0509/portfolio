resource "google_container_cluster" "foodiguard" {
  name             = var.gke_cluster_name
  location         = var.region
  enable_autopilot = true
  network          = data.google_compute_network.default.self_link
  subnetwork       = data.google_compute_subnetwork.default.self_link

  cluster_autoscaling {
    auto_provisioning_defaults {
      service_account = google_service_account.gke_nodes.email
      oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    }
  }

  release_channel {
    channel = "REGULAR"
  }

  resource_labels = merge(var.resource_labels, { component = "runtime" })

  deletion_protection = true

  depends_on = [
    google_project_service.required,
    google_project_iam_member.gke_nodes,
    google_artifact_registry_repository_iam_member.gke_pull,
  ]

  lifecycle {
    ignore_changes = [
      addons_config,
      cluster_autoscaling,
      in_transit_encryption_config,
      ip_allocation_policy,
      logging_config,
      maintenance_policy,
      monitoring_config,
      node_config,
      node_pool,
      resource_labels,
    ]
  }
}

resource "google_service_account" "gke_nodes" {
  account_id   = "foodiguard-gke-nodes"
  display_name = "FoodiGuard GKE node runtime"
}

resource "google_project_iam_member" "gke_nodes" {
  project = var.project_id
  role    = "roles/container.defaultNodeServiceAccount"
  member  = "serviceAccount:${google_service_account.gke_nodes.email}"
}

resource "google_artifact_registry_repository_iam_member" "gke_pull" {
  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.docker_repo.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.gke_nodes.email}"
}
