#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" != "--run" || $# -ne 1 ]]; then
  printf '%s\n' 'Usage: smoke-production-read-only-remote.sh --run' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

remote_ssh 'bash -s' <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
SMOKE_POLICY="${ROOT}/releases/${STACK}/current/deploy/scripts/smoke-data-hygiene.sh"
BASE_URL=http://127.0.0.1:8787
COMPOSE_CONFIG="$(mktemp)"
AUTH_RESPONSE="$(mktemp)"

cleanup() {
  rm -f "$COMPOSE_CONFIG" "$AUTH_RESPONSE"
}
trap cleanup EXIT

test -f "${COMPOSE_DIR}/.env"
test -f "${COMPOSE_DIR}/compose.yaml"
test -r "$SMOKE_POLICY"
source "$SMOKE_POLICY"

docker compose --project-name "$STACK" --env-file "${COMPOSE_DIR}/.env" \
  -f "${COMPOSE_DIR}/compose.yaml" config --format json >"$COMPOSE_CONFIG"
mapfile -t deployment_values < <(python3 - "$COMPOSE_CONFIG" <<'PYTHON'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
api = config.get("services", {}).get("api", {})
environment = api.get("environment", {})
for name in ("NODE_ENV", "PUBLIC_ORIGIN", "AUTH_DISABLED", "ALLOW_PRODUCTION_AUTH_BYPASS"):
    value = environment.get(name)
    if not isinstance(value, str) or not value:
        raise SystemExit(f"Resolved API environment is missing {name}.")
    print(value)
PYTHON
)
[[ "${#deployment_values[@]}" -eq 4 ]] || { printf '%s\n' 'Read-only smoke could not resolve the API environment.' >&2; exit 1; }
NODE_ENV="${deployment_values[0]}"
PUBLIC_ORIGIN="${deployment_values[1]}"
AUTH_DISABLED="${deployment_values[2]}"
ALLOW_PRODUCTION_AUTH_BYPASS="${deployment_values[3]}"
SMOKE_DEPLOYMENT_CLASS="$(smoke_deployment_class "${COMPOSE_DIR}/.env")"
printf 'Production read-only smoke: SMOKE_DEPLOYMENT_CLASS=%s node_env=%s\n' \
  "$SMOKE_DEPLOYMENT_CLASS" "$NODE_ENV"
[[ "$NODE_ENV" == "production" ]] || { printf 'Read-only smoke requires NODE_ENV=production, got %s\n' "$NODE_ENV" >&2; exit 1; }
[[ "$AUTH_DISABLED" == "false" && "$ALLOW_PRODUCTION_AUTH_BYPASS" == "false" ]] \
  || { printf '%s\n' 'Read-only smoke requires Owner session authentication without a production bypass.' >&2; exit 1; }

curl --fail --silent --show-error --noproxy '*' "${BASE_URL}/api/health/ready" >/dev/null
TAILSCALE_DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
test -n "$TAILSCALE_DNS"
[[ "$PUBLIC_ORIGIN" == "https://${TAILSCALE_DNS}:8444" ]] \
  || { printf 'Read-only smoke public origin mismatch: %s\n' "$PUBLIC_ORIGIN" >&2; exit 1; }
curl --fail --silent --show-error --noproxy '*' \
  "https://${TAILSCALE_DNS}:8444/api/health/ready" >/dev/null

bootstrap_status="$(curl --silent --show-error --output "$AUTH_RESPONSE" --write-out '%{http_code}' --noproxy '*' \
  "${BASE_URL}/api/bootstrap")"
[[ "$bootstrap_status" == "401" ]] || { printf 'Anonymous bootstrap expected 401, got %s\n' "$bootstrap_status" >&2; exit 1; }
python3 - "$AUTH_RESPONSE" <<'PYTHON'
import json
import sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
assert body["error"]["code"] == "UNAUTHORIZED"
PYTHON

printf '%s\n' 'Production read-only smoke passed: health, public health, and anonymous Owner-session rejection.'
REMOTE
