#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]{8}T[0-9]{6}Z$ || "${2:-}" != "--confirm" ]]; then
  printf 'Usage: %s YYYYMMDDTHHMMSSZ --confirm\n' "$0" >&2
  exit 1
fi

remote_ssh "VERSION='${VERSION}' bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
BACKUPS_ROOT="${ROOT}/backups/${STACK}"
RELEASES_ROOT="${ROOT}/releases/${STACK}"
RELEASE_ROOT="${ROOT}/releases/${STACK}/${VERSION}"
ENV_FILE="${COMPOSE_DIR}/.env"
TARGET_COMPOSE="${RELEASE_ROOT}/deploy/compose.yaml"
TARGET_MANIFEST="${RELEASE_ROOT}/release-manifest.json"
TEMP_ROOT="$(mktemp -d "${COMPOSE_DIR}/.rollback-${VERSION}.XXXXXX")"
TARGET_ENV="${TEMP_ROOT}/target.env"
TARGET_CONFIG_JSON="${TEMP_ROOT}/target-compose.json"
SERVE_STATUS="${TEMP_ROOT}/tailscale-serve-status"
SERVE_CONFIG="${TEMP_ROOT}/tailscale-serve-status.json"
PRE_CUTOVER_SERVE_STATUS="${TEMP_ROOT}/tailscale-serve-pre-cutover.txt"
PRE_CUTOVER_SERVE_JSON="${TEMP_ROOT}/tailscale-serve-pre-cutover.json"
CURRENT_RELEASE="${RELEASES_ROOT}/current"
ROLLBACK_POINT=
SOURCE_COMPOSE=
SOURCE_ENV=
SOURCE_DUMP=
SOURCE_REDIS_BACKUP=
SOURCE_SERVE_CONFIG=
SOURCE_VERSION=
TAILSCALE_DNS=
source_current_kind=absent
source_current_target=
source_serve_target=http://127.0.0.1:8787
recovery_required=false
candidate_data_may_have_changed=false
rollback_committed=false
recovery_running=false

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

test -f "$TARGET_COMPOSE"
test -f "$TARGET_MANIFEST"
test -f "${RELEASE_ROOT}/deploy/Dockerfile"
test -f "${RELEASE_ROOT}/deploy/Caddyfile"
test -f "${COMPOSE_DIR}/compose.yaml"
test -f "$ENV_FILE"
if [[ "$(stat -c '%a' -- "$ENV_FILE")" != "600" ]]; then
  printf '%s\n' 'Current deployment .env must have mode 600.' >&2
  exit 1
fi

cp "$ENV_FILE" "$TARGET_ENV"
chmod 600 "$TARGET_ENV"
sed -i "s|^RELEASE_VERSION=.*|RELEASE_VERSION=${VERSION}|" "$TARGET_ENV"
sed -i "s|^RELEASE_ROOT=.*|RELEASE_ROOT=${RELEASE_ROOT}|" "$TARGET_ENV"

env_file_value() {
  local env_file="$1"
  local key="$2"

  awk -F= -v key="$key" '
    $1 == key {
      sub(/^[^=]*=/, "")
      value=$0
      count++
    }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$env_file"
}

target_env_value() {
  local key="$1"
  env_file_value "$TARGET_ENV" "$key"
}

required_settings=(
  RELEASE_VERSION RELEASE_ROOT DATA_ROOT SECRETS_ROOT PUBLIC_ORIGIN APP_UID APP_GID
  AUTH_DISABLED ALLOW_PRODUCTION_AUTH_BYPASS MCP_LOCAL_HOST_ALLOWLIST
  MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED MCP_KEYED_FINGERPRINT_WRITE_ENABLED MCP_LEGACY_ARGUMENT_READER_ENABLED
)
if grep -Fq 'GOAL_RUN_AUTONOMY_ENABLED' "$TARGET_COMPOSE"; then
  required_settings+=(GOAL_RUN_AUTONOMY_ENABLED)
fi
if grep -Fq 'HARNESS_ACTION_ADAPTER_ENABLED' "$TARGET_COMPOSE"; then
  required_settings+=(HARNESS_ACTION_ADAPTER_ENABLED)
fi
if grep -Fq 'TAILNET_QUICK_LOGIN_ENABLED' "$TARGET_COMPOSE"; then
  required_settings+=(TAILNET_QUICK_LOGIN_ENABLED)
fi
if grep -Fq 'DOCKER_HOST_GATEWAY' "$TARGET_COMPOSE"; then
  if ! target_env_value DOCKER_HOST_GATEWAY >/dev/null; then
    docker_host_gateway="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
    if [[ -z "$docker_host_gateway" ]]; then
      printf '%s\n' 'Unable to determine the Docker host gateway required by the rollback target.' >&2
      exit 1
    fi
    sed -i '/^DOCKER_HOST_GATEWAY=/d' "$TARGET_ENV"
    printf 'DOCKER_HOST_GATEWAY=%s\n' "$docker_host_gateway" >>"$TARGET_ENV"
  fi
  required_settings+=(DOCKER_HOST_GATEWAY)
fi
for setting in "${required_settings[@]}"; do
  if ! target_env_value "$setting" >/dev/null; then
    printf 'Rollback setting must occur exactly once and be non-empty: %s\n' "$setting" >&2
    exit 1
  fi
done

DATA_ROOT="$(target_env_value DATA_ROOT)"
REDIS_DATA="${DATA_ROOT}/redis"
REDIS_BACKUP_IMAGE=redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232
SECRETS_ROOT="$(target_env_value SECRETS_ROOT)"
AUTH_DISABLED="$(target_env_value AUTH_DISABLED)"
ALLOW_PRODUCTION_AUTH_BYPASS="$(target_env_value ALLOW_PRODUCTION_AUTH_BYPASS)"
GOAL_RUN_AUTONOMY_ENABLED="false"
if grep -Fq 'GOAL_RUN_AUTONOMY_ENABLED' "$TARGET_COMPOSE"; then
  GOAL_RUN_AUTONOMY_ENABLED="$(target_env_value GOAL_RUN_AUTONOMY_ENABLED)"
