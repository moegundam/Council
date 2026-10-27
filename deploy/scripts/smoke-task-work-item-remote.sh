#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN=false
SMOKE_TARGET=production
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN=true
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' 'Usage: smoke-task-work-item-remote.sh --run --target disposable|isolated' >&2
        exit 2
      fi
      SMOKE_TARGET="$2"
      shift
      ;;
    --help|-h)
      printf '%s\n' 'Usage: smoke-task-work-item-remote.sh --run --target disposable|isolated'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$RUN" != "true" ]]; then
  printf '%s\n' 'Dry run only. Use --run --target disposable|isolated to create a fresh remote Task Adapter acceptance record.'
  printf 'Target: %s via %s\n' "${REMOTE_TARGET:-operator@council.example}" "${REMOTE_JUMP-jump@bastion.example}"
  exit 0
fi
if [[ "$SMOKE_TARGET" != "disposable" && "$SMOKE_TARGET" != "isolated" ]]; then
  printf '%s\n' 'Mutating Task Adapter smoke requires --target disposable or --target isolated.' >&2
  exit 2
fi

source "${SCRIPT_DIR}/remote-common.sh"

remote_ssh "SMOKE_TARGET='${SMOKE_TARGET}' bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
SECRETS_ROOT="${ROOT}/secrets/${STACK}"
SMOKE_POLICY="${ROOT}/releases/${STACK}/current/deploy/scripts/smoke-data-hygiene.sh"
BASE_URL=http://127.0.0.1:8787
SNAPSHOT="$(mktemp)"
COMPOSE_CONFIG="$(mktemp)"

cleanup() {
  rm -f "$SNAPSHOT" "$COMPOSE_CONFIG"
}
trap cleanup EXIT

test -f "${COMPOSE_DIR}/.env"
test -r "$SMOKE_POLICY"
source "$SMOKE_POLICY"
docker compose --project-name "$STACK" --env-file "${COMPOSE_DIR}/.env" \
  -f "${COMPOSE_DIR}/compose.yaml" config --format json >"$COMPOSE_CONFIG"
mapfile -t deployment_values < <(python3 - "$COMPOSE_CONFIG" <<'PYTHON'
import json, sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
api = config.get("services", {}).get("api", {})
environment = api.get("environment", {})
names = ("AUTH_DISABLED", "ALLOW_PRODUCTION_AUTH_BYPASS", "PUBLIC_ORIGIN")
values = []
for name in names:
    value = environment.get(name)
    if not isinstance(value, str) or not value:
        raise SystemExit(f"Resolved API environment is missing {name}.")
    values.append(value)
image = api.get("image")
prefix = "agent-meeting-platform-api:"
if not isinstance(image, str) or not image.startswith(prefix) or not image[len(prefix):]:
    raise SystemExit("Resolved API image does not contain a release version.")
for value in (*values, image[len(prefix):]):
    print(value)
PYTHON
)
if [[ "${#deployment_values[@]}" -ne 4 ]]; then
  printf '%s\n' 'Could not read the resolved deployment configuration.' >&2
  exit 1
fi
AUTH_DISABLED="${deployment_values[0]}"
ALLOW_PRODUCTION_AUTH_BYPASS="${deployment_values[1]}"
PUBLIC_ORIGIN="${deployment_values[2]}"
RELEASE_VERSION="${deployment_values[3]}"
smoke_require_mutating_acceptance "$SMOKE_TARGET" "${COMPOSE_DIR}/.env" "$COMPOSE_CONFIG" >/dev/null
if [[ "${AUTH_DISABLED:-false}" != "true" || "${ALLOW_PRODUCTION_AUTH_BYPASS:-false}" != "true" ]]; then
  printf '%s\n' 'Task smoke requires the owner-approved temporary authentication bypass.' >&2
  exit 1
fi
test -n "$PUBLIC_ORIGIN"
RUN_STARTED_AT="$(python3 -c 'from datetime import datetime, timezone; print(datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))')"
RUN_NONCE="$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
RUN_ID="${RELEASE_VERSION}-$(date -u +%Y%m%dT%H%M%SZ)-${RUN_NONCE}"

