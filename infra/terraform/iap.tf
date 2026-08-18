# The IAP service agent must be able to invoke the service it fronts. Without this,
# IAP authenticates the user and then gets a 403 from Cloud Run, which surfaces as a
# confusing error well after the login succeeds.
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  provider = google-beta

  name     = google_cloud_run_v2_service.civil.name
  location = google_cloud_run_v2_service.civil.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# PRD 12: "your email allowlisted... Adding a person is an allowlist edit."
# This is that allowlist.
resource "google_iap_web_cloud_run_service_iam_member" "owner" {
  provider = google-beta

  project                = var.project_id
  location               = var.region
  cloud_run_service_name = google_cloud_run_v2_service.civil.name
  role                   = "roles/iap.httpsResourceAccessor"
  member                 = "user:${var.owner_email}"
}
