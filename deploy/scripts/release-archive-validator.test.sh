#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${SCRIPT_DIR}/release-archive-validator.py"
DEPLOY="${SCRIPT_DIR}/deploy-remote.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

python3 - "$TEMP_ROOT" <<'PYTHON'
from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
import tarfile

root = Path(sys.argv[1])
version = "20260818T120000Z"
commit = "0123456789abcdef0123456789abcdef01234567"
evidence = json.dumps({
    "gitCommit": commit,
    "source": "external_macmini_docker",
    "createdAt": "2026-08-18T11:00:00Z",
    "result": "passed",
    "testCounts": {"passed": 12, "failed": 0, "skipped": 0},
}, sort_keys=True).encode()
def release_manifest(release_version):
    return {
        "version": release_version,
        "gitCommit": commit,
        "buildkitImage": "moby/buildkit:buildx-stable-1@sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec",
        "ompRuntime": {
            "runtimeContract": "omp-rpc-v2@18.1.2",
            "version": "18.1.2",
            "asset": "omp-linux-x64",
            "assetSha256": "c6a306347a57c872bf38587e81132db50490228867e3e179a363a4cf874da1a0",
            "nativeBaselineSha256": "cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4",
            "dockerCliImage": "docker:29.7.2-cli@sha256:eb952fbf036947347bff9f303878c86ec3df00af0341f4cca59b1d1924d6668d",
            "defaultEnabled": False,
        },
        "agenticSeek": {"integration": "methodology_only", "runtimeDeployed": False},
        "e2eEvidence": {
            "path": "release-evidence/disposable-e2e.json",
            "sha256": hashlib.sha256(evidence).hexdigest(),
            "source": "external_macmini_docker",
            "createdAt": "2026-08-18T11:00:00Z",
        },
    }

manifest = json.dumps(release_manifest(version)).encode()

def archive(name, members):
    members = [*members, ("./release-evidence/disposable-e2e.json", "file", evidence)]
    with tarfile.open(root / name, "w:gz") as output:
        for member in members:
            member_name, kind, payload, *mode = member
            info = tarfile.TarInfo(member_name)
            if kind == "file":
                info.size = len(payload)
                info.mode = mode[0] if mode else 0o644
                output.addfile(info, BytesIO(payload))
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = payload.decode()
                output.addfile(info)

archive(
    f"agent-meeting-platform-{version}.tar.gz",
    [("./release-manifest.json", "file", manifest),
     ("./deploy/compose.yaml", "file", b"name: agent-meeting-platform\n"),
     ("./deploy/Caddyfile", "file", b":8080 {}\n")],
)
archive(
    "agent-meeting-platform-20260818T120001Z.tar.gz",
    [("./release-manifest.json", "file", manifest),
     ("./deploy/Caddyfile", "file", b":8080 {}\n")],
)
archive(
    "agent-meeting-platform-20260818T120002Z.tar.gz",
    [("./release-manifest.json", "file", json.dumps(release_manifest("20260818T120002Z")).encode()),
     ("./deploy/Caddyfile", "file", b":8080 {}\n"),
     ("../escape", "file", b"escape")],
)
archive(
    "agent-meeting-platform-20260818T120003Z.tar.gz",
    [("./release-manifest.json", "file", json.dumps(release_manifest("20260818T120003Z")).encode()),
     ("./deploy/Caddyfile", "file", b":8080 {}\n"),
     ("./unsafe-link", "symlink", b"/etc/passwd")],
)
archive(
    "agent-meeting-platform-20260818T120004Z.tar.gz",
    [("./release-manifest.json", "file", json.dumps(release_manifest("20260818T120004Z")).encode()),
     ("./deploy/Caddyfile", "file", b":8080 {}\n"),
     ("release-manifest.json", "file", json.dumps(release_manifest("20260818T120004Z")).encode())],
)
archive(
    "agent-meeting-platform-20260818T120005Z.tar.gz",
    [("./release-manifest.json", "file", json.dumps(release_manifest("20260818T120005Z")).encode()),
     ("./deploy/Caddyfile", "file", b":8080 {}\n", 0o600)],
)
for suffix, pin in [("6", None), ("7", "moby/buildkit:buildx-stable-1@sha256:" + "0" * 64)]:
    invalid_version = f"20260818T12000{suffix}Z"
    invalid_manifest = release_manifest(invalid_version)
    if pin is None:
        invalid_manifest.pop("buildkitImage")
    else:
        invalid_manifest["buildkitImage"] = pin
    archive(
        f"agent-meeting-platform-{invalid_version}.tar.gz",
        [("./release-manifest.json", "file", json.dumps(invalid_manifest).encode()),
         ("./deploy/compose.yaml", "file", b"name: agent-meeting-platform\n"),
         ("./deploy/Caddyfile", "file", b":8080 {}\n")],
    )
PYTHON

valid="${TEMP_ROOT}/agent-meeting-platform-20260818T120000Z.tar.gz"
[[ "$(python3 "$VALIDATOR" "$valid")" == "20260818T120000Z" ]]

for invalid in \
  agent-meeting-platform-20260818T120001Z.tar.gz \
  agent-meeting-platform-20260818T120002Z.tar.gz \
  agent-meeting-platform-20260818T120003Z.tar.gz \
  agent-meeting-platform-20260818T120004Z.tar.gz \
  agent-meeting-platform-20260818T120005Z.tar.gz \
  agent-meeting-platform-20260818T120006Z.tar.gz \
  agent-meeting-platform-20260818T120007Z.tar.gz; do
  if python3 "$VALIDATOR" "${TEMP_ROOT}/${invalid}" >/dev/null 2>&1; then
    printf 'Unsafe or inconsistent release archive was accepted: %s\n' "$invalid" >&2
    exit 1
  fi
done

cp "$valid" "${TEMP_ROOT}/renamed.tar.gz"
if python3 "$VALIDATOR" "${TEMP_ROOT}/renamed.tar.gz" >/dev/null 2>&1; then
  printf '%s\n' 'Release archive validator accepted a noncanonical basename.' >&2
  exit 1
fi

validator_line="$(awk '$0 == "VERSION=\"$(python3 \"$VALIDATOR\" \"$BUNDLE\")\"" { print NR; exit }' "$DEPLOY")"
extract_line="$(awk 'index($0, "tar -xzf \"$BUNDLE_NAME\"") { print NR; exit }' "$DEPLOY")"
if [[ -z "$validator_line" || -z "$extract_line" || "$validator_line" -ge "$extract_line" ]]; then
  printf '%s\n' 'Deployment must validate the release archive before extraction.' >&2
  exit 1
fi
grep -Fq 'EXPECTED_BUNDLE_NAME="agent-meeting-platform-${VERSION}.tar.gz"' "$DEPLOY"
grep -Fq 'validate_checksum_file "$BUNDLE" "${BUNDLE}.sha256"' "$DEPLOY"
grep -Fq 'validate_checksum_file "$BUNDLE_NAME" "$CHECKSUM_NAME"' "$DEPLOY"

printf '%s\n' 'release archive validator tests passed'
