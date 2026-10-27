#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

BUNDLE="${1:-}"
VALIDATOR="${SCRIPT_DIR}/release-archive-validator.py"
AUTH_DISABLED="${AUTH_DISABLED:-false}"
ALLOW_PRODUCTION_AUTH_BYPASS="${ALLOW_PRODUCTION_AUTH_BYPASS:-false}"
GOAL_RUN_AUTONOMY_ENABLED="${GOAL_RUN_AUTONOMY_ENABLED:-false}"
ALLOW_GOAL_RUN_AUTONOMY="${ALLOW_GOAL_RUN_AUTONOMY:-false}"
OMP_RUNTIME_ENABLED="${OMP_RUNTIME_ENABLED:-false}"
ALLOW_OMP_RUNTIME="${ALLOW_OMP_RUNTIME:-false}"
OMP_HOST_TOOLS_ENABLED="${OMP_HOST_TOOLS_ENABLED:-false}"
ALLOW_OMP_HOST_TOOLS="${ALLOW_OMP_HOST_TOOLS:-false}"
OMP_SUBAGENTS_ENABLED="${OMP_SUBAGENTS_ENABLED:-false}"
ALLOW_OMP_SUBAGENTS="${ALLOW_OMP_SUBAGENTS:-false}"
OMP_SANDBOX_PROFILE_ID="${OMP_SANDBOX_PROFILE_ID:-a8d1178e-b0b6-4fe1-817f-2b504b084520}"
HARNESS_ACTION_ADAPTER_ENABLED="${HARNESS_ACTION_ADAPTER_ENABLED:-false}"
ALLOW_HARNESS_ACTION_ADAPTER="${ALLOW_HARNESS_ACTION_ADAPTER:-false}"
HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST="${HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST:-}"
TAILNET_QUICK_LOGIN_ENABLED="${TAILNET_QUICK_LOGIN_ENABLED:-false}"
ALLOW_TAILNET_QUICK_LOGIN="${ALLOW_TAILNET_QUICK_LOGIN:-false}"
TAILNET_QUICK_LOGIN_IDENTITY="${TAILNET_QUICK_LOGIN_IDENTITY:-}"
TAILNET_QUICK_LOGIN_OWNER_EMAIL="${TAILNET_QUICK_LOGIN_OWNER_EMAIL:-}"
SMOKE_DEPLOYMENT_CLASS="${SMOKE_DEPLOYMENT_CLASS:-production}"
ALLOW_REBOOT_REQUIRED="${ALLOW_REBOOT_REQUIRED:-false}"
MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED="${MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED:-true}"
MCP_KEYED_FINGERPRINT_WRITE_ENABLED="${MCP_KEYED_FINGERPRINT_WRITE_ENABLED:-true}"
MCP_LEGACY_ARGUMENT_READER_ENABLED="${MCP_LEGACY_ARGUMENT_READER_ENABLED:-true}"
GOVERNANCE_PROVIDER="${GOVERNANCE_PROVIDER:-native}"
GOVERNANCE_MODE="${GOVERNANCE_MODE:-off}"
GOVERNANCE_TIMEOUT_MS="${GOVERNANCE_TIMEOUT_MS:-2000}"
ALLOW_GOVERNANCE_ENFORCE="${ALLOW_GOVERNANCE_ENFORCE:-false}"
GOVERNANCE_ACS_MANIFEST_PATH=/etc/council/governance/acs-mcp-readonly.manifest.yaml
GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS=/etc/council/governance/policy
GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST="${GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST:-sha256:29f8adb7a73ff7811bd286c4b8adc47014ed7a23f21d35e0c5b735484bf60744}"
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" || ! -f "${BUNDLE}.sha256" ]]; then
  printf 'Usage: %s /absolute/path/agent-meeting-platform-VERSION.tar.gz\n' "$0" >&2
  exit 1
fi
if [[ ! -f "$VALIDATOR" ]]; then
  printf '%s\n' 'Release archive validator is missing.' >&2
  exit 1
fi
if [[ "$AUTH_DISABLED" != "true" && "$AUTH_DISABLED" != "false" ]]; then
  printf '%s\n' 'AUTH_DISABLED must be true or false.' >&2
  exit 1
fi
if [[ "$ALLOW_PRODUCTION_AUTH_BYPASS" != "true" && "$ALLOW_PRODUCTION_AUTH_BYPASS" != "false" ]]; then
  printf '%s\n' 'ALLOW_PRODUCTION_AUTH_BYPASS must be true or false.' >&2
  exit 1
fi
if [[ "$GOAL_RUN_AUTONOMY_ENABLED" != "true" && "$GOAL_RUN_AUTONOMY_ENABLED" != "false" ]]; then
  printf '%s\n' 'GOAL_RUN_AUTONOMY_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$ALLOW_GOAL_RUN_AUTONOMY" != "true" && "$ALLOW_GOAL_RUN_AUTONOMY" != "false" ]]; then
  printf '%s\n' 'ALLOW_GOAL_RUN_AUTONOMY must be true or false.' >&2
  exit 1
fi
if [[ "$GOAL_RUN_AUTONOMY_ENABLED" == "true" && "$ALLOW_GOAL_RUN_AUTONOMY" != "true" ]]; then
  printf '%s\n' 'Enabling Goal Run autonomy requires ALLOW_GOAL_RUN_AUTONOMY=true.' >&2
  exit 1
fi
for flag_name in OMP_RUNTIME_ENABLED ALLOW_OMP_RUNTIME OMP_HOST_TOOLS_ENABLED ALLOW_OMP_HOST_TOOLS OMP_SUBAGENTS_ENABLED ALLOW_OMP_SUBAGENTS; do
  flag_value="${!flag_name}"
  if [[ "$flag_value" != "true" && "$flag_value" != "false" ]]; then
    printf '%s must be true or false.\n' "$flag_name" >&2
    exit 1
  fi
done
if [[ "$OMP_RUNTIME_ENABLED" == "true" && "$ALLOW_OMP_RUNTIME" != "true" ]]; then
  printf '%s\n' 'Enabling OMP Runtime requires ALLOW_OMP_RUNTIME=true.' >&2
  exit 1
