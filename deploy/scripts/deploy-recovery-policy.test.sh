#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-remote.sh"
TEMP_ROOT="$(mktemp -d)"
POLICY_FILE="${TEMP_ROOT}/deploy-recovery-policy.sh"
REMOTE_FILE="${TEMP_ROOT}/deploy-remote-body.sh"
trap 'rm -rf "$TEMP_ROOT"' EXIT

awk '
  /remote_ssh .*bash -s.*<<.REMOTE.$/ { capture=1; next }
  capture && $0 == "REMOTE" { exit }
  capture
' "$DEPLOY_SCRIPT" >"$REMOTE_FILE"
bash -n "$REMOTE_FILE"

awk '
  /^# DEPLOY_RECOVERY_POLICY_BEGIN$/ { capture=1; next }
  /^# DEPLOY_RECOVERY_POLICY_END$/ { capture=0 }
  capture
' "$DEPLOY_SCRIPT" >"$POLICY_FILE"
source "$POLICY_FILE"

events=()
stop_status=0
configuration_status=0
current_status=0
database_status=0
redis_status=0
restart_status=0
serve_status=0

record_event() {
  events+=("$1")
}

stop_candidate_stack() {
  record_event stop-candidate
  return "$stop_status"
}

restore_previous_configuration() {
  record_event restore-config
  return "$configuration_status"
}

restore_previous_current() {
  record_event restore-current
  return "$current_status"
}

restore_previous_database() {
  record_event restore-database
  return "$database_status"
}

restore_previous_redis() {
  record_event restore-redis
  return "$redis_status"
}

restart_previous_stack() {
  record_event restart-previous
  return "$restart_status"
}

restore_previous_serve() {
  record_event restore-serve
  return "$serve_status"
}

fail_closed_deployment() {
  record_event fail-closed
}

reset_case() {
  events=()
  stop_status=0
  configuration_status=0
  current_status=0
  database_status=0
  redis_status=0
  restart_status=0
  serve_status=0
}

