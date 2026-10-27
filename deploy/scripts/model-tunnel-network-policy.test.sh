#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
ENV_EXAMPLE="${ROOT}/deploy/.env.example"
DEPLOY_SCRIPT="${ROOT}/deploy/scripts/deploy-remote.sh"
ROLLBACK_SCRIPT="${ROOT}/deploy/scripts/rollback-remote.sh"
DEPLOYMENT_RUNBOOK="${ROOT}/docs/operations/REMOTE_DOCKER_DEPLOYMENT.md"
PRODUCT_CATALOG="${ROOT}/docs/product/PRODUCT_AND_MODULE_FUNCTION_CATALOG_2026-07-16.md"

service_block() {
  local service="$1"

  awk -v service="$service" '
    $0 == "  " service ":" { capture=1 }
    capture && /^  [a-zA-Z0-9_-]+:/ && $0 != "  " service ":" { exit }
    capture { print }
  ' "$COMPOSE"
}

MODEL_TUNNEL_BLOCK="$(service_block model-tunnel)"
API_BLOCK="$(service_block api)"
WORKER_BLOCK="$(service_block worker)"

grep -Fq '<<: *app-security' <<<"$MODEL_TUNNEL_BLOCK"
grep -Fq 'LOCAL_HOST: 0.0.0.0' <<<"$MODEL_TUNNEL_BLOCK"

if grep -Eq 'network_mode:[[:space:]]*host|network:[[:space:]]*host|^[[:space:]]+ports:' <<<"$MODEL_TUNNEL_BLOCK"; then
  printf '%s\n' 'Model tunnel must stay on the private Compose network without published ports.' >&2
  exit 1
fi
if grep -Eq 'extra_hosts:|host-gateway' <<<"${API_BLOCK}${WORKER_BLOCK}"; then
  printf '%s\n' 'API and Worker must resolve the model tunnel through Compose DNS.' >&2
  exit 1
fi
if grep -Fq 'DOCKER_HOST_GATEWAY' "$COMPOSE" "$ENV_EXAMPLE" "$DEPLOY_SCRIPT"; then
  printf '%s\n' 'New releases must not depend on the Docker host gateway.' >&2
  exit 1
fi
if ! grep -Fq 'com.docker.network.driver.mtu: "1400"' "$COMPOSE"; then
  printf '%s\n' 'The private Compose network MTU must match the 1400-byte host uplink.' >&2
  exit 1
fi

# Old releases used the bridge gateway, so rollback must reconstruct it only when
# the selected historical Compose file still references that setting.
grep -Fq "grep -Fq 'DOCKER_HOST_GATEWAY' \"\$TARGET_COMPOSE\"" "$ROLLBACK_SCRIPT"
grep -Fq "docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'" "$ROLLBACK_SCRIPT"

grep -Fq '`agent-meeting-platform-app` Compose network' "$DEPLOYMENT_RUNBOOK"
if grep -Eq 'model tunnel .*Docker gateway|model tunnel 只可出現在 Docker gateway' "$DEPLOYMENT_RUNBOOK"; then
  printf '%s\n' 'The current deployment runbook must not describe a host-gateway tunnel bind.' >&2
  exit 1
fi
if grep -Fq 'host-gateway bind' "$PRODUCT_CATALOG"; then
  printf '%s\n' 'The current product catalog must describe the private Compose tunnel boundary.' >&2
  exit 1
fi

printf '%s\n' 'model tunnel private-network policy tests passed'
