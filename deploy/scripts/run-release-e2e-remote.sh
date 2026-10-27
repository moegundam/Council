#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="${ROOT}/deploy/scripts"
source "${SCRIPT_DIR}/remote-common.sh"

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e"
GIT_COMMIT="$(git -C "$ROOT" rev-parse --verify HEAD)"
RUN_ID="${GIT_COMMIT:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE_OUTPUT="${1:-/tmp/council-release-e2e-${RUN_ID}.json}"
SOURCE_ARCHIVE="$(mktemp -t council-release-e2e.XXXXXX.tar.gz)"
REMOTE_RUN_ROOT="${COUNCIL_E2E_ROOT:-${COUNCIL_ROOT:-/opt/council}/releases/agent-meeting-platform/e2e}/${RUN_ID}"

cleanup() {
  unlink "$SOURCE_ARCHIVE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [[ ! "$GIT_COMMIT" =~ ^[a-f0-9]{40}$ || ! "$RUN_ID" =~ ^[a-f0-9]{12}-[0-9]{8}T[0-9]{6}Z$ ]]; then
  printf '%s\n' 'Remote E2E requires a canonical committed Git revision.' >&2
  exit 1
fi
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]]; then
  printf '%s\n' 'Remote release E2E requires a clean Git worktree.' >&2
  exit 1
fi
if [[ -e "$EVIDENCE_OUTPUT" ]]; then
  printf 'Evidence output already exists: %s\n' "$EVIDENCE_OUTPUT" >&2
  exit 1
fi

git -C "$ROOT" archive --format=tar.gz --output="$SOURCE_ARCHIVE" "$GIT_COMMIT"
remote_ssh "install -d -m 700 '${REMOTE_RUN_ROOT}'"
remote_rsync "$SOURCE_ARCHIVE" "${REMOTE_RUN_ROOT}/source.tar.gz"

set +e
remote_output="$(remote_ssh "RUN_ID='${RUN_ID}' GIT_COMMIT='${GIT_COMMIT}' PLAYWRIGHT_IMAGE='${PLAYWRIGHT_IMAGE}' bash -s" <<'REMOTE' 2>&1
set -euo pipefail

