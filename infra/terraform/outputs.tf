output "service_url" {
  description = "The IAP-protected URL. Opening this triggers the Google login flow."
  value       = google_cloud_run_v2_service.civil.uri
}

output "iap_audience" {
  description = "Expected `aud` claim on the IAP assertion. Must match CIVIL_IAP_AUDIENCE."
  value       = "/projects/${data.google_project.this.number}/locations/${var.region}/services/${var.service_name}"
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
