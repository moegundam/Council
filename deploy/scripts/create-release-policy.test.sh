#!/usr/bin/env bash

set -euo pipefail

# Fixture repositories create and validate their own disposable E2E evidence.
unset RELEASE_E2E_EVIDENCE_FILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_VALIDATOR="${SCRIPT_DIR}/release-e2e-evidence-validator.py"
VERSION=19000101T000000Z

set +e
output="$(env -u MIGRATION_TEST_DATABASE_URL bash "${SCRIPT_DIR}/create-release.sh" "$VERSION" 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  printf '%s\n' 'Release creation unexpectedly accepted missing PostgreSQL migration evidence.' >&2
  exit 1
fi
if [[ "$output" != *"MIGRATION_TEST_DATABASE_URL is required"* ]]; then
  printf 'Release creation failed for the wrong reason:\n%s\n' "$output" >&2
  exit 1
fi

set +e
redis_output="$(MIGRATION_TEST_DATABASE_URL='postgres://policy.invalid/release' \
  env -u REDIS_RECOVERY_TEST_URL bash "${SCRIPT_DIR}/create-release.sh" "$VERSION" 2>&1)"
redis_status=$?
set -e

if [[ "$redis_status" -eq 0 ]]; then
  printf '%s\n' 'Release creation unexpectedly accepted missing Redis recovery evidence.' >&2
  exit 1
fi
if [[ "$redis_output" != *"REDIS_RECOVERY_TEST_URL is required"* ]]; then
  printf 'Release creation failed for the wrong Redis reason:\n%s\n' "$redis_output" >&2
  exit 1
fi

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "${fixture}/project/deploy/scripts"
cp "${SCRIPT_DIR}/create-release.sh" "${fixture}/project/deploy/scripts/create-release.sh"
printf '%s\n' 'fixture' >"${fixture}/project/tracked.txt"
git -C "${fixture}/project" init -q
git -C "${fixture}/project" add tracked.txt deploy/scripts/create-release.sh
git -C "${fixture}/project" -c user.name='Release Policy Test' -c user.email='release-policy@example.invalid' commit -qm 'fixture'
printf '%s\n' 'dirty' >>"${fixture}/project/tracked.txt"

set +e
dirty_output="$(MIGRATION_TEST_DATABASE_URL='postgres://policy.invalid/release' \
  REDIS_RECOVERY_TEST_URL='redis://policy.invalid:6379' \
  bash "${fixture}/project/deploy/scripts/create-release.sh" "$VERSION" 2>&1)"
dirty_status=$?
set -e

if [[ "$dirty_status" -eq 0 ]]; then
  printf '%s\n' 'Release creation unexpectedly accepted a dirty Git worktree.' >&2
  exit 1
fi
if [[ "$dirty_output" != *"requires a clean Git worktree"* ]]; then
  printf 'Dirty-worktree release failed for the wrong reason:\n%s\n' "$dirty_output" >&2
  exit 1
fi

mkdir -p "${fixture}/pin-project/deploy/scripts" "${fixture}/stub-bin"
cp "${SCRIPT_DIR}/create-release.sh" "${fixture}/pin-project/deploy/scripts/create-release.sh"
printf '%s\n' '{"name":"pin-policy","private":true,"packageManager":"pnpm@11.7.0"}' \
  >"${fixture}/pin-project/package.json"
git -C "${fixture}/pin-project" init -q
git -C "${fixture}/pin-project" add package.json deploy/scripts/create-release.sh
git -C "${fixture}/pin-project" -c user.name='Release Policy Test' -c user.email='release-policy@example.invalid' \
  commit -qm 'fixture'
cat >"${fixture}/stub-bin/corepack" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == enable && "${2:-}" == --install-directory && -n "${3:-}" ]]
mkdir -p "$3"
cat >"$3/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == --version ]]
printf '%s\n' '11.9.0'
PNPM
chmod +x "$3/pnpm"
STUB
chmod +x "${fixture}/stub-bin/corepack"

set +e
pin_output="$(PATH="${fixture}/stub-bin:${PATH}" MIGRATION_TEST_DATABASE_URL='postgres://policy.invalid/release' \
  REDIS_RECOVERY_TEST_URL='redis://policy.invalid:6379' \
  bash "${fixture}/pin-project/deploy/scripts/create-release.sh" "$VERSION" 2>&1)"
pin_status=$?
set -e
if [[ "$pin_status" -eq 0 ]]; then
  printf '%s\n' 'Release creation unexpectedly accepted the wrong pnpm version.' >&2
  exit 1
