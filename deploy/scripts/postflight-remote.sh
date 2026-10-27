#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN=false
ALLOW_REBOOT_REQUIRED=false
SMOKE_TARGET=production
MUTATING_ACCEPTANCE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN=true
      ;;
    --allow-reboot-required)
      ALLOW_REBOOT_REQUIRED=true
      ;;
    --mutating-acceptance)
      MUTATING_ACCEPTANCE=true
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' '--target requires production, disposable, or isolated.' >&2
        exit 2
      fi
      SMOKE_TARGET="$2"
      shift
      ;;
    --help|-h)
      printf '%s\n' 'Usage: postflight-remote.sh --run [--allow-reboot-required] [--target production|disposable|isolated] [--mutating-acceptance]'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

case "$SMOKE_TARGET" in
  production|disposable|isolated)
    ;;
  *)
    printf 'Unknown smoke target: %s\n' "$SMOKE_TARGET" >&2
    exit 2
    ;;
esac
if [[ "$MUTATING_ACCEPTANCE" == "true" && "$SMOKE_TARGET" == "production" ]]; then
  printf '%s\n' 'Mutating acceptance requires --target disposable or --target isolated.' >&2
  exit 2
fi

if [[ "$RUN" != "true" ]]; then
  printf '%s\n' 'Dry run only. Use --run to execute the controlled external-host postflight.'
  printf 'Target: %s via %s\n' "${REMOTE_TARGET:-operator@council.example}" "${REMOTE_JUMP-jump@bastion.example}"
  printf 'Smoke target: %s; mutating acceptance: %s\n' "$SMOKE_TARGET" "$MUTATING_ACCEPTANCE"
  exit 0
fi

source "${SCRIPT_DIR}/remote-common.sh"

preflight_args=(--run)
if [[ "$ALLOW_REBOOT_REQUIRED" == "true" ]]; then
  preflight_args+=(--allow-reboot-required)
fi
"${SCRIPT_DIR}/preflight-remote.sh" "${preflight_args[@]}"

run_platform_security_checks() {
  remote_ssh 'bash -s' <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
COMPOSE_HELPER="${ROOT}/releases/${STACK}/current/deploy/scripts/compose-environment.sh"
BASE_URL=http://127.0.0.1:8787
TMP_ROOT="$(mktemp -d)"
COMPOSE_CONFIG="${TMP_ROOT}/compose-config.json"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  printf 'POSTFLIGHT FAIL %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'POSTFLIGHT PASS %s\n' "$1"
}

test -r "$COMPOSE_HELPER" || fail 'compose_helper=missing'
source "$COMPOSE_HELPER"

expect_status() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local insecure="${4:-false}"
  local -a curl_args=(--silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --noproxy '*')
  local actual
  if [[ "$insecure" == "true" ]]; then
    curl_args+=(--insecure)
  fi
  actual="$(curl "${curl_args[@]}" "$url" || true)"
  [[ "$actual" == "$expected" ]] || fail "${label} expected=${expected} actual=${actual}"
  pass "${label}=${actual}"
}

expect_api_error() {
  local label="$1"
  local status="$2"
  local expected_status="$3"
  local expected_code="$4"
  local body_file="$5"
  [[ "$status" == "$expected_status" ]] || fail "${label} expected_status=${expected_status} actual=${status}"
  python3 - "$body_file" "$expected_code" <<'PYTHON' || fail "${label} returned the wrong error code"
import json, sys
body = json.load(open(sys.argv[1], encoding="utf-8"))
assert body["error"]["code"] == sys.argv[2]
PYTHON
  pass "${label}=rejected code=${expected_code}"
}

test -f "${COMPOSE_DIR}/.env" || fail 'platform_env=missing'
compose_with_deployment_environment "$STACK" "${COMPOSE_DIR}/.env" "${COMPOSE_DIR}/compose.yaml" \
  config --format json >"$COMPOSE_CONFIG" \
  || fail 'compose_config=invalid'
