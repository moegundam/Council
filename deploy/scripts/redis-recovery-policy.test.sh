#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

extract_helpers() {
  local script="$1"
  local destination="$2"

  awk '
    /^# REDIS_RECOVERY_HELPERS_BEGIN$/ { capture=1; next }
    /^# REDIS_RECOVERY_HELPERS_END$/ { capture=0 }
    capture
  ' "$script" >"$destination"
  grep -Fq 'archive_failed_redis_state()' "$destination"
  grep -Fq 'restore_redis_archive_in_place()' "$destination"
  bash -n "$destination"
}

exercise_helpers() {
  local script="$1"
  local prefix="$2"
  local helper_file="${TEMP_ROOT}/${prefix}-helpers.sh"
  local case_root="${TEMP_ROOT}/${prefix}-case"
  local redis_data="${case_root}/redis-data"
  local forensic_dir="${case_root}/forensics"
  local failed_archive="${forensic_dir}/redis-data-after-failed.tar.gz"
  local failed_checksum="${failed_archive}.sha256"
  local recovery_source="${case_root}/recovery-source"
  local recovery_archive="${case_root}/redis-data.tar.gz"
  local extraction_failure_archive="${case_root}/extraction-failure.tar.gz"
  local docker_events="${case_root}/docker-events"

  extract_helpers "$script" "$helper_file"
  # shellcheck disable=SC1090
  source "$helper_file"

  mkdir -p "$redis_data" "$recovery_source"
  printf '%s\n' 'failed-state' >"${redis_data}/appendonly.aof"
  printf '%s\n' 'recovered-state' >"${recovery_source}/dump.rdb"
  tar -C "$recovery_source" -czf "$recovery_archive" .
  : >"$docker_events"

  docker() {
    local command="$1"
    shift
    local source_path=""
    local output_path=""
    local backup_path=""
    local restore_path=""
    local failed_name=""
    local host_uid_value=""
    local host_gid_value=""
    local argument
    local mount
    local container_script=""
    local rewritten_script=""
    local effective_backup=""
    local image_value=""
    local saw_network_none=false
    local saw_pull_never=false
    local saw_read_only=false
    local saw_root_user=false
    local saw_no_new_privileges=false
    local saw_rm=false
    local saw_shell=false

    [[ "$command" == run ]] || return 90
    while (( $# > 0 )); do
      argument="$1"
      shift
      case "$argument" in
        --network)
          [[ "${1:-}" == none ]] || return 91
          saw_network_none=true
          shift
          ;;
        --pull)
          [[ "${1:-}" == never ]] || return 92
          saw_pull_never=true
          shift
          ;;
        --rm)
          saw_rm=true
          ;;
        --read-only)
          saw_read_only=true
          ;;
        --user)
          [[ "${1:-}" == 0:0 ]] || return 93
          saw_root_user=true
          shift
          ;;
        --security-opt)
          [[ "${1:-}" == no-new-privileges ]] || return 94
          saw_no_new_privileges=true
          shift
          ;;
        --mount)
          mount="${1:-}"
          shift
          case "$mount" in
            "type=bind,src=${redis_data},dst=/source,readonly") source_path="$redis_data" ;;
            "type=bind,src=${forensic_dir},dst=/output") output_path="$forensic_dir" ;;
            "type=bind,src=${recovery_archive},dst=/backup/redis-data.tar.gz,readonly") backup_path="$recovery_archive" ;;
            "type=bind,src=${redis_data},dst=/restore") restore_path="$redis_data" ;;
            *) printf 'Unexpected %s mount: %s\n' "$prefix" "$mount" >&2; return 95 ;;
          esac
          ;;
        -e)
          case "${1:-}" in
            FAILED_ARCHIVE_NAME=*) failed_name="${1#FAILED_ARCHIVE_NAME=}" ;;
            HOST_UID=*) host_uid_value="${1#HOST_UID=}" ;;
            HOST_GID=*) host_gid_value="${1#HOST_GID=}" ;;
          esac
          shift
          ;;
        sh)
          [[ "$image_value" == "$REDIS_BACKUP_IMAGE" && "${1:-}" == -ec ]] || return 96
          saw_shell=true
          shift
          container_script="${1:-}"
          shift
          ;;
        -*)
          printf 'Unexpected %s Docker option: %s\n' "$prefix" "$argument" >&2
          return 97
          ;;
        *)
          [[ -z "$image_value" && "$argument" == "$REDIS_BACKUP_IMAGE" ]] || return 98
          image_value="$argument"
          ;;
      esac
    done

    [[ "$saw_network_none" == true && "$saw_pull_never" == true \
      && "$saw_read_only" == true && "$saw_root_user" == true \
      && "$saw_no_new_privileges" == true && "$saw_rm" == true \
      && "$saw_shell" == true && "$image_value" == "$REDIS_BACKUP_IMAGE" ]] || return 99

    if [[ -n "$source_path" || -n "$output_path" ]]; then
      [[ -n "$source_path" && -n "$output_path" && -n "$failed_name" \
        && -n "$host_uid_value" && -n "$host_gid_value" \
        && -z "$backup_path" && -z "$restore_path" ]] || return 100
      [[ "$host_uid_value" == "$(id -u)" && "$host_gid_value" == "$(id -g)" \
        && "$container_script" == *'archive="/output/${FAILED_ARCHIVE_NAME}"'* \
        && "$container_script" == *'tar -C /source -czf "$temporary" .'* \
        && "$container_script" == *'tar -tzf "$temporary" >/dev/null'* \
        && "$container_script" == *'mv "$temporary" "$archive"'* \
        && "$container_script" == *'chown "${HOST_UID}:${HOST_GID}" "$archive"'* \
        && "$container_script" == *'chmod 600 "$archive"'* ]] || return 101
      printf '%s\n' 'archive:source-ro,output-rw' >>"$docker_events"
      rewritten_script="${container_script//\/source/$source_path}"
      rewritten_script="${rewritten_script//\/output/$output_path}"
      FAILED_ARCHIVE_NAME="$failed_name" HOST_UID="$host_uid_value" HOST_GID="$host_gid_value" \
        sh -ec "$rewritten_script"
      return
    fi

    [[ -n "$backup_path" && -n "$restore_path" \
      && -z "$source_path" && -z "$output_path" ]] || return 102
    [[ "$container_script" == \
      'find /restore -mindepth 1 -depth -delete && tar -C /restore -xzf /backup/redis-data.tar.gz' ]] \
      || return 103
    printf '%s\n' 'restore:backup-file-ro,redis-rw' >>"$docker_events"
    effective_backup="$backup_path"
    if [[ "${FAKE_RESTORE_FAILURE:-false}" == true ]]; then
      printf '%s\n' 'not-a-tar-stream' >"$extraction_failure_archive"
      effective_backup="$extraction_failure_archive"
    fi
    rewritten_script="${container_script//\/backup\/redis-data.tar.gz/$effective_backup}"
    rewritten_script="${rewritten_script//\/restore/$restore_path}"
    sh -ec "$rewritten_script"
  }

  REDIS_BACKUP_IMAGE=redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232
  archive_failed_redis_state "$redis_data" "$forensic_dir" "$failed_archive"
  [[ -s "$failed_archive" && -s "$failed_checksum" ]]
  validate_redis_backup_archive "$failed_archive"
  (
    cd "$forensic_dir"
    sha256sum --check --strict "$(basename "$failed_checksum")"
  )
  python3 - "$forensic_dir" "$failed_archive" "$failed_checksum" <<'PYTHON'
