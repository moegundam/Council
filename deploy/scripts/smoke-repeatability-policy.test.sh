#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts=(
  "${SCRIPT_DIR}/smoke-task-agent-run-remote.sh"
  "${SCRIPT_DIR}/smoke-task-work-item-remote.sh"
)

fail() {
  printf 'smoke repeatability policy failed: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local text="$2"
  grep -Fq -- "$text" "$file" || fail "$(basename "$file") is missing: ${text}"
}

assert_not_contains() {
  local file="$1"
  local text="$2"
  if grep -Fq -- "$text" "$file"; then
    fail "$(basename "$file") still contains reusable-record logic: ${text}"
  fi
}

for script in "${scripts[@]}"; do
  [[ -x "$script" ]] || fail "$(basename "$script") is not executable"

  dry_output="$(SSH_KEY=/definitely/missing bash "$script")"
  [[ "$dry_output" == *"Dry run only"* ]] || fail "$(basename "$script") does not default to a no-SSH dry run"

  set +e
  mutating_output="$(SSH_KEY=/definitely/missing bash "$script" --run 2>&1)"
  mutating_status=$?
  set -e
  [[ "$mutating_status" -eq 2 ]] || fail "$(basename "$script") did not fail closed without a disposable target"
  [[ "$mutating_output" == *'requires --target disposable or --target isolated'* ]] \
    || fail "$(basename "$script") did not explain its fail-closed target gate"
  assert_contains "$script" 'smoke_require_mutating_acceptance'
  assert_contains "$script" '--target'

  assert_contains "$script" 'RUN_STARTED_AT='
  assert_contains "$script" 'uuid.uuid4().hex'
  assert_contains "$script" 'RUN_ID="${RELEASE_VERSION}-'
  assert_contains "$script" 'SMOKE_TITLE='
  assert_contains "$script" '${RUN_ID}'
  assert_contains "$script" 'idempotency-key:'
  assert_contains "$script" 'createdAt'
  assert_contains "$script" 'RUN_STARTED_AT'
  assert_contains "$script" 'api_body POST /api/decisions'
  assert_contains "$script" '${BASE_URL}/api/tasks'

  assert_not_contains "$script" 'if [[ -z "$TASK_ID" ]]'
  assert_not_contains "$script" 'snapshot["tasks"] if item["title"]'
  assert_not_contains "$script" 'print(task["id"] if task else "")'
done

assert_contains "${scripts[0]}" 'resultEvidenceId'
assert_contains "${scripts[0]}" 'requestedAt'
assert_contains "${scripts[0]}" 'completedAt'
assert_contains "${scripts[1]}" 'EVIDENCE_ID'
assert_contains "${scripts[1]}" 'task["evidence"]'
assert_contains "${scripts[1]}" 'assert len(matches) == 1'
assert_contains "${scripts[1]}" 'syncedAt'
assert_contains "${scripts[1]}" 'externalId'
assert_not_contains "${scripts[1]}" 'EVIDENCE_ID="$(python3 -c'

printf '%s\n' 'smoke repeatability policy tests passed'