mapfile -t deployment_values < <(python3 - "$COMPOSE_CONFIG" <<'PYTHON'
import json, sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
api = config.get("services", {}).get("api", {})
environment = api.get("environment", {})
names = (
    "AUTH_DISABLED",
    "ALLOW_PRODUCTION_AUTH_BYPASS",
    "PUBLIC_ORIGIN",
    "TAILNET_QUICK_LOGIN_ENABLED",
    "OMP_RUNTIME_ENABLED",
)
values = []
for name in names:
    value = environment.get(name)
    if not isinstance(value, str) or not value:
        raise SystemExit(f"Resolved API environment is missing {name}.")
    values.append(value)
tailnet_identity = environment.get("TAILNET_QUICK_LOGIN_IDENTITY", "")
tailnet_owner_email = environment.get("TAILNET_QUICK_LOGIN_OWNER_EMAIL", "")
if values[3] == "true" and (not tailnet_identity or not tailnet_owner_email):
    raise SystemExit("Enabled Tailnet quick login is missing its identity binding.")
image = api.get("image")
prefix = "agent-meeting-platform-api:"
if not isinstance(image, str) or not image.startswith(prefix) or not image[len(prefix):]:
    raise SystemExit("Resolved API image does not contain a release version.")
for value in (*values, tailnet_identity, tailnet_owner_email, image[len(prefix):]):
    print(value)
PYTHON
)
[[ "${#deployment_values[@]}" -eq 8 ]] || fail 'compose_config=missing_api_values'
AUTH_DISABLED="${deployment_values[0]}"
ALLOW_PRODUCTION_AUTH_BYPASS="${deployment_values[1]}"
PUBLIC_ORIGIN="${deployment_values[2]}"
TAILNET_QUICK_LOGIN_ENABLED="${deployment_values[3]}"
OMP_RUNTIME_ENABLED="${deployment_values[4]}"
RELEASE_VERSION="${deployment_values[7]}"
test -n "$PUBLIC_ORIGIN" || fail 'public_origin=missing'
if [[ "$AUTH_DISABLED" != "false" || "$ALLOW_PRODUCTION_AUTH_BYPASS" != "false" ]]; then
  fail 'production authentication must require an Owner session without a bypass'
fi
pass 'production_auth=owner_session_required'
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" != "true" && "$TAILNET_QUICK_LOGIN_ENABLED" != "false" ]]; then
  fail "tailnet_quick_login=${TAILNET_QUICK_LOGIN_ENABLED}"
fi
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" == "true" ]]; then
  pass 'tailnet_quick_login=enabled_identity_bound'
else
  pass 'tailnet_quick_login=disabled'
fi

services_output="$(platform_services_for_omp_runtime "$OMP_RUNTIME_ENABLED")" \
  || fail "omp_runtime_enabled=${OMP_RUNTIME_ENABLED}"
mapfile -t services <<<"$services_output"
expected_services="$(printf '%s\n' "${services[@]}" | sort)"
actual_services="$(docker ps \
  --filter "label=com.docker.compose.project=${STACK}" \
  --format '{{.Label "com.docker.compose.service"}}' | sort)"
[[ "$actual_services" == "$expected_services" ]] || {
  printf 'Expected platform services:\n%s\nActual platform services:\n%s\n' "$expected_services" "$actual_services" >&2
  fail 'platform_services do not match the runtime-resolved service set'
}