fi
if [[ "$pin_output" != *"requires pnpm 11.7.0; got 11.9.0"* ]]; then
  printf 'pnpm pin failed for the wrong reason:\n%s\n' "$pin_output" >&2
  exit 1
  fi
  grep -Fq '"pnpmVersion"' "${SCRIPT_DIR}/create-release.sh"
	  grep -Fq 'runtimeContract: "omp-rpc-v2@18.1.2"' "${SCRIPT_DIR}/create-release.sh"
	  grep -Fq 'nativeBaselineSha256: "cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4"' "${SCRIPT_DIR}/create-release.sh"
  grep -Fq 'integration: "methodology_only"' "${SCRIPT_DIR}/create-release.sh"
  grep -Fq 'TOOL_BIN="$(mktemp -d)"' "${SCRIPT_DIR}/create-release.sh"
  if grep -Fq 'TOOL_BIN="${STAGING}' "${SCRIPT_DIR}/create-release.sh"; then
    printf '%s\n' 'Release tool shims must not be created inside the bundle staging directory.' >&2
    exit 1
  fi

mkdir -p "${fixture}/drift-project/deploy/scripts" "${fixture}/drift-stub-bin"
cp "${SCRIPT_DIR}/create-release.sh" "${fixture}/drift-project/deploy/scripts/create-release.sh"
cp "$E2E_VALIDATOR" "${fixture}/drift-project/deploy/scripts/release-e2e-evidence-validator.py"
printf '%s\n' '{"name":"drift-policy","private":true,"packageManager":"pnpm@11.7.0"}' \
  >"${fixture}/drift-project/package.json"
printf '%s\n' 'committed content' >"${fixture}/drift-project/tracked.txt"
git -C "${fixture}/drift-project" init -q
git -C "${fixture}/drift-project" add package.json tracked.txt deploy/scripts/create-release.sh deploy/scripts/release-e2e-evidence-validator.py
git -C "${fixture}/drift-project" -c user.name='Release Policy Test' -c user.email='release-policy@example.invalid' \
  commit -qm 'fixture'
cat >"${fixture}/drift-stub-bin/corepack" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == enable && "${2:-}" == --install-directory && -n "${3:-}" ]]
mkdir -p "$3"
cat >"$3/pnpm" <<'PNPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then
  printf '%s\n' '11.7.0'
  exit 0
fi
[[ "${1:-}" == run ]]
[[ "${2:-}" == verify:release || "${2:-}" == test:e2e:container ]]
if [[ "${2:-}" == verify:release && "${PNPM_VERIFY_MUTATE_TRACKED:-0}" == 1 ]]; then
  printf '%s\n' 'changed during verification' >>tracked.txt
  exit 0
fi
mkdir -p node_modules .next dist
printf '%s\n' 'runtime only' >ignored-runtime.txt
printf '%s\n' 'dependency cache' >node_modules/dependency.txt
printf '%s\n' 'build cache' >.next/cache.txt
printf '%s\n' 'build output' >dist/output.txt
PNPM
chmod +x "$3/pnpm"
STUB
chmod +x "${fixture}/drift-stub-bin/corepack"

set +e
drift_output="$(PATH="${fixture}/drift-stub-bin:${PATH}" PNPM_VERIFY_MUTATE_TRACKED=1 \
  MIGRATION_TEST_DATABASE_URL='postgres://policy.invalid/release' \
  REDIS_RECOVERY_TEST_URL='redis://policy.invalid:6379' \
  bash "${fixture}/drift-project/deploy/scripts/create-release.sh" "$VERSION" 2>&1)"
drift_status=$?
set -e
if [[ "$drift_status" -eq 0 ]]; then
  printf '%s\n' 'Release creation unexpectedly accepted worktree drift during verification.' >&2
  exit 1
fi
if [[ "$drift_output" != *"changed during release verification"* ]]; then
  printf 'Verification-drift release failed for the wrong reason:\n%s\n' "$drift_output" >&2
  exit 1
fi

mkdir -p "${fixture}/archive-project/deploy/scripts"
cp "${SCRIPT_DIR}/create-release.sh" "${fixture}/archive-project/deploy/scripts/create-release.sh"
cp "$E2E_VALIDATOR" "${fixture}/archive-project/deploy/scripts/release-e2e-evidence-validator.py"
printf '%s\n' ':8080 {' '  respond "ready"' '}' \
  >"${fixture}/archive-project/deploy/Caddyfile"
