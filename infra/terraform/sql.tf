resource "google_sql_database_instance" "civil" {
  name             = "civil-pg"
  database_version = "POSTGRES_17"
  region           = var.region

  deletion_protection = var.db_deletion_protection

  settings {
    # POSTGRES_17 defaults to ENTERPRISE_PLUS, which rejects shared-core tiers and
    # starts at roughly ten times the cost. ENTERPRISE is what makes db-f1-micro legal.
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = "ZONAL"
    disk_size         = 10
    disk_type         = "PD_SSD"
    disk_autoresize   = true

    ip_configuration {
      # No authorized networks: the only way in is the Cloud SQL Auth Proxy, which
      # Cloud Run mounts as a unix socket and which authenticates with IAM.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "09:00"
      point_in_time_recovery_enabled = true
      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day  = 7
      hour = 10
    }
  }
}

resource "google_sql_database" "civil" {
  name     = "civil"
  instance = google_sql_database_instance.civil.name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_user" "civil" {
  name     = "civil"
  instance = google_sql_database_instance.civil.name
  password = random_password.db.result
}

# PRD 2: secrets in env and Secret Manager, never in the repo. The whole connection
# string is one secret rather than a password the container reassembles, so there is
# a single thing to rotate and the app just reads DATABASE_URL.
resource "google_secret_manager_secret" "database_url" {
  secret_id = "civil-database-url"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # The unix socket the Cloud SQL volume mounts. `pg` reads the host from the query
  # string, so no Cloud-Run-specific code is needed in the app.
  secret_data = format(
    "postgres://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.civil.name,
    random_password.db.result,
    google_sql_database.civil.name,
    google_sql_database_instance.civil.connection_name,
  )
}