if [[ ! "$RUN_ID" =~ ^[a-f0-9]{12}-[0-9]{8}T[0-9]{6}Z$ \
  || ! "$GIT_COMMIT" =~ ^[a-f0-9]{40}$ \
  || ! "$PLAYWRIGHT_IMAGE" =~ ^mcr\.microsoft\.com/playwright:v1\.62\.1-noble@sha256:[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'Remote E2E inputs are invalid.' >&2
  exit 1
fi

ROOT="${COUNCIL_E2E_ROOT:-${COUNCIL_ROOT:-/opt/council}/releases/agent-meeting-platform/e2e}"
RUN_ROOT="${ROOT}/${RUN_ID}"
SOURCE_ROOT="${RUN_ROOT}/source"
ARCHIVE="${RUN_ROOT}/source.tar.gz"
LOG="${RUN_ROOT}/playwright.log"
CONTAINER_NAME="council-release-e2e-${RUN_ID}"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  if [[ "$RUN_ROOT" == "${ROOT}/"* && -d "$RUN_ROOT" ]]; then
    find "$RUN_ROOT" -depth -delete
  fi
}
trap cleanup EXIT INT TERM

mkdir -m 700 "$SOURCE_ROOT"
python3 - "$ARCHIVE" "$SOURCE_ROOT" <<'PYTHON'
from pathlib import Path, PurePosixPath
import os
import sys
import tarfile

archive_path = Path(sys.argv[1])
destination = Path(sys.argv[2]).resolve()
total = 0
with tarfile.open(archive_path, "r:gz") as archive:
    members = archive.getmembers()
    if not members or len(members) > 100_000:
        raise SystemExit("Remote E2E source archive member count is invalid.")
    for member in members:
        path = PurePosixPath(member.name)
        if not member.name or path.is_absolute() or ".." in path.parts or not (member.isdir() or member.isfile()):
            raise SystemExit("Remote E2E source archive contains an unsafe entry.")
        target = destination.joinpath(*path.parts).resolve()
        if target != destination and destination not in target.parents:
            raise SystemExit("Remote E2E source archive escaped its root.")
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if member.size < 0 or member.size > 512 * 1024 * 1024:
            raise SystemExit("Remote E2E source archive member is oversized.")
        total += member.size
        if total > 2 * 1024 * 1024 * 1024:
            raise SystemExit("Remote E2E source archive expands beyond its limit.")
        target.parent.mkdir(parents=True, exist_ok=True)
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit("Remote E2E source archive member cannot be read.")
        with target.open("wb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        os.chmod(target, member.mode & 0o755)
PYTHON

if ! docker image inspect "$PLAYWRIGHT_IMAGE" >/dev/null 2>&1; then
  docker pull "$PLAYWRIGHT_IMAGE"
fi

docker run --rm --init \
  --name "$CONTAINER_NAME" \
  --label com.council.release-e2e=true \
  --network bridge \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777,size=2g \
  --shm-size 2g \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --pids-limit 1024 \
  --memory 4g \
  --cpus 4 \
  --mount "type=bind,src=${SOURCE_ROOT},dst=/workspace" \
  --workdir /workspace \
  --env E2E_DEPLOYMENT_CLASS=disposable \
  --env E2E_DISPOSABLE_MARKER=council-agent-meeting-platform-disposable-e2e-v1 \
  --env E2E_WEB_URL=http://127.0.0.1:33000 \
  --env E2E_APP_UPSTREAM_URL=http://127.0.0.1:33001 \
  --env E2E_API_URL=http://127.0.0.1:34000 \
  --env E2E_DIRECT_NODE_MODULES=true \
  --env E2E_REUSE_EXISTING_SERVERS=false \
  --env PLAYWRIGHT_OUTPUT_DIR=/tmp/council-playwright-results \
  --env HOME=/workspace/.home \
  --env COREPACK_HOME=/workspace/.corepack \
  --env NEXT_TELEMETRY_DISABLED=1 \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'set -euo pipefail; mkdir -p "$COREPACK_HOME/bin"; corepack enable --install-directory "$COREPACK_HOME/bin" pnpm; export PATH="$COREPACK_HOME/bin:$PATH"; pnpm install --frozen-lockfile; pnpm run test:e2e' \
  2>&1 | tee "$LOG"

python3 - "$LOG" "$RUN_ROOT/evidence.json" "$GIT_COMMIT" "$PLAYWRIGHT_IMAGE" <<'PYTHON'
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import platform
import re
import socket
import sys

log = Path(sys.argv[1]).read_text(errors="replace")
matches = re.findall(r"(?:^|\s)(\d+) passed(?:\s|$)", log, re.MULTILINE)
if not matches:
    raise SystemExit("Remote Playwright output did not contain a passing test count.")
skipped = re.findall(r"(?:^|\s)(\d+) skipped(?:\s|$)", log, re.MULTILINE)
created = datetime.now(timezone.utc).replace(microsecond=0)
architecture = platform.machine()
if architecture == "arm64":
    architecture = "aarch64"
evidence = {
    "schemaVersion": 1,
    "source": "external_macmini_docker",
    "gitCommit": sys.argv[3],
    "createdAt": created.isoformat().replace("+00:00", "Z"),
    "expiresAt": (created + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
    "runnerHost": socket.gethostname(),
    "architecture": architecture,
    "playwrightImage": sys.argv[4],
    "pnpmVersion": "11.7.0",
    "testCommand": "pnpm run test:e2e",
    "result": "passed",
    "testCounts": {"passed": int(matches[-1]), "failed": 0, "skipped": int(skipped[-1]) if skipped else 0},
}
Path(sys.argv[2]).write_text(json.dumps(evidence, indent=2) + "\n")
PYTHON

printf 'COUNCIL_E2E_EVIDENCE_BASE64='
base64 -w0 "${RUN_ROOT}/evidence.json"
printf '\n'
REMOTE
)"
remote_status=$?
set -e
printf '%s\n' "$remote_output"
if (( remote_status != 0 )); then
  printf 'Remote release E2E failed with status %s.\n' "$remote_status" >&2
  exit "$remote_status"
fi

evidence_base64="$(printf '%s\n' "$remote_output" | sed -n 's/^COUNCIL_E2E_EVIDENCE_BASE64=//p')"
if [[ -z "$evidence_base64" || "$(printf '%s\n' "$remote_output" | grep -c '^COUNCIL_E2E_EVIDENCE_BASE64=')" -ne 1 ]]; then
  printf '%s\n' 'Remote release E2E returned no unique evidence payload.' >&2
  exit 1
fi
EVIDENCE_BASE64="$evidence_base64" python3 - "$EVIDENCE_OUTPUT" <<'PYTHON'
import base64
from pathlib import Path
import os
import sys

path = Path(sys.argv[1]).expanduser().resolve()
path.parent.mkdir(parents=True, exist_ok=True)
path.write_bytes(base64.b64decode(os.environ["EVIDENCE_BASE64"], validate=True))
path.chmod(0o600)
PYTHON

digest="$(python3 "${SCRIPT_DIR}/release-e2e-evidence-validator.py" "$EVIDENCE_OUTPUT" "$GIT_COMMIT")"
printf 'Remote release E2E evidence: %s\nSHA-256: %s\n' "$EVIDENCE_OUTPUT" "$digest"
