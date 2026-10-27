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
        printf '%s\n' 'Usage: smoke-management-control-plane-remote.sh --run --target disposable|isolated' >&2
        exit 2
      fi
      SMOKE_TARGET="$2"
      shift
      ;;
    --help|-h)
      printf '%s\n' 'Usage: smoke-management-control-plane-remote.sh --run --target disposable|isolated'
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
  printf '%s\n' 'Usage: smoke-management-control-plane-remote.sh --run --target disposable|isolated' >&2
  exit 2
fi
if [[ "$SMOKE_TARGET" != "disposable" && "$SMOKE_TARGET" != "isolated" ]]; then
  printf '%s\n' 'Mutating management smoke requires --target disposable or --target isolated.' >&2
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
PREFLIGHT="$(mktemp)"
API_RESPONSE="$(mktemp)"
COMPOSE_CONFIG="$(mktemp)"
CURRENT_STEP=bootstrap
RUN_ID=""
PUBLIC_ORIGIN=""
TOOL_PACK_ID=""
TOOL_PACK_REVOKED=false

cleanup_approved_tool_pack() {
  local status
  local -a pack_values=()

  if [[ -z "$TOOL_PACK_ID" || "$TOOL_PACK_REVOKED" == "true" || -z "$RUN_ID" || -z "$PUBLIC_ORIGIN" ]]; then
    return 0
  fi
  if ! status="$(curl --silent --show-error \
      --output "$API_RESPONSE" \
      --write-out '%{http_code}' \
      --header "Origin: ${PUBLIC_ORIGIN}" \
      "${BASE_URL}/api/tool-packs")"; then
    printf 'Management smoke cleanup could not inspect Tool Pack %s.\n' "$TOOL_PACK_ID" >&2
    return 1
  fi
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Management smoke cleanup received HTTP %s while inspecting Tool Pack %s.\n' "$status" "$TOOL_PACK_ID" >&2
    return 1
  fi
  mapfile -t pack_values < <(python3 - "$API_RESPONSE" "$TOOL_PACK_ID" <<'PYTHON'
import json, sys

body = json.load(open(sys.argv[1], encoding="utf-8"))
pack = next((item for item in body.get("toolPacks", []) if item.get("id") == sys.argv[2]), None)
if pack is None:
    raise SystemExit("Synthetic Tool Pack is missing from the cleanup inventory.")
print(pack.get("status", ""))
print(pack.get("revision", ""))
PYTHON
  )
  if [[ "${#pack_values[@]}" -ne 2 ]]; then
    printf 'Management smoke cleanup could not read Tool Pack %s state.\n' "$TOOL_PACK_ID" >&2
    return 1
  fi
  if [[ "${pack_values[0]}" != "approved" ]]; then
    return 0
  fi
  python3 - "${pack_values[1]}" >"$PREFLIGHT" <<'PYTHON'
import json, sys

json.dump({
    "expectedRevision": int(sys.argv[1]),
    "reason": "Acceptance smoke cleanup after interrupted run.",
}, sys.stdout)
PYTHON
  if ! status="$(curl --silent --show-error \
      --output "$API_RESPONSE" \
      --write-out '%{http_code}' \
      --request POST \
      --header "Origin: ${PUBLIC_ORIGIN}" \
      --header 'content-type: application/json' \
      --header "idempotency-key: management-tool-pack-cleanup-${RUN_ID}" \
      --data-binary @"$PREFLIGHT" \
      "${BASE_URL}/api/tool-packs/${TOOL_PACK_ID}/revoke")"; then
    printf 'Management smoke cleanup could not revoke Tool Pack %s.\n' "$TOOL_PACK_ID" >&2
    return 1
  fi
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]] \
    || ! python3 - "$API_RESPONSE" <<'PYTHON'
import json, sys

