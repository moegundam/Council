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
        printf '%s\n' 'Usage: smoke-task-agent-run-remote.sh --run --target disposable|isolated' >&2
        exit 2
      fi
      SMOKE_TARGET="$2"
      shift
      ;;
    --help|-h)
      printf '%s\n' 'Usage: smoke-task-agent-run-remote.sh --run --target disposable|isolated'
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
  printf '%s\n' 'Dry run only. Use --run --target disposable|isolated to create a fresh remote Task Agent acceptance record.'
  printf 'Target: %s via %s\n' "${REMOTE_TARGET:-operator@council.example}" "${REMOTE_JUMP-jump@bastion.example}"
  exit 0
fi
if [[ "$SMOKE_TARGET" != "disposable" && "$SMOKE_TARGET" != "isolated" ]]; then
  printf '%s\n' 'Mutating Task Agent smoke requires --target disposable or --target isolated.' >&2
  exit 2
fi

source "${SCRIPT_DIR}/remote-common.sh"

remote_ssh "SMOKE_TARGET='${SMOKE_TARGET}' bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
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
  printf '%s\n' 'Task Agent smoke requires the owner-approved temporary authentication bypass.' >&2
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
read -r AGENT_ID MEETING_ID < <(python3 - "$SNAPSHOT" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
enabled_local = {
    item["id"] for item in snapshot["modelConnectors"]
    if item["enabled"] and item["location"] == "local"
}
agent = next((item for item in snapshot["agents"] if item.get("modelConnectorId") in enabled_local), None)
if not agent:
    raise SystemExit("No Agent has an enabled local Model Connector.")
if not snapshot["meetings"]:
    raise SystemExit("No Meeting is available as Task provenance.")
print(agent["id"], snapshot["meetings"][-1]["id"])
PYTHON
)

SMOKE_TITLE="M11 Task Agent 正式驗收 ${RUN_ID}"
DECISION_RESPONSE="$(python3 - "$MEETING_ID" "$SMOKE_TITLE" <<'PYTHON' | api_body POST /api/decisions
import json, sys
json.dump({
    "meetingId": sys.argv[1],
    "title": sys.argv[2],
    "description": "驗證地端 Agent 依受控 Task 產生文字 Evidence，且只移至 Review。",
}, sys.stdout)
PYTHON
)"
DECISION_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$DECISION_RESPONSE")"
printf '{}' | api_body POST "/api/decisions/${DECISION_ID}/approve" >/dev/null
TASK_RESPONSE="$(python3 - "$DECISION_ID" "$SMOKE_TITLE" "$AGENT_ID" <<'PYTHON' | curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Origin: ${PUBLIC_ORIGIN}" \
  --header 'content-type: application/json' \
  --header "idempotency-key: m11-task-${RUN_ID}" \
  --data-binary @- \
  "${BASE_URL}/api/tasks"
import json, sys
json.dump({
    "decisionId": sys.argv[1],
    "title": sys.argv[2],
    "description": "請整理本次正式驗收的實作結果與人工檢查重點；不得呼叫外部工具。",
    "assigneeAgentId": sys.argv[3],
    "acceptanceCriteria": "產出保存為未驗證 Evidence，Task 只自動移至 Review。",
    "executionProfile": "worker",
    "allowedTools": [],
    "dataScope": "Task、來源 Decision 與 Meeting 目標；不含逐字稿或外部資料",
}, sys.stdout)
PYTHON
)"
TASK_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$TASK_RESPONSE")"

api_get /api/bootstrap >"$SNAPSHOT"
read -r EXECUTION_REVISION APPROVAL_STATE EXECUTION_STATUS < <(python3 - "$SNAPSHOT" "$TASK_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
print(task["execution"]["revision"], task["approvalState"], task["execution"]["status"])
PYTHON
)

if [[ "$EXECUTION_STATUS" != "idle" ]]; then
  printf 'Fresh Task Agent record started in an unexpected execution state: %s\n' "$EXECUTION_STATUS" >&2
  exit 1
fi
if [[ "$APPROVAL_STATE" != "approved" ]]; then
  APPROVAL_RESPONSE="$(printf '{"expectedExecutionRevision":%s,"action":"approve"}' "$EXECUTION_REVISION" \
    | api_body POST "/api/tasks/${TASK_ID}/approval")"
  EXECUTION_REVISION="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["execution"]["revision"])' <<<"$APPROVAL_RESPONSE")"
fi
printf '{"expectedExecutionRevision":%s}' "$EXECUTION_REVISION" | curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Origin: ${PUBLIC_ORIGIN}" \
  --header 'content-type: application/json' \
  --header "idempotency-key: m11-task-agent-${RUN_ID}-${EXECUTION_REVISION}" \
  --data-binary @- \
  "${BASE_URL}/api/tasks/${TASK_ID}/run" >/dev/null

for _ in $(seq 1 90); do
  api_get /api/bootstrap >"$SNAPSHOT"
  EXECUTION_STATUS="$(python3 - "$SNAPSHOT" "$TASK_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
print(task["execution"]["status"])
PYTHON
)"
  if [[ "$EXECUTION_STATUS" == "completed" ]]; then
    break
  fi
  if [[ "$EXECUTION_STATUS" == "failed" ]]; then
    python3 - "$SNAPSHOT" "$TASK_ID" <<'PYTHON' >&2
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
print(f'Task Agent run failed: {task["execution"]["lastError"]}')
PYTHON
    exit 1
  fi
  sleep 2
done

python3 - "$SNAPSHOT" "$TASK_ID" "$AGENT_ID" "$SMOKE_TITLE" "$RUN_STARTED_AT" <<'PYTHON'
from datetime import datetime
import json, sys

def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
task = next(item for item in snapshot["tasks"] if item["id"] == sys.argv[2])
assert task["assigneeAgentId"] == sys.argv[3]
assert task["title"] == sys.argv[4]
run_started_at = instant(sys.argv[5])
assert instant(task["createdAt"]) >= run_started_at
assert task["executionProfile"] == "worker"
assert task["approvalState"] == "approved"
assert task["execution"]["status"] == "completed"
assert task["status"] == "review"
assert instant(task["execution"]["requestedAt"]) >= run_started_at
assert instant(task["execution"]["startedAt"]) >= run_started_at
assert instant(task["execution"]["completedAt"]) >= run_started_at
result_id = task["execution"]["resultEvidenceId"]
evidence = next(item for item in task["evidence"] if item["id"] == result_id)
assert evidence["type"] == "note"
assert evidence["addedBy"] == "system"
assert evidence["agentId"] == sys.argv[3]
assert evidence["executionProfile"] == "worker"
assert evidence["jobId"] == task["execution"]["jobId"]
assert instant(evidence["createdAt"]) >= run_started_at
assert evidence["reference"].strip()
required = {"approval_changed", "agent_run_requested", "agent_run_started", "agent_run_completed", "moved"}
assert required.issubset({item["type"] for item in task["transitions"]})
print(f'Task Agent smoke passed fresh=yes task={task["id"]} evidence={result_id}')
PYTHON
REMOTE
