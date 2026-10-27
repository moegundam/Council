#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
test -f deploy/.env || { echo 'deploy/.env does not exist; nothing to stop.'; exit 0; }
docker compose --env-file deploy/.env -f deploy/compose.yaml down
