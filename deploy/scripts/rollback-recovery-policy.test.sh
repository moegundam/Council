#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLLBACK_SCRIPT="${SCRIPT_DIR}/rollback-remote.sh"
TEMP_ROOT="$(mktemp -d)"
POLICY_FILE="${TEMP_ROOT}/rollback-recovery-policy.sh"
REMOTE_FILE="${TEMP_ROOT}/rollback-remote-body.sh"
trap 'rm -rf "$TEMP_ROOT"' EXIT

awk '
  /remote_ssh .*bash -s.*<<.REMOTE.$/ { capture=1; next }
  capture && $0 == "REMOTE" { exit }
  capture
' "$ROLLBACK_SCRIPT" >"$REMOTE_FILE"
bash -n "$REMOTE_FILE"

awk '
  /^# ROLLBACK_RECOVERY_POLICY_BEGIN$/ { capture=1; next }
  /^# ROLLBACK_RECOVERY_POLICY_END$/ { capture=0 }
  capture
' "$ROLLBACK_SCRIPT" >"$POLICY_FILE"
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

stop_target_stack() {
  record_event stop-target
  return "$stop_status"
}

restore_source_configuration() {
  record_event restore-config
  return "$configuration_status"
}

restore_source_current() {
  record_event restore-current
  return "$current_status"
}

restore_source_database() {
  record_event restore-database
  return "$database_status"
}

restore_source_redis() {
  record_event restore-redis
  return "$redis_status"
}

restart_source_stack() {
  record_event restart-source
  return "$restart_status"
}

restore_source_serve() {
  record_event restore-serve
  return "$serve_status"
}

