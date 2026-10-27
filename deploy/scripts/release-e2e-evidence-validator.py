#!/usr/bin/env python3

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import sys


PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e"
COMMIT = re.compile(r"^[a-f0-9]{40}$")
HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MAX_SIZE = 64 * 1024
MAX_LIFETIME = timedelta(hours=24)


def fail(message: str) -> None:
    raise SystemExit(message)


def timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        fail(f"Release E2E evidence {label} must be a canonical UTC timestamp.")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        fail(f"Release E2E evidence {label} is invalid.")
    if parsed.tzinfo != timezone.utc or parsed.isoformat(timespec="seconds").replace("+00:00", "Z") != value:
        fail(f"Release E2E evidence {label} must use second-precision UTC.")
    return parsed


def validate(path: Path, expected_commit: str, now: datetime | None = None) -> str:
    if not COMMIT.fullmatch(expected_commit):
        fail("Expected release commit must be a full lowercase Git SHA-1.")
    try:
        if not path.is_file() or path.stat().st_size > MAX_SIZE:
            fail("Release E2E evidence must be one bounded regular file.")
        raw = path.read_bytes()
        evidence = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"Release E2E evidence cannot be read: {error}")
    if not isinstance(evidence, dict) or set(evidence) != {
        "schemaVersion", "source", "gitCommit", "createdAt", "expiresAt",
        "runnerHost", "architecture", "playwrightImage", "pnpmVersion",
        "testCommand", "result", "testCounts"
    }:
        fail("Release E2E evidence has an unsupported schema.")
    if evidence["schemaVersion"] != 1:
        fail("Release E2E evidence schema version is unsupported.")
    if evidence["source"] not in {"external_macmini_docker", "local_container"}:
        fail("Release E2E evidence source is unsupported.")
    if evidence["gitCommit"] != expected_commit:
        fail("Release E2E evidence does not match the release commit.")
    if not isinstance(evidence["runnerHost"], str) or not HOST.fullmatch(evidence["runnerHost"]):
        fail("Release E2E evidence runner host is invalid.")
    if evidence["architecture"] not in {"x86_64", "aarch64"}:
        fail("Release E2E evidence architecture is unsupported.")
    if evidence["playwrightImage"] != PLAYWRIGHT_IMAGE or evidence["pnpmVersion"] != "11.7.0":
        fail("Release E2E evidence toolchain is not pinned to the approved versions.")
    if evidence["testCommand"] != "pnpm run test:e2e" or evidence["result"] != "passed":
        fail("Release E2E evidence does not record the approved passing test command.")
    counts = evidence["testCounts"]
    if not isinstance(counts, dict) or set(counts) != {"passed", "failed", "skipped"}:
        fail("Release E2E evidence test counts are invalid.")
    if any(not isinstance(counts[key], int) or counts[key] < 0 for key in counts):
        fail("Release E2E evidence test counts must be non-negative integers.")
    if counts["passed"] < 1 or counts["failed"] != 0:
        fail("Release E2E evidence must record at least one pass and no failures.")
    created_at = timestamp(evidence["createdAt"], "createdAt")
    expires_at = timestamp(evidence["expiresAt"], "expiresAt")
    current = now or datetime.now(timezone.utc)
    if created_at > current + timedelta(minutes=5):
        fail("Release E2E evidence creation time is in the future.")
    if expires_at <= current:
        fail("Release E2E evidence has expired.")
    if expires_at <= created_at or expires_at - created_at > MAX_LIFETIME:
        fail("Release E2E evidence lifetime must be positive and at most 24 hours.")
    return hashlib.sha256(raw).hexdigest()


def main() -> None:
    if len(sys.argv) != 3:
        fail(f"Usage: {Path(sys.argv[0]).name} EVIDENCE_FILE EXPECTED_GIT_COMMIT")
    print(validate(Path(sys.argv[1]), sys.argv[2]))


if __name__ == "__main__":
    main()
