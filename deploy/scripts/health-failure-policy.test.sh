#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/health-failure-policy.sh"

assert_allowed() {
  local label="$1"
  local output="$2"
  local allow_platform_repair="$3"
  local allow_reboot_required="$4"
  if ! health_failures_are_allowed "$output" "$allow_platform_repair" "$allow_reboot_required"; then
    printf 'Expected policy to allow: %s\n' "$label" >&2
    exit 1
  fi
}

assert_rejected() {
  local label="$1"
  local output="$2"
  local allow_platform_repair="$3"
  local allow_reboot_required="$4"
  if health_failures_are_allowed "$output" "$allow_platform_repair" "$allow_reboot_required"; then
    printf 'Expected policy to reject: %s\n' "$label" >&2
    exit 1
  fi
}

reboot_failure=$'PASS systemd_failed_units=0\nFAIL reboot_required=yes\nhealth_result=fail failures=1'
platform_failure=$'FAIL docker_bad_containers_present\nhealth_result=fail failures=1'
combined_failure=$'FAIL docker_bad_containers_present\nFAIL reboot_required=yes\nhealth_result=fail failures=2'
foreign_failure=$'FAIL systemd_failed_units expected=0 actual=1\nhealth_result=fail failures=1'

assert_rejected "strict reboot" "$reboot_failure" false false
assert_allowed "explicit reboot waiver" "$reboot_failure" false true
assert_rejected "platform waiver cannot accept reboot" "$reboot_failure" true false
assert_allowed "bounded platform repair" "$platform_failure" true false
assert_rejected "reboot waiver cannot accept platform failure" "$platform_failure" false true
assert_allowed "two explicitly bounded failures" "$combined_failure" true true
assert_rejected "unknown failure remains closed" "$foreign_failure" true true
assert_rejected "nonzero health without a failure receipt" "health_result=fail failures=1" true true

health_output_has_failure "$combined_failure" 'FAIL reboot_required=yes'
health_output_has_failure "$combined_failure" 'FAIL docker_bad_containers_present'

printf '%s\n' 'health failure policy tests passed'
