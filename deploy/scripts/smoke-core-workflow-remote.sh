#!/usr/bin/env bash

set -euo pipefail

RUN=false
SMOKE_TARGET=production
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN=true
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' 'Usage: smoke-core-workflow-remote.sh --run --target disposable|isolated' >&2
        exit 2
      fi
      SMOKE_TARGET="$2"
      shift
      ;;
    --help|-h)
      printf '%s\n' 'Usage: smoke-core-workflow-remote.sh --run --target disposable|isolated'
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
  printf '%s\n' 'Usage: smoke-core-workflow-remote.sh --run --target disposable|isolated' >&2
  exit 2
fi
if [[ "$SMOKE_TARGET" != "disposable" && "$SMOKE_TARGET" != "isolated" ]]; then
  printf '%s\n' 'Mutating core workflow smoke requires --target disposable or --target isolated.' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

remote_ssh "SMOKE_TARGET='${SMOKE_TARGET}' bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
BASE_URL=http://127.0.0.1:8787
SAFE_RESPONSE_EXCERPT="${ROOT}/releases/${STACK}/current/deploy/scripts/safe-api-error-excerpt.py"
SMOKE_POLICY="${ROOT}/releases/${STACK}/current/deploy/scripts/smoke-data-hygiene.sh"
SNAPSHOT="$(mktemp)"
API_RESPONSE="$(mktemp)"
COMPOSE_CONFIG="$(mktemp)"
CURRENT_STEP=bootstrap

cleanup() {
  rm -f "$SNAPSHOT" "$API_RESPONSE" "$COMPOSE_CONFIG"
}
trap cleanup EXIT

step() {
  CURRENT_STEP="$1"
  printf 'Core workflow smoke: %s\n' "$CURRENT_STEP" >&2
}

safe_response_excerpt() {
  python3 "$SAFE_RESPONSE_EXCERPT" "$API_RESPONSE"
}

test -f "${COMPOSE_DIR}/.env"
test -f "$SAFE_RESPONSE_EXCERPT"
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
  printf '%s\n' 'Core workflow smoke requires the owner-approved temporary authentication bypass.' >&2
  exit 1
fi
test -n "$PUBLIC_ORIGIN"
RUN_ID="${RELEASE_VERSION}-$(date -u +%Y%m%dT%H%M%SZ)-$$"

api_get() {
  local path="$1"
  local status

  if ! status="$(curl --silent --show-error --output "$API_RESPONSE" --write-out '%{http_code}' "${BASE_URL}${path}")"; then
    printf 'Core workflow smoke transport failure at %s (GET %s).\n' "$CURRENT_STEP" "$path" >&2
    return 1
  fi
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Core workflow smoke HTTP %s at %s (GET %s): ' "$status" "$CURRENT_STEP" "$path" >&2
    safe_response_excerpt >&2
    printf '\n' >&2
    return 1
  fi
  cat "$API_RESPONSE"
}

api_body() {
  local method="$1"
  local path="$2"
  local key="$3"
  local status

  if ! status="$(curl --silent --show-error \
      --output "$API_RESPONSE" \
      --write-out '%{http_code}' \
      --request "$method" \
      --header "Origin: ${PUBLIC_ORIGIN}" \
      --header 'content-type: application/json' \
      --header "idempotency-key: ${key}" \
      --data-binary @- \
      "${BASE_URL}${path}")"; then
    printf 'Core workflow smoke transport failure at %s (%s %s).\n' "$CURRENT_STEP" "$method" "$path" >&2
    return 1
  fi
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Core workflow smoke HTTP %s at %s (%s %s): ' "$status" "$CURRENT_STEP" "$method" "$path" >&2
    safe_response_excerpt >&2
    printf '\n' >&2
    return 1
  fi
  cat "$API_RESPONSE"
}

