#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROLLBACK_SCRIPT="${SCRIPT_DIR}/rollback-remote.sh"
TEMP_ROOT="$(mktemp -d)"
POLICY_FILE="${TEMP_ROOT}/goal-run-rollback-policy.sh"
trap 'rm -rf "$TEMP_ROOT"' EXIT

awk '
  /^# GOAL_RUN_ROLLBACK_PREFLIGHT_POLICY_BEGIN$/ { capture=1; next }
  /^# GOAL_RUN_ROLLBACK_PREFLIGHT_POLICY_END$/ { capture=0 }
  capture
' "$ROLLBACK_SCRIPT" >"$POLICY_FILE"
source "$POLICY_FILE"

goal_run_status=1
binding_status=1
admission_status=1
queue_status=1

source_database_contains_unsafe_goal_run() {
  return "$goal_run_status"
}

source_database_contains_active_goal_task_binding() {
  return "$binding_status"
}

source_database_contains_nonsettled_goal_job_admission() {
  return "$admission_status"
}

source_queue_contains_active_goal_work() {
  return "$queue_status"
}

assert_blocked() {
  local label="$1"

  if assert_goal_run_rollback_safe; then
    printf 'Goal Run rollback preflight allowed active %s.\n' "$label" >&2
    exit 1
  fi
}

assert_goal_run_rollback_safe

goal_run_status=0
assert_blocked unsafe-goal-run
goal_run_status=1

binding_status=0
assert_blocked active-goal-task-binding
binding_status=1

admission_status=0
assert_blocked nonsettled-goal-job-admission
admission_status=1

queue_status=0
assert_blocked queued-or-in-flight-goal-work
queue_status=1

goal_run_status=2
assert_blocked unverifiable-goal-run-state
goal_run_status=1

binding_status=2
assert_blocked unverifiable-goal-task-binding-state
binding_status=1

admission_status=2
assert_blocked unverifiable-goal-job-admission-state
admission_status=1

queue_status=2
assert_blocked unverifiable-goal-queue-state

writer_stop_line="$(awk '$0 == "source_compose stop api worker" { line=NR } END { print line }' "$ROLLBACK_SCRIPT")"
preflight_line="$(awk '$0 == "assert_goal_run_rollback_safe" { print NR; exit }' "$ROLLBACK_SCRIPT")"
cutover_line="$(awk '$0 == "source_compose down --remove-orphans" { print NR; exit }' "$ROLLBACK_SCRIPT")"
if [[ -z "$writer_stop_line" || -z "$preflight_line" || -z "$cutover_line" \
  || "$writer_stop_line" -ge "$preflight_line" || "$preflight_line" -ge "$cutover_line" ]]; then
  printf '%s\n' 'Goal Run rollback preflight must run after writers stop and before rollback cutover.' >&2
  exit 1
fi

grep -Fq "SELECT to_regclass('public.goal_runs') IS NOT NULL;" "$ROLLBACK_SCRIPT"
grep -Fq "FROM goal_runs WHERE state NOT IN ('paused', 'completed', 'failed', 'cancelled')" "$ROLLBACK_SCRIPT"
grep -Fq "SELECT to_regclass('public.goal_task_bindings') IS NOT NULL;" "$ROLLBACK_SCRIPT"
grep -Fq "FROM goal_task_bindings WHERE state IN ('running', 'reviewing') OR active_job_id IS NOT NULL" "$ROLLBACK_SCRIPT"
grep -Fq "SELECT to_regclass('public.goal_job_admissions') IS NOT NULL;" "$ROLLBACK_SCRIPT"
grep -Fq "FROM goal_job_admissions WHERE state <> 'settled'" "$ROLLBACK_SCRIPT"
grep -Fq "'bull:council-background-jobs'" "$ROLLBACK_SCRIPT"
grep -Fq 'string.sub(name, 1, 5) == "goal-"' "$ROLLBACK_SCRIPT"

printf '%s\n' 'Goal Run rollback preflight policy tests passed'
