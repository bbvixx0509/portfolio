resource "google_compute_address" "jenkins_static_ip" {
  count        = var.create_jenkins ? 1 : 0
  name         = var.jenkins_static_ip_name
  region       = var.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  description  = "Static external IP for Jenkins webhook"

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_compute_instance" "jenkins" {
  count                     = var.create_jenkins ? 1 : 0
  name                      = var.jenkins_instance_name
  zone                      = var.zone
  machine_type              = var.jenkins_machine_type
  tags                      = [var.jenkins_network_tag]
  labels                    = merge(var.resource_labels, { component = "ci" })
  deletion_protection       = false
  allow_stopping_for_update = true

  metadata_startup_script = templatefile("${path.module}/scripts/jenkins-startup.sh.tftpl", {
    project_id = var.project_id
    region     = var.region
  })

  boot_disk {
    initialize_params {
      image = var.jenkins_boot_image
      size  = var.jenkins_boot_disk_size_gb
      type  = var.jenkins_boot_disk_type
    }
  }

  network_interface {
    network    = data.google_compute_network.default.self_link
    subnetwork = data.google_compute_subnetwork.default.self_link

    access_config {
      nat_ip       = google_compute_address.jenkins_static_ip[0].address
      network_tier = "PREMIUM"
    }
  }

  service_account {
    email  = google_service_account.jenkins[0].email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = false
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    prevent_destroy = true

    ignore_changes = [
      boot_disk,
      confidential_instance_config,
      enable_display,
      key_revocation_action_type,
      network_interface,
      labels,
      metadata_startup_script,
      reservation_affinity,
      resource_policies,
      scheduling,
      tags,
    ]
  }
}
