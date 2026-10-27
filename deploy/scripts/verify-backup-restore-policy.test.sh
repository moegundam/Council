#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY_SCRIPT="${SCRIPT_DIR}/verify-backup-restore.sh"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-remote.sh"
TEMP_ROOT="$(mktemp -d)"
STUB_BIN="${TEMP_ROOT}/bin"
REMOTE_BACKUP_DIR="${TEMP_ROOT}/backup"
FAKE_REMOTE_BACKUP=/opt/council/backups/agent-meeting-platform/policy-test/postgres.sql.gz
LOG_FILE="${TEMP_ROOT}/commands.log"
SSH_KEY_FILE="${TEMP_ROOT}/ssh-key"
trap 'rm -rf "$TEMP_ROOT"' EXIT

mkdir -p "$STUB_BIN" "$REMOTE_BACKUP_DIR"
touch "$SSH_KEY_FILE" "${REMOTE_BACKUP_DIR}/postgres.sql.gz"
printf '%064d  postgres.sql.gz\n' 0 >"${REMOTE_BACKUP_DIR}/SHA256SUMS"

cat >"${STUB_BIN}/ssh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh %s\n' "$*" >>"$STUB_LOG_FILE"
test() {
  if [[ "${2:-}" == /opt/council/compose/agent-meeting-platform/* \
    || "${2:-}" == /opt/council/secrets/agent-meeting-platform/* ]]; then
    return 0
  fi
  builtin test "$@"
}
export BACKUP_FILE="$STUB_BACKUP_FILE"
source /dev/stdin
STUB

cat >"${STUB_BIN}/sha256sum" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'sha256sum %s\n' "$*" >>"$STUB_LOG_FILE"
if [[ "${STUB_CHECKSUM_OK:-true}" != true ]]; then
  printf '%s\n' 'postgres.sql.gz: FAILED' >&2
  exit 1
fi
printf '%s\n' 'postgres.sql.gz: OK'
STUB

cat >"${STUB_BIN}/gzip" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'gzip %s\n' "$*" >>"$STUB_LOG_FILE"
if [[ "$1" == "-dc" ]]; then
  printf '%s\n' '-- policy test SQL dump --'
fi
STUB

cat >"${STUB_BIN}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

cat >"${STUB_BIN}/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$STUB_LOG_FILE"
arguments="$*"

if [[ "${1:-}" == compose && "$arguments" == *" ps -q api"* ]]; then
  printf '%s\n' 'production-api-container-id'
  exit 0
fi
  if [[ "$arguments" == *"inspect --format {{.Image}}"* ]]; then
    printf 'sha256:%064d\n' 0
  exit 0
fi
if [[ "${1:-}" == exec && "$arguments" == *" pg_isready "* ]]; then
  exit 0
fi
if [[ "${1:-}" == exec && "$arguments" == *" psql "* ]]; then
  if [[ "$arguments" != *" -c "* ]]; then
    cat >/dev/null
    exit 0
  fi
  if [[ "$arguments" == *"to_regclass"* ]]; then
    if [[ "${STUB_SCHEMA_OK:-true}" == true ]]; then
      printf '\n'
    else
      printf '%s\n' 'role_versions'
    fi
    exit 0
  fi
  if [[ "$arguments" == *"information_schema.columns"* ]]; then
    if [[ "${STUB_COLUMNS_OK:-true}" == true ]]; then
      printf '\n'
    else
      printf '%s\n' 'tool_pack_grants'
    fi
    exit 0
  fi
  if [[ "$arguments" == *"021_utterance_projection_expand"* ]]; then
    [[ "${STUB_MIGRATION_021_OK:-true}" == true ]] && printf '%s\n' 1 || printf '%s\n' 0
    exit 0
  fi
  if [[ "$arguments" == *"022_mcp_connector_location"* ]]; then
    [[ "${STUB_MIGRATION_022_OK:-true}" == true ]] && printf '%s\n' 1 || printf '%s\n' 0
    exit 0
  fi
  if [[ "$arguments" == *"utterance_projection_backfill_progress"* \
    && "$arguments" == *"meeting_utterances"* ]]; then
    [[ "${STUB_PROJECTION_OK:-true}" == true ]] && printf '%s\n' '5|5|t|t|7' || printf '%s\n' '5|4|f|f|4'
    exit 0
  fi
  if [[ "$arguments" == *"count(*) || ':'"* ]]; then
    [[ "${STUB_SINGLETON_OK:-true}" == true ]] && printf '%s\n' '1:1' || printf '%s\n' '2:1'
    exit 0
  fi
  if [[ "$arguments" == *"jsonb_array_length"* ]]; then
    [[ "${STUB_CORE_OK:-true}" == true ]] && printf '%s\n' '2|2|4|5|5|3|3|1|1' || printf '%s\n' '2|2|4|0|5|3|3|1|1'
    exit 0
  fi
fi
if [[ "$arguments" == *"/api/health/ready"* ]]; then
  [[ "${STUB_API_READY:-true}" == true ]]
  exit
fi
if [[ "$arguments" == *"/api/bootstrap"* ]]; then
  if [[ "${STUB_API_DATA_OK:-true}" != true ]]; then
    exit 1
  fi
  printf '%s' '{"groups":2,"categories":2,"tags":4,"threads":5,"meetings":5,"agents":3,"roles":3,"skills":1,"runtimeProfiles":1}'
  exit 0
fi
if [[ "$arguments" == *"SecretVault"* ]]; then
  [[ "${STUB_SECRET_PROOF_OK:-true}" == true ]] || exit 1
  printf '%s\n' 'encrypted_secret_proof=passed count=1'
  exit 0
fi
exit 0
STUB

chmod +x "${STUB_BIN}/ssh" "${STUB_BIN}/sha256sum" "${STUB_BIN}/gzip" \
  "${STUB_BIN}/sleep" "${STUB_BIN}/docker"

run_verifier() {
  env \
    PATH="${STUB_BIN}:${PATH}" \
    REMOTE_TARGET=operator@council.example \
    SSH_KEY="$SSH_KEY_FILE" \
    REMOTE_JUMP='' \
    STUB_LOG_FILE="$LOG_FILE" \
    STUB_BACKUP_FILE="${REMOTE_BACKUP_DIR}/postgres.sql.gz" \
    STUB_CHECKSUM_OK="${STUB_CHECKSUM_OK:-true}" \
    STUB_SCHEMA_OK="${STUB_SCHEMA_OK:-true}" \
    STUB_COLUMNS_OK="${STUB_COLUMNS_OK:-true}" \
    STUB_MIGRATION_OK="${STUB_MIGRATION_OK:-true}" \
    STUB_PROJECTION_OK="${STUB_PROJECTION_OK:-true}" \
    STUB_SINGLETON_OK="${STUB_SINGLETON_OK:-true}" \
    STUB_CORE_OK="${STUB_CORE_OK:-true}" \
    STUB_API_READY="${STUB_API_READY:-true}" \
    STUB_API_DATA_OK="${STUB_API_DATA_OK:-true}" \
    STUB_SECRET_PROOF_OK="${STUB_SECRET_PROOF_OK:-true}" \
    bash "$VERIFY_SCRIPT" "$@"
}

assert_failure() {
  local label="$1"
  local expected="$2"
  shift 2
  local output
  local status

  set +e
  output="$(run_verifier "$@" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf '%s unexpectedly passed.\n' "$label" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected"* ]]; then
    printf '%s failed for the wrong reason:\n%s\n' "$label" "$output" >&2
    exit 1
  fi
}

assert_failure explicit-run 'requires explicit --run' "$FAKE_REMOTE_BACKUP"
assert_failure unsafe-path 'Backup path contains an unsafe component' --run \
  '/opt/council/backups/agent-meeting-platform/../escape/postgres.sql.gz'

: >"$LOG_FILE"
set +e
happy_output="$(run_verifier --run "$FAKE_REMOTE_BACKUP" 2>&1)"
happy_status=$?
set -e
if [[ "$happy_status" -ne 0 ]]; then
  printf 'Happy-path restore verification failed:\n%s\n' "$happy_output" >&2
  printf '%s\n' 'Command log:' >&2
  sed -n '1,240p' "$LOG_FILE" >&2
  exit 1
fi
[[ "$happy_output" == *'Restore verification passed.'* ]]
[[ "$happy_output" == *'migration=021_utterance_projection_expand'* ]]
[[ "$happy_output" == *'migration=022_mcp_connector_location'* ]]
grep -Fq 'sha256sum --check --strict SHA256SUMS' "$LOG_FILE"
grep -Fq 'docker network create --internal --attachable' "$LOG_FILE"
grep -Fq 'docker compose --project-name agent-meeting-platform' "$LOG_FILE"
  grep -Fq '/api/bootstrap' "$LOG_FILE"
  grep -Fq 'SecretVault' "$LOG_FILE"
  grep -Fq 'inspect --format {{.Image}} production-api-container-id' "$LOG_FILE"
  if grep -Fq '{{.Config.Image}}' "$VERIFY_SCRIPT"; then
    printf '%s\n' 'Restore verification must use the immutable container image ID, not a mutable image tag.' >&2
    exit 1
  fi
for required_table in runtime_profiles runtime_profile_revisions tool_packs tool_pack_revisions \
  meeting_utterances utterance_projection_backfill_progress; do
  grep -Fq "('$required_table')" "$VERIFY_SCRIPT"
done
grep -Fq 'cd "$BACKUP_DIR"' "$BACKUP_SCRIPT"
grep -Fq 'sha256sum postgres.sql.gz >SHA256SUMS' "$BACKUP_SCRIPT"
grep -Fq 'MCP_LOCAL_HOST_ALLOWLIST=mcp-readonly' "$VERIFY_SCRIPT"
if grep -Fq 'sha256sum "${BACKUP_DIR}/postgres.sql.gz"' "$BACKUP_SCRIPT"; then
  printf '%s\n' 'Backup checksum entries must use the portable relative filename.' >&2
  exit 1
fi

STUB_CHECKSUM_OK=false assert_failure checksum 'postgres.sql.gz: FAILED' --run "$FAKE_REMOTE_BACKUP"
STUB_SCHEMA_OK=false assert_failure schema 'missing expected tables: role_versions' --run "$FAKE_REMOTE_BACKUP"
STUB_COLUMNS_OK=false assert_failure columns 'agent_revisions columns: tool_pack_grants' --run "$FAKE_REMOTE_BACKUP"
STUB_MIGRATION_021_OK=false assert_failure migration-021 'missing migration 021_utterance_projection_expand' --run "$FAKE_REMOTE_BACKUP"
STUB_MIGRATION_022_OK=false assert_failure migration-022 'missing migration 022_mcp_connector_location' --run "$FAKE_REMOTE_BACKUP"
STUB_PROJECTION_OK=false assert_failure projection 'Utterance projection restore proof failed' --run "$FAKE_REMOTE_BACKUP"
STUB_SINGLETON_OK=false assert_failure singleton 'must contain exactly the singleton row' --run "$FAKE_REMOTE_BACKUP"
STUB_CORE_OK=false assert_failure core-state 'core collection threads must be nonempty' --run "$FAKE_REMOTE_BACKUP"
STUB_API_DATA_OK=false assert_failure api-proof 'API bootstrap data proof failed' --run "$FAKE_REMOTE_BACKUP"
STUB_SECRET_PROOF_OK=false assert_failure secret-proof 'secret decryption proof failed' --run "$FAKE_REMOTE_BACKUP"

if grep -Eq 'docker( system)? prune|compose[^[:cntrl:]]* down[^[:cntrl:]]*(--volumes| -v)|systemctl (reboot|poweroff)|(^|[[:space:]])(ufw|iptables|nft)([[:space:]]|$)' "$VERIFY_SCRIPT"; then
  printf '%s\n' 'Restore verifier contains a forbidden destructive host operation.' >&2
  exit 1
fi

printf '%s\n' 'backup restore verification policy tests passed'