step 'load bootstrap dependencies'
api_get /api/bootstrap >"$SNAPSHOT"
read -r RUN_AGENT_ID RUNNABLE_COUNT TOOL_CONNECTOR_ID TOOL_NAME < <(python3 - "$SNAPSHOT" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
enabled_local = {
    item["id"] for item in snapshot["modelConnectors"]
    if item["enabled"] and item["location"] == "local"
}
runnable = [item for item in snapshot["agents"] if item.get("modelConnectorId") in enabled_local]
if len(runnable) < 2:
    raise SystemExit("The multi-Agent core smoke requires at least two Agents on enabled local Model Connectors.")
runnable_ids = {item["id"] for item in runnable}
for connector in snapshot["mcpConnectors"]:
    if not connector["enabled"]:
        continue
    registered = {item["toolName"] for item in connector["toolRegistrations"]}
    approved = [item for item in connector["approvedTools"] if item in registered]
    for agent in snapshot["agents"]:
        if agent["id"] not in runnable_ids:
            continue
        grants = {
            grant["toolName"] for grant in agent["toolGrants"]
            if grant["connectorId"] == connector["id"]
        }
        tool = next((item for item in approved if item in grants), None)
        if tool:
            print(agent["id"], len(runnable), connector["id"], tool)
            raise SystemExit(0)
raise SystemExit("No runnable local Agent has a registered, approved read-only MCP Tool grant.")
PYTHON
)

step 'create discussion Group'
GROUP_RESPONSE="$(python3 - "$RUN_ID" <<'PYTHON' | api_body POST /api/groups "core-group-${RUN_ID}"
import json, sys
json.dump({"name": f"[Acceptance] Council {sys.argv[1]}"}, sys.stdout)
PYTHON
)"
GROUP_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$GROUP_RESPONSE")"

step 'create discussion Category'
CATEGORY_RESPONSE="$(python3 - "$GROUP_ID" <<'PYTHON' | api_body POST /api/categories "core-category-${RUN_ID}"
import json, sys
json.dump({"groupId": sys.argv[1], "name": "Phase 1 workflow"}, sys.stdout)
PYTHON
)"
CATEGORY_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$CATEGORY_RESPONSE")"

step 'create discussion Tag'
TAG_RESPONSE="$(python3 - "$RUN_ID" <<'PYTHON' | api_body POST /api/tags "core-tag-${RUN_ID}"
import json, sys
json.dump({"name": f"Acceptance {sys.argv[1]}", "color": "blue"}, sys.stdout)
PYTHON
)"
TAG_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$TAG_RESPONSE")"

step 'create discussion Topic'
THREAD_RESPONSE="$(python3 - "$CATEGORY_ID" "$TAG_ID" "$RUN_ID" <<'PYTHON' | api_body POST /api/threads "core-topic-${RUN_ID}"
import json, sys
json.dump({
    "categoryId": sys.argv[1],
    "title": f"[Acceptance] Discussion to Task {sys.argv[3]}",
    "summary": "Isolated end-to-end verification of the fixed Phase 1 workflow.",
    "tagIds": [sys.argv[2]],
}, sys.stdout)
PYTHON
)"
THREAD_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$THREAD_RESPONSE")"

step 'create multi-Agent Meeting'
MEETING_RESPONSE="$(python3 - "$SNAPSHOT" "$THREAD_ID" "$RUN_ID" "$RUN_AGENT_ID" <<'PYTHON' | api_body POST /api/meetings "core-meeting-${RUN_ID}"
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
enabled_local = {
    item["id"] for item in snapshot["modelConnectors"]
    if item["enabled"] and item["location"] == "local"
}
all_agents = [item for item in snapshot["agents"] if item.get("modelConnectorId") in enabled_local]
tool_agent = next(item for item in all_agents if item["id"] == sys.argv[4])
agents = [next(item for item in all_agents if item["id"] != tool_agent["id"]), tool_agent]
agents.extend(item for item in all_agents if item["id"] not in {entry["id"] for entry in agents})
agents = agents[:3]
roles = [item for item in snapshot["roles"] if not item.get("deletedAt")]
chair_role = next((item for item in roles if item.get("templateKey") == "meeting_chair"), roles[0])
other_roles = [item for item in roles if item["id"] != chair_role["id"]] or [chair_role]
tool_role = next((item for item in roles if item.get("toolPolicy") == "agent_read_only_grants"), None)
if not tool_role:
    raise SystemExit("No active Role permits Agent read-only grants.")
