#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/smoke-core-workflow-remote.sh"

bash -n "$SCRIPT"

set +e
output="$(bash "$SCRIPT" 2>&1)"
status=$?
set -e
if [[ "$status" -ne 2 || "$output" != *'Usage: smoke-core-workflow-remote.sh --run'* ]]; then
  printf 'Core workflow smoke did not fail closed without --run:\n%s\n' "$output" >&2
  exit 1
fi

for required in \
  '/api/groups' \
  '/api/categories' \
  '/api/tags' \
  '/api/threads' \
  '/api/meetings' \
  '/tools/run' \
  'toolRuns' \
  '"status"] == "succeeded"' \
  '/chair-suggestions/${SUGGESTION_ID}/role' \
  '/api/decisions' \
  '/api/tasks' \
  'for status in in_progress review done' \
  '"status":"archived"' \
  'CURRENT_STEP=bootstrap' \
  'Core workflow smoke HTTP %s at %s' \
  'safe_response_excerpt >&2' \
  'requires at least two Agents'; do
  if ! grep -Fq "$required" "$SCRIPT"; then
    printf 'Core workflow smoke is missing required proof: %s\n' "$required" >&2
    exit 1
  fi
done


if grep -Fq 'cat "$API_RESPONSE" >&2' "$SCRIPT" || grep -Fq 'head -c' "$SCRIPT"; then
  printf '%s\n' 'Core workflow smoke must not log an unfiltered API response body.' >&2
  exit 1
fi

printf '%s\n' 'core workflow smoke policy tests passed'