assert json.load(open(sys.argv[1], encoding="utf-8"))["status"] == "revoked"
PYTHON
  then
    printf 'Management smoke cleanup failed to verify revocation for Tool Pack %s.\n' "$TOOL_PACK_ID" >&2
    return 1
  fi
  TOOL_PACK_REVOKED=true
  printf 'Management smoke cleanup revoked Tool Pack %s.\n' "$TOOL_PACK_ID" >&2
}

cleanup() {
  local exit_status=$?
  local cleanup_failed=false

  trap - EXIT
  if ! cleanup_approved_tool_pack; then
    cleanup_failed=true
  fi
  rm -f "$SNAPSHOT" "$PREFLIGHT" "$API_RESPONSE" "$COMPOSE_CONFIG" || true
  if [[ "$cleanup_failed" == "true" && "$exit_status" -eq 0 ]]; then
    exit_status=1
  fi
  exit "$exit_status"
}
trap cleanup EXIT

step() {
  CURRENT_STEP="$1"
  printf 'Management smoke: %s\n' "$CURRENT_STEP" >&2
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
  printf '%s\n' 'Management smoke requires the owner-approved temporary authentication bypass.' >&2
  exit 1
fi
test -n "$PUBLIC_ORIGIN"
RUN_ID="${RELEASE_VERSION}-$(date -u +%Y%m%dT%H%M%SZ)-$$"

api_get() {
  local status

  if ! status="$(curl --silent --show-error --output "$API_RESPONSE" --write-out '%{http_code}' "${BASE_URL}$1")"; then
    printf 'Management smoke transport failure at %s.\n' "$CURRENT_STEP" >&2
    return 1
  fi
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Management smoke HTTP %s at %s: ' "$status" "$CURRENT_STEP" >&2
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
    printf 'Management smoke transport failure at %s.\n' "$CURRENT_STEP" >&2
    return 1
  fi
  if [[ ! "$status" =~ ^2[0-9][0-9]$ ]]; then
    printf 'Management smoke HTTP %s at %s: ' "$status" "$CURRENT_STEP" >&2
    safe_response_excerpt >&2
    printf '\n' >&2
    return 1
  fi
  cat "$API_RESPONSE"
}

step 'load bootstrap dependencies'
api_get /api/bootstrap >"$SNAPSHOT"
read -r LOCAL_MODEL_ID MEMBER_ROLE_ID CHAIR_ROLE_ID < <(python3 - "$SNAPSHOT" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
models = [item for item in snapshot["modelConnectors"] if item["enabled"] and item["location"] == "local"]
roles = [item for item in snapshot["roles"] if not item.get("deletedAt")]
if not models:
    raise SystemExit("Management smoke requires one enabled local Model Connector.")
if len(roles) < 2:
    raise SystemExit("Management smoke requires at least two active Roles.")
chair = next((item for item in roles if item.get("templateKey") == "meeting_chair"), roles[0])
member = next(item for item in roles if item["id"] != chair["id"])
print(models[0]["id"], member["id"], chair["id"])
PYTHON
)

step 'create immutable Runtime Profile'
RUNTIME_PROFILE_RESPONSE="$(python3 - "$RUN_ID" "$LOCAL_MODEL_ID" <<'PYTHON' | api_body POST /api/runtime-profiles "management-runtime-profile-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Local text runtime {sys.argv[1]}",
    "harnessKind": "openai_compatible",
    "modelConnectorId": sys.argv[2],
    "sandboxProfileId": None,
    "policy": "text_only",
    "capabilities": ["text", "abort"],
    "timeoutMs": 90000,
    "maxConcurrency": 2,
    "enabled": True,
}, sys.stdout)
PYTHON
)"
read -r RUNTIME_PROFILE_ID RUNTIME_PROFILE_REVISION < <(
  python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["id"], value["revision"])' \
    <<<"$RUNTIME_PROFILE_RESPONSE"
)

