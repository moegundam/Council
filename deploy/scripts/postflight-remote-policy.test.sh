#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/postflight-remote.sh"
COMPOSE_HELPER="${SCRIPT_DIR}/compose-environment.sh"
CORE_SMOKE="${SCRIPT_DIR}/smoke-core-workflow-remote.sh"
READ_ONLY_SMOKE="${SCRIPT_DIR}/smoke-production-read-only-remote.sh"
CONFIG_CONSUMERS=(
  "$SCRIPT"
  "$CORE_SMOKE"
  "$READ_ONLY_SMOKE"
  "${SCRIPT_DIR}/smoke-management-control-plane-remote.sh"
  "${SCRIPT_DIR}/smoke-task-agent-run-remote.sh"
  "${SCRIPT_DIR}/smoke-task-work-item-remote.sh"
)

fail() {
  printf 'postflight policy failed: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local text="$1"
  grep -Fq -- "$text" "$SCRIPT" || fail "missing required check: ${text}"
}

[[ -x "$SCRIPT" ]] || fail 'postflight-remote.sh is not executable'
[[ -r "$COMPOSE_HELPER" ]] || fail 'shared Compose environment helper is not readable'
bash -n "$COMPOSE_HELPER"
[[ -x "$CORE_SMOKE" ]] || fail 'main-owned core workflow smoke is not executable'
[[ -x "$READ_ONLY_SMOKE" ]] || fail 'production read-only smoke is not executable'
for config_consumer in "${CONFIG_CONSUMERS[@]}"; do
  bash -n "$config_consumer"
  grep -Fq 'config --format json' "$config_consumer" \
    || fail "$(basename "$config_consumer") must consume Docker Compose resolved JSON"
  if grep -Fq 'source "${COMPOSE_DIR}/.env"' "$config_consumer" \
    || grep -Fq 'set -a' "$config_consumer"; then
    fail "$(basename "$config_consumer") must not execute Compose dotenv as shell code"
  fi
done

dry_output="$(SSH_KEY=/definitely/missing bash "$SCRIPT")"
[[ "$dry_output" == *"Dry run only"* ]] || fail 'postflight must not open SSH without --run'

set +e
mutating_without_target="$(SSH_KEY=/definitely/missing bash "$SCRIPT" --run --mutating-acceptance 2>&1)"
mutating_without_target_status=$?
set -e
[[ "$mutating_without_target_status" -eq 2 ]] \
  || fail 'postflight mutating acceptance did not fail closed without an isolated target'
[[ "$mutating_without_target" == *'Mutating acceptance requires --target disposable or --target isolated.'* ]] \
  || fail 'postflight mutating acceptance refusal was not explicit'

set +e
unknown_output="$(bash "$SCRIPT" --unknown 2>&1)"
unknown_status=$?
set -e
[[ "$unknown_status" -eq 2 ]] || fail 'unknown arguments must fail with status 2'
[[ "$unknown_output" == *"Unknown argument"* ]] || fail 'unknown argument failure must be explicit'

assert_contains 'preflight-remote.sh'
assert_contains 'smoke-production-read-only-remote.sh" --run'
assert_contains '--mutating-acceptance'
assert_contains 'SMOKE_TARGET'
assert_contains 'smoke-data-hygiene.sh'
assert_contains '--allow-reboot-required'
assert_contains 'compose-environment.sh'
assert_contains 'compose_with_deployment_environment'
assert_contains 'OMP_RUNTIME_ENABLED="${deployment_values[4]}"'
assert_contains 'platform_services_for_omp_runtime "$OMP_RUNTIME_ENABLED"'
assert_contains 'platform_services=${#services[@]}/${#services[@]}_running_healthy_restartable'
assert_contains 'final_health=platform_${#services[@]}/${#services[@]}_and_retained_services'
assert_contains '127.0.0.1:8787'
assert_contains 'tailscale serve status'
assert_contains ':8444'
assert_contains '/api/health/ready'
assert_contains '/api/mcp-connectors/${CONNECTOR_ID}/discover'
assert_contains '/api/tools/authorize'
assert_contains 'AUTH_DISABLED'
assert_contains 'ALLOW_PRODUCTION_AUTH_BYPASS'
assert_contains 'production_auth=owner_session_required'
assert_contains 'UNAUTHORIZED'
assert_contains '/api/executions/harness'
assert_contains 'direct_lan_8787=blocked'
assert_contains 'candidate == "" && address[1] != tailscale_ip'
assert_contains 'END { if (candidate != "") print candidate }'
assert_contains 'https://127.0.0.1:9443'
assert_contains 'http://127.0.0.1:80'
assert_contains 'http://127.0.0.1:5678'
assert_contains 'http://127.0.0.1:1880'
assert_contains 'http://127.0.0.1:8123'
assert_contains 'smoke-task-agent-run-remote.sh" --run'
assert_contains 'smoke-task-work-item-remote.sh" --run'
assert_contains 'smoke-core-workflow-remote.sh" --run'
assert_contains 'smoke-management-control-plane-remote.sh" --run'

