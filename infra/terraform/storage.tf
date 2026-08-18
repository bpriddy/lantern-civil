# PRD 12: GCS holds large event payloads and cached node results. Postgres holds the
# metadata that points at them. Nothing here is truth — PRD 12 is explicit that repo
# contents are never stored as truth and any cache must be reconstructible.
resource "google_storage_bucket" "payloads" {
  name     = "${var.project_id}-payloads"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = false
  }

  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_artifact_registry_repository" "civil" {
  location      = var.region
  repository_id = "civil"
  format        = "DOCKER"
  description   = "Civil API container images."

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }
}
