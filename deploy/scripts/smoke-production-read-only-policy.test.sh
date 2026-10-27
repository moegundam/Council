#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/smoke-production-read-only-remote.sh"
POSTFLIGHT="${SCRIPT_DIR}/postflight-remote.sh"

fail() {
  printf 'production read-only smoke policy failed: %s\n' "$1" >&2
  exit 1
}

[[ -x "$SCRIPT" ]] || fail 'production read-only smoke is not executable'
bash -n "$SCRIPT"

set +e
output="$(bash "$SCRIPT" 2>&1)"
status=$?
set -e
[[ "$status" -eq 2 ]] || fail 'production read-only smoke must require --run'
[[ "$output" == *'Usage: smoke-production-read-only-remote.sh --run'* ]] \
  || fail 'production read-only smoke usage is missing'

for required in \
  'read-only' \
  'smoke-data-hygiene.sh' \
  '/api/health/ready' \
  '/api/bootstrap' \
  'SMOKE_DEPLOYMENT_CLASS' \
  'AUTH_DISABLED' \
  'ALLOW_PRODUCTION_AUTH_BYPASS' \
  'UNAUTHORIZED'; do
  grep -Fq "$required" "$SCRIPT" || fail "production smoke is missing: ${required}"
done

if grep -Eq -- '--request[[:space:]]+(POST|PATCH|PUT|DELETE)|api_body|/api/(groups|categories|tags|threads|meetings|decisions|tasks|agents)' "$SCRIPT"; then
  fail 'production smoke contains a mutating acceptance request'
fi

grep -Fq 'smoke-production-read-only-remote.sh" --run' "$POSTFLIGHT" \
  || fail 'postflight does not call the read-only production smoke'
grep -Fq -- '--mutating-acceptance' "$POSTFLIGHT" \
  || fail 'postflight has no explicit mutating acceptance opt-in'
grep -Fq -- '--target' "$POSTFLIGHT" \
  || fail 'postflight has no explicit environment target'

printf '%s\n' 'production read-only smoke policy tests passed'
