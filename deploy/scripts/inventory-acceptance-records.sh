#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf '%s\n' 'Usage: inventory-acceptance-records.sh --backup-dir /path/to/verified-backup [--dry-run]' >&2
}

BACKUP_DIR=
DRY_RUN=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      if [[ $# -lt 2 ]]; then
        usage
        exit 2
      fi
      BACKUP_DIR="$2"
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage
      exit 2
      ;;
  esac
  shift
done

if [[ -z "$BACKUP_DIR" ]]; then
  usage
  exit 2
fi
if [[ ! -d "$BACKUP_DIR" ]]; then
  printf 'Backup directory does not exist: %s\n' "$BACKUP_DIR" >&2
  exit 1
fi

BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"
CHECKSUM_FILE="${BACKUP_DIR}/SHA256SUMS"
if [[ ! -r "$CHECKSUM_FILE" ]]; then
  printf 'Refusing inventory: backup checksum file is missing: %s\n' "$CHECKSUM_FILE" >&2
  exit 1
fi

if [[ -f "${BACKUP_DIR}/postgres.sql.gz" ]]; then
  BACKUP_FILE="${BACKUP_DIR}/postgres.sql.gz"
elif [[ -f "${BACKUP_DIR}/postgres.sql" ]]; then
  BACKUP_FILE="${BACKUP_DIR}/postgres.sql"
else
  printf 'Refusing inventory: postgres backup is missing in %s\n' "$BACKUP_DIR" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && sha256sum --check --status SHA256SUMS)
else
  expected_checksum="$(awk '$2 == "postgres.sql.gz" || $2 == "postgres.sql" { print $1; exit }' "$CHECKSUM_FILE")"
  actual_checksum="$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')"
  [[ -n "$expected_checksum" && "$expected_checksum" == "$actual_checksum" ]] \
    || { printf '%s\n' 'Refusing inventory: backup checksum verification failed.' >&2; exit 1; }
fi

if [[ "$BACKUP_FILE" == *.gz ]]; then
  gzip -t "$BACKUP_FILE"
fi

python3 - "$BACKUP_FILE" "$DRY_RUN" <<'PYTHON'
import gzip
import json
import pathlib
import sys

backup_file = pathlib.Path(sys.argv[1])
dry_run = sys.argv[2] == "true"

def load_state(path: pathlib.Path):
    opener = gzip.open if path.suffix == ".gz" else open
    inside_copy = False
    state_index = None
    state = None
    with opener(path, "rt", encoding="utf-8") as stream:
        for raw_line in stream:
            line = raw_line.rstrip("\n")
            if line.startswith("COPY ") and "platform_state" in line and "FROM stdin;" in line:
                open_paren = line.rfind("(")
                close_paren = line.rfind(")")
                if open_paren < 0 or close_paren <= open_paren:
                    raise SystemExit("Could not parse platform_state COPY columns.")
                columns = [column.strip().strip('"') for column in line[open_paren + 1:close_paren].split(",")]
                if "state" not in columns:
                    raise SystemExit("platform_state COPY does not include the state column.")
                state_index = columns.index("state")
                inside_copy = True
                continue
            if not inside_copy:
                continue
            if line == r"\.":
                break
            fields = line.split("\t")
            if state_index is None or state_index >= len(fields):
                raise SystemExit("Could not parse platform_state backup row.")
            try:
                state = json.loads(fields[state_index])
            except json.JSONDecodeError as error:
                raise SystemExit(f"Could not parse platform_state JSON: {error}") from error
            break
    if not isinstance(state, dict):
        raise SystemExit("Backup does not contain a platform_state JSON object.")
    return state

state = load_state(backup_file)
if not isinstance(state, dict):
    raise SystemExit("Backup state is not a JSON object.")

collections = {
    "group": "groups",
    "category": "categories",
    "tag": "tags",
    "topic": "threads" if isinstance(state.get("threads"), list) else "topics",
    "agent": "agents",
    "model_connector": "modelConnectors",
    "mcp_connector": "mcpConnectors",
    "task_adapter_connector": "taskAdapterConnectors",
    "meeting": "meetings",
    "decision": "decisions",
    "task": "tasks",
    "credential": "credentials",
    "prompt": "prompts",
    "agent_team": "agentTeams",
    "meeting_preset": "meetingPresets",
    "runtime_profile": "runtimeProfiles",
    "tool_pack": "toolPacks",
}
print("backup_verified=true")
print(f"dry_run={str(dry_run).lower()}")
total = 0
for record_type, key in collections.items():
    records = state.get(key, [])
    if not isinstance(records, list):
        raise SystemExit(f"Backup collection is not a list: {key}")
    matches = []
    for item in records:
        if not isinstance(item, dict):
            continue
        label = item.get("name") or item.get("title") or item.get("label") or ""
        if "[Acceptance]" not in str(label):
            continue
        matches.append((str(item.get("id", "unknown")), str(label).replace("\n", " ")[:160]))
    for record_id, label in matches:
        print(f"record type={record_type} id={record_id} label={label}")
    print(f"type={record_type} count={len(matches)}")
    total += len(matches)
print(f"total={total}")
print("deletions=0")
PYTHON
