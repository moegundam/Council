#!/usr/bin/env bash

set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
RELEASES_ROOT="${ROOT}/releases/${STACK}"
DATA_ROOT="${ROOT}/data/${STACK}"
ENV_FILE="${COMPOSE_DIR}/.env"
COMPOSE_FILE="${COMPOSE_DIR}/compose.yaml"
CURRENT_RELEASE="${RELEASES_ROOT}/current"
LOCK_FILE="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/council-omp-attestation.lock"

exec 9>"$LOCK_FILE"
flock --nonblock 9 || {
  printf '%s\n' 'OMP attestation refresh is already running.'
  exit 0
}

if [[ ! -f "$ENV_FILE" || ! -f "$COMPOSE_FILE" || ! -L "$CURRENT_RELEASE" ]]; then
  printf '%s\n' 'Council deployment is not present; skipping OMP attestation refresh.'
  exit 0
fi

env_value() {
  local key="$1"
  local count

  count="$(awk -F= -v key="$key" '$1 == key { count += 1 } END { print count + 0 }' "$ENV_FILE")"
  if [[ "$count" != 1 ]]; then
    printf 'Expected exactly one %s entry in %s.\n' "$key" "$ENV_FILE" >&2
    return 1
  fi
  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$ENV_FILE"
}

runtime_enabled="$(env_value OMP_RUNTIME_ENABLED)"
if [[ "$runtime_enabled" != true ]]; then
  printf '%s\n' 'OMP runtime is disabled; no attestation refresh is required.'
  exit 0
fi

release_version="$(env_value RELEASE_VERSION)"
runtime_digest="$(env_value OMP_RUNTIME_IMAGE_DIGEST)"
expected_broker_digest="$(env_value OMP_BROKER_IMAGE_DIGEST)"
if [[ ! "$release_version" =~ ^[0-9]{8}T[0-9]{6}Z$ \
  || ! "$runtime_digest" =~ ^sha256:[a-f0-9]{64}$ \
  || ! "$expected_broker_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'OMP attestation refresh found invalid immutable bindings.' >&2
  exit 1
fi

release_root="$(readlink -f "$CURRENT_RELEASE")"
case "$release_root" in
  "${RELEASES_ROOT}"/*) ;;
  *)
    printf '%s\n' 'Current release pointer escaped the Council releases root.' >&2
    exit 1
    ;;
esac
compose_helper="${release_root}/deploy/scripts/compose-environment.sh"
if [[ ! -r "$compose_helper" ]]; then
  legacy_refresh="${release_root}/deploy/scripts/refresh-omp-attestation.sh"
  [[ -x "$legacy_refresh" ]] || {
    printf 'Current release has no compatible OMP attestation refresh script: %s\n' "$legacy_refresh" >&2
    exit 1
  }
  legacy_refresh_resolved="$(readlink -f "$legacy_refresh")"
  running_refresh_resolved="$(readlink -f "${BASH_SOURCE[0]}")"
  if [[ "$legacy_refresh_resolved" == "$running_refresh_resolved" ]]; then
    printf '%s\n' 'Current release OMP attestation refresh fallback resolves to itself.' >&2
    exit 1
  fi
  if [[ "$legacy_refresh_resolved" != "$legacy_refresh" ]]; then
    printf 'Current release OMP attestation refresh fallback escaped its release path: %s\n' "$legacy_refresh_resolved" >&2
    exit 1
  fi
  printf 'Shared Compose helper is absent; delegating to current release refresh script: %s\n' "$legacy_refresh_resolved"
  exec 9>&-
  exec "$legacy_refresh_resolved"
fi
verify_script="${release_root}/deploy/scripts/verify-omp-isolation.sh"
[[ -x "$verify_script" ]] || {
  printf 'Current release has no executable OMP verifier: %s\n' "$verify_script" >&2
  exit 1
}
# shellcheck disable=SC1090
source "$compose_helper"

broker_image="agent-meeting-platform-sandbox-broker:${release_version}"
observed_broker_digest="$(docker image inspect "$broker_image" --format '{{.Id}}')"
if [[ "$observed_broker_digest" != "$expected_broker_digest" ]]; then
  printf '%s\n' 'Installed OMP broker image does not match the approved environment digest.' >&2
  exit 1
fi

install -d -m 700 "${DATA_ROOT}/omp-isolation"
timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
OMP_RUNTIME_IMAGE_DIGEST="$runtime_digest" \
  OMP_BROKER_IMAGE="$broker_image" \
  ATTESTATION_FILE="${DATA_ROOT}/omp-isolation/attestation.json" \
  EVIDENCE_FILE="${DATA_ROOT}/omp-isolation/evidence-refresh-${timestamp}.json" \
  bash "$verify_script"

container_id="$(compose_with_deployment_environment "$STACK" "$ENV_FILE" "$COMPOSE_FILE" ps --all --quiet sandbox-broker 2>/dev/null | head -n 1 || true)"
state=missing
if [[ -n "$container_id" ]]; then
  state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthcheck-missing{{end}}' "$container_id")"
fi
if [[ "$state" != 'running healthy' ]]; then
  compose_with_deployment_environment "$STACK" "$ENV_FILE" "$COMPOSE_FILE" up -d sandbox-broker
fi

for _ in $(seq 1 60); do
  container_id="$(compose_with_deployment_environment "$STACK" "$ENV_FILE" "$COMPOSE_FILE" ps --all --quiet sandbox-broker 2>/dev/null | head -n 1 || true)"
  if [[ -n "$container_id" \
    && "$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}healthcheck-missing{{end}}' "$container_id")" == 'running healthy' ]]; then
    printf 'OMP attestation refreshed at %s; sandbox broker is healthy.\n' "$timestamp"
    exit 0
  fi
  sleep 2
done

printf '%s\n' 'OMP sandbox broker did not become healthy after attestation refresh.' >&2
exit 1
