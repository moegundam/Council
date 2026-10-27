#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
DOCKERFILE="${ROOT}/deploy/Dockerfile"
ENV_EXAMPLE="${ROOT}/deploy/.env.example"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"
ROLLBACK="${ROOT}/deploy/scripts/rollback-remote.sh"

grep -Fq 'GOAL_RUN_AUTONOMY_ENABLED: ${GOAL_RUN_AUTONOMY_ENABLED:-false}' "${COMPOSE}"
grep -Fq 'NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED: ${GOAL_RUN_AUTONOMY_ENABLED:-false}' "${COMPOSE}"
grep -Fxq 'ARG NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED=false' "${DOCKERFILE}"
grep -Fxq 'ENV NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED=${NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED}' "${DOCKERFILE}"
grep -Fxq 'GOAL_RUN_AUTONOMY_ENABLED=false' "${ENV_EXAMPLE}"
grep -Fxq 'GOAL_RUN_AUTONOMY_ENABLED="${GOAL_RUN_AUTONOMY_ENABLED:-false}"' "${DEPLOY}"
grep -Fxq 'ALLOW_GOAL_RUN_AUTONOMY="${ALLOW_GOAL_RUN_AUTONOMY:-false}"' "${DEPLOY}"
grep -Fq 'GOAL_RUN_AUTONOMY_ENABLED must be true or false.' "${DEPLOY}"
grep -Fq 'Enabling Goal Run autonomy requires ALLOW_GOAL_RUN_AUTONOMY=true.' "${DEPLOY}"
grep -Fq "GOAL_RUN_AUTONOMY_ENABLED='\${GOAL_RUN_AUTONOMY_ENABLED}'" "${DEPLOY}"
grep -Fq 'GOAL_RUN_AUTONOMY_ENABLED=%s\n' "${DEPLOY}"
grep -Fq '# GOAL_RUN_FLAG_VERIFY_BEGIN' "${DEPLOY}"
grep -Fq 'NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED' "${DEPLOY}"
grep -Fq 'required_settings+=(GOAL_RUN_AUTONOMY_ENABLED)' "${ROLLBACK}"
grep -Fq 'GOAL_RUN_AUTONOMY_ENABLED="$(target_env_value GOAL_RUN_AUTONOMY_ENABLED)"' "${ROLLBACK}"

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
bundle="${fixture}/agent-meeting-platform-19000101T000000Z.tar.gz"
ssh_key="${fixture}/ssh-key"
touch "$bundle" "${bundle}.sha256" "$ssh_key"

set +e
invalid_output="$(SSH_KEY="$ssh_key" GOAL_RUN_AUTONOMY_ENABLED=invalid bash "$DEPLOY" "$bundle" 2>&1)"
invalid_status=$?
set -e
[[ "$invalid_status" -ne 0 ]]
[[ "$invalid_output" == *'GOAL_RUN_AUTONOMY_ENABLED must be true or false.'* ]]

set +e
unacknowledged_output="$(SSH_KEY="$ssh_key" GOAL_RUN_AUTONOMY_ENABLED=true ALLOW_GOAL_RUN_AUTONOMY=false \
  bash "$DEPLOY" "$bundle" 2>&1)"
unacknowledged_status=$?
set -e
[[ "$unacknowledged_status" -ne 0 ]]
[[ "$unacknowledged_output" == *'Enabling Goal Run autonomy requires ALLOW_GOAL_RUN_AUTONOMY=true.'* ]]

printf 'Goal Run rollout defaults are fail-closed and API/Worker/Web use one explicit flag.\n'
