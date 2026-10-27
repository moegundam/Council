#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${SCRIPT_DIR}/release-e2e-evidence-validator.py"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
COMMIT=0123456789abcdef0123456789abcdef01234567

python3 - "$TEMP_ROOT/evidence.json" "$COMMIT" <<'PYTHON'
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys

now = datetime.now(timezone.utc).replace(microsecond=0)
Path(sys.argv[1]).write_text(json.dumps({
    "schemaVersion": 1,
    "source": "external_macmini_docker",
    "gitCommit": sys.argv[2],
    "createdAt": now.isoformat().replace("+00:00", "Z"),
    "expiresAt": (now + timedelta(hours=24)).isoformat().replace("+00:00", "Z"),
    "runnerHost": "council-host",
    "architecture": "x86_64",
    "playwrightImage": "mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e",
    "pnpmVersion": "11.7.0",
    "testCommand": "pnpm run test:e2e",
    "result": "passed",
    "testCounts": {"passed": 12, "failed": 0, "skipped": 0},
}, indent=2) + "\n")
PYTHON

digest="$(python3 "$VALIDATOR" "$TEMP_ROOT/evidence.json" "$COMMIT")"
[[ "$digest" =~ ^[a-f0-9]{64}$ ]]

python3 - "$TEMP_ROOT/evidence.json" <<'PYTHON'
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
value = json.loads(path.read_text())
value["testCounts"]["failed"] = 1
path.write_text(json.dumps(value))
PYTHON
if python3 "$VALIDATOR" "$TEMP_ROOT/evidence.json" "$COMMIT" >/dev/null 2>&1; then
  printf '%s\n' 'Release E2E evidence validator accepted a failing test result.' >&2
  exit 1
fi

printf '%s\n' 'release E2E evidence validator tests passed'
