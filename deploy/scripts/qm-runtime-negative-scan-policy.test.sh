#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
REAL_GREP="$(command -v grep)"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'for argument in "$@"; do' \
  '  if [[ "$argument" == '\''readRequired("SANDBOX_BROKER_TOKEN")'\'' || "$argument" == '\''manifestDigest'\'' ]]; then' \
  '    exit 2' \
  '  fi' \
  'done' \
  "exec ${REAL_GREP} \"\$@\"" \
  >"${TEMP_DIR}/grep"
chmod +x "${TEMP_DIR}/grep"

for policy in qm-runtime-r4-policy.test.sh qm-runtime-r5-policy.test.sh; do
  set +e
  output="$(PATH="${TEMP_DIR}:${PATH}" bash "${ROOT}/deploy/scripts/${policy}" 2>&1)"
  status=$?
  set -e
  if (( status == 0 )); then
    printf 'Policy unexpectedly passed after an injected grep failure: %s\n' "$policy" >&2
    exit 1
  fi
  grep -Fq 'Policy scan failed with status 2; refusing to pass' <<<"$output"
done

printf '%s\n' 'QM negative policy scans fail closed on grep execution errors'
