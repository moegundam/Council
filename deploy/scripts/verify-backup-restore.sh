#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  printf 'Usage: %s --run /opt/council/backups/agent-meeting-platform/.../postgres.sql.gz\n' "$0" >&2
}

RUN=false
BACKUP_FILE=""
while (( $# > 0 )); do
  case "$1" in
    --run)
      RUN=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage
      exit 1
      ;;
    *)
      if [[ -n "$BACKUP_FILE" ]]; then
        printf '%s\n' 'Only one PostgreSQL backup may be verified at a time.' >&2
        usage
        exit 1
      fi
      BACKUP_FILE="$1"
      ;;
  esac
  shift
done

BACKUP_ROOT="${COUNCIL_BACKUP_ROOT:-${COUNCIL_ROOT:-/opt/council}/backups/agent-meeting-platform}"
if [[ "$RUN" != true ]]; then
  printf '%s\n' 'Restore verification requires explicit --run confirmation.' >&2
  usage
  exit 1
fi
if [[ -z "$BACKUP_FILE" || "$BACKUP_FILE" != "${BACKUP_ROOT}/"*/postgres.sql.gz ]]; then
  usage
  exit 1
fi

RELATIVE_BACKUP="${BACKUP_FILE#${BACKUP_ROOT}/}"
if [[ ! "$RELATIVE_BACKUP" =~ ^[A-Za-z0-9._/-]+$ \
  || "$RELATIVE_BACKUP" == ../* \
  || "$RELATIVE_BACKUP" == */../* \
  || "$RELATIVE_BACKUP" == */.. \
  || "$RELATIVE_BACKUP" == ./* \
  || "$RELATIVE_BACKUP" == */./* \
  || "$RELATIVE_BACKUP" == *//* ]]; then
  printf '%s\n' 'Backup path contains an unsafe component.' >&2
  exit 1
fi

source "${SCRIPT_DIR}/remote-common.sh"

printf -v BACKUP_FILE_Q '%q' "$BACKUP_FILE"
remote_ssh "BACKUP_FILE=${BACKUP_FILE_Q} bash -s" <<'REMOTE'
set -euo pipefail

ROOT="${COUNCIL_ROOT:-/opt/council}"
STACK=agent-meeting-platform
COMPOSE_DIR="${ROOT}/compose/${STACK}"
SECRETS_DIR="${ROOT}/secrets/${STACK}"
POSTGRES_SECRET="${SECRETS_DIR}/postgres_password"
APP_MASTER_SECRET="${SECRETS_DIR}/app_master_key"
BACKUP_DIR="$(dirname -- "$BACKUP_FILE")"
CHECKSUM_FILE="${BACKUP_DIR}/SHA256SUMS"
RESTORE_CONTAINER="${STACK}-restore-test-$$"
API_CONTAINER="${STACK}-restore-api-test-$$"
RESTORE_NETWORK="${STACK}-restore-test-$$"

test -r "$BACKUP_FILE"
test -r "$CHECKSUM_FILE"
test -r "$POSTGRES_SECRET"
test -r "$APP_MASTER_SECRET"
test -f "${COMPOSE_DIR}/compose.yaml"
test -f "${COMPOSE_DIR}/.env"

CHECKSUM_ENTRY_COUNT="$(awk '$2 == "postgres.sql.gz" { count += 1 } END { print count + 0 }' "$CHECKSUM_FILE")"
if [[ "$CHECKSUM_ENTRY_COUNT" != 1 ]]; then
  printf '%s\n' 'SHA256SUMS must contain exactly one postgres.sql.gz entry.' >&2
  exit 1
fi
(
  cd "$BACKUP_DIR"
  sha256sum --check --strict SHA256SUMS
)
gzip -t "$BACKUP_FILE"

cleanup() {
  set +e
  docker rm -f "$API_CONTAINER" >/dev/null 2>&1
  docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1
  docker network rm "$RESTORE_NETWORK" >/dev/null 2>&1
}
trap cleanup EXIT

docker network create --internal --attachable \
  --label "com.council.purpose=restore-verification" \
  "$RESTORE_NETWORK" >/dev/null

docker run -d --rm \
  --name "$RESTORE_CONTAINER" \
  --network "$RESTORE_NETWORK" \
  --network-alias restore-postgres \
  --label "com.council.purpose=restore-verification" \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
  --mount "type=bind,src=${POSTGRES_SECRET},dst=/run/secrets/postgres_password,readonly" \
  -e POSTGRES_DB=council \
  -e POSTGRES_USER=council \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94 >/dev/null

postgres_ready=false
for _ in $(seq 1 30); do
  if docker exec "$RESTORE_CONTAINER" pg_isready -U council -d council >/dev/null 2>&1; then
    postgres_ready=true
    break
  fi
  sleep 2
done
if [[ "$postgres_ready" != true ]]; then
  printf '%s\n' 'Isolated restore PostgreSQL did not become ready.' >&2
  exit 1
fi

gzip -dc "$BACKUP_FILE" \
  | docker exec -i "$RESTORE_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U council -d council >/dev/null

restore_query() {
  local query="$1"
  docker exec "$RESTORE_CONTAINER" \
    psql -X -v ON_ERROR_STOP=1 -Atq -U council -d council -c "$query"
}

MISSING_TABLES="$(restore_query "
  WITH expected(table_name) AS (
    VALUES
      ('schema_migrations'),
      ('platform_state'),
      ('owner_users'),
      ('owner_sessions'),
      ('connector_secrets'),
      ('credential_secrets'),
      ('idempotency_records'),
      ('audit_events'),
      ('role_versions'),
      ('prompt_versions'),
      ('agent_revisions'),
      ('runtime_profiles'),
      ('runtime_profile_revisions'),
      ('tool_packs'),
      ('tool_pack_revisions'),
      ('meeting_utterances'),
      ('utterance_projection_backfill_progress')
  )
  SELECT COALESCE(string_agg(table_name, ',' ORDER BY table_name), '')
  FROM expected
  WHERE to_regclass(format('public.%I', table_name)) IS NULL;
")"
if [[ -n "$MISSING_TABLES" ]]; then
  printf 'Restore verification is missing expected tables: %s\n' "$MISSING_TABLES" >&2
  exit 1
fi

MISSING_AGENT_REVISION_COLUMNS="$(restore_query "
  WITH expected(column_name) AS (
    VALUES
      ('runtime_profile_binding'),
      ('tool_pack_grants')
  )
  SELECT COALESCE(string_agg(column_name, ',' ORDER BY column_name), '')
  FROM expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS columns
    WHERE columns.table_schema = 'public'
      AND columns.table_name = 'agent_revisions'
      AND columns.column_name = expected.column_name
  );
")"
if [[ -n "$MISSING_AGENT_REVISION_COLUMNS" ]]; then
  printf 'Restore verification is missing agent_revisions columns: %s\n' \
    "$MISSING_AGENT_REVISION_COLUMNS" >&2
  exit 1
fi

LATEST_MIGRATION_COUNT="$(restore_query \
  "SELECT count(*) FROM schema_migrations WHERE version = '021_utterance_projection_expand';")"
if [[ "$LATEST_MIGRATION_COUNT" != 1 ]]; then
  printf '%s\n' 'Restore verification is missing migration 021_utterance_projection_expand.' >&2
  exit 1
fi

MCP_LOCATION_MIGRATION_COUNT="$(restore_query \
  "SELECT count(*) FROM schema_migrations WHERE version = '022_mcp_connector_location';")"
if [[ "$MCP_LOCATION_MIGRATION_COUNT" != 1 ]]; then
  printf '%s\n' 'Restore verification is missing migration 022_mcp_connector_location.' >&2
  exit 1
fi

UTTERANCE_PROJECTION_STATE="$(restore_query "
  SELECT concat_ws('|',
    source_count,
    processed_count,
    completed_at IS NOT NULL,
    cutover_at IS NOT NULL,
    (SELECT count(*) FROM meeting_utterances)
  )
  FROM utterance_projection_backfill_progress
  WHERE singleton_id = 1;
")"
IFS='|' read -r UTTERANCE_SOURCE_COUNT UTTERANCE_PROCESSED_COUNT \
  UTTERANCE_BACKFILL_COMPLETE UTTERANCE_CUTOVER_COMPLETE \
  UTTERANCE_PROJECTED_COUNT <<<"$UTTERANCE_PROJECTION_STATE"
if [[ ! "$UTTERANCE_SOURCE_COUNT" =~ ^[0-9]+$ \
  || "$UTTERANCE_SOURCE_COUNT" != "$UTTERANCE_PROCESSED_COUNT" \
  || "$UTTERANCE_BACKFILL_COMPLETE" != "t" \
  || "$UTTERANCE_CUTOVER_COMPLETE" != "t" \
  || ! "$UTTERANCE_PROJECTED_COUNT" =~ ^[0-9]+$ \
  || "$UTTERANCE_PROJECTED_COUNT" -lt "$UTTERANCE_SOURCE_COUNT" ]]; then
  printf 'Utterance projection restore proof failed: %s.\n' "$UTTERANCE_PROJECTION_STATE" >&2
  exit 1
fi

PLATFORM_STATE_CARDINALITY="$(restore_query \
  "SELECT count(*) || ':' || count(*) FILTER (WHERE singleton_id = 1) FROM platform_state;")"
if [[ "$PLATFORM_STATE_CARDINALITY" != "1:1" ]]; then
  printf 'platform_state must contain exactly the singleton row; found %s.\n' \
    "$PLATFORM_STATE_CARDINALITY" >&2
  exit 1
fi

CORE_COUNTS="$(restore_query "
  SELECT concat_ws('|',
    jsonb_array_length(COALESCE(state->'groups', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'categories', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'tags', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'threads', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'meetings', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'agents', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'roles', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'skills', '[]'::jsonb)),
    jsonb_array_length(COALESCE(state->'runtimeProfiles', '[]'::jsonb))
  )
  FROM platform_state
  WHERE singleton_id = 1;
")"
IFS='|' read -r GROUP_COUNT CATEGORY_COUNT TAG_COUNT THREAD_COUNT MEETING_COUNT \
  AGENT_COUNT ROLE_COUNT SKILL_COUNT RUNTIME_PROFILE_COUNT <<<"$CORE_COUNTS"
CORE_NAMES=(groups categories tags threads meetings agents roles skills runtimeProfiles)
CORE_VALUES=(
  "$GROUP_COUNT" "$CATEGORY_COUNT" "$TAG_COUNT" "$THREAD_COUNT"
  "$MEETING_COUNT" "$AGENT_COUNT" "$ROLE_COUNT" "$SKILL_COUNT" "$RUNTIME_PROFILE_COUNT"
)
for index in "${!CORE_NAMES[@]}"; do
  value="${CORE_VALUES[$index]}"
  if [[ ! "$value" =~ ^[0-9]+$ || "$value" -lt 1 ]]; then
    printf 'Restored core collection %s must be nonempty; found %s.\n' \
      "${CORE_NAMES[$index]}" "${value:-missing}" >&2
    exit 1
  fi
done

CURRENT_API_ID="$(
  docker compose --project-name "$STACK" --env-file "${COMPOSE_DIR}/.env" \
    -f "${COMPOSE_DIR}/compose.yaml" ps -q api
)"
if [[ -z "$CURRENT_API_ID" ]]; then
  printf '%s\n' 'The deployed API container is required for an isolated API restore proof.' >&2
  exit 1
fi
API_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CURRENT_API_ID")"
if [[ ! "$API_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf 'Could not resolve the immutable deployed API image ID; found %s.\n' "${API_IMAGE_ID:-missing}" >&2
  exit 1
fi
docker image inspect "$API_IMAGE_ID" >/dev/null

docker run -d --rm \
  --name "$API_CONTAINER" \
  --network "$RESTORE_NETWORK" \
  --label "com.council.purpose=restore-verification" \
  --user "$(id -u):$(id -g)" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --mount "type=bind,src=${POSTGRES_SECRET},dst=/run/secrets/postgres_password,readonly" \
  --mount "type=bind,src=${APP_MASTER_SECRET},dst=/run/secrets/app_master_key,readonly" \
  -e NODE_ENV=production \
  -e PORT=4000 \
  -e PGHOST=restore-postgres \
  -e PGPORT=5432 \
  -e PGDATABASE=council \
  -e PGUSER=council \
  -e POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password \
  -e APP_MASTER_KEY_FILE=/run/secrets/app_master_key \
  -e PUBLIC_ORIGIN=https://restore-proof.invalid \
  -e AUTH_DISABLED=true \
  -e ALLOW_PRODUCTION_AUTH_BYPASS=true \
  -e MCP_LOCAL_HOST_ALLOWLIST=mcp-readonly \
  -e HARNESS_EXECUTOR_ENABLED=false \
  "$API_IMAGE_ID" >/dev/null

api_ready=false
for _ in $(seq 1 30); do
  if docker exec "$API_CONTAINER" node -e \
    "fetch('http://127.0.0.1:4000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    api_ready=true
    break
  fi
  sleep 2
done
if [[ "$api_ready" != true ]]; then
  docker logs --tail 100 "$API_CONTAINER" >&2 || true
  printf '%s\n' 'Isolated restored API did not become ready.' >&2
  exit 1
fi

if ! API_CORE_COUNTS="$(docker exec "$API_CONTAINER" node -e '
  const names = ["groups", "categories", "tags", "threads", "meetings", "agents", "roles", "skills", "runtimeProfiles"];
  fetch("http://127.0.0.1:4000/api/bootstrap")
    .then(async (response) => {
      if (!response.ok) throw new Error(`bootstrap returned ${response.status}`);
      const body = await response.json();
      const counts = Object.fromEntries(names.map((name) => [name, Array.isArray(body[name]) ? body[name].length : -1]));
      for (const [name, count] of Object.entries(counts)) {
        if (count < 1) throw new Error(`${name} is missing or empty`);
      }
      process.stdout.write(JSON.stringify(counts));
    })
    .catch((error) => { console.error(error.message); process.exit(1); });
')"; then
  printf '%s\n' 'Isolated restored API bootstrap data proof failed.' >&2
  exit 1
fi

if ! docker exec "$API_CONTAINER" node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  import { createPostgresPoolFromEnv } from "@council/database";
  import { SecretVault } from "@council/domain";

  const pool = await createPostgresPoolFromEnv();
  try {
    const result = await pool.query("SELECT ciphertext FROM connector_secrets ORDER BY connector_id");
    if (result.rows.length === 0) {
      console.log("encrypted_secret_proof=skipped reason=no_connector_secrets");
    } else {
      const encodedKey = (await readFile(process.env.APP_MASTER_KEY_FILE, "utf8")).trim();
      const vault = new SecretVault(Buffer.from(encodedKey, "base64"));
      for (const row of result.rows) {
        const plaintext = vault.decrypt(row.ciphertext);
        if (!plaintext) throw new Error("Decrypted connector secret is empty.");
      }
      console.log(`encrypted_secret_proof=passed count=${result.rows.length}`);
    }
  } finally {
    await pool.end();
  }
'; then
  printf '%s\n' 'Restored connector secret decryption proof failed.' >&2
  exit 1
fi

printf 'Restore verification passed. migration=021_utterance_projection_expand migration=022_mcp_connector_location utterances=%s core_counts=%s api_counts=%s\n' \
  "$UTTERANCE_PROJECTED_COUNT" "$CORE_COUNTS" "$API_CORE_COUNTS"
REMOTE