step 'create deferred cloud Credential metadata'
CREDENTIAL_RESPONSE="$(python3 - "$RUN_ID" <<'PYTHON' | api_body POST /api/credentials "management-credential-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Deferred cloud key {sys.argv[1]}",
    "provider": "OpenAI",
    "kind": "api_key",
    "location": "cloud",
}, sys.stdout)
PYTHON
)"
CREDENTIAL_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$CREDENTIAL_RESPONSE")"

step 'create cloud Model Connector without a secret'
CLOUD_MODEL_RESPONSE="$(python3 - "$RUN_ID" "$CREDENTIAL_ID" <<'PYTHON' | api_body POST /api/model-connectors "management-cloud-model-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Cloud model awaiting key {sys.argv[1]}",
    "location": "cloud",
    "baseUrl": "https://api.openai.com/v1",
    "model": "cloud-key-deferred",
    "credentialId": sys.argv[2],
}, sys.stdout)
PYTHON
)"
read -r CLOUD_MODEL_ID CLOUD_MODEL_REVISION < <(
  python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["id"], value["revision"])' \
    <<<"$CLOUD_MODEL_RESPONSE"
)
python3 - "$CREDENTIAL_RESPONSE" "$CLOUD_MODEL_RESPONSE" <<'PYTHON'
import json, sys
credential = json.loads(sys.argv[1])
model = json.loads(sys.argv[2])
assert credential["hasSecret"] is False and credential["secretRevision"] == 0
assert model["credentialId"] == credential["id"]
assert model["hasSecret"] is False and model["secretRevision"] == 0
PYTHON
step 'disable deferred cloud Model Connector'
python3 - "$CLOUD_MODEL_REVISION" <<'PYTHON' \
  | api_body PATCH "/api/model-connectors/${CLOUD_MODEL_ID}" "management-cloud-disable-${RUN_ID}" >/dev/null
import json, sys
json.dump({"expectedRevision": int(sys.argv[1]), "enabled": False}, sys.stdout)
PYTHON

step 'create Prompt draft'
PROMPT_RESPONSE="$(python3 - "$RUN_ID" <<'PYTHON' | api_body POST /api/prompts "management-prompt-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Meeting brief {sys.argv[1]}",
    "kind": "meeting",
    "description": "Immutable Prompt binding for management-control-plane acceptance.",
    "owner": "Platform Owner",
    "content": "You are {{AGENT_NAME}}. Review {{MEETING_GOAL}} and return one evidence-backed recommendation.",
    "variables": ["AGENT_NAME", "MEETING_GOAL"],
}, sys.stdout)
PYTHON
)"
PROMPT_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$PROMPT_RESPONSE")"
step 'publish Prompt version 1'
printf '%s' '{"expectedCurrentVersion":1,"version":1}' \
  | api_body POST "/api/prompts/${PROMPT_ID}/publish" "management-prompt-publish-${RUN_ID}" >/dev/null
step 'preview published Prompt'
PREVIEW_RESPONSE="$(printf '%s' '{"version":1,"variables":{"AGENT_NAME":"Chair","MEETING_GOAL":"validate reusable meeting management"}}' \
  | api_body POST "/api/prompts/${PROMPT_ID}/preview" "management-prompt-preview-${RUN_ID}")"
python3 - "$PREVIEW_RESPONSE" <<'PYTHON'
import json, sys
preview = json.loads(sys.argv[1])
assert preview["version"] == 1
assert preview["content"] == "You are Chair. Review validate reusable meeting management and return one evidence-backed recommendation."
PYTHON