fi
HARNESS_ACTION_ADAPTER_ENABLED="false"
if grep -Fq 'HARNESS_ACTION_ADAPTER_ENABLED' "$TARGET_COMPOSE"; then
  HARNESS_ACTION_ADAPTER_ENABLED="$(target_env_value HARNESS_ACTION_ADAPTER_ENABLED)"
fi
TAILNET_QUICK_LOGIN_ENABLED="false"
if grep -Fq 'TAILNET_QUICK_LOGIN_ENABLED' "$TARGET_COMPOSE"; then
  TAILNET_QUICK_LOGIN_ENABLED="$(target_env_value TAILNET_QUICK_LOGIN_ENABLED)"
fi
MCP_LOCAL_HOST_ALLOWLIST="$(target_env_value MCP_LOCAL_HOST_ALLOWLIST)"
MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED="$(target_env_value MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED)"
MCP_KEYED_FINGERPRINT_WRITE_ENABLED="$(target_env_value MCP_KEYED_FINGERPRINT_WRITE_ENABLED)"
MCP_LEGACY_ARGUMENT_READER_ENABLED="$(target_env_value MCP_LEGACY_ARGUMENT_READER_ENABLED)"
SOURCE_VERSION="$(env_file_value "$ENV_FILE" RELEASE_VERSION)"
if [[ ! "$SOURCE_VERSION" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf '%s\n' 'Current deployment release version is invalid.' >&2
  exit 1
fi

if [[ "$(target_env_value RELEASE_VERSION)" != "$VERSION" || "$(target_env_value RELEASE_ROOT)" != "$RELEASE_ROOT" ]]; then
  printf '%s\n' 'Rollback release settings do not match the requested target.' >&2
  exit 1
fi
if [[ "$DATA_ROOT" != "${ROOT}/data/${STACK}" || "$SECRETS_ROOT" != "${ROOT}/secrets/${STACK}" ]]; then
  printf '%s\n' 'Rollback data or secrets root does not match the platform stack.' >&2
  exit 1
fi
if [[ ! "$(target_env_value APP_UID)" =~ ^[0-9]+$ || ! "$(target_env_value APP_GID)" =~ ^[0-9]+$ ]]; then
  printf '%s\n' 'Rollback APP_UID and APP_GID must be numeric.' >&2
  exit 1
fi
if [[ "$AUTH_DISABLED" != "true" && "$AUTH_DISABLED" != "false" ]]; then
  printf '%s\n' 'Rollback AUTH_DISABLED must be true or false.' >&2
  exit 1
fi
if [[ "$ALLOW_PRODUCTION_AUTH_BYPASS" != "true" && "$ALLOW_PRODUCTION_AUTH_BYPASS" != "false" ]]; then
  printf '%s\n' 'Rollback ALLOW_PRODUCTION_AUTH_BYPASS must be true or false.' >&2
  exit 1
fi
if [[ "$GOAL_RUN_AUTONOMY_ENABLED" != "true" && "$GOAL_RUN_AUTONOMY_ENABLED" != "false" ]]; then
  printf '%s\n' 'Rollback GOAL_RUN_AUTONOMY_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$HARNESS_ACTION_ADAPTER_ENABLED" != "true" && "$HARNESS_ACTION_ADAPTER_ENABLED" != "false" ]]; then
  printf '%s\n' 'Rollback HARNESS_ACTION_ADAPTER_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$HARNESS_ACTION_ADAPTER_ENABLED" == "true" ]] && ! target_env_value HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST >/dev/null; then
  printf '%s\n' 'Rollback Harness Action Adapter requires HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST.' >&2
  exit 1
fi
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" != "true" && "$TAILNET_QUICK_LOGIN_ENABLED" != "false" ]]; then
  printf '%s\n' 'Rollback TAILNET_QUICK_LOGIN_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" == "true" ]]; then
  if ! target_env_value TAILNET_QUICK_LOGIN_IDENTITY >/dev/null \
    || ! target_env_value TAILNET_QUICK_LOGIN_OWNER_EMAIL >/dev/null; then
    printf '%s\n' 'Rollback Tailnet quick login requires its identity and Owner email.' >&2
    exit 1
  fi
fi
if [[ "$MCP_LOCAL_HOST_ALLOWLIST" != "mcp-readonly" ]]; then
  printf '%s\n' 'Rollback MCP_LOCAL_HOST_ALLOWLIST must be mcp-readonly.' >&2
  exit 1
fi
for value in \
  "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" \
  "$MCP_KEYED_FINGERPRINT_WRITE_ENABLED" \
  "$MCP_LEGACY_ARGUMENT_READER_ENABLED"; do
  if [[ "$value" != "true" && "$value" != "false" ]]; then
    printf '%s\n' 'Rollback MCP compatibility settings must be true or false.' >&2
    exit 1
  fi
done
if [[ "$MCP_LEGACY_ARGUMENT_READER_ENABLED" == "false" \
  && "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" != "true" ]]; then
  printf '%s\n' 'Rollback cannot disable the legacy MCP reader while encrypted writes are disabled.' >&2
  exit 1
fi
if [[ "$AUTH_DISABLED" == "true" && "$ALLOW_PRODUCTION_AUTH_BYPASS" != "true" ]]; then
  printf '%s\n' 'Rollback production auth bypass is not explicitly allowed.' >&2
  exit 1
fi
test -d "$DATA_ROOT"
test -w "$DATA_ROOT"
if [[ ! -d "$SECRETS_ROOT" || "$(stat -c '%a' -- "$SECRETS_ROOT")" != "700" ]]; then
  printf '%s\n' 'Rollback secrets root must exist with mode 700.' >&2
  exit 1
fi

validate_secret() {
  local secret_name="$1"
  local secret_path="${SECRETS_ROOT}/${secret_name}"
  local secret_mode

  if [[ ! -f "$secret_path" || -L "$secret_path" || ! -s "$secret_path" ]]; then
    printf 'Required rollback secret must be a non-empty regular file: %s\n' "$secret_path" >&2
    exit 1
  fi
  secret_mode="$(stat -c '%a' -- "$secret_path")"
  if [[ "$secret_mode" != "600" ]]; then
    printf 'Required rollback secret must have mode 600: %s (mode %s)\n' "$secret_path" "$secret_mode" >&2
    exit 1
  fi
}

for secret_name in postgres_password app_master_key gb10_model_tunnel_key gb10_known_hosts; do
  validate_secret "$secret_name"
done

target_compose() {
  docker compose --project-name "$STACK" --env-file "$TARGET_ENV" -f "$TARGET_COMPOSE" "$@" </dev/null
}

target_compose config --quiet
target_compose config --format json >"$TARGET_CONFIG_JSON"
if target_compose config --services | grep -qx 'task-adapter-reference'; then
  validate_secret task_adapter_token
fi
python3 - "$TARGET_CONFIG_JSON" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as config_file:
    config = json.load(config_file)

required_services = (
    "postgres",
    "redis",
    "api",
    "worker",
    "web",
    "mcp-readonly",
    "model-tunnel",
    "gateway",
)
services = config.get("services", {})
if "task-adapter-reference" in services:
    required_services += ("task-adapter-reference",)
missing = [name for name in required_services if name not in services]
without_healthchecks = [
    name for name in required_services
    if name in services and name != "worker" and not services[name].get("healthcheck")
]
if missing or without_healthchecks:
    if missing:
        print(f"Rollback compose is missing long-lived services: {', '.join(missing)}", file=sys.stderr)
    if without_healthchecks:
        print(
            "Rollback compose services lack healthchecks: " + ", ".join(without_healthchecks),
            file=sys.stderr,
        )
    raise SystemExit(1)
PYTHON

mapfile -t target_images < <(
  python3 -c 'import json,sys; c=json.load(open(sys.argv[1], encoding="utf-8")); print("\n".join(sorted({s["image"] for s in c["services"].values()})))' \
    "$TARGET_CONFIG_JSON"
)
if (( ${#target_images[@]} == 0 )); then
  printf '%s\n' 'Rollback target compose resolved no images.' >&2
  exit 1
fi
for image in "${target_images[@]}"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf 'Rollback target image is not present locally: %s\n' "$image" >&2
    exit 1
  fi
done

# TAILSCALE_SERVE_PREFLIGHT_POLICY_BEGIN
assert_required_platform_serve() {
  local config_file="$1"
  local dns_name="$2"

  python3 - "$config_file" "$dns_name" <<'PYTHON'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
dns_name = sys.argv[2]
tcp_entry = config.get("TCP", {}).get("8444")
handler = config.get("Web", {}).get(f"{dns_name}:8444")
if tcp_entry is None or not isinstance(handler, dict):
    raise SystemExit("Required Tailscale Serve 8444 rule is missing or incomplete.")
target = handler.get("Handlers", {}).get("/", {}).get("Proxy")
if target != "http://127.0.0.1:8787":
    raise SystemExit("Tailscale Serve 8444 must target http://127.0.0.1:8787.")
PYTHON
}
# TAILSCALE_SERVE_PREFLIGHT_POLICY_END

if tailscale serve status >"$SERVE_STATUS" 2>/dev/null; then
  TAILSCALE_STATUS=(tailscale)
elif sudo -n tailscale serve status >"$SERVE_STATUS" 2>/dev/null; then
  TAILSCALE_STATUS=(sudo -n tailscale)
else
  printf '%s\n' 'Unable to read the pre-provisioned Tailscale Serve configuration.' >&2
  exit 1
fi
if ! "${TAILSCALE_STATUS[@]}" serve status --json >"$SERVE_CONFIG" \
  || [[ ! -s "$SERVE_CONFIG" ]]; then
  printf '%s\n' 'Unable to capture the complete Tailscale Serve status.' >&2
  exit 1
fi
TAILSCALE_DNS="$(
  "${TAILSCALE_STATUS[@]}" status --json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
)"
if [[ -z "$TAILSCALE_DNS" ]]; then
  printf '%s\n' 'Unable to determine the Tailscale DNS name.' >&2
  exit 1
fi
assert_required_platform_serve "$SERVE_CONFIG" "$TAILSCALE_DNS"

if [[ -L "$CURRENT_RELEASE" ]]; then
  source_current_kind=symlink
  source_current_target="$(readlink "$CURRENT_RELEASE")"
elif [[ -e "$CURRENT_RELEASE" ]]; then
  printf '%s\n' 'Current release pointer is not a symlink; refusing rollback.' >&2
  exit 1
fi

mkdir -p "$BACKUPS_ROOT"
chmod 700 "$BACKUPS_ROOT"
ROLLBACK_POINT="$(mktemp -d "${BACKUPS_ROOT}/rollback-point-${SOURCE_VERSION}-before-${VERSION}.XXXXXX")"
chmod 700 "$ROLLBACK_POINT"
SOURCE_COMPOSE="${ROLLBACK_POINT}/compose.yaml"
SOURCE_ENV="${ROLLBACK_POINT}/compose.env"
SOURCE_DUMP="${ROLLBACK_POINT}/postgres.sql.gz"
SOURCE_REDIS_BACKUP="${ROLLBACK_POINT}/redis-data.tar.gz"
SOURCE_SERVE_CONFIG="${ROLLBACK_POINT}/tailscale-serve-before.json"
cp -a "${COMPOSE_DIR}/compose.yaml" "$SOURCE_COMPOSE"
cp -a "$ENV_FILE" "$SOURCE_ENV"
install -m 600 "$SERVE_STATUS" "${ROLLBACK_POINT}/tailscale-serve-before.txt"
install -m 600 "$SERVE_CONFIG" "$SOURCE_SERVE_CONFIG"
if [[ "$source_current_kind" == "symlink" ]]; then
  printf '%s\n' "$source_current_target" >"${ROLLBACK_POINT}/current-release.target"
else
  printf '%s\n' 'absent' >"${ROLLBACK_POINT}/current-release.target"
fi

source_compose() {
  docker compose --project-name "$STACK" --env-file "$SOURCE_ENV" -f "$SOURCE_COMPOSE" "$@" </dev/null
}

manifest_supports_mcp_reader() {
  local manifest="$1"
  local reader="$2"

  python3 - "$manifest" "$reader" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
readers = manifest.get("queueCapabilities", {}).get("mcpArgumentPayloadReaders", [])
raise SystemExit(0 if sys.argv[2] in readers else 1)
PYTHON
}

manifest_supports_queue_capability() {
  local manifest="$1"
  local capability="$2"
  local value="$3"

  python3 - "$manifest" "$capability" "$value" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as manifest_file:
    manifest = json.load(manifest_file)
values = manifest.get("queueCapabilities", {}).get(sys.argv[2], [])
raise SystemExit(0 if sys.argv[3] in values else 1)
PYTHON
}

if ! manifest_supports_queue_capability "$TARGET_MANIFEST" mcpFailureReceipts argument_free_v1; then
  printf '%s\n' 'Rollback target must support argument-free MCP failure receipts.' >&2
  exit 1
fi
if [[ "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" == "true" ]] \
  && ! manifest_supports_mcp_reader "$TARGET_MANIFEST" vault_v1; then
  printf '%s\n' 'Rollback target cannot preserve encrypted MCP writes without a vault_v1 reader.' >&2
  exit 1
fi
if [[ "$MCP_KEYED_FINGERPRINT_WRITE_ENABLED" == "true" ]] \
  && { ! manifest_supports_queue_capability "$TARGET_MANIFEST" mcpRequestFingerprintReaders hmac_sha256_v1 \
    || ! manifest_supports_queue_capability "$TARGET_MANIFEST" mcpAdmissionProtocols atomic_v1; }; then
  printf '%s\n' 'Rollback target cannot preserve keyed MCP writes without HMAC reader and atomic admission.' >&2
  exit 1
fi

source_queue_contains_mcp_payload() {
  local encoding="$1"
  local status

  if source_compose run --rm --no-deps worker \
    node dist/mcp-queue-compatibility-cli.js "$encoding"; then
    return 0
  else
    status=$?
  fi
  [[ "$status" -eq 10 ]] && return 1
  return 2
}

source_database_contains_mcp_reservation() {
  local value
  value="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT EXISTS (SELECT 1 FROM platform_state AS platform CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entry(item) WHERE COALESCE(item->>'kind', 'agent_turn') = 'mcp_tool_call');")" || return 2
  [[ "$value" == "t" ]] && return 0
  [[ "$value" == "f" ]] && return 1
  return 2
}

source_database_contains_keyed_mcp_fingerprint() {
  local value
  value="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT EXISTS (SELECT 1 FROM platform_state AS platform CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb) || COALESCE(platform.state->'toolRuns', '[]'::jsonb)) AS entry(item) WHERE COALESCE(item->>'requestFingerprint', '') LIKE 'hmac-sha256:v1:%');")" || return 2
  [[ "$value" == "t" ]] && return 0
  [[ "$value" == "f" ]] && return 1
  return 2
}

# GOAL_RUN_ROLLBACK_PREFLIGHT_POLICY_BEGIN
source_database_contains_unsafe_goal_run() {
  local table_exists
  local value

  table_exists="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT to_regclass('public.goal_runs') IS NOT NULL;")" || return 2
  [[ "$table_exists" == "f" ]] && return 1
  [[ "$table_exists" == "t" ]] || return 2
  value="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT EXISTS (SELECT 1 FROM goal_runs WHERE state NOT IN ('paused', 'completed', 'failed', 'cancelled'));")" || return 2
  [[ "$value" == "t" ]] && return 0
  [[ "$value" == "f" ]] && return 1
  return 2
}

