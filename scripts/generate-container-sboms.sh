#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SYFT_IMAGE="anchore/syft:v1.55.0@sha256:4cc92b64ca74ffca4c94d4c8fcc01f217731375300be14d0b6eeb2e82eaa110a"
DOCKER_ENDPOINT="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
case "$DOCKER_ENDPOINT" in
  unix://*) DOCKER_SOCKET="${DOCKER_ENDPOINT#unix://}" ;;
  *) echo "Container SBOM generation requires a local Unix Docker socket." >&2; exit 2 ;;
esac
test -S "$DOCKER_SOCKET" || { echo "Docker socket is unavailable." >&2; exit 2; }

images=(
  "agent-meeting-platform-api:dev"
  "agent-meeting-platform-worker:dev"
  "agent-meeting-platform-web:dev"
  "agent-meeting-platform-mcp-readonly:dev"
  "agent-meeting-platform-task-adapter-reference:dev"
  "agent-meeting-platform-model-tunnel:dev"
  "agent-meeting-platform-sandbox-broker:dev"
  "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
  "redis:8.2.1-alpine@sha256:987c376c727652f99625c7d205a1cba3cb2c53b92b0b62aade2bd48ee1593232"
  "caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
)
names=(api worker web mcp-readonly task-adapter-reference model-tunnel sandbox-broker postgres redis caddy)

mkdir -p sbom/containers
for index in "${!images[@]}"; do
  image="${images[$index]}"
  name="${names[$index]}"
  docker image inspect "$image" >/dev/null
  temporary="sbom/containers/${name}.spdx.json.tmp"
  docker run --rm \
    -v "$DOCKER_SOCKET:/var/run/docker.sock" \
    "$SYFT_IMAGE" "$image" -o spdx-json > "$temporary"
  gzip -n -c "$temporary" > "sbom/containers/${name}.spdx.json.gz"
  python3 - "$temporary" "$image" <<'PY'
import json, sys
document = json.load(open(sys.argv[1], encoding="utf-8"))
if document.get("spdxVersion") != "SPDX-2.3":
    raise SystemExit("Unexpected SPDX version")
print(f"{sys.argv[2]}: {len(document.get('packages', []))} packages")
PY
  python3 - "$temporary" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink()
PY
done

(cd sbom/containers && sha256sum -- *.spdx.json.gz > SHA256SUMS)
echo "Container SBOMs written to sbom/containers/."
