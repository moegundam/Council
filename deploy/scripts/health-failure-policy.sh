#!/usr/bin/env bash

health_output_has_failure() {
  local health_output="$1"
  local failure="$2"
  printf '%s\n' "$health_output" | grep -Fxq -- "$failure"
}

health_failures_are_allowed() {
  local health_output="$1"
  local allow_platform_repair="$2"
  local allow_reboot_required="$3"
  local failures
  local failure

  failures="$(printf '%s\n' "$health_output" | grep '^FAIL ' || true)"
  [[ -n "$failures" ]] || return 1

  while IFS= read -r failure; do
    case "$failure" in
      'FAIL docker_bad_containers_present')
        [[ "$allow_platform_repair" == "true" ]] || return 1
        ;;
      'FAIL reboot_required=yes')
        [[ "$allow_reboot_required" == "true" ]] || return 1
        ;;
      *)
        return 1
        ;;
    esac
  done <<<"$failures"
}