source_database_contains_active_goal_task_binding() {
  local table_exists
  local value

  table_exists="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT to_regclass('public.goal_task_bindings') IS NOT NULL;")" || return 2
  [[ "$table_exists" == "f" ]] && return 1
  [[ "$table_exists" == "t" ]] || return 2
  value="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT EXISTS (SELECT 1 FROM goal_task_bindings WHERE state IN ('running', 'reviewing') OR active_job_id IS NOT NULL);")" || return 2
  [[ "$value" == "t" ]] && return 0
  [[ "$value" == "f" ]] && return 1
  return 2
}

source_database_contains_nonsettled_goal_job_admission() {
  local table_exists
  local value

  table_exists="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT to_regclass('public.goal_job_admissions') IS NOT NULL;")" || return 2
  [[ "$table_exists" == "f" ]] && return 1
  [[ "$table_exists" == "t" ]] || return 2
  value="$(source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT EXISTS (SELECT 1 FROM goal_job_admissions WHERE state <> 'settled');")" || return 2
  [[ "$value" == "t" ]] && return 0
  [[ "$value" == "f" ]] && return 1
  return 2
}

source_queue_contains_active_goal_work() {
  local value

  value="$(source_compose exec -T redis redis-cli --raw EVAL '
local prefix = ARGV[1]
local list_states = {"wait", "paused", "active"}
local zset_states = {"delayed", "prioritized", "waiting-children"}

local function contains_goal_job(ids)
  for _, job_id in ipairs(ids) do
    local name = redis.call("HGET", prefix .. ":" .. job_id, "name")
    if name and string.sub(name, 1, 5) == "goal-" then
      return true
    end
  end
  return false
end

for _, state in ipairs(list_states) do
  local key = prefix .. ":" .. state
  local kind = redis.call("TYPE", key).ok
  if kind ~= "none" then
    if kind ~= "list" then return redis.error_reply("Unexpected BullMQ " .. state .. " key type: " .. kind) end
    if contains_goal_job(redis.call("LRANGE", key, 0, -1)) then return 1 end
  end
end
for _, state in ipairs(zset_states) do
  local key = prefix .. ":" .. state
  local kind = redis.call("TYPE", key).ok
  if kind ~= "none" then
    if kind ~= "zset" then return redis.error_reply("Unexpected BullMQ " .. state .. " key type: " .. kind) end
    if contains_goal_job(redis.call("ZRANGE", key, 0, -1)) then return 1 end
  end
end
return 0
' 0 'bull:council-background-jobs')" || return 2
  [[ "$value" == "1" ]] && return 0
  [[ "$value" == "0" ]] && return 1
  return 2
}

