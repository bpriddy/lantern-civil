#!/usr/bin/env bash
# PRD 2: one command to deploy Civil itself. This is it.
#
# Migrations run as a Cloud Run job built from the same image as the service, so the
# schema and the code that expects it are never different versions. The job runs
# BEFORE the service is updated, which is the only ordering that is safe for additive
# migrations.
set -euo pipefail

cd "$(dirname "$0")/.."

TF_DIR=infra/terraform
tf() { terraform -chdir="$TF_DIR" "$@"; }

need() { command -v "$1" >/dev/null || { echo "error: $1 not found" >&2; exit 1; }; }
need gcloud
need terraform

PROJECT_ID=$(tf output -raw project_id 2>/dev/null || echo "")
if [[ -z "$PROJECT_ID" ]]; then
  echo "error: no terraform state. Run 'terraform -chdir=$TF_DIR apply' first." >&2
  exit 1
fi

REGION=$(tf output -raw region)
SERVICE=$(tf output -raw service_name)
REPO=$(tf output -raw image_repository)
JOB=$(tf output -raw migrate_job_name)

TAG="$(git rev-parse --short HEAD)$( git diff --quiet || echo '-dirty' )"
IMAGE="${REPO}/api:${TAG}"

echo "==> Building ${IMAGE}"
gcloud builds submit --project="$PROJECT_ID" --tag="$IMAGE" .

echo "==> Migrating"
gcloud run jobs update "$JOB" --project="$PROJECT_ID" --region="$REGION" --image="$IMAGE" --quiet
gcloud run jobs execute "$JOB" --project="$PROJECT_ID" --region="$REGION" --wait

echo "==> Deploying"
gcloud run deploy "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --image="$IMAGE" --quiet

URL=$(tf output -raw service_url)

# The root URL is the one every visitor types, and it is the one most easily broken
# without breaking anything else: a guard that covers too much, or a static handler
# that refuses a directory, both leave every other route looking correct. Check it.
echo "==> Smoke test"
fail=0

check() {
  local path="$1" want_status="$2" want_type="$3"
  local got
  got=$(curl -sS -o /dev/null -w "%{http_code} %{content_type}" --max-time 30 "${URL}${path}" || echo "000 none")
  if [[ "$got" == "$want_status "*"$want_type"* ]]; then
    printf "    ok   %-16s %s\n" "$path" "$got"
  else
    printf "    FAIL %-16s got '%s', wanted '%s * %s'\n" "$path" "$got" "$want_status" "$want_type"
    fail=1
  fi
}

# The shell must load signed out, or nobody can reach the sign-in screen.
check "/"        200 "text/html"
# The data must not.
check "/api/me"  401 "application/json"
# The container must be able to answer for itself.
check "/readyz"  200 "application/json"

if [[ $fail -ne 0 ]]; then
  echo
  echo "Deployed, but the smoke test failed: $URL" >&2
  exit 1
fi

echo
echo "Deployed: $URL"