for service in "${services[@]}"; do
  mapfile -t ids < <(docker ps \
    --filter "label=com.docker.compose.project=${STACK}" \
    --filter "label=com.docker.compose.service=${service}" \
    --quiet)
  (( ${#ids[@]} == 1 )) || fail "service_${service} expected=1 actual=${#ids[@]}"
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}} {{.HostConfig.RestartPolicy.Name}}' "${ids[0]}")"
  [[ "$state" == 'running healthy unless-stopped' ]] || fail "service_${service} state=${state}"
  bindings="$(docker port "${ids[0]}" 2>/dev/null || true)"
  if [[ "$service" == "gateway" ]]; then
    [[ "$bindings" == '8080/tcp -> 127.0.0.1:8787' ]] || fail "gateway_bindings=${bindings:-none}"
  elif [[ -n "$bindings" ]]; then
    fail "service_${service} unexpectedly publishes ${bindings}"
  fi
done
pass "platform_services=${#services[@]}/${#services[@]}_running_healthy_restartable"

mapfile -t listeners < <(ss -ltnH | awk '$4 ~ /:8787$/ {print $4}')
(( ${#listeners[@]} == 1 )) || fail "gateway_8787_listener_count=${#listeners[@]}"
[[ "${listeners[0]}" == '127.0.0.1:8787' ]] || fail "gateway_8787_listener=${listeners[0]}"
pass 'gateway_8787=loopback_only'

expect_status 'platform_loopback_ready' "${BASE_URL}/api/health/ready" '200'
ready_file="${TMP_ROOT}/ready.json"
curl --fail-with-body --silent --show-error --noproxy '*' "${BASE_URL}/api/health/ready" >"$ready_file"
python3 - "$ready_file" <<'PYTHON' || fail 'platform readiness payload is not ready'
import json, sys
assert json.load(open(sys.argv[1], encoding="utf-8")) == {"status": "ready"}
PYTHON

TAILSCALE_DNS="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
test -n "$TAILSCALE_DNS" || fail 'tailscale_dns=missing'
SERVE_STATUS="${TMP_ROOT}/tailscale-serve.txt"
if tailscale serve status >"$SERVE_STATUS" 2>/dev/null; then
  :
else
  sudo -n tailscale serve status >"$SERVE_STATUS"
fi
grep -q ':8444' "$SERVE_STATUS" || fail 'tailscale_serve_8444=missing'
grep -q 'http://127.0.0.1:8787' "$SERVE_STATUS" || fail 'tailscale_serve_target=wrong'
[[ "$PUBLIC_ORIGIN" == "https://${TAILSCALE_DNS}:8444" ]] || fail "public_origin=${PUBLIC_ORIGIN}"
expect_status 'tailscale_https_ready' "https://${TAILSCALE_DNS}:8444/api/health/ready" '200'
pass 'tailscale_serve_8444=tailnet_https_to_loopback_gateway'

TAILSCALE_IP="$(tailscale ip -4 | head -n 1)"
LAN_IP="$(ip -4 -o addr show scope global | awk -v tailscale_ip="$TAILSCALE_IP" '
  $2 !~ /^(lo|docker|br-|veth|tailscale)/ {
    split($4, address, "/");
    if (candidate == "" && address[1] != tailscale_ip) { candidate = address[1] }
  }
  END { if (candidate != "") print candidate }
')"
if [[ -n "$LAN_IP" ]]; then
  set +e
  direct_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 2 --max-time 3 --noproxy '*' "http://${LAN_IP}:8787/api/health/ready" 2>/dev/null)"
  direct_result=$?
  set -e
  [[ "$direct_result" -ne 0 && "$direct_status" == '000' ]] || fail "direct_lan_8787 exposed status=${direct_status}"
  pass 'direct_lan_8787=blocked'
else
  printf '%s\n' 'POSTFLIGHT WARN direct_lan_8787=not_testable_no_physical_ipv4'
fi

CONNECTOR_ID=00000000-0000-4000-8000-000000000001
TOOL_NAME=postflight_protected_tool
AGENT_ID=00000000-0000-4000-8000-000000000002

bootstrap_file="${TMP_ROOT}/bootstrap.json"
bootstrap_status="$(curl --silent --show-error --output "$bootstrap_file" --write-out '%{http_code}' --noproxy '*' \
  "${BASE_URL}/api/bootstrap")"
expect_api_error 'anonymous_bootstrap' "$bootstrap_status" '401' 'UNAUTHORIZED' "$bootstrap_file"

tailnet_login_file="${TMP_ROOT}/tailnet-login.json"
tailnet_login_status="$(curl --silent --show-error --output "$tailnet_login_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header "Origin: ${PUBLIC_ORIGIN}" "${BASE_URL}/api/auth/tailnet-login")"
if [[ "$TAILNET_QUICK_LOGIN_ENABLED" == "true" ]]; then
  expect_api_error 'tailnet_login_without_identity' "$tailnet_login_status" '403' 'TAILNET_IDENTITY_REJECTED' "$tailnet_login_file"
else
  expect_api_error 'tailnet_login_disabled' "$tailnet_login_status" '404' 'NOT_FOUND' "$tailnet_login_file"
fi

READ_PAYLOAD="$(python3 - "$CONNECTOR_ID" "$TOOL_NAME" "$AGENT_ID" <<'PYTHON'
import json, sys
print(json.dumps({"connectorId": sys.argv[1], "toolName": sys.argv[2], "effect": "read", "agentId": sys.argv[3]}))
PYTHON
)"
WRITE_PAYLOAD="$(python3 - "$CONNECTOR_ID" "$TOOL_NAME" "$AGENT_ID" <<'PYTHON'
import json, sys
print(json.dumps({"connectorId": sys.argv[1], "toolName": sys.argv[2], "effect": "write", "agentId": sys.argv[3]}))
PYTHON
)"