participants = []
for index, agent in enumerate(agents):
    role = chair_role if index == 0 else tool_role if agent["id"] == tool_agent["id"] else other_roles[(index - 1) % len(other_roles)]
    participants.append({"agentId": agent["id"], "roleId": role["id"], "isChair": index == 0})
json.dump({
    "threadId": sys.argv[2],
    "title": f"[Acceptance] Multi-Agent Meeting {sys.argv[3]}",
    "goal": "Reach one evidence-backed Phase 1 deployment decision and assign its Task.",
    "mode": "open",
    "automation": "suggest",
    "durationMinutes": 30,
    "participants": participants,
    "agendaItems": [
        {"title": "Review evidence", "description": "Verify runtime and policy evidence."},
        {"title": "Approve action", "description": "Approve one bounded follow-up Task."},
    ],
}, sys.stdout)
PYTHON
)"
MEETING_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$MEETING_RESPONSE")"

step 'start Meeting'
printf '{}' | api_body POST "/api/meetings/${MEETING_ID}/start" "core-start-${RUN_ID}" >/dev/null
step 'post initial human contribution'
printf '%s' '{"content":"Please review the Phase 1 evidence and identify one bounded follow-up."}' \
  | api_body POST "/api/meetings/${MEETING_ID}/utterances" "core-human-${RUN_ID}" >/dev/null

step 'queue local Agent turn'
python3 - "$RUN_AGENT_ID" <<'PYTHON' | api_body POST "/api/meetings/${MEETING_ID}/run" "core-agent-${RUN_ID}" >/dev/null
import json, sys
json.dump({"agentId": sys.argv[1]}, sys.stdout)
PYTHON

step 'wait for local Agent turn'
for _ in $(seq 1 120); do
  api_get /api/bootstrap >"$SNAPSHOT"
  TURN_STATE="$(python3 - "$SNAPSHOT" "$MEETING_ID" "$RUN_AGENT_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
meeting = next(item for item in snapshot["meetings"] if item["id"] == sys.argv[2])
completed = any(
    item["meetingId"] == sys.argv[2] and item.get("agentId") == sys.argv[3]
    for item in snapshot["utterances"]
)
print("completed" if completed else "failed" if meeting["state"] == "paused" else "waiting")
PYTHON
)"
  [[ "$TURN_STATE" == "completed" ]] && break
  if [[ "$TURN_STATE" == "failed" ]]; then
    printf '%s\n' 'The local Agent turn failed and paused the acceptance Meeting.' >&2
    exit 1
  fi
  sleep 2
done
[[ "$TURN_STATE" == "completed" ]] || { printf '%s\n' 'The local Agent turn did not complete in time.' >&2; exit 1; }

step 'queue approved read-only Tool Run'
TOOL_RESPONSE="$(python3 - "$RUN_AGENT_ID" "$TOOL_CONNECTOR_ID" "$TOOL_NAME" <<'PYTHON' | api_body POST "/api/meetings/${MEETING_ID}/tools/run" "core-tool-${RUN_ID}"
import json, sys
json.dump({
    "agentId": sys.argv[1],
    "connectorId": sys.argv[2],
    "toolName": sys.argv[3],
    "arguments": {},
}, sys.stdout)
PYTHON
)"
TOOL_JOB_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])' <<<"$TOOL_RESPONSE")"
step 'wait for approved read-only Tool Run'
for _ in $(seq 1 60); do
  api_get /api/bootstrap >"$SNAPSHOT"
  TOOL_STATE="$(python3 - "$SNAPSHOT" "$TOOL_JOB_ID" "$MEETING_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
