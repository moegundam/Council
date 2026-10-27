#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-remote.sh"
ROLLBACK_SCRIPT="${SCRIPT_DIR}/rollback-remote.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

extract_policy() {
  local script="$1"
  local begin_marker="$2"
  local end_marker="$3"
  local destination="$4"

  awk -v begin_marker="$begin_marker" -v end_marker="$end_marker" '
    $0 == begin_marker { capture=1; next }
    $0 == end_marker { capture=0 }
    capture
  ' "$script" >"$destination"
}

line_number() {
  local script="$1"
  local needle="$2"
  awk -v needle="$needle" 'index($0, needle) { print NR; exit }' "$script"
}

exact_line_number() {
  local script="$1"
  local needle="$2"
  awk -v needle="$needle" '$0 == needle { print NR; exit }' "$script"
}

assert_before() {
  local script="$1"
  local first="$2"
  local second="$3"
  local label="$4"
  local first_line second_line

  first_line="$(line_number "$script" "$first")"
  second_line="$(line_number "$script" "$second")"
  if [[ -z "$first_line" || -z "$second_line" || "$first_line" -ge "$second_line" ]]; then
    printf '%s must occur before %s in %s.\n' "$label" "$second" "$script" >&2
    exit 1
  fi
}

assert_exact_before() {
  local script="$1"
  local first="$2"
  local second="$3"
  local label="$4"
  local first_line second_line

  first_line="$(exact_line_number "$script" "$first")"
  second_line="$(exact_line_number "$script" "$second")"
  if [[ -z "$first_line" || -z "$second_line" || "$first_line" -ge "$second_line" ]]; then
    printf '%s must occur before %s in %s.\n' "$label" "$second" "$script" >&2
    exit 1
  fi
}

write_serve_fixture() {
  local destination="$1"
  local dns_name="$2"
  local target="${3:-}"

  python3 - "$destination" "$dns_name" "$target" <<'PYTHON'
import json
import sys

destination, dns_name, target = sys.argv[1:]
config = {"TCP": {}, "Web": {}}
if target:
    config["TCP"]["8444"] = {"HTTPS": True}
    config["Web"][f"{dns_name}:8444"] = {
        "Handlers": {"/": {"Proxy": target}}
    }
with open(destination, "w", encoding="utf-8") as output:
    json.dump(config, output)
PYTHON
}

exercise_preflight_policy() {
  local script="$1"
  local prefix="$2"
  local policy_file="${TEMP_ROOT}/${prefix}-preflight.sh"
  local dns_name=council-host.example.ts.net
  local fixture="${TEMP_ROOT}/${prefix}-serve.json"

  extract_policy "$script" \
    '# TAILSCALE_SERVE_PREFLIGHT_POLICY_BEGIN' \
    '# TAILSCALE_SERVE_PREFLIGHT_POLICY_END' \
    "$policy_file"
  grep -Fq 'assert_required_platform_serve()' "$policy_file"
  # shellcheck disable=SC1090
  source "$policy_file"

  write_serve_fixture "$fixture" "$dns_name" 'http://127.0.0.1:8787'
  assert_required_platform_serve "$fixture" "$dns_name"

  write_serve_fixture "$fixture" "$dns_name"
  if assert_required_platform_serve "$fixture" "$dns_name" >/dev/null 2>&1; then
    printf '%s preflight accepted a missing 8444 rule.\n' "$prefix" >&2
    exit 1
  fi

  write_serve_fixture "$fixture" "$dns_name" 'http://127.0.0.1:9999'
  if assert_required_platform_serve "$fixture" "$dns_name" >/dev/null 2>&1; then
    printf '%s preflight accepted the wrong 8444 target.\n' "$prefix" >&2
    exit 1
  fi
}

