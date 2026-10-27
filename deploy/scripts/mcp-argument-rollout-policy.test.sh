#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CREATE_RELEASE="${ROOT}/deploy/scripts/create-release.sh"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"
ROLLBACK="${ROOT}/deploy/scripts/rollback-remote.sh"
COMPOSE="${ROOT}/deploy/compose.yaml"
ENV_EXAMPLE="${ROOT}/deploy/.env.example"
QUEUE="${ROOT}/apps/api/src/agent-queue.ts"
QUEUE_INSPECTOR="${ROOT}/apps/worker/src/mcp-queue-compatibility-cli.ts"
RUNBOOK="${ROOT}/docs/operations/REMOTE_DOCKER_DEPLOYMENT.md"

bash -n "$CREATE_RELEASE" "$DEPLOY" "$ROLLBACK"

grep -Fq '"mcpArgumentPayloadReaders": ["legacy_plaintext", "vault_v1"]' "$CREATE_RELEASE"
grep -Fq '"mcpRequestFingerprintReaders": ["legacy_sha256", "hmac_sha256_v1"]' "$CREATE_RELEASE"
grep -Fq '"mcpAdmissionProtocols": ["atomic_v1"]' "$CREATE_RELEASE"
grep -Fq '"mcpFailureReceipts": ["argument_free_v1"]' "$CREATE_RELEASE"
grep -Fq 'MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED: ${MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED:-true}' "$COMPOSE"
grep -Fq 'MCP_KEYED_FINGERPRINT_WRITE_ENABLED: ${MCP_KEYED_FINGERPRINT_WRITE_ENABLED:-true}' "$COMPOSE"
grep -Fq 'MCP_LEGACY_ARGUMENT_READER_ENABLED: ${MCP_LEGACY_ARGUMENT_READER_ENABLED:-true}' "$COMPOSE"
grep -Fxq 'MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED=true' "$ENV_EXAMPLE"
grep -Fxq 'MCP_KEYED_FINGERPRINT_WRITE_ENABLED=true' "$ENV_EXAMPLE"
grep -Fxq 'MCP_LEGACY_ARGUMENT_READER_ENABLED=true' "$ENV_EXAMPLE"

grep -Fq 'Encrypted MCP writes require a reader-capable release to be deployed first.' "$DEPLOY"
grep -Fq 'Legacy MCP argument jobs remain queued; refusing to disable the legacy reader.' "$DEPLOY"
grep -Fq 'Pre-atomic MCP jobs or reservations remain' "$DEPLOY"
grep -Fq 'Keyed MCP fingerprint writes require an atomic HMAC-reader release' "$DEPLOY"
grep -Fq 'Encrypted MCP argument jobs remain queued; refusing rollback to a release without a vault_v1 reader.' "$ROLLBACK"
grep -Fq 'Rollback target cannot preserve encrypted MCP writes without a vault_v1 reader.' "$ROLLBACK"
grep -Fq 'Rollback target cannot preserve keyed MCP writes without HMAC reader and atomic admission.' "$ROLLBACK"
grep -Fq 'Rollback target must support argument-free MCP failure receipts.' "$ROLLBACK"
if grep -Fq 'set_env_value MCP_' "$ROLLBACK"; then
  printf '%s\n' 'Rollback must preserve the current MCP writer and reader settings.' >&2
  exit 1
fi
grep -Fq 'mcp-queue-compatibility-cli.js' "$DEPLOY"
grep -Fq 'mcp-queue-compatibility-cli.js' "$ROLLBACK"
grep -Fq 'process.exitCode = matched > 0 ? 0 : 10' "$QUEUE_INSPECTOR"

deploy_stop_line="$(awk '$0 == "  previous_compose stop api worker" { print NR; exit }' "$DEPLOY")"
deploy_scan_line="$(awk '$0 == "  current_queue_contains_mcp_payload legacy_plaintext" { line=NR } END { print line }' "$DEPLOY")"
rollback_stop_line="$(awk '$0 == "source_compose stop api worker" { print NR; exit }' "$ROLLBACK")"
rollback_scan_line="$(awk '$0 == "  source_queue_contains_mcp_payload vault_v1" { line=NR } END { print line }' "$ROLLBACK")"

if [[ -z "$deploy_stop_line" || -z "$deploy_scan_line" || "$deploy_stop_line" -ge "$deploy_scan_line" ]]; then
  printf '%s\n' 'Deployment must stop the previous writers before checking for legacy MCP jobs.' >&2
  exit 1
fi
if [[ -z "$rollback_stop_line" || -z "$rollback_scan_line" || "$rollback_stop_line" -ge "$rollback_scan_line" ]]; then
  printf '%s\n' 'Rollback must stop source writers before checking encrypted MCP jobs.' >&2
  exit 1
fi

grep -Fq 'removeOnFail: retainedMcpFailures' "$QUEUE"
grep -A8 'async enqueueToolCall' "$QUEUE" | grep -Fq 'attempts: 1'
grep -Fq 'age: 7 * 24 * 60 * 60' "$QUEUE"
grep -Fq 'count: 500' "$QUEUE"
if grep -A8 'async enqueueToolCall' "$QUEUE" | grep -Fq 'removeOnFail: true'; then
  printf '%s\n' 'MCP failures must be retained for bounded reconciliation.' >&2
  exit 1
fi

grep -Fq 'reader-first' "$RUNBOOK"
grep -Fq 'vault_v1' "$RUNBOOK"

printf '%s\n' 'MCP argument rollout policy tests passed'