step 'register governed Tool Pack'
TOOL_PACK_RESPONSE="$(python3 - "$RUN_ID" <<'PYTHON' | api_body POST /api/tool-packs "management-tool-pack-${RUN_ID}"
import json, sys
image_digest = "sha256:" + "a" * 64
json.dump({
    "name": f"[Acceptance] Documentation tools {sys.argv[1]}",
    "version": "1.0.0",
    "description": "Read-only Tool Pack lifecycle acceptance.",
    "owner": "Platform Owner",
    "sourceReference": f"registry.example.com/council/acceptance-docs@{image_digest}",
    "imageDigest": image_digest,
    "tools": [{
        "name": "search",
        "kind": "command",
        "goal": "Search an immutable acceptance documentation image.",
        "access": "read_only",
        "argv": {"executable": "/opt/council/tool-pack/bin/entrypoint", "fixedArguments": ["search"]},
        "env": {"allowedNames": []},
        "stdin": {"mode": "none"},
    }],
}, sys.stdout)
PYTHON
)"
read -r TOOL_PACK_ID TOOL_PACK_REVISION TOOL_PACK_DIGEST < <(python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["id"], value["revision"], value["manifestDigest"])' <<<"$TOOL_PACK_RESPONSE")
step 'record Tool Pack validation'
TOOL_PACK_VALIDATED="$(python3 - "$TOOL_PACK_REVISION" "$TOOL_PACK_DIGEST" <<'PYTHON' | api_body POST "/api/tool-packs/${TOOL_PACK_ID}/validate" "management-tool-pack-validate-${RUN_ID}"
import json, sys
json.dump({
    "expectedRevision": int(sys.argv[1]),
    "manifestDigest": sys.argv[2],
    "result": "passed",
    "summary": "Digest pin, read-only declaration, and bounded manifest reviewed.",
}, sys.stdout)
PYTHON
)"
read -r TOOL_PACK_REVISION TOOL_PACK_DIGEST < <(python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["revision"], value["manifestDigest"])' <<<"$TOOL_PACK_VALIDATED")
step 'approve Tool Pack revision'
TOOL_PACK_APPROVED="$(python3 - "$TOOL_PACK_REVISION" "$TOOL_PACK_DIGEST" <<'PYTHON' | api_body POST "/api/tool-packs/${TOOL_PACK_ID}/approve" "management-tool-pack-approve-${RUN_ID}"
import json, sys
json.dump({"expectedRevision": int(sys.argv[1]), "manifestDigest": sys.argv[2]}, sys.stdout)
PYTHON
)"
read -r TOOL_PACK_REVISION TOOL_PACK_DIGEST < <(python3 -c 'import json,sys; value=json.load(sys.stdin); assert value["status"] == "approved"; print(value["revision"], value["manifestDigest"])' <<<"$TOOL_PACK_APPROVED")

step 'create reviewer Agent draft'
AGENT_A_RESPONSE="$(python3 - "$RUN_ID" "$LOCAL_MODEL_ID" "$PROMPT_ID" "$TOOL_PACK_ID" "$TOOL_PACK_REVISION" "$TOOL_PACK_DIGEST" "$RUNTIME_PROFILE_ID" "$RUNTIME_PROFILE_REVISION" <<'PYTHON' | api_body POST /api/agents "management-agent-a-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Reviewer {sys.argv[1]}",
    "description": "Reusable management-control-plane reviewer.",
    "modelConnectorId": sys.argv[2],
    "goalSummary": "Review the meeting goal and produce bounded recommendations.",
    "toolsSummary": "No external tools are required for this management smoke.",
    "dataSummary": "Only this acceptance meeting and its immutable snapshots.",
    "skillIds": [],
    "toolGrants": [],
    "toolPackGrants": [{
        "packId": sys.argv[4],
        "revision": int(sys.argv[5]),
        "manifestDigest": sys.argv[6],
        "toolName": "search",
    }],
    "promptBinding": {"promptId": sys.argv[3], "version": 1},
    "runtimeProfileBinding": {"profileId": sys.argv[7], "revision": int(sys.argv[8])},
}, sys.stdout)
PYTHON
)"
read -r AGENT_A_ID AGENT_A_REVISION < <(python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["id"], value["draftRevision"])' <<<"$AGENT_A_RESPONSE")
step 'publish reviewer Agent revision'
printf '{"expectedDraftRevision":%s}' "$AGENT_A_REVISION" \
  | api_body POST "/api/agents/${AGENT_A_ID}/publish" "management-agent-a-publish-${RUN_ID}" >/dev/null