fi
if [[ ! "$OMP_SANDBOX_PROFILE_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  printf '%s\n' 'OMP_SANDBOX_PROFILE_ID must be a UUID.' >&2
  exit 1
fi
if [[ "$OMP_HOST_TOOLS_ENABLED" == "true" ]]; then
  if [[ "$OMP_RUNTIME_ENABLED" != "true" || "$ALLOW_OMP_HOST_TOOLS" != "true" ]]; then
    printf '%s\n' 'Enabling OMP Host Tools requires OMP Runtime and ALLOW_OMP_HOST_TOOLS=true.' >&2
    exit 1
  fi
  printf '%s\n' 'OMP Host Tools are not available in the phase-one release.' >&2
  exit 1
fi
if [[ "$OMP_SUBAGENTS_ENABLED" == "true" ]]; then
  if [[ "$OMP_RUNTIME_ENABLED" != "true" || "$ALLOW_OMP_SUBAGENTS" != "true" ]]; then
    printf '%s\n' 'Enabling OMP subagents requires OMP Runtime and ALLOW_OMP_SUBAGENTS=true.' >&2
    exit 1
  fi
  printf '%s\n' 'OMP subagents are not available in the phase-one release.' >&2
  exit 1
fi
if [[ "$HARNESS_ACTION_ADAPTER_ENABLED" != "true" && "$HARNESS_ACTION_ADAPTER_ENABLED" != "false" ]]; then
  printf '%s\n' 'HARNESS_ACTION_ADAPTER_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$ALLOW_HARNESS_ACTION_ADAPTER" != "true" && "$ALLOW_HARNESS_ACTION_ADAPTER" != "false" ]]; then
  printf '%s\n' 'ALLOW_HARNESS_ACTION_ADAPTER must be true or false.' >&2
  exit 1
fi
if [[ "$HARNESS_ACTION_ADAPTER_ENABLED" == "true" && "$ALLOW_HARNESS_ACTION_ADAPTER" != "true" ]]; then
  printf '%s\n' 'Enabling Harness Action Adapter requires ALLOW_HARNESS_ACTION_ADAPTER=true.' >&2
  exit 1
fi
if [[ "$HARNESS_ACTION_ADAPTER_ENABLED" == "true" && -z "$HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST" ]]; then
  printf '%s\n' 'Enabling Harness Action Adapter requires HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST.' >&2
  exit 1
fi
if [[ "$HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST" =~ [^A-Za-z0-9.,:/_-] ]]; then
  printf '%s\n' 'HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST contains unsupported characters.' >&2
  exit 1
fi
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" != "true" && "$TAILNET_QUICK_LOGIN_ENABLED" != "false" ]]; then
  printf '%s\n' 'TAILNET_QUICK_LOGIN_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$ALLOW_TAILNET_QUICK_LOGIN" != "true" && "$ALLOW_TAILNET_QUICK_LOGIN" != "false" ]]; then
  printf '%s\n' 'ALLOW_TAILNET_QUICK_LOGIN must be true or false.' >&2
  exit 1
fi
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" == "true" && "$ALLOW_TAILNET_QUICK_LOGIN" != "true" ]]; then
  printf '%s\n' 'Enabling Tailnet quick login requires ALLOW_TAILNET_QUICK_LOGIN=true.' >&2
  exit 1
fi
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" == "true" ]]; then
  if [[ ! "$TAILNET_QUICK_LOGIN_IDENTITY" =~ ^[A-Za-z0-9][A-Za-z0-9@._+-]{0,253}$ ]]; then
    printf '%s\n' 'TAILNET_QUICK_LOGIN_IDENTITY is missing or contains unsupported characters.' >&2
    exit 1
  fi
  if [[ ! "$TAILNET_QUICK_LOGIN_OWNER_EMAIL" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    printf '%s\n' 'TAILNET_QUICK_LOGIN_OWNER_EMAIL is missing or invalid.' >&2
    exit 1
  fi
fi
if [[ "$SMOKE_DEPLOYMENT_CLASS" != "production" \
  && "$SMOKE_DEPLOYMENT_CLASS" != "disposable" \
  && "$SMOKE_DEPLOYMENT_CLASS" != "isolated" ]]; then
  printf '%s\n' 'SMOKE_DEPLOYMENT_CLASS must be production, disposable, or isolated.' >&2
  exit 1
fi
if [[ "$ALLOW_REBOOT_REQUIRED" != "true" && "$ALLOW_REBOOT_REQUIRED" != "false" ]]; then
  printf '%s\n' 'ALLOW_REBOOT_REQUIRED must be true or false.' >&2
  exit 1
fi
if [[ "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" != "true" && "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" != "false" ]]; then
  printf '%s\n' 'MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$MCP_KEYED_FINGERPRINT_WRITE_ENABLED" != "true" && "$MCP_KEYED_FINGERPRINT_WRITE_ENABLED" != "false" ]]; then
  printf '%s\n' 'MCP_KEYED_FINGERPRINT_WRITE_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$MCP_LEGACY_ARGUMENT_READER_ENABLED" != "true" && "$MCP_LEGACY_ARGUMENT_READER_ENABLED" != "false" ]]; then
  printf '%s\n' 'MCP_LEGACY_ARGUMENT_READER_ENABLED must be true or false.' >&2
  exit 1
fi
if [[ "$MCP_LEGACY_ARGUMENT_READER_ENABLED" == "false" && "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" != "true" ]]; then
  printf '%s\n' 'Disabling the legacy MCP argument reader requires encrypted MCP writes.' >&2
  exit 1
fi
if [[ "$GOVERNANCE_PROVIDER" != "native" && "$GOVERNANCE_PROVIDER" != "microsoft_acs" ]]; then
  printf '%s\n' 'GOVERNANCE_PROVIDER must be native or microsoft_acs.' >&2
  exit 1
fi
if [[ "$GOVERNANCE_MODE" != "off" && "$GOVERNANCE_MODE" != "shadow" && "$GOVERNANCE_MODE" != "enforce" ]]; then
  printf '%s\n' 'GOVERNANCE_MODE must be off, shadow, or enforce.' >&2
  exit 1
fi
if [[ ! "$GOVERNANCE_TIMEOUT_MS" =~ ^[0-9]{2,4}$ ]] \
  || (( 10#$GOVERNANCE_TIMEOUT_MS < 50 || 10#$GOVERNANCE_TIMEOUT_MS > 5000 )); then
  printf '%s\n' 'GOVERNANCE_TIMEOUT_MS must be an integer between 50 and 5000.' >&2
  exit 1
fi
if [[ "$ALLOW_GOVERNANCE_ENFORCE" != "true" && "$ALLOW_GOVERNANCE_ENFORCE" != "false" ]]; then
  printf '%s\n' 'ALLOW_GOVERNANCE_ENFORCE must be true or false.' >&2
  exit 1
fi
if [[ "$GOVERNANCE_PROVIDER" == "native" && "$GOVERNANCE_MODE" != "off" ]]; then
  printf '%s\n' 'Native governance may only be deployed with GOVERNANCE_MODE=off.' >&2
  exit 1
fi
if [[ "$GOVERNANCE_PROVIDER" == "microsoft_acs" && "$GOVERNANCE_MODE" == "off" ]]; then
  printf '%s\n' 'Microsoft ACS requires GOVERNANCE_MODE=shadow or enforce.' >&2
  exit 1
fi
if [[ ! "$GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Governance policy digest must be a pinned SHA-256 value.' >&2
  exit 1
fi
if [[ "$GOVERNANCE_MODE" == "enforce" && "$ALLOW_GOVERNANCE_ENFORCE" != "true" ]]; then
  printf '%s\n' 'Microsoft ACS enforce mode requires ALLOW_GOVERNANCE_ENFORCE=true.' >&2
  exit 1
fi
if [[ "$AUTH_DISABLED" == "true" && "$ALLOW_PRODUCTION_AUTH_BYPASS" != "true" ]]; then
  printf '%s\n' 'Production auth bypass requires ALLOW_PRODUCTION_AUTH_BYPASS=true.' >&2
  exit 1
fi

BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
VERSION="$(python3 "$VALIDATOR" "$BUNDLE")"
EXPECTED_BUNDLE_NAME="agent-meeting-platform-${VERSION}.tar.gz"
if [[ "$(basename "$BUNDLE")" != "$EXPECTED_BUNDLE_NAME" ]]; then
  printf '%s\n' 'Release archive basename does not match its manifest version.' >&2
  exit 1
fi

validate_checksum_file() {
  local archive="$1"
  local checksum="$2"
  local expected_name="$(basename "$archive")"
  local line

  [[ "$(wc -l <"$checksum" | tr -d ' ')" == "1" ]] || return 1
  IFS= read -r line <"$checksum"
  [[ "${line:0:64}" =~ ^[0-9a-f]{64}$ \
    && "${line:64:2}" == "  " \
    && "${line:66}" == "$expected_name" ]] || return 1
  (cd "$(dirname "$archive")" && sha256sum --check "$(basename "$checksum")")
}

if ! validate_checksum_file "$BUNDLE" "${BUNDLE}.sha256"; then
  printf '%s\n' 'Release checksum file is invalid or does not match the canonical bundle.' >&2
  exit 1
fi

preflight_args=(--run --allow-platform-repair)
if [[ "$ALLOW_REBOOT_REQUIRED" == "true" ]]; then
  preflight_args+=(--allow-reboot-required)
fi
"${SCRIPT_DIR}/preflight-remote.sh" "${preflight_args[@]}"
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  "${SCRIPT_DIR}/omp-rootless-preflight-remote.sh" --run
fi

# TAILSCALE_SERVE_PRESTAGE_GATE_BEGIN
remote_ssh "bash -s" <<'REMOTE_SERVE_PREFLIGHT'
set -euo pipefail

if tailscale serve status >/dev/null 2>&1; then
  TAILSCALE_STATUS=(tailscale)
elif sudo -n tailscale serve status >/dev/null 2>&1; then
  TAILSCALE_STATUS=(sudo -n tailscale)
else
  printf '%s\n' 'Unable to read the pre-provisioned Tailscale Serve configuration before transfer.' >&2
  exit 1
fi
TAILSCALE_DNS="$(
  "${TAILSCALE_STATUS[@]}" status --json \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
)"
SERVE_CONFIG="$("${TAILSCALE_STATUS[@]}" serve status --json)"
SERVE_CONFIG="$SERVE_CONFIG" TAILSCALE_DNS="$TAILSCALE_DNS" python3 - <<'PYTHON'
import json
import os

config = json.loads(os.environ["SERVE_CONFIG"])
dns_name = os.environ["TAILSCALE_DNS"]
tcp_entry = config.get("TCP", {}).get("8444")
handler = config.get("Web", {}).get(f"{dns_name}:8444")
if tcp_entry is None or not isinstance(handler, dict):
    raise SystemExit("Required Tailscale Serve 8444 rule is missing or incomplete.")
target = handler.get("Handlers", {}).get("/", {}).get("Proxy")
if target != "http://127.0.0.1:8787":
    raise SystemExit("Tailscale Serve 8444 must target http://127.0.0.1:8787.")
PYTHON
REMOTE_SERVE_PREFLIGHT
# TAILSCALE_SERVE_PRESTAGE_GATE_END

INCOMING="/opt/council/releases/agent-meeting-platform/incoming"
remote_ssh "mkdir -p '${INCOMING}'"
remote_rsync "$BUNDLE" "${INCOMING}/"
remote_rsync "${BUNDLE}.sha256" "${INCOMING}/"
remote_rsync "$VALIDATOR" "${INCOMING}/release-archive-validator.py"

BUNDLE_NAME="$(basename "$BUNDLE")"
CHECKSUM_NAME="$(basename "${BUNDLE}.sha256")"

remote_ssh "VERSION='${VERSION}' BUNDLE_NAME='${BUNDLE_NAME}' CHECKSUM_NAME='${CHECKSUM_NAME}' AUTH_DISABLED='${AUTH_DISABLED}' ALLOW_PRODUCTION_AUTH_BYPASS='${ALLOW_PRODUCTION_AUTH_BYPASS}' GOAL_RUN_AUTONOMY_ENABLED='${GOAL_RUN_AUTONOMY_ENABLED}' OMP_RUNTIME_ENABLED='${OMP_RUNTIME_ENABLED}' OMP_HOST_TOOLS_ENABLED='${OMP_HOST_TOOLS_ENABLED}' OMP_SUBAGENTS_ENABLED='${OMP_SUBAGENTS_ENABLED}' OMP_SANDBOX_PROFILE_ID='${OMP_SANDBOX_PROFILE_ID}' HARNESS_ACTION_ADAPTER_ENABLED='${HARNESS_ACTION_ADAPTER_ENABLED}' HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST='${HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST}' TAILNET_QUICK_LOGIN_ENABLED='${TAILNET_QUICK_LOGIN_ENABLED}' TAILNET_QUICK_LOGIN_IDENTITY='${TAILNET_QUICK_LOGIN_IDENTITY}' TAILNET_QUICK_LOGIN_OWNER_EMAIL='${TAILNET_QUICK_LOGIN_OWNER_EMAIL}' SMOKE_DEPLOYMENT_CLASS='${SMOKE_DEPLOYMENT_CLASS}' MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED='${MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED}' MCP_KEYED_FINGERPRINT_WRITE_ENABLED='${MCP_KEYED_FINGERPRINT_WRITE_ENABLED}' MCP_LEGACY_ARGUMENT_READER_ENABLED='${MCP_LEGACY_ARGUMENT_READER_ENABLED}' GOVERNANCE_PROVIDER='${GOVERNANCE_PROVIDER}' GOVERNANCE_MODE='${GOVERNANCE_MODE}' GOVERNANCE_TIMEOUT_MS='${GOVERNANCE_TIMEOUT_MS}' GOVERNANCE_ACS_MANIFEST_PATH='${GOVERNANCE_ACS_MANIFEST_PATH}' GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS='${GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS}' GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST='${GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST}' bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
DATA_ROOT="${ROOT}/data/${STACK}"
SECRETS_ROOT="${ROOT}/secrets/${STACK}"
BACKUPS_ROOT="${ROOT}/backups/${STACK}"
RELEASES_ROOT="${ROOT}/releases/${STACK}"
INCOMING="${RELEASES_ROOT}/incoming"
RELEASE_ROOT="${RELEASES_ROOT}/${VERSION}"
BACKUP_ROOT="${BACKUPS_ROOT}/predeploy-${VERSION}"
CURRENT_RELEASE="${RELEASES_ROOT}/current"
OMP_REFRESH_SCRIPT="${COMPOSE_DIR}/refresh-omp-attestation.sh"
USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
POSTGRES_DATA="${DATA_ROOT}/postgres"
REDIS_DATA="${DATA_ROOT}/redis"
REDIS_BACKUP="${BACKUP_ROOT}/redis-data.tar.gz"
REDIS_BACKUP_IMAGE=redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232
BUILDER_NAME=agent-meeting-platform-builder
BUILDKIT_IMAGE=moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec
CANDIDATE_COMPOSE="${BACKUP_ROOT}/candidate-compose.yaml"
CANDIDATE_ENV="${BACKUP_ROOT}/candidate.env"
PRIOR_SERVE_STATUS="${BACKUP_ROOT}/tailscale-serve-before.txt"
PRIOR_SERVE_CONFIG="${BACKUP_ROOT}/tailscale-serve-before.json"
PRE_CUTOVER_SERVE_STATUS="${BACKUP_ROOT}/tailscale-serve-pre-cutover.txt"
PRE_CUTOVER_SERVE_JSON="${BACKUP_ROOT}/tailscale-serve-pre-cutover.json"

had_previous_config=false
existing_database=false
previous_current_kind=absent
previous_current_target=
previous_serve_target=http://127.0.0.1:8787
recovery_required=false
candidate_data_may_have_changed=false
deployment_committed=false
recovery_running=false

umask 077
mkdir -p "$COMPOSE_DIR" "$DATA_ROOT" "$SECRETS_ROOT" "$BACKUPS_ROOT" "$RELEASES_ROOT"
chmod 700 "$SECRETS_ROOT" "$BACKUPS_ROOT"

cd "$INCOMING"
validate_checksum_file() {
  local archive="$1"
  local checksum="$2"
  local expected_name="$(basename "$archive")"
  local line

  [[ "$(wc -l <"$checksum" | tr -d ' ')" == "1" ]] || return 1
  IFS= read -r line <"$checksum"
  [[ "${line:0:64}" =~ ^[0-9a-f]{64}$ \
    && "${line:64:2}" == "  " \
    && "${line:66}" == "$expected_name" ]] || return 1
  sha256sum --check "$checksum"
}

EXPECTED_BUNDLE_NAME="agent-meeting-platform-${VERSION}.tar.gz"
if [[ "$BUNDLE_NAME" != "$EXPECTED_BUNDLE_NAME" || "$CHECKSUM_NAME" != "${EXPECTED_BUNDLE_NAME}.sha256" ]]; then
  printf '%s\n' 'Incoming release filenames are not canonical.' >&2
  exit 1
fi
if ! validate_checksum_file "$BUNDLE_NAME" "$CHECKSUM_NAME"; then
  printf '%s\n' 'Incoming release checksum is invalid.' >&2
  exit 1
fi
if [[ "$(python3 ./release-archive-validator.py "$BUNDLE_NAME")" != "$VERSION" ]]; then
  printf '%s\n' 'Incoming release archive failed structural validation.' >&2
  exit 1
fi

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

SERVE_PREFLIGHT_STATUS="$(mktemp "/tmp/${STACK}-${VERSION}-serve-status.XXXXXX")"
SERVE_PREFLIGHT_CONFIG="$(mktemp "/tmp/${STACK}-${VERSION}-serve-config.XXXXXX")"
cleanup_serve_preflight() {
  rm -f -- "$SERVE_PREFLIGHT_STATUS" "$SERVE_PREFLIGHT_CONFIG"
}
trap cleanup_serve_preflight EXIT

if tailscale serve status >"$SERVE_PREFLIGHT_STATUS" 2>/dev/null; then
  TAILSCALE_STATUS=(tailscale)
elif sudo -n tailscale serve status >"$SERVE_PREFLIGHT_STATUS" 2>/dev/null; then
  TAILSCALE_STATUS=(sudo -n tailscale)
else
  printf '%s\n' 'Unable to read the pre-provisioned Tailscale Serve configuration.' >&2
  exit 1
fi
if ! "${TAILSCALE_STATUS[@]}" serve status --json >"$SERVE_PREFLIGHT_CONFIG" \
  || [[ ! -s "$SERVE_PREFLIGHT_CONFIG" ]]; then
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
assert_required_platform_serve "$SERVE_PREFLIGHT_CONFIG" "$TAILSCALE_DNS"

if [[ -e "$RELEASE_ROOT" || -e "$BACKUP_ROOT" ]]; then
  printf 'Release or predeploy backup already exists for version %s.\n' "$VERSION" >&2
  exit 1
fi
mkdir "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
install -m 600 "$SERVE_PREFLIGHT_STATUS" "$PRIOR_SERVE_STATUS"
install -m 600 "$SERVE_PREFLIGHT_CONFIG" "$PRIOR_SERVE_CONFIG"
mkdir "$RELEASE_ROOT"
(umask 022; tar -xzf "$BUNDLE_NAME" -C "$RELEASE_ROOT")
cleanup_serve_preflight
trap - EXIT

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

if ! manifest_supports_mcp_reader "${RELEASE_ROOT}/release-manifest.json" legacy_plaintext \
  || ! manifest_supports_mcp_reader "${RELEASE_ROOT}/release-manifest.json" vault_v1; then
  printf '%s\n' 'Candidate release manifest must declare legacy_plaintext and vault_v1 MCP argument readers.' >&2
  exit 1
fi
for capability in \
  'mcpRequestFingerprintReaders legacy_sha256' \
  'mcpRequestFingerprintReaders hmac_sha256_v1' \
  'mcpAdmissionProtocols atomic_v1' \
  'mcpFailureReceipts argument_free_v1'; do
  read -r capability_name capability_value <<<"$capability"
  if ! manifest_supports_queue_capability "${RELEASE_ROOT}/release-manifest.json" "$capability_name" "$capability_value"; then
    printf 'Candidate release manifest is missing queue capability %s=%s.\n' "$capability_name" "$capability_value" >&2
    exit 1
  fi
done

if [[ -L "$CURRENT_RELEASE" || -e "$CURRENT_RELEASE" ]]; then
  existing_database=true
elif [[ -d "$POSTGRES_DATA" && -n "$(find "$POSTGRES_DATA" -mindepth 1 -print -quit)" ]]; then
  existing_database=true
fi

if [[ -e "${COMPOSE_DIR}/compose.yaml" || -e "${COMPOSE_DIR}/.env" ]]; then
  if [[ ! -f "${COMPOSE_DIR}/compose.yaml" || ! -f "${COMPOSE_DIR}/.env" ]]; then
    printf '%s\n' 'Existing deployment configuration is incomplete; refusing to deploy.' >&2
    exit 1
  fi
  had_previous_config=true
  cp -a "${COMPOSE_DIR}/compose.yaml" "$BACKUP_ROOT/compose.yaml"
  cp -a "${COMPOSE_DIR}/.env" "$BACKUP_ROOT/compose.env"
fi

if [[ -L "$CURRENT_RELEASE" ]]; then
  previous_current_kind=symlink
  previous_current_target="$(readlink "$CURRENT_RELEASE")"
  printf '%s\n' "$previous_current_target" >"${BACKUP_ROOT}/current-release.target"
elif [[ -e "$CURRENT_RELEASE" ]]; then
  printf '%s\n' 'Current release pointer is not a symlink; refusing to deploy.' >&2
  exit 1
else
  printf '%s\n' 'absent' >"${BACKUP_ROOT}/current-release.target"
fi

if [[ "$existing_database" == "true" && "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" == "true" ]]; then
  if [[ "$previous_current_kind" != "symlink" ]] \
    || ! manifest_supports_mcp_reader "${CURRENT_RELEASE}/release-manifest.json" vault_v1; then
    printf '%s\n' 'Encrypted MCP writes require a reader-capable release to be deployed first.' >&2
    exit 1
  fi
fi
if [[ "$existing_database" == "true" && "$MCP_KEYED_FINGERPRINT_WRITE_ENABLED" == "true" ]]; then
  if [[ "$previous_current_kind" != "symlink" ]] \
    || ! manifest_supports_queue_capability "${CURRENT_RELEASE}/release-manifest.json" mcpRequestFingerprintReaders hmac_sha256_v1 \
    || ! manifest_supports_queue_capability "${CURRENT_RELEASE}/release-manifest.json" mcpAdmissionProtocols atomic_v1; then
    printf '%s\n' 'Keyed MCP fingerprint writes require an atomic HMAC-reader release to be deployed first.' >&2
    exit 1
  fi
fi

if [[ "$existing_database" == "true" ]]; then
  if [[ "$had_previous_config" != "true" ]]; then
    printf '%s\n' 'Existing PostgreSQL data has no complete deployment configuration; refusing to migrate.' >&2
    exit 1
  fi
  postgres_container="$(cd "$COMPOSE_DIR" && docker compose --env-file .env -f compose.yaml ps --status running --quiet postgres)"
  if [[ -z "$postgres_container" ]]; then
    printf '%s\n' 'Existing PostgreSQL is not running; a verified pre-migration dump is mandatory.' >&2
    exit 1
  fi
  redis_container="$(cd "$COMPOSE_DIR" && docker compose --env-file .env -f compose.yaml ps --status running --quiet redis)"
  if [[ -z "$redis_container" ]]; then
    printf '%s\n' 'Existing Redis is not running; a coordinated pre-migration queue backup is mandatory.' >&2
    exit 1
  fi
fi

for generated_secret in postgres_password app_master_key task_adapter_token sandbox_broker_token; do
  generated_secret_path="${SECRETS_ROOT}/${generated_secret}"
  if [[ -L "$generated_secret_path" ]]; then
    printf 'Refusing to generate a secret through a symlink: %s\n' "$generated_secret_path" >&2
    exit 1
  fi
  if [[ ! -e "$generated_secret_path" ]]; then
    openssl rand -base64 32 >"$generated_secret_path"
  fi
done

required_secrets=(postgres_password app_master_key gb10_model_tunnel_key gb10_known_hosts task_adapter_token sandbox_broker_token)
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  required_secrets+=(gb10_litellm_agent_key)
fi
for secret_name in "${required_secrets[@]}"; do
  secret_path="${SECRETS_ROOT}/${secret_name}"
  if [[ ! -f "$secret_path" || -L "$secret_path" || ! -s "$secret_path" ]]; then
    printf 'Required secret must be a non-empty regular file: %s\n' "$secret_path" >&2
    exit 1
  fi
done

chmod 700 "$SECRETS_ROOT"
chmod 600 \
  "${SECRETS_ROOT}/postgres_password" \
  "${SECRETS_ROOT}/app_master_key" \
  "${SECRETS_ROOT}/gb10_model_tunnel_key" \
  "${SECRETS_ROOT}/gb10_known_hosts" \
  "${SECRETS_ROOT}/task_adapter_token" \
  "${SECRETS_ROOT}/sandbox_broker_token"
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  chmod 600 "${SECRETS_ROOT}/gb10_litellm_agent_key"
fi

validate_secret() {
  local secret_name="$1"
  local secret_path="${SECRETS_ROOT}/${secret_name}"
  local secret_mode

  if [[ ! -f "$secret_path" || -L "$secret_path" || ! -s "$secret_path" ]]; then
    printf 'Required secret must be a non-empty regular file: %s\n' "$secret_path" >&2
    exit 1
  fi
  secret_mode="$(stat -c '%a' -- "$secret_path")"
  if [[ "$secret_mode" != "600" ]]; then
    printf 'Required secret must have mode 600: %s (mode %s)\n' "$secret_path" "$secret_mode" >&2
    exit 1
  fi
}

for secret_name in "${required_secrets[@]}"; do
  validate_secret "$secret_name"
done

install -m 644 "${RELEASE_ROOT}/deploy/compose.yaml" "$CANDIDATE_COMPOSE"
printf 'RELEASE_VERSION=%s\nRELEASE_ROOT=%s\nDATA_ROOT=%s\nSECRETS_ROOT=%s\nPUBLIC_ORIGIN=https://%s:8444\nAPP_UID=%s\nAPP_GID=%s\nAUTH_DISABLED=%s\nALLOW_PRODUCTION_AUTH_BYPASS=%s\nTAILNET_QUICK_LOGIN_ENABLED=%s\nTAILNET_QUICK_LOGIN_IDENTITY=%s\nTAILNET_QUICK_LOGIN_OWNER_EMAIL=%s\nGOAL_RUN_AUTONOMY_ENABLED=%s\nOMP_RUNTIME_ENABLED=%s\nOMP_HOST_TOOLS_ENABLED=%s\nOMP_SUBAGENTS_ENABLED=%s\nHARNESS_ACTION_ADAPTER_ENABLED=%s\nHARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST=%s\nSMOKE_DEPLOYMENT_CLASS=%s\nMCP_LOCAL_HOST_ALLOWLIST=mcp-readonly\nMCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED=%s\nMCP_KEYED_FINGERPRINT_WRITE_ENABLED=%s\nMCP_LEGACY_ARGUMENT_READER_ENABLED=%s\nGOVERNANCE_PROVIDER=%s\nGOVERNANCE_MODE=%s\nGOVERNANCE_TIMEOUT_MS=%s\nGOVERNANCE_ACS_MANIFEST_PATH=%s\nGOVERNANCE_ACS_POLICY_ARTIFACT_PATHS=%s\nGOVERNANCE_ACS_EXPECTED_POLICY_DIGEST=%s\n' \
  "$VERSION" "$RELEASE_ROOT" "$DATA_ROOT" "$SECRETS_ROOT" "$TAILSCALE_DNS" "$(id -u)" "$(id -g)" "$AUTH_DISABLED" "$ALLOW_PRODUCTION_AUTH_BYPASS" "$TAILNET_QUICK_LOGIN_ENABLED" "$TAILNET_QUICK_LOGIN_IDENTITY" "$TAILNET_QUICK_LOGIN_OWNER_EMAIL" "$GOAL_RUN_AUTONOMY_ENABLED" "$OMP_RUNTIME_ENABLED" "$OMP_HOST_TOOLS_ENABLED" "$OMP_SUBAGENTS_ENABLED" "$HARNESS_ACTION_ADAPTER_ENABLED" "$HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST" "$SMOKE_DEPLOYMENT_CLASS" "$MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED" "$MCP_KEYED_FINGERPRINT_WRITE_ENABLED" "$MCP_LEGACY_ARGUMENT_READER_ENABLED" "$GOVERNANCE_PROVIDER" "$GOVERNANCE_MODE" "$GOVERNANCE_TIMEOUT_MS" "$GOVERNANCE_ACS_MANIFEST_PATH" "$GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS" "$GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST" \
  >"$CANDIDATE_ENV"
printf 'OMP_SANDBOX_PROFILE_ID=%s\nOMP_RUNTIME_IMAGE_DIGEST=\nOMP_BROKER_IMAGE_DIGEST=\nOMP_WORKSPACE_SOURCE_ID=\nOMP_WORKSPACE_ARCHIVE_DIGEST=\n' \
  "$OMP_SANDBOX_PROFILE_ID" >>"$CANDIDATE_ENV"
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  printf 'COMPOSE_PROFILES=omp\n' >>"$CANDIDATE_ENV"
else
  printf 'COMPOSE_PROFILES=\n' >>"$CANDIDATE_ENV"
fi
chmod 600 "$CANDIDATE_ENV"

# COMPOSE_ENVIRONMENT_POLICY_BEGIN
compose_with_environment_file() {
  local env_file="$1"
  local compose_file="$2"
  local variable_name
  local -a clean_environment=("HOME=${HOME}" "PATH=${PATH}")
  shift 2

  for variable_name in \
    DOCKER_API_VERSION \
    DOCKER_CERT_PATH \
    DOCKER_CONFIG \
    DOCKER_CONTEXT \
    DOCKER_CUSTOM_HEADERS \
    DOCKER_DEFAULT_PLATFORM \
    DOCKER_HOST \
    DOCKER_TLS \
    DOCKER_TLS_VERIFY \
    BUILDX_BUILDER \
    BUILDX_CONFIG \
    BUILDKIT_HOST; do
    if [[ "${!variable_name+x}" == x ]]; then
      clean_environment+=("${variable_name}=${!variable_name}")
    fi
  done

  env -i "${clean_environment[@]}" \
    docker compose --project-name "$STACK" --env-file "$env_file" -f "$compose_file" "$@" </dev/null
}

candidate_compose() {
  compose_with_environment_file "$CANDIDATE_ENV" "$CANDIDATE_COMPOSE" "$@"
}

compose() {
  compose_with_environment_file "${COMPOSE_DIR}/.env" "${COMPOSE_DIR}/compose.yaml" "$@"
}

previous_compose() {
  compose_with_environment_file "${BACKUP_ROOT}/compose.env" "${BACKUP_ROOT}/compose.yaml" "$@"
}
# COMPOSE_ENVIRONMENT_POLICY_END

current_queue_contains_mcp_payload() {
  local encoding="$1"
  local status

  if candidate_compose run --rm --no-deps worker \
    node dist/mcp-queue-compatibility-cli.js "$encoding"; then
    return 0
  else
    status=$?
  fi
  [[ "$status" -eq 10 ]] && return 1
  return 2
}

current_database_contains_mcp_reservation() {
  local value
  value="$(previous_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council -Atqc \
    "SELECT EXISTS (SELECT 1 FROM platform_state AS platform CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entry(item) WHERE COALESCE(item->>'kind', 'agent_turn') = 'mcp_tool_call');")" || return 2
  [[ "$value" == "t" ]] && return 0
  [[ "$value" == "f" ]] && return 1
  return 2
}

create_predeploy_database_backup() {
  local dump_tmp="${BACKUP_ROOT}/.postgres.sql.gz.tmp"

  rm -f "$dump_tmp"
  if ! previous_compose exec -T postgres \
    pg_dump --clean --if-exists --no-owner --no-privileges -U council -d council \
    | gzip -9 >"$dump_tmp"; then
    rm -f "$dump_tmp"
    return 1
  fi
  if [[ ! -s "$dump_tmp" ]] || ! gzip -t "$dump_tmp"; then
    rm -f "$dump_tmp"
    return 1
  fi
  mv "$dump_tmp" "${BACKUP_ROOT}/postgres.sql.gz"
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

create_predeploy_redis_backup() {
  local archive_tmp="${BACKUP_ROOT}/.redis-data.tar.gz.tmp"

  if [[ ! -d "$REDIS_DATA" || -L "$REDIS_DATA" ]]; then
    printf '%s\n' 'Redis data path must be a real directory before backup.' >&2
    return 1
  fi
  if [[ -n "$(previous_compose ps --status running --quiet redis 2>/dev/null)" ]]; then
    printf '%s\n' 'Redis must be stopped before its recovery archive is created.' >&2
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
  mv "$archive_tmp" "$REDIS_BACKUP"
}

seal_predeploy_recovery_backup() {
  local checksum_tmp="${BACKUP_ROOT}/.SHA256SUMS.tmp"

  if [[ ! -s "${BACKUP_ROOT}/postgres.sql.gz" || ! -s "$REDIS_BACKUP" ]]; then
    return 1
  fi
  (
    cd "$BACKUP_ROOT"
    sha256sum postgres.sql.gz redis-data.tar.gz >"$checksum_tmp"
    mv "$checksum_tmp" SHA256SUMS
    sha256sum --check SHA256SUMS
  )
}

# GOAL_RUN_FLAG_VERIFY_BEGIN
candidate_config_json="${BACKUP_ROOT}/candidate-compose.json"
candidate_compose config --format json >"$candidate_config_json"
chmod 600 "$candidate_config_json"
python3 - "$candidate_config_json" "$GOAL_RUN_AUTONOMY_ENABLED" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as config_file:
    config = json.load(config_file)
expected = sys.argv[2]
services = config.get("services", {})
for service_name in ("api", "worker"):
    observed = services.get(service_name, {}).get("environment", {}).get("GOAL_RUN_AUTONOMY_ENABLED")
    if str(observed).lower() != expected:
        raise SystemExit(f"{service_name} Goal Run runtime flag does not match the rollout input.")
web_flag = services.get("web", {}).get("build", {}).get("args", {}).get(
    "NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED"
)
if str(web_flag).lower() != expected:
    raise SystemExit("Web Goal Run build flag does not match the rollout input.")
PYTHON
printf 'goal_run_autonomy=%s\n' "$GOAL_RUN_AUTONOMY_ENABLED"
# GOAL_RUN_FLAG_VERIFY_END
candidate_compose config --quiet
candidate_compose pull --policy missing postgres redis gateway
builder_container="buildx_buildkit_${BUILDER_NAME}0"
builder_needs_recreate=false
if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  if ! docker inspect "$builder_container" >/dev/null 2>&1 \
    || [[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$builder_container")" != "host" ]] \
    || [[ "$(docker inspect --format '{{.Image}}' "$builder_container")" != "${BUILDKIT_IMAGE##*@}" ]]; then
    builder_needs_recreate=true
  fi
fi
if [[ "$builder_needs_recreate" == "true" ]]; then
  docker buildx rm "$BUILDER_NAME" >/dev/null
fi
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create \
    --name "$BUILDER_NAME" \
    --driver docker-container \
    --driver-opt network=host \
    --driver-opt "image=${BUILDKIT_IMAGE}" >/dev/null
fi
docker buildx inspect --bootstrap "$BUILDER_NAME" >/dev/null
build_services=(api worker web mcp-readonly model-tunnel task-adapter-reference)
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  build_services+=(sandbox-broker)
fi
candidate_compose build --builder "$BUILDER_NAME" "${build_services[@]}"

if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  OMP_RUNTIME_IMAGE="council-omp-runtime:18.1.2-${VERSION}"
  OMP_BROKER_IMAGE="agent-meeting-platform-sandbox-broker:${VERSION}"
  OMP_RUNTIME_ENV="${BACKUP_ROOT}/omp-runtime.env"
  OMP_ATTESTATION_FILE="${DATA_ROOT}/omp-isolation/attestation.json"
  OMP_EVIDENCE_FILE="${DATA_ROOT}/omp-isolation/evidence-${VERSION}.json"
  install -d -m 700 \
    "${DATA_ROOT}/sandbox-workspaces" \
    "${DATA_ROOT}/omp-broker" \
    "${DATA_ROOT}/omp-sources" \
    "${DATA_ROOT}/omp-isolation"
  docker buildx build \
    --builder "$BUILDER_NAME" \
    --load \
    --target omp-runtime \
    --tag "$OMP_RUNTIME_IMAGE" \
    --file "${RELEASE_ROOT}/deploy/omp-runtime.Dockerfile" \
    "$RELEASE_ROOT"
  OMP_RUNTIME_IMAGE="$OMP_RUNTIME_IMAGE" \
    MODEL_TUNNEL_IMAGE="agent-meeting-platform-model-tunnel:${VERSION}" \
    OMP_SOURCE_DIRECTORY="${RELEASE_ROOT}/deploy/omp-canary" \
    OMP_SOURCE_ROOT="${DATA_ROOT}/omp-sources" \
    MODEL_TUNNEL_KEY_FILE="${SECRETS_ROOT}/gb10_model_tunnel_key" \
    KNOWN_HOSTS_FILE="${SECRETS_ROOT}/gb10_known_hosts" \
    LITELLM_KEY_FILE="${SECRETS_ROOT}/gb10_litellm_agent_key" \
    OUTPUT_ENV_FILE="$OMP_RUNTIME_ENV" \
    bash "${RELEASE_ROOT}/deploy/scripts/prepare-omp-rootless-runtime.sh"
  env_value() {
    local key="$1"
    awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$OMP_RUNTIME_ENV"
  }
  OMP_RUNTIME_IMAGE_DIGEST="$(env_value OMP_RUNTIME_IMAGE_DIGEST)"
  OMP_WORKSPACE_SOURCE_ID="$(env_value OMP_WORKSPACE_SOURCE_ID)"
  OMP_WORKSPACE_ARCHIVE_DIGEST="$(env_value OMP_WORKSPACE_ARCHIVE_DIGEST)"
  OMP_BROKER_IMAGE_DIGEST="$(docker image inspect "$OMP_BROKER_IMAGE" --format '{{.Id}}')"
  if [[ ! "$OMP_RUNTIME_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ \
    || ! "$OMP_WORKSPACE_ARCHIVE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ \
    || ! "$OMP_BROKER_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ \
    || ! "$OMP_WORKSPACE_SOURCE_ID" =~ ^[a-z0-9][a-z0-9._-]{0,119}$ ]]; then
    printf '%s\n' 'OMP runtime preparation returned invalid immutable bindings.' >&2
    exit 1
  fi
  OMP_RUNTIME_IMAGE_DIGEST="$OMP_RUNTIME_IMAGE_DIGEST" \
    OMP_BROKER_IMAGE="$OMP_BROKER_IMAGE" \
    ATTESTATION_FILE="$OMP_ATTESTATION_FILE" \
    EVIDENCE_FILE="$OMP_EVIDENCE_FILE" \
    bash "${RELEASE_ROOT}/deploy/scripts/verify-omp-isolation.sh"
  ENV_FILE="$CANDIDATE_ENV" \
    OMP_RUNTIME_IMAGE_DIGEST="$OMP_RUNTIME_IMAGE_DIGEST" \
    OMP_BROKER_IMAGE_DIGEST="$OMP_BROKER_IMAGE_DIGEST" \
    OMP_WORKSPACE_SOURCE_ID="$OMP_WORKSPACE_SOURCE_ID" \
    OMP_WORKSPACE_ARCHIVE_DIGEST="$OMP_WORKSPACE_ARCHIVE_DIGEST" \
    python3 - <<'PYTHON'
import os
from pathlib import Path

path = Path(os.environ["ENV_FILE"])
updates = {
    "OMP_RUNTIME_IMAGE_DIGEST": os.environ["OMP_RUNTIME_IMAGE_DIGEST"],
    "OMP_BROKER_IMAGE_DIGEST": os.environ["OMP_BROKER_IMAGE_DIGEST"],
    "OMP_WORKSPACE_SOURCE_ID": os.environ["OMP_WORKSPACE_SOURCE_ID"],
    "OMP_WORKSPACE_ARCHIVE_DIGEST": os.environ["OMP_WORKSPACE_ARCHIVE_DIGEST"],
}
observed = set()
output = []
for line in path.read_text(encoding="utf-8").splitlines():
    key = line.split("=", 1)[0]
    if key in updates:
        output.append(f"{key}={updates[key]}")
        observed.add(key)
    else:
        output.append(line)
if observed != set(updates):
    raise SystemExit("Candidate environment is missing OMP binding placeholders.")
temporary = path.with_suffix(path.suffix + ".tmp")
temporary.write_text("\n".join(output) + "\n", encoding="utf-8")
temporary.chmod(0o600)
temporary.replace(path)
PYTHON
  candidate_compose config --quiet
fi

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

fail_closed_deployment() {
  local failed=false

  if ! disable_omp_attestation_timer; then
    printf '%s\n' 'CRITICAL: OMP attestation timer could not be proven inactive.' >&2
    failed=true
  fi
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

  python3 - "$PRIOR_SERVE_CONFIG" "$current_snapshot" "$TAILSCALE_DNS" "$expected_target" <<'PYTHON'
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
    raise SystemExit("Tailscale Serve 8444 changed from the predeploy snapshot.")
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

stop_candidate_stack() {
  candidate_compose stop api worker sandbox-broker >/dev/null 2>&1 || true
  candidate_compose down --remove-orphans >/dev/null 2>&1 || true
  stop_project_containers || {
    printf '%s\n' 'Candidate stop helper did not immediately verify; requiring stable empty project inventory.' >&2
    containers_stably_absent project_running_container_ids
  }
}

restore_previous_configuration() {
  if [[ "$had_previous_config" == "true" ]]; then
    if ! cp -a "${BACKUP_ROOT}/compose.yaml" "${COMPOSE_DIR}/compose.yaml"; then
      return 1
    fi
    cp -a "${BACKUP_ROOT}/compose.env" "${COMPOSE_DIR}/.env"
  else
    rm -f "${COMPOSE_DIR}/compose.yaml" "${COMPOSE_DIR}/.env"
  fi
}

restore_previous_current() {
  if [[ "$previous_current_kind" == "symlink" ]]; then
    ln -sfn "$previous_current_target" "$CURRENT_RELEASE"
  else
    rm -f "$CURRENT_RELEASE"
  fi
}

user_systemctl() {
  XDG_RUNTIME_DIR="/run/user/$(id -u)" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus" \
    systemctl --user "$@"
}

disable_omp_attestation_timer() {
  local active_state

  user_systemctl disable --now council-omp-attestation.timer >/dev/null 2>&1 || true
  if active_state="$(user_systemctl is-active council-omp-attestation.timer 2>/dev/null)"; then
    printf 'OMP attestation timer remained active: %s\n' "$active_state" >&2
    return 1
  fi
  case "$active_state" in
    inactive|failed|unknown) return 0 ;;
    *)
      printf '%s\n' 'Unable to prove the OMP attestation timer is inactive.' >&2
      return 1
      ;;
  esac
}

install_omp_attestation_maintenance() {
  install -d -m 700 "$USER_SYSTEMD_DIR"
  install -m 755 "${RELEASE_ROOT}/deploy/scripts/refresh-omp-attestation.sh" "$OMP_REFRESH_SCRIPT"
  install -m 644 "${RELEASE_ROOT}/deploy/systemd/council-omp-attestation.service" \
    "${USER_SYSTEMD_DIR}/council-omp-attestation.service"
  install -m 644 "${RELEASE_ROOT}/deploy/systemd/council-omp-attestation.timer" \
    "${USER_SYSTEMD_DIR}/council-omp-attestation.timer"
  user_systemctl daemon-reload
}

reconcile_omp_attestation_timer() {
  local enabled=false

  if [[ -f "${COMPOSE_DIR}/.env" ]] \
    && grep -qx 'OMP_RUNTIME_ENABLED=true' "${COMPOSE_DIR}/.env"; then
    enabled=true
  fi
  if [[ "$enabled" == true ]]; then
    user_systemctl enable --now council-omp-attestation.timer
    user_systemctl is-active --quiet council-omp-attestation.timer
  else
    disable_omp_attestation_timer
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

restore_previous_database() {
  local dump_path="${BACKUP_ROOT}/postgres.sql.gz"

  if ! (
    cd "$BACKUP_ROOT"
    sha256sum --check SHA256SUMS
  ); then
    return 1
  fi
  if ! gzip -t "$dump_path"; then
    return 1
  fi
  if ! previous_compose up -d postgres redis; then
    return 1
  fi
  if ! wait_for_postgres_and_redis previous_compose; then
    return 1
  fi
  previous_compose stop api worker >/dev/null 2>&1 || true
  if previous_compose config --services | grep -qx sandbox-broker; then
    previous_compose stop sandbox-broker >/dev/null 2>&1 || true
  fi
  if ! previous_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d postgres \
    -c "DROP DATABASE IF EXISTS council WITH (FORCE);"; then
    return 1
  fi
  if ! previous_compose exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d postgres \
    -c "CREATE DATABASE council OWNER council;"; then
    return 1
  fi
  if ! gzip -dc "$dump_path" | docker compose --project-name "$STACK" \
    --env-file "${BACKUP_ROOT}/compose.env" -f "${BACKUP_ROOT}/compose.yaml" \
    exec -T postgres psql -v ON_ERROR_STOP=1 -U council -d council; then
    return 1
  fi
  previous_compose exec -T postgres psql -U council -d council -Atqc 'SELECT 1' | grep -qx 1
}

restore_previous_redis() {
  local failed_archive_dir="${BACKUP_ROOT}/forensics/failed-${VERSION}"
  local failed_archive="${failed_archive_dir}/redis-data-after-failed-${VERSION}.tar.gz"

  if ! (
    cd "$BACKUP_ROOT"
    sha256sum --check SHA256SUMS
  ) || ! validate_redis_backup_archive "$REDIS_BACKUP"; then
    return 1
  fi
  if [[ ! -d "$REDIS_DATA" || -L "$REDIS_DATA" || -e "$failed_archive_dir" ]]; then
    return 1
  fi
  if ! archive_failed_redis_state "$REDIS_DATA" "$failed_archive_dir" "$failed_archive"; then
    return 1
  fi
  restore_redis_archive_in_place "$REDIS_BACKUP" "$REDIS_DATA"
}

previous_service_state() {
  local service="$1"
  local container_id

  container_id="$(previous_compose ps --all --quiet "$service" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$container_id" ]]; then
    printf '%s' 'missing'
    return
  fi
  docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthcheck-missing{{end}}' \
    "$container_id" 2>/dev/null || printf '%s' 'inspect-failed'
}

restart_previous_stack() {
  local -a services=(postgres redis api worker web mcp-readonly model-tunnel gateway)
  local -a expected_services=()
  local -a unhealthy_services=()
  local service state

  if previous_compose config --services | grep -qx 'task-adapter-reference'; then
    services+=(task-adapter-reference)
  fi
  if previous_compose config --services | grep -qx 'sandbox-broker'; then
    services+=(sandbox-broker)
  fi
  for service in "${services[@]}"; do
    if previous_compose config --services | grep -qx "$service"; then
      expected_services+=("$service")
    fi
  done
  if ! previous_compose up -d; then
    return 1
  fi
  for _ in $(seq 1 60); do
    unhealthy_services=()
    for service in "${expected_services[@]}"; do
      state="$(previous_service_state "$service")"
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
  printf 'Previous services failed to recover: %s\n' "${unhealthy_services[*]}" >&2
  return 1
}

# TAILSCALE_SERVE_RECOVERY_POLICY_BEGIN
restore_previous_serve() {
  local status_file="${BACKUP_ROOT}/.serve-restored-status"
  local status_json="${BACKUP_ROOT}/.serve-restored-status.json"

  if ! serve_matches_expected "$status_file" "$status_json" "$previous_serve_target"; then
    return 1
  fi
  if [[ "$had_previous_config" == "true" ]]; then
    curl --fail --silent --show-error "https://${TAILSCALE_DNS}:8444/api/health/ready" >/dev/null
  else
    containers_stably_absent project_running_container_ids
  fi
}
# TAILSCALE_SERVE_RECOVERY_POLICY_END

# DEPLOY_RECOVERY_POLICY_BEGIN
recover_deployment() {
  local recovery_failed=false
  local candidate_stopped=false
  local configuration_restored=false
  local current_restored=false
  local database_ready=true
  local redis_ready=true
  local previous_stack_ready=false

  if stop_candidate_stack; then
    candidate_stopped=true
  else
    recovery_failed=true
  fi
  if restore_previous_configuration; then
    configuration_restored=true
  else
    recovery_failed=true
  fi
  if restore_previous_current; then
    current_restored=true
  else
    recovery_failed=true
  fi
  if [[ "$existing_database" == "true" && "$candidate_data_may_have_changed" == "true" ]]; then
    database_ready=false
    redis_ready=false
    if [[ "$candidate_stopped" == "true" && "$configuration_restored" == "true" \
      && "$current_restored" == "true" ]] && restore_previous_redis; then
      redis_ready=true
      if restore_previous_database; then
        database_ready=true
      else
        recovery_failed=true
      fi
    else
      recovery_failed=true
    fi
  fi
  if [[ "$had_previous_config" == "true" ]]; then
    if [[ "$candidate_stopped" == "true" && "$configuration_restored" == "true" \
      && "$current_restored" == "true" && "$redis_ready" == "true" && "$database_ready" == "true" ]] \
      && restart_previous_stack; then
      previous_stack_ready=true
    else
      recovery_failed=true
    fi
  elif [[ "$candidate_stopped" == "true" && "$configuration_restored" == "true" \
    && "$current_restored" == "true" && "$redis_ready" == "true" && "$database_ready" == "true" ]]; then
    previous_stack_ready=true
  else
    recovery_failed=true
  fi
  if [[ "$recovery_failed" == "false" && "$previous_stack_ready" == "true" ]]; then
    if [[ -n "${USER_SYSTEMD_DIR:-}" \
      && -f "${USER_SYSTEMD_DIR}/council-omp-attestation.timer" ]] \
      && ! reconcile_omp_attestation_timer; then
      recovery_failed=true
    fi
  fi
  if [[ "$recovery_failed" == "false" && "$previous_stack_ready" == "true" ]]; then
    if ! restore_previous_serve; then
      recovery_failed=true
    fi
  fi
  if [[ "$recovery_failed" == "true" ]]; then
    if ! fail_closed_deployment; then
      printf '%s\n' 'CRITICAL: fail-closed state could not be verified.' >&2
    fi
    return 1
  fi
}
# DEPLOY_RECOVERY_POLICY_END

restore_previous_writers() {
  recovery_running=true
  if recover_deployment; then
    recovery_required=false
    return 0
  fi
  return 1
}

deployment_exit() {
  local status=$?

  trap - EXIT
  if (( status != 0 )) \
    && [[ "$recovery_required" == "true" && "$deployment_committed" != "true" && "$recovery_running" != "true" ]]; then
    recovery_running=true
    printf '%s\n' 'Deployment failed after cutover; restoring the predeploy state.' >&2
    if recover_deployment; then
      printf '%s\n' 'Predeploy state restored.' >&2
    else
      printf '%s\n' 'Predeploy recovery failed; review the explicit fail-closed verification results.' >&2
    fi
  fi
  exit "$status"
}
trap deployment_exit EXIT

if ! serve_matches_expected "$PRE_CUTOVER_SERVE_STATUS" "$PRE_CUTOVER_SERVE_JSON" "$previous_serve_target"; then
  printf '%s\n' 'Tailscale Serve state drifted before cutover.' >&2
  exit 1
fi
recovery_required=true
if [[ "$had_previous_config" == "true" ]]; then
  previous_compose stop api worker
  if previous_compose config --services | grep -qx sandbox-broker; then
    previous_compose stop sandbox-broker
  fi
fi
if [[ "$existing_database" == "true" ]]; then
  create_predeploy_database_backup
  previous_compose stop redis
  create_predeploy_redis_backup
  seal_predeploy_recovery_backup
  previous_compose start redis
  for _ in $(seq 1 12); do
    if previous_compose exec -T redis redis-cli ping 2>/dev/null | grep -qx PONG; then
      break
    fi
    sleep 1
  done
  previous_compose exec -T redis redis-cli ping | grep -qx PONG
fi
if [[ "$had_previous_config" == "true" ]] \
  && { [[ "$previous_current_kind" != "symlink" ]] \
    || ! manifest_supports_queue_capability "${CURRENT_RELEASE}/release-manifest.json" mcpAdmissionProtocols atomic_v1; }; then
  set +e
  current_queue_contains_mcp_payload any
  pre_atomic_queue_status=$?
  current_database_contains_mcp_reservation
  pre_atomic_reservation_status=$?
  set -e
  if [[ "$pre_atomic_queue_status" -eq 0 || "$pre_atomic_reservation_status" -eq 0 ]]; then
    printf '%s\n' 'Pre-atomic MCP jobs or reservations remain; drain them before the first atomic admission release.' >&2
    exit 1
  fi
  if [[ "$pre_atomic_queue_status" -ne 1 || "$pre_atomic_reservation_status" -ne 1 ]]; then
    printf '%s\n' 'Unable to prove that pre-atomic MCP work is fully drained.' >&2
    exit 1
  fi
fi
if [[ "$MCP_LEGACY_ARGUMENT_READER_ENABLED" == "false" && "$had_previous_config" == "true" ]]; then
  set +e
  current_queue_contains_mcp_payload legacy_plaintext
  legacy_queue_status=$?
  set -e
  if [[ "$legacy_queue_status" -eq 0 ]]; then
    printf '%s\n' 'Legacy MCP argument jobs remain queued; refusing to disable the legacy reader.' >&2
    exit 1
  fi
  if [[ "$legacy_queue_status" -ne 1 ]]; then
    printf '%s\n' 'Unable to verify that the current queue contains no legacy MCP argument jobs.' >&2
    exit 1
  fi
fi
if [[ "$existing_database" == "true" ]]; then
  previous_compose stop redis
fi
if [[ "$had_previous_config" == "true" ]]; then
  previous_compose down --remove-orphans
fi
install -m 644 "$CANDIDATE_COMPOSE" "${COMPOSE_DIR}/compose.yaml"
install -m 600 "$CANDIDATE_ENV" "${COMPOSE_DIR}/.env"

candidate_data_may_have_changed=true
compose up -d postgres redis

for _ in $(seq 1 36); do
  if compose exec -T postgres pg_isready -U council -d council >/dev/null 2>&1 \
    && compose exec -T redis redis-cli ping 2>/dev/null | grep -qx PONG; then
    break
  fi
  sleep 5
done
compose exec -T postgres pg_isready -U council -d council
compose exec -T redis redis-cli ping | grep -qx PONG

compose stop api worker
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  compose stop sandbox-broker >/dev/null 2>&1 || true
fi
if ! compose --profile ops run --rm migrate; then
  printf '%s\n' 'Migration failed; restoring the complete predeploy state.' >&2
  if ! restore_previous_writers; then
    printf '%s\n' 'Migration recovery failed; deployment remains fail-closed.' >&2
  fi
  exit 1
fi
compose run --rm --no-deps worker node dist/governance-smoke-cli.js
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  compose up -d sandbox-broker
fi
compose up -d api worker web mcp-readonly model-tunnel task-adapter-reference gateway

long_lived_services=(postgres redis api worker web mcp-readonly model-tunnel task-adapter-reference gateway)
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  long_lived_services+=(sandbox-broker)
fi
service_state() {
  local service="$1"
  local container_id

  container_id="$(compose ps --all --quiet "$service" 2>/dev/null | head -n 1 || true)"
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
    if [[ "$(service_state "$service")" != "running healthy" ]]; then
      unhealthy_services+=("$service")
    fi
  done
  if (( ${#unhealthy_services[@]} == 0 )); then
    break
  fi
  sleep 5
done

if (( ${#unhealthy_services[@]} != 0 )); then
  printf 'Services failed to become healthy: %s\n' "${unhealthy_services[*]}" >&2
  for service in "${long_lived_services[@]}"; do
    printf '  %s: %s\n' "$service" "$(service_state "$service")" >&2
  done
  compose ps >&2
  exit 1
fi
curl --fail --silent --show-error http://127.0.0.1:8787/api/health/ready
restore_previous_serve
ln -sfn "$RELEASE_ROOT" "${RELEASES_ROOT}/current"
install_omp_attestation_maintenance
if [[ "$OMP_RUNTIME_ENABLED" == "true" ]]; then
  disable_omp_attestation_timer
  user_systemctl reset-failed council-omp-attestation.service >/dev/null 2>&1 || true
  user_systemctl start council-omp-attestation.service
  user_systemctl show council-omp-attestation.service --property=Result --value | grep -qx success
  user_systemctl enable --now council-omp-attestation.timer
  user_systemctl is-active --quiet council-omp-attestation.timer
else
  reconcile_omp_attestation_timer
fi
deployment_committed=true
recovery_required=false
printf 'Deployed release %s at https://%s:8444\n' "$VERSION" "$TAILSCALE_DNS"
REMOTE
