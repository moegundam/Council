#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

EMAIL="${1:-}"
if [[ ! "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  printf 'Usage: %s owner@example.com\n' "$0" >&2
  exit 1
fi

read -r -s -p 'Owner password (minimum 12 characters): ' PASSWORD
printf '\n'
read -r -s -p 'Confirm owner password: ' PASSWORD_CONFIRM
printf '\n'

if [[ "$PASSWORD" != "$PASSWORD_CONFIRM" || ${#PASSWORD} -lt 12 ]]; then
  printf '%s\n' 'Passwords do not match or are shorter than 12 characters.' >&2
  exit 1
fi

printf '%s\n' "$PASSWORD" | remote_ssh \
  "cd /opt/council/compose/agent-meeting-platform && docker compose --project-name agent-meeting-platform --env-file .env -f compose.yaml exec -T api node dist/admin-create.js --email '${EMAIL}'"
unset PASSWORD PASSWORD_CONFIRM
