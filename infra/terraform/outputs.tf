output "service_url" {
  description = "Public URL. Sign-in happens in the application, not in front of it."
  value       = local.public_url
}

output "oauth_redirect_uri" {
  description = "Authorised redirect URI to register on the Google OAuth client. Must match exactly."
  value       = "${local.public_url}/auth/google/callback"
}

output "oauth_javascript_origin" {
  description = "Authorised JavaScript origin to register on the Google OAuth client."
  value       = local.public_url
}

output "sql_connection_name" {
  description = "Cloud SQL connection name, for the auth proxy when running migrations."
  value       = google_sql_database_instance.civil.connection_name
}

output "image_repository" {
  description = "Artifact Registry path that scripts/deploy.sh pushes to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.civil.repository_id}"
}

output "payload_bucket" {
  description = "GCS bucket for large event payloads and cached node results."
  value       = google_storage_bucket.payloads.name
}

output "project_id" {
  description = "Read by scripts/deploy.sh so the deploy target comes from state, never a flag."
  value       = var.project_id
}

output "region" {
  value = var.region
}

output "service_name" {
  value = google_cloud_run_v2_service.civil.name
}

output "migrate_job_name" {
  description = "Cloud Run job that applies migrations from the same image as the service."
  value       = google_cloud_run_v2_job.migrate.name
}
