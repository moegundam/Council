#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
pnpm run selfhost:init
compose=(docker compose --env-file deploy/.env -f deploy/compose.yaml)
"${compose[@]}" up -d --build postgres redis
"${compose[@]}" --profile ops run --rm migrate
"${compose[@]}" up -d --build
printf 'Council is available at the PUBLIC_ORIGIN configured in deploy/.env.\n'
