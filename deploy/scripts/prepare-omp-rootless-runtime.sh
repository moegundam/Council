#!/usr/bin/env bash

set -euo pipefail

OMP_ROOTLESS_DOCKER_HOST="${OMP_ROOTLESS_DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
OMP_INTERNAL_NETWORK="${OMP_INTERNAL_NETWORK:-council-omp-internal}"
OMP_INTERNAL_SUBNET="${OMP_INTERNAL_SUBNET:-10.231.44.0/24}"
OMP_MODEL_GATEWAY_CONTAINER="${OMP_MODEL_GATEWAY_CONTAINER:-council-omp-model-gateway}"
OMP_WORKSPACE_SOURCE_ID="${OMP_WORKSPACE_SOURCE_ID:-council-canary}"
OMP_RUNTIME_IMAGE="${OMP_RUNTIME_IMAGE:?OMP_RUNTIME_IMAGE is required}"
MODEL_TUNNEL_IMAGE="${MODEL_TUNNEL_IMAGE:?MODEL_TUNNEL_IMAGE is required}"
OMP_SOURCE_DIRECTORY="${OMP_SOURCE_DIRECTORY:?OMP_SOURCE_DIRECTORY is required}"
OMP_SOURCE_ROOT="${OMP_SOURCE_ROOT:?OMP_SOURCE_ROOT is required}"
MODEL_TUNNEL_KEY_FILE="${MODEL_TUNNEL_KEY_FILE:?MODEL_TUNNEL_KEY_FILE is required}"
KNOWN_HOSTS_FILE="${KNOWN_HOSTS_FILE:?KNOWN_HOSTS_FILE is required}"
LITELLM_KEY_FILE="${LITELLM_KEY_FILE:?LITELLM_KEY_FILE is required}"
OUTPUT_ENV_FILE="${OUTPUT_ENV_FILE:?OUTPUT_ENV_FILE is required}"