api_get() {
  curl --fail-with-body --silent --show-error "${BASE_URL}$1"
}

api_body() {
  local method="$1"
  local path="$2"
  curl --fail-with-body --silent --show-error \
    --request "$method" \
    --header "Origin: ${PUBLIC_ORIGIN}" \
    --header 'content-type: application/json' \
    --data-binary @- \
    "${BASE_URL}${path}"
}

api_get /api/bootstrap >"$SNAPSHOT"
ADAPTER_ID="$(python3 - "$SNAPSHOT" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
enabled = [item for item in snapshot["taskAdapterConnectors"] if item["enabled"]]
if len(enabled) > 1:
    raise SystemExit("More than one enabled Task Adapter exists.")
if enabled and enabled[0]["baseUrl"] != "http://task-adapter-reference:4200":
    raise SystemExit("The enabled Task Adapter is not the reference service.")
print(enabled[0]["id"] if enabled else "")
PYTHON
)"

if [[ -z "$ADAPTER_ID" ]]; then
  ADAPTER_RESPONSE="$(python3 - "${SECRETS_ROOT}/task_adapter_token" <<'PYTHON' | api_body POST /api/task-adapter-connectors
import json, pathlib, sys
token = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").rstrip("\r\n")
json.dump({
    "name": "Reference Task Adapter",
    "location": "local",
    "baseUrl": "http://task-adapter-reference:4200",
    "bearerToken": token,
}, sys.stdout)
PYTHON
)"
  ADAPTER_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$ADAPTER_RESPONSE")"
fi

HEALTH_RESPONSE="$(printf '{}' | api_body POST "/api/task-adapter-connectors/${ADAPTER_ID}/health")"
python3 -c 'import json,sys; assert json.load(sys.stdin) == {"healthy": True}' <<<"$HEALTH_RESPONSE"

api_get /api/bootstrap >"$SNAPSHOT"
MEETING_ID="$(python3 -c 'import json,sys; data=json.load(open(sys.argv[1])); assert data["meetings"]; print(data["meetings"][-1]["id"])' "$SNAPSHOT")"
SMOKE_TITLE="M10 Task Adapter 正式驗收 ${RUN_ID}"
DECISION_RESPONSE="$(python3 - "$MEETING_ID" "$SMOKE_TITLE" <<'PYTHON' | api_body POST /api/decisions
import json, sys
json.dump({
    "meetingId": sys.argv[1],
    "title": sys.argv[2],
    "description": "驗證 Task 工作單、證據、歷程與外部同步。",
}, sys.stdout)
PYTHON
)"
DECISION_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$DECISION_RESPONSE")"
printf '{}' | api_body POST "/api/decisions/${DECISION_ID}/approve" >/dev/null
TASK_RESPONSE="$(python3 - "$DECISION_ID" "$SMOKE_TITLE" <<'PYTHON' | curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Origin: ${PUBLIC_ORIGIN}" \
  --header 'content-type: application/json' \
  --header "idempotency-key: m10-smoke-${RUN_ID}" \
  --data-binary @- \
  "${BASE_URL}/api/tasks"
from datetime import datetime, timedelta, timezone
import json, sys
json.dump({
    "decisionId": sys.argv[1],
    "title": sys.argv[2],
    "description": "正式環境 Task Adapter 端到端驗收。",
    "assignee": "Platform owner",
    "dueAt": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
    "acceptanceCriteria": "證據與歷程保留，外部同步回傳 deterministic external ID。",
    "executionProfile": "manual",
    "allowedTools": ["task-adapter.upsert"],
    "dataScope": "Task fields only; no transcript",
}, sys.stdout)
PYTHON
)"
TASK_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$TASK_RESPONSE")"

