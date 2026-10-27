#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-remote.sh"
COMPOSE_HELPER="${SCRIPT_DIR}/compose-environment.sh"
TEMP_ROOT="$(mktemp -d)"
POLICY_FILE="${TEMP_ROOT}/compose-environment-policy.sh"
MOCK_BIN="${TEMP_ROOT}/bin"
trap 'rm -rf "$TEMP_ROOT"' EXIT

awk '
  /^# COMPOSE_ENVIRONMENT_POLICY_BEGIN$/ { capture=1; next }
  /^# COMPOSE_ENVIRONMENT_POLICY_END$/ { capture=0 }
  capture
' "$DEPLOY_SCRIPT" >"$POLICY_FILE"

if [[ ! -s "$POLICY_FILE" ]]; then
  printf '%s\n' 'Compose environment isolation policy is missing.' >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$POLICY_FILE"
# shellcheck disable=SC1090
source "$COMPOSE_HELPER"

mkdir -p "$MOCK_BIN" "${TEMP_ROOT}/home"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf "OMP_RUNTIME_ENABLED=%s\n" "${OMP_RUNTIME_ENABLED-unset}"' \
  'printf "AUTH_DISABLED=%s\n" "${AUTH_DISABLED-unset}"' \
  'printf "FUTURE_APPLICATION_FLAG=%s\n" "${FUTURE_APPLICATION_FLAG-unset}"' \
  'printf "DOCKER_HOST=%s\n" "${DOCKER_HOST-unset}"' \
  'printf "HOME=%s\n" "${HOME-unset}"' \
  'printf "ARGS="' \
  'printf " <%s>" "$@"' \
  'printf "\n"' \
  >"${MOCK_BIN}/docker"
chmod 755 "${MOCK_BIN}/docker"

STACK=agent-meeting-platform
CANDIDATE_ENV="${TEMP_ROOT}/candidate.env"
CANDIDATE_COMPOSE="${TEMP_ROOT}/candidate.yaml"
COMPOSE_DIR="${TEMP_ROOT}/current"
BACKUP_ROOT="${TEMP_ROOT}/backup"
mkdir -p "$COMPOSE_DIR" "$BACKUP_ROOT"
printf '%s\n' 'OMP_RUNTIME_ENABLED=true' >"$CANDIDATE_ENV"
printf '%s\n' 'services: {}' >"$CANDIDATE_COMPOSE"
printf '%s\n' 'OMP_RUNTIME_ENABLED=true' >"${COMPOSE_DIR}/.env"
printf '%s\n' 'services: {}' >"${COMPOSE_DIR}/compose.yaml"
printf '%s\n' 'OMP_RUNTIME_ENABLED=false' >"${BACKUP_ROOT}/compose.env"
printf '%s\n' 'services: {}' >"${BACKUP_ROOT}/compose.yaml"

export PATH="${MOCK_BIN}:${PATH}"
export HOME="${TEMP_ROOT}/home"
export DOCKER_HOST='unix:///run/docker-admin.sock'
export OMP_RUNTIME_ENABLED=true
export AUTH_DISABLED=true
export FUTURE_APPLICATION_FLAG=candidate-value

output="$(previous_compose config)"

grep -Fqx 'OMP_RUNTIME_ENABLED=unset' <<<"$output"
grep -Fqx 'AUTH_DISABLED=unset' <<<"$output"
grep -Fqx 'FUTURE_APPLICATION_FLAG=unset' <<<"$output"
grep -Fqx 'DOCKER_HOST=unix:///run/docker-admin.sock' <<<"$output"
grep -Fqx "HOME=${TEMP_ROOT}/home" <<<"$output"
grep -Fq "<--env-file> <${BACKUP_ROOT}/compose.env>" <<<"$output"
grep -Fq "<-f> <${BACKUP_ROOT}/compose.yaml>" <<<"$output"

output="$(compose_with_deployment_environment "$STACK" "$CANDIDATE_ENV" "$CANDIDATE_COMPOSE" config)"
grep -Fqx 'OMP_RUNTIME_ENABLED=unset' <<<"$output"
grep -Fqx 'AUTH_DISABLED=unset' <<<"$output"
grep -Fqx 'FUTURE_APPLICATION_FLAG=unset' <<<"$output"
grep -Fqx 'DOCKER_HOST=unix:///run/docker-admin.sock' <<<"$output"
grep -Fq "<--env-file> <${CANDIDATE_ENV}>" <<<"$output"
grep -Fq "<-f> <${CANDIDATE_COMPOSE}>" <<<"$output"

disabled_services="$(platform_services_for_omp_runtime false)"
[[ "$(wc -l <<<"$disabled_services")" -eq 9 ]]
[[ "$disabled_services" == $'postgres\nredis\napi\nworker\nweb\nmcp-readonly\nmodel-tunnel\ntask-adapter-reference\ngateway' ]]
enabled_services="$(platform_services_for_omp_runtime true)"
[[ "$(wc -l <<<"$enabled_services")" -eq 10 ]]
[[ "$enabled_services" == *$'gateway\nsandbox-broker' ]]
set +e
invalid_services="$(platform_services_for_omp_runtime TRUE 2>&1)"
invalid_status=$?
set -e
[[ "$invalid_status" -ne 0 ]]
[[ "$invalid_services" == 'Invalid OMP runtime flag: TRUE' ]]

printf '%s\n' 'Compose helpers isolate application interpolation and resolve strict OMP service sets'
