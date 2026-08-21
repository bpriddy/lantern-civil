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

# The runner: the process that executes project code (PRD 12). Its venv is set up
# on first use; ANTHROPIC_API_KEY from .env reaches it through the sourced env,
# and without one, agent nodes fail with a message that says exactly that.
if [[ ! -d runner/.venv ]]; then
  echo "Setting up the runner's venv..."
  python3 -m venv runner/.venv
  runner/.venv/bin/pip install -q -r runner/requirements.txt
fi

echo
echo "  api     http://127.0.0.1:${PORT:-8080}"
echo "  web     http://127.0.0.1:5173   <- open this"
echo "  runner  http://127.0.0.1:8081"
echo

exec npx concurrently -k -n api,web,runner -c green,cyan,yellow \
  "npm run dev --workspace @civil/api" \
  "npm run dev --workspace @civil/web" \
  "runner/.venv/bin/python runner/server.py"