printf '%s\n' '{"name":"archive-policy","private":true,"packageManager":"pnpm@11.7.0"}' \
  >"${fixture}/archive-project/package.json"
printf '%s\n' 'committed content' >"${fixture}/archive-project/tracked.txt"
printf '%s\n' 'ignored-runtime.txt' 'node_modules/' '.next/' 'dist/' 'release/' \
  >"${fixture}/archive-project/.gitignore"
git -C "${fixture}/archive-project" init -q
git -C "${fixture}/archive-project" add .gitignore package.json tracked.txt deploy/Caddyfile deploy/scripts/create-release.sh deploy/scripts/release-e2e-evidence-validator.py
git -C "${fixture}/archive-project" -c user.name='Release Policy Test' -c user.email='release-policy@example.invalid' \
  commit -qm 'fixture'
archive_commit="$(git -C "${fixture}/archive-project" rev-parse HEAD)"

(
  umask 077
  PATH="${fixture}/drift-stub-bin:${PATH}" MIGRATION_TEST_DATABASE_URL='postgres://policy.invalid/release' \
    REDIS_RECOVERY_TEST_URL='redis://policy.invalid:6379' \
    bash "${fixture}/archive-project/deploy/scripts/create-release.sh" "$VERSION" >/dev/null
)
archive_bundle="${fixture}/archive-project/release/agent-meeting-platform-${VERSION}.tar.gz"
archive_manifest_commit="$(tar -xOzf "$archive_bundle" ./release-manifest.json \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["gitCommit"])')"
archive_entries="$(tar -tzf "$archive_bundle")"

if [[ "$archive_manifest_commit" != "$archive_commit" ]]; then
  printf 'Release manifest commit mismatch: expected %s, got %s.\n' "$archive_commit" "$archive_manifest_commit" >&2
  exit 1
fi
if [[ "$(tar -xOzf "$archive_bundle" ./tracked.txt)" != 'committed content' ]]; then
  printf '%s\n' 'Release bundle did not preserve the committed tracked content.' >&2
  exit 1
fi
python3 - "$archive_bundle" <<'PYTHON'
import sys
import tarfile

with tarfile.open(sys.argv[1], "r:gz") as archive:
    modes = {member.name.removeprefix("./"): member.mode & 0o777 for member in archive.getmembers()}
assert modes["deploy/Caddyfile"] == 0o644, oct(modes["deploy/Caddyfile"])
assert modes["release-evidence/disposable-e2e.json"] == 0o644, oct(modes["release-evidence/disposable-e2e.json"])
assert modes["release-manifest.json"] == 0o644, oct(modes["release-manifest.json"])
PYTHON
if printf '%s\n' "$archive_entries" | grep -Fxq './'; then
  printf '%s\n' 'Release bundle must not contain an archive root entry.' >&2
  exit 1
fi
for prohibited_entry in ./.git/ ./ignored-runtime.txt ./node_modules/ ./.next/ ./dist/; do
  if [[ "$archive_entries" == *"$prohibited_entry"* ]]; then
    printf 'Release bundle unexpectedly contains %s.\n' "$prohibited_entry" >&2
    exit 1
  fi
done

deploy_script="${SCRIPT_DIR}/deploy-remote.sh"
stop_line="$(awk '/^compose stop api worker$/ { print NR; exit }' "$deploy_script")"
migrate_line="$(awk '/^if ! compose --profile ops run --rm migrate; then$/ { print NR; exit }' "$deploy_script")"
restore_line="$(awk '/^  if ! restore_previous_writers; then$/ { print NR; exit }' "$deploy_script")"
restart_line="$(awk '/^compose up -d api worker web / { print NR; exit }' "$deploy_script")"

if [[ -z "$stop_line" || -z "$migrate_line" || "$stop_line" -ge "$migrate_line" ]]; then
  printf '%s\n' 'Deployment must stop the previous API and Worker before migration.' >&2
  exit 1
fi
if [[ -z "$restore_line" || "$restore_line" -le "$migrate_line" ]]; then
  printf '%s\n' 'Migration failure must restore the previous API and Worker configuration.' >&2
  exit 1
fi
if [[ -z "$restart_line" || "$restart_line" -le "$migrate_line" ]]; then
  printf '%s\n' 'The new API and Worker must start only after migration succeeds.' >&2
  exit 1
fi

printf '%s\n' 'release migration policy tests passed'
