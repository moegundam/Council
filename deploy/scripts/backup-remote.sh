#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

remote_ssh 'bash -s' <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
BACKUP_DIR="${ROOT}/backups/${STACK}/manual-$(date -u +%Y%m%dT%H%M%SZ)"

test -f "${COMPOSE_DIR}/compose.yaml"
test -f "${COMPOSE_DIR}/.env"
umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "${ROOT}/backups/${STACK}"
cp -a "${COMPOSE_DIR}/compose.yaml" "$BACKUP_DIR/compose.yaml"
cp -a "${COMPOSE_DIR}/.env" "$BACKUP_DIR/compose.env"

cd "$COMPOSE_DIR"
docker compose --project-name "$STACK" --env-file .env -f compose.yaml exec -T postgres \
  pg_dump --clean --if-exists --no-owner --no-privileges -U council -d council </dev/null \
  | gzip -9 >"${BACKUP_DIR}/postgres.sql.gz"
gzip -t "${BACKUP_DIR}/postgres.sql.gz"
(
  cd "$BACKUP_DIR"
  sha256sum postgres.sql.gz >SHA256SUMS
)
printf 'Backup created: %s\n' "$BACKUP_DIR"
REMOTE