api_get /api/bootstrap >"$SNAPSHOT"
EXECUTION_REVISION="$(python3 - "$SNAPSHOT" "$TASK_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
print(task["execution"]["revision"])
PYTHON
)"
PATCH_RESPONSE="$(python3 - "$EXECUTION_REVISION" <<'PYTHON' | api_body PATCH "/api/tasks/${TASK_ID}"
import json, sys
json.dump({
    "expectedExecutionRevision": int(sys.argv[1]),
    "acceptanceCriteria": "正式 API、Worker、Adapter 與 UI 可追溯同步。",
}, sys.stdout)
PYTHON
)"
EXECUTION_REVISION="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["execution"]["revision"])' <<<"$PATCH_RESPONSE")"

EVIDENCE_RESPONSE="$(printf '%s' '{"type":"note","label":"正式驗收","reference":"由遠端 smoke script 建立；未包含 Connector secret 或逐字稿。"}' \
  | api_body POST "/api/tasks/${TASK_ID}/evidence")"
printf '%s' "$EVIDENCE_RESPONSE" >"$SNAPSHOT"
EVIDENCE_ID="$(python3 - "$SNAPSHOT" "$RUN_STARTED_AT" <<'PYTHON'
from datetime import datetime
import json, sys

def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

task = json.load(open(sys.argv[1], encoding="utf-8"))
run_started_at = instant(sys.argv[2])
matches = [
    item for item in task["evidence"]
    if item["type"] == "note"
    and item["label"] == "正式驗收"
    and item["reference"] == "由遠端 smoke script 建立；未包含 Connector secret 或逐字稿。"
    and instant(item["createdAt"]) >= run_started_at
]
assert len(matches) == 1
print(matches[0]["id"])
PYTHON
)"

printf '{"status":"in_progress","position":0,"expectedExecutionRevision":%s}' "$EXECUTION_REVISION" | api_body PATCH "/api/tasks/${TASK_ID}/status" >/dev/null
printf '{"status":"review","position":0,"expectedExecutionRevision":%s}' "$EXECUTION_REVISION" | api_body PATCH "/api/tasks/${TASK_ID}/status" >/dev/null
printf '{"adapterId":"%s"}' "$ADAPTER_ID" | api_body POST "/api/tasks/${TASK_ID}/sync" >/dev/null

for _ in $(seq 1 30); do
  api_get /api/bootstrap >"$SNAPSHOT"
  SYNC_STATUS="$(python3 - "$SNAPSHOT" "$TASK_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
print(task["sync"]["status"])
PYTHON
)"
  if [[ "$SYNC_STATUS" == "synced" ]]; then
    break
  fi
  if [[ "$SYNC_STATUS" == "failed" ]]; then
    printf '%s\n' 'Task Adapter synchronization failed.' >&2
    exit 1
  fi
  sleep 2
done

python3 - "$SNAPSHOT" "$TASK_ID" "$SMOKE_TITLE" "$RUN_STARTED_AT" "$EVIDENCE_ID" <<'PYTHON'
from datetime import datetime
import json, sys

def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
assert task["title"] == sys.argv[3]
run_started_at = instant(sys.argv[4])
assert instant(task["createdAt"]) >= run_started_at
assert task["status"] == "review"
assert task["acceptanceCriteria"] == "正式 API、Worker、Adapter 與 UI 可追溯同步。"
assert task["sync"]["status"] == "synced"
assert task["sync"]["externalId"].startswith("task_")
assert instant(task["sync"]["syncedAt"]) >= run_started_at
evidence = next(item for item in task["evidence"] if item["id"] == sys.argv[5])
assert evidence["label"] == "正式驗收"
assert evidence["addedBy"] == "owner"
assert instant(evidence["createdAt"]) >= run_started_at
required = {"created", "updated", "evidence_added", "moved", "sync_requested", "sync_succeeded"}
assert required.issubset({item["type"] for item in task["transitions"]})
assert all(instant(item["at"]) >= run_started_at for item in task["transitions"])
print(f'Task smoke passed fresh=yes task={task["id"]} evidence={evidence["id"]} external={task["sync"]["externalId"]}')
PYTHON
REMOTE
