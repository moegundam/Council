#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"

grep -Fq 'HARNESS_EXECUTOR_ENABLED: "false"' "$COMPOSE"

printf '%s\n' 'Harness default-disabled policy test passed'
