#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
DOMAIN_POLICY="${ROOT}/packages/domain/src/runtime-policy.ts"
BROKER_MAIN="${ROOT}/apps/sandbox-broker/src/main.ts"
BROKER_SOURCE="${ROOT}/apps/sandbox-broker/src/sandbox-broker.ts"
BACKEND_SOURCE="${ROOT}/packages/runtime/src/sandbox-backend.ts"
AGENT_UI="${ROOT}/apps/web/src/components/agents-view.tsx"

assert_no_match() {
  local message="$1"
  shift
  local status
  if "$@"; then
    printf '%s\n' "$message" >&2
    exit 1
  else
    status=$?
  fi
  if (( status != 1 )); then
    printf 'Policy scan failed with status %s; refusing to pass: %s\n' "$status" "$message" >&2
    exit 1
  fi
}

grep -Fq 'executionIsolationAttested !== true' "$DOMAIN_POLICY"
grep -Fq 'SANDBOX_BROKER_TOKEN_FILE' "$BROKER_MAIN"
assert_no_match 'Sandbox broker credentials must be read from a mounted secret file.' \
  grep -Fq 'readRequired("SANDBOX_BROKER_TOKEN")' "$BROKER_MAIN"
grep -Fq 'SANDBOX_BROKER_EXECUTION_ISOLATION_ATTESTATION_FILE' "$BROKER_MAIN"
grep -Fq 'SANDBOX_BROKER_IMAGE_DIGEST' "$BROKER_MAIN"
assert_no_match 'A boolean environment flag is not valid OS isolation evidence.' \
  grep -Fq 'SANDBOX_BROKER_EXECUTION_ISOLATION_ATTESTED' "$BROKER_MAIN"
grep -Fq 'detached: process.platform !== "win32"' "$BROKER_SOURCE"
grep -Fq 'process.kill(-child.pid' "$BROKER_SOURCE"
grep -Fq 'Sandbox broker redirects are forbidden.' "$BACKEND_SOURCE"
grep -Fq 'Sandbox broker returned a mismatched destroyed lease.' "$BACKEND_SOURCE"
grep -Fq 'disabled={!ompRuntimeUiEnabled || runtimeDraft.harnessKind !== "pi"}' "$AGENT_UI"
assert_no_match 'Unverified raw Sandbox identifiers must not be exposed in the Agent editor.' \
  grep -Fq 'Sandbox profile ID' "$AGENT_UI"

grep -Eq '^  sandbox-broker:' "$COMPOSE"
assert_no_match 'Platform services must not mount the host Docker socket.' \
  grep -Fq '/var/run/docker.sock' "$COMPOSE"
assert_no_match 'SandboxBackend must remain disconnected from Worker until live isolation evidence passes.' \
  grep -REq --include='*.ts' --include='*.tsx' 'HttpSandboxBackend|SandboxBackend' "${ROOT}/apps/worker/src"

WORKER_BLOCK="$(awk '/^  worker:/{capture=1} capture && /^  [a-zA-Z0-9_-]+:/ && $1 != "worker:" && NR > 1 {exit} capture{print}' "$COMPOSE")"
BROKER_BLOCK="$(awk '/^  sandbox-broker:/{capture=1} capture && /^  [a-zA-Z0-9_-]+:/ && $1 != "sandbox-broker:" && NR > 1 {exit} capture{print}' "$COMPOSE")"
if [[ -z "$WORKER_BLOCK" ]]; then
  printf '%s\n' 'Worker Compose policy block is missing; refusing to pass.' >&2
  exit 1
fi
if [[ -z "$BROKER_BLOCK" ]]; then
  printf '%s\n' 'Sandbox Broker Compose policy block is missing; refusing to pass.' >&2
  exit 1
fi
assert_no_match 'Worker must not receive privileged or host-network execution.' \
  grep -Eq 'privileged:[[:space:]]*true|network_mode:[[:space:]]*host' <<<"$WORKER_BLOCK"
grep -Fq 'profiles: ["omp"]' <<<"$BROKER_BLOCK"
grep -Fq '/run/user/${APP_UID:?APP_UID is required}/docker.sock' <<<"$BROKER_BLOCK"
grep -Fq 'SANDBOX_BROKER_EXECUTION_ISOLATION_ATTESTATION_FILE' <<<"$BROKER_BLOCK"
grep -Fq '<<: *app-security' <<<"$BROKER_BLOCK"
grep -Fq 'read_only: true' <<<"$BROKER_BLOCK"

printf '%s\n' 'QM runtime R4 fail-closed policy tests passed'
