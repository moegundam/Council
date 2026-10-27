#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/smoke-data-hygiene.sh"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-remote.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

fail() {
  printf 'smoke data hygiene policy failed: %s\n' "$1" >&2
  exit 1
}

[[ -x "$HELPER" ]] || fail 'data-hygiene helper is not executable'
bash -n "$HELPER"
grep -Fq 'SMOKE_DEPLOYMENT_CLASS' "$DEPLOY_SCRIPT" \
  || fail 'deployment must persist an explicit smoke deployment marker'
grep -Fq 'SMOKE_DEPLOYMENT_CLASS="${SMOKE_DEPLOYMENT_CLASS:-production}"' "$DEPLOY_SCRIPT" \
  || fail 'deployment must default the smoke marker to production'
grep -Fq 'MCP_LOCAL_HOST_ALLOWLIST=mcp-readonly' "$DEPLOY_SCRIPT" \
  || fail 'deployment must persist the MCP local host allowlist'

COMPOSE_CONFIG="${TEMP_ROOT}/compose.json"
printf '%s\n' '{"services":{"api":{"environment":{"NODE_ENV":"production"}}}}' >"$COMPOSE_CONFIG"

run_gate() {
  source "$HELPER"
  smoke_require_mutating_acceptance "$@"
}

production_env="${TEMP_ROOT}/production.env"
printf '%s\n' 'SMOKE_DEPLOYMENT_CLASS=production' >"$production_env"
set +e
production_output="$(run_gate disposable "$production_env" "$COMPOSE_CONFIG" 2>&1)"
production_status=$?
set -e
[[ "$production_status" -ne 0 ]] || fail 'production marker unexpectedly allowed mutating acceptance'
[[ "$production_output" == *'SMOKE_DEPLOYMENT_CLASS=production'* ]] \
  || fail 'production refusal did not identify the deployment marker'

disposable_env="${TEMP_ROOT}/disposable.env"
printf '%s\n' 'SMOKE_DEPLOYMENT_CLASS=disposable' >"$disposable_env"
disposable_output="$(run_gate disposable "$disposable_env" "$COMPOSE_CONFIG")" \
  || fail 'explicit disposable marker did not allow disposable acceptance'
[[ "$disposable_output" == *'node_env=production'* ]] \
  || fail 'mutating gate did not inspect the resolved deployment marker'

set +e
missing_output="$(run_gate isolated "${TEMP_ROOT}/missing.env" "$COMPOSE_CONFIG" 2>&1)"
missing_status=$?
set -e
[[ "$missing_status" -ne 0 ]] || fail 'missing deployment marker unexpectedly allowed mutation'
[[ "$missing_output" == *'fail closed'* ]] || fail 'missing marker refusal was not fail closed'

for script in \
  "${SCRIPT_DIR}/smoke-management-control-plane-remote.sh" \
  "${SCRIPT_DIR}/smoke-core-workflow-remote.sh" \
  "${SCRIPT_DIR}/smoke-task-agent-run-remote.sh" \
  "${SCRIPT_DIR}/smoke-task-work-item-remote.sh"; do
  set +e
  output="$(SSH_KEY=/definitely/missing bash "$script" --run 2>&1)"
  status=$?
  set -e
  [[ "$status" -eq 2 ]] || fail "$(basename "$script") did not fail closed without an isolated target"
  [[ "$output" == *'requires --target disposable or --target isolated'* ]] \
    || fail "$(basename "$script") did not explain its isolated target requirement"
  grep -Fq 'smoke_require_mutating_acceptance' "$script" \
    || fail "$(basename "$script") is missing the remote marker gate"
done

if grep -Eiq 'hostname|REMOTE_TARGET' "$HELPER"; then
  fail 'mutation gate must not use a hostname substring as its environment proof'
fi

printf '%s\n' 'smoke data hygiene policy tests passed'
