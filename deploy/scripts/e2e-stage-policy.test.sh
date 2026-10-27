#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="${ROOT}/e2e/start-disposable-standalone-web.sh"
PREFIX="/tmp/council-e2e-standalone-policy-$$"
VICTIM="/tmp/council-e2e-victim-$$"
trap 'rm -rf "$PREFIX" "$VICTIM"' EXIT

mkdir -p "$PREFIX" "$VICTIM"
printf '%s\n' 'must-survive' >"${VICTIM}/marker"

set +e
E2E_DEPLOYMENT_CLASS=disposable \
E2E_DISPOSABLE_MARKER=council-agent-meeting-platform-disposable-e2e-v1 \
E2E_STANDALONE_ROOT="${PREFIX}/../$(basename "$VICTIM")" \
  bash "$LAUNCHER" >/dev/null 2>&1 &
launcher_pid=$!
for _ in $(seq 1 20); do
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if kill -0 "$launcher_pid" 2>/dev/null; then
  kill "$launcher_pid" 2>/dev/null || true
  wait "$launcher_pid" 2>/dev/null || true
  status=124
else
  wait "$launcher_pid"
  status=$?
fi
set -e

if [[ "$status" -ne 2 || "$(cat "${VICTIM}/marker" 2>/dev/null || true)" != "must-survive" ]]; then
  printf '%s\n' 'Disposable E2E launcher accepted or mutated a traversal stage.' >&2
  exit 1
fi

grep -Fq '[[ ! "$STAGE" =~ ^/tmp/council-e2e-standalone-([0-9]{1,5})$ ]]' "$LAUNCHER"
grep -Fq '(( stage_port >= 1 && stage_port <= 65535 ))' "$LAUNCHER"

printf '%s\n' 'E2E standalone stage policy tests passed'
