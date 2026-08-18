#!/usr/bin/env bash
# PRD 2: one command to run locally. This is it.
set -euo pipefail

cd "$(dirname "$0")/.."

PG_BIN="/opt/homebrew/opt/postgresql@17/bin"
[[ -d "$PG_BIN" ]] && export PATH="$PG_BIN:$PATH"

if [[ ! -f .env ]]; then
  echo "No .env found. Copying .env.example — edit it if the defaults are wrong."
  cp .env.example .env
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

if ! command -v pg_isready >/dev/null; then
  echo "error: PostgreSQL client tools not found." >&2
  echo "       brew install postgresql@17" >&2
  exit 1
fi

if ! pg_isready -q; then
  echo "Starting PostgreSQL..."
  brew services start postgresql@17 >/dev/null
  for _ in $(seq 1 30); do pg_isready -q && break; sleep 0.5; done
  pg_isready -q || { echo "error: PostgreSQL did not start." >&2; exit 1; }
fi

DB_NAME="${DATABASE_URL##*/}"
DB_NAME="${DB_NAME%%\?*}"
if ! psql -lqt | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
  echo "Creating database $DB_NAME..."
  createdb "$DB_NAME"
fi

echo "Applying migrations..."
npm run migrate --workspace @civil/api -- up >/dev/null

echo "Building shared packages..."
npm run build --workspace @civil/schema --silent

echo
echo "  api  http://127.0.0.1:${PORT:-8080}"
echo "  web  http://127.0.0.1:5173   <- open this"
echo

exec npx concurrently -k -n api,web -c green,cyan \
  "npm run dev --workspace @civil/api" \
  "npm run dev --workspace @civil/web"
