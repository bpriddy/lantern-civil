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

RUNNER=$(tf output -raw runner_service_name 2>/dev/null || echo "")

TAG="$(git rev-parse --short HEAD)$( git diff --quiet || echo '-dirty' )"
IMAGE="${REPO}/api:${TAG}"

echo "==> Building ${IMAGE}"
gcloud builds submit --project="$PROJECT_ID" --tag="$IMAGE" .

if [[ -n "$RUNNER" ]]; then
  # The runner deploys only once its one secret exists — a revision referencing a
  # versionless secret fails to start, and the error it fails with says less than
  # this does.
  if ! gcloud secrets versions list civil-anthropic-key --project="$PROJECT_ID" \
      --filter="state=enabled" --format="value(name)" --limit=1 | grep -q .; then
    echo "error: civil-anthropic-key has no enabled version." >&2
    echo "       Add the platform's model key yourself (never through tooling):" >&2
    echo "         printf 'sk-ant-…' | gcloud secrets versions add civil-anthropic-key --data-file=- --project=$PROJECT_ID" >&2
    exit 1
  fi

  RUNNER_IMAGE="${REPO}/runner:${TAG}"
  echo "==> Building ${RUNNER_IMAGE}"
  gcloud builds submit --project="$PROJECT_ID" --config=runner/cloudbuild.yaml \
    --substitutions="_IMAGE=${RUNNER_IMAGE}" .

  echo "==> Deploying runner"
  gcloud run deploy "$RUNNER" --project="$PROJECT_ID" --region="$REGION" --image="$RUNNER_IMAGE" --quiet
fi

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

# The runner must refuse strangers at the platform, before the service hears them.
if [[ -n "$RUNNER" ]]; then
  RUNNER_URL=$(tf output -raw runner_url)
  got=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 "${RUNNER_URL}/healthz" || echo "000")
  if [[ "$got" == "403" || "$got" == "401" ]]; then
    printf "    ok   %-16s %s (IAM refuses the unauthenticated)\n" "runner" "$got"
  else
    printf "    FAIL %-16s got %s, wanted 401/403 — the runner may be publicly invokable\n" "runner" "$got"
    fail=1
  fi
fi

if [[ $fail -ne 0 ]]; then
  echo
  echo "Deployed, but the smoke test failed: $URL" >&2
  exit 1
fi

echo
echo "Deployed: $URL"