run = next((item for item in snapshot["toolRuns"] if item["jobId"] == sys.argv[2]), None)
meeting = next(item for item in snapshot["meetings"] if item["id"] == sys.argv[3])
print(run["status"] if run else "failed" if meeting["state"] == "paused" else "waiting")
PYTHON
)"
  [[ "$TOOL_STATE" == "succeeded" ]] && break
  if [[ "$TOOL_STATE" == "failed" ]]; then
    printf '%s\n' 'The read-only MCP Tool Run failed and paused the acceptance Meeting.' >&2
    exit 1
  fi
  sleep 2
done
[[ "$TOOL_STATE" == "succeeded" ]] || { printf '%s\n' 'The read-only MCP Tool Run did not complete in time.' >&2; exit 1; }

step 'trigger Chair intervention suggestion'
printf '%s' '{"content":"Lunch and travel planning are unrelated to this deployment evidence agenda."}' \
  | api_body POST "/api/meetings/${MEETING_ID}/utterances" "core-chair-trigger-${RUN_ID}" >/dev/null
step 'load Chair intervention suggestion'
api_get /api/bootstrap >"$SNAPSHOT"
read -r SUGGESTION_ID SUGGESTED_REVISION < <(python3 - "$SNAPSHOT" "$MEETING_ID" "$RUN_AGENT_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
suggestions = [
    item for item in snapshot["chairSuggestions"]
    if item["meetingId"] == sys.argv[2] and item["status"] == "open"
]
suggestion = suggestions[-1] if suggestions else None
if not suggestion:
    raise SystemExit("The off-topic contribution did not create a Chair suggestion.")
required = ["suggestedParticipantId", "suggestedParticipantAgentId", "suggestedRoleId", "suggestedRoleVersion", "suggestedParticipantRoleRevision"]
if any(suggestion.get(field) is None for field in required):
    raise SystemExit("The Chair suggestion did not include an immutable Role recommendation.")
if suggestion["suggestedParticipantAgentId"] != sys.argv[3]:
    raise SystemExit("The Chair Role recommendation targeted the wrong Agent.")
print(suggestion["id"], suggestion["suggestedParticipantRoleRevision"])
PYTHON
)
step 'accept suggested participant Role'
printf '{"expectedRoleRevision":%s}' "$SUGGESTED_REVISION" \
  | api_body POST "/api/meetings/${MEETING_ID}/chair-suggestions/${SUGGESTION_ID}/role" "core-role-${RUN_ID}" >/dev/null

step 'create Meeting Decision'
DECISION_RESPONSE="$(python3 - "$MEETING_ID" "$RUN_ID" <<'PYTHON' | api_body POST /api/decisions "core-decision-${RUN_ID}"
import json, sys
json.dump({
    "meetingId": sys.argv[1],
    "title": f"Phase 1 acceptance decision {sys.argv[2]}",
    "description": "The fixed Discussion to Decision to Task workflow is accepted for this release.",
}, sys.stdout)
PYTHON
)"
DECISION_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$DECISION_RESPONSE")"
step 'approve Meeting Decision'
printf '{}' | api_body POST "/api/decisions/${DECISION_ID}/approve" "core-approve-${RUN_ID}" >/dev/null

step 'create Task from approved Decision'
TASK_RESPONSE="$(python3 - "$DECISION_ID" "$RUN_ID" <<'PYTHON' | api_body POST /api/tasks "core-task-${RUN_ID}"
import json, sys
json.dump({
    "decisionId": sys.argv[1],
    "title": f"Phase 1 acceptance Task {sys.argv[2]}",
    "description": "Verify the accepted release evidence.",
    "assignee": "Platform owner",
    "acceptanceCriteria": "All four Task states and one Evidence item are retained.",
    "executionProfile": "manual",
    "allowedTools": [],
    "dataScope": "This acceptance Meeting only",
}, sys.stdout)
PYTHON
)"
TASK_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$TASK_RESPONSE")"
EXECUTION_REVISION="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["execution"]["revision"])' <<<"$TASK_RESPONSE")"

