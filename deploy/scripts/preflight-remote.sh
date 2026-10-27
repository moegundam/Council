#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"
source "${SCRIPT_DIR}/health-failure-policy.sh"

RUN=false
ALLOW_PLATFORM_REPAIR=false
ALLOW_REBOOT_REQUIRED=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN=true
      ;;
    --allow-platform-repair)
      ALLOW_PLATFORM_REPAIR=true
      ;;
    --allow-reboot-required)
      ALLOW_REBOOT_REQUIRED=true
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$RUN" != "true" ]]; then
  printf '%s\n' 'Dry run only. Use --run to execute read-only host checks.'
  printf 'Target: %s via %s\n' "$REMOTE_TARGET" "${REMOTE_JUMP:-direct}"
  exit 0
fi

OPS_ROOT="/opt/council-ops"
set +e
health_output="$("${OPS_ROOT}/scripts/health-check.sh" --run --host "$REMOTE_TARGET" --jump "$REMOTE_JUMP" --key "$SSH_KEY" 2>&1)"
health_status=$?
set -e
printf '%s\n' "$health_output"

if (( health_status != 0 )); then
  if ! health_failures_are_allowed "$health_output" "$ALLOW_PLATFORM_REPAIR" "$ALLOW_REBOOT_REQUIRED"; then
    exit "$health_status"
  fi

  if health_output_has_failure "$health_output" 'FAIL docker_bad_containers_present'; then
    remote_ssh 'bash -s' <<'REMOTE_REPAIR_GATE'
set -euo pipefail

bad_containers="$(docker ps -a \
  --filter status=restarting \
  --filter status=exited \
  --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}')"
if [[ -z "$bad_containers" ]]; then
  printf '%s\n' 'Health check reported bad containers, but none can be verified.' >&2
  exit 1
fi

while IFS=$'\t' read -r container_name compose_project; do
  if [[ "$compose_project" != "agent-meeting-platform" ]]; then
    printf 'Refusing repair preflight: bad container %s belongs to %s.\n' \
      "$container_name" "${compose_project:-no-compose-project}" >&2
    exit 1
  fi
done <<<"$bad_containers"

printf '%s\n' 'WARN only agent-meeting-platform containers are unhealthy; continuing bounded repair deployment.'
REMOTE_REPAIR_GATE
  fi

  if health_output_has_failure "$health_output" 'FAIL reboot_required=yes'; then
    printf '%s\n' 'WARN host reboot is required; continuing only because this deployment explicitly accepted that existing risk.'
  fi
fi

"${OPS_ROOT}/scripts/inventory.sh" --run --host "$REMOTE_TARGET" --jump "$REMOTE_JUMP" --key "$SSH_KEY"

remote_ssh 'bash -s' <<'REMOTE'
set -euo pipefail

printf '%s\n' '== agent-meeting-platform deployment preflight =='
printf 'host=%s arch=%s kernel=%s\n' "$(hostname)" "$(uname -m)" "$(uname -r)"
docker version --format 'docker_server={{.Server.Version}}'
docker compose version
printf '%s\n' '-- disk --'
df -h / /opt/council
printf '%s\n' '-- memory --'
free -h
printf '%s\n' '-- reserved ports --'
ss -ltnH | awk '$4 ~ /:(80|443|1880|4001|5003|5678|8000|8123|9443|8787)$/ {print}'
printf '%s\n' '-- tailscale --'
tailscale status --self
tailscale serve status || true

if ss -ltnH | awk '$4 ~ /:8787$/ {found=1} END {exit !found}'; then
  if ! docker ps --format '{{.Names}}' | grep -qx 'agent-meeting-platform-gateway-1'; then
    printf '%s\n' 'Port 8787 is occupied by a non-platform process.' >&2
    exit 1
  fi
fi

if ss -ltnH | awk '$4 ~ /:4001$/ {found=1} END {exit !found}'; then
  model_tunnel_container="$(docker ps \
    --filter 'label=com.docker.compose.project=agent-meeting-platform' \
    --filter 'label=com.docker.compose.service=model-tunnel' \
    --quiet)"
  if [[ -z "$model_tunnel_container" ]]; then
    printf '%s\n' 'Docker host gateway port 4001 is occupied outside the platform model tunnel.' >&2
    exit 1
  fi
  if [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$model_tunnel_container")" != "healthy" ]]; then
    printf '%s\n' 'Docker host gateway port 4001 is occupied, but the platform model tunnel is not healthy.' >&2
    exit 1
  fi
fi

if [[ "$(uname -m)" != "x86_64" && "$(uname -m)" != "aarch64" ]]; then
  printf '%s\n' 'Unsupported CPU architecture.' >&2
  exit 1
fi

test -d /opt/council
test -w /opt/council
printf '%s\n' 'Preflight passed.'
REMOTE