assert_goal_run_rollback_safe() {
  local status

  for check in \
    source_database_contains_unsafe_goal_run \
    source_database_contains_active_goal_task_binding \
    source_database_contains_nonsettled_goal_job_admission \
    source_queue_contains_active_goal_work; do
    set +e
    "$check"
    status=$?
    set -e
    if [[ "$status" == "0" ]]; then
      printf 'Goal Run rollback preflight found active state: %s. Drain or settle Goal Run work before rollback.\n' "$check" >&2
      return 1
    fi
    if [[ "$status" != "1" ]]; then
      printf 'Goal Run rollback preflight could not verify state: %s. Refusing rollback.\n' "$check" >&2
      return 1
    fi
  done
}
# GOAL_RUN_ROLLBACK_PREFLIGHT_POLICY_END

create_rollback_point_database_backup() {
  local dump_tmp="${ROLLBACK_POINT}/.postgres.sql.gz.tmp"

  rm -f "$dump_tmp"
  if ! source_compose exec -T postgres \
    pg_dump --clean --if-exists --no-owner --no-privileges -U council -d council \
    | gzip -9 >"$dump_tmp"; then
    rm -f "$dump_tmp"
    return 1
  fi
  if [[ ! -s "$dump_tmp" ]] || ! gzip -t "$dump_tmp"; then
    rm -f "$dump_tmp"
    return 1
  fi
  mv "$dump_tmp" "$SOURCE_DUMP"
}