if grep -Fq 'controlled E2E requires the owner-approved temporary authentication bypass' "$SCRIPT"; then
  fail 'production postflight must not require an authentication bypass'
fi

if grep -Fq 'required 9-service set' "$SCRIPT" \
  || grep -Fq 'platform_services=9/9' "$SCRIPT" \
  || grep -Fq 'platform_9/9' "$SCRIPT"; then
  fail 'postflight service acceptance must follow the resolved OMP runtime flag'
fi

[[ "$(grep -Fc 'platform_services_for_omp_runtime "$OMP_RUNTIME_ENABLED"' "$SCRIPT")" -eq 2 ]] \
  || fail 'both platform service checks must use the strict shared OMP service set'

baseline_line="$(grep -n '^run_platform_security_checks$' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
readonly_line="$(grep -n 'smoke-production-read-only-remote.sh" --run' "$SCRIPT" | cut -d: -f1)"
mutation_if_line="$(grep -n '^if \[\[ "\$MUTATING_ACCEPTANCE" == "true" \]\]; then$' "$SCRIPT" | head -n 1 | cut -d: -f1)"
gate_line="$(grep -n '^  run_mutating_acceptance_gate$' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
management_line="$(grep -n 'smoke-management-control-plane-remote.sh" --run' "$SCRIPT" | cut -d: -f1)"
core_line="$(grep -n 'smoke-core-workflow-remote.sh" --run' "$SCRIPT" | cut -d: -f1)"
agent_line="$(grep -n 'smoke-task-agent-run-remote.sh" --run' "$SCRIPT" | cut -d: -f1)"
adapter_line="$(grep -n 'smoke-task-work-item-remote.sh" --run' "$SCRIPT" | cut -d: -f1)"
final_line="$(grep -n '^run_final_health_check$' "$SCRIPT" | tail -n 1 | cut -d: -f1)"
[[ "$baseline_line" -lt "$readonly_line" \
  && "$readonly_line" -lt "$final_line" \
  && "$mutation_if_line" -lt "$gate_line" \
  && "$gate_line" -lt "$management_line" \
  && "$management_line" -lt "$core_line" \
  && "$core_line" -lt "$agent_line" \
  && "$agent_line" -lt "$adapter_line" \
  && "$adapter_line" -lt "$final_line" ]] || fail 'postflight smoke checks are in the wrong order or mutation gate is missing'

if grep -Eq 'smoke-(management-control-plane|core-workflow|task-agent-run|task-work-item)-remote\.sh" --run$' "$SCRIPT"; then
  fail 'mutating acceptance smoke must never be invoked without an explicit target'
fi

if grep -Fq 'print address[1]; exit' "$SCRIPT"; then
  fail 'LAN IP discovery must consume the full ip output under pipefail'
fi

if grep -En '(docker[[:space:]]+(compose[[:space:]].*)?(up|down|stop|rm)|docker[[:space:]].*prune|tailscale[[:space:]]+serve[[:space:]]+(--bg|.*off)|sudo[[:space:]].*reboot|systemctl[[:space:]]+reboot|apt(-get)?[[:space:]]+(upgrade|install|remove))' "$SCRIPT"; then
  fail 'postflight contains a forbidden host or stack mutation'
fi

printf '%s\n' 'postflight remote policy tests passed'
