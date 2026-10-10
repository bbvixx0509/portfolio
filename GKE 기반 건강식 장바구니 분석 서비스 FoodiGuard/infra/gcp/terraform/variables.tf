variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "project_number" {
  description = "GCP project number."
  type        = string
}

variable "region" {
  description = "Primary GCP region."
  type        = string
  default     = "asia-northeast3"
}

variable "zone" {
  description = "Primary GCP zone."
  type        = string
  default     = "asia-northeast3-a"
}

variable "network_name" {
  description = "VPC network name."
  type        = string
  default     = "default"
}

variable "subnetwork_name" {
  description = "Subnetwork name."
  type        = string
  default     = "default"
}

variable "artifact_registry_repository" {
  description = "Artifact Registry Docker repository ID."
  type        = string
  default     = "foodiguard-api"
}

variable "gke_cluster_name" {
  description = "GKE cluster name."
  type        = string
  default     = "foodiguard-cluster"
}

variable "jenkins_instance_name" {
  description = "Jenkins Compute Engine instance name."
  type        = string
  default     = "jenkins-vm"
}

variable "jenkins_machine_type" {
  description = "Jenkins VM machine type."
  type        = string
  default     = "e2-medium"
}

variable "jenkins_boot_image" {
  description = "Jenkins VM boot image."
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "jenkins_boot_disk_size_gb" {
  description = "Jenkins VM boot disk size."
  type        = number
  default     = 50
}

variable "jenkins_boot_disk_type" {
  description = "Jenkins VM boot disk type."
  type        = string
  default     = "pd-balanced"
}

variable "jenkins_static_ip_name" {
  description = "Reserved external IP name for Jenkins."
  type        = string
  default     = "jenkins-static-ip"
}

variable "jenkins_firewall_rule_name" {
  description = "Firewall rule name for Jenkins web UI."
  type        = string
  default     = "allow-jenkins-8080"
}

variable "jenkins_network_tag" {
  description = "Network tag attached to Jenkins VM."
  type        = string
  default     = "jenkins"
}

variable "jenkins_allowed_source_ranges" {
  description = "Allowed IAP source ranges for Jenkins SSH and web UI access."
  type        = list(string)
  default     = ["35.235.240.0/20"]
}

variable "jenkins_service_account_id" {
  description = "Dedicated service account ID used by the Jenkins VM."
  type        = string
  default     = "foodiguard-jenkins"
}

variable "jenkins_admin_user_email" {
  description = "Google account allowed to open IAP tunnels and administer the Jenkins VM."
  type        = string
}

variable "jenkins_project_roles" {
  description = "Project IAM roles required by Jenkins CI/CD."
  type        = list(string)
  default = [
    "roles/container.admin",
    "roles/artifactregistry.writer",
    "roles/cloudsql.client",
  ]
}

variable "create_cloud_sql" {
  description = "Whether Terraform manages the FoodiGuard Cloud SQL instance and app database. Import only when adopting an existing instance."
  type        = bool
  default     = false
}

variable "cloud_sql_instance_name" {
  description = "Optional Cloud SQL instance name."
  type        = string
  default     = "foodiguard-db"
}

variable "cloud_sql_database_version" {
  description = "Optional Cloud SQL PostgreSQL version."
  type        = string
  default     = "POSTGRES_17"
}

variable "cloud_sql_edition" {
  description = "Cloud SQL edition. ENTERPRISE_PLUS only accepts db-perf-optimized-N-* tiers."
  type        = string
  default     = "ENTERPRISE"
}

variable "cloud_sql_tier" {
  description = "Optional Cloud SQL machine tier."
  type        = string
  default     = "db-custom-1-3840"
}

variable "cloud_sql_disk_size_gb" {
  description = "Optional Cloud SQL disk size."
  type        = number
  default     = 20
}

variable "create_jenkins" {
  description = "Whether Terraform should create the Jenkins VM, its static IP, its firewall rule, and its IAM bindings."
  type        = bool
  default     = false
}

variable "api_service_account_id" {
  description = "Service account used by the API pods through Workload Identity."
  type        = string
  default     = "foodiguard-api-sa"
}

variable "api_service_account_roles" {
  description = "Project IAM roles required by the API pods."
  type        = list(string)
  default = [
    "roles/cloudsql.client",
    "roles/aiplatform.user",
  ]
}

variable "api_kubernetes_namespace" {
  description = "Namespace holding the API Kubernetes service account."
  type        = string
  default     = "default"
}

variable "api_kubernetes_service_account" {
  description = "Kubernetes service account bound to the API service account."
  type        = string
  default     = "foodiguard-api-ksa"
}

variable "resource_labels" {
  description = "Cost allocation labels applied to every billable resource."
  type        = map(string)
  default = {
    app = "foodiguard"
    env = "capstone"
  }
}

variable "create_application_alerts" {
  description = "Create application-metric alert policies only after the new project has ingested Prometheus metrics."
  type        = bool
  default     = false
}

variable "alerts_enabled" {
  description = "Enable alerts only after DB restore, app health and Prometheus collection have been verified."
  type        = bool
  default     = false
}

variable "create_legacy_team_channel" {
  description = "Keep the historical team notification channel only when explicitly required. It is not attached to alerts."
  type        = bool
  default     = false
}
