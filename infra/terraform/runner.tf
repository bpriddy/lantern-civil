# The Civil runner: the service that executes project code and holds no platform
# credentials (PRD 12). Its identity can write logs and read exactly one secret —
# the platform's model key, the single documented exception — and nothing else:
# no SQL role, no bucket, no GitHub key. The blast radius of hostile project code
# is "spend model budget", by construction.

resource "google_service_account" "runner" {
  account_id   = "civil-runner"
  display_name = "Civil Runner"
  description  = "Executes project code. Holds model access and nothing else."
}

resource "google_project_iam_member" "runner_log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = google_service_account.runner.member
}

# The key arrives by the owner's hand, never through tooling:
#   printf 'sk-ant-…' | gcloud secrets versions add civil-anthropic-key --data-file=-
resource "google_secret_manager_secret" "anthropic_key" {
  secret_id = "civil-anthropic-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "runner_anthropic_key" {
  secret_id = google_secret_manager_secret.anthropic_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runner.member
}

resource "google_cloud_run_v2_service" "runner" {
  provider = google-beta

  name     = "${var.service_name}-runner"
  location = var.region

  # No allUsers invoker (below, only the API's identity may call), so the platform
  # refuses strangers before the service hears from them. A run is a long request —
  # execution happens inside it, which is what keeps CPU allocated without paying
  # for always-on.
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.runner.email

    timeout = "3600s"

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    # Runs are heavier than requests; a handful per instance is plenty.
    max_instance_request_concurrency = 4

    containers {
      image = var.runner_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.anthropic_key.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 3
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
    # scripts/deploy.sh owns the image after the first apply.
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runner_anthropic_key,
  ]
}

locals {
  # The service's own URI, not a computed guess: the runner landed on the legacy
  # hostname format, and a wrong address here fails as runs that never start. No
  # cycle — the runner references nothing that references it.
  runner_url = google_cloud_run_v2_service.runner.uri
}

# The API is the runner's only caller. It authenticates with an ID token minted
# from its own service account; Cloud Run's IAM checks it before the runner ever
# sees the request.
resource "google_cloud_run_v2_service_iam_member" "runner_invoker" {
  name     = google_cloud_run_v2_service.runner.name
  location = google_cloud_run_v2_service.runner.location
  role     = "roles/run.invoker"
  member   = google_service_account.api.member
}
