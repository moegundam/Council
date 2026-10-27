#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS="${ROOT}/packages/contracts/src/tool-pack-contracts.ts"
CONTRACT_INDEX="${ROOT}/packages/contracts/src/index.ts"
CONTRACT_PACKAGE="${ROOT}/packages/contracts/package.json"
STORE="${ROOT}/packages/database/src/memory-store.ts"
DIGEST="${ROOT}/packages/database/src/tool-pack-governance.ts"
AGENT_DIGEST="${ROOT}/packages/database/src/agent-revision-governance.ts"
POSTGRES_STORE="${ROOT}/packages/database/src/postgres-store.ts"
READINESS="${ROOT}/packages/domain/src/agent-readiness.ts"
MIGRATIONS="${ROOT}/packages/database/src/migrations.ts"
API="${ROOT}/apps/api/src/routes/management-routes.ts"
BROKER="${ROOT}/apps/sandbox-broker/src/tool-pack-registry.ts"
AGENT_UI="${ROOT}/apps/web/src/components/agents-view.tsx"
PACK_UI="${ROOT}/apps/web/src/components/tool-pack-registry.tsx"
PACK_MANAGEMENT="${ROOT}/apps/web/src/components/tool-pack-management.tsx"

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

grep -Fq 'version: toolPackSemanticVersionSchema' "$CONTRACTS"
grep -Fq '"./tool-pack-contracts"' "$CONTRACT_PACKAGE"
grep -Fq '"./runtime-contracts"' "$CONTRACT_PACKAGE"
grep -Fq '@council/contracts/tool-pack-contracts' "$CONTRACT_INDEX"
grep -Fq '@council/contracts/runtime-contracts' "$CONTRACT_INDEX"
grep -Fq 'toolPackSourceReferenceSchema' "$CONTRACTS"
grep -Fq 'toolPackEnvironmentNameSchema' "$CONTRACTS"
grep -Fq 'access: z.literal("read_only")' "$CONTRACTS"
grep -Fq 'createHash("sha256")' "$DIGEST"
grep -Fq 'manifestDigest: createToolPackManifestDigest(normalized)' "$STORE"
grep -Fq 'manifestDigest: createToolPackManifestDigest' "$STORE"
grep -Fq 'toolPackManifestDigestIsValid' "$STORE"
grep -Fq 'toolPackManifestDigestIsValid' "$POSTGRES_STORE"
grep -Fq 'agentRevisionContentDigestIsValid' "$POSTGRES_STORE"
grep -Fq 'contentDigestVersion === 1' "$AGENT_DIGEST"
grep -Fq 'toolPackGrantIsCurrentAndApproved' "$READINESS"
grep -Fq '020_tool_pack_governance' "$MIGRATIONS"
grep -Fq "'contentDigestVersion'" "$MIGRATIONS"
grep -Fq '/api/tool-packs/:id/approve' "$API"
grep -Fq '/api/tool-packs/:id/revoke' "$API"
grep -Fq 'toolPackEnvironmentNameSchema' "$BROKER"
grep -Fq 'toolPackSourceReferenceSchema' "$BROKER"
grep -Fq 'toolPackGrants' "$AGENT_UI"
grep -Fq 'Runtime Profiles' "$AGENT_UI"
grep -Fq 'Tool Packs' "$AGENT_UI"
grep -Fq 'type="password"' "$PACK_MANAGEMENT"

TOOL_PACK_MANIFEST_BLOCK="$(sed -n '/const toolPackManifestFields = {/,/^};/p' "$CONTRACTS")"
if [[ -z "$TOOL_PACK_MANIFEST_BLOCK" ]]; then
  printf '%s\n' 'Tool Pack manifest policy block is missing; refusing to pass.' >&2
  exit 1
fi
assert_no_match 'Tool Pack create/update manifests must not trust a caller-supplied digest.' \
  grep -Fq 'manifestDigest' <<<"$TOOL_PACK_MANIFEST_BLOCK"
assert_no_match 'Tool Pack management must not expose external_write.' \
  grep -Eq 'external_write' "$PACK_UI" "$PACK_MANAGEMENT"
assert_no_match 'Tool Pack detail must not expose argv, executable paths, or environment names.' \
  grep -Eq 'argv|executable|allowedNames' "$PACK_UI"
assert_no_match 'Tool Pack execution controls must remain absent until R4 isolation passes.' \
  grep -Eq 'onExecute|執行</button>|Play[,( ]' "$PACK_UI" "$PACK_MANAGEMENT"
assert_no_match 'Tool Pack execution must remain disconnected from Worker until R4 isolation passes.' \
  grep -REq --include='*.ts' --include='*.tsx' 'HttpSandboxBackend|SandboxBackend' "${ROOT}/apps/worker/src"

printf '%s\n' 'QM runtime R5 fail-closed policy tests passed'
