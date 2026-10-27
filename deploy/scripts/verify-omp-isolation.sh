#!/usr/bin/env bash

set -euo pipefail

OMP_ROOTLESS_DOCKER_HOST="${OMP_ROOTLESS_DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
OMP_INTERNAL_NETWORK="${OMP_INTERNAL_NETWORK:-council-omp-internal}"
OMP_MODEL_GATEWAY_CONTAINER="${OMP_MODEL_GATEWAY_CONTAINER:-council-omp-model-gateway}"
OMP_RUNTIME_IMAGE_DIGEST="${OMP_RUNTIME_IMAGE_DIGEST:?OMP_RUNTIME_IMAGE_DIGEST is required}"
OMP_BROKER_IMAGE="${OMP_BROKER_IMAGE:?OMP_BROKER_IMAGE is required}"
ATTESTATION_FILE="${ATTESTATION_FILE:?ATTESTATION_FILE is required}"
EVIDENCE_FILE="${EVIDENCE_FILE:?EVIDENCE_FILE is required}"
probe_suffix="$$"
resource_probe="council-omp-resource-probe-${probe_suffix}"
left_volume="council-omp-left-${probe_suffix}"
right_volume="council-omp-right-${probe_suffix}"

rootless_docker() {
  DOCKER_HOST="$OMP_ROOTLESS_DOCKER_HOST" docker "$@"
}

