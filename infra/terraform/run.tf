resource "google_service_account" "api" {
  account_id   = "civil-api"
  display_name = "Civil API"
  description  = "Runtime identity for the Civil Cloud Run service."
}

# Least privilege: exactly what the API needs and nothing else. Notably absent is any
# project-level storage or SQL admin role.
resource "google_project_iam_member" "api_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = google_service_account.api.member
}

resource "google_project_iam_member" "api_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.api.member
}

resource "google_storage_bucket_iam_member" "api_payloads" {
  bucket = google_storage_bucket.payloads.name
  role   = "roles/storage.objectAdmin"
  member = google_service_account.api.member
}

resource "google_cloud_run_v2_service" "civil" {
  provider = google-beta

  name     = var.service_name
  location = var.region

  # Public, because the application authenticates for itself now. IAP was removed at
  # the owner's direction: it cannot admit users outside a Workspace organisation,
  # and this project has none, so sharing the application was impossible with it.
  # Every unauthenticated request is refused by the onRequest hook in http/server.ts.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.api.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 3
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.civil.connection_name]
      }
    }

    containers {
      image = var.image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # Throttled between requests. Keeps a warm instance affordable, but see the
        # note on var.min_instances: M4's long-running jobs will need this false.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "LOG_LEVEL"
        value = "info"
      }

      # The origin Google was told to redirect back to. Computed rather than taken
      # from the service's own uri attribute, which would be a dependency cycle, and
      # rather than hand-copied, because a mismatch here fails closed and looks
      # exactly like a broken login.
      env {
        name  = "CIVIL_PUBLIC_URL"
        value = local.public_url
      }

      env {
        name  = "CIVIL_PAYLOAD_BUCKET"
        value = google_storage_bucket.payloads.name
      }

      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_CLIENT_ID"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_client_id.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "GOOGLE_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.google_client_secret.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "SESSION_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.session_secret.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 10
      }

      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 30
        failure_threshold = 3
      }
    }
  }

  lifecycle {
    # scripts/deploy.sh owns the image after the first apply. Without this, every
    # terraform apply would roll the service back to the placeholder.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.api,
  ]
}

locals {
  # Cloud Run's deterministic hostname. Using the service's own uri attribute here
  # would be a cycle, since the env var is part of the service definition.
  public_url = "https://${var.service_name}-${data.google_project.this.number}.${var.region}.run.app"
}

# The application does its own authentication, so Cloud Run must let requests through
# to it. Without this, every visitor gets a 403 from the platform before the sign-in
# page can render.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.civil.name
  location = google_cloud_run_v2_service.civil.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
