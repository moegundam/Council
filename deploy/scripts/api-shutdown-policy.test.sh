#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
LIFECYCLE="${ROOT}/apps/api/src/server-lifecycle.ts"

API_BLOCK="$(awk '/^  api:/{capture=1} capture && /^  [a-zA-Z0-9_-]+:/ && $1 != "api:" && NR > 1 {exit} capture{print}' "$COMPOSE")"
GRACE_SECONDS="$(sed -nE 's/^[[:space:]]*stop_grace_period:[[:space:]]*([0-9]+)s[[:space:]]*$/\1/p' <<<"$API_BLOCK")"
DEADLINE_LITERAL="$(sed -nE 's/^export const API_SHUTDOWN_DEADLINE_MS = ([0-9_]+);$/\1/p' "$LIFECYCLE")"
FALLBACK_LITERAL="$(sed -nE 's/^export const API_SHUTDOWN_FALLBACK_MS = ([0-9_]+);$/\1/p' "$LIFECYCLE")"

if [[ -z "$GRACE_SECONDS" ]]; then
  printf '%s\n' 'API must define an explicit stop_grace_period in seconds.' >&2
  exit 1
fi
if [[ -z "$DEADLINE_LITERAL" ]]; then
  printf '%s\n' 'API must define a static application shutdown deadline.' >&2
  exit 1
fi
if [[ -z "$FALLBACK_LITERAL" ]]; then
  printf '%s\n' 'API must define a static bounded shutdown fallback window.' >&2
  exit 1
fi

DEADLINE_MS="${DEADLINE_LITERAL//_/}"
FALLBACK_MS="${FALLBACK_LITERAL//_/}"
if (( DEADLINE_MS + FALLBACK_MS >= GRACE_SECONDS * 1000 )); then
  printf '%s\n' 'API graceful deadline plus fallback window must be shorter than Compose stop_grace_period.' >&2
  exit 1
fi

printf '%s\n' 'API shutdown policy tests passed'
