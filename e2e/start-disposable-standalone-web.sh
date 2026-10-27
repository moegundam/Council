#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STAGE="${E2E_STANDALONE_ROOT:-/tmp/council-e2e-standalone-3001}"

if [[ "${E2E_DEPLOYMENT_CLASS:-}" != "disposable" \
  || "${E2E_DISPOSABLE_MARKER:-}" != "council-agent-meeting-platform-disposable-e2e-v1" ]]; then
  printf '%s\n' 'Disposable standalone web marker is missing or invalid.' >&2
  exit 2
fi

if [[ ! "$STAGE" =~ ^/tmp/council-e2e-standalone-([0-9]{1,5})$ ]]; then
  printf 'Unsafe disposable standalone stage: %s\n' "$STAGE" >&2
  exit 2
fi
stage_port=$((10#${BASH_REMATCH[1]}))
if ! (( stage_port >= 1 && stage_port <= 65535 )); then
  printf 'Disposable standalone stage has an invalid port: %s\n' "$STAGE" >&2
  exit 2
fi

rm -rf -- "$STAGE"
mkdir -p "$STAGE/apps/web/.next" "$STAGE/apps/web"
cp -R "$ROOT/apps/web/.next/standalone/." "$STAGE/"
cp -R "$ROOT/apps/web/.next/static" "$STAGE/apps/web/.next/static"
cp -R "$ROOT/apps/web/public" "$STAGE/apps/web/public"

child_pid=""
cleanup() {
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  rm -rf -- "$STAGE"
}
trap cleanup EXIT INT TERM

cd "$STAGE"
node apps/web/server.js &
child_pid="$!"
wait "$child_pid"
child_pid=""