discover_file="${TMP_ROOT}/mcp-discover.json"
discover_status="$(curl --silent --show-error --output "$discover_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header "Origin: ${PUBLIC_ORIGIN}" --header 'content-type: application/json' --data '{}' \
  "${BASE_URL}/api/mcp-connectors/${CONNECTOR_ID}/discover")"
expect_api_error 'anonymous_mcp_discover' "$discover_status" '401' 'UNAUTHORIZED' "$discover_file"

read_file="${TMP_ROOT}/tool-read.json"
read_status="$(curl --silent --show-error --output "$read_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header "Origin: ${PUBLIC_ORIGIN}" --header 'content-type: application/json' --data "$READ_PAYLOAD" \
  "${BASE_URL}/api/tools/authorize")"
expect_api_error 'anonymous_mcp_read' "$read_status" '401' 'UNAUTHORIZED' "$read_file"

write_file="${TMP_ROOT}/tool-write.json"
write_status="$(curl --silent --show-error --output "$write_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header "Origin: ${PUBLIC_ORIGIN}" --header 'content-type: application/json' --data "$WRITE_PAYLOAD" \
  "${BASE_URL}/api/tools/authorize")"
expect_api_error 'anonymous_mcp_write' "$write_status" '401' 'UNAUTHORIZED' "$write_file"

harness_file="${TMP_ROOT}/harness.json"
harness_status="$(curl --silent --show-error --output "$harness_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header "Origin: ${PUBLIC_ORIGIN}" --header 'content-type: application/json' \
  --data '{"resourceId":"postflight-denied","inputs":{}}' "${BASE_URL}/api/executions/harness")"
expect_api_error 'anonymous_harness' "$harness_status" '401' 'UNAUTHORIZED' "$harness_file"

missing_origin_file="${TMP_ROOT}/missing-origin.json"
missing_origin_status="$(curl --silent --show-error --output "$missing_origin_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header 'content-type: application/json' --data "$READ_PAYLOAD" "${BASE_URL}/api/tools/authorize")"
expect_api_error 'anonymous_missing_origin' "$missing_origin_status" '401' 'UNAUTHORIZED' "$missing_origin_file"

foreign_origin_file="${TMP_ROOT}/foreign-origin.json"
foreign_origin_status="$(curl --silent --show-error --output "$foreign_origin_file" --write-out '%{http_code}' --noproxy '*' \
  --request POST --header 'Origin: https://foreign.invalid' --header 'content-type: application/json' \
  --data "$READ_PAYLOAD" "${BASE_URL}/api/tools/authorize")"
expect_api_error 'anonymous_foreign_origin' "$foreign_origin_status" '401' 'UNAUTHORIZED' "$foreign_origin_file"

expect_status 'portainer_9443' 'https://127.0.0.1:9443' '200' 'true'
expect_status 'dify_80' 'http://127.0.0.1:80' '307'
expect_status 'n8n_5678' 'http://127.0.0.1:5678' '200'
expect_status 'nodered_1880' 'http://127.0.0.1:1880' '200'
expect_status 'homeassistant_8123' 'http://127.0.0.1:8123' '200'
REMOTE
}

run_mutating_acceptance_gate() {
  remote_ssh "SMOKE_TARGET='${SMOKE_TARGET}' bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
COMPOSE_HELPER="${ROOT}/releases/${STACK}/current/deploy/scripts/compose-environment.sh"
SMOKE_POLICY="${ROOT}/releases/${STACK}/current/deploy/scripts/smoke-data-hygiene.sh"
COMPOSE_CONFIG="$(mktemp)"
cleanup() {
  rm -f "$COMPOSE_CONFIG"
}
trap cleanup EXIT

test -r "$COMPOSE_HELPER"
source "$COMPOSE_HELPER"
test -r "$SMOKE_POLICY"
source "$SMOKE_POLICY"
compose_with_deployment_environment "$STACK" "${COMPOSE_DIR}/.env" "${COMPOSE_DIR}/compose.yaml" \
  config --format json >"$COMPOSE_CONFIG"
smoke_require_mutating_acceptance "$SMOKE_TARGET" "${COMPOSE_DIR}/.env" "$COMPOSE_CONFIG"
REMOTE
}