# REDIS_RECOVERY_HELPERS_BEGIN
validate_redis_backup_archive() {
  local archive="$1"

  python3 - "$archive" <<'PYTHON'
from pathlib import PurePosixPath
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    members = archive.getmembers()
    if not members or not any(member.isfile() for member in members):
        raise SystemExit("Redis recovery archive contains no files.")
    for member in members:
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
            raise SystemExit("Redis recovery archive contains an unsafe path or link.")
PYTHON
}

archive_failed_redis_state() {
  local redis_data="$1"
  local forensic_dir="$2"
  local failed_archive="$3"
  local archive_name
  local checksum_name
  local checksum_tmp
  local host_gid
  local host_uid

  archive_name="$(basename "$failed_archive")"
  checksum_name="${archive_name}.sha256"
  checksum_tmp=".${checksum_name}.tmp"
  if [[ ! -d "$redis_data" || -L "$redis_data" \
    || "$(dirname "$failed_archive")" != "$forensic_dir" \
    || -e "$forensic_dir" || -L "$forensic_dir" ]]; then
    return 1
  fi
  install -d -m 700 "$forensic_dir"
  host_uid="$(id -u)"
  host_gid="$(id -g)"
  if ! docker run --rm --pull never --user 0:0 --network none --read-only --security-opt no-new-privileges \
    -e FAILED_ARCHIVE_NAME="$archive_name" -e HOST_UID="$host_uid" -e HOST_GID="$host_gid" \
    --mount "type=bind,src=${redis_data},dst=/source,readonly" \
    --mount "type=bind,src=${forensic_dir},dst=/output" \
    "$REDIS_BACKUP_IMAGE" sh -ec '
      archive="/output/${FAILED_ARCHIVE_NAME}"
      temporary="${archive}.tmp"
      tar -C /source -czf "$temporary" .
      tar -tzf "$temporary" >/dev/null
      mv "$temporary" "$archive"
      chown "${HOST_UID}:${HOST_GID}" "$archive"
      chmod 600 "$archive"
    '; then
    return 1
  fi
  if ! validate_redis_backup_archive "$failed_archive"; then
    return 1
  fi
  (
    cd "$forensic_dir"
    sha256sum "$archive_name" >"$checksum_tmp"
    mv "$checksum_tmp" "$checksum_name"
    chmod 600 "$checksum_name"
    sha256sum --check --strict "$checksum_name"
  )
}

restore_redis_archive_in_place() {
  local recovery_archive="$1"
  local redis_data="$2"

  if [[ ! -f "$recovery_archive" || -L "$recovery_archive" \
    || ! -d "$redis_data" || -L "$redis_data" ]]; then
    return 1
  fi
  if ! validate_redis_backup_archive "$recovery_archive"; then
    return 1
  fi
  docker run --rm --pull never --user 0:0 --network none --read-only --security-opt no-new-privileges \
    --mount "type=bind,src=${recovery_archive},dst=/backup/redis-data.tar.gz,readonly" \
    --mount "type=bind,src=${redis_data},dst=/restore" \
    "$REDIS_BACKUP_IMAGE" sh -ec \
    'find /restore -mindepth 1 -depth -delete && tar -C /restore -xzf /backup/redis-data.tar.gz'
}
# REDIS_RECOVERY_HELPERS_END

create_rollback_point_redis_backup() {
  local archive_tmp="${ROLLBACK_POINT}/.redis-data.tar.gz.tmp"

  if [[ ! -d "$REDIS_DATA" || -L "$REDIS_DATA" ]]; then
    printf '%s\n' 'Redis data path must be a real directory before rollback backup.' >&2
    return 1
  fi
  if [[ -n "$(source_compose ps --status running --quiet redis 2>/dev/null)" ]]; then
    printf '%s\n' 'Redis must be stopped before the rollback recovery archive is created.' >&2
    return 1
  fi
  rm -f "$archive_tmp"
  if ! docker run --rm --pull never --network none --read-only --security-opt no-new-privileges \
    -v "${REDIS_DATA}:/source:ro" \
    "$REDIS_BACKUP_IMAGE" sh -ec 'tar -C /source -czf - .' >"$archive_tmp"; then
    rm -f "$archive_tmp"
    return 1
  fi
  if [[ ! -s "$archive_tmp" ]] || ! validate_redis_backup_archive "$archive_tmp"; then
    rm -f "$archive_tmp"
    return 1
  fi
  mv "$archive_tmp" "$SOURCE_REDIS_BACKUP"
}

