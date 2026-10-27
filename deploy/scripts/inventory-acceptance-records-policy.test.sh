#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/inventory-acceptance-records.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

fail() {
  printf 'acceptance inventory policy failed: %s\n' "$1" >&2
  exit 1
}

[[ -x "$SCRIPT" ]] || fail 'acceptance inventory script is not executable'
bash -n "$SCRIPT"

set +e
usage_output="$(bash "$SCRIPT" 2>&1)"
usage_status=$?
set -e
[[ "$usage_status" -eq 2 ]] || fail 'inventory must require an explicit backup directory'
[[ "$usage_output" == *'Usage: inventory-acceptance-records.sh --backup-dir'* ]] \
  || fail 'inventory usage is missing'

BACKUP_DIR="${TEMP_ROOT}/backup"
mkdir -p "$BACKUP_DIR"
python3 - "$BACKUP_DIR/postgres.sql" <<'PYTHON'
import json
import sys

state = {
    "groups": [{"id": "group-1", "name": "[Acceptance] Group"}],
    "threads": [{"id": "topic-1", "title": "[Acceptance] Topic"}],
    "agents": [{"id": "agent-1", "name": "[Acceptance] Agent"}],
    "meetings": [{"id": "meeting-1", "title": "[Acceptance] Meeting"}],
    "tasks": [{"id": "task-1", "title": "[Acceptance] Task"}],
}
with open(sys.argv[1], "w", encoding="utf-8") as output:
    output.write("COPY public.platform_state (singleton_id, revision, state, updated_at) FROM stdin;\n")
    output.write("1\t1\t" + json.dumps(state, separators=(",", ":")) + "\t2026-08-09 00:00:00+00\n")
    output.write("\\.\n")
PYTHON
gzip -9 "$BACKUP_DIR/postgres.sql"
(cd "$BACKUP_DIR" && sha256sum postgres.sql.gz >SHA256SUMS)

inventory_output="$(bash "$SCRIPT" --backup-dir "$BACKUP_DIR" --dry-run)" \
  || fail 'verified backup inventory did not complete'
for required in \
  'backup_verified=true' \
  'dry_run=true' \
  'type=group count=1' \
  'type=topic count=1' \
  'type=agent count=1' \
  'type=meeting count=1' \
  'type=task count=1' \
  'deletions=0'; do
  [[ "$inventory_output" == *"$required"* ]] || fail "inventory output is missing: ${required}"
done
default_inventory_output="$(bash "$SCRIPT" --backup-dir "$BACKUP_DIR")" \
  || fail 'inventory was not dry-run by default'
[[ "$default_inventory_output" == *'dry_run=true'* ]] || fail 'inventory default mode is not dry-run'

set +e
mutating_output="$(bash "$SCRIPT" --backup-dir "$BACKUP_DIR" --delete 2>&1)"
mutating_status=$?
set -e
[[ "$mutating_status" -eq 2 ]] || fail 'inventory accepted a mutation option'
[[ "$mutating_output" == *'Unknown argument'* ]] || fail 'inventory mutation refusal was not explicit'

for forbidden in ssh remote_ssh curl 'DELETE' 'docker compose'; do
  if grep -Fqi "$forbidden" "$SCRIPT"; then
    fail "inventory script contains a remote or destructive operation: ${forbidden}"
  fi
done
grep -Fq 'sha256sum --check' "$SCRIPT" || fail 'inventory must verify the backup before reading records'
grep -Fq 'gzip -t' "$SCRIPT" || fail 'inventory must validate compressed backups before reading records'

printf '%s\n' 'acceptance inventory policy tests passed'
