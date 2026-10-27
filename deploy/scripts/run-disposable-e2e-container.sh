#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e"
CONTAINER_NAME="council-release-e2e-$$"
WEB_PORT="${E2E_RELEASE_WEB_PORT:-33000}"
APP_PORT="${E2E_RELEASE_APP_PORT:-33001}"
API_PORT="${E2E_RELEASE_API_PORT:-34000}"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Docker is required for the release Playwright gate.' >&2
  exit 1
fi
if ! command -v ss >/dev/null 2>&1; then
  printf '%s\n' 'The ss command is required to prove disposable E2E ports are unused.' >&2
  exit 1
fi
if ! docker image inspect "$PLAYWRIGHT_IMAGE" >/dev/null 2>&1; then
  printf 'Pinned Playwright image is unavailable: %s\n' "$PLAYWRIGHT_IMAGE" >&2
  exit 1
fi
if [[ ! -f "${ROOT}/node_modules/@playwright/test/cli.js" || ! -f "${ROOT}/node_modules/tsx/dist/cli.mjs" ]]; then
  printf '%s\n' 'Release Playwright dependencies are not installed in the verified workspace.' >&2
  exit 1
fi
if [[ ! -f "${ROOT}/apps/web/.next/standalone/apps/web/server.js" ]]; then
  printf '%s\n' 'The Goal-enabled standalone Web build is missing.' >&2
  exit 1
fi

for port in "$WEB_PORT" "$APP_PORT" "$API_PORT"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
    printf 'Invalid disposable E2E port: %s\n' "$port" >&2
    exit 1
  fi
  if ss -H -ltn "sport = :${port}" | grep -q .; then
    printf 'Disposable E2E port is already in use: %s\n' "$port" >&2
    exit 1
  fi
done
if [[ "$WEB_PORT" == "$APP_PORT" || "$WEB_PORT" == "$API_PORT" || "$APP_PORT" == "$API_PORT" ]]; then
  printf '%s\n' 'Disposable E2E ports must be distinct.' >&2
  exit 1
fi

docker run --rm --init \
  --name "$CONTAINER_NAME" \
  --network host \
  --ipc host \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=2g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user "${HOST_UID}:${HOST_GID}" \
  --pids-limit 1024 \
  --memory 4g \
  --cpus 4 \
  --mount "type=bind,src=${ROOT},dst=/workspace,readonly" \
  --workdir /workspace \
  --env E2E_DEPLOYMENT_CLASS=disposable \
  --env E2E_DISPOSABLE_MARKER=council-agent-meeting-platform-disposable-e2e-v1 \
  --env E2E_WEB_URL="http://127.0.0.1:${WEB_PORT}" \
  --env E2E_APP_UPSTREAM_URL="http://127.0.0.1:${APP_PORT}" \
  --env E2E_API_URL="http://127.0.0.1:${API_PORT}" \
  --env E2E_DIRECT_NODE_MODULES=true \
  --env E2E_REUSE_EXISTING_SERVERS=false \
  --env PLAYWRIGHT_OUTPUT_DIR=/tmp/council-playwright-results \
  --env HOME=/tmp \
  --env NEXT_TELEMETRY_DISABLED=1 \
  "$PLAYWRIGHT_IMAGE" \
  node /workspace/node_modules/@playwright/test/cli.js test "$@"

for port in "$WEB_PORT" "$APP_PORT" "$API_PORT"; do
  if ss -H -ltn "sport = :${port}" | grep -q .; then
    printf 'Disposable E2E listener survived container teardown: %s\n' "$port" >&2
    exit 1
  fi
done

trap - EXIT INT TERM
