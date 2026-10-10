data "google_compute_network" "default" {
  name = var.network_name
}

data "google_compute_subnetwork" "default" {
  name   = var.subnetwork_name
  region = var.region
}

resource "google_compute_firewall" "allow_jenkins_8080" {
  count         = var.create_jenkins ? 1 : 0
  name          = var.jenkins_firewall_rule_name
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  priority      = 900
  target_tags   = [var.jenkins_network_tag]
  source_ranges = var.jenkins_allowed_source_ranges
  description   = "Allow Jenkins SSH and web UI only through Google Cloud IAP"

  allow {
    protocol = "tcp"
    ports    = ["22", "8080"]
  }
}

resource "google_compute_firewall" "deny_jenkins_admin_from_internet" {
  count         = var.create_jenkins ? 1 : 0
  name          = "deny-jenkins-admin-from-internet"
  network       = data.google_compute_network.default.name
  direction     = "INGRESS"
  priority      = 1000
  target_tags   = [var.jenkins_network_tag]
  source_ranges = ["0.0.0.0/0"]
  description   = "Block direct internet access to Jenkins SSH and port 8080"

  deny {
    protocol = "tcp"
    ports    = ["22", "8080"]
  }
}
