#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${ROOT}/deploy/scripts/run-disposable-e2e-container.sh"
RELEASE="${ROOT}/deploy/scripts/create-release.sh"
CONFIG="${ROOT}/playwright.config.ts"

grep -Fq 'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:' "$RUNNER"
grep -Fq -- '--mount "type=bind,src=${ROOT},dst=/workspace,readonly"' "$RUNNER"
grep -Fq -- '--network host' "$RUNNER"
grep -Fq -- '--read-only' "$RUNNER"
grep -Fq -- '--cap-drop ALL' "$RUNNER"
grep -Fq -- '--user "${HOST_UID}:${HOST_GID}"' "$RUNNER"
grep -Fq -- '--env E2E_DEPLOYMENT_CLASS=disposable' "$RUNNER"
grep -Fq -- '--env E2E_DIRECT_NODE_MODULES=true' "$RUNNER"
grep -Fq -- '--env E2E_REUSE_EXISTING_SERVERS=false' "$RUNNER"
grep -Fq 'pnpm run test:e2e:container' "$RELEASE"
grep -Fq 'directNodeModules && reuseExistingServers' "$CONFIG"

verify_line="$(awk '/pnpm run verify:release/ { print NR; exit }' "$RELEASE")"
e2e_line="$(awk '/pnpm run test:e2e:container/ { print NR; exit }' "$RELEASE")"
status_line="$(awk '/POST_VERIFY_GIT_STATUS=/ { print NR; exit }' "$RELEASE")"
if [[ -z "$verify_line" || -z "$e2e_line" || -z "$status_line" \
  || "$verify_line" -ge "$e2e_line" || "$e2e_line" -ge "$status_line" ]]; then
  printf '%s\n' 'Release E2E must run after verification and before the clean-tree recheck.' >&2
  exit 1
fi

printf '%s\n' 'release containerized E2E gate policy tests passed'