assert_events() {
  local label="$1"
  local expected="$2"
  local actual

  actual="$(IFS=,; printf '%s' "${events[*]}")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Unexpected recovery order for %s.\nExpected: %s\nActual:   %s\n' \
      "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

reset_case
had_previous_config=true
existing_database=true
candidate_data_may_have_changed=true
recover_deployment
assert_events existing-migrated \
  'stop-candidate,restore-config,restore-current,restore-redis,restore-database,restart-previous,restore-serve'

reset_case
had_previous_config=false
existing_database=false
candidate_data_may_have_changed=true
recover_deployment
assert_events initial-deployment \
  'stop-candidate,restore-config,restore-current,restore-serve'

reset_case
had_previous_config=true
existing_database=true
candidate_data_may_have_changed=true
database_status=1
if recover_deployment; then
  printf '%s\n' 'Database recovery failure was not fail-closed.' >&2
  exit 1
fi
assert_events database-failure \
  'stop-candidate,restore-config,restore-current,restore-redis,restore-database,fail-closed'

reset_case
had_previous_config=true
existing_database=true
candidate_data_may_have_changed=true
redis_status=1
if recover_deployment; then
  printf '%s\n' 'Redis recovery failure was not fail-closed.' >&2
  exit 1
fi
assert_events redis-failure \
  'stop-candidate,restore-config,restore-current,restore-redis,fail-closed'

reset_case
had_previous_config=true
existing_database=true
candidate_data_may_have_changed=true
configuration_status=1
if recover_deployment; then
  printf '%s\n' 'Configuration recovery failure was not fail-closed.' >&2
  exit 1
fi
assert_events configuration-failure \
  'stop-candidate,restore-config,restore-current,fail-closed'

reset_case
had_previous_config=true
existing_database=true
candidate_data_may_have_changed=true
stop_status=1
if recover_deployment; then
  printf '%s\n' 'Candidate stop failure was not fail-closed.' >&2
  exit 1
fi
assert_events candidate-stop-failure \
  'stop-candidate,restore-config,restore-current,fail-closed'

reset_case
had_previous_config=true
existing_database=true
candidate_data_may_have_changed=true
serve_status=1
if recover_deployment; then
  printf '%s\n' 'Serve restoration failure was not fail-closed.' >&2
  exit 1
fi
assert_events serve-failure \
  'stop-candidate,restore-config,restore-current,restore-redis,restore-database,restart-previous,restore-serve,fail-closed'

line_number() {
  local needle="$1"
  awk -v needle="$needle" 'index($0, needle) { print NR; exit }' "$DEPLOY_SCRIPT"
}

exact_line_number() {
  local needle="$1"
  awk -v needle="$needle" '$0 == needle { print NR; exit }' "$DEPLOY_SCRIPT"
}

trap_line="$(line_number 'trap deployment_exit EXIT')"
cutover_line="$(line_number 'recovery_required=true')"
writer_stop_line="$(exact_line_number '  previous_compose stop api worker')"
backup_call_line="$(exact_line_number '  create_predeploy_database_backup')"
redis_stop_line="$(exact_line_number '  previous_compose stop redis')"
redis_backup_line="$(exact_line_number '  create_predeploy_redis_backup')"
backup_seal_line="$(exact_line_number '  seal_predeploy_recovery_backup')"
compatibility_scan_line="$(exact_line_number '  current_queue_contains_mcp_payload any')"
stack_down_line="$(exact_line_number '  previous_compose down --remove-orphans')"
candidate_config_install_line="$(exact_line_number 'install -m 644 "$CANDIDATE_COMPOSE" "${COMPOSE_DIR}/compose.yaml"')"
candidate_data_flag_line="$(line_number 'candidate_data_may_have_changed=true')"
candidate_data_start_line="$(exact_line_number 'compose up -d postgres redis')"
migration_line="$(line_number 'if ! compose --profile ops run --rm migrate; then')"
pointer_line="$(line_number 'ln -sfn "$RELEASE_ROOT" "${RELEASES_ROOT}/current"')"
commit_line="$(line_number 'deployment_committed=true')"

if [[ -z "$trap_line" || -z "$cutover_line" || "$trap_line" -ge "$cutover_line" ]]; then
  printf '%s\n' 'Deployment recovery trap must be installed before cutover.' >&2
  exit 1
fi
if [[ -z "$candidate_data_flag_line" || -z "$candidate_data_start_line" || -z "$migration_line" \
  || "$candidate_data_flag_line" -ge "$candidate_data_start_line" \
  || "$candidate_data_start_line" -ge "$migration_line" ]]; then
  printf '%s\n' 'Deployment must mark candidate data as mutable before starting PostgreSQL or Redis.' >&2
  exit 1
fi
if [[ -z "$writer_stop_line" || -z "$backup_call_line" || -z "$redis_stop_line" \
  || -z "$redis_backup_line" || -z "$backup_seal_line" || -z "$compatibility_scan_line" \
  || "$writer_stop_line" -ge "$backup_call_line" || "$backup_call_line" -ge "$redis_stop_line" \
  || "$redis_stop_line" -ge "$redis_backup_line" || "$redis_backup_line" -ge "$backup_seal_line" \
  || "$backup_seal_line" -ge "$compatibility_scan_line" \
  || "$compatibility_scan_line" -ge "$candidate_data_flag_line" ]]; then
  printf '%s\n' 'Deployment must seal PostgreSQL and stopped-Redis recovery data after writers stop and before candidate data services start.' >&2
  exit 1
fi
if [[ -z "$stack_down_line" || -z "$candidate_config_install_line" \
  || "$compatibility_scan_line" -ge "$stack_down_line" \
  || "$stack_down_line" -ge "$candidate_config_install_line" \
  || "$candidate_config_install_line" -ge "$candidate_data_flag_line" ]]; then
  printf '%s\n' 'Deployment must remove all platform network endpoints before installing a changed candidate network.' >&2
  exit 1
fi
if [[ -z "$pointer_line" || -z "$commit_line" || "$pointer_line" -ge "$commit_line" ]]; then
  printf '%s\n' 'Deployment must update current before marking the release committed.' >&2
  exit 1
fi

grep -Fq 'sha256sum --check SHA256SUMS' "$DEPLOY_SCRIPT"
grep -Fq 'postgres.sql.gz redis-data.tar.gz' "$DEPLOY_SCRIPT"
grep -Fq 'redis-data-after-failed-${VERSION}.tar.gz' "$DEPLOY_SCRIPT"
grep -Fq 'local failed_archive_dir="${BACKUP_ROOT}/forensics/failed-${VERSION}"' "$DEPLOY_SCRIPT"
grep -Fq 'archive_failed_redis_state "$REDIS_DATA" "$failed_archive_dir" "$failed_archive"' "$DEPLOY_SCRIPT"
grep -Fq 'restore_redis_archive_in_place "$REDIS_BACKUP" "$REDIS_DATA"' "$DEPLOY_SCRIPT"
grep -Fq 'sha256sum --check --strict "$checksum_name"' "$DEPLOY_SCRIPT"
grep -Fq -- '--mount "type=bind,src=${forensic_dir},dst=/output"' "$DEPLOY_SCRIPT"
if grep -Fq -- '-v "${BACKUP_ROOT}:/backup"' "$DEPLOY_SCRIPT"; then
  printf '%s\n' 'Deployment recovery must not grant the root helper write access to the recovery-point root.' >&2
  exit 1
fi
grep -Fq 'restore_previous_redis' "$DEPLOY_SCRIPT"
grep -Fq 'docker run --rm --pull never --network none --read-only' "$DEPLOY_SCRIPT"
grep -Fq -- '--user 0:0' "$DEPLOY_SCRIPT"
grep -Fq 'find /restore -mindepth 1 -depth -delete' "$DEPLOY_SCRIPT"
grep -Fq 'Candidate stop helper did not immediately verify; requiring stable empty project inventory.' "$DEPLOY_SCRIPT"
grep -Fq 'containers_stably_absent project_running_container_ids' "$DEPLOY_SCRIPT"
if grep -Fq 'mv "$REDIS_DATA"' "$DEPLOY_SCRIPT"; then
  printf '%s\n' 'Deployment recovery must not rename the root-owned Redis data directory.' >&2
  exit 1
fi
grep -Fq 'DROP DATABASE IF EXISTS council WITH (FORCE)' "$DEPLOY_SCRIPT"
grep -Fq 'candidate_compose stop api worker' "$DEPLOY_SCRIPT"
grep -Fq 'compose_with_environment_file "${COMPOSE_DIR}/.env" "${COMPOSE_DIR}/compose.yaml" "$@"' "$DEPLOY_SCRIPT"
grep -Fq 'compose_with_environment_file "${BACKUP_ROOT}/compose.env" "${BACKUP_ROOT}/compose.yaml" "$@"' "$DEPLOY_SCRIPT"
grep -Fq 'env -i "${clean_environment[@]}"' "$DEPLOY_SCRIPT"
grep -Fq 'label=com.docker.compose.project=${STACK}' "$DEPLOY_SCRIPT"
grep -Fq 'install -m 600 "$SERVE_PREFLIGHT_CONFIG" "$PRIOR_SERVE_CONFIG"' "$DEPLOY_SCRIPT"
grep -Fq 'assert_required_platform_serve "$SERVE_PREFLIGHT_CONFIG" "$TAILSCALE_DNS"' "$DEPLOY_SCRIPT"
grep -Fq 'serve_matches_expected "$status_file" "$status_json" "$previous_serve_target"' "$DEPLOY_SCRIPT"
if grep -Fq 'serve get-config' "$DEPLOY_SCRIPT" || grep -Fq 'serve set-config' "$DEPLOY_SCRIPT"; then
  printf '%s\n' 'Deployment must support legacy Serve status instead of service-config-only commands.' >&2
  exit 1
fi

if grep -Eq 'docker( system)? prune|compose[^\n]*down[^\n]*(--volumes| -v)|systemctl (reboot|poweroff)|(^|[[:space:]])(ufw|iptables|nft)([[:space:]]|$)|rm -rf[^\n]*(DATA_ROOT|POSTGRES_DATA)' "$DEPLOY_SCRIPT"; then
  printf '%s\n' 'Deployment recovery contains a forbidden destructive host operation.' >&2
  exit 1
fi

printf '%s\n' 'deploy recovery policy tests passed'
