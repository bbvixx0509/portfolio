terraform {
  required_version = ">= 1.5.0"

  backend "gcs" {
    prefix = "production/terraform"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.30, < 7.0"
    }
  }
}
