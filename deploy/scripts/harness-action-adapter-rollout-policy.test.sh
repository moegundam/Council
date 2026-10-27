#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
ENV_EXAMPLE="${ROOT}/deploy/.env.example"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"
ROLLBACK="${ROOT}/deploy/scripts/rollback-remote.sh"

grep -Fq 'HARNESS_ACTION_ADAPTER_ENABLED: ${HARNESS_ACTION_ADAPTER_ENABLED:-false}' "$COMPOSE"
grep -Fxq 'HARNESS_ACTION_ADAPTER_ENABLED=false' "$ENV_EXAMPLE"
grep -Fxq 'HARNESS_ACTION_ADAPTER_ENABLED="${HARNESS_ACTION_ADAPTER_ENABLED:-false}"' "$DEPLOY"
grep -Fxq 'ALLOW_HARNESS_ACTION_ADAPTER="${ALLOW_HARNESS_ACTION_ADAPTER:-false}"' "$DEPLOY"
grep -Fq 'HARNESS_ACTION_ADAPTER_ENABLED must be true or false.' "$DEPLOY"
grep -Fq 'Enabling Harness Action Adapter requires ALLOW_HARNESS_ACTION_ADAPTER=true.' "$DEPLOY"
grep -Fq 'Enabling Harness Action Adapter requires HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST.' "$DEPLOY"
grep -Fq 'required_settings+=(HARNESS_ACTION_ADAPTER_ENABLED)' "$ROLLBACK"
grep -Fq 'HARNESS_ACTION_ADAPTER_ENABLED="$(target_env_value HARNESS_ACTION_ADAPTER_ENABLED)"' "$ROLLBACK"

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
bundle="${fixture}/agent-meeting-platform-19000101T000000Z.tar.gz"
ssh_key="${fixture}/ssh-key"
touch "$bundle" "${bundle}.sha256" "$ssh_key"

set +e
invalid_output="$(SSH_KEY="$ssh_key" HARNESS_ACTION_ADAPTER_ENABLED=invalid bash "$DEPLOY" "$bundle" 2>&1)"
invalid_status=$?
set -e
[[ "$invalid_status" -ne 0 ]]
[[ "$invalid_output" == *'HARNESS_ACTION_ADAPTER_ENABLED must be true or false.'* ]]

set +e
unacknowledged_output="$(SSH_KEY="$ssh_key" HARNESS_ACTION_ADAPTER_ENABLED=true ALLOW_HARNESS_ACTION_ADAPTER=false \
  bash "$DEPLOY" "$bundle" 2>&1)"
unacknowledged_status=$?
set -e
[[ "$unacknowledged_status" -ne 0 ]]
[[ "$unacknowledged_output" == *'Enabling Harness Action Adapter requires ALLOW_HARNESS_ACTION_ADAPTER=true.'* ]]

set +e
missing_allowlist_output="$(SSH_KEY="$ssh_key" HARNESS_ACTION_ADAPTER_ENABLED=true ALLOW_HARNESS_ACTION_ADAPTER=true \
  bash "$DEPLOY" "$bundle" 2>&1)"
missing_allowlist_status=$?
set -e
[[ "$missing_allowlist_status" -ne 0 ]]
[[ "$missing_allowlist_output" == *'Enabling Harness Action Adapter requires HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST.'* ]]

printf '%s\n' 'Harness Action Adapter rollout defaults are fail-closed and require explicit acknowledgement.'