import os
import stat
import sys

assert stat.S_IMODE(os.stat(sys.argv[1]).st_mode) == 0o700
assert stat.S_IMODE(os.stat(sys.argv[2]).st_mode) == 0o600
assert stat.S_IMODE(os.stat(sys.argv[3]).st_mode) == 0o600
assert os.stat(sys.argv[1]).st_uid == os.getuid()
assert os.stat(sys.argv[1]).st_gid == os.getgid()
assert os.stat(sys.argv[2]).st_uid == os.getuid()
assert os.stat(sys.argv[2]).st_gid == os.getgid()
assert os.stat(sys.argv[3]).st_uid == os.getuid()
assert os.stat(sys.argv[3]).st_gid == os.getgid()
PYTHON

  restore_redis_archive_in_place "$recovery_archive" "$redis_data"
  [[ "$(cat "${redis_data}/dump.rdb")" == recovered-state ]]
  [[ ! -e "${redis_data}/appendonly.aof" ]]
  tar -xOzf "$failed_archive" ./appendonly.aof | grep -qx failed-state
  [[ "$(cat "$docker_events")" == $'archive:source-ro,output-rw\nrestore:backup-file-ro,redis-rw' ]]

  if archive_failed_redis_state "$redis_data" "$forensic_dir" "$failed_archive" >/dev/null 2>&1; then
    printf '%s archive helper overwrote an existing forensic directory.\n' "$prefix" >&2
    exit 1
  fi

  corrupt_archive="${case_root}/corrupt-redis-data.tar.gz"
  printf '%s\n' 'not-a-tar-stream' >"$corrupt_archive"
  docker_event_count="$(wc -l <"$docker_events" | tr -d ' ')"
  printf '%s\n' 'must-survive-invalid-archive' >"${redis_data}/sentinel"
  if restore_redis_archive_in_place "$corrupt_archive" "$redis_data" >/dev/null 2>&1; then
    printf '%s restore helper accepted a corrupt recovery archive.\n' "$prefix" >&2
    exit 1
  fi
  [[ "$(cat "${redis_data}/sentinel")" == must-survive-invalid-archive ]]
  [[ "$(wc -l <"$docker_events" | tr -d ' ')" == "$docker_event_count" ]]

  printf '%s\n' 'must-survive-failure' >"${redis_data}/sentinel"
  recovery_checksum="$(sha256sum "$recovery_archive" | awk '{print $1}')"
  FAKE_RESTORE_FAILURE=true
  if restore_redis_archive_in_place "$recovery_archive" "$redis_data" >/dev/null 2>&1; then
    printf '%s restore helper ignored an extraction failure.\n' "$prefix" >&2
    exit 1
  fi
  [[ ! -e "${redis_data}/sentinel" ]]
  [[ -z "$(find "$redis_data" -mindepth 1 -print -quit)" ]]
  [[ "$(sha256sum "$recovery_archive" | awk '{print $1}')" == "$recovery_checksum" ]]
  unset FAKE_RESTORE_FAILURE
  restore_redis_archive_in_place "$recovery_archive" "$redis_data"
  [[ "$(cat "${redis_data}/dump.rdb")" == recovered-state ]]
}

for runtime_script in "${SCRIPT_DIR}/deploy-remote.sh" "${SCRIPT_DIR}/rollback-remote.sh"; do
  [[ "$(grep -c '^REDIS_BACKUP_IMAGE=' "$runtime_script")" == 1 ]]
  grep -qx 'REDIS_BACKUP_IMAGE=redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232' "$runtime_script"
done

exercise_helpers "${SCRIPT_DIR}/deploy-remote.sh" deploy
exercise_helpers "${SCRIPT_DIR}/rollback-remote.sh" rollback

deploy_helpers="${TEMP_ROOT}/deploy-helpers-compare.sh"
rollback_helpers="${TEMP_ROOT}/rollback-helpers-compare.sh"
extract_helpers "${SCRIPT_DIR}/deploy-remote.sh" "$deploy_helpers"
extract_helpers "${SCRIPT_DIR}/rollback-remote.sh" "$rollback_helpers"
cmp "$deploy_helpers" "$rollback_helpers"

printf '%s\n' 'Redis recovery executable policy tests passed'
