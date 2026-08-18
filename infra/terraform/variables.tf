variable "project_id" {
  description = "GCP project id."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, and the payload bucket."
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name. Part of the IAP JWT audience, so changing it invalidates assertions until the new audience is deployed."
  type        = string
  default     = "civil"
}

variable "owner_email" {
  description = "The single account allowed through IAP. PRD 2: one user, one owner. Adding a person is an edit here."
  type        = string
}

variable "db_tier" {
  description = "Cloud SQL machine type."
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Guards against destroying the database. Flip to false deliberately when tearing down."
  type        = bool
  default     = true
}

variable "min_instances" {
  description = <<-EOT
    PRD 12 wants long runs decoupled from the request, which needs an instance that
    outlives it. Note this alone is not sufficient: with cpu_idle = true the instance
    stays warm but its CPU is throttled between requests, so background execution
    does not progress. M4 will need cpu_idle = false, which is a materially larger
    bill — always-allocated vCPU is billed at roughly ten times the idle rate.
  EOT
  type        = number
  default     = 1
}

variable "image" {
  description = <<-EOT
    Container image. Defaults to Google's hello container so the very first apply can
    create the service before any image exists. Subsequent images are pushed by
    scripts/deploy.sh, and the service ignores changes to this field so Terraform and
    deploys do not fight over it.
  EOT
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
