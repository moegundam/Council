#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
PREPARE="${ROOT}/deploy/scripts/prepare-omp-rootless-runtime.sh"
VERIFY="${ROOT}/deploy/scripts/verify-omp-isolation.sh"
REFRESH="${ROOT}/deploy/scripts/refresh-omp-attestation.sh"
COMPOSE_HELPER="${ROOT}/deploy/scripts/compose-environment.sh"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"
SERVICE="${ROOT}/deploy/systemd/council-omp-attestation.service"
TIMER="${ROOT}/deploy/systemd/council-omp-attestation.timer"

for required in "$COMPOSE" "$PREPARE" "$VERIFY" "$REFRESH" "$COMPOSE_HELPER" "$DEPLOY" "$SERVICE" "$TIMER"; do
  [[ -f "$required" ]] || {
    printf 'Required OMP production wiring file is missing: %s\n' "$required" >&2
    exit 1
  }
done

grep -Eq '^  sandbox-broker:' "$COMPOSE"
grep -Fq 'profiles: ["omp"]' "$COMPOSE"
grep -Fq 'internal: true' "$COMPOSE"
grep -Fq '/run/user/${APP_UID:?APP_UID is required}/docker.sock' "$COMPOSE"
grep -Fq 'OMP_BROKER_TOKEN_FILE: /run/secrets/sandbox_broker_token' "$COMPOSE"
grep -Fq 'SANDBOX_BROKER_ALLOWED_SOURCE_ADDRESSES:' "$COMPOSE"
grep -Fq 'OMP_BROKER_URL: http://sandbox-broker:8080' "$COMPOSE"
grep -Fq -- '- council-omp-model-gateway' "$COMPOSE"
if grep -Fq '/var/run/docker.sock' "$COMPOSE"; then
  printf '%s\n' 'Rootful Docker socket must never appear in Council Compose.' >&2
  exit 1
fi

grep -Fq 'docker save "$OMP_RUNTIME_IMAGE"' "$PREPARE"
grep -Fq 'docker save "$MODEL_TUNNEL_IMAGE"' "$PREPARE"
grep -Fq -- '--internal' "$PREPARE"
grep -Fq 'UPSTREAM_API_KEY_FILE=/run/secrets/gb10_litellm_agent_key' "$PREPARE"
grep -Fq 'OMP_WORKSPACE_ARCHIVE_DIGEST=' "$PREPARE"

for control in rootless noNewPrivileges readOnlyRootfs denyAllEgress hostSocketAbsent hostNetworkAbsent resourceLimitsEnforced; do
  grep -Fq "\"${control}\": True" "$VERIFY"
done
grep -Fq 'council-omp-model-gateway' "$VERIFY"
grep -Fq '169.254.169.254' "$VERIFY"
grep -Fq '203.0.113.10' "$VERIFY"
grep -Fq 'brokerImageDigest' "$VERIFY"

grep -Fq 'flock --nonblock 9' "$REFRESH"
grep -Fq 'verify-omp-isolation.sh' "$REFRESH"
grep -Fq 'source "$compose_helper"' "$REFRESH"
grep -Fq 'compose_with_deployment_environment "$STACK"' "$REFRESH"
grep -Fq 'docker compose --project-name "$stack" --env-file "$env_file" -f "$compose_file" "$@"' "$COMPOSE_HELPER"
grep -Fq 'OMP_BROKER_IMAGE_DIGEST' "$REFRESH"
grep -Fq 'OnUnitActiveSec=12h' "$TIMER"
grep -Fq 'Persistent=true' "$TIMER"
grep -Fq 'NoNewPrivileges=true' "$SERVICE"

grep -Fq 'prepare-omp-rootless-runtime.sh' "$DEPLOY"
grep -Fq 'verify-omp-isolation.sh' "$DEPLOY"
grep -Fq 'COMPOSE_PROFILES=omp' "$DEPLOY"
grep -Fq 'council-omp-attestation.timer' "$DEPLOY"

printf '%s\n' 'OMP production wiring policy tests passed'