step 'create chair Agent draft'
AGENT_B_RESPONSE="$(python3 - "$RUN_ID" "$LOCAL_MODEL_ID" "$PROMPT_ID" "$RUNTIME_PROFILE_ID" "$RUNTIME_PROFILE_REVISION" <<'PYTHON' | api_body POST /api/agents "management-agent-b-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Chair {sys.argv[1]}",
    "description": "Reusable management-control-plane chair.",
    "modelConnectorId": sys.argv[2],
    "goalSummary": "Keep agenda, time, and meeting decisions aligned.",
    "toolsSummary": "No external tools are required for this management smoke.",
    "dataSummary": "Only this acceptance meeting and its immutable snapshots.",
    "skillIds": [],
    "toolGrants": [],
    "promptBinding": {"promptId": sys.argv[3], "version": 1},
    "runtimeProfileBinding": {"profileId": sys.argv[4], "revision": int(sys.argv[5])},
}, sys.stdout)
PYTHON
)"
read -r AGENT_B_ID AGENT_B_REVISION < <(python3 -c 'import json,sys; value=json.load(sys.stdin); print(value["id"], value["draftRevision"])' <<<"$AGENT_B_RESPONSE")
step 'publish chair Agent revision'
printf '{"expectedDraftRevision":%s}' "$AGENT_B_REVISION" \
  | api_body POST "/api/agents/${AGENT_B_ID}/publish" "management-agent-b-publish-${RUN_ID}" >/dev/null

step 'verify published Agent readiness'
for agent_id in "$AGENT_A_ID" "$AGENT_B_ID"; do
  READINESS="$(api_get "/api/agents/${agent_id}/readiness")"
  python3 - "$READINESS" <<'PYTHON'
import json, sys
readiness = json.loads(sys.argv[1])
assert readiness["status"] == "ready"
assert all(item["status"] != "blocked" for item in readiness["checks"])
PYTHON
done

step 'create reusable Agent Team'
TEAM_RESPONSE="$(python3 - "$RUN_ID" "$AGENT_A_ID" "$MEMBER_ROLE_ID" "$AGENT_B_ID" "$CHAIR_ROLE_ID" <<'PYTHON' | api_body POST /api/agent-teams "management-team-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Governance team {sys.argv[1]}",
    "description": "Reusable two-Agent roster with one immutable chair assignment.",
    "members": [
        {"agentId": sys.argv[2], "roleId": sys.argv[3], "isChair": False},
        {"agentId": sys.argv[4], "roleId": sys.argv[5], "isChair": True},
    ],
}, sys.stdout)
PYTHON
)"
TEAM_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$TEAM_RESPONSE")"

step 'create reusable Meeting Preset'
PRESET_RESPONSE="$(python3 - "$RUN_ID" "$TEAM_ID" <<'PYTHON' | api_body POST /api/meeting-presets "management-preset-${RUN_ID}"
import json, sys
json.dump({
    "name": f"[Acceptance] Architecture review {sys.argv[1]}",
    "description": "Reusable agenda, roster, mode, duration, and chair automation policy.",
    "teamId": sys.argv[2],
    "mode": "chaired",
    "automation": "auto",
    "durationMinutes": 30,
    "agendaItems": [
        {"title": "Review management evidence", "description": "Confirm versions, bindings, and readiness."},
        {"title": "Record bounded action", "description": "Keep the fixed discussion to decision to task flow."},
    ],
}, sys.stdout)
PYTHON
)"
PRESET_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$PRESET_RESPONSE")"
step 'run Meeting Preset preflight'
api_get "/api/meeting-presets/${PRESET_ID}/preflight" >"$PREFLIGHT"
python3 - "$PREFLIGHT" "$TEAM_ID" "$AGENT_A_ID" "$AGENT_B_ID" <<'PYTHON'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
assert value["status"] == "ready"
assert value["team"]["id"] == sys.argv[2]
assert {item["agentId"] for item in value["agents"]} == {sys.argv[3], sys.argv[4]}
assert all(item["agentRevision"] == 1 and item["readiness"]["status"] == "ready" for item in value["agents"])
PYTHON