seal_rollback_point_recovery_backup() {
  local checksum_tmp="${ROLLBACK_POINT}/.SHA256SUMS.tmp"

  if [[ ! -s "$SOURCE_DUMP" || ! -s "$SOURCE_REDIS_BACKUP" ]]; then
    return 1
  fi
  (
    cd "$ROLLBACK_POINT"
    sha256sum postgres.sql.gz redis-data.tar.gz >"$checksum_tmp"
    mv "$checksum_tmp" SHA256SUMS
    sha256sum --check SHA256SUMS
  )
}

postgres_container="$(source_compose ps --status running --quiet postgres)"
if [[ -z "$postgres_container" ]]; then
  printf '%s\n' 'Current PostgreSQL is not running; rollback-point database backup is mandatory.' >&2
  exit 1
fi
create_rollback_point_database_backup

# PLATFORM_FAIL_CLOSED_POLICY_BEGIN
project_running_container_ids() {
  docker ps --quiet --filter "label=com.docker.compose.project=${STACK}"
}

gateway_running_container_ids() {
  docker ps --quiet \
    --filter "label=com.docker.compose.project=${STACK}" \
    --filter 'label=com.docker.compose.service=gateway'
}

containers_stably_absent() {
  local inventory_function="$1"
  local container_output
  local attempt

  for attempt in 1 2 3; do
    if ! container_output="$("$inventory_function")"; then
      return 1
    fi
    [[ -z "$container_output" ]] || return 1
    if (( attempt < 3 )); then
      sleep 1
    fi
  done
}

stop_platform_gateway() {
  local -a container_ids=()
  local container_output

  if ! container_output="$(gateway_running_container_ids)"; then
    return 1
  fi
  if [[ -z "$container_output" ]]; then
    containers_stably_absent gateway_running_container_ids
    return
  fi
  mapfile -t container_ids <<<"$container_output"
  docker stop --time 10 "${container_ids[@]}" >/dev/null 2>&1 || true
  if ! container_output="$(gateway_running_container_ids)"; then
    return 1
  fi
  if [[ -n "$container_output" ]]; then
    mapfile -t container_ids <<<"$container_output"
    docker kill "${container_ids[@]}" >/dev/null 2>&1 || true
  fi
  containers_stably_absent gateway_running_container_ids
}

stop_project_containers() {
  local -a container_ids=()
  local container_output

  for _ in 1 2; do
    if ! container_output="$(project_running_container_ids)"; then
      return 1
    fi
    if [[ -z "$container_output" ]]; then
      containers_stably_absent project_running_container_ids
      return
    fi
    mapfile -t container_ids <<<"$container_output"
    docker stop --time 10 "${container_ids[@]}" >/dev/null 2>&1 || true
  done
  if ! container_output="$(project_running_container_ids)"; then
    return 1
  fi
  if [[ -n "$container_output" ]]; then
    mapfile -t container_ids <<<"$container_output"
    docker kill "${container_ids[@]}" >/dev/null 2>&1 || true
  fi
  containers_stably_absent project_running_container_ids
}

fail_closed_rollback() {
  local failed=false

  if ! stop_platform_gateway; then
    printf '%s\n' 'CRITICAL: Gateway stop sequence failed; checking final project state for evidence.' >&2
    failed=true
  fi
  if ! stop_project_containers; then
    printf '%s\n' 'CRITICAL: project stop sequence failed; checking final project state for evidence.' >&2
    failed=true
  fi
  if ! containers_stably_absent gateway_running_container_ids; then
    printf '%s\n' 'CRITICAL: unable to verify the platform Gateway is stably stopped.' >&2
    failed=true
  fi
  if ! containers_stably_absent project_running_container_ids; then
    printf '%s\n' 'CRITICAL: unable to verify project containers are stably stopped.' >&2
    failed=true
  fi
  [[ "$failed" == "false" ]]
}
# PLATFORM_FAIL_CLOSED_POLICY_END

# TAILSCALE_SERVE_MATCHER_POLICY_BEGIN
capture_serve_json() {
  local destination="$1"

  "${TAILSCALE_STATUS[@]}" serve status --json >"$destination"
  python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$destination"
}

assert_serve_snapshot() {
  local current_snapshot="$1"
  local expected_target="$2"

  python3 - "$SOURCE_SERVE_CONFIG" "$current_snapshot" "$TAILSCALE_DNS" "$expected_target" <<'PYTHON'
import json
import sys

before = json.load(open(sys.argv[1], encoding="utf-8"))
current = json.load(open(sys.argv[2], encoding="utf-8"))
dns_name = sys.argv[3]
expected_target = sys.argv[4]

before_platform = (
    before.get("TCP", {}).get("8444"),
    before.get("Web", {}).get(f"{dns_name}:8444"),
)
current_platform = (
    current.get("TCP", {}).get("8444"),
    current.get("Web", {}).get(f"{dns_name}:8444"),
)
if current_platform != before_platform:
    raise SystemExit("Tailscale Serve 8444 changed from the rollback-point snapshot.")
tcp_entry, handler = current_platform
if tcp_entry is None or not isinstance(handler, dict):
    raise SystemExit("Required Tailscale Serve 8444 rule is missing or incomplete.")
actual_target = handler.get("Handlers", {}).get("/", {}).get("Proxy")
if actual_target != expected_target:
    raise SystemExit("Tailscale Serve 8444 target does not match the required loopback target.")
PYTHON
}

serve_matches_expected() {
  local status_file="$1"
  local status_json="$2"
  local expected_target="$3"

  if ! "${TAILSCALE_STATUS[@]}" serve status >"$status_file" \
    || ! capture_serve_json "$status_json" \
    || ! assert_serve_snapshot "$status_json" "$expected_target"; then
    return 1
  fi
  grep -q ':8444' "$status_file" && grep -qF "$expected_target" "$status_file"
}
# TAILSCALE_SERVE_MATCHER_POLICY_END

stop_target_stack() {
  target_compose stop api worker >/dev/null 2>&1 || true
  target_compose down --remove-orphans >/dev/null 2>&1 || true
  stop_project_containers || {
    printf '%s\n' 'Target stop helper did not immediately verify; requiring stable empty project inventory.' >&2
    containers_stably_absent project_running_container_ids
  }
}

