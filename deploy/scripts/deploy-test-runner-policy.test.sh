#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_deploy_script="$(node -e 'process.stdout.write(require(process.argv[1]).scripts["test:deploy"])' "${ROOT}/package.json")"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

if [[ "$test_deploy_script" != *'bash "$test" || exit $?'* ]]; then
  printf '%s\n' 'The deployment policy runner must stop on the first failing test.' >&2
  exit 1
fi

mkdir -p "${TEMP_ROOT}/deploy/scripts"
printf '%s\n' '#!/usr/bin/env bash' 'printf pass > pass.marker' \
  >"${TEMP_ROOT}/deploy/scripts/00-pass.test.sh"
printf '%s\n' '#!/usr/bin/env bash' 'printf fail > fail.marker' 'exit 17' \
  >"${TEMP_ROOT}/deploy/scripts/01-fail.test.sh"
printf '%s\n' '#!/usr/bin/env bash' 'printf late > late.marker' \
  >"${TEMP_ROOT}/deploy/scripts/02-must-not-run.test.sh"

set +e
(cd "$TEMP_ROOT" && bash -c "$test_deploy_script" >/dev/null 2>&1)
runner_status=$?
set -e
if [[ "$runner_status" -ne 17 ]]; then
  printf 'The deployment policy runner returned %s instead of the first failure status 17.\n' "$runner_status" >&2
  exit 1
fi
if [[ ! -f "${TEMP_ROOT}/pass.marker" || ! -f "${TEMP_ROOT}/fail.marker" \
  || -e "${TEMP_ROOT}/late.marker" ]]; then
  printf '%s\n' 'The deployment policy runner did not stop before the post-failure fixture.' >&2
  exit 1
fi

printf '%s\n' 'Deployment policy test runner fail-fast execution check passed'
