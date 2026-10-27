#!/usr/bin/env python3

from __future__ import annotations

import json
import hashlib
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile


ARCHIVE_NAME = re.compile(r"agent-meeting-platform-(\d{8}T\d{6}Z)\.tar\.gz")
MAX_MEMBER_COUNT = 100_000
MAX_MEMBER_SIZE = 512 * 1024 * 1024
MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024
MAX_MANIFEST_SIZE = 1024 * 1024
REQUIRED_FILE_MODES = {
    "deploy/Caddyfile": 0o644,
    "release-evidence/disposable-e2e.json": 0o644,
    "release-manifest.json": 0o644,
}
EXPECTED_OMP_RUNTIME = {
    "runtimeContract": "omp-rpc-v2@18.1.2",
    "version": "18.1.2",
    "asset": "omp-linux-x64",
    "assetSha256": "c6a306347a57c872bf38587e81132db50490228867e3e179a363a4cf874da1a0",
    "nativeBaselineSha256": "cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4",
    "dockerCliImage": "docker:29.7.2-cli@sha256:eb952fbf036947347bff9f303878c86ec3df00af0341f4cca59b1d1924d6668d",
    "defaultEnabled": False,
}
EXPECTED_BUILDKIT_IMAGE = (
    "moby/buildkit:buildx-stable-1@"
    "sha256:2f5adac4ecd194d9f8c10b7b5d7bceb5186853db1b26e5abd3a657af0b7e26ec"
)
EXPECTED_AGENTICSEEK = {"integration": "methodology_only", "runtimeDeployed": False}


def fail(message: str) -> None:
    raise SystemExit(message)


def normalized_member_name(name: str) -> str:
    if not name or name.startswith("/") or "\\" in name:
        fail("Release archive contains an unsafe path.")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        fail("Release archive contains an unsafe path.")
    normalized = str(path)
    if normalized in {"", "."}:
        fail("Release archive contains an invalid root entry.")
    return normalized


def validate(archive_path: Path) -> str:
    match = ARCHIVE_NAME.fullmatch(archive_path.name)
    if not match:
        fail("Release archive basename must be agent-meeting-platform-VERSION.tar.gz.")
    filename_version = match.group(1)

    seen: set[str] = set()
    required_file_modes: dict[str, int] = {}
    manifest_member: tarfile.TarInfo | None = None
    evidence_member: tarfile.TarInfo | None = None
    evidence_bytes = b""
    total_size = 0
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if not members or len(members) > MAX_MEMBER_COUNT:
                fail("Release archive member count is invalid.")
            for member in members:
                name = normalized_member_name(member.name)
                if name in seen:
                    fail("Release archive contains duplicate normalized paths.")
                seen.add(name)
                if not (member.isdir() or member.isfile()):
                    fail("Release archive may contain only regular files and directories.")
                if member.mode & 0o7000:
                    fail("Release archive contains a special-permission entry.")
                if name in REQUIRED_FILE_MODES:
                    if not member.isfile():
                        fail(f"Release archive runtime file must be regular: {name}.")
                    required_file_modes[name] = member.mode & 0o777
                if member.isfile():
                    if member.size < 0 or member.size > MAX_MEMBER_SIZE:
                        fail("Release archive contains an oversized member.")
                    total_size += member.size
                    if total_size > MAX_TOTAL_SIZE:
                        fail("Release archive expands beyond the permitted size.")
                if name == "release-manifest.json":
                    if not member.isfile() or manifest_member is not None:
                        fail("Release archive must contain one regular release manifest.")
                    manifest_member = member
                if name == "release-evidence/disposable-e2e.json":
                    if not member.isfile() or evidence_member is not None or member.size > 64 * 1024:
                        fail("Release archive must contain one bounded E2E evidence file.")
                    evidence_member = member

            if manifest_member is None or manifest_member.size > MAX_MANIFEST_SIZE or evidence_member is None:
                fail("Release archive must contain one bounded release manifest.")
            for name, expected_mode in REQUIRED_FILE_MODES.items():
                actual_mode = required_file_modes.get(name)
                if actual_mode is None:
                    fail(f"Release archive is missing required runtime file: {name}.")
                if actual_mode != expected_mode:
                    fail(
                        f"Release archive runtime file {name} must have mode "
                        f"{expected_mode:04o}; got {actual_mode:04o}."
                    )
            manifest_file = archive.extractfile(manifest_member)
            if manifest_file is None:
                fail("Release manifest cannot be read.")
            manifest = json.load(manifest_file)
            evidence_file = archive.extractfile(evidence_member)
            if evidence_file is None:
                fail("Release E2E evidence cannot be read.")
            evidence_bytes = evidence_file.read()
    except (OSError, tarfile.TarError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"Release archive validation failed: {error}")

    if not isinstance(manifest, dict) or manifest.get("version") != filename_version:
        fail("Release manifest version does not match the archive basename.")
    if manifest.get("ompRuntime") != EXPECTED_OMP_RUNTIME:
        fail("Release manifest does not pin the approved OMP Runtime contract and assets.")
    if manifest.get("buildkitImage") != EXPECTED_BUILDKIT_IMAGE:
        fail("Release manifest does not pin the approved BuildKit driver image.")
    if manifest.get("agenticSeek") != EXPECTED_AGENTICSEEK:
        fail("Release manifest must keep agenticSeek methodology-only.")
    try:
        evidence = json.loads(evidence_bytes)
    except (UnicodeError, json.JSONDecodeError) as error:
        fail(f"Release E2E evidence is invalid: {error}")
    e2e_manifest = manifest.get("e2eEvidence")
    if not isinstance(e2e_manifest, dict) or set(e2e_manifest) != {"path", "sha256", "source", "createdAt"}:
        fail("Release manifest E2E evidence binding is invalid.")
    if e2e_manifest.get("path") != "release-evidence/disposable-e2e.json":
        fail("Release manifest E2E evidence path is invalid.")
    if e2e_manifest.get("sha256") != hashlib.sha256(evidence_bytes).hexdigest():
        fail("Release manifest E2E evidence digest does not match the archive.")
    if not isinstance(evidence, dict) or evidence.get("gitCommit") != manifest.get("gitCommit"):
        fail("Release E2E evidence does not match the manifest commit.")
    if evidence.get("source") != e2e_manifest.get("source") or evidence.get("createdAt") != e2e_manifest.get("createdAt"):
        fail("Release manifest E2E metadata does not match its evidence.")
    counts = evidence.get("testCounts")
    if evidence.get("result") != "passed" or not isinstance(counts, dict) or counts.get("failed") != 0:
        fail("Release E2E evidence does not record a passing run.")
    return filename_version


def main() -> None:
    if len(sys.argv) != 2:
        fail(f"Usage: {Path(sys.argv[0]).name} ARCHIVE")
    print(validate(Path(sys.argv[1])))


if __name__ == "__main__":
    main()