run_final_health_check() {
  remote_ssh 'bash -s' <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
COMPOSE_HELPER="${ROOT}/releases/${STACK}/current/deploy/scripts/compose-environment.sh"
COMPOSE_CONFIG="$(mktemp)"
cleanup() {
  rm -f "$COMPOSE_CONFIG"
}
trap cleanup EXIT

test -r "$COMPOSE_HELPER"
source "$COMPOSE_HELPER"
compose_with_deployment_environment "$STACK" "${COMPOSE_DIR}/.env" "${COMPOSE_DIR}/compose.yaml" \
  config --format json >"$COMPOSE_CONFIG"
OMP_RUNTIME_ENABLED="$(python3 - "$COMPOSE_CONFIG" <<'PYTHON'
import json, sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
value = config.get("services", {}).get("api", {}).get("environment", {}).get("OMP_RUNTIME_ENABLED")
if value not in ("true", "false"):
    raise SystemExit("Resolved API environment has an invalid OMP_RUNTIME_ENABLED value.")
print(value)
PYTHON
)"
services_output="$(platform_services_for_omp_runtime "$OMP_RUNTIME_ENABLED")" \
  || { printf 'POSTFLIGHT FAIL omp_runtime_enabled=%s\n' "$OMP_RUNTIME_ENABLED" >&2; exit 1; }
mapfile -t services <<<"$services_output"
expected_services="$(printf '%s\n' "${services[@]}" | sort)"
actual_services="$(docker ps \
  --filter "label=com.docker.compose.project=${STACK}" \
  --format '{{.Label "com.docker.compose.service"}}' | sort)"
[[ "$actual_services" == "$expected_services" ]]
for service in "${services[@]}"; do
  container_id="$(docker ps \
    --filter "label=com.docker.compose.project=${STACK}" \
    --filter "label=com.docker.compose.service=${service}" \
    --quiet)"
  [[ -n "$container_id" && "$(wc -w <<<"$container_id")" -eq 1 ]]
  [[ "$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")" == 'running healthy' ]]
done

curl --fail-with-body --silent --show-error --noproxy '*' http://127.0.0.1:8787/api/health/ready >/dev/null
tailscale_dns="$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
curl --fail-with-body --silent --show-error --noproxy '*' "https://${tailscale_dns}:8444/api/health/ready" >/dev/null

check_status() {
  local url="$1"
  local expected="$2"
  local insecure="${3:-false}"
  local -a args=(--silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --noproxy '*')
  [[ "$insecure" == 'true' ]] && args+=(--insecure)
  [[ "$(curl "${args[@]}" "$url" || true)" == "$expected" ]]
}
check_status 'https://127.0.0.1:9443' '200' 'true'
check_status 'http://127.0.0.1:80' '307'
check_status 'http://127.0.0.1:5678' '200'
check_status 'http://127.0.0.1:1880' '200'
check_status 'http://127.0.0.1:8123' '200'
printf '%s\n' "POSTFLIGHT PASS final_health=platform_${#services[@]}/${#services[@]}_and_retained_services"
REMOTE
}

run_platform_security_checks
"${SCRIPT_DIR}/smoke-production-read-only-remote.sh" --run
if [[ "$MUTATING_ACCEPTANCE" == "true" ]]; then
  run_mutating_acceptance_gate
  "${SCRIPT_DIR}/smoke-management-control-plane-remote.sh" --run --target "$SMOKE_TARGET"
  "${SCRIPT_DIR}/smoke-core-workflow-remote.sh" --run --target "$SMOKE_TARGET"
  "${SCRIPT_DIR}/smoke-task-agent-run-remote.sh" --run --target "$SMOKE_TARGET"
  "${SCRIPT_DIR}/smoke-task-work-item-remote.sh" --run --target "$SMOKE_TARGET"
fi
run_final_health_check

if [[ "$MUTATING_ACCEPTANCE" == "true" ]]; then
  printf '%s\n' 'Postflight passed: baseline, read-only production smoke, disposable mutating acceptance, security negatives, and retained-service checks are green.'
else
  printf '%s\n' 'Postflight passed: baseline, read-only production smoke, security negatives, and retained-service checks are green.'
fi