step 'attach Task Evidence'
printf '%s' '{"type":"note","label":"Phase 1 acceptance","reference":"Created by the isolated remote core workflow smoke."}' \
  | api_body POST "/api/tasks/${TASK_ID}/evidence" "core-evidence-${RUN_ID}" >/dev/null
for status in in_progress review done; do
  step "move Task to ${status}"
  printf '{"status":"%s","position":0,"expectedExecutionRevision":%s}' "$status" "$EXECUTION_REVISION" \
    | api_body PATCH "/api/tasks/${TASK_ID}/status" "core-task-${status}-${RUN_ID}" >/dev/null
done

step 'close Meeting'
printf '{}' | api_body POST "/api/meetings/${MEETING_ID}/close" "core-close-${RUN_ID}" >/dev/null
step 'archive discussion Topic'
printf '%s' '{"status":"archived"}' | api_body PATCH "/api/threads/${THREAD_ID}" "core-archive-${RUN_ID}" >/dev/null
step 'verify final workflow snapshot'
api_get /api/bootstrap >"$SNAPSHOT"

python3 - "$SNAPSHOT" "$GROUP_ID" "$CATEGORY_ID" "$TAG_ID" "$THREAD_ID" "$MEETING_ID" "$DECISION_ID" "$TASK_ID" "$SUGGESTION_ID" "$RUN_AGENT_ID" "$RUNNABLE_COUNT" "$TOOL_JOB_ID" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
group_id, category_id, tag_id, thread_id, meeting_id, decision_id, task_id, suggestion_id, agent_id = sys.argv[2:11]
assert int(sys.argv[11]) >= 2
assert any(item["id"] == group_id for item in snapshot["groups"])
assert any(item["id"] == category_id and item["groupId"] == group_id for item in snapshot["categories"])
assert any(item["id"] == tag_id for item in snapshot["tags"])
thread = next(item for item in snapshot["threads"] if item["id"] == thread_id)
assert thread["categoryId"] == category_id and tag_id in thread["tagIds"] and thread["status"] == "archived"
meeting = next(item for item in snapshot["meetings"] if item["id"] == meeting_id)
assert meeting["threadId"] == thread_id and meeting["state"] == "closed"
assert len([item for item in snapshot["participants"] if item["meetingId"] == meeting_id]) >= 2
assert any(item["meetingId"] == meeting_id and item.get("agentId") == agent_id for item in snapshot["utterances"])
tool_run = next(item for item in snapshot["toolRuns"] if item["jobId"] == sys.argv[12])
assert tool_run["meetingId"] == meeting_id and tool_run["agentId"] == agent_id and tool_run["status"] == "succeeded"
assert any(item["id"] == tool_run["utteranceId"] and item["kind"] == "verified" for item in snapshot["utterances"])
suggestion = next(item for item in snapshot["chairSuggestions"] if item["id"] == suggestion_id)
assert suggestion["status"] == "resolved" and suggestion["resolution"] == "completed"
assert any(item["type"] == "role_accepted" for item in suggestion["transitions"])
decision = next(item for item in snapshot["decisions"] if item["id"] == decision_id)
assert decision["meetingId"] == meeting_id and decision["status"] == "approved"
task = next(item for item in snapshot["tasks"] if item["id"] == task_id)
assert task["decisionId"] == decision_id and task["meetingId"] == meeting_id and task["status"] == "done"
assert any(item["label"] == "Phase 1 acceptance" for item in task["evidence"])
assert len([item for item in task["transitions"] if item["type"] == "moved"]) >= 3
print(f'Core workflow smoke passed meeting={meeting_id} decision={decision_id} task={task_id} chairSuggestion={suggestion_id}')
PYTHON
REMOTE
