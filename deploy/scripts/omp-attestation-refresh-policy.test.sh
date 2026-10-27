#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REFRESH_SCRIPT="${SCRIPT_DIR}/refresh-omp-attestation.sh"
ATTESTATION_UNIT="${SCRIPT_DIR}/../systemd/council-omp-attestation.service"
TEMP_ROOT="$(cd "$(mktemp -d)" && pwd -P)"
MOCK_BIN="${TEMP_ROOT}/bin"
ROOT="${TEMP_ROOT}/council"
STACK=agent-meeting-platform
VERSION=20260902T120000Z
RUNTIME_DIGEST="sha256:$(printf 'a%.0s' {1..64})"
BROKER_DIGEST="sha256:$(printf 'b%.0s' {1..64})"
RELEASE_ROOT="${ROOT}/releases/${STACK}/${VERSION}"
COMPOSE_DIR="${ROOT}/compose/${STACK}"
trap 'rm -rf "$TEMP_ROOT"' EXIT

mkdir -p \
  "$MOCK_BIN" \
  "$RELEASE_ROOT/deploy/scripts" \
  "$COMPOSE_DIR" \
  "${ROOT}/data/${STACK}" \
  "${ROOT}/releases/${STACK}"

printf '%s\n' 'services: {}' >"${COMPOSE_DIR}/compose.yaml"
printf '%s\n' \
  "RELEASE_VERSION=${VERSION}" \
  'OMP_RUNTIME_ENABLED=true' \
  "OMP_RUNTIME_IMAGE_DIGEST=${RUNTIME_DIGEST}" \
  "OMP_BROKER_IMAGE_DIGEST=${BROKER_DIGEST}" \
  >"${COMPOSE_DIR}/.env"
ln -s "$RELEASE_ROOT" "${ROOT}/releases/${STACK}/current"
cp "${SCRIPT_DIR}/compose-environment.sh" "${RELEASE_ROOT}/deploy/scripts/compose-environment.sh"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ "$OMP_BROKER_IMAGE" == "agent-meeting-platform-sandbox-broker:20260902T120000Z" ]]' \
  'printf "{}\n" >"$ATTESTATION_FILE"' \
  'printf "{}\n" >"$EVIDENCE_FILE"' \
  >"${RELEASE_ROOT}/deploy/scripts/verify-omp-isolation.sh"
chmod 755 "${RELEASE_ROOT}/deploy/scripts/verify-omp-isolation.sh"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then' \
  "  printf '%s\\n' '${BROKER_DIGEST}'" \
  '  exit 0' \
  'fi' \
  'if [[ "${1:-}" == inspect ]]; then' \
  "  printf '%s\\n' 'running healthy'" \
  '  exit 0' \
  'fi' \
  'for argument in "$@"; do' \
  '  if [[ "$argument" == ps ]]; then' \
  "    printf '%s\\n' 'sandbox-broker-id'" \
  '    exit 0' \
  '  fi' \
  'done' \
  'exit 0' \
  >"${MOCK_BIN}/docker"
chmod 755 "${MOCK_BIN}/docker"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exit 0' \
  >"${MOCK_BIN}/flock"
chmod 755 "${MOCK_BIN}/flock"

PATH="${MOCK_BIN}:${PATH}" \
XDG_RUNTIME_DIR="$TEMP_ROOT" \
COUNCIL_ROOT="$ROOT" \
OMP_RUNTIME_ENABLED=false \
AUTH_DISABLED=true \
  bash "$REFRESH_SCRIPT"

test -s "${ROOT}/data/${STACK}/omp-isolation/attestation.json"
find "${ROOT}/data/${STACK}/omp-isolation" -maxdepth 1 \
  -name 'evidence-refresh-*.json' -type f -size +0c | grep -q .
grep -Fq 'env_value RELEASE_VERSION' "$REFRESH_SCRIPT"
grep -Fq 'compose_with_deployment_environment' "$REFRESH_SCRIPT"
if grep -Fq 'env_value IMAGE_TAG' "$REFRESH_SCRIPT"; then
  printf '%s\n' 'Attestation refresh still depends on the obsolete IMAGE_TAG key.' >&2
  exit 1
