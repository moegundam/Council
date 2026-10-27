#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-remote.sh"
ROLLBACK_SCRIPT="${SCRIPT_DIR}/rollback-remote.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

if ! type mapfile >/dev/null 2>&1; then
  mapfile() {
    local target
    local line

    [[ "${1:-}" == "-t" ]] || return 2
    target="$2"
    eval "$target=()"
    while IFS= read -r line; do
      eval "$target+=(\"\$line\")"
    done
  }
fi

extract_policy() {
  local script="$1"
  local destination="$2"

  awk '
    /^# PLATFORM_FAIL_CLOSED_POLICY_BEGIN$/ { capture=1; next }
    /^# PLATFORM_FAIL_CLOSED_POLICY_END$/ { capture=0 }
    capture
  ' "$script" >"$destination"
}

exercise_stop_policy() {
  local script="$1"
  local prefix="$2"
  local fail_closed_function="$3"
  local policy_file="${TEMP_ROOT}/${prefix}-fail-closed.sh"

  extract_policy "$script" "$policy_file"
  grep -Fq 'stop_platform_gateway()' "$policy_file"
  grep -Fq 'stop_project_containers()' "$policy_file"
  grep -Fq 'containers_stably_absent()' "$policy_file"
  grep -Fq "${fail_closed_function}()" "$policy_file"
  # shellcheck disable=SC1090
  source "$policy_file"

  disable_omp_attestation_timer() { return 0; }

  STACK=agent-meeting-platform
  gateway_running=true
  api_running=true
  stop_failures_remaining=3
  kill_fails=false
  ps_fails=false
  events=()
  sleep() { :; }

  docker() {
    local command="$1"
    shift
    case "$command" in
      ps)
        if [[ "$ps_fails" == true ]]; then
          return 42
        fi
        if [[ "$*" == *'com.docker.compose.service=gateway'* ]]; then
          [[ "$gateway_running" == true ]] && printf '%s\n' gateway-id
        else
          [[ "$gateway_running" == true ]] && printf '%s\n' gateway-id
          [[ "$api_running" == true ]] && printf '%s\n' api-id
        fi
        return 0
        ;;
      stop)
        events+=("stop:$*")
        if (( stop_failures_remaining > 0 )); then
          stop_failures_remaining=$((stop_failures_remaining - 1))
          return 1
        fi
        [[ " $* " == *' gateway-id '* ]] && gateway_running=false
        [[ " $* " == *' api-id '* ]] && api_running=false
        ;;
      kill)
        events+=("kill:$*")
        if [[ "$kill_fails" == true ]]; then
          return 1
        fi
        [[ " $* " == *' gateway-id '* ]] && gateway_running=false
        [[ " $* " == *' api-id '* ]] && api_running=false
        ;;
      *)
        printf 'Unexpected docker command in %s test: %s %s\n' "$prefix" "$command" "$*" >&2
        return 1
        ;;
    esac
  }

  stop_platform_gateway
  if [[ "$gateway_running" != false || "$(IFS=,; printf '%s' "${events[*]}")" != *'kill:gateway-id'* ]]; then
    printf '%s gateway stop did not use the verified kill fallback.\n' "$prefix" >&2
    exit 1
  fi

  gateway_running=true
  api_running=true
  stop_failures_remaining=2
  events=()
  stop_project_containers
  if [[ "$gateway_running" != false || "$api_running" != false ]]; then
    printf '%s project stop did not verify every project container stopped.\n' "$prefix" >&2
    exit 1
  fi
  if [[ "$(IFS=,; printf '%s' "${events[*]}")" != *'kill:gateway-id api-id'* ]]; then
    printf '%s project stop did not use the bounded kill fallback.\n' "$prefix" >&2
    exit 1
  fi

  gateway_running=true
  api_running=true
  ps_fails=true
  if stop_platform_gateway >/dev/null 2>&1; then
    printf '%s gateway stop treated a failed Docker inventory as empty.\n' "$prefix" >&2
    exit 1
  fi
  if stop_project_containers >/dev/null 2>&1; then
    printf '%s project stop treated a failed Docker inventory as empty.\n' "$prefix" >&2
    exit 1
  fi
  if "$fail_closed_function" >/dev/null 2>&1; then
    printf '%s fail-closed policy accepted an unavailable Docker inventory.\n' "$prefix" >&2
    exit 1
  fi
  ps_fails=false

  counter_file="${TEMP_ROOT}/${prefix}-inventory-counter"
  printf '%s\n' 0 >"$counter_file"
  flapping_inventory() {
    local count
    count="$(cat "$counter_file")"
    count=$((count + 1))
    printf '%s\n' "$count" >"$counter_file"
    if [[ "$count" -eq 2 ]]; then
      printf '%s\n' restarted-id
    fi
    return 0
  }
  if containers_stably_absent flapping_inventory; then
    printf '%s stable-stop verifier accepted a restart between empty snapshots.\n' "$prefix" >&2
    exit 1
  fi

  order=()
  disable_omp_attestation_timer() {
    if [[ "$prefix" == deploy ]]; then
      order+=(timer)
    fi
  }
  stop_platform_gateway() {
    order+=(gateway)
  }
  stop_project_containers() {
    order+=(project)
  }
  gateway_running_container_ids() { return 0; }
  project_running_container_ids() { return 0; }
  "$fail_closed_function"
  expected_order='gateway,project'
  if [[ "$prefix" == deploy ]]; then
    expected_order='timer,gateway,project'
  fi
  if [[ "$(IFS=,; printf '%s' "${order[*]}")" != "$expected_order" ]]; then
    printf '%s fail-closed policy did not disable the timer before closing the gateway and project.\n' "$prefix" >&2
    exit 1
  fi

  stop_platform_gateway() { return 1; }
  stop_project_containers() { return 0; }
  gateway_inventory_counter="${TEMP_ROOT}/${prefix}-final-gateway-counter"
  project_inventory_counter="${TEMP_ROOT}/${prefix}-final-project-counter"
  printf '%s\n' 0 >"$gateway_inventory_counter"
  printf '%s\n' 0 >"$project_inventory_counter"
  gateway_running_container_ids() {
    local count
    count="$(cat "$gateway_inventory_counter")"
    printf '%s\n' "$((count + 1))" >"$gateway_inventory_counter"
  }
  project_running_container_ids() {
    local count
    count="$(cat "$project_inventory_counter")"
    printf '%s\n' "$((count + 1))" >"$project_inventory_counter"
  }
  if "$fail_closed_function" >/dev/null 2>&1; then
    printf '%s fail-closed policy accepted a failed stop helper despite stable final inventory.\n' "$prefix" >&2
    exit 1
  fi
  if [[ "$(cat "$gateway_inventory_counter")" != 3 \
    || "$(cat "$project_inventory_counter")" != 3 ]]; then
    printf '%s fail-closed policy did not independently run all three final inventory checks.\n' "$prefix" >&2
    exit 1
  fi

  stop_platform_gateway() { return 0; }
  stop_project_containers() { return 1; }
  disable_omp_attestation_timer() { return 0; }
  printf '%s\n' 0 >"$gateway_inventory_counter"
  printf '%s\n' 0 >"$project_inventory_counter"
  if "$fail_closed_function" >/dev/null 2>&1; then
    printf '%s fail-closed policy accepted a failed project stop helper despite stable final inventory.\n' "$prefix" >&2
    exit 1
  fi
  if [[ "$(cat "$gateway_inventory_counter")" != 3 \
    || "$(cat "$project_inventory_counter")" != 3 ]]; then
    printf '%s fail-closed policy did not run all three final inventory checks after a project helper failure.\n' "$prefix" >&2
    exit 1
  fi

  stop_platform_gateway() { return 1; }
  stop_project_containers() { return 1; }
  containers_stably_absent() { return 1; }
  gateway_running_container_ids() { printf '%s\n' gateway-id; }
  project_running_container_ids() { printf '%s\n' gateway-id; }
  if "$fail_closed_function" >/dev/null 2>&1; then
    printf '%s fail-closed policy claimed success while the gateway remained running.\n' "$prefix" >&2
    exit 1
  fi
}

exercise_stop_policy "$DEPLOY_SCRIPT" deploy fail_closed_deployment
exercise_stop_policy "$ROLLBACK_SCRIPT" rollback fail_closed_rollback

for script in "$DEPLOY_SCRIPT" "$ROLLBACK_SCRIPT"; do
  grep -Fq 'docker stop --time 10' "$script"
  grep -Fq 'docker kill' "$script"
  grep -Fq 'label=com.docker.compose.service=gateway' "$script"
done

printf '%s\n' 'Platform fail-closed gateway and project stop policy tests passed'