fail_closed_rollback() {
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
    printf 'Unexpected rollback recovery order for %s.\nExpected: %s\nActual:   %s\n' \
      "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

reset_case
candidate_data_may_have_changed=true
recover_rollback
assert_events migrated-target \
  'stop-target,restore-config,restore-current,restore-redis,restore-database,restart-source,restore-serve'

reset_case
candidate_data_may_have_changed=false
recover_rollback
assert_events pre-migration-failure \
  'stop-target,restore-config,restore-current,restart-source,restore-serve'

reset_case
candidate_data_may_have_changed=true
database_status=1
if recover_rollback; then
  printf '%s\n' 'Rollback database recovery failure was not fail-closed.' >&2
  exit 1
fi
assert_events database-failure \
  'stop-target,restore-config,restore-current,restore-redis,restore-database,fail-closed'

reset_case
candidate_data_may_have_changed=true
redis_status=1
if recover_rollback; then
  printf '%s\n' 'Rollback Redis recovery failure was not fail-closed.' >&2
  exit 1
fi
assert_events redis-failure \
  'stop-target,restore-config,restore-current,restore-redis,fail-closed'

reset_case
candidate_data_may_have_changed=true
restart_status=1
if recover_rollback; then
  printf '%s\n' 'Source restart failure was not fail-closed.' >&2
  exit 1
fi
assert_events restart-failure \
  'stop-target,restore-config,restore-current,restore-redis,restore-database,restart-source,fail-closed'

reset_case
candidate_data_may_have_changed=true
stop_status=1
if recover_rollback; then
  printf '%s\n' 'Target stop failure was not fail-closed.' >&2
  exit 1
fi
assert_events target-stop-failure \
  'stop-target,restore-config,restore-current,fail-closed'

reset_case
candidate_data_may_have_changed=true
serve_status=1
if recover_rollback; then
  printf '%s\n' 'Rollback Serve restoration failure was not fail-closed.' >&2
  exit 1
fi
assert_events serve-failure \
  'stop-target,restore-config,restore-current,restore-redis,restore-database,restart-source,restore-serve,fail-closed'

line_number() {
  local needle="$1"
  awk -v needle="$needle" 'index($0, needle) { print NR; exit }' "$ROLLBACK_SCRIPT"
}

exact_line_number() {
  local needle="$1"
  awk -v needle="$needle" '$0 == needle { print NR; exit }' "$ROLLBACK_SCRIPT"
}

last_exact_line_number() {
  local needle="$1"
  awk -v needle="$needle" '$0 == needle { line=NR } END { if (line) print line }' "$ROLLBACK_SCRIPT"
}

backup_line="$(line_number 'ROLLBACK_POINT="$(mktemp -d')"
checksum_line="$(line_number 'sha256sum --check SHA256SUMS')"
trap_line="$(line_number 'trap rollback_exit EXIT')"
cutover_line="$(line_number 'recovery_required=true')"
writer_stop_line="$(exact_line_number 'source_compose stop api worker')"
projection_sync_line="$(exact_line_number '  source_compose --profile ops run --rm sync-legacy-projections')"
locked_backup_line="$(last_exact_line_number 'create_rollback_point_database_backup')"
redis_stop_line="$(exact_line_number 'source_compose stop redis')"
redis_backup_line="$(exact_line_number 'create_rollback_point_redis_backup')"
backup_seal_line="$(exact_line_number 'seal_rollback_point_recovery_backup')"
source_down_line="$(exact_line_number 'source_compose down --remove-orphans')"
candidate_data_flag_line="$(line_number 'candidate_data_may_have_changed=true')"
candidate_data_start_line="$(exact_line_number 'target_compose up -d postgres redis')"
migration_line="$(line_number 'target_compose --profile ops run --rm migrate')"
pointer_line="$(line_number 'ln -sfn "$RELEASE_ROOT" "$CURRENT_RELEASE"')"
commit_line="$(line_number 'rollback_committed=true')"

if [[ -z "$backup_line" || -z "$cutover_line" || "$backup_line" -ge "$cutover_line" ]]; then
  printf '%s\n' 'Rollback point must be created before cutover.' >&2
  exit 1
fi
if [[ -z "$checksum_line" || "$checksum_line" -ge "$cutover_line" ]]; then
  printf '%s\n' 'Rollback-point database checksum must be verified before cutover.' >&2
  exit 1
fi
if [[ -z "$trap_line" || "$trap_line" -ge "$cutover_line" ]]; then
  printf '%s\n' 'Rollback recovery trap must be installed before cutover.' >&2
  exit 1
fi
if [[ -z "$candidate_data_flag_line" || -z "$candidate_data_start_line" || -z "$migration_line" \
  || "$candidate_data_flag_line" -ge "$candidate_data_start_line" \
  || "$candidate_data_start_line" -ge "$migration_line" ]]; then
  printf '%s\n' 'Rollback must mark target data as mutable before starting PostgreSQL or Redis.' >&2
  exit 1
fi
if [[ -z "$writer_stop_line" || -z "$projection_sync_line" || -z "$locked_backup_line" \
  || -z "$redis_stop_line" || -z "$redis_backup_line" || -z "$backup_seal_line" || -z "$source_down_line" \
  || "$writer_stop_line" -ge "$projection_sync_line" || "$projection_sync_line" -ge "$locked_backup_line" \
  || "$locked_backup_line" -ge "$redis_stop_line" || "$redis_stop_line" -ge "$redis_backup_line" \
  || "$redis_backup_line" -ge "$backup_seal_line" || "$backup_seal_line" -ge "$source_down_line" \
  || "$source_down_line" -ge "$candidate_data_flag_line" ]]; then
  printf '%s\n' 'Rollback compatibility sync and sealed PostgreSQL/Redis backup must run after source writers stop and before target data services start.' >&2
  exit 1
fi
if [[ -z "$pointer_line" || -z "$commit_line" || "$pointer_line" -ge "$commit_line" ]]; then
  printf '%s\n' 'Rollback must update current before marking the target committed.' >&2
  exit 1
fi

grep -Fq 'DROP DATABASE IF EXISTS council WITH (FORCE)' "$ROLLBACK_SCRIPT"
grep -Fq 'postgres.sql.gz redis-data.tar.gz' "$ROLLBACK_SCRIPT"
grep -Fq 'redis-data-after-failed-${SOURCE_VERSION}.tar.gz' "$ROLLBACK_SCRIPT"
grep -Fq 'local failed_archive_dir="${ROLLBACK_POINT}/forensics/failed-${SOURCE_VERSION}"' "$ROLLBACK_SCRIPT"
grep -Fq 'archive_failed_redis_state "$REDIS_DATA" "$failed_archive_dir" "$failed_archive"' "$ROLLBACK_SCRIPT"
grep -Fq 'restore_redis_archive_in_place "$SOURCE_REDIS_BACKUP" "$REDIS_DATA"' "$ROLLBACK_SCRIPT"
grep -Fq 'sha256sum --check --strict "$checksum_name"' "$ROLLBACK_SCRIPT"
grep -Fq -- '--mount "type=bind,src=${forensic_dir},dst=/output"' "$ROLLBACK_SCRIPT"
if grep -Fq -- '-v "${ROLLBACK_POINT}:/backup"' "$ROLLBACK_SCRIPT"; then
  printf '%s\n' 'Rollback recovery must not grant the root helper write access to the rollback-point root.' >&2
  exit 1
fi
grep -Fq 'restore_source_redis' "$ROLLBACK_SCRIPT"
grep -Fq 'docker run --rm --pull never --network none --read-only' "$ROLLBACK_SCRIPT"
grep -Fq -- '--user 0:0' "$ROLLBACK_SCRIPT"
grep -Fq 'find /restore -mindepth 1 -depth -delete' "$ROLLBACK_SCRIPT"
grep -Fq 'Target stop helper did not immediately verify; requiring stable empty project inventory.' "$ROLLBACK_SCRIPT"
grep -Fq 'containers_stably_absent project_running_container_ids' "$ROLLBACK_SCRIPT"
if grep -Fq 'mv "$REDIS_DATA"' "$ROLLBACK_SCRIPT"; then
  printf '%s\n' 'Rollback recovery must not rename the root-owned Redis data directory.' >&2
  exit 1
fi
grep -Fq 'target_compose stop api worker' "$ROLLBACK_SCRIPT"
grep -Fq 'MCP_LOCAL_HOST_ALLOWLIST' "$ROLLBACK_SCRIPT"
grep -Fq 'mcp-readonly' "$ROLLBACK_SCRIPT"
grep -Fq 'label=com.docker.compose.project=${STACK}' "$ROLLBACK_SCRIPT"
grep -Fq 'install -m 600 "$SERVE_CONFIG" "$SOURCE_SERVE_CONFIG"' "$ROLLBACK_SCRIPT"
grep -Fq 'assert_required_platform_serve "$SERVE_CONFIG" "$TAILSCALE_DNS"' "$ROLLBACK_SCRIPT"
grep -Fq 'serve_matches_expected "$status_file" "$status_json" "$source_serve_target"' "$ROLLBACK_SCRIPT"
if grep -Fq 'serve get-config' "$ROLLBACK_SCRIPT" || grep -Fq 'serve set-config' "$ROLLBACK_SCRIPT"; then
  printf '%s\n' 'Rollback must support legacy Serve status instead of service-config-only commands.' >&2
  exit 1
fi

if grep -Eq 'docker( system)? prune|compose[^\n]*down[^\n]*(--volumes| -v)|systemctl (reboot|poweroff)|(^|[[:space:]])(ufw|iptables|nft)([[:space:]]|$)|rm -rf[^\n]*(DATA_ROOT|POSTGRES_DATA)' "$ROLLBACK_SCRIPT"; then
  printf '%s\n' 'Rollback recovery contains a forbidden destructive host operation.' >&2
  exit 1
fi

printf '%s\n' 'rollback recovery policy tests passed'