fi
grep -Fqx 'PrivateTmp=false' "$ATTESTATION_UNIT"
grep -Fqx 'ProtectHome=false' "$ATTESTATION_UNIT"
grep -Fqx 'ProtectSystem=false' "$ATTESTATION_UNIT"
if grep -Eq '^(PrivateTmp=true|ProtectHome=(yes|read-only|tmpfs)|ProtectSystem=(yes|full|strict)|ReadWritePaths=)' "$ATTESTATION_UNIT"; then
  printf '%s\n' 'Filesystem mount namespacing blocks the approved Rootless Docker socket on the production host.' >&2
  exit 1
fi
grep -Fqx 'NoNewPrivileges=true' "$ATTESTATION_UNIT"
grep -Fqx 'RestrictAddressFamilies=AF_UNIX' "$ATTESTATION_UNIT"

LEGACY_VERSION=20260901T120000Z
LEGACY_RELEASE_ROOT="${ROOT}/releases/${STACK}/${LEGACY_VERSION}"
LEGACY_MARKER="${TEMP_ROOT}/legacy-refresh-ran"
mkdir -p "${LEGACY_RELEASE_ROOT}/deploy/scripts"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  '[[ ! -e /dev/fd/9 ]]' \
  'exec 9>"${LEGACY_LOCK_FILE}"' \
  'flock --nonblock 9' \
  'printf "legacy refresh executed\\n" >"${LEGACY_MARKER}"' \
  >"${LEGACY_RELEASE_ROOT}/deploy/scripts/refresh-omp-attestation.sh"
chmod 755 "${LEGACY_RELEASE_ROOT}/deploy/scripts/refresh-omp-attestation.sh"
cp "$REFRESH_SCRIPT" "${COMPOSE_DIR}/refresh-omp-attestation.sh"
chmod 755 "${COMPOSE_DIR}/refresh-omp-attestation.sh"
ln -sfn "$LEGACY_RELEASE_ROOT" "${ROOT}/releases/${STACK}/current"

PATH="${MOCK_BIN}:${PATH}" \
XDG_RUNTIME_DIR="$TEMP_ROOT" \
COUNCIL_ROOT="$ROOT" \
LEGACY_LOCK_FILE="${TEMP_ROOT}/legacy-refresh.lock" \
LEGACY_MARKER="$LEGACY_MARKER" \
  bash "${COMPOSE_DIR}/refresh-omp-attestation.sh"
grep -Fqx 'legacy refresh executed' "$LEGACY_MARKER"

MISSING_RELEASE_ROOT="${ROOT}/releases/${STACK}/20260831T120000Z"
mkdir -p "${MISSING_RELEASE_ROOT}/deploy/scripts"
ln -sfn "$MISSING_RELEASE_ROOT" "${ROOT}/releases/${STACK}/current"
set +e
missing_output="$(PATH="${MOCK_BIN}:${PATH}" XDG_RUNTIME_DIR="$TEMP_ROOT" COUNCIL_ROOT="$ROOT" bash "${COMPOSE_DIR}/refresh-omp-attestation.sh" 2>&1)"
missing_status=$?
set -e
[[ "$missing_status" -eq 1 ]]
[[ "$missing_output" == *'no compatible OMP attestation refresh script'* ]]

SELF_RELEASE_ROOT="${ROOT}/releases/${STACK}/20260830T120000Z"
mkdir -p "${SELF_RELEASE_ROOT}/deploy/scripts"
ln -s "${COMPOSE_DIR}/refresh-omp-attestation.sh" "${SELF_RELEASE_ROOT}/deploy/scripts/refresh-omp-attestation.sh"
ln -sfn "$SELF_RELEASE_ROOT" "${ROOT}/releases/${STACK}/current"
set +e
self_output="$(PATH="${MOCK_BIN}:${PATH}" XDG_RUNTIME_DIR="$TEMP_ROOT" COUNCIL_ROOT="$ROOT" bash "${COMPOSE_DIR}/refresh-omp-attestation.sh" 2>&1)"
self_status=$?
set -e
[[ "$self_status" -eq 1 ]]
[[ "$self_output" == *'fallback resolves to itself'* ]]

printf '%s\n' 'OMP attestation refresh uses canonical bindings and safe legacy rollback fallback'
