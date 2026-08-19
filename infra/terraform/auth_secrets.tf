# PRD 2: secrets in env and Secret Manager, never in the repo.
#
# The Google OAuth client is created by hand in the console and its values written
# here by the owner. Terraform creates the containers and the access grants but never
# the versions, so the client secret is never in a plan, a state file, or a terminal
# transcript. See docs/deploy.md.

resource "google_secret_manager_secret" "google_client_id" {
  secret_id = "civil-google-client-id"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "google_client_secret" {
  secret_id = "civil-google-client-secret"
  replication {
    auto {}
  }
}

# This one has no human origin, so Terraform generates it. Rotating it invalidates
# every existing login, which is the intended emergency lever.
resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "google_secret_manager_secret" "session_secret" {
  secret_id = "civil-session-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "session_secret" {
  secret      = google_secret_manager_secret.session_secret.id
  secret_data = random_password.session_secret.result
}

# PRD 12: a GitHub App, not PATs — short-lived installation tokens minted
# server-side and never sent to the browser. This key is what signs the JWT that
# mints them, so it is the most sensitive value Civil holds.
resource "google_secret_manager_secret" "github_app_key" {
  secret_id = "civil-github-app-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "github_app_id" {
  secret_id = "civil-github-app-id"
  replication {
    auto {}
  }
}

locals {
  api_secrets = {
    database_url         = google_secret_manager_secret.database_url.id
    google_client_id     = google_secret_manager_secret.google_client_id.id
    google_client_secret = google_secret_manager_secret.google_client_secret.id
    session_secret       = google_secret_manager_secret.session_secret.id
    github_app_key       = google_secret_manager_secret.github_app_key.id
    github_app_id        = google_secret_manager_secret.github_app_id.id
  }
}

resource "google_secret_manager_secret_iam_member" "api" {
  for_each = local.api_secrets

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.api.member
}
