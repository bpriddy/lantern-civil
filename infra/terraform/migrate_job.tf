# PRD 2 requires real migrations from the first commit. Running them as a Cloud Run
# job built from the SAME image as the service is what keeps the schema and the code
# that expects it on the same version — a job running older SQL than the deploy that
# follows it is the failure this prevents.
#
# The job runs before the service updates. That ordering is only safe for additive
# migrations, which is a discipline, not something Terraform can enforce.
resource "google_cloud_run_v2_job" "migrate" {
  name     = "${var.service_name}-migrate"
  location = var.region

  deletion_protection = false

  template {
    template {
      service_account = google_service_account.api.email
      max_retries     = 0
      timeout         = "600s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.civil.connection_name]
        }
      }

      containers {
        image = var.image
        # The binary directly, not through npx. npx will happily try to FETCH a
        # missing package and then block on its install prompt, which in a
        # non-interactive job looks exactly like a hung migration rather than a
        # missing dependency. This path either exists or the container exits.
        command = ["node_modules/.bin/node-pg-migrate"]
        args = [
          "--migrations-dir", "apps/api/migrations",
          "--migrations-table", "schema_migrations",
          "up",
        ]

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
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
      }
    }
  }

  lifecycle {
    # scripts/deploy.sh sets the image immediately before executing the job.
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.api_database_url,
  ]
}
