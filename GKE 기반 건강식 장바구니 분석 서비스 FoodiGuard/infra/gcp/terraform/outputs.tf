output "artifact_registry_repository" {
  value = google_artifact_registry_repository.docker_repo.name
}

output "gke_cluster_name" {
  value = google_container_cluster.foodiguard.name
}

output "api_service_account_email" {
  value = google_service_account.foodiguard_api.email
}

output "cloud_sql_connection_name" {
  value = var.create_cloud_sql ? google_sql_database_instance.postgres[0].connection_name : null
}

output "jenkins_static_ip" {
  value = var.create_jenkins ? google_compute_address.jenkins_static_ip[0].address : null
}

output "jenkins_url" {
  value       = var.create_jenkins ? "http://127.0.0.1:18080" : null
  description = "Jenkins URL after opening the IAP tunnel. Port 8080 is not public."
}

output "jenkins_iap_tunnel_command" {
  value       = var.create_jenkins ? "gcloud compute start-iap-tunnel ${var.jenkins_instance_name} 8080 --local-host-port=127.0.0.1:18080 --zone=${var.zone} --project=${var.project_id}" : null
  description = "Open this tunnel before visiting the Jenkins URL."
}

output "jenkins_initial_password_command" {
  value       = var.create_jenkins ? "gcloud compute ssh ${var.jenkins_instance_name} --tunnel-through-iap --zone=${var.zone} --project=${var.project_id} --command='sudo cat /var/lib/jenkins/secrets/initialAdminPassword'" : null
  description = "Read the one-time Jenkins setup password through IAP SSH."
}