step 'create discussion Group'
GROUP_RESPONSE="$(python3 - "$RUN_ID" <<'PYTHON' | api_body POST /api/groups "management-group-${RUN_ID}"
import json, sys
json.dump({"name": f"[Acceptance] Agent management {sys.argv[1]}"}, sys.stdout)
PYTHON
)"
GROUP_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$GROUP_RESPONSE")"
step 'create discussion Category'
CATEGORY_RESPONSE="$(python3 - "$GROUP_ID" <<'PYTHON' | api_body POST /api/categories "management-category-${RUN_ID}"
import json, sys
json.dump({"groupId": sys.argv[1], "name": "Reusable meetings"}, sys.stdout)
PYTHON
)"
CATEGORY_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$CATEGORY_RESPONSE")"
step 'create discussion Topic'
THREAD_RESPONSE="$(python3 - "$CATEGORY_ID" "$RUN_ID" <<'PYTHON' | api_body POST /api/threads "management-topic-${RUN_ID}"
import json, sys
json.dump({
    "categoryId": sys.argv[1],
    "title": f"[Acceptance] Managed multi-Agent meeting {sys.argv[2]}",
    "summary": "Verify Team and Preset reuse without a cloud key.",
    "tagIds": [],
}, sys.stdout)
PYTHON
)"
THREAD_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$THREAD_RESPONSE")"

step 'create Meeting from Team and Preset snapshots'
MEETING_RESPONSE="$(python3 - "$PREFLIGHT" "$THREAD_ID" "$RUN_ID" "$TEAM_ID" "$PRESET_ID" <<'PYTHON' | api_body POST /api/meetings "management-meeting-${RUN_ID}"
import json, sys
preflight = json.load(open(sys.argv[1], encoding="utf-8"))
json.dump({
    "threadId": sys.argv[2],
    "title": f"[Acceptance] Managed meeting {sys.argv[3]}",
    "goal": "Confirm reusable multi-Agent management and immutable execution bindings.",
    "mode": "chaired",
    "automation": "auto",
    "durationMinutes": 30,
    "sourceTeamId": sys.argv[4],
    "sourcePresetId": sys.argv[5],
    "participants": [{
        "agentId": item["agentId"],
        "roleId": item["roleId"],
        "isChair": item["isChair"],
        "agentRevision": item["agentRevision"],
    } for item in preflight["agents"]],
    "agendaItems": [
        {"title": "Review management evidence", "description": "Confirm versions, bindings, and readiness."},
        {"title": "Record bounded action", "description": "Keep the fixed discussion to decision to task flow."},
    ],
}, sys.stdout)
PYTHON
)"
MEETING_ID="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$MEETING_RESPONSE")"
step 'start Meeting'
printf '{}' | api_body POST "/api/meetings/${MEETING_ID}/start" "management-meeting-start-${RUN_ID}" >/dev/null
step 'verify immutable Meeting and Agent snapshots'
api_get /api/bootstrap >"$SNAPSHOT"

