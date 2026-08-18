terraform {
  required_version = ">= 1.9"

  # State lives in GCS, not on a laptop. PRD 2's definition of shippable is that
  # someone else could deploy from a clean checkout, and local state fails that.
  # The bucket is created out-of-band because it must exist before this block runs.
  backend "gcs" {
    bucket = "lantern-civil-tfstate"
    prefix = "civil"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

data "google_project" "this" {}
