#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="${ROOT}/deploy/scripts/run-release-e2e-remote.sh"
RELEASE="${ROOT}/deploy/scripts/create-release.sh"

grep -Fq 'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:' "$RUNNER"
grep -Fq 'git -C "$ROOT" archive --format=tar.gz' "$RUNNER"
grep -Fq 'remote_ssh "install -d -m 700' "$RUNNER"
grep -Fq -- '--network bridge' "$RUNNER"
grep -Fq -- '--read-only' "$RUNNER"
grep -Fq -- '--cap-drop ALL' "$RUNNER"
grep -Fq -- '--security-opt no-new-privileges' "$RUNNER"
grep -Fq -- '--pids-limit 1024' "$RUNNER"
grep -Fq -- '--memory 4g' "$RUNNER"
grep -Fq -- '--mount "type=bind,src=${SOURCE_ROOT},dst=/workspace"' "$RUNNER"
grep -Fq 'corepack enable --install-directory "$COREPACK_HOME/bin" pnpm' "$RUNNER"
grep -Fq 'export PATH="$COREPACK_HOME/bin:$PATH"' "$RUNNER"
grep -Fq 'pnpm run test:e2e' "$RUNNER"
grep -Fq 'release-e2e-evidence-validator.py' "$RUNNER"
grep -Fq 'RELEASE_E2E_EVIDENCE_FILE' "$RELEASE"

for forbidden in '/var/run/docker.sock' '--network host' '--privileged' '--cap-add' '/home/council/.ssh' '/opt/council/secrets'; do
  if grep -Fq -- "$forbidden" "$RUNNER"; then
    printf 'Remote release E2E runner contains forbidden boundary: %s\n' "$forbidden" >&2
    exit 1
  fi
done

printf '%s\n' 'remote release E2E runner policy tests passed'
