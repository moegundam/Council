#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
DOCKERFILE="${ROOT}/deploy/Dockerfile"
ENV_EXAMPLE="${ROOT}/deploy/.env.example"
RUNTIME_PACKAGE="${ROOT}/packages/runtime/package.json"
MANIFEST="${ROOT}/deploy/governance/acs-mcp-readonly.manifest.yaml"
POLICY="${ROOT}/deploy/governance/policy/council-mcp-readonly.rego"
DEPLOY_SCRIPT="${ROOT}/deploy/scripts/deploy-remote.sh"
RELEASE_SCRIPT="${ROOT}/deploy/scripts/create-release.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

grep -Fq '"agent-control-specification": "0.3.1-beta.0"' "$RUNTIME_PACKAGE"
grep -Fq 'GOVERNANCE_PROVIDER: ${GOVERNANCE_PROVIDER:-native}' "$COMPOSE"
grep -Fq 'GOVERNANCE_MODE: ${GOVERNANCE_MODE:-off}' "$COMPOSE"
grep -Fq 'GOVERNANCE_TIMEOUT_MS: ${GOVERNANCE_TIMEOUT_MS:-2000}' "$COMPOSE"
grep -Fq 'ACS_OPA_TIMEOUT_MS: ${GOVERNANCE_TIMEOUT_MS:-2000}' "$COMPOSE"
grep -Fq 'COPY --chown=root:root deploy/governance /etc/council/governance' "$DOCKERFILE"
grep -Fq 'ARG WORKER_NODE_IMAGE=node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292' "$DOCKERFILE"
grep -Fq 'FROM ${WORKER_NODE_IMAGE} AS worker' "$DOCKERFILE"
worker_block="$(awk '/^  worker:/{capture=1} capture && /^  [a-zA-Z0-9_-]+:/ && $1 != "worker:" && NR > 1 {exit} capture{print}' "$COMPOSE")"
grep -Fq 'WORKER_NODE_IMAGE: node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292' <<<"$worker_block"
grep -Fq '"workerNodeImage": "node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292"' "$RELEASE_SCRIPT"
if grep -Fq '/deploy/governance:/etc/council/governance' "$COMPOSE"; then
  printf '%s\n' 'Governance policy must be image-owned, not a mutable host release mount.' >&2
  exit 1
fi
grep -Fq 'GOVERNANCE_PROVIDER=native' "$ENV_EXAMPLE"
grep -Fq 'GOVERNANCE_MODE=off' "$ENV_EXAMPLE"
grep -Fq 'GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS=/etc/council/governance/policy' "$ENV_EXAMPLE"
grep -Eq '^GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST=sha256:[a-f0-9]{64}$' "$ENV_EXAMPLE"
grep -Fq 'agent_control_specification_version: "0.3.1-beta"' "$MANIFEST"
grep -Fq 'council_mcp_readonly:' "$MANIFEST"
grep -Fq 'default pre_tool_call_verdict' "$POLICY"
grep -Fq 'GOVERNANCE_PROVIDER="${GOVERNANCE_PROVIDER:-native}"' "$DEPLOY_SCRIPT"
grep -Fq 'GOVERNANCE_MODE="${GOVERNANCE_MODE:-off}"' "$DEPLOY_SCRIPT"
grep -Fq 'ALLOW_GOVERNANCE_ENFORCE="${ALLOW_GOVERNANCE_ENFORCE:-false}"' "$DEPLOY_SCRIPT"
grep -Fq "GOVERNANCE_PROVIDER='\${GOVERNANCE_PROVIDER}' GOVERNANCE_MODE='\${GOVERNANCE_MODE}'" "$DEPLOY_SCRIPT"
grep -Fq 'GOVERNANCE_PROVIDER=%s\nGOVERNANCE_MODE=%s\nGOVERNANCE_TIMEOUT_MS=%s\n' "$DEPLOY_SCRIPT"
grep -Fq 'GOVERNANCE_ACS_MANIFEST_PATH=/etc/council/governance/acs-mcp-readonly.manifest.yaml' "$DEPLOY_SCRIPT"
grep -Fq 'GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS=/etc/council/governance/policy' "$DEPLOY_SCRIPT"
grep -Fq 'Governance policy digest must be a pinned SHA-256 value.' "$DEPLOY_SCRIPT"
grep -Fq 'Microsoft ACS enforce mode requires ALLOW_GOVERNANCE_ENFORCE=true.' "$DEPLOY_SCRIPT"
grep -Fq 'compose run --rm --no-deps worker node dist/governance-smoke-cli.js' "$DEPLOY_SCRIPT"
grep -Fq 'deniedResult.decision !== "deny"' "${ROOT}/apps/worker/src/governance-smoke-cli.ts"

governance_smoke_line="$(awk '/compose run --rm --no-deps worker node dist\/governance-smoke-cli.js/ { print NR; exit }' "$DEPLOY_SCRIPT")"
worker_start_line="$(awk '/compose up -d api worker web mcp-readonly model-tunnel task-adapter-reference gateway/ { print NR; exit }' "$DEPLOY_SCRIPT")"
release_commit_line="$(awk '/deployment_committed=true/ { print NR; exit }' "$DEPLOY_SCRIPT")"
if [[ -z "$governance_smoke_line" || -z "$worker_start_line" || -z "$release_commit_line" \
  || "$governance_smoke_line" -ge "$worker_start_line" || "$worker_start_line" -ge "$release_commit_line" ]]; then
  printf '%s\n' 'Governance runtime smoke must pass before the long-lived Worker starts and deployment is committed.' >&2
  exit 1
fi

dummy_bundle="${TEMP_ROOT}/dummy.tar.gz"
: >"$dummy_bundle"
: >"${dummy_bundle}.sha256"
dummy_ssh_key="${TEMP_ROOT}/dummy-ssh-key"
: >"$dummy_ssh_key"
chmod 600 "$dummy_ssh_key"
injection_marker="${TEMP_ROOT}/injected"
malicious_digest="sha256:invalid'; touch '${injection_marker}'; #"
if SSH_KEY="$dummy_ssh_key" GOVERNANCE_PROVIDER=native GOVERNANCE_MODE=off \
  GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST="$malicious_digest" \
  bash "$DEPLOY_SCRIPT" "$dummy_bundle" >"${TEMP_ROOT}/invalid-digest.out" 2>&1; then
  printf '%s\n' 'Native/off accepted an unsafe governance digest.' >&2
  exit 1
fi
grep -Fq 'Governance policy digest must be a pinned SHA-256 value.' "${TEMP_ROOT}/invalid-digest.out"
if [[ -e "$injection_marker" ]]; then
  printf '%s\n' 'Unsafe governance digest reached shell execution.' >&2
  exit 1
fi

example_digest="$(sed -n 's/^GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST=\(sha256:[a-f0-9]\{64\}\)$/\1/p' "$ENV_EXAMPLE")"
deploy_digest="$(sed -n 's/^GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST="${GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST:-\(sha256:[a-f0-9]\{64\}\)}"$/\1/p' "$DEPLOY_SCRIPT")"
if [[ -z "$example_digest" || "$deploy_digest" != "$example_digest" ]]; then
  printf '%s\n' 'Deployment and environment example must pin the same governance policy digest.' >&2
  exit 1
fi

if grep -Eq 'GOVERNANCE_MODE:[[:space:]]*("?enforce"?)$' "$COMPOSE"; then
  printf '%s\n' 'Microsoft ACS must not default to enforce before shadow review.' >&2
  exit 1
fi

printf '%s\n' 'Governance adapter default-off and policy pin tests passed'
