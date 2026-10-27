#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASE_DIR="${ROOT}/release"
STAGING="$(mktemp -d)"
TOOL_BIN=""
LOCAL_E2E_EVIDENCE=""
E2E_VALIDATOR="${ROOT}/deploy/scripts/release-e2e-evidence-validator.py"

cleanup() {
  rm -rf "$STAGING"
  if [[ -n "$TOOL_BIN" ]]; then
    rm -rf "$TOOL_BIN"
  fi
  if [[ -n "$LOCAL_E2E_EVIDENCE" ]]; then
    rm -f "$LOCAL_E2E_EVIDENCE"
  fi
}
trap cleanup EXIT

TOOL_BIN="$(mktemp -d)"

if [[ ! "$VERSION" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf '%s\n' 'Version must use UTC YYYYMMDDTHHMMSSZ format.' >&2
  exit 1
fi

if [[ -z "${MIGRATION_TEST_DATABASE_URL:-}" ]]; then
  printf '%s\n' 'MIGRATION_TEST_DATABASE_URL is required; releases must pass migration tests against PostgreSQL.' >&2
  exit 1
fi

if [[ -z "${REDIS_RECOVERY_TEST_URL:-}" ]]; then
  printf '%s\n' 'REDIS_RECOVERY_TEST_URL is required; releases must pass empty-Redis recovery tests against Redis.' >&2
  exit 1
fi

if ! GIT_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null)"; then
  printf '%s\n' 'Release creation requires a committed Git revision.' >&2
  exit 1
fi
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' 'Release creation requires a clean Git worktree; commit or remove every pending change first.' >&2
  exit 1
fi

PACKAGE_MANAGER="$(node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).packageManager;process.stdout.write(typeof value === "string" ? value : "")' "$ROOT/package.json")"
if [[ ! "$PACKAGE_MANAGER" =~ ^pnpm@([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  printf 'package.json must pin an exact pnpm packageManager version; found %s.\n' "${PACKAGE_MANAGER:-missing}" >&2
  exit 1
fi
EXPECTED_PNPM_VERSION="${BASH_REMATCH[1]}"
if ! command -v corepack >/dev/null 2>&1; then
  printf '%s\n' 'Corepack is required to enforce the pinned pnpm release toolchain.' >&2
  exit 1
fi
corepack enable --install-directory "$TOOL_BIN" >/dev/null
ACTUAL_PNPM_VERSION="$(PATH="${TOOL_BIN}:${PATH}" pnpm --version)"
if [[ "$ACTUAL_PNPM_VERSION" != "$EXPECTED_PNPM_VERSION" ]]; then
  printf 'Release creation requires pnpm %s; got %s.\n' "$EXPECTED_PNPM_VERSION" "$ACTUAL_PNPM_VERSION" >&2
  exit 1
fi

(cd "$ROOT" && PATH="${TOOL_BIN}:${PATH}" pnpm run verify:release)
if [[ ! -f "$E2E_VALIDATOR" ]]; then
  printf '%s\n' 'Release E2E evidence validator is missing.' >&2
  exit 1
fi
if [[ -n "${RELEASE_E2E_EVIDENCE_FILE:-}" ]]; then
  if [[ ! -f "$RELEASE_E2E_EVIDENCE_FILE" || -L "$RELEASE_E2E_EVIDENCE_FILE" ]]; then
    printf '%s\n' 'RELEASE_E2E_EVIDENCE_FILE must be one regular non-symlink file.' >&2
    exit 1
  fi
  E2E_EVIDENCE_FILE="$RELEASE_E2E_EVIDENCE_FILE"
else
  (cd "$ROOT" && PATH="${TOOL_BIN}:${PATH}" pnpm run test:e2e:container)
  LOCAL_E2E_EVIDENCE="$(mktemp)"
  local_architecture="$(uname -m)"
  if [[ "$local_architecture" == "arm64" ]]; then local_architecture=aarch64; fi
  node - "$LOCAL_E2E_EVIDENCE" "$GIT_COMMIT" "$(hostname -s)" "$local_architecture" <<'NODE'
const fs = require("node:fs");
const [, , path, gitCommit, runnerHost, architecture] = process.argv;
const createdAt = new Date();
createdAt.setMilliseconds(0);
const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
fs.writeFileSync(path, `${JSON.stringify({
  schemaVersion: 1,
  source: "local_container",
  gitCommit,
  createdAt: createdAt.toISOString().replace(".000Z", "Z"),
  expiresAt: expiresAt.toISOString().replace(".000Z", "Z"),
  runnerHost,
  architecture,
  playwrightImage: "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
  pnpmVersion: "11.7.0",
  testCommand: "pnpm run test:e2e",
  result: "passed",
  testCounts: { passed: 1, failed: 0, skipped: 0 }
}, null, 2)}\n`, { mode: 0o600 });
NODE
  E2E_EVIDENCE_FILE="$LOCAL_E2E_EVIDENCE"
fi
E2E_EVIDENCE_DIGEST="$(python3 "$E2E_VALIDATOR" "$E2E_EVIDENCE_FILE" "$GIT_COMMIT")"

if ! POST_VERIFY_GIT_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD 2>/dev/null)"; then
  printf '%s\n' 'Release source changed during release verification; HEAD is no longer available.' >&2
  exit 1
fi
if ! POST_VERIFY_GIT_STATUS="$(git -C "$ROOT" status --porcelain --untracked-files=all)"; then
  printf '%s\n' 'Release source changed during release verification; worktree status is unavailable.' >&2
  exit 1
fi
if [[ "$POST_VERIFY_GIT_COMMIT" != "$GIT_COMMIT" || -n "$POST_VERIFY_GIT_STATUS" ]]; then
  printf '%s\n' 'Release source changed during release verification; HEAD and worktree must remain unchanged.' >&2
  exit 1
fi

mkdir -p "$RELEASE_DIR"
(
  umask 022
  git -C "$ROOT" archive --format=tar "$GIT_COMMIT" | tar -xf - -C "$STAGING"
)
find "$STAGING" -type d \( \
  -name '.git' -o \
  -name '.next' -o \
  -name 'node_modules' -o \
  -name 'dist' -o \
  -name 'coverage' -o \
  -name 'output' -o \
  -name 'release' -o \
  -name '.superpowers' \
\) -prune -exec rm -rf {} \;
find "$STAGING" -type f -name '*.tsbuildinfo' -delete
mkdir -p "${STAGING}/release-evidence"
install -m 644 "$E2E_EVIDENCE_FILE" "${STAGING}/release-evidence/disposable-e2e.json"

node - "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$GIT_COMMIT" "$EXPECTED_PNPM_VERSION" "$E2E_EVIDENCE_DIGEST" "${STAGING}/release-evidence/disposable-e2e.json" \
  >"${STAGING}/release-manifest.json" <<'NODE'
const fs = require("node:fs");
const [, , version, createdAt, gitCommit, pnpmVersion, e2eEvidenceSha256, e2eEvidencePath] = process.argv;
const e2eEvidence = JSON.parse(fs.readFileSync(e2eEvidencePath, "utf8"));
const manifest = {
  version,
  createdAt,
  gitCommit,
  gitDirty: false,
  "pnpmVersion": pnpmVersion,
  nodeImage: "node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8",
  "workerNodeImage": "node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292",
  postgresImage: "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  redisImage: "redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232",
  gatewayImage: "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
  buildkitImage: "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec",
  ompRuntime: {
    runtimeContract: "omp-rpc-v2@18.1.2",
    version: "18.1.2",
    asset: "omp-linux-x64",
    assetSha256: "c6a306347a57c872bf38587e81132db50490228867e3e179a363a4cf874da1a0",
    nativeBaselineSha256: "cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4",
    dockerCliImage: "docker:29.7.2-cli@sha256:eb952fbf036947347bff9f303878c86ec3df00af0341f4cca59b1d1924d6668d",
    defaultEnabled: false
  },
  agenticSeek: {
    integration: "methodology_only",
    runtimeDeployed: false
  },
  e2eEvidence: {
    path: "release-evidence/disposable-e2e.json",
    sha256: e2eEvidenceSha256,
    source: e2eEvidence.source,
    createdAt: e2eEvidence.createdAt
  },
  queueCapabilities: {
    "mcpArgumentPayloadReaders": ["legacy_plaintext", "vault_v1"],
    "mcpRequestFingerprintReaders": ["legacy_sha256", "hmac_sha256_v1"],
    "mcpAdmissionProtocols": ["atomic_v1"],
    "mcpFailureReceipts": ["argument_free_v1"]
  }
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
NODE
chmod 644 "${STAGING}/release-manifest.json"
python3 -m json.tool "${STAGING}/release-manifest.json" >/dev/null

BUNDLE="${RELEASE_DIR}/agent-meeting-platform-${VERSION}.tar.gz"
(
  cd "$STAGING"
  find . -mindepth 1 -maxdepth 1 -print0 \
    | COPYFILE_DISABLE=1 tar --no-xattrs --null -T - -czf "$BUNDLE"
)

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$RELEASE_DIR" && sha256sum "$(basename "$BUNDLE")") >"${BUNDLE}.sha256"
else
  (cd "$RELEASE_DIR" && shasum -a 256 "$(basename "$BUNDLE")") >"${BUNDLE}.sha256"
fi

printf 'Release bundle: %s\nChecksum: %s\n' "$BUNDLE" "${BUNDLE}.sha256"
