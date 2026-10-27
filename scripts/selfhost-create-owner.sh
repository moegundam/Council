#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
EMAIL="${1:-}"
test -n "$EMAIL" || { echo "Usage: printf '%s\\n' 'password' | pnpm selfhost:create-owner -- owner@example.com" >&2; exit 2; }
cd "$ROOT"
test -f deploy/.env || { echo 'Run pnpm selfhost:init first.' >&2; exit 2; }
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T api node dist/admin-create.js --email "$EMAIL"