cleanup() {
  rootless_docker rm -f "$resource_probe" >/dev/null 2>&1 || true
  rootless_docker volume rm -f "$left_volume" "$right_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

broker_image_digest="$(docker image inspect "$OMP_BROKER_IMAGE" --format '{{.Id}}')"
if [[ ! "$broker_image_digest" =~ ^sha256:[a-f0-9]{64}$ \
  || ! "$OMP_RUNTIME_IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'OMP isolation verification requires immutable image IDs.' >&2
  exit 1
fi
[[ "$(rootless_docker image inspect "$OMP_RUNTIME_IMAGE_DIGEST" --format '{{.Id}}')" == "$OMP_RUNTIME_IMAGE_DIGEST" ]]

info_json="$(rootless_docker info --format '{{json .}}')"
INFO_JSON="$info_json" python3 - <<'PYTHON'
import json
import os

info = json.loads(os.environ["INFO_JSON"])
security = info.get("SecurityOptions", [])
if not any("rootless" in value for value in security if isinstance(value, str)):
    raise SystemExit("rootless control failed")
if str(info.get("CgroupVersion")) != "2":
    raise SystemExit("cgroup v2 control failed")
for capability in ("MemoryLimit", "PidsLimit", "CpuCfsPeriod", "CpuCfsQuota"):
    if info.get(capability) is not True:
        raise SystemExit(f"resource control failed: {capability}")
PYTHON

network_json="$(rootless_docker network inspect "$OMP_INTERNAL_NETWORK" --format '{{json .}}')"
gateway_json="$(rootless_docker inspect "$OMP_MODEL_GATEWAY_CONTAINER" --format '{{json .}}')"
NETWORK_JSON="$network_json" GATEWAY_JSON="$gateway_json" OMP_INTERNAL_NETWORK="$OMP_INTERNAL_NETWORK" python3 - <<'PYTHON'
import json
import os

network = json.loads(os.environ["NETWORK_JSON"])
gateway = json.loads(os.environ["GATEWAY_JSON"])
if network.get("Internal") is not True:
    raise SystemExit("deny-all network is not internal")
state = gateway.get("State", {})
networks = gateway.get("NetworkSettings", {}).get("Networks", {})
if state.get("Running") is not True or state.get("Health", {}).get("Status") != "healthy":
    raise SystemExit("model gateway is not healthy")
if os.environ["OMP_INTERNAL_NETWORK"] not in networks or "bridge" not in networks:
    raise SystemExit("model gateway does not have the exact dual-network topology")
PYTHON

probe_json="$(rootless_docker run --rm \
  --network "$OMP_INTERNAL_NETWORK" \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --pids-limit 32 \
  --memory 256m \
  --memory-swap 256m \
  --cpus 0.25 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --user 10001:10001 \
  "$OMP_RUNTIME_IMAGE_DIGEST" \
  node -e '
    const fs = require("node:fs");
    const net = require("node:net");
    const probe = (host, port) => new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1200);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    (async () => {
      let rootWritable = true;
      try { fs.writeFileSync("/should-not-write", "x"); } catch { rootWritable = false; }
      const modelResponse = await fetch("http://council-omp-model-gateway:4001/v1/models", {
        signal: AbortSignal.timeout(5000)
      }).catch(() => null);
      const result = {
        rootWritable,
        rootfulSocket: fs.existsSync("/var/run/docker.sock"),
        modelGateway: modelResponse?.ok === true,
        lan: await probe("203.0.113.10", 22),
        internet: await probe("1.1.1.1", 53),
        metadata: await probe("169.254.169.254", 80)
      };
      process.stdout.write(JSON.stringify(result));
    })().catch(() => process.exit(1));
  ')"
PROBE_JSON="$probe_json" python3 - <<'PYTHON'
import json
import os

probe = json.loads(os.environ["PROBE_JSON"])
expected = {
    "rootWritable": False,
    "rootfulSocket": False,
    "modelGateway": True,
    "lan": False,
    "internet": False,
    "metadata": False,
}
if probe != expected:
    raise SystemExit(f"OMP network or filesystem isolation probe failed: {probe}")
PYTHON

rootless_docker run -d \
  --name "$resource_probe" \
  --network "$OMP_INTERNAL_NETWORK" \
  --read-only \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --pids-limit 32 \
  --memory 256m \
  --memory-swap 256m \
  --cpus 0.25 \
  --user 10001:10001 \
  "$OMP_RUNTIME_IMAGE_DIGEST" sleep 60 >/dev/null
resource_json="$(rootless_docker inspect "$resource_probe" --format '{{json .HostConfig}}')"
RESOURCE_JSON="$resource_json" OMP_INTERNAL_NETWORK="$OMP_INTERNAL_NETWORK" python3 - <<'PYTHON'
import json
import os

host = json.loads(os.environ["RESOURCE_JSON"])
if host.get("ReadonlyRootfs") is not True:
    raise SystemExit("read-only root filesystem control failed")
if host.get("Memory") != 268435456 or host.get("MemorySwap") != 268435456:
    raise SystemExit("memory control failed")
if host.get("PidsLimit") != 32 or host.get("NanoCpus") != 250000000:
    raise SystemExit("PID or CPU control failed")
if host.get("NetworkMode") != os.environ["OMP_INTERNAL_NETWORK"]:
    raise SystemExit("host network absence control failed")
if "no-new-privileges" not in (host.get("SecurityOpt") or []):
    raise SystemExit("no-new-privileges control failed")
if "ALL" not in (host.get("CapDrop") or []):
    raise SystemExit("capability drop control failed")
PYTHON
rootless_docker rm -f "$resource_probe" >/dev/null

rootless_docker volume create "$left_volume" >/dev/null
rootless_docker volume create "$right_volume" >/dev/null
rootless_docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
  --mount "type=volume,src=${left_volume},dst=/workspace" \
  "$OMP_RUNTIME_IMAGE_DIGEST" sh -c 'printf isolated-left > /workspace/marker'
sibling_result="$(rootless_docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL \
  --mount "type=volume,src=${right_volume},dst=/workspace" \
  "$OMP_RUNTIME_IMAGE_DIGEST" sh -c 'if test -e /workspace/marker; then printf leaked; else printf isolated; fi')"
[[ "$sibling_result" == isolated ]]

evidence_dir="$(dirname "$EVIDENCE_FILE")"
attestation_dir="$(dirname "$ATTESTATION_FILE")"
install -d -m 700 "$evidence_dir" "$attestation_dir"
evidence_tmp="${EVIDENCE_FILE}.tmp"
attestation_tmp="${ATTESTATION_FILE}.tmp"
verified_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
umask 077
INFO_JSON="$info_json" NETWORK_JSON="$network_json" GATEWAY_JSON="$gateway_json" \
  PROBE_JSON="$probe_json" RESOURCE_JSON="$resource_json" VERIFIED_AT="$verified_at" \
  OMP_RUNTIME_IMAGE_DIGEST="$OMP_RUNTIME_IMAGE_DIGEST" BROKER_IMAGE_DIGEST="$broker_image_digest" \
  python3 - <<'PYTHON' >"$evidence_tmp"
import json
import os

info = json.loads(os.environ["INFO_JSON"])
network = json.loads(os.environ["NETWORK_JSON"])
gateway = json.loads(os.environ["GATEWAY_JSON"])
resource = json.loads(os.environ["RESOURCE_JSON"])
probe = json.loads(os.environ["PROBE_JSON"])
evidence = {
    "schemaVersion": 1,
    "verifiedAt": os.environ["VERIFIED_AT"],
    "runtimeImageDigest": os.environ["OMP_RUNTIME_IMAGE_DIGEST"],
    "brokerImageDigest": os.environ["BROKER_IMAGE_DIGEST"],
    "engine": {
        "rootless": any("rootless" in item for item in info.get("SecurityOptions", []) if isinstance(item, str)),
        "cgroupVersion": str(info.get("CgroupVersion")),
    },
    "network": {
        "internal": network.get("Internal") is True,
        "gatewayHealthy": gateway.get("State", {}).get("Health", {}).get("Status") == "healthy",
        "probe": probe,
    },
    "resources": {
        "readOnlyRootfs": resource.get("ReadonlyRootfs"),
        "memory": resource.get("Memory"),
        "memorySwap": resource.get("MemorySwap"),
        "pidsLimit": resource.get("PidsLimit"),
        "nanoCpus": resource.get("NanoCpus"),
        "networkMode": resource.get("NetworkMode"),
    },
    "siblingWorkspaces": "isolated",
}
print(json.dumps(evidence, sort_keys=True, separators=(",", ":")))
PYTHON
chmod 600 "$evidence_tmp"
mv "$evidence_tmp" "$EVIDENCE_FILE"
evidence_digest="sha256:$(sha256sum "$EVIDENCE_FILE" | awk '{print $1}')"

VERIFIED_AT="$verified_at" BROKER_IMAGE_DIGEST="$broker_image_digest" EVIDENCE_DIGEST="$evidence_digest" \
  python3 - <<'PYTHON' >"$attestation_tmp"
from datetime import datetime, timedelta, timezone
import json
import os

verified = datetime.fromisoformat(os.environ["VERIFIED_AT"].replace("Z", "+00:00"))
expires = verified + timedelta(hours=23)
attestation = {
    "schemaVersion": 1,
    "brokerImageDigest": os.environ["BROKER_IMAGE_DIGEST"],
    "evidenceDigest": os.environ["EVIDENCE_DIGEST"],
    "verifiedAt": verified.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    "expiresAt": expires.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
    "controls": {
        "rootless": True,
        "noNewPrivileges": True,
        "readOnlyRootfs": True,
        "denyAllEgress": True,
        "hostSocketAbsent": True,
        "hostNetworkAbsent": True,
        "resourceLimitsEnforced": True,
    },
}
print(json.dumps(attestation, sort_keys=True, separators=(",", ":")))
PYTHON
chmod 600 "$attestation_tmp"
mv "$attestation_tmp" "$ATTESTATION_FILE"

printf 'OMP isolation verified broker=%s runtime=%s evidence=%s\n' \
  "$broker_image_digest" "$OMP_RUNTIME_IMAGE_DIGEST" "$evidence_digest"