restore_source_configuration() {
  if ! cp -a "$SOURCE_COMPOSE" "${COMPOSE_DIR}/compose.yaml"; then
    return 1
  fi
  cp -a "$SOURCE_ENV" "$ENV_FILE"
}

restore_source_current() {
  if [[ "$source_current_kind" == "symlink" ]]; then
    ln -sfn "$source_current_target" "$CURRENT_RELEASE"
  else
    rm -f "$CURRENT_RELEASE"
  fi
}

wait_for_postgres_and_redis() {
  local compose_function="$1"

  for _ in $(seq 1 36); do
    if "$compose_function" exec -T postgres pg_isready -U council -d council >/dev/null 2>&1 \
      && "$compose_function" exec -T redis redis-cli ping 2>/dev/null | grep -qx PONG; then
      return 0
    fi
    sleep 5
  done
  if ! "$compose_function" exec -T postgres pg_isready -U council -d council >/dev/null; then
    return 1
  fi
  "$compose_function" exec -T redis redis-cli ping | grep -qx PONG
}

restore_source_database() {
  if ! (
    cd "$ROLLBACK_POINT"
    sha256sum --check SHA256SUMS
  ); then
    return 1
  fi
  if ! gzip -t "$SOURCE_DUMP"; then
    return 1
  fi
  if ! source_compose up -d postgres redis; then
    return 1
  fi
  if ! wait_for_postgres_and_redis source_compose; then
    return 1
  fi
  source_compose stop api worker >/dev/null 2>&1 || true
  if ! source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d postgres \
    -c "DROP DATABASE IF EXISTS council WITH (FORCE);"; then
    return 1
  fi
  if ! source_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d postgres \
    -c "CREATE DATABASE council OWNER council;"; then
    return 1
  fi
  if ! gzip -dc "$SOURCE_DUMP" | docker compose --project-name "$STACK" \
    --env-file "$SOURCE_ENV" -f "$SOURCE_COMPOSE" \
    exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council; then
    return 1
  fi
  source_compose exec -T postgres psql -U council -d council -Atqc 'SELECT 1' | grep -qx 1
}

restore_source_redis() {
  local failed_archive_dir="${ROLLBACK_POINT}/forensics/failed-${SOURCE_VERSION}"
  local failed_archive="${failed_archive_dir}/redis-data-after-failed-${SOURCE_VERSION}.tar.gz"

  if ! (
    cd "$ROLLBACK_POINT"
    sha256sum --check SHA256SUMS
  ) || ! validate_redis_backup_archive "$SOURCE_REDIS_BACKUP"; then
    return 1
  fi
  if [[ ! -d "$REDIS_DATA" || -L "$REDIS_DATA" || -e "$failed_archive_dir" ]]; then
    return 1
  fi
  if ! archive_failed_redis_state "$REDIS_DATA" "$failed_archive_dir" "$failed_archive"; then
    return 1
  fi
  restore_redis_archive_in_place "$SOURCE_REDIS_BACKUP" "$REDIS_DATA"
}

source_service_state() {
  local service="$1"
  local container_id

  container_id="$(source_compose ps --all --quiet "$service" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$container_id" ]]; then
    printf '%s' 'missing'
    return
  fi
  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthcheck-missing{{end}}' \
    "$container_id" 2>/dev/null || printf '%s' 'inspect-failed'
}