EFFECTIVE_A="$(api_get "/api/agents/${AGENT_A_ID}/effective-configuration")"
EFFECTIVE_B="$(api_get "/api/agents/${AGENT_B_ID}/effective-configuration")"
python3 - "$SNAPSHOT" "$MEETING_ID" "$THREAD_ID" "$TEAM_ID" "$PRESET_ID" "$PROMPT_ID" "$LOCAL_MODEL_ID" "$AGENT_A_ID" "$AGENT_B_ID" "$EFFECTIVE_A" "$EFFECTIVE_B" "$TOOL_PACK_ID" "$TOOL_PACK_REVISION" "$TOOL_PACK_DIGEST" "$RUNTIME_PROFILE_ID" "$RUNTIME_PROFILE_REVISION" <<'PYTHON'
import json, sys
snapshot = json.load(open(sys.argv[1], encoding="utf-8"))
meeting = next(item for item in snapshot["meetings"] if item["id"] == sys.argv[2])
assert meeting["threadId"] == sys.argv[3] and meeting["state"] == "active"
assert meeting["sourceTeamId"] == sys.argv[4] and meeting["sourcePresetId"] == sys.argv[5]
participants = [item for item in snapshot["participants"] if item["meetingId"] == meeting["id"]]
assert len(participants) == 2 and sum(1 for item in participants if item["isChair"]) == 1
assert all(item["agentRevision"] == 1 and item["roleSnapshot"]["version"] >= 1 for item in participants)
for raw, agent_id in [(sys.argv[10], sys.argv[8]), (sys.argv[11], sys.argv[9])]:
    effective = json.loads(raw)
    assert effective["agent"]["id"] == agent_id and effective["agent"]["publishedRevision"] == 1
    assert effective["model"]["id"] == sys.argv[7]
    assert effective["prompt"]["id"] == sys.argv[6] and effective["prompt"]["version"] == 1
    runtime = effective["runtimeProfile"]
    expected_revision = int(sys.argv[16])
    assert runtime["binding"] == {"profileId": sys.argv[15], "revision": expected_revision}
    assert runtime["current"]["id"] == sys.argv[15] and runtime["current"]["revision"] == expected_revision
    assert runtime["revision"]["profileId"] == sys.argv[15] and runtime["revision"]["revision"] == expected_revision
    assert runtime["snapshot"]["profileId"] == sys.argv[15] and runtime["snapshot"]["revision"] == expected_revision
    assert effective["readiness"]["status"] == "ready"
    assert any(item["id"] == sys.argv[4] for item in effective["teams"])
reviewer = json.loads(sys.argv[10])
assert len(reviewer["toolPacks"]) == 1
assert reviewer["toolPacks"][0]["grant"] == {
    "packId": sys.argv[12],
    "revision": int(sys.argv[13]),
    "manifestDigest": sys.argv[14],
    "toolName": "search",
}
PYTHON

step 'close Meeting and archive acceptance Topic'
printf '{}' | api_body POST "/api/meetings/${MEETING_ID}/close" "management-meeting-close-${RUN_ID}" >/dev/null
printf '%s' '{"status":"archived"}' | api_body PATCH "/api/threads/${THREAD_ID}" "management-topic-archive-${RUN_ID}" >/dev/null

step 'revoke Tool Pack and verify existing Agent grant is blocked'
TOOL_PACK_REVOKE_RESPONSE="$(python3 - "$TOOL_PACK_REVISION" <<'PYTHON' | api_body POST "/api/tool-packs/${TOOL_PACK_ID}/revoke" "management-tool-pack-revoke-${RUN_ID}"
import json, sys
json.dump({"expectedRevision": int(sys.argv[1]), "reason": "Acceptance lifecycle completed."}, sys.stdout)
PYTHON
)"
python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "revoked"' <<<"$TOOL_PACK_REVOKE_RESPONSE"
TOOL_PACK_REVOKED=true
REVOKED_READINESS="$(api_get "/api/agents/${AGENT_A_ID}/readiness")"
python3 - "$REVOKED_READINESS" <<'PYTHON'
import json, sys
readiness = json.loads(sys.argv[1])
assert readiness["status"] == "blocked"
assert any(item["code"] == "tool" and item["status"] == "blocked" for item in readiness["checks"])
PYTHON

printf 'Management control-plane smoke passed credential=%s prompt=%s runtime_profile=%s tool_pack=%s team=%s preset=%s meeting=%s\n' \
  "$CREDENTIAL_ID" "$PROMPT_ID" "$RUNTIME_PROFILE_ID" "$TOOL_PACK_ID" "$TEAM_ID" "$PRESET_ID" "$MEETING_ID"
REMOTE