exercise_matcher_policy() {
  local script="$1"
  local prefix="$2"
  local baseline_variable="$3"
  local policy_file="${TEMP_ROOT}/${prefix}-matcher.sh"
  local dns_name=council-host.example.ts.net
  local baseline="${TEMP_ROOT}/${prefix}-baseline.json"
  local current="${TEMP_ROOT}/${prefix}-current.json"
  local status_file="${TEMP_ROOT}/${prefix}-status.txt"
  local captured_json="${TEMP_ROOT}/${prefix}-captured.json"

  extract_policy "$script" \
    '# TAILSCALE_SERVE_MATCHER_POLICY_BEGIN' \
    '# TAILSCALE_SERVE_MATCHER_POLICY_END' \
    "$policy_file"
  grep -Fq 'serve_matches_expected()' "$policy_file"
  # shellcheck disable=SC1090
  source "$policy_file"

  write_serve_fixture "$baseline" "$dns_name" 'http://127.0.0.1:8787'
  write_serve_fixture "$current" "$dns_name" 'http://127.0.0.1:8787'
  printf -v "$baseline_variable" '%s' "$baseline"
  TAILSCALE_DNS="$dns_name"
  TAILSCALE_STATUS=(fake_tailscale)
  fake_config="$current"
  fake_status_result=0
  fake_json_result=0
  fake_status_target=http://127.0.0.1:8787
  fake_tailscale() {
    if [[ "$1" == serve && "$2" == status && "${3:-}" == --json ]]; then
      [[ "$fake_json_result" -eq 0 ]] || return "$fake_json_result"
      cat "$fake_config"
      return
    fi
    if [[ "$1" == serve && "$2" == status && $# -eq 2 ]]; then
      [[ "$fake_status_result" -eq 0 ]] || return "$fake_status_result"
      printf 'https://%s:8444\n|-- proxy %s\n' "$TAILSCALE_DNS" "$fake_status_target"
      return
    fi
    return 64
  }

  serve_matches_expected "$status_file" "$captured_json" 'http://127.0.0.1:8787'

  write_serve_fixture "$current" "$dns_name" 'http://127.0.0.1:9999'
  if serve_matches_expected "$status_file" "$captured_json" 'http://127.0.0.1:8787' >/dev/null 2>&1; then
    printf '%s matcher accepted a changed proxy target.\n' "$prefix" >&2
    exit 1
  fi

  write_serve_fixture "$current" "$dns_name" 'http://127.0.0.1:8787'
  python3 - "$current" <<'PYTHON'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    config = json.load(source)
config["TCP"]["8444"]["unexpected"] = True
with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(config, output)
PYTHON
  if serve_matches_expected "$status_file" "$captured_json" 'http://127.0.0.1:8787' >/dev/null 2>&1; then
    printf '%s matcher accepted snapshot drift with the same target.\n' "$prefix" >&2
    exit 1
  fi

  write_serve_fixture "$current" "$dns_name" 'http://127.0.0.1:8787'
  fake_status_target=http://127.0.0.1:9999
  if serve_matches_expected "$status_file" "$captured_json" 'http://127.0.0.1:8787' >/dev/null 2>&1; then
    printf '%s matcher accepted status text that disagreed with JSON.\n' "$prefix" >&2
    exit 1
  fi
  fake_status_target=http://127.0.0.1:8787

  fake_status_result=41
  if serve_matches_expected "$status_file" "$captured_json" 'http://127.0.0.1:8787' >/dev/null 2>&1; then
    printf '%s matcher accepted a failed status command.\n' "$prefix" >&2
    exit 1
  fi
  fake_status_result=0
  fake_json_result=42
  if serve_matches_expected "$status_file" "$captured_json" 'http://127.0.0.1:8787' >/dev/null 2>&1; then
    printf '%s matcher accepted a failed JSON capture.\n' "$prefix" >&2
    exit 1
  fi
}

exercise_restore_policy() {
  local script="$1"
  local prefix="$2"
  local begin_marker="$3"
  local end_marker="$4"
  local restore_function="$5"
  local policy_file="${TEMP_ROOT}/${prefix}-restore.sh"

  extract_policy "$script" "$begin_marker" "$end_marker" "$policy_file"
  grep -Fq "${restore_function}()" "$policy_file"
  # shellcheck disable=SC1090
  source "$policy_file"

  events=()
  serve_result=0
  stable_result=0
  serve_matches_expected() {
    events+=("verify:$3")
    return "$serve_result"
  }
  curl() {
    events+=(curl)
  }
  containers_stably_absent() {
    events+=(stable)
    return "$stable_result"
  }
  project_running_container_ids() { return 0; }

  BACKUP_ROOT="$TEMP_ROOT"
  TAILSCALE_DNS=council-host.example.ts.net
  previous_serve_target=http://127.0.0.1:8787
  source_serve_target=http://127.0.0.1:8787
  had_previous_config=true

  "$restore_function"
  if [[ "$(IFS=,; printf '%s' "${events[*]}")" != 'verify:http://127.0.0.1:8787,curl' ]]; then
    printf '%s restore did not perform verify-then-health.\n' "$prefix" >&2
    exit 1
  fi

  events=()
  serve_result=1
  if "$restore_function"; then
    printf '%s restore accepted Serve drift.\n' "$prefix" >&2
    exit 1
  fi
  if [[ "$(IFS=,; printf '%s' "${events[*]}")" != 'verify:http://127.0.0.1:8787' ]]; then
    printf '%s restore attempted work after Serve verification failed.\n' "$prefix" >&2
    exit 1
  fi

  if [[ "$prefix" == deploy ]]; then
    events=()
    serve_result=0
    had_previous_config=false
    "$restore_function"
    if [[ "$(IFS=,; printf '%s' "${events[*]}")" != 'verify:http://127.0.0.1:8787,stable' ]]; then
      printf '%s first-install restore did not verify Serve plus stable container absence.\n' "$prefix" >&2
      exit 1
    fi
  fi
}

exercise_preflight_policy "$DEPLOY_SCRIPT" deploy
exercise_preflight_policy "$ROLLBACK_SCRIPT" rollback
exercise_matcher_policy "$DEPLOY_SCRIPT" deploy PRIOR_SERVE_CONFIG
exercise_matcher_policy "$ROLLBACK_SCRIPT" rollback SOURCE_SERVE_CONFIG
exercise_restore_policy "$DEPLOY_SCRIPT" deploy \
  '# TAILSCALE_SERVE_RECOVERY_POLICY_BEGIN' \
  '# TAILSCALE_SERVE_RECOVERY_POLICY_END' \
  restore_previous_serve
exercise_restore_policy "$ROLLBACK_SCRIPT" rollback \
  '# TAILSCALE_SERVE_ROLLBACK_RECOVERY_POLICY_BEGIN' \
  '# TAILSCALE_SERVE_ROLLBACK_RECOVERY_POLICY_END' \
  restore_source_serve

for script in "$DEPLOY_SCRIPT" "$ROLLBACK_SCRIPT"; do
  if grep -Eq 'TAILSCALE_MUTATE|serve_mutation_authorized|tailscale debug prefs|serve --bg|serve --https=8444 off' "$script"; then
    printf 'Release lifecycle must not mutate Tailscale Serve: %s\n' "$script" >&2
    exit 1
  fi
done

assert_before "$DEPLOY_SCRIPT" \
  '# TAILSCALE_SERVE_PRESTAGE_GATE_BEGIN' \
  'remote_ssh "mkdir -p' \
  'Deployment pre-transfer Serve gate'
assert_before "$DEPLOY_SCRIPT" \
  '# TAILSCALE_SERVE_PRESTAGE_GATE_BEGIN' \
  'remote_rsync "$BUNDLE"' \
  'Deployment pre-transfer Serve gate'

assert_before "$DEPLOY_SCRIPT" \
  'assert_required_platform_serve "$SERVE_PREFLIGHT_CONFIG" "$TAILSCALE_DNS"' \
  'if [[ -e "$RELEASE_ROOT" || -e "$BACKUP_ROOT" ]]' \
  'Deployment Serve precondition'
assert_before "$DEPLOY_SCRIPT" \
  'assert_required_platform_serve "$SERVE_PREFLIGHT_CONFIG" "$TAILSCALE_DNS"' \
  'for generated_secret in postgres_password app_master_key task_adapter_token' \
  'Deployment Serve precondition'
assert_before "$ROLLBACK_SCRIPT" \
  'assert_required_platform_serve "$SERVE_CONFIG" "$TAILSCALE_DNS"' \
  'ROLLBACK_POINT="$(mktemp -d' \
  'Rollback Serve precondition'

grep -Fq 'serve_matches_expected "$PRE_CUTOVER_SERVE_STATUS" "$PRE_CUTOVER_SERVE_JSON" "$previous_serve_target"' "$DEPLOY_SCRIPT"
grep -Fq 'serve_matches_expected "$PRE_CUTOVER_SERVE_STATUS" "$PRE_CUTOVER_SERVE_JSON" "$source_serve_target"' "$ROLLBACK_SCRIPT"
assert_exact_before "$DEPLOY_SCRIPT" \
  'if ! serve_matches_expected "$PRE_CUTOVER_SERVE_STATUS" "$PRE_CUTOVER_SERVE_JSON" "$previous_serve_target"; then' \
  'recovery_required=true' \
  'Deployment pre-cutover Serve check'
assert_exact_before "$DEPLOY_SCRIPT" \
  'recovery_required=true' \
  '  previous_compose stop api worker' \
  'Deployment recovery activation'
assert_exact_before "$ROLLBACK_SCRIPT" \
  'if ! serve_matches_expected "$PRE_CUTOVER_SERVE_STATUS" "$PRE_CUTOVER_SERVE_JSON" "$source_serve_target"; then' \
  'recovery_required=true' \
  'Rollback pre-cutover Serve check'
assert_exact_before "$ROLLBACK_SCRIPT" \
  'recovery_required=true' \
  'source_compose stop api worker' \
  'Rollback recovery activation'

printf '%s\n' 'Tailscale Serve read-only precondition, cutover, and recovery policy tests passed'