restart_source_stack() {
  local -a services=(postgres redis api worker web mcp-readonly model-tunnel gateway)
  local -a expected_services=()
  local -a unhealthy_services=()
  local service state

  if source_compose config --services | grep -qx 'task-adapter-reference'; then
    services+=(task-adapter-reference)
  fi
  for service in "${services[@]}"; do
    if source_compose config --services | grep -qx "$service"; then
      expected_services+=("$service")
    fi
  done
  if ! source_compose up -d; then
    return 1
  fi
  for _ in $(seq 1 60); do
    unhealthy_services=()
    for service in "${expected_services[@]}"; do
      state="$(source_service_state "$service")"
      if [[ "$state" != "running healthy" \
        && ! ( "$service" == "worker" && "$state" == "running healthcheck-missing" ) ]]; then
        unhealthy_services+=("$service")
      fi
    done
    if (( ${#unhealthy_services[@]} == 0 )); then
      if curl --fail --silent --show-error http://127.0.0.1:8787/api/health/ready >/dev/null; then
        return 0
      fi
    fi
    sleep 5
  done
  printf 'Source services failed to recover: %s\n' "${unhealthy_services[*]}" >&2
  return 1
}

# TAILSCALE_SERVE_ROLLBACK_RECOVERY_POLICY_BEGIN
restore_source_serve() {
  local status_file="${TEMP_ROOT}/serve-restored-status"
  local status_json="${TEMP_ROOT}/serve-restored-status.json"

  serve_matches_expected "$status_file" "$status_json" "$source_serve_target" \
    && curl --fail --silent --show-error "https://${TAILSCALE_DNS}:8444/api/health/ready" >/dev/null
}
# TAILSCALE_SERVE_ROLLBACK_RECOVERY_POLICY_END

# ROLLBACK_RECOVERY_POLICY_BEGIN
recover_rollback() {
  local recovery_failed=false
  local target_stopped=false
  local configuration_restored=false
  local current_restored=false
  local database_ready=true
  local redis_ready=true
  local source_stack_ready=false

  if stop_target_stack; then
    target_stopped=true
  else
    recovery_failed=true
  fi
  if restore_source_configuration; then
    configuration_restored=true
  else
    recovery_failed=true
  fi
  if restore_source_current; then
    current_restored=true
  else
    recovery_failed=true
  fi
  if [[ "$candidate_data_may_have_changed" == "true" ]]; then
    database_ready=false
    redis_ready=false
    if [[ "$target_stopped" == "true" && "$configuration_restored" == "true" \
      && "$current_restored" == "true" ]] && restore_source_redis; then
      redis_ready=true
      if restore_source_database; then
        database_ready=true
      else
        recovery_failed=true
      fi
    else
      recovery_failed=true
    fi
  fi
  if [[ "$target_stopped" == "true" && "$configuration_restored" == "true" \
    && "$current_restored" == "true" && "$redis_ready" == "true" && "$database_ready" == "true" ]] \
    && restart_source_stack; then
    source_stack_ready=true
  else
    recovery_failed=true
  fi
  if [[ "$recovery_failed" == "false" && "$source_stack_ready" == "true" ]]; then
    if ! restore_source_serve; then
      recovery_failed=true
    fi
  fi
  if [[ "$recovery_failed" == "true" ]]; then
    if ! fail_closed_rollback; then
      printf '%s\n' 'CRITICAL: fail-closed state could not be verified.' >&2
    fi
    return 1
  fi
}
# ROLLBACK_RECOVERY_POLICY_END

rollback_exit() {
  local status=$?

  trap - EXIT
  if (( status != 0 )) \
    && [[ "$recovery_required" == "true" && "$rollback_committed" != "true" && "$recovery_running" != "true" ]]; then
    recovery_running=true
    printf '%s\n' 'Rollback failed after cutover; restoring the rollback-point state.' >&2
    if recover_rollback; then
      printf '%s\n' 'Rollback-point state restored.' >&2
    else
      printf '%s\n' 'Rollback recovery failed; review the explicit fail-closed verification results.' >&2
    fi
  fi
  cleanup
  exit "$status"
}
trap rollback_exit EXIT

if ! serve_matches_expected "$PRE_CUTOVER_SERVE_STATUS" "$PRE_CUTOVER_SERVE_JSON" "$source_serve_target"; then
  printf '%s\n' 'Tailscale Serve state drifted before rollback cutover.' >&2
  exit 1
fi
recovery_required=true
source_compose stop api worker
assert_goal_run_rollback_safe
if ! manifest_supports_mcp_reader "$TARGET_MANIFEST" vault_v1; then
  set +e
  source_queue_contains_mcp_payload vault_v1
  encrypted_queue_status=$?
  set -e
  if [[ "$encrypted_queue_status" -eq 0 ]]; then
    printf '%s\n' 'Encrypted MCP argument jobs remain queued; refusing rollback to a release without a vault_v1 reader.' >&2
    exit 1
  fi
  if [[ "$encrypted_queue_status" -ne 1 ]]; then
    printf '%s\n' 'Unable to verify MCP queue compatibility for rollback.' >&2
    exit 1
  fi
fi
if ! manifest_supports_queue_capability "$TARGET_MANIFEST" mcpRequestFingerprintReaders hmac_sha256_v1; then
  set +e
  source_database_contains_keyed_mcp_fingerprint
  keyed_fingerprint_status=$?
  set -e
  if [[ "$keyed_fingerprint_status" -eq 0 ]]; then
    printf '%s\n' 'Keyed MCP fingerprints exist; refusing rollback to a release without an hmac_sha256_v1 reader.' >&2
    exit 1
  fi
  if [[ "$keyed_fingerprint_status" -ne 1 ]]; then
    printf '%s\n' 'Unable to verify MCP fingerprint compatibility for rollback.' >&2
    exit 1
  fi
fi
if ! manifest_supports_queue_capability "$TARGET_MANIFEST" mcpAdmissionProtocols atomic_v1; then
  set +e
  source_queue_contains_mcp_payload any
  atomic_queue_status=$?
  source_database_contains_mcp_reservation
  atomic_reservation_status=$?
  set -e
  if [[ "$atomic_queue_status" -eq 0 || "$atomic_reservation_status" -eq 0 ]]; then
    printf '%s\n' 'Active MCP work exists; refusing rollback to a pre-atomic admission release.' >&2
    exit 1
  fi
  if [[ "$atomic_queue_status" -ne 1 || "$atomic_reservation_status" -ne 1 ]]; then
    printf '%s\n' 'Unable to prove pre-atomic rollback compatibility.' >&2
    exit 1
  fi
fi
if source_compose config --services | grep -qx 'sync-legacy-projections'; then
  source_compose --profile ops run --rm sync-legacy-projections
fi
create_rollback_point_database_backup
source_compose stop redis
create_rollback_point_redis_backup
seal_rollback_point_recovery_backup
source_compose down --remove-orphans
install -m 644 "$TARGET_COMPOSE" "${COMPOSE_DIR}/compose.yaml"
install -m 600 "$TARGET_ENV" "$ENV_FILE"

target_compose config --quiet
candidate_data_may_have_changed=true
target_compose up -d postgres redis
wait_for_postgres_and_redis target_compose
target_compose --profile ops run --rm migrate
target_compose up -d

long_lived_services=(postgres redis api worker web mcp-readonly model-tunnel gateway)
if target_compose config --services | grep -qx 'task-adapter-reference'; then
  long_lived_services+=(task-adapter-reference)
fi
service_state() {
  local service="$1"
  local container_id

  container_id="$(target_compose ps --all --quiet "$service" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$container_id" ]]; then
    printf '%s' 'missing'
    return
  fi

  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthcheck-missing{{end}}' \
    "$container_id" 2>/dev/null || printf '%s' 'inspect-failed'
}

unhealthy_services=()
for _ in $(seq 1 60); do
  unhealthy_services=()
  for service in "${long_lived_services[@]}"; do
    state="$(service_state "$service")"
    if [[ "$state" != "running healthy" \
      && ! ( "$service" == "worker" && "$state" == "running healthcheck-missing" ) ]]; then
      unhealthy_services+=("$service")
    fi
  done
  if (( ${#unhealthy_services[@]} == 0 )); then
    break
  fi
  sleep 5
done

if (( ${#unhealthy_services[@]} != 0 )); then
  printf 'Services failed to become healthy after rollback: %s\n' "${unhealthy_services[*]}" >&2
  for service in "${long_lived_services[@]}"; do
    printf '  %s: %s\n' "$service" "$(service_state "$service")" >&2
  done
  target_compose ps >&2
  exit 1
fi
curl --fail --silent --show-error http://127.0.0.1:8787/api/health/ready
restore_source_serve
ln -sfn "$RELEASE_ROOT" "$CURRENT_RELEASE"
rollback_committed=true
recovery_required=false
printf 'Rolled back application release to %s. Rollback point: %s\n' "$VERSION" "$ROLLBACK_POINT"
REMOTE