if [[ ! "$OMP_ROOTLESS_DOCKER_HOST" =~ ^unix:///run/user/[1-9][0-9]*/docker\.sock$ ]]; then
  printf '%s\n' 'OMP rootless Docker host is outside the approved user socket path.' >&2
  exit 1
fi
for path in "$MODEL_TUNNEL_KEY_FILE" "$KNOWN_HOSTS_FILE" "$LITELLM_KEY_FILE"; do
  if [[ ! -f "$path" || -L "$path" || ! -s "$path" || "$(stat -c '%a' "$path")" != "600" ]]; then
    printf 'OMP gateway secret must be a non-empty mode-600 regular file: %s\n' "$path" >&2
    exit 1
  fi
done
if [[ ! -d "$OMP_SOURCE_DIRECTORY" || -L "$OMP_SOURCE_DIRECTORY" ]]; then
  printf '%s\n' 'OMP canary source must be a real directory.' >&2
  exit 1
fi
if find "$OMP_SOURCE_DIRECTORY" -type l -print -quit | grep -q .; then
  printf '%s\n' 'OMP canary source must not contain symbolic links.' >&2
  exit 1
fi
if [[ ! "$OMP_WORKSPACE_SOURCE_ID" =~ ^[a-z0-9][a-z0-9._-]{0,119}$ ]]; then
  printf '%s\n' 'OMP workspace source ID is invalid.' >&2
  exit 1
fi

rootless_docker() {
  DOCKER_HOST="$OMP_ROOTLESS_DOCKER_HOST" docker "$@"
}

rootless_info="$(rootless_docker info --format '{{json .}}')"
ROOTLESS_INFO="$rootless_info" python3 - <<'PYTHON'
import json
import os

info = json.loads(os.environ["ROOTLESS_INFO"])
security = info.get("SecurityOptions", [])
if not any("rootless" in value for value in security if isinstance(value, str)):
    raise SystemExit("OMP Docker engine is not rootless.")
if str(info.get("CgroupVersion")) != "2":
    raise SystemExit("OMP rootless engine must use cgroup v2.")
for capability in ("MemoryLimit", "PidsLimit", "CpuCfsPeriod", "CpuCfsQuota"):
    if info.get(capability) is not True:
        raise SystemExit(f"OMP rootless engine lacks {capability} enforcement.")
PYTHON

load_rootless_image() {
  local source_image="$1"
  local expected_id
  local current_id

  expected_id="$(docker image inspect "$source_image" --format '{{.Id}}')"
  current_id="$(rootless_docker image inspect "$source_image" --format '{{.Id}}' 2>/dev/null || true)"
  if [[ "$current_id" != "$expected_id" ]]; then
    if [[ "$source_image" == "$OMP_RUNTIME_IMAGE" ]]; then
      docker save "$OMP_RUNTIME_IMAGE" | DOCKER_HOST="$OMP_ROOTLESS_DOCKER_HOST" docker load >/dev/null
    else
      docker save "$MODEL_TUNNEL_IMAGE" | DOCKER_HOST="$OMP_ROOTLESS_DOCKER_HOST" docker load >/dev/null
    fi
  fi
  [[ "$(rootless_docker image inspect "$source_image" --format '{{.Id}}')" == "$expected_id" ]]
  printf '%s' "$expected_id"
}

omp_runtime_image_digest="$(load_rootless_image "$OMP_RUNTIME_IMAGE")"
model_tunnel_image_digest="$(load_rootless_image "$MODEL_TUNNEL_IMAGE")"
if [[ ! "$omp_runtime_image_digest" =~ ^sha256:[a-f0-9]{64}$ \
  || ! "$model_tunnel_image_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'OMP rootless image IDs are not immutable SHA-256 digests.' >&2
  exit 1
fi

if ! rootless_docker network inspect "$OMP_INTERNAL_NETWORK" >/dev/null 2>&1; then
  rootless_docker network create \
    --driver bridge \
    --internal \
    --subnet "$OMP_INTERNAL_SUBNET" \
    --opt com.docker.network.driver.mtu=1400 \
    "$OMP_INTERNAL_NETWORK" >/dev/null
fi
network_json="$(rootless_docker network inspect "$OMP_INTERNAL_NETWORK" --format '{{json .}}')"
NETWORK_JSON="$network_json" EXPECTED_SUBNET="$OMP_INTERNAL_SUBNET" python3 - <<'PYTHON'
import json
import os

network = json.loads(os.environ["NETWORK_JSON"])
subnets = [item.get("Subnet") for item in network.get("IPAM", {}).get("Config", [])]
if network.get("Internal") is not True or os.environ["EXPECTED_SUBNET"] not in subnets:
    raise SystemExit("OMP rootless internal network does not match its pinned policy.")
PYTHON

if [[ -n "$(rootless_docker ps -q --filter label=com.council.omp.session=true)" ]]; then
  printf '%s\n' 'Active OMP Sessions must be paused or completed before replacing the model gateway.' >&2
  exit 1
fi
rootless_docker rm -f "$OMP_MODEL_GATEWAY_CONTAINER" >/dev/null 2>&1 || true
rootless_docker run -d \
  --name "$OMP_MODEL_GATEWAY_CONTAINER" \
  --label com.council.omp.gateway=true \
  --restart unless-stopped \
  --network bridge \
  --user 0:0 \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --pids-limit 64 \
  --memory 192m \
  --memory-swap 192m \
  --cpus 0.5 \
  --tmpfs /tmp:rw,noexec,nosuid,size=8m,mode=1777 \
  --mount "type=bind,src=${MODEL_TUNNEL_KEY_FILE},dst=/run/secrets/gb10_model_tunnel_key,readonly" \
  --mount "type=bind,src=${KNOWN_HOSTS_FILE},dst=/run/secrets/gb10_known_hosts,readonly" \
  --mount "type=bind,src=${LITELLM_KEY_FILE},dst=/run/secrets/gb10_litellm_agent_key,readonly" \
  --env SSH_HOST=203.0.113.10 \
  --env SSH_PORT=22 \
  --env SSH_USER=council \
  --env TARGET_HOST=127.0.0.1 \
  --env TARGET_PORT=4001 \
  --env LOCAL_HOST=127.0.0.1 \
  --env LOCAL_PORT=4002 \
  --env GATEWAY_HOST=0.0.0.0 \
  --env GATEWAY_PORT=4001 \
  --env HEALTH_HOST=127.0.0.1 \
  --env HEALTH_PORT=4101 \
  --env UPSTREAM_API_KEY_FILE=/run/secrets/gb10_litellm_agent_key \
  --health-cmd "node -e \"fetch('http://127.0.0.1:4101/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\"" \
  --health-interval 10s \
  --health-timeout 5s \
  --health-retries 12 \
  --health-start-period 10s \
  "$model_tunnel_image_digest" >/dev/null
rootless_docker network connect "$OMP_INTERNAL_NETWORK" "$OMP_MODEL_GATEWAY_CONTAINER"

gateway_ready=false
for _ in $(seq 1 24); do
  if [[ "$(rootless_docker inspect "$OMP_MODEL_GATEWAY_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')" == healthy ]]; then
    gateway_ready=true
    break
  fi
  sleep 5
done
if [[ "$gateway_ready" != true ]]; then
  rootless_docker logs --tail 30 "$OMP_MODEL_GATEWAY_CONTAINER" >&2 || true
  printf '%s\n' 'OMP credential-injecting model gateway did not become healthy.' >&2
  exit 1
fi

source_parent="${OMP_SOURCE_ROOT}/${OMP_WORKSPACE_SOURCE_ID}"
install -d -m 700 "$OMP_SOURCE_ROOT" "$source_parent"
archive_tmp="$(mktemp "${source_parent}/.source.XXXXXX.tar")"
cleanup_archive() {
  rm -f -- "$archive_tmp"
}
trap cleanup_archive EXIT
tar \
  --sort=name \
  --mtime='UTC 1970-01-01' \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --format=posix \
  --pax-option=delete=atime,delete=ctime \
  -cf "$archive_tmp" \
  -C "$OMP_SOURCE_DIRECTORY" .
archive_hex="$(sha256sum "$archive_tmp" | awk '{print $1}')"
archive_path="${source_parent}/${archive_hex}.tar"
if [[ ! -e "$archive_path" ]]; then
  install -m 600 "$archive_tmp" "$archive_path"
fi
[[ "$(sha256sum "$archive_path" | awk '{print $1}')" == "$archive_hex" ]]

output_tmp="${OUTPUT_ENV_FILE}.tmp"
umask 077
printf 'OMP_RUNTIME_IMAGE_DIGEST=%s\nOMP_WORKSPACE_SOURCE_ID=%s\nOMP_WORKSPACE_ARCHIVE_DIGEST=sha256:%s\nOMP_MODEL_GATEWAY_IMAGE_DIGEST=%s\n' \
  "$omp_runtime_image_digest" \
  "$OMP_WORKSPACE_SOURCE_ID" \
  "$archive_hex" \
  "$model_tunnel_image_digest" \
  >"$output_tmp"
chmod 600 "$output_tmp"
mv "$output_tmp" "$OUTPUT_ENV_FILE"
trap - EXIT
cleanup_archive

printf 'OMP rootless runtime prepared image=%s source=sha256:%s gateway=%s\n' \
  "$omp_runtime_image_digest" "$archive_hex" "$OMP_MODEL_GATEWAY_CONTAINER"
