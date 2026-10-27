#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
DOCKERFILE="${ROOT}/deploy/Dockerfile"
HARNESS="${ROOT}/packages/runtime/src/codex-cli-harness.ts"
RUNTIME="${ROOT}/apps/worker/src/codex-runtime.ts"

grep -Fq 'npm install --global @openai/codex@0.146.0' "$DOCKERFILE"
grep -Fq 'CODEX_CLI_HARNESS_ENABLED: "false"' "$COMPOSE"
grep -Fq 'environment.CODEX_CLI_HARNESS_ENABLED !== "true"' "$RUNTIME"
grep -Fq '"--sandbox", "read-only"' "$HARNESS"
grep -Fq '"--ignore-user-config"' "$HARNESS"
grep -Fq '"--ephemeral"' "$HARNESS"
grep -Fq 'shell: false' "$HARNESS"

WORKER_BLOCK="$(awk '/^  worker:/{capture=1} capture && /^  [a-zA-Z0-9_-]+:/ && $1 != "worker:" && NR > 1 {exit} capture{print}' "$COMPOSE")"

if grep -Fq '/var/run/docker.sock' <<<"$WORKER_BLOCK"; then
  printf '%s\n' 'Codex Runtime must not receive the Docker socket.' >&2
  exit 1
fi
if grep -Eq 'privileged:[[:space:]]*true|network_mode:[[:space:]]*host' <<<"$WORKER_BLOCK"; then
  printf '%s\n' 'Codex Runtime must not use privileged or host-network execution.' >&2
  exit 1
fi
if grep -Fq '...process.env' "$RUNTIME"; then
  printf '%s\n' 'Codex child environment must remain an explicit allowlist.' >&2
  exit 1
fi

printf '%s\n' 'QM runtime R3 policy tests passed'
