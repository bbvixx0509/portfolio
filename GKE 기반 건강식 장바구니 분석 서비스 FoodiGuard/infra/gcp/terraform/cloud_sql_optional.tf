resource "google_sql_database_instance" "postgres" {
  count            = var.create_cloud_sql ? 1 : 0
  name             = var.cloud_sql_instance_name
  database_version = var.cloud_sql_database_version
  region           = var.region

  settings {
    user_labels       = merge(var.resource_labels, { component = "database" })
    edition           = var.cloud_sql_edition
    tier              = var.cloud_sql_tier
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.cloud_sql_disk_size_gb
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      start_time                     = "19:00"
      point_in_time_recovery_enabled = false
    }

    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }
  }

  deletion_protection = true
}

# The application database is a separate Cloud SQL object. The postgres user and
# its password are deliberately not managed: importing users can put credentials
# into Terraform state. PostgreSQL does not support an update operation for this
# resource; preserve the imported deletion policy and use prevent_destroy.
resource "google_sql_database" "foodiguard" {
  count    = var.create_cloud_sql ? 1 : 0
  name     = "foodiguard"
  instance = google_sql_database_instance.postgres[0].name
  project  = var.project_id

  deletion_policy = "ABANDON"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [deletion_policy]
  }
}
