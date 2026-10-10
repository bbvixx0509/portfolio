# Bootstrap this project's bucket before terraform init, then import it into
# the same backend. Never connect a new project to another project's state.
resource "google_storage_bucket" "terraform_state" {
  name                        = "${var.project_id}-foodiguard-tfstate"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  lifecycle {
    prevent_destroy = true
  }
}
