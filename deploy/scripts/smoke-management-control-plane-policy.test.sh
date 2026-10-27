#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/smoke-management-control-plane-remote.sh"

bash -n "$SCRIPT"

set +e
output="$(bash "$SCRIPT" 2>&1)"
status=$?
set -e
if [[ "$status" -ne 2 || "$output" != *'Usage: smoke-management-control-plane-remote.sh --run'* ]]; then
  printf 'Management smoke did not fail closed without --run:\n%s\n' "$output" >&2
  exit 1
fi

for required in \
  '/api/credentials' \
  '"hasSecret"] is False' \
  '/api/prompts' \
  '/preview' \
  '/api/tool-packs' \
    '/validate' \
    '/approve' \
    'cleanup_approved_tool_pack' \
    'Acceptance smoke cleanup after interrupted run.' \
    'TOOL_PACK_REVOKED=true' \
    'toolPackGrants' \
  '/revoke' \
  '"code"] == "tool"' \
  '/api/runtime-profiles' \
  'runtimeProfileBinding' \
  'runtimeProfile' \
  'CLOUD_MODEL_REVISION' \
  '"expectedRevision": int(sys.argv[1])' \
  '/api/agents' \
  '/publish' \
  '/api/agent-teams' \
  '/api/meeting-presets' \
  '/preflight' \
  'sourceTeamId' \
  'sourcePresetId' \
  '/effective-configuration' \
  '"status"] == "ready"' \
  'safe_response_excerpt >&2' \
  '"status":"archived"'; do
  if ! grep -Fq "$required" "$SCRIPT"; then
    printf 'Management smoke is missing required proof: %s\n' "$required" >&2
    exit 1
  fi
done

if grep -Fq 'cat "$API_RESPONSE" >&2' "$SCRIPT" || grep -Fq 'head -c' "$SCRIPT"; then
  printf '%s\n' 'Management smoke must not log an unfiltered API response body.' >&2
  exit 1
fi

cleanup_line="$(grep -n '^cleanup_approved_tool_pack()' "$SCRIPT" | cut -d: -f1)"
trap_line="$(grep -n '^trap cleanup EXIT$' "$SCRIPT" | cut -d: -f1)"
approval_line="$(grep -n "step 'approve Tool Pack revision'" "$SCRIPT" | cut -d: -f1)"
if [[ -z "$cleanup_line" || -z "$trap_line" || -z "$approval_line" \
  || "$cleanup_line" -ge "$approval_line" || "$trap_line" -ge "$approval_line" ]]; then
  printf '%s\n' 'Management smoke must register Tool Pack cleanup before approval.' >&2
  exit 1
fi

if grep -Eq '"secret"[[:space:]]*:' "$SCRIPT"; then
  printf '%s\n' 'Management smoke must not submit a cloud secret.' >&2
  exit 1
fi

printf '%s\n' 'management control-plane smoke policy tests passed'
