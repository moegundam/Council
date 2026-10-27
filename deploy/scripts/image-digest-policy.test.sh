#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE="${DEPLOY_DIR}/compose.yaml"
DOCKERFILE="${DEPLOY_DIR}/Dockerfile"
OMP_DOCKERFILE="${DEPLOY_DIR}/omp-runtime.Dockerfile"
RELEASE_SCRIPT="${SCRIPT_DIR}/create-release.sh"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-remote.sh"
ROLLBACK_SCRIPT="${SCRIPT_DIR}/rollback-remote.sh"
RESTORE_SCRIPT="${SCRIPT_DIR}/verify-backup-restore.sh"

NODE_IMAGE='node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8'
POSTGRES_IMAGE='postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
REDIS_IMAGE='redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232'
CADDY_IMAGE='caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
DOCKER_CLI_IMAGE='docker:29.7.2-cli@sha256:eb952fbf036947347bff9f303878c86ec3df00af0341f4cca59b1d1924d6668d'
OMP_ASSET_SHA256='c6a306347a57c872bf38587e81132db50490228867e3e179a363a4cf874da1a0'
OMP_NATIVE_BASELINE_SHA256='cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4'
BUILDKIT_IMAGE='moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec'

fail() {
  printf 'image digest policy failed: %s\n' "$1" >&2
  exit 1
}

grep -Fqx "ARG NODE_IMAGE=${NODE_IMAGE}" "$DOCKERFILE" || fail 'Dockerfile Node image is not pinned'
if grep -Eq '^# syntax=' "$DOCKERFILE" "$OMP_DOCKERFILE"; then
  fail 'Dockerfiles must use the built-in frontend without registry resolution'
fi
grep -Fqx "ARG DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE}" "$DOCKERFILE" || fail 'Docker CLI image is not pinned'
grep -Fq "ARG OMP_ASSET_SHA256=${OMP_ASSET_SHA256}" "${DEPLOY_DIR}/omp-runtime.Dockerfile" || fail 'OMP binary checksum is not pinned'
grep -Fq "ARG OMP_NATIVE_BASELINE_SHA256=${OMP_NATIVE_BASELINE_SHA256}" "${DEPLOY_DIR}/omp-runtime.Dockerfile" || fail 'OMP native addon checksum is not pinned'
grep -Fq "image: ${POSTGRES_IMAGE}" "$COMPOSE" || fail 'Compose PostgreSQL image is not pinned'
grep -Fq "image: ${REDIS_IMAGE}" "$COMPOSE" || fail 'Compose Redis image is not pinned'
grep -Fq "image: ${CADDY_IMAGE}" "$COMPOSE" || fail 'Compose Caddy image is not pinned'
grep -Fq 'candidate_compose pull --policy missing postgres redis gateway' "$DEPLOY_SCRIPT" \
  || fail 'deployment must reuse locally present pinned service images during a registry outage'
grep -Fqx "BUILDKIT_IMAGE=${BUILDKIT_IMAGE}" "$DEPLOY_SCRIPT" \
  || fail 'deployment BuildKit driver image is not pinned'
grep -Fq -- '--driver-opt "image=${BUILDKIT_IMAGE}"' "$DEPLOY_SCRIPT" \
  || fail 'deployment does not create BuildKit with the pinned driver image'
if grep -F -- '--pull' "$DEPLOY_SCRIPT" | grep -Fvq -- '--pull never'; then
  fail 'deployment must not force registry revalidation for already cached pinned build inputs'
fi

node_arg_count="$(grep -Fc "NODE_IMAGE: ${NODE_IMAGE}" "$COMPOSE")"
[[ "$node_arg_count" -eq 9 ]] || fail "expected 9 pinned Compose Node build args, got ${node_arg_count}"
if grep -F 'NODE_IMAGE: node:24.14.0-bookworm-slim' "$COMPOSE" | grep -Fvq '@sha256:'; then
  fail 'Compose contains an unpinned Node build arg'
fi

for entry in \
  "${RELEASE_SCRIPT}:${NODE_IMAGE}" \
  "${RELEASE_SCRIPT}:${POSTGRES_IMAGE}" \
  "${RELEASE_SCRIPT}:${REDIS_IMAGE}" \
  "${RELEASE_SCRIPT}:${CADDY_IMAGE}" \
  "${RELEASE_SCRIPT}:${DOCKER_CLI_IMAGE}" \
  "${RELEASE_SCRIPT}:${OMP_ASSET_SHA256}" \
  "${RELEASE_SCRIPT}:${OMP_NATIVE_BASELINE_SHA256}" \
  "${RELEASE_SCRIPT}:${BUILDKIT_IMAGE}" \
  "${DEPLOY_SCRIPT}:${BUILDKIT_IMAGE}" \
  "${DEPLOY_SCRIPT}:${REDIS_IMAGE}" \
  "${ROLLBACK_SCRIPT}:${REDIS_IMAGE}" \
  "${RESTORE_SCRIPT}:${POSTGRES_IMAGE}"; do
  file="${entry%%:*}"
  image="${entry#*:}"
  grep -Fq "$image" "$file" || fail "$(basename "$file") does not use ${image}"
done

printf '%s\n' 'external image digest policy tests passed'
