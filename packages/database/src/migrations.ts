import { meetingAgendaSchema } from "@council/contracts";
import type { Pool, PoolClient } from "pg";
import { createSeedSnapshot } from "./seed.js";
import { defaultRuntimeProfileId } from "./runtime-profiles.js";

function assertRuntimeCompatibleMeetingAgendas(state: unknown): void {
  if (!state || typeof state !== "object" || !Array.isArray((state as { meetings?: unknown }).meetings)) {
    throw new Error("Invalid existing Meeting Agenda detected during migration.");
  }
  for (const meeting of (state as { meetings: unknown[] }).meetings) {
    if (!meeting || typeof meeting !== "object" || Array.isArray(meeting)) {
      throw new Error("Invalid existing Meeting Agenda detected during migration.");
    }
    if (Object.prototype.hasOwnProperty.call(meeting, "agenda")
      && !meetingAgendaSchema.safeParse((meeting as { agenda: unknown }).agenda).success) {
      throw new Error("Invalid existing Meeting Agenda detected during migration.");
    }
  }
}

async function validateMeetingAgendaMigration(client: PoolClient): Promise<void> {
  const result = await client.query<{ state: unknown }>(
    "SELECT state FROM platform_state WHERE singleton_id = 1 FOR UPDATE"
  );
  if (result.rowCount !== 1 || !result.rows[0]) {
    throw new Error("Invalid existing Meeting Agenda detected during migration.");
  }
  assertRuntimeCompatibleMeetingAgendas(result.rows[0].state);
}

const initialSchema = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS platform_state (
    singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
    revision bigint NOT NULL DEFAULT 0,
    state jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS owner_users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS owner_sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES owner_users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS owner_sessions_expires_idx ON owner_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS connector_secrets (
    connector_id uuid PRIMARY KEY,
    ciphertext text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS idempotency_records (
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_fingerprint text,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (operation, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id uuid PRIMARY KEY,
    event text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
`;

export const additiveMigrations = [{
  version: "002_idempotency_fingerprint",
  sql: "ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS request_fingerprint text"
}, {
  version: "003_chair_suggestions_snapshot",
  sql: `
    UPDATE platform_state
    SET state = jsonb_set(state, '{chairSuggestions}', '[]'::jsonb, true),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (state ? 'chairSuggestions')
  `
}, {
  version: "004_task_work_items_snapshot",
  sql: `
    UPDATE platform_state
    SET state = jsonb_set(
          jsonb_set(
            state,
            '{taskAdapterConnectors}',
            COALESCE(state->'taskAdapterConnectors', '[]'::jsonb),
            true
          ),
          '{tasks}',
          COALESCE((
            SELECT jsonb_agg(
              task || jsonb_build_object(
                'assigneeAgentId', COALESCE(task->'assigneeAgentId', 'null'::jsonb),
                'dueAt', COALESCE(task->'dueAt', 'null'::jsonb),
                'acceptanceCriteria', COALESCE(task->'acceptanceCriteria', '""'::jsonb),
                'evidence', CASE
                  WHEN jsonb_typeof(task->'evidence') = 'array' THEN task->'evidence'
                  ELSE jsonb_build_array(
                    jsonb_build_object(
                      'id', 'meeting:' || (task->>'id'),
                      'type', 'meeting',
                      'label', '來源會議',
                      'reference', task->>'meetingId',
                      'addedBy', 'system',
                      'createdAt', task->>'createdAt'
                    ),
                    jsonb_build_object(
                      'id', 'decision:' || (task->>'id'),
                      'type', 'decision',
                      'label', '來源決議',
                      'reference', task->>'decisionId',
                      'addedBy', 'system',
                      'createdAt', task->>'createdAt'
                    )
                  )
                END,
                'executionProfile', COALESCE(task->'executionProfile', '"manual"'::jsonb),
                'allowedTools', CASE WHEN jsonb_typeof(task->'allowedTools') = 'array' THEN task->'allowedTools' ELSE '[]'::jsonb END,
                'dataScope', COALESCE(task->'dataScope', '""'::jsonb),
                'approvalState', COALESCE(task->'approvalState', '"not_required"'::jsonb),
                'transitions', CASE
                  WHEN jsonb_typeof(task->'transitions') = 'array' THEN task->'transitions'
                  ELSE jsonb_build_array(jsonb_build_object(
                    'id', 'created:' || (task->>'id'),
                    'type', 'created',
                    'actor', 'system',
                    'at', task->>'createdAt',
                    'toStatus', task->>'status',
                    'toPosition', (task->>'position')::integer,
                    'note', 'Backfilled from a legacy Task.'
                  ))
                END,
                'sync', jsonb_build_object(
                  'status', 'not_synced',
                  'adapterId', null,
                  'jobId', null,
                  'externalId', null,
                  'attemptCount', 0,
                  'lastAttemptAt', null,
                  'lastError', null,
                  'syncedAt', null
                ) || COALESCE(task->'sync', '{}'::jsonb),
                'updatedAt', COALESCE(task->'updatedAt', task->'createdAt')
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'tasks', '[]'::jsonb)) WITH ORDINALITY AS entries(task, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (state ? 'taskAdapterConnectors')
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(state->'tasks', '[]'::jsonb)) AS entries(task)
         WHERE NOT (task ?& ARRAY[
           'assigneeAgentId', 'dueAt', 'acceptanceCriteria', 'evidence', 'executionProfile',
           'allowedTools', 'dataScope', 'approvalState', 'transitions', 'sync', 'updatedAt'
         ])
       )
  `
}, {
  version: "005_skill_governance_snapshot",
  sql: `
    UPDATE platform_state
    SET state = jsonb_set(
          state,
          '{skills}',
          COALESCE((
            SELECT jsonb_agg(
              skill || jsonb_build_object(
                'source', normalized.source,
                'owner', normalized.owner,
                'contentDigest', calculated.content_digest,
                'validation', CASE
                  WHEN jsonb_typeof(skill->'validation') = 'object'
                    AND skill->'validation'->>'result' IN ('pending', 'passed', 'failed')
                    AND jsonb_typeof(skill->'validation'->'summary') = 'string'
                    AND jsonb_typeof(skill->'validation'->'checkedAt') IN ('string', 'null')
                    AND (
                      (skill->'validation'->>'result' = 'pending' AND jsonb_typeof(skill->'validation'->'contentDigest') = 'null')
                      OR (skill->'validation'->>'result' IN ('passed', 'failed') AND skill->'validation'->>'contentDigest' = calculated.content_digest)
                    )
                    THEN skill->'validation'
                  WHEN NOT (skill ?| ARRAY['source', 'owner', 'contentDigest', 'validation', 'approvedAt', 'revokedAt', 'revocationReason'])
                    AND skill->>'status' = 'approved' THEN jsonb_build_object(
                    'result', 'passed',
                    'summary', '此 Skill 在治理功能上線前已核准；沒有自動驗證證據。',
                    'checkedAt', null,
                    'contentDigest', calculated.content_digest
                  )
                  WHEN NOT (skill ? 'validation') AND skill->>'status' <> 'approved'
                    THEN jsonb_build_object('result', 'pending', 'summary', '尚未記錄人工驗證證據。', 'checkedAt', null, 'contentDigest', null)
                  ELSE jsonb_build_object('result', 'failed', 'summary', '治理紀錄不完整，必須重新人工驗證。', 'checkedAt', null, 'contentDigest', calculated.content_digest)
                END,
                'approvedAt', CASE WHEN jsonb_typeof(skill->'approvedAt') IN ('string', 'null') THEN skill->'approvedAt' ELSE 'null'::jsonb END,
                'revokedAt', CASE WHEN jsonb_typeof(skill->'revokedAt') IN ('string', 'null') THEN skill->'revokedAt' ELSE 'null'::jsonb END,
                'revocationReason', CASE WHEN jsonb_typeof(skill->'revocationReason') IN ('string', 'null') THEN skill->'revocationReason' ELSE 'null'::jsonb END
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'skills', '[]'::jsonb)) WITH ORDINALITY AS entries(skill, ordinal)
            CROSS JOIN LATERAL (
              SELECT
                CASE WHEN jsonb_typeof(skill->'source') = 'string' AND btrim(skill->>'source') <> '' THEN skill->>'source' ELSE 'Council legacy registry' END AS source,
                CASE WHEN jsonb_typeof(skill->'owner') = 'string' AND btrim(skill->>'owner') <> '' THEN skill->>'owner' ELSE 'Platform Owner' END AS owner
            ) AS normalized
            CROSS JOIN LATERAL (
              SELECT encode(sha256(convert_to(concat_ws(chr(31), skill->>'name', skill->>'version', skill->>'instructions', normalized.source, normalized.owner), 'UTF8')), 'hex') AS content_digest
            ) AS calculated
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
  `
}, {
  version: "006_meeting_summary_delivery_snapshot",
  sql: `
    UPDATE platform_state
    SET state = jsonb_set(
          state,
          '{meetings}',
          COALESCE((
            SELECT jsonb_agg(
              meeting || jsonb_build_object(
                'summaryState', COALESCE(meeting->'summaryState', '"not_requested"'::jsonb),
                'summaryJobId', CASE
                  WHEN meeting ? 'summaryJobId' THEN meeting->'summaryJobId'
                  ELSE 'null'::jsonb
                END
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'meetings', '[]'::jsonb)) WITH ORDINALITY AS entries(meeting, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(state->'meetings', '[]'::jsonb)) AS entries(meeting)
      WHERE NOT (meeting ?& ARRAY['summaryState', 'summaryJobId'])
    )
  `
}, {
  version: "007_role_policy_snapshots",
  sql: `
    UPDATE platform_state
    SET state = jsonb_set(
          state,
          '{roles}',
          COALESCE((
            SELECT jsonb_agg(
              role || jsonb_build_object(
                'version', CASE
                  WHEN jsonb_typeof(role->'version') = 'number' AND (role->>'version')::integer > 0 THEN role->'version'
                  ELSE '1'::jsonb
                END,
                'templateKey', CASE
                  WHEN role->>'templateKey' IN ('platform_architect', 'meeting_chair', 'security_reviewer', 'evidence_analyst') THEN role->'templateKey'
                  ELSE CASE role->>'id'
                    WHEN '60000000-0000-4000-8000-000000000001' THEN '"platform_architect"'::jsonb
                    WHEN '60000000-0000-4000-8000-000000000002' THEN '"meeting_chair"'::jsonb
                    WHEN '60000000-0000-4000-8000-000000000003' THEN '"security_reviewer"'::jsonb
                    ELSE 'null'::jsonb
                  END
                END,
                'speakingGuidance', CASE
                  WHEN jsonb_typeof(role->'speakingGuidance') = 'string' AND btrim(role->>'speakingGuidance') <> '' THEN role->'speakingGuidance'
                  ELSE to_jsonb('先回應目前議題，再提出一項具體建議與風險。'::text)
                END,
                'decisionScope', CASE
                  WHEN jsonb_typeof(role->'decisionScope') = 'string' AND btrim(role->>'decisionScope') <> '' THEN role->'decisionScope'
                  ELSE to_jsonb('可提出候選決議，不代替擁有者核准。'::text)
                END,
                'constraints', CASE
                  WHEN jsonb_typeof(role->'constraints') = 'string' AND btrim(role->>'constraints') <> '' THEN role->'constraints'
                  ELSE to_jsonb('不得偏離會議目標；不確定時必須明確標示假設。'::text)
                END,
                'toolPolicy', CASE
                  WHEN role->>'toolPolicy' IN ('none', 'agent_read_only_grants') THEN role->'toolPolicy'
                  WHEN role->>'templateKey' IN ('platform_architect', 'security_reviewer', 'evidence_analyst')
                    OR role->>'id' IN ('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003')
                    THEN '"agent_read_only_grants"'::jsonb
                  ELSE '"none"'::jsonb
                END,
                'dataPolicy', CASE
                  WHEN role->>'dataPolicy' IN ('meeting_only', 'agent_declared_scope') THEN role->'dataPolicy'
                  WHEN role->>'templateKey' IN ('platform_architect', 'security_reviewer', 'evidence_analyst')
                    OR role->>'id' IN ('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000003')
                    THEN '"agent_declared_scope"'::jsonb
                  ELSE '"meeting_only"'::jsonb
                END
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) WITH ORDINALITY AS entries(role, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) AS entries(role)
      WHERE NOT (role ?& ARRAY['version', 'templateKey', 'speakingGuidance', 'decisionScope', 'constraints', 'toolPolicy', 'dataPolicy'])
    );

    UPDATE platform_state
    SET state = jsonb_set(
          state,
          '{roles}',
          COALESCE((
            SELECT jsonb_agg(
              CASE
                WHEN role->>'toolPolicy' = 'agent_read_only_grants' AND role->>'dataPolicy' = 'meeting_only'
                  THEN role || jsonb_build_object('toolPolicy', 'none')
                ELSE role
              END ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) WITH ORDINALITY AS entries(role, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) AS entries(role)
      WHERE role->>'toolPolicy' = 'agent_read_only_grants' AND role->>'dataPolicy' = 'meeting_only'
    );

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS roles(role)
          WHERE role->>'id' = participant->>'roleId'
        )
      ) THEN
        RAISE EXCEPTION 'Cannot backfill Role snapshots with orphan participant Role references.';
      END IF;
    END $$;

    UPDATE platform_state
    SET state = jsonb_set(
          state,
          '{participants}',
          COALESCE((
            SELECT jsonb_agg(
              CASE WHEN participant ? 'roleSnapshot' THEN participant ELSE
                participant || jsonb_build_object(
                  'roleSnapshot', jsonb_build_object(
                    'roleId', role->'id',
                    'name', role->'name',
                    'responsibility', role->'responsibility',
                    'speakingGuidance', role->'speakingGuidance',
                    'decisionScope', role->'decisionScope',
                    'constraints', role->'constraints',
                    'version', role->'version',
                    'templateKey', role->'templateKey',
                    'toolPolicy', role->'toolPolicy',
                    'dataPolicy', role->'dataPolicy',
                    'source', 'legacy_backfilled'
                  )
                )
              END ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'participants', '[]'::jsonb)) WITH ORDINALITY AS entries(participant, ordinal)
            CROSS JOIN LATERAL (
              SELECT candidate AS role
              FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) AS roles(candidate)
              WHERE candidate->>'id' = participant->>'roleId'
              LIMIT 1
            ) AS resolved
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(state->'participants', '[]'::jsonb)) AS entries(participant)
      WHERE NOT (participant ? 'roleSnapshot')
    )
  `
}, {
  version: "008_tool_catalog_evidence_snapshot",
  sql: `
    WITH normalized_connectors AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            connector || jsonb_build_object(
              'approvedTools', normalized_tools.items,
              'toolRegistrations', CASE
                WHEN connector->>'enabled' = 'true' THEN COALESCE((
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'toolName', tool_name,
                      'displayName', tool_name,
                      'kind', 'mcp_tool',
                      'version', 'unversioned',
                      'owner', 'Platform Owner',
                      'goal', '以唯讀方式執行 ' || tool_name || '。'
                    ) ORDER BY tool_ordinal
                  )
                  FROM jsonb_array_elements_text(normalized_tools.items) WITH ORDINALITY AS tools(tool_name, tool_ordinal)
                ), '[]'::jsonb)
                ELSE '[]'::jsonb
              END
            ) ORDER BY connector_ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb))
            WITH ORDINALITY AS connectors(connector, connector_ordinal)
          CROSS JOIN LATERAL (
            SELECT COALESCE(jsonb_agg(to_jsonb(tool_name) ORDER BY first_ordinal), '[]'::jsonb) AS items
            FROM (
              SELECT btrim(tool #>> '{}') AS tool_name, min(tool_ordinal) AS first_ordinal
              FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(connector->'approvedTools') = 'array'
                  THEN connector->'approvedTools'
                  ELSE '[]'::jsonb
                END
              ) WITH ORDINALITY AS approved(tool, tool_ordinal)
              WHERE jsonb_typeof(tool) = 'string' AND btrim(tool #>> '{}') <> ''
              GROUP BY btrim(tool #>> '{}')
            ) AS unique_tools
          ) AS normalized_tools
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
    ), normalized_agents AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            agent || jsonb_build_object(
              'toolGrants', COALESCE((
                SELECT jsonb_agg(grant_entry ORDER BY grant_ordinal)
                FROM (
                  SELECT DISTINCT ON (grant_entry->>'connectorId', grant_entry->>'toolName') grant_entry, grant_ordinal
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(agent->'toolGrants') = 'array'
                      THEN agent->'toolGrants'
                      ELSE '[]'::jsonb
                    END
                  ) WITH ORDINALITY AS grants(grant_entry, grant_ordinal)
                  WHERE jsonb_typeof(grant_entry) = 'object'
                    AND jsonb_typeof(grant_entry->'connectorId') = 'string'
                    AND jsonb_typeof(grant_entry->'toolName') = 'string'
                    AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements(connectors.items) AS catalog(connector)
                      WHERE connector->>'id' = grant_entry->>'connectorId'
                        AND connector->>'enabled' = 'true'
                        AND connector->'approvedTools' ? (grant_entry->>'toolName')
                        AND EXISTS (
                          SELECT 1
                          FROM jsonb_array_elements(connector->'toolRegistrations') AS registrations(registration)
                          WHERE registration->>'toolName' = grant_entry->>'toolName'
                        )
                    )
                  ORDER BY grant_entry->>'connectorId', grant_entry->>'toolName', grant_ordinal
                ) AS unique_grants
              ), '[]'::jsonb)
            ) ORDER BY agent_ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb))
            WITH ORDINALITY AS agents(agent, agent_ordinal)
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
      JOIN normalized_connectors AS connectors USING (singleton_id)
    ), normalized_tool_runs AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            run || jsonb_build_object(
              'requestFingerprint', CASE
                WHEN jsonb_typeof(run->'requestFingerprint') = 'string' THEN run->'requestFingerprint'
                ELSE to_jsonb('legacy-unverifiable'::text)
              END,
              'toolSnapshot', CASE
                WHEN jsonb_typeof(run->'toolSnapshot') = 'object'
                  AND jsonb_typeof(run->'toolSnapshot'->'connectorName') = 'string'
                  AND jsonb_typeof(run->'toolSnapshot'->'toolName') = 'string'
                  AND jsonb_typeof(run->'toolSnapshot'->'displayName') = 'string'
                  AND jsonb_typeof(run->'toolSnapshot'->'kind') = 'string'
                  AND jsonb_typeof(run->'toolSnapshot'->'version') = 'string'
                  AND jsonb_typeof(run->'toolSnapshot'->'owner') = 'string'
                  AND jsonb_typeof(run->'toolSnapshot'->'goal') = 'string'
                THEN run->'toolSnapshot'
                ELSE jsonb_build_object(
                  'connectorName', 'Unknown legacy connector',
                  'toolName', CASE
                    WHEN jsonb_typeof(run->'toolName') = 'string' AND btrim(run->>'toolName') <> '' THEN btrim(run->>'toolName')
                    ELSE 'unknown_tool'
                  END,
                  'displayName', CASE
                    WHEN jsonb_typeof(run->'toolName') = 'string' AND btrim(run->>'toolName') <> '' THEN btrim(run->>'toolName')
                    ELSE 'unknown_tool'
                  END,
                  'kind', 'mcp_tool',
                  'version', 'legacy-unknown',
                  'owner', 'Unknown legacy owner',
                  'goal', 'Legacy Tool Run did not capture request-time metadata.'
                )
              END
            ) ORDER BY run_ordinal
          )
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(platform.state->'toolRuns') = 'array'
              THEN platform.state->'toolRuns'
              ELSE '[]'::jsonb
            END
          ) WITH ORDINALITY AS runs(run, run_ordinal)
          WHERE jsonb_typeof(run) = 'object'
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
    )
    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            jsonb_set(platform.state, '{mcpConnectors}', connectors.items, true),
            '{agents}', agents.items, true
          ),
          '{toolRuns}', tool_runs.items,
          true
        ),
        revision = revision + 1,
        updated_at = now()
    FROM normalized_connectors AS connectors
    JOIN normalized_agents AS agents USING (singleton_id)
    JOIN normalized_tool_runs AS tool_runs USING (singleton_id)
    WHERE platform.singleton_id = connectors.singleton_id
  `
}, {
  version: "009_role_version_history",
  sql: `
    SELECT singleton_id
    FROM platform_state
    WHERE singleton_id = 1
    FOR UPDATE;

    UPDATE platform_state
    SET state = jsonb_set(
          state,
          '{roles}',
          COALESCE((
            SELECT jsonb_agg(
              role || jsonb_build_object(
                'deletedAt', CASE
                  WHEN jsonb_typeof(role->'deletedAt') IN ('string', 'null') THEN role->'deletedAt'
                  ELSE 'null'::jsonb
                END
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) WITH ORDINALITY AS entries(role, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(state->'roles', '[]'::jsonb)) AS entries(role)
      WHERE NOT (role ? 'deletedAt') OR jsonb_typeof(role->'deletedAt') NOT IN ('string', 'null')
    );

    CREATE TABLE IF NOT EXISTS role_versions (
      role_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (role_id, version)
    );

    CREATE TEMP TABLE role_version_candidates ON COMMIT DROP AS
    WITH candidates AS (
      SELECT
        (role->>'id')::uuid AS role_id,
        (role->>'version')::integer AS version,
        jsonb_build_object(
          'roleId', role->'id',
          'version', role->'version',
          'name', role->'name',
          'responsibility', role->'responsibility',
          'speakingGuidance', role->'speakingGuidance',
          'decisionScope', role->'decisionScope',
          'constraints', role->'constraints',
          'templateKey', role->'templateKey',
          'toolPolicy', role->'toolPolicy',
          'dataPolicy', role->'dataPolicy'
        ) AS definition
      FROM platform_state AS platform
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS roles(role)
      UNION ALL
      SELECT
        (snapshot->>'roleId')::uuid AS role_id,
        (snapshot->>'version')::integer AS version,
        jsonb_build_object(
          'roleId', snapshot->'roleId',
          'version', snapshot->'version',
          'name', snapshot->'name',
          'responsibility', snapshot->'responsibility',
          'speakingGuidance', snapshot->'speakingGuidance',
          'decisionScope', snapshot->'decisionScope',
          'constraints', snapshot->'constraints',
          'templateKey', snapshot->'templateKey',
          'toolPolicy', snapshot->'toolPolicy',
          'dataPolicy', snapshot->'dataPolicy'
        ) AS definition
      FROM platform_state AS platform
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
      CROSS JOIN LATERAL (SELECT participant->'roleSnapshot' AS snapshot) AS snapshots
      WHERE jsonb_typeof(snapshot) = 'object'
    )
    SELECT role_id, version, definition FROM candidates;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM role_version_candidates
        GROUP BY role_id, version
        HAVING count(DISTINCT definition) > 1
      ) THEN
        RAISE EXCEPTION 'Conflicting Role version definitions detected during migration.';
      END IF;
    END $$;

    INSERT INTO role_versions(role_id, version, snapshot, created_at)
    SELECT
      role_id,
      version,
      definition || jsonb_build_object(
        'source', 'legacy_backfilled',
        'restoredFromVersion', null,
        'recordedAt', now()
      ),
      now()
    FROM (
      SELECT DISTINCT ON (role_id, version) role_id, version, definition
      FROM role_version_candidates
      ORDER BY role_id, version
    ) AS known_versions
    ON CONFLICT (role_id, version) DO NOTHING
  `
}, {
  version: "010_role_usage_context",
  sql: `
    SELECT singleton_id
    FROM platform_state
    WHERE singleton_id = 1
    FOR UPDATE;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
        WHERE jsonb_typeof(participant->'roleSnapshot') IS DISTINCT FROM 'object'
      ) THEN
        RAISE EXCEPTION 'Cannot backfill Role usage context with an invalid Participant Role snapshot.';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS roles(role)
        WHERE (jsonb_typeof(role->'usageContext') IS DISTINCT FROM 'string' OR btrim(role->>'usageContext') = '')
          AND COALESCE(role->>'templateKey', '') NOT IN ('platform_architect', 'meeting_chair', 'security_reviewer', 'evidence_analyst')
          AND (jsonb_typeof(role->'responsibility') IS DISTINCT FROM 'string' OR btrim(role->>'responsibility') = '')
      ) THEN
        RAISE EXCEPTION 'Cannot backfill a custom Role usage context without its own responsibility.';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
        CROSS JOIN LATERAL (SELECT participant->'roleSnapshot' AS snapshot) AS snapshots
        WHERE (jsonb_typeof(snapshot->'usageContext') IS DISTINCT FROM 'string' OR btrim(snapshot->>'usageContext') = '')
          AND COALESCE(snapshot->>'templateKey', '') NOT IN ('platform_architect', 'meeting_chair', 'security_reviewer', 'evidence_analyst')
          AND (jsonb_typeof(snapshot->'responsibility') IS DISTINCT FROM 'string' OR btrim(snapshot->>'responsibility') = '')
      ) THEN
        RAISE EXCEPTION 'Cannot backfill a custom Meeting Role usage context without its snapshotted responsibility.';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM role_versions
        WHERE (jsonb_typeof(snapshot->'usageContext') IS DISTINCT FROM 'string' OR btrim(snapshot->>'usageContext') = '')
          AND COALESCE(snapshot->>'templateKey', '') NOT IN ('platform_architect', 'meeting_chair', 'security_reviewer', 'evidence_analyst')
          AND (jsonb_typeof(snapshot->'responsibility') IS DISTINCT FROM 'string' OR btrim(snapshot->>'responsibility') = '')
      ) THEN
        RAISE EXCEPTION 'Cannot backfill a custom Role version usage context without its recorded responsibility.';
      END IF;
    END $$;

    CREATE TEMP TABLE role_usage_context_candidates ON COMMIT DROP AS
    WITH candidates AS (
      SELECT
        (role->>'id')::uuid AS role_id,
        (role->>'version')::integer AS version,
        jsonb_build_object(
          'roleId', role->'id',
          'version', role->'version',
          'name', role->'name',
          'usageContext', CASE
            WHEN jsonb_typeof(role->'usageContext') = 'string' AND btrim(role->>'usageContext') <> '' THEN role->>'usageContext'
            WHEN role->>'templateKey' = 'platform_architect' THEN '用於架構邊界、整合取捨與技術方案評審。'
            WHEN role->>'templateKey' = 'meeting_chair' THEN '用於需要控制議程、發言秩序與時間的會議。'
            WHEN role->>'templateKey' = 'security_reviewer' THEN '用於權限、資料、供應鏈與外部整合風險審查。'
            WHEN role->>'templateKey' = 'evidence_analyst' THEN '用於彙整來源、驗證主張與指出證據缺口。'
            ELSE btrim(role->>'responsibility')
          END,
          'responsibility', role->'responsibility',
          'speakingGuidance', role->'speakingGuidance',
          'decisionScope', role->'decisionScope',
          'constraints', role->'constraints',
          'templateKey', role->'templateKey',
          'toolPolicy', role->'toolPolicy',
          'dataPolicy', role->'dataPolicy'
        ) AS definition
      FROM platform_state AS platform
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS roles(role)
      UNION ALL
      SELECT
        (snapshot->>'roleId')::uuid AS role_id,
        (snapshot->>'version')::integer AS version,
        jsonb_build_object(
          'roleId', snapshot->'roleId',
          'version', snapshot->'version',
          'name', snapshot->'name',
          'usageContext', CASE
            WHEN jsonb_typeof(snapshot->'usageContext') = 'string' AND btrim(snapshot->>'usageContext') <> '' THEN snapshot->>'usageContext'
            WHEN snapshot->>'templateKey' = 'platform_architect' THEN '用於架構邊界、整合取捨與技術方案評審。'
            WHEN snapshot->>'templateKey' = 'meeting_chair' THEN '用於需要控制議程、發言秩序與時間的會議。'
            WHEN snapshot->>'templateKey' = 'security_reviewer' THEN '用於權限、資料、供應鏈與外部整合風險審查。'
            WHEN snapshot->>'templateKey' = 'evidence_analyst' THEN '用於彙整來源、驗證主張與指出證據缺口。'
            ELSE btrim(snapshot->>'responsibility')
          END,
          'responsibility', snapshot->'responsibility',
          'speakingGuidance', snapshot->'speakingGuidance',
          'decisionScope', snapshot->'decisionScope',
          'constraints', snapshot->'constraints',
          'templateKey', snapshot->'templateKey',
          'toolPolicy', snapshot->'toolPolicy',
          'dataPolicy', snapshot->'dataPolicy'
        ) AS definition
      FROM platform_state AS platform
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
      CROSS JOIN LATERAL (SELECT participant->'roleSnapshot' AS snapshot) AS snapshots
      UNION ALL
      SELECT
        role_id,
        version,
        jsonb_build_object(
          'roleId', snapshot->'roleId',
          'version', snapshot->'version',
          'name', snapshot->'name',
          'usageContext', CASE
            WHEN jsonb_typeof(snapshot->'usageContext') = 'string' AND btrim(snapshot->>'usageContext') <> '' THEN snapshot->>'usageContext'
            WHEN snapshot->>'templateKey' = 'platform_architect' THEN '用於架構邊界、整合取捨與技術方案評審。'
            WHEN snapshot->>'templateKey' = 'meeting_chair' THEN '用於需要控制議程、發言秩序與時間的會議。'
            WHEN snapshot->>'templateKey' = 'security_reviewer' THEN '用於權限、資料、供應鏈與外部整合風險審查。'
            WHEN snapshot->>'templateKey' = 'evidence_analyst' THEN '用於彙整來源、驗證主張與指出證據缺口。'
            ELSE btrim(snapshot->>'responsibility')
          END,
          'responsibility', snapshot->'responsibility',
          'speakingGuidance', snapshot->'speakingGuidance',
          'decisionScope', snapshot->'decisionScope',
          'constraints', snapshot->'constraints',
          'templateKey', snapshot->'templateKey',
          'toolPolicy', snapshot->'toolPolicy',
          'dataPolicy', snapshot->'dataPolicy'
        ) AS definition
      FROM role_versions
    )
    SELECT role_id, version, definition FROM candidates;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM role_usage_context_candidates
        GROUP BY role_id, version
        HAVING count(DISTINCT definition) > 1
      ) THEN
        RAISE EXCEPTION 'Conflicting Role version definitions detected during usage context migration.';
      END IF;
    END $$;

    WITH normalized_roles AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            role || jsonb_build_object(
              'usageContext', CASE
                WHEN jsonb_typeof(role->'usageContext') = 'string' AND btrim(role->>'usageContext') <> ''
                  THEN role->>'usageContext'
                WHEN role->>'templateKey' = 'platform_architect'
                  THEN '用於架構邊界、整合取捨與技術方案評審。'
                WHEN role->>'templateKey' = 'meeting_chair'
                  THEN '用於需要控制議程、發言秩序與時間的會議。'
                WHEN role->>'templateKey' = 'security_reviewer'
                  THEN '用於權限、資料、供應鏈與外部整合風險審查。'
                WHEN role->>'templateKey' = 'evidence_analyst'
                  THEN '用於彙整來源、驗證主張與指出證據缺口。'
                ELSE btrim(role->>'responsibility')
              END
            ) ORDER BY ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) WITH ORDINALITY AS roles(role, ordinal)
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
    ), normalized_participants AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_set(
              participant,
              '{roleSnapshot}',
              participant->'roleSnapshot' || jsonb_build_object(
                'usageContext', CASE
                  WHEN jsonb_typeof(participant->'roleSnapshot'->'usageContext') = 'string'
                    AND btrim(participant->'roleSnapshot'->>'usageContext') <> ''
                    THEN participant->'roleSnapshot'->>'usageContext'
                  WHEN participant->'roleSnapshot'->>'templateKey' = 'platform_architect'
                    THEN '用於架構邊界、整合取捨與技術方案評審。'
                  WHEN participant->'roleSnapshot'->>'templateKey' = 'meeting_chair'
                    THEN '用於需要控制議程、發言秩序與時間的會議。'
                  WHEN participant->'roleSnapshot'->>'templateKey' = 'security_reviewer'
                    THEN '用於權限、資料、供應鏈與外部整合風險審查。'
                  WHEN participant->'roleSnapshot'->>'templateKey' = 'evidence_analyst'
                    THEN '用於彙整來源、驗證主張與指出證據缺口。'
                  ELSE btrim(participant->'roleSnapshot'->>'responsibility')
                END
              ),
              true
            ) ORDER BY ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) WITH ORDINALITY AS participants(participant, ordinal)
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
    )
    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(platform.state, '{roles}', roles.items, true),
          '{participants}', participants.items, true
        ),
        revision = revision + 1,
        updated_at = now()
    FROM normalized_roles AS roles
    JOIN normalized_participants AS participants USING (singleton_id)
    WHERE platform.singleton_id = roles.singleton_id
      AND (
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS entries(role)
          WHERE jsonb_typeof(role->'usageContext') IS DISTINCT FROM 'string'
             OR btrim(role->>'usageContext') = ''
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS entries(participant)
          WHERE jsonb_typeof(participant->'roleSnapshot'->'usageContext') IS DISTINCT FROM 'string'
             OR btrim(participant->'roleSnapshot'->>'usageContext') = ''
        )
      );

    UPDATE role_versions
    SET snapshot = snapshot || jsonb_build_object(
          'usageContext', CASE
            WHEN jsonb_typeof(snapshot->'usageContext') = 'string' AND btrim(snapshot->>'usageContext') <> ''
              THEN snapshot->>'usageContext'
            WHEN snapshot->>'templateKey' = 'platform_architect'
              THEN '用於架構邊界、整合取捨與技術方案評審。'
            WHEN snapshot->>'templateKey' = 'meeting_chair'
              THEN '用於需要控制議程、發言秩序與時間的會議。'
            WHEN snapshot->>'templateKey' = 'security_reviewer'
              THEN '用於權限、資料、供應鏈與外部整合風險審查。'
            WHEN snapshot->>'templateKey' = 'evidence_analyst'
              THEN '用於彙整來源、驗證主張與指出證據缺口。'
            ELSE btrim(snapshot->>'responsibility')
          END
        )
    WHERE jsonb_typeof(snapshot->'usageContext') IS DISTINCT FROM 'string'
       OR btrim(snapshot->>'usageContext') = ''
  `
}, {
  version: "011_meeting_agenda_snapshot",
  validate: validateMeetingAgendaMigration,
  sql: `
    SELECT singleton_id
    FROM platform_state
    WHERE singleton_id = 1
    FOR UPDATE;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state
        WHERE jsonb_typeof(state->'meetings') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Meeting Agenda detected during migration.';
      END IF;

      IF EXISTS (
        WITH meeting_agenda_candidates AS (
          SELECT meeting
          FROM platform_state AS platform
          CROSS JOIN LATERAL jsonb_array_elements(platform.state->'meetings') AS meetings(meeting)
          WHERE meeting ? 'agenda'
        )
        SELECT 1
        FROM meeting_agenda_candidates AS candidate
        WHERE jsonb_typeof(candidate.meeting->'agenda') IS DISTINCT FROM 'object'
           OR jsonb_typeof(candidate.meeting->'agenda'->'revision') IS DISTINCT FROM 'number'
           OR CASE
                WHEN jsonb_typeof(candidate.meeting->'agenda'->'revision') = 'number'
                  THEN (candidate.meeting->'agenda'->>'revision')::numeric < 0
                    OR trunc((candidate.meeting->'agenda'->>'revision')::numeric) <> (candidate.meeting->'agenda'->>'revision')::numeric
                ELSE false
              END
           OR jsonb_typeof(candidate.meeting->'agenda'->'items') IS DISTINCT FROM 'array'
           OR CASE
                WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                  THEN jsonb_array_length(candidate.meeting->'agenda'->'items') > 12
                ELSE false
              END
           OR ((candidate.meeting->'agenda') - 'revision' - 'items') <> '{}'::jsonb
           OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) AS entries(item)
                WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
                   OR (item - ARRAY[
                        'id', 'title', 'description', 'position', 'status',
                        'createdAt', 'updatedAt', 'startedAt', 'resolvedAt'
                      ]) <> '{}'::jsonb
                   OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
                   OR (item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                   OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
                   OR btrim(item->>'title') = ''
                   OR char_length(item->>'title') > 160
                   OR jsonb_typeof(item->'description') IS DISTINCT FROM 'string'
                   OR char_length(item->>'description') > 1000
                   OR jsonb_typeof(item->'position') IS DISTINCT FROM 'number'
                   OR CASE
                        WHEN jsonb_typeof(item->'position') = 'number'
                          THEN (item->>'position')::numeric < 0
                            OR (item->>'position')::numeric > 11
                            OR trunc((item->>'position')::numeric) <> (item->>'position')::numeric
                        ELSE false
                      END
                   OR jsonb_typeof(item->'status') IS DISTINCT FROM 'string'
                   OR item->>'status' NOT IN ('pending', 'current', 'completed', 'skipped')
                   OR jsonb_typeof(item->'createdAt') IS DISTINCT FROM 'string'
                   OR jsonb_typeof(item->'updatedAt') IS DISTINCT FROM 'string'
                   OR (
                        jsonb_typeof(item->'startedAt') IS DISTINCT FROM 'string'
                        AND jsonb_typeof(item->'startedAt') IS DISTINCT FROM 'null'
                      )
                   OR (
                        jsonb_typeof(item->'resolvedAt') IS DISTINCT FROM 'string'
                        AND jsonb_typeof(item->'resolvedAt') IS DISTINCT FROM 'null'
                      )
                   OR (item->>'status' = 'pending' AND (
                        jsonb_typeof(item->'startedAt') IS DISTINCT FROM 'null'
                        OR jsonb_typeof(item->'resolvedAt') IS DISTINCT FROM 'null'
                      ))
                   OR (item->>'status' = 'current' AND (
                        jsonb_typeof(item->'startedAt') IS DISTINCT FROM 'string'
                        OR jsonb_typeof(item->'resolvedAt') IS DISTINCT FROM 'null'
                      ))
                   OR (item->>'status' IN ('completed', 'skipped')
                        AND jsonb_typeof(item->'resolvedAt') IS DISTINCT FROM 'string')
              )
           OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) WITH ORDINALITY AS entries(item, ordinal)
                WHERE CASE
                  WHEN jsonb_typeof(item->'position') = 'number'
                    AND (item->>'position') ~ '^[0-9]+$'
                    THEN (item->>'position')::integer <> ordinal - 1
                  ELSE false
                END
              )
           OR (
                SELECT count(*) <> count(DISTINCT item->>'id')
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) AS entries(item)
              )
           OR (
                SELECT count(*) <> count(DISTINCT lower(btrim(item->>'title')))
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) AS entries(item)
              )
           OR (
                SELECT count(*) FILTER (WHERE item->>'status' = 'current') > 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) AS entries(item)
              )
           OR EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) WITH ORDINALITY AS earlier(item, ordinal)
                CROSS JOIN LATERAL jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(candidate.meeting->'agenda'->'items') = 'array'
                      THEN candidate.meeting->'agenda'->'items'
                    ELSE '[]'::jsonb
                  END
                ) WITH ORDINALITY AS later(item, ordinal)
                WHERE earlier.ordinal < later.ordinal
                  AND CASE earlier.item->>'status'
                        WHEN 'completed' THEN 0
                        WHEN 'skipped' THEN 0
                        WHEN 'current' THEN 1
                        WHEN 'pending' THEN 2
                        ELSE 0
                      END
                    > CASE later.item->>'status'
                        WHEN 'completed' THEN 0
                        WHEN 'skipped' THEN 0
                        WHEN 'current' THEN 1
                        WHEN 'pending' THEN 2
                        ELSE 0
                      END
              )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Meeting Agenda detected during migration.';
      END IF;
    END $$;

    WITH meeting_agenda_candidates AS (
      SELECT
        platform.singleton_id,
        COALESCE(jsonb_agg(
          CASE
            WHEN meeting ? 'agenda' THEN meeting
            ELSE meeting || jsonb_build_object(
              'agenda', jsonb_build_object('revision', 0, 'items', '[]'::jsonb)
            )
          END ORDER BY ordinal
        ), '[]'::jsonb) AS meetings,
        COALESCE(bool_or(NOT (meeting ? 'agenda')), false) AS changed
      FROM platform_state AS platform
      CROSS JOIN LATERAL jsonb_array_elements(platform.state->'meetings') WITH ORDINALITY AS meetings(meeting, ordinal)
      GROUP BY platform.singleton_id
    )
    UPDATE platform_state AS platform
    SET state = jsonb_set(platform.state, '{meetings}', candidates.meetings, true),
        revision = revision + 1,
        updated_at = now()
    FROM meeting_agenda_candidates AS candidates
    WHERE platform.singleton_id = candidates.singleton_id
      AND candidates.changed
  `
}, {
  version: "012_participant_role_history_and_speaker_queue",
  sql: `
    SELECT singleton_id
    FROM platform_state
    WHERE singleton_id = 1
    FOR UPDATE;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state
        WHERE state ? 'speakerQueue'
          AND jsonb_typeof(state->'speakerQueue') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Speaker Queue detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
        WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
          OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'jobId') IS DISTINCT FROM 'string'
          OR item->>'id' <> item->>'jobId'
          OR btrim(COALESCE(item->>'jobId', '')) = ''
          OR jsonb_typeof(item->'meetingId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'participantId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'agentId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'roleId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'roleName') IS DISTINCT FROM 'string'
          OR jsonb_typeof(item->'roleRevision') IS DISTINCT FROM 'number'
          OR trunc((item->>'roleRevision')::numeric) <> (item->>'roleRevision')::numeric
          OR (item->>'roleRevision')::numeric < 1
          OR jsonb_typeof(item->'roleVersion') IS DISTINCT FROM 'number'
          OR trunc((item->>'roleVersion')::numeric) <> (item->>'roleVersion')::numeric
          OR (item->>'roleVersion')::numeric < 1
          OR jsonb_typeof(item->'agendaRevision') IS DISTINCT FROM 'number'
          OR trunc((item->>'agendaRevision')::numeric) <> (item->>'agendaRevision')::numeric
          OR (item->>'agendaRevision')::numeric < 0
          OR NOT (item ? 'agendaCurrentItemId')
          OR (item->'agendaCurrentItemId' <> 'null'::jsonb AND jsonb_typeof(item->'agendaCurrentItemId') IS DISTINCT FROM 'string')
          OR COALESCE(item->>'status', '') NOT IN ('queued', 'running')
          OR jsonb_typeof(item->'requestedAt') IS DISTINCT FROM 'string'
          OR (item->>'requestedAt') !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$'
          OR NOT (item ? 'startedAt')
          OR (item->>'status' = 'queued' AND item->'startedAt' <> 'null'::jsonb)
          OR (item->>'status' = 'running' AND jsonb_typeof(item->'startedAt') IS DISTINCT FROM 'string')
          OR (item ? 'kind' AND COALESCE(item->>'kind', '') NOT IN ('agent_turn', 'mcp_tool_call'))
          OR (item ? 'label' AND (jsonb_typeof(item->'label') IS DISTINCT FROM 'string' OR btrim(item->>'label') = ''))
          OR (item ? 'leaseExpiresAt' AND (
            jsonb_typeof(item->'leaseExpiresAt') IS DISTINCT FROM 'string'
            OR (item->>'leaseExpiresAt') !~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,6})?Z$'
            OR (item->>'leaseExpiresAt')::timestamptz <= (item->>'requestedAt')::timestamptz
          ))
      ) THEN
        RAISE EXCEPTION 'Invalid existing Speaker Queue item detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb)) AS meetings(meeting)
          WHERE meeting->>'id' = item->>'meetingId' AND meeting->>'state' = 'active'
        ) OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
          WHERE participant->>'id' = item->>'participantId'
            AND participant->>'meetingId' = item->>'meetingId'
            AND participant->>'agentId' = item->>'agentId'
            AND participant->>'roleId' = item->>'roleId'
            AND COALESCE((participant->>'roleRevision')::numeric, 1) = (item->>'roleRevision')::numeric
            AND (participant->'roleSnapshot'->>'version')::numeric = (item->>'roleVersion')::numeric
        )
      ) THEN
        RAISE EXCEPTION 'Speaker Queue references a stale Meeting, Participant, or Role binding.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
        GROUP BY platform.singleton_id, item->>'meetingId'
        HAVING count(*) > 1
      ) OR EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
        GROUP BY platform.singleton_id, item->>'jobId'
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Speaker Queue contains duplicate Meeting or job reservations.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state
        WHERE jsonb_typeof(state->'participants') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Participant assignments detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'participants') AS entries(participant)
        WHERE jsonb_typeof(participant->'roleSnapshot') IS DISTINCT FROM 'object'
      ) THEN
        RAISE EXCEPTION 'Cannot backfill Participant Role history without a Role snapshot.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'participants') AS entries(participant)
        WHERE participant ? 'roleRevision'
          AND (
            jsonb_typeof(participant->'roleRevision') IS DISTINCT FROM 'number'
            OR CASE
              WHEN jsonb_typeof(participant->'roleRevision') = 'number' THEN
                trunc((participant->>'roleRevision')::numeric) <> (participant->>'roleRevision')::numeric
                OR (participant->>'roleRevision')::numeric < 1
              ELSE false
            END
          )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Participant Role revision detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'participants') AS entries(participant)
        WHERE participant ? 'roleHistory'
          AND jsonb_typeof(participant->'roleHistory') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Participant Role history detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'participants') AS participants(participant)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(participant->'roleHistory', '[]'::jsonb)) AS histories(history)
        WHERE jsonb_typeof(history) IS DISTINCT FROM 'object'
          OR jsonb_typeof(history->'revision') IS DISTINCT FROM 'number'
          OR trunc((history->>'revision')::numeric) <> (history->>'revision')::numeric
          OR (history->>'revision')::numeric < 1
          OR jsonb_typeof(history->'roleId') IS DISTINCT FROM 'string'
          OR jsonb_typeof(history->'roleSnapshot') IS DISTINCT FROM 'object'
          OR history->>'roleId' <> history->'roleSnapshot'->>'roleId'
          OR COALESCE(history->>'changedBy', '') NOT IN ('owner', 'system')
          OR jsonb_typeof(history->'changedAt') IS DISTINCT FROM 'string'
          OR jsonb_typeof(history->'reason') IS DISTINCT FROM 'string'
          OR btrim(history->>'reason') = ''
      ) THEN
        RAISE EXCEPTION 'Invalid Participant Role history entry detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'participants') AS participants(participant)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(participant->'roleHistory', '[]'::jsonb)) AS histories(history)
        GROUP BY platform.singleton_id, participant->>'id', history->>'revision'
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Participant Role history contains duplicate revisions.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'participants') AS participants(participant)
        WHERE jsonb_array_length(COALESCE(participant->'roleHistory', '[]'::jsonb)) > 0
          AND (
            COALESCE((participant->>'roleRevision')::numeric, (
              participant->'roleHistory'->(jsonb_array_length(participant->'roleHistory') - 1)->>'revision'
            )::numeric) <> (
              participant->'roleHistory'->(jsonb_array_length(participant->'roleHistory') - 1)->>'revision'
            )::numeric
            OR participant->>'roleId' <> participant->'roleHistory'->(jsonb_array_length(participant->'roleHistory') - 1)->>'roleId'
            OR participant->'roleSnapshot' <> participant->'roleHistory'->(jsonb_array_length(participant->'roleHistory') - 1)->'roleSnapshot'
          )
      ) THEN
        RAISE EXCEPTION 'Participant Role history does not match the current Role binding.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            platform.state,
            '{participants}',
            COALESCE((
              SELECT jsonb_agg(
                participant || jsonb_build_object(
                  'roleRevision', CASE
                    WHEN participant ? 'roleRevision' THEN participant->'roleRevision'
                    ELSE '1'::jsonb
                  END,
                  'roleHistory', CASE
                    WHEN participant ? 'roleHistory'
                      AND jsonb_array_length(participant->'roleHistory') > 0
                      THEN participant->'roleHistory'
                    ELSE jsonb_build_array(jsonb_build_object(
                      'revision', CASE
                        WHEN participant ? 'roleRevision' THEN participant->'roleRevision'
                        ELSE '1'::jsonb
                      END,
                      'roleId', participant->'roleSnapshot'->'roleId',
                      'roleSnapshot', participant->'roleSnapshot',
                      'changedAt', COALESCE(
                        NULLIF((
                          SELECT meeting->>'createdAt'
                          FROM jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb)) AS meetings(meeting)
                          WHERE meeting->>'id' = participant->>'meetingId'
                          LIMIT 1
                        ), ''),
                        to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                      ),
                      'changedBy', 'system',
                      'reason', 'Migration 012 initialized the participant Role revision and history.'
                    ))
                  END
                ) ORDER BY ordinal
              )
              FROM jsonb_array_elements(platform.state->'participants') WITH ORDINALITY AS entries(participant, ordinal)
            ), '[]'::jsonb),
            true
          ),
          '{speakerQueue}',
          COALESCE((
            SELECT jsonb_agg(
              item || jsonb_build_object(
                'kind', COALESCE(item->>'kind', 'agent_turn'),
                'label', COALESCE(NULLIF(item->>'label', ''), (item->>'roleName') || ' 發言'),
                'toolName', CASE WHEN COALESCE(item->>'kind', 'agent_turn') = 'mcp_tool_call' THEN item->'toolName' ELSE 'null'::jsonb END,
                'leaseExpiresAt', COALESCE(item->'leaseExpiresAt', to_jsonb(to_char(
                  ((item->>'requestedAt')::timestamptz + CASE WHEN item->>'status' = 'running' THEN interval '30 minutes' ELSE interval '5 minutes' END) AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                )))
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) WITH ORDINALITY AS queue_entries(item, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (platform.state ? 'speakerQueue')
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS queue_entries(item)
         WHERE NOT (item ? 'kind' AND item ? 'label' AND item ? 'toolName' AND item ? 'leaseExpiresAt')
       )
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(platform.state->'participants') AS entries(participant)
         WHERE NOT (
           participant ? 'roleRevision'
           AND participant ? 'roleHistory'
           AND jsonb_array_length(participant->'roleHistory') > 0
         )
       )
  `
}, {
  version: "013_chair_automation_level",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state
        WHERE jsonb_typeof(state->'meetings') IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Meetings collection detected during Chair automation migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(platform.state->'meetings') AS entries(meeting)
        WHERE meeting ? 'automation'
          AND (
            jsonb_typeof(meeting->'automation') IS DISTINCT FROM 'string'
            OR COALESCE(meeting->>'automation', '') NOT IN ('manual', 'suggest', 'auto')
          )
          OR meeting ? 'automationRevision'
          AND (
            jsonb_typeof(meeting->'automationRevision') IS DISTINCT FROM 'number'
            OR CASE
              WHEN jsonb_typeof(meeting->'automationRevision') = 'number' THEN
                trunc((meeting->>'automationRevision')::numeric) <> (meeting->>'automationRevision')::numeric
                OR (meeting->>'automationRevision')::numeric < 0
              ELSE false
            END
          )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Chair automation level detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
        WHERE (
          item ? 'requestedBy' AND COALESCE(item->>'requestedBy', '') NOT IN ('owner', 'system')
          OR item ? 'chairSuggestionId' AND item->'chairSuggestionId' <> 'null'::jsonb
            AND jsonb_typeof(item->'chairSuggestionId') IS DISTINCT FROM 'string'
          OR item ? 'automationRevision' AND item->'automationRevision' <> 'null'::jsonb
            AND (
              jsonb_typeof(item->'automationRevision') IS DISTINCT FROM 'number'
              OR CASE
                WHEN jsonb_typeof(item->'automationRevision') = 'number' THEN
                  trunc((item->>'automationRevision')::numeric) <> (item->>'automationRevision')::numeric
                  OR (item->>'automationRevision')::numeric < 0
                ELSE false
              END
            )
          OR COALESCE(item->>'requestedBy', 'owner') = 'system'
            AND (
              jsonb_typeof(item->'chairSuggestionId') IS DISTINCT FROM 'string'
              OR btrim(COALESCE(item->>'chairSuggestionId', '')) = ''
              OR jsonb_typeof(item->'automationRevision') IS DISTINCT FROM 'number'
              OR CASE
                WHEN jsonb_typeof(item->'automationRevision') = 'number' THEN
                  trunc((item->>'automationRevision')::numeric) <> (item->>'automationRevision')::numeric
                  OR (item->>'automationRevision')::numeric < 0
                ELSE true
              END
            )
        )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Speaker Queue Chair automation binding detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            platform.state,
            '{meetings}',
            COALESCE((
              SELECT jsonb_agg(
                meeting || jsonb_build_object(
                  'automation', COALESCE(meeting->'automation', '"suggest"'::jsonb),
                  'automationRevision', COALESCE(meeting->'automationRevision', '0'::jsonb)
                )
                ORDER BY ordinal
              )
              FROM jsonb_array_elements(platform.state->'meetings') WITH ORDINALITY AS entries(meeting, ordinal)
            ), '[]'::jsonb),
            true
          ),
          '{speakerQueue}',
          COALESCE((
            SELECT jsonb_agg(
              item || jsonb_build_object(
                'requestedBy', COALESCE(item->'requestedBy', '"owner"'::jsonb),
                'chairSuggestionId', COALESCE(item->'chairSuggestionId', 'null'::jsonb),
                'automationRevision', COALESCE(item->'automationRevision', 'null'::jsonb)
              )
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb))
              WITH ORDINALITY AS entries(item, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(platform.state->'meetings') AS entries(meeting)
      WHERE NOT (meeting ? 'automation' AND meeting ? 'automationRevision')
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
      WHERE NOT (item ? 'requestedBy' AND item ? 'chairSuggestionId' AND item ? 'automationRevision')
    )
  `
}, {
  version: "014_task_agent_execution",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state
        WHERE jsonb_typeof(COALESCE(state->'tasks', '[]'::jsonb)) IS DISTINCT FROM 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Tasks collection detected during Task Agent execution migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) AS entries(task)
        WHERE task ? 'execution'
          AND (
            jsonb_typeof(task->'execution') IS DISTINCT FROM 'object'
            OR NOT (task->'execution' ?& ARRAY[
              'revision', 'status', 'jobId', 'requestFingerprint', 'agentId', 'profile', 'attemptCount',
              'requestedAt', 'startedAt', 'completedAt', 'lastError', 'resultEvidenceId'
            ])
            OR jsonb_typeof(task->'execution'->'revision') IS DISTINCT FROM 'number'
            OR CASE WHEN jsonb_typeof(task->'execution'->'revision') = 'number' THEN
              trunc((task->'execution'->>'revision')::numeric) <> (task->'execution'->>'revision')::numeric
              OR (task->'execution'->>'revision')::numeric < 0
            ELSE false END
            OR jsonb_typeof(task->'execution'->'attemptCount') IS DISTINCT FROM 'number'
            OR CASE WHEN jsonb_typeof(task->'execution'->'attemptCount') = 'number' THEN
              trunc((task->'execution'->>'attemptCount')::numeric) <> (task->'execution'->>'attemptCount')::numeric
              OR (task->'execution'->>'attemptCount')::numeric < 0
            ELSE false END
            OR COALESCE(task->'execution'->>'status', '') NOT IN ('idle', 'queued', 'running', 'completed', 'failed')
            OR jsonb_typeof(task->'execution'->'jobId') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'requestFingerprint') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'agentId') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'profile') NOT IN ('string', 'null')
            OR task->'execution'->'profile' <> 'null'::jsonb
              AND COALESCE(task->'execution'->>'profile', '') NOT IN ('advisor', 'worker')
            OR jsonb_typeof(task->'execution'->'requestedAt') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'startedAt') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'completedAt') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'lastError') NOT IN ('string', 'null')
            OR jsonb_typeof(task->'execution'->'resultEvidenceId') NOT IN ('string', 'null')
            OR task->'execution'->>'status' = 'idle' AND (
              task->'execution'->'jobId' <> 'null'::jsonb
              OR task->'execution'->'requestFingerprint' <> 'null'::jsonb
              OR task->'execution'->'agentId' <> 'null'::jsonb
              OR task->'execution'->'profile' <> 'null'::jsonb
              OR task->'execution'->'requestedAt' <> 'null'::jsonb
              OR task->'execution'->'startedAt' <> 'null'::jsonb
              OR task->'execution'->'completedAt' <> 'null'::jsonb
              OR task->'execution'->'lastError' <> 'null'::jsonb
              OR task->'execution'->'resultEvidenceId' <> 'null'::jsonb
            )
            OR task->'execution'->>'status' IN ('queued', 'running', 'completed', 'failed') AND (
              jsonb_typeof(task->'execution'->'jobId') IS DISTINCT FROM 'string'
              OR btrim(COALESCE(task->'execution'->>'jobId', '')) = ''
              OR jsonb_typeof(task->'execution'->'requestFingerprint') IS DISTINCT FROM 'string'
              OR btrim(COALESCE(task->'execution'->>'requestFingerprint', '')) = ''
              OR jsonb_typeof(task->'execution'->'agentId') IS DISTINCT FROM 'string'
              OR btrim(COALESCE(task->'execution'->>'agentId', '')) = ''
              OR COALESCE(task->'execution'->>'profile', '') NOT IN ('advisor', 'worker')
              OR jsonb_typeof(task->'execution'->'requestedAt') IS DISTINCT FROM 'string'
            )
            OR task->'execution'->>'status' = 'queued' AND (
              task->'execution'->'startedAt' <> 'null'::jsonb
              OR task->'execution'->'completedAt' <> 'null'::jsonb
              OR task->'execution'->'lastError' <> 'null'::jsonb
              OR task->'execution'->'resultEvidenceId' <> 'null'::jsonb
            )
            OR task->'execution'->>'status' = 'running' AND (
              jsonb_typeof(task->'execution'->'startedAt') IS DISTINCT FROM 'string'
              OR task->'execution'->'completedAt' <> 'null'::jsonb
              OR task->'execution'->'lastError' <> 'null'::jsonb
              OR task->'execution'->'resultEvidenceId' <> 'null'::jsonb
            )
            OR task->'execution'->>'status' = 'completed' AND (
              jsonb_typeof(task->'execution'->'startedAt') IS DISTINCT FROM 'string'
              OR jsonb_typeof(task->'execution'->'completedAt') IS DISTINCT FROM 'string'
              OR task->'execution'->'lastError' <> 'null'::jsonb
              OR jsonb_typeof(task->'execution'->'resultEvidenceId') IS DISTINCT FROM 'string'
            )
            OR task->'execution'->>'status' = 'failed' AND (
              jsonb_typeof(task->'execution'->'startedAt') IS DISTINCT FROM 'string'
              OR jsonb_typeof(task->'execution'->'completedAt') IS DISTINCT FROM 'string'
              OR jsonb_typeof(task->'execution'->'lastError') IS DISTINCT FROM 'string'
              OR task->'execution'->'resultEvidenceId' <> 'null'::jsonb
            )
          )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Task Agent execution state detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          platform.state,
          '{tasks}',
          COALESCE((
            SELECT jsonb_agg(
              task
              || jsonb_build_object(
                'execution', COALESCE(task->'execution', jsonb_build_object(
                  'revision', 0,
                  'status', 'idle',
                  'jobId', null,
                  'requestFingerprint', null,
                  'agentId', null,
                  'profile', null,
                  'attemptCount', 0,
                  'requestedAt', null,
                  'startedAt', null,
                  'completedAt', null,
                  'lastError', null,
                  'resultEvidenceId', null
                )),
                'approvalState', CASE
                  WHEN NOT (task ? 'execution')
                    AND task->>'executionProfile' = 'worker'
                    AND task->>'approvalState' = 'approved'
                    THEN 'pending'::text
                  ELSE COALESCE(task->>'approvalState', 'not_required')
                END,
                'transitions', CASE
                  WHEN NOT (task ? 'execution')
                    AND task->>'executionProfile' = 'worker'
                    AND task->>'approvalState' = 'approved'
                    THEN COALESCE(task->'transitions', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                      'id', concat('migration014:approval:', task->>'id'),
                      'type', 'approval_changed',
                      'actor', 'system',
                      'at', COALESCE(NULLIF(task->>'updatedAt', ''), NULLIF(task->>'createdAt', ''), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
                      'fromApprovalState', 'approved',
                      'toApprovalState', 'pending',
                      'executionRevision', 0,
                      'note', 'Migration 014 requires fresh Owner approval before Worker execution.'
                    ))
                  ELSE COALESCE(task->'transitions', '[]'::jsonb)
                END
              )
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) WITH ORDINALITY AS entries(task, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) AS entries(task)
      WHERE NOT (task ? 'execution')
    )
  `
}, {
  version: "015_credential_registry",
  sql: `
    CREATE TABLE IF NOT EXISTS credential_secrets (
      credential_id uuid PRIMARY KEY,
      ciphertext text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO credential_secrets(credential_id, ciphertext, updated_at)
    SELECT connector_id, ciphertext, updated_at
    FROM connector_secrets
    ON CONFLICT (credential_id) DO NOTHING;

    WITH generated_credentials AS (
      SELECT platform.singleton_id,
             COALESCE(jsonb_agg(jsonb_build_object(
               'id', secret.connector_id,
               'name', reference.connector->>'name' || ' Credential',
               'provider', 'legacy',
               'kind', reference.kind,
               'location', reference.location,
               'status', 'active',
               'hasSecret', true,
               'secretRevision', CASE
                 WHEN reference.kind = 'api_key' THEN GREATEST(COALESCE((reference.connector->>'secretRevision')::integer, 1), 1)
                 ELSE 1
               END,
               'maskedHint', null,
               'expiresAt', null,
               'lastUsedAt', null,
               'createdAt', to_jsonb(secret.updated_at),
               'updatedAt', to_jsonb(secret.updated_at),
               'rotatedAt', to_jsonb(secret.updated_at)
             ) ORDER BY secret.connector_id), '[]'::jsonb) AS credentials
      FROM platform_state AS platform
      JOIN connector_secrets AS secret ON true
      JOIN LATERAL (
        SELECT connector, 'api_key'::text AS kind,
               COALESCE(NULLIF(connector->>'location', ''), 'cloud') AS location
        FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb)) AS connector
        WHERE connector->>'id' = secret.connector_id::text
        UNION ALL
        SELECT connector, 'bearer_token'::text AS kind, 'local'::text AS location
        FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb)) AS connector
        WHERE connector->>'id' = secret.connector_id::text
        UNION ALL
        SELECT connector, 'bearer_token'::text AS kind,
               COALESCE(NULLIF(connector->>'location', ''), 'local') AS location
        FROM jsonb_array_elements(COALESCE(platform.state->'taskAdapterConnectors', '[]'::jsonb)) AS connector
        WHERE connector->>'id' = secret.connector_id::text
        LIMIT 1
      ) AS reference ON true
      WHERE NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(platform.state->'credentials', '[]'::jsonb)) AS existing
        WHERE existing->>'id' = secret.connector_id::text
      )
      GROUP BY platform.singleton_id
    )
    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            platform.state,
            '{credentials}',
            COALESCE(platform.state->'credentials', '[]'::jsonb)
              || COALESCE(generated.credentials, '[]'::jsonb),
            true
          ),
          '{modelConnectors}',
          COALESCE((
            SELECT jsonb_agg(
              connector || jsonb_build_object(
                'credentialId', CASE
                  WHEN EXISTS (
                    SELECT 1 FROM connector_secrets AS secret
                    WHERE secret.connector_id::text = connector->>'id'
                  ) THEN to_jsonb(connector->>'id')
                  ELSE COALESCE(connector->'credentialId', 'null'::jsonb)
                END
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb))
              WITH ORDINALITY AS entries(connector, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    FROM generated_credentials AS generated
    WHERE generated.singleton_id = platform.singleton_id
       OR NOT (platform.state ? 'credentials')
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb)) AS connector
         WHERE NOT (connector ? 'credentialId')
       );

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            platform.state,
            '{credentials}',
            COALESCE(platform.state->'credentials', '[]'::jsonb),
            true
          ),
          '{modelConnectors}',
          COALESCE((
            SELECT jsonb_agg(
              connector || jsonb_build_object('credentialId', COALESCE(connector->'credentialId', 'null'::jsonb))
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb))
              WITH ORDINALITY AS entries(connector, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (platform.state ? 'credentials')
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb)) AS connector
         WHERE NOT (connector ? 'credentialId')
       )
  `
}, {
  version: "016_prompt_registry",
  sql: `
    CREATE TABLE IF NOT EXISTS prompt_versions (
      prompt_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      published_at timestamptz,
      PRIMARY KEY (prompt_id, version)
    );

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'prompts', '[]'::jsonb)) AS prompt
        WHERE NOT (prompt ?& ARRAY['id', 'name', 'status', 'currentVersion', 'publishedVersion'])
      ) THEN
        RAISE EXCEPTION 'Invalid existing Prompt registry detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state
    SET state = jsonb_set(state, '{prompts}', '[]'::jsonb, true),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (state ? 'prompts')
  `
}, {
  version: "017_agent_revision_history",
  sql: `
    CREATE TABLE IF NOT EXISTS agent_revisions (
      agent_id uuid NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      published_at timestamptz,
      PRIMARY KEY (agent_id, revision)
    );

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          platform.state,
          '{agents}',
          COALESCE((
            SELECT jsonb_agg(
              agent || jsonb_build_object(
                'promptBinding', COALESCE(agent->'promptBinding', 'null'::jsonb),
                'draftRevision', COALESCE(agent->'draftRevision', '1'::jsonb),
                'publishedRevision', COALESCE(agent->'publishedRevision', '1'::jsonb),
                'lifecycleStatus', COALESCE(agent->'lifecycleStatus', '"published"'::jsonb)
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb))
              WITH ORDINALITY AS entries(agent, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS agent
      WHERE NOT (agent ?& ARRAY['promptBinding', 'draftRevision', 'publishedRevision', 'lifecycleStatus'])
    );

    INSERT INTO agent_revisions(agent_id, revision, snapshot, created_at, published_at)
    SELECT (agent->>'id')::uuid,
           COALESCE((agent->>'publishedRevision')::integer, 1),
           jsonb_build_object(
             'agentId', agent->>'id',
             'revision', COALESCE((agent->>'publishedRevision')::integer, 1),
             'name', agent->>'name',
             'description', COALESCE(agent->>'description', ''),
             'modelConnectorId', COALESCE(agent->'modelConnectorId', 'null'::jsonb),
             'promptBinding', COALESCE(agent->'promptBinding', 'null'::jsonb),
             'goalSummary', agent->>'goalSummary',
             'toolsSummary', agent->>'toolsSummary',
             'dataSummary', agent->>'dataSummary',
             'skillIds', COALESCE(agent->'skillIds', '[]'::jsonb),
             'toolGrants', COALESCE(agent->'toolGrants', '[]'::jsonb),
             'contentDigest', encode(sha256(convert_to(agent::text, 'UTF8')), 'hex'),
             'source', 'legacy_backfilled',
             'restoredFromRevision', null,
             'createdAt', COALESCE(platform.updated_at, now()),
             'publishedAt', COALESCE(platform.updated_at, now())
           ),
           COALESCE(platform.updated_at, now()),
           COALESCE(platform.updated_at, now())
    FROM platform_state AS platform
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS agent
    ON CONFLICT (agent_id, revision) DO NOTHING
  `
}, {
  version: "018_agent_teams_and_meeting_presets",
  sql: `
    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                platform.state,
                '{agentTeams}',
                COALESCE(platform.state->'agentTeams', '[]'::jsonb),
                true
              ),
              '{meetingPresets}',
              COALESCE(platform.state->'meetingPresets', '[]'::jsonb),
              true
            ),
            '{meetings}',
            COALESCE((
              SELECT jsonb_agg(
                meeting || jsonb_build_object(
                  'sourceTeamId', COALESCE(meeting->'sourceTeamId', 'null'::jsonb),
                  'sourcePresetId', COALESCE(meeting->'sourcePresetId', 'null'::jsonb)
                ) ORDER BY ordinal
              )
              FROM jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb))
                WITH ORDINALITY AS entries(meeting, ordinal)
            ), '[]'::jsonb),
            true
          ),
          '{participants}',
          COALESCE((
            SELECT jsonb_agg(
              participant || jsonb_build_object(
                'agentRevision', COALESCE(
                  participant->'agentRevision',
                  (
                    SELECT COALESCE(agent->'publishedRevision', agent->'draftRevision', '1'::jsonb)
                    FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS agent
                    WHERE agent->>'id' = participant->>'agentId'
                  ),
                  '1'::jsonb
                )
              ) ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb))
              WITH ORDINALITY AS entries(participant, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (platform.state ? 'agentTeams')
       OR NOT (platform.state ? 'meetingPresets')
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb)) AS meeting
         WHERE NOT (meeting ?& ARRAY['sourceTeamId', 'sourcePresetId'])
       )
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participant
         WHERE NOT (participant ? 'agentRevision')
       )
  `
}, {
  version: "019_runtime_profiles",
  sql: `
    CREATE TABLE IF NOT EXISTS runtime_profiles (
      profile_id uuid PRIMARY KEY,
      revision integer NOT NULL CHECK (revision > 0),
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_profile_revisions (
      profile_id uuid NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      source text NOT NULL CHECK (source IN ('created', 'updated', 'legacy_backfilled')),
      recorded_at timestamptz NOT NULL,
      PRIMARY KEY (profile_id, revision)
    );

    CREATE INDEX IF NOT EXISTS runtime_profile_revisions_profile_idx
      ON runtime_profile_revisions(profile_id, revision DESC);

    ALTER TABLE agent_revisions
      ADD COLUMN IF NOT EXISTS runtime_profile_binding jsonb;

    WITH normalized_runtime_profiles AS (
      SELECT
        platform.singleton_id,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(platform.state->'runtimeProfiles', '[]'::jsonb)) AS entries(profile)
            WHERE profile->>'id' = '${defaultRuntimeProfileId}'
          ) THEN COALESCE(platform.state->'runtimeProfiles', '[]'::jsonb)
          ELSE COALESCE(platform.state->'runtimeProfiles', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
            'id', '${defaultRuntimeProfileId}',
            'name', 'Default text runtime',
            'harnessKind', 'openai_compatible',
            'modelConnectorId', null,
            'sandboxProfileId', null,
            'policy', 'text_only',
            'capabilities', jsonb_build_array('text', 'abort'),
            'timeoutMs', 90000,
            'maxConcurrency', 2,
            'enabled', true,
            'revision', 1,
            'createdAt', COALESCE(platform.updated_at, now()),
            'updatedAt', COALESCE(platform.updated_at, now())
          ))
        END AS profiles
      FROM platform_state AS platform
    ), normalized_runtime_profile_revisions AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(entry.revision ORDER BY entry.profile_id, entry.revision_number)
          FROM (
            SELECT
              existing->>'profileId' AS profile_id,
              (existing->>'revision')::integer AS revision_number,
              existing AS revision
            FROM jsonb_array_elements(COALESCE(platform.state->'runtimeProfileRevisions', '[]'::jsonb)) AS entries(existing)
            UNION
            SELECT
              profile->>'id' AS profile_id,
              (profile->>'revision')::integer AS revision_number,
              jsonb_build_object(
                'profileId', profile->>'id',
                'revision', (profile->>'revision')::integer,
                'name', profile->>'name',
                'harnessKind', profile->>'harnessKind',
                'modelConnectorId', COALESCE(profile->'modelConnectorId', 'null'::jsonb),
                'sandboxProfileId', COALESCE(profile->'sandboxProfileId', 'null'::jsonb),
                'policy', profile->>'policy',
                'capabilities', COALESCE(profile->'capabilities', '[]'::jsonb),
                'timeoutMs', (profile->>'timeoutMs')::integer,
                'maxConcurrency', (profile->>'maxConcurrency')::integer,
                'enabled', COALESCE(profile->'enabled', 'true'::jsonb),
                'source', 'legacy_backfilled',
                'recordedAt', COALESCE(profile->>'updatedAt', platform.updated_at::text, now()::text)
              ) AS revision
            FROM jsonb_array_elements(normalized_runtime_profiles.profiles) AS entries(profile)
            WHERE NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(COALESCE(platform.state->'runtimeProfileRevisions', '[]'::jsonb)) AS current(existing)
              WHERE existing->>'profileId' = profile->>'id'
                AND (existing->>'revision')::integer = (profile->>'revision')::integer
            )
          ) AS entry
        ), '[]'::jsonb) AS revisions
      FROM platform_state AS platform
      JOIN normalized_runtime_profiles USING (singleton_id)
    ), normalized_agents AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            agent || jsonb_build_object(
              'runtimeProfileBinding',
              COALESCE(
                agent->'runtimeProfileBinding',
                jsonb_build_object('profileId', '${defaultRuntimeProfileId}', 'revision', 1)
              )
            ) ORDER BY ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb))
            WITH ORDINALITY AS entries(agent, ordinal)
        ), '[]'::jsonb) AS agents
      FROM platform_state AS platform
    )
    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            jsonb_set(platform.state, '{runtimeProfiles}', profiles.profiles, true),
            '{runtimeProfileRevisions}', revisions.revisions, true
          ),
          '{agents}', agents.agents, true
        ),
        revision = revision + 1,
        updated_at = now()
    FROM normalized_runtime_profiles AS profiles
    JOIN normalized_runtime_profile_revisions AS revisions USING (singleton_id)
    JOIN normalized_agents AS agents USING (singleton_id)
    WHERE platform.singleton_id = profiles.singleton_id;

    INSERT INTO runtime_profiles(profile_id, revision, snapshot, created_at, updated_at)
    SELECT
      (profile->>'id')::uuid,
      (profile->>'revision')::integer,
      profile,
      COALESCE((profile->>'createdAt')::timestamptz, platform.updated_at, now()),
      COALESCE((profile->>'updatedAt')::timestamptz, platform.updated_at, now())
    FROM platform_state AS platform
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'runtimeProfiles', '[]'::jsonb)) AS entries(profile)
    ON CONFLICT (profile_id) DO UPDATE
    SET revision = EXCLUDED.revision,
        snapshot = EXCLUDED.snapshot,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO runtime_profile_revisions(profile_id, revision, snapshot, source, recorded_at)
    SELECT
      (runtime_revision->>'profileId')::uuid,
      (runtime_revision->>'revision')::integer,
      runtime_revision,
      runtime_revision->>'source',
      COALESCE((runtime_revision->>'recordedAt')::timestamptz, platform.updated_at, now())
    FROM platform_state AS platform
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'runtimeProfileRevisions', '[]'::jsonb)) AS entries(runtime_revision)
    ON CONFLICT (profile_id, revision) DO UPDATE
    SET snapshot = EXCLUDED.snapshot,
        source = EXCLUDED.source,
        recorded_at = EXCLUDED.recorded_at;

    UPDATE agent_revisions AS revision
    SET snapshot = revision.snapshot || jsonb_build_object(
          'runtimeProfileBinding',
          COALESCE(
            revision.snapshot->'runtimeProfileBinding',
            (
              SELECT agent->'runtimeProfileBinding'
              FROM platform_state AS platform
              CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS entries(agent)
              WHERE agent->>'id' = revision.agent_id::text
              LIMIT 1
            ),
            jsonb_build_object('profileId', '${defaultRuntimeProfileId}', 'revision', 1)
          )
        ),
        runtime_profile_binding = COALESCE(
          revision.runtime_profile_binding,
          revision.snapshot->'runtimeProfileBinding',
          (
            SELECT agent->'runtimeProfileBinding'
            FROM platform_state AS platform
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS entries(agent)
            WHERE agent->>'id' = revision.agent_id::text
            LIMIT 1
          ),
          jsonb_build_object('profileId', '${defaultRuntimeProfileId}', 'revision', 1)
        )
    WHERE revision.runtime_profile_binding IS NULL
       OR jsonb_typeof(revision.snapshot->'runtimeProfileBinding') IS DISTINCT FROM 'object'
  `
}, {
  version: "020_tool_pack_governance",
  sql: `
    CREATE TABLE IF NOT EXISTS tool_packs (
      pack_id uuid PRIMARY KEY,
      revision integer NOT NULL CHECK (revision > 0),
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_pack_revisions (
      pack_id uuid NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      source text NOT NULL CHECK (source IN ('created', 'updated', 'validated', 'approved', 'revoked')),
      recorded_at timestamptz NOT NULL,
      PRIMARY KEY (pack_id, revision)
    );

    CREATE INDEX IF NOT EXISTS tool_pack_revisions_pack_idx
      ON tool_pack_revisions(pack_id, revision DESC);

    ALTER TABLE agent_revisions
      ADD COLUMN IF NOT EXISTS tool_pack_grants jsonb;

    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        WHERE jsonb_typeof(COALESCE(platform.state->'toolPacks', '[]'::jsonb)) <> 'array'
           OR jsonb_typeof(COALESCE(platform.state->'toolPackRevisions', '[]'::jsonb)) <> 'array'
      ) OR EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'toolPacks', '[]'::jsonb)) AS entries(pack)
        WHERE NOT (pack ?& ARRAY['id', 'version', 'revision', 'status', 'sourceReference', 'imageDigest', 'manifestDigest', 'tools'])
      ) OR EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'toolPackRevisions', '[]'::jsonb)) AS entries(candidate_revision)
        WHERE NOT (candidate_revision ?& ARRAY['packId', 'revision', 'status', 'manifestDigest', 'source'])
      ) OR EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS entries(agent)
        WHERE agent ? 'toolPackGrants' AND jsonb_typeof(agent->'toolPackGrants') <> 'array'
      ) THEN
        RAISE EXCEPTION 'Invalid existing Tool Pack governance state detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            jsonb_set(
              platform.state,
              '{toolPacks}',
              COALESCE(platform.state->'toolPacks', '[]'::jsonb),
              true
            ),
            '{toolPackRevisions}',
            COALESCE(platform.state->'toolPackRevisions', '[]'::jsonb),
            true
          ),
          '{agents}',
          COALESCE((
            SELECT jsonb_agg(
              agent || jsonb_build_object('toolPackGrants', COALESCE(agent->'toolPackGrants', '[]'::jsonb))
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb))
              WITH ORDINALITY AS entries(agent, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE NOT (platform.state ? 'toolPacks')
       OR NOT (platform.state ? 'toolPackRevisions')
       OR EXISTS (
         SELECT 1
         FROM jsonb_array_elements(COALESCE(platform.state->'agents', '[]'::jsonb)) AS entries(agent)
         WHERE NOT (agent ? 'toolPackGrants')
       );

    INSERT INTO tool_packs(pack_id, revision, snapshot, created_at, updated_at)
    SELECT
      (pack->>'id')::uuid,
      (pack->>'revision')::integer,
      pack,
      (pack->>'createdAt')::timestamptz,
      (pack->>'updatedAt')::timestamptz
    FROM platform_state AS platform
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'toolPacks', '[]'::jsonb)) AS entries(pack)
    ON CONFLICT (pack_id) DO UPDATE
    SET revision = EXCLUDED.revision,
        snapshot = EXCLUDED.snapshot,
        updated_at = EXCLUDED.updated_at;

    INSERT INTO tool_pack_revisions(pack_id, revision, snapshot, source, recorded_at)
    SELECT
      (pack_revision->>'packId')::uuid,
      (pack_revision->>'revision')::integer,
      pack_revision,
      pack_revision->>'source',
      (pack_revision->>'recordedAt')::timestamptz
    FROM platform_state AS platform
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'toolPackRevisions', '[]'::jsonb)) AS entries(pack_revision)
    ON CONFLICT (pack_id, revision) DO NOTHING;

    -- Version 1 digests predate Tool Pack bindings. Preserve their payload and digest;
    -- the typed read path supplies an empty legacy grant list, while all new revisions use version 2.
    UPDATE agent_revisions
    SET snapshot = snapshot || jsonb_build_object(
          'contentDigestVersion',
          COALESCE(snapshot->'contentDigestVersion', '1'::jsonb)
        ),
        tool_pack_grants = COALESCE(tool_pack_grants, snapshot->'toolPackGrants', '[]'::jsonb)
    WHERE tool_pack_grants IS NULL
       OR NOT (snapshot ? 'contentDigestVersion');

    ALTER TABLE agent_revisions
      ALTER COLUMN tool_pack_grants SET DEFAULT '[]'::jsonb,
      ALTER COLUMN tool_pack_grants SET NOT NULL;
  `
}, {
  version: "021_utterance_projection_expand",
  sql: `
    CREATE TABLE IF NOT EXISTS meeting_utterances (
      utterance_id uuid PRIMARY KEY,
      turn_id text,
      meeting_id uuid NOT NULL,
      created_at timestamptz NOT NULL,
      sequence_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object')
    );

    CREATE UNIQUE INDEX IF NOT EXISTS meeting_utterances_turn_id_idx
      ON meeting_utterances(turn_id)
      WHERE turn_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS meeting_utterances_meeting_created_sequence_idx
      ON meeting_utterances(meeting_id, created_at, sequence_no);

    CREATE TABLE IF NOT EXISTS utterance_projection_backfill_progress (
      singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
      source_count bigint CHECK (source_count IS NULL OR source_count >= 0),
      processed_count bigint NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
      completed_at timestamptz,
      cutover_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (source_count IS NULL OR processed_count <= source_count)
    );

    INSERT INTO utterance_projection_backfill_progress(singleton_id)
    VALUES (1)
    ON CONFLICT (singleton_id) DO NOTHING;
  `
}, {
  version: "022_mcp_connector_location",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb)) AS connector
        WHERE connector ? 'location'
          AND (
            jsonb_typeof(connector->'location') <> 'string'
            OR connector->>'location' NOT IN ('cloud', 'local')
          )
      ) THEN
        RAISE EXCEPTION 'Invalid existing MCP Connector location detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          platform.state,
          '{mcpConnectors}',
          COALESCE((
            SELECT jsonb_agg(
              connector || jsonb_build_object('location', 'local') ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb))
              WITH ORDINALITY AS entries(connector, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb)) AS connector
      WHERE NOT (connector ? 'location')
    );
  `
}, {
  version: "023_mcp_queue_request_fingerprint",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
        WHERE (
          item ? 'requestFingerprint'
          AND item->'requestFingerprint' <> 'null'::jsonb
          AND (
            jsonb_typeof(item->'requestFingerprint') IS DISTINCT FROM 'string'
            OR btrim(COALESCE(item->>'requestFingerprint', '')) = ''
          )
        ) OR (
          COALESCE(item->>'kind', 'agent_turn') <> 'mcp_tool_call'
          AND item ? 'requestFingerprint'
          AND item->'requestFingerprint' <> 'null'::jsonb
        )
      ) THEN
        RAISE EXCEPTION 'Invalid existing MCP queue request fingerprint detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          platform.state,
          '{speakerQueue}',
          COALESCE((
            SELECT jsonb_agg(
              item || jsonb_build_object(
                'requestFingerprint', COALESCE(item->'requestFingerprint', 'null'::jsonb)
              )
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb))
              WITH ORDINALITY AS entries(item, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'speakerQueue', '[]'::jsonb)) AS entries(item)
      WHERE NOT (item ? 'requestFingerprint')
    );
  `
}, {
  version: "024_topic_revision",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'threads', '[]'::jsonb)) AS entries(topic)
        WHERE topic ? 'revision'
          AND (
            jsonb_typeof(topic->'revision') <> 'number'
            OR COALESCE(topic->>'revision', '') !~ '^[1-9][0-9]*$'
          )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Topic revision detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          platform.state,
          '{threads}',
          COALESCE((
            SELECT jsonb_agg(
              topic || jsonb_build_object(
                'revision', COALESCE(topic->'revision', '1'::jsonb)
              )
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'threads', '[]'::jsonb))
              WITH ORDINALITY AS entries(topic, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'threads', '[]'::jsonb)) AS entries(topic)
      WHERE NOT (topic ? 'revision')
    );
  `
}, {
  version: "025_task_revisions",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) AS entries(task)
        WHERE (task ? 'revision' AND (
          jsonb_typeof(task->'revision') <> 'number'
          OR COALESCE(task->>'revision', '') !~ '^[1-9][0-9]*$'
        )) OR (task ? 'boardRevision' AND (
          jsonb_typeof(task->'boardRevision') <> 'number'
          OR COALESCE(task->>'boardRevision', '') !~ '^[1-9][0-9]*$'
        ))
      ) THEN
        RAISE EXCEPTION 'Invalid existing Task revision detected during migration.';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL (
          SELECT count(DISTINCT task->>'boardRevision') AS revision_count
          FROM jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) AS entries(task)
          WHERE task ? 'boardRevision'
        ) AS board_state
        WHERE board_state.revision_count > 1
      ) THEN
        RAISE EXCEPTION 'Inconsistent existing Task board revisions detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          platform.state,
          '{tasks}',
          COALESCE((
            SELECT jsonb_agg(
              task || jsonb_build_object(
                'revision', COALESCE(task->'revision', '1'::jsonb),
                'boardRevision', COALESCE(task->'boardRevision', to_jsonb(board_state.revision))
              )
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb))
              WITH ORDINALITY AS entries(task, ordinal)
            CROSS JOIN LATERAL (
              SELECT COALESCE(max((existing->>'boardRevision')::bigint), 1) AS revision
              FROM jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) AS existing_entries(existing)
              WHERE existing ? 'boardRevision'
            ) AS board_state
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'tasks', '[]'::jsonb)) AS entries(task)
      WHERE NOT (task ? 'revision') OR NOT (task ? 'boardRevision')
    );
  `
}, {
  version: "026_connector_revisions",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM platform_state AS platform
        CROSS JOIN LATERAL (
          SELECT connector
          FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb)) AS models(connector)
          UNION ALL
          SELECT connector
          FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb)) AS mcps(connector)
        ) AS entries
        WHERE entries.connector ? 'revision'
          AND (
            jsonb_typeof(entries.connector->'revision') <> 'number'
            OR COALESCE(entries.connector->>'revision', '') !~ '^[1-9][0-9]*$'
          )
      ) THEN
        RAISE EXCEPTION 'Invalid existing Connector revision detected during migration.';
      END IF;
    END $$;

    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(
            platform.state,
            '{modelConnectors}',
            COALESCE((
              SELECT jsonb_agg(
                connector || jsonb_build_object(
                  'revision', COALESCE(connector->'revision', '1'::jsonb)
                )
                ORDER BY ordinal
              )
              FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb))
                WITH ORDINALITY AS entries(connector, ordinal)
            ), '[]'::jsonb),
            true
          ),
          '{mcpConnectors}',
          COALESCE((
            SELECT jsonb_agg(
              connector || jsonb_build_object(
                'revision', COALESCE(connector->'revision', '1'::jsonb)
              )
              ORDER BY ordinal
            )
            FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb))
              WITH ORDINALITY AS entries(connector, ordinal)
          ), '[]'::jsonb),
          true
        ),
        revision = revision + 1,
        updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb)) AS entries(connector)
      WHERE NOT (connector ? 'revision')
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'mcpConnectors', '[]'::jsonb)) AS entries(connector)
      WHERE NOT (connector ? 'revision')
    );
  `
}, {
  version: "027_chair_automation_job_admissions",
  sql: `
    CREATE TABLE IF NOT EXISTS chair_automation_job_admissions (
      chair_suggestion_id uuid PRIMARY KEY,
      meeting_id uuid NOT NULL,
      job_id text NOT NULL UNIQUE CHECK (btrim(job_id) <> ''),
      automation_revision integer NOT NULL CHECK (automation_revision >= 0),
      status text NOT NULL CHECK (status IN ('reserved', 'admitted', 'reconciliation_required')),
      reserved_at timestamptz NOT NULL,
      admitted_at timestamptz,
      reconciliation_required_at timestamptz,
      reconciliation_reason text,
      updated_at timestamptz NOT NULL,
      CONSTRAINT chair_automation_job_admissions_reconciliation_reason_check
        CHECK (reconciliation_reason IS NULL OR reconciliation_reason IN (
          'queue_state_missing',
          'queue_state_terminal',
          'queue_ownership_unknown'
        )),
      CHECK (
        (status = 'reserved'
          AND admitted_at IS NULL
          AND reconciliation_required_at IS NULL
          AND reconciliation_reason IS NULL)
        OR (status = 'admitted'
          AND admitted_at IS NOT NULL
          AND reconciliation_required_at IS NULL
          AND reconciliation_reason IS NULL)
        OR (status = 'reconciliation_required'
          AND reconciliation_required_at IS NOT NULL
          AND reconciliation_reason IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS chair_automation_job_admissions_status_idx
      ON chair_automation_job_admissions(status, updated_at);

    INSERT INTO chair_automation_job_admissions(
      chair_suggestion_id,
      meeting_id,
      job_id,
      automation_revision,
      status,
      reserved_at,
      admitted_at,
      reconciliation_required_at,
      reconciliation_reason,
      updated_at
    )
    SELECT DISTINCT ON (audit.entity_id)
      audit.entity_id,
      (audit.detail->>'meetingId')::uuid,
      audit.detail->>'jobId',
      (audit.detail->>'automationRevision')::integer,
      'admitted',
      audit.created_at,
      audit.created_at,
      NULL,
      NULL,
      audit.created_at
    FROM audit_events AS audit
    CROSS JOIN platform_state AS platform
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'chairSuggestions', '[]'::jsonb)) AS entries(suggestion)
    WHERE audit.event = 'chair.automation.queued'
      AND audit.entity_type = 'chair_suggestion'
      AND suggestion->>'id' = audit.entity_id::text
      AND suggestion->>'status' = 'open'
      AND jsonb_typeof(audit.detail->'meetingId') = 'string'
      AND audit.detail->>'meetingId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(audit.detail->'jobId') = 'string'
      AND btrim(audit.detail->>'jobId') <> ''
      AND jsonb_typeof(audit.detail->'automationRevision') = 'number'
      AND audit.detail->>'automationRevision' ~ '^[0-9]+$'
      AND (audit.detail->>'automationRevision')::numeric BETWEEN 0 AND 2147483647
    ORDER BY audit.entity_id, audit.created_at DESC
    ON CONFLICT (chair_suggestion_id) DO NOTHING;
  `
}, {
  version: "028_chair_automation_reconciliation_reasons",
  sql: `
    ALTER TABLE chair_automation_job_admissions
      DROP CONSTRAINT IF EXISTS chair_automation_job_admissions_reconciliation_reason_check;

    ALTER TABLE chair_automation_job_admissions
      ADD CONSTRAINT chair_automation_job_admissions_reconciliation_reason_check
      CHECK (reconciliation_reason IS NULL OR reconciliation_reason IN (
        'queue_state_missing',
        'queue_state_terminal',
        'queue_ownership_unknown'
      )) NOT VALID;

    ALTER TABLE chair_automation_job_admissions
      VALIDATE CONSTRAINT chair_automation_job_admissions_reconciliation_reason_check;
  `
}, {
  version: "029_goal_run_autonomy",
  sql: `
    CREATE TABLE IF NOT EXISTS goal_runs (
      id uuid PRIMARY KEY,
      title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
      goal text NOT NULL CHECK (length(btrim(goal)) BETWEEN 1 AND 8000),
      thread_id uuid NOT NULL,
      meeting_id uuid NOT NULL,
      state text NOT NULL CHECK (state IN (
        'draft', 'planning', 'awaiting_approval', 'executing', 'reviewing',
        'replanning', 'paused', 'completed', 'failed', 'cancelled'
      )),
      revision integer NOT NULL CHECK (revision > 0),
      active_plan_revision integer NOT NULL DEFAULT 0 CHECK (active_plan_revision >= 0),
      execution_contract_id uuid,
      limits jsonb NOT NULL,
      usage jsonb NOT NULL,
      deadline_at timestamptz NOT NULL,
      paused_from_state text CHECK (paused_from_state IS NULL OR paused_from_state IN (
        'planning', 'awaiting_approval', 'executing', 'reviewing', 'replanning'
      )),
      terminal_reason text CHECK (terminal_reason IS NULL OR length(terminal_reason) <= 2000),
      created_by uuid NOT NULL REFERENCES owner_users(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (meeting_id)
    );

    CREATE INDEX IF NOT EXISTS goal_runs_state_updated_idx
      ON goal_runs(state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS goal_runs_thread_idx
      ON goal_runs(thread_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS goal_plan_revisions (
      id uuid PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      revision integer NOT NULL CHECK (revision > 0),
      status text NOT NULL CHECK (status IN ('draft', 'approved', 'superseded')),
      digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
      tasks jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (goal_run_id, revision),
      UNIQUE (goal_run_id, digest)
    );

    CREATE INDEX IF NOT EXISTS goal_plan_revisions_goal_idx
      ON goal_plan_revisions(goal_run_id, revision DESC);

    CREATE TABLE IF NOT EXISTS execution_contracts (
      id uuid PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE RESTRICT,
      plan_revision integer NOT NULL CHECK (plan_revision > 0),
      plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
      contract_digest text NOT NULL UNIQUE CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
      approved_by uuid NOT NULL REFERENCES owner_users(id) ON DELETE RESTRICT,
      approved_at timestamptz NOT NULL,
      limits jsonb NOT NULL,
      plan_snapshot jsonb NOT NULL,
      FOREIGN KEY (goal_run_id, plan_revision)
        REFERENCES goal_plan_revisions(goal_run_id, revision) ON DELETE RESTRICT
    );

    ALTER TABLE goal_runs
      DROP CONSTRAINT IF EXISTS goal_runs_execution_contract_fk;
    ALTER TABLE goal_runs
      ADD CONSTRAINT goal_runs_execution_contract_fk
      FOREIGN KEY (execution_contract_id) REFERENCES execution_contracts(id) ON DELETE RESTRICT;

    CREATE TABLE IF NOT EXISTS goal_task_bindings (
      id uuid PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      plan_revision integer NOT NULL CHECK (plan_revision > 0),
      plan_task_id uuid NOT NULL,
      task_id uuid,
      state text NOT NULL CHECK (state IN (
        'waiting', 'ready', 'running', 'reviewing', 'completed', 'failed', 'blocked', 'cancelled'
      )),
      attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      active_job_id text,
      last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (goal_run_id, plan_revision, plan_task_id),
      FOREIGN KEY (goal_run_id, plan_revision)
        REFERENCES goal_plan_revisions(goal_run_id, revision) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS goal_task_bindings_ready_idx
      ON goal_task_bindings(goal_run_id, state, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS goal_task_bindings_active_job_idx
      ON goal_task_bindings(active_job_id) WHERE active_job_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS goal_events (
      sequence bigserial NOT NULL UNIQUE,
      id uuid PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      type text NOT NULL CHECK (type IN (
        'goal.created', 'goal.state.changed', 'meeting.linked',
        'meeting.round.started', 'meeting.round.completed', 'chair.intervened',
        'plan.created', 'plan.revised', 'contract.approved', 'task.bound',
        'task.state.changed', 'action.state.changed', 'review.recorded',
        'owner.message', 'owner.takeover'
      )),
      actor_type text NOT NULL CHECK (actor_type IN ('owner', 'agent', 'system')),
      actor_id uuid,
      entity_type text NOT NULL CHECK (entity_type IN ('goal', 'meeting', 'plan', 'task', 'action', 'review')),
      entity_id text NOT NULL,
      summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 1000),
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (goal_run_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS goal_events_replay_idx
      ON goal_events(goal_run_id, sequence);

    CREATE TABLE IF NOT EXISTS reviewer_verdicts (
      id uuid PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      scope text NOT NULL CHECK (scope IN ('task', 'goal', 'action')),
      scope_id uuid NOT NULL,
      reviewer_agent_id uuid NOT NULL,
      reviewer_agent_revision integer NOT NULL CHECK (reviewer_agent_revision > 0),
      model_connector_id uuid NOT NULL,
      verdict text NOT NULL CHECK (verdict IN ('pass', 'fail', 'needs_human')),
      summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 4000),
      evidence_ids jsonb NOT NULL,
      contract_digest text NOT NULL CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (scope, scope_id, reviewer_agent_id)
    );

    CREATE INDEX IF NOT EXISTS reviewer_verdicts_scope_idx
      ON reviewer_verdicts(scope, scope_id, created_at);

    CREATE TABLE IF NOT EXISTS action_adapters (
      id uuid PRIMARY KEY,
      name text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      kind text NOT NULL CHECK (kind = 'harness_pipeline'),
      enabled boolean NOT NULL DEFAULT false,
      base_url text NOT NULL,
      credential_id uuid,
      catalog_revision integer NOT NULL CHECK (catalog_revision > 0),
      actions jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS action_runs (
      id uuid PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      plan_task_id uuid NOT NULL,
      adapter_id uuid NOT NULL REFERENCES action_adapters(id) ON DELETE RESTRICT,
      adapter_catalog_revision integer NOT NULL CHECK (adapter_catalog_revision > 0),
      action_key text NOT NULL,
      target_id text NOT NULL,
      inputs jsonb NOT NULL,
      state text NOT NULL CHECK (state IN (
        'draft', 'awaiting_review', 'approved', 'reserved', 'running',
        'succeeded', 'failed', 'cancelled', 'denied', 'expired', 'outcome_unknown'
      )),
      request_fingerprint text NOT NULL UNIQUE CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
      contract_digest text NOT NULL CHECK (contract_digest ~ '^[a-f0-9]{64}$'),
      external_execution_id text,
      verification_summary text CHECK (verification_summary IS NULL OR length(verification_summary) <= 4000),
      last_error text CHECK (last_error IS NULL OR length(last_error) <= 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (goal_run_id, plan_task_id)
    );

    CREATE INDEX IF NOT EXISTS action_runs_state_idx
      ON action_runs(state, updated_at);

    CREATE TABLE IF NOT EXISTS goal_job_admissions (
      job_id text PRIMARY KEY,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      job_name text NOT NULL CHECK (job_name IN (
        'goal-orchestrate', 'goal-plan', 'goal-review', 'goal-action-run'
      )),
      entity_id text NOT NULL,
      request_fingerprint text NOT NULL CHECK (length(request_fingerprint) BETWEEN 1 AND 500),
      state text NOT NULL CHECK (state IN (
        'reserved', 'admitted', 'running', 'settled', 'outcome_unknown'
      )),
      reserved_at timestamptz NOT NULL DEFAULT now(),
      admitted_at timestamptz,
      started_at timestamptz,
      settled_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS goal_job_admissions_recovery_idx
      ON goal_job_admissions(state, updated_at);
  `
}, {
  version: "030_execution_contract_action_bindings",
  sql: `
    ALTER TABLE execution_contracts
      ADD COLUMN IF NOT EXISTS action_bindings jsonb NOT NULL DEFAULT '[]'::jsonb;
  `
}, {
  version: "031_goal_run_immutability",
  sql: `
    CREATE OR REPLACE FUNCTION goal_events_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'goal_events are append-only';
    END;
    $$;

    DROP TRIGGER IF EXISTS goal_events_reject_update_delete ON goal_events;
    CREATE TRIGGER goal_events_reject_update_delete
      BEFORE UPDATE OR DELETE ON goal_events
      FOR EACH ROW
      EXECUTE FUNCTION goal_events_reject_mutation();

    CREATE OR REPLACE FUNCTION execution_contracts_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'execution_contracts are immutable';
    END;
    $$;

    DROP TRIGGER IF EXISTS execution_contracts_reject_update_delete ON execution_contracts;
    CREATE TRIGGER execution_contracts_reject_update_delete
      BEFORE UPDATE OR DELETE ON execution_contracts
      FOR EACH ROW
      EXECUTE FUNCTION execution_contracts_reject_mutation();

    CREATE OR REPLACE FUNCTION goal_plan_revisions_enforce_immutability()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'goal_plan_revisions are immutable';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.goal_run_id IS DISTINCT FROM OLD.goal_run_id
        OR NEW.revision IS DISTINCT FROM OLD.revision
        OR NEW.digest IS DISTINCT FROM OLD.digest
        OR NEW.tasks IS DISTINCT FROM OLD.tasks
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'goal_plan_revisions immutable fields cannot be changed';
      END IF;

      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
      END IF;

      IF OLD.status = 'draft' AND NEW.status IN ('approved', 'superseded') THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'goal_plan_revisions status transition is not permitted';
    END;
    $$;

    DROP TRIGGER IF EXISTS goal_plan_revisions_enforce_immutability ON goal_plan_revisions;
    CREATE TRIGGER goal_plan_revisions_enforce_immutability
      BEFORE UPDATE OR DELETE ON goal_plan_revisions
      FOR EACH ROW
      EXECUTE FUNCTION goal_plan_revisions_enforce_immutability();
  `
}, {
  version: "032_role_orchestration_functions",
  sql: `
    DO $$
    DECLARE
      candidate jsonb;
      function_name text;
    BEGIN
      FOR candidate IN
        SELECT role->'orchestrationFunctions'
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS roles(role)
        WHERE role ? 'orchestrationFunctions'
        UNION ALL
        SELECT participant->'roleSnapshot'->'orchestrationFunctions'
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
        WHERE (participant->'roleSnapshot') ? 'orchestrationFunctions'
        UNION ALL
        SELECT history->'roleSnapshot'->'orchestrationFunctions'
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS participants(participant)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(participant->'roleHistory', '[]'::jsonb)) AS histories(history)
        WHERE (history->'roleSnapshot') ? 'orchestrationFunctions'
        UNION ALL
        SELECT snapshot->'orchestrationFunctions'
        FROM role_versions
        WHERE snapshot ? 'orchestrationFunctions'
      LOOP
        IF jsonb_typeof(candidate) <> 'array' OR jsonb_array_length(candidate) > 4 THEN
          RAISE EXCEPTION 'Invalid existing Role orchestration functions detected during migration.';
        END IF;
        FOR function_name IN
          SELECT value
          FROM jsonb_array_elements_text(candidate) AS functions(value)
        LOOP
          IF function_name NOT IN ('chair', 'planner', 'worker', 'reviewer') THEN
            RAISE EXCEPTION 'Invalid existing Role orchestration functions detected during migration.';
          END IF;
        END LOOP;
      END LOOP;
    END $$;

    WITH normalized_roles AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            CASE
              WHEN role ? 'orchestrationFunctions' THEN role
              ELSE role || jsonb_build_object(
                'orchestrationFunctions', CASE role->>'templateKey'
                  WHEN 'platform_architect' THEN '["planner", "worker"]'::jsonb
                  WHEN 'meeting_chair' THEN '["chair", "planner"]'::jsonb
                  WHEN 'security_reviewer' THEN '["reviewer"]'::jsonb
                  WHEN 'evidence_analyst' THEN '["reviewer"]'::jsonb
                  ELSE '[]'::jsonb
                END
              )
            END ORDER BY ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb))
            WITH ORDINALITY AS roles(role, ordinal)
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
    ), normalized_participants AS (
      SELECT
        platform.singleton_id,
        COALESCE((
          SELECT jsonb_agg(
            participant || jsonb_build_object(
              'roleSnapshot', CASE
                WHEN (participant->'roleSnapshot') ? 'orchestrationFunctions'
                  THEN participant->'roleSnapshot'
                ELSE participant->'roleSnapshot' || jsonb_build_object(
                  'orchestrationFunctions', CASE participant->'roleSnapshot'->>'templateKey'
                    WHEN 'platform_architect' THEN '["planner", "worker"]'::jsonb
                    WHEN 'meeting_chair' THEN '["chair", "planner"]'::jsonb
                    WHEN 'security_reviewer' THEN '["reviewer"]'::jsonb
                    WHEN 'evidence_analyst' THEN '["reviewer"]'::jsonb
                    ELSE '[]'::jsonb
                  END
                )
              END,
              'roleHistory', COALESCE((
                SELECT jsonb_agg(
                  history || jsonb_build_object(
                    'roleSnapshot', CASE
                      WHEN (history->'roleSnapshot') ? 'orchestrationFunctions'
                        THEN history->'roleSnapshot'
                      ELSE history->'roleSnapshot' || jsonb_build_object(
                        'orchestrationFunctions', CASE history->'roleSnapshot'->>'templateKey'
                          WHEN 'platform_architect' THEN '["planner", "worker"]'::jsonb
                          WHEN 'meeting_chair' THEN '["chair", "planner"]'::jsonb
                          WHEN 'security_reviewer' THEN '["reviewer"]'::jsonb
                          WHEN 'evidence_analyst' THEN '["reviewer"]'::jsonb
                          ELSE '[]'::jsonb
                        END
                      )
                    END
                  ) ORDER BY history_ordinal
                )
                FROM jsonb_array_elements(COALESCE(participant->'roleHistory', '[]'::jsonb))
                  WITH ORDINALITY AS histories(history, history_ordinal)
              ), '[]'::jsonb)
            ) ORDER BY participant_ordinal
          )
          FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb))
            WITH ORDINALITY AS participants(participant, participant_ordinal)
        ), '[]'::jsonb) AS items
      FROM platform_state AS platform
    )
    UPDATE platform_state AS platform
    SET state = jsonb_set(
          jsonb_set(platform.state, '{roles}', roles.items, true),
          '{participants}', participants.items, true
        ),
        revision = revision + 1,
        updated_at = now()
    FROM normalized_roles AS roles
    JOIN normalized_participants AS participants USING (singleton_id)
    WHERE platform.singleton_id = roles.singleton_id
      AND (
        EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'roles', '[]'::jsonb)) AS entries(role)
          WHERE NOT (role ? 'orchestrationFunctions')
        )
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE(platform.state->'participants', '[]'::jsonb)) AS entries(participant)
          WHERE NOT ((participant->'roleSnapshot') ? 'orchestrationFunctions')
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(participant->'roleHistory', '[]'::jsonb)) AS histories(history)
               WHERE NOT ((history->'roleSnapshot') ? 'orchestrationFunctions')
             )
        )
      );

    UPDATE role_versions
    SET snapshot = snapshot || jsonb_build_object(
          'orchestrationFunctions', CASE snapshot->>'templateKey'
            WHEN 'platform_architect' THEN '["planner", "worker"]'::jsonb
            WHEN 'meeting_chair' THEN '["chair", "planner"]'::jsonb
            WHEN 'security_reviewer' THEN '["reviewer"]'::jsonb
            WHEN 'evidence_analyst' THEN '["reviewer"]'::jsonb
            ELSE '[]'::jsonb
          END
        )
    WHERE NOT (snapshot ? 'orchestrationFunctions');
  `
}, {
  version: "033_goal_plan_planner_provenance",
  sql: `
    ALTER TABLE goal_plan_revisions
      ADD COLUMN IF NOT EXISTS planner_provenance jsonb;

    ALTER TABLE goal_plan_revisions
      DROP CONSTRAINT IF EXISTS goal_plan_revisions_planner_provenance_shape;
    ALTER TABLE goal_plan_revisions
      ADD CONSTRAINT goal_plan_revisions_planner_provenance_shape CHECK (
        planner_provenance IS NULL OR (
          jsonb_typeof(planner_provenance) = 'object'
          AND planner_provenance ?& ARRAY[
            'plannerAgentId', 'plannerAgentRevision', 'plannerModelConnectorId'
          ]
          AND planner_provenance - ARRAY[
            'plannerAgentId', 'plannerAgentRevision', 'plannerModelConnectorId'
          ] = '{}'::jsonb
          AND (planner_provenance->>'plannerAgentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND jsonb_typeof(planner_provenance->'plannerAgentRevision') = 'number'
          AND (planner_provenance->>'plannerAgentRevision') ~ '^[1-9][0-9]*$'
          AND (planner_provenance->>'plannerModelConnectorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
      );

    CREATE OR REPLACE FUNCTION goal_plan_revisions_enforce_immutability()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'goal_plan_revisions are immutable';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.goal_run_id IS DISTINCT FROM OLD.goal_run_id
        OR NEW.revision IS DISTINCT FROM OLD.revision
        OR NEW.digest IS DISTINCT FROM OLD.digest
        OR NEW.tasks IS DISTINCT FROM OLD.tasks
        OR NEW.planner_provenance IS DISTINCT FROM OLD.planner_provenance
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'goal_plan_revisions immutable fields cannot be changed';
      END IF;

      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
      END IF;

      IF OLD.status = 'draft' AND NEW.status IN ('approved', 'superseded') THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'goal_plan_revisions status transition is not permitted';
    END;
    $$;
  `
}, {
  version: "034_goal_contract_execution_history",
  sql: `
    ALTER TABLE action_runs
      DROP CONSTRAINT IF EXISTS action_runs_goal_run_id_plan_task_id_key;
    ALTER TABLE action_runs
      DROP CONSTRAINT IF EXISTS action_runs_goal_plan_contract_unique;
    ALTER TABLE action_runs
      ADD CONSTRAINT action_runs_goal_plan_contract_unique
      UNIQUE (goal_run_id, plan_task_id, contract_digest);

    ALTER TABLE reviewer_verdicts
      DROP CONSTRAINT IF EXISTS reviewer_verdicts_scope_scope_id_reviewer_agent_id_key;
    ALTER TABLE reviewer_verdicts
      DROP CONSTRAINT IF EXISTS reviewer_verdicts_contract_reviewer_unique;
    ALTER TABLE reviewer_verdicts
      ADD CONSTRAINT reviewer_verdicts_contract_reviewer_unique
      UNIQUE (goal_run_id, scope, scope_id, reviewer_agent_id, contract_digest);
  `
}, {
  version: "035_goal_job_dispatch_lease",
  sql: `
    ALTER TABLE goal_job_admissions
      ADD COLUMN IF NOT EXISTS dispatch_token text,
      ADD COLUMN IF NOT EXISTS dispatch_lease_expires_at timestamptz;

    ALTER TABLE goal_job_admissions
      DROP CONSTRAINT IF EXISTS goal_job_admissions_state_check;
    ALTER TABLE goal_job_admissions
      ADD CONSTRAINT goal_job_admissions_state_check CHECK (state IN (
        'reserved', 'dispatching', 'admitted', 'running', 'settled', 'outcome_unknown'
      ));

    ALTER TABLE goal_job_admissions
      DROP CONSTRAINT IF EXISTS goal_job_admissions_dispatch_lease_shape;
    ALTER TABLE goal_job_admissions
      ADD CONSTRAINT goal_job_admissions_dispatch_lease_shape CHECK (
        (
          state = 'dispatching'
          AND dispatch_token IS NOT NULL
          AND length(dispatch_token) BETWEEN 1 AND 200
          AND dispatch_token = btrim(dispatch_token)
          AND dispatch_lease_expires_at IS NOT NULL
          AND dispatch_lease_expires_at >= updated_at + INTERVAL '1 second'
          AND dispatch_lease_expires_at <= updated_at + INTERVAL '60 seconds'
          AND admitted_at IS NULL
          AND started_at IS NULL
          AND settled_at IS NULL
        ) OR (
          state <> 'dispatching'
          AND dispatch_token IS NULL
          AND dispatch_lease_expires_at IS NULL
        )
      );
  `
}, {
  version: "036_goal_planner_role_provenance",
  sql: `
    ALTER TABLE goal_plan_revisions
      DISABLE TRIGGER goal_plan_revisions_enforce_immutability;

    UPDATE goal_plan_revisions
    SET planner_provenance = NULL
    WHERE planner_provenance IS NOT NULL
      AND NOT (
        jsonb_typeof(planner_provenance) = 'object'
        AND planner_provenance ?& ARRAY[
          'plannerParticipantId', 'plannerAgentId', 'plannerAgentRevision',
          'plannerModelConnectorId', 'plannerRoleId', 'plannerRoleRevision',
          'plannerRoleSnapshotDigest'
        ]
        AND planner_provenance - ARRAY[
          'plannerParticipantId', 'plannerAgentId', 'plannerAgentRevision',
          'plannerModelConnectorId', 'plannerRoleId', 'plannerRoleRevision',
          'plannerRoleSnapshotDigest'
        ] = '{}'::jsonb
        AND jsonb_typeof(planner_provenance->'plannerParticipantId') = 'string'
        AND (planner_provenance->>'plannerParticipantId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(planner_provenance->'plannerAgentId') = 'string'
        AND (planner_provenance->>'plannerAgentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(planner_provenance->'plannerAgentRevision') = 'number'
        AND (planner_provenance->>'plannerAgentRevision') ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(planner_provenance->'plannerModelConnectorId') = 'string'
        AND (planner_provenance->>'plannerModelConnectorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(planner_provenance->'plannerRoleId') = 'string'
        AND (planner_provenance->>'plannerRoleId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(planner_provenance->'plannerRoleRevision') = 'number'
        AND (planner_provenance->>'plannerRoleRevision') ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(planner_provenance->'plannerRoleSnapshotDigest') = 'string'
        AND (planner_provenance->>'plannerRoleSnapshotDigest') ~ '^[a-f0-9]{64}$'
      );

    ALTER TABLE goal_plan_revisions
      ENABLE TRIGGER goal_plan_revisions_enforce_immutability;

    ALTER TABLE goal_plan_revisions
      DROP CONSTRAINT IF EXISTS goal_plan_revisions_planner_provenance_shape;
    ALTER TABLE goal_plan_revisions
      ADD CONSTRAINT goal_plan_revisions_planner_provenance_shape CHECK (
        planner_provenance IS NULL OR (
          jsonb_typeof(planner_provenance) = 'object'
          AND planner_provenance ?& ARRAY[
            'plannerParticipantId', 'plannerAgentId', 'plannerAgentRevision',
            'plannerModelConnectorId', 'plannerRoleId', 'plannerRoleRevision',
            'plannerRoleSnapshotDigest'
          ]
          AND planner_provenance - ARRAY[
            'plannerParticipantId', 'plannerAgentId', 'plannerAgentRevision',
            'plannerModelConnectorId', 'plannerRoleId', 'plannerRoleRevision',
            'plannerRoleSnapshotDigest'
          ] = '{}'::jsonb
          AND jsonb_typeof(planner_provenance->'plannerParticipantId') = 'string'
          AND (planner_provenance->>'plannerParticipantId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND jsonb_typeof(planner_provenance->'plannerAgentId') = 'string'
          AND (planner_provenance->>'plannerAgentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND jsonb_typeof(planner_provenance->'plannerAgentRevision') = 'number'
          AND (planner_provenance->>'plannerAgentRevision') ~ '^[1-9][0-9]*$'
          AND jsonb_typeof(planner_provenance->'plannerModelConnectorId') = 'string'
          AND (planner_provenance->>'plannerModelConnectorId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND jsonb_typeof(planner_provenance->'plannerRoleId') = 'string'
          AND (planner_provenance->>'plannerRoleId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND jsonb_typeof(planner_provenance->'plannerRoleRevision') = 'number'
          AND (planner_provenance->>'plannerRoleRevision') ~ '^[1-9][0-9]*$'
          AND jsonb_typeof(planner_provenance->'plannerRoleSnapshotDigest') = 'string'
          AND (planner_provenance->>'plannerRoleSnapshotDigest') ~ '^[a-f0-9]{64}$'
        )
      );
  `
}, {
  version: "037_goal_orchestration_admission_goal_run_identity",
  sql: `
    UPDATE goal_job_admissions AS admission
    SET entity_id = run.id::text
    FROM goal_runs AS run
    INNER JOIN execution_contracts AS contract
      ON contract.goal_run_id = run.id
    WHERE admission.goal_run_id = run.id
      AND admission.job_name = 'goal-orchestrate'
      AND admission.state IN ('reserved', 'dispatching', 'admitted', 'running')
      AND admission.entity_id = contract.id::text;
  `
}, {
  version: "038_goal_review_job_bindings",
  sql: `
    CREATE TABLE IF NOT EXISTS goal_review_job_bindings (
      job_id text PRIMARY KEY REFERENCES goal_job_admissions(job_id) ON DELETE CASCADE,
      goal_run_id uuid NOT NULL REFERENCES goal_runs(id) ON DELETE CASCADE,
      job_data jsonb NOT NULL CHECK (
        jsonb_typeof(job_data) = 'object'
        AND octet_length(job_data::text) <= 20000
      ),
      request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^v2:[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS goal_review_job_bindings_goal_run_idx
      ON goal_review_job_bindings(goal_run_id, created_at);
  `
}, {
  version: "039_reviewer_verdict_job_binding",
  sql: `
    ALTER TABLE goal_job_admissions
      DROP CONSTRAINT IF EXISTS goal_job_admissions_job_fingerprint_unique;
    ALTER TABLE goal_job_admissions
      ADD CONSTRAINT goal_job_admissions_job_fingerprint_unique
      UNIQUE (job_id, request_fingerprint);

    ALTER TABLE reviewer_verdicts
      ADD COLUMN IF NOT EXISTS review_job_id text,
      ADD COLUMN IF NOT EXISTS review_request_fingerprint text;

    ALTER TABLE reviewer_verdicts
      DROP CONSTRAINT IF EXISTS reviewer_verdicts_job_binding_shape;
    ALTER TABLE reviewer_verdicts
      ADD CONSTRAINT reviewer_verdicts_job_binding_shape CHECK (
        (review_job_id IS NULL AND review_request_fingerprint IS NULL)
        OR (
          review_job_id IS NOT NULL
          AND length(review_job_id) BETWEEN 1 AND 1000
          AND review_job_id = btrim(review_job_id)
          AND review_request_fingerprint ~ '^v2:[a-f0-9]{64}$'
        )
      );

    ALTER TABLE reviewer_verdicts
      DROP CONSTRAINT IF EXISTS reviewer_verdicts_job_binding_fkey;
    ALTER TABLE reviewer_verdicts
      ADD CONSTRAINT reviewer_verdicts_job_binding_fkey
      FOREIGN KEY (review_job_id, review_request_fingerprint)
      REFERENCES goal_job_admissions(job_id, request_fingerprint)
      ON DELETE RESTRICT;
  `
}, {
  version: "040_meeting_records",
  sql: `
    UPDATE platform_state AS platform
    SET state = jsonb_set(
      platform.state,
      '{meetings}',
      COALESCE((
        SELECT jsonb_agg(
          meeting || jsonb_build_object(
            'closedAt',
            CASE
              WHEN meeting->>'state' = 'closed' AND meeting->>'closedAt' IS NULL THEN
                COALESCE((
                  SELECT to_jsonb(MAX(close_event.created_at))
                  FROM audit_events AS close_event
                  WHERE close_event.event = 'meeting.close'
                    AND close_event.entity_type = 'meeting'
                    AND close_event.entity_id = (meeting->>'id')::uuid
                ), 'null'::jsonb)
              ELSE COALESCE(meeting->'closedAt', 'null'::jsonb)
            END
          )
          ORDER BY ordinal
        )
        FROM jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb))
          WITH ORDINALITY AS entries(meeting, ordinal)
      ), '[]'::jsonb),
      true
    ),
    revision = revision + 1,
    updated_at = now()
    WHERE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb)) AS entries(meeting)
      WHERE NOT meeting ? 'closedAt'
        OR (
          meeting->>'state' = 'closed'
          AND meeting->>'closedAt' IS NULL
          AND EXISTS (
            SELECT 1
            FROM audit_events AS close_event
            WHERE close_event.event = 'meeting.close'
              AND close_event.entity_type = 'meeting'
              AND close_event.entity_id = (meeting->>'id')::uuid
          )
        )
    );

    CREATE TABLE IF NOT EXISTS meeting_records (
      meeting_id uuid NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      closed_at timestamptz NOT NULL,
      generated_at timestamptz NOT NULL,
      generation_mode text NOT NULL CHECK (generation_mode IN ('deterministic', 'model_assisted')),
      content jsonb NOT NULL CHECK (
        jsonb_typeof(content) = 'object'
        AND NOT (content ? 'utterances')
      ),
      source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
      created_by text NOT NULL CHECK (created_by IN ('system', 'owner')),
      UNIQUE (meeting_id, revision),
      UNIQUE (meeting_id, source_digest)
    );
    CREATE INDEX IF NOT EXISTS meeting_records_meeting_latest_idx
      ON meeting_records(meeting_id, revision DESC, generated_at DESC);

    CREATE OR REPLACE FUNCTION reject_meeting_record_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'meeting_records are append-only';
    END;
    $$;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'meeting_records'::regclass
          AND tgname = 'meeting_records_append_only'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER meeting_records_append_only
          BEFORE UPDATE OR DELETE ON meeting_records
          FOR EACH ROW EXECUTE FUNCTION reject_meeting_record_mutation();
      END IF;
    END;
    $$;
  `
}, {
  version: "041_omp_runtime_runs",
  sql: `
    ALTER TABLE execution_contracts
      ADD COLUMN IF NOT EXISTS runtime_bindings jsonb NOT NULL DEFAULT '[]'::jsonb;

    CREATE TABLE IF NOT EXISTS runtime_runs (
      id uuid PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('meeting_turn', 'task_agent', 'tool_execution')),
      scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND octet_length(scope::text) <= 4000),
      runtime_profile jsonb NOT NULL CHECK (
        jsonb_typeof(runtime_profile) = 'object'
        AND octet_length(runtime_profile::text) <= 8000
      ),
      goal_run_id uuid REFERENCES goal_runs(id) ON DELETE RESTRICT,
      task_id uuid,
      agent_id uuid NOT NULL,
      agent_revision integer NOT NULL CHECK (agent_revision > 0),
      role_id uuid,
      role_revision integer CHECK (role_revision IS NULL OR role_revision > 0),
      state text NOT NULL CHECK (state IN (
        'queued', 'provisioning', 'ready', 'running', 'awaiting_approval', 'paused',
        'completed', 'failed', 'cancelled', 'expired'
      )),
      attempt integer NOT NULL CHECK (attempt > 0),
      idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 500),
      evidence_ids uuid[] NOT NULL DEFAULT '{}',
      queued_at timestamptz NOT NULL,
      started_at timestamptz,
      completed_at timestamptz,
      expires_at timestamptz,
      error_code text CHECK (error_code IS NULL OR length(btrim(error_code)) BETWEEN 1 AND 120),
      runtime_version text CHECK (runtime_version IS NULL OR length(btrim(runtime_version)) BETWEEN 1 AND 120),
      provider_session_id text UNIQUE CHECK (
        provider_session_id IS NULL OR length(btrim(provider_session_id)) BETWEEN 1 AND 500
      ),
      lease_id uuid UNIQUE,
      revision integer NOT NULL CHECK (revision > 0),
      heartbeat_at timestamptz,
      event_cursor bigint NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
      paused_at timestamptz,
      updated_at timestamptz NOT NULL,
      CHECK (
        (state IN ('completed', 'failed', 'cancelled', 'expired') AND completed_at IS NOT NULL AND expires_at IS NULL)
        OR (state NOT IN ('completed', 'failed', 'cancelled', 'expired') AND completed_at IS NULL AND expires_at IS NOT NULL)
      ),
      CHECK ((state = 'failed' AND error_code IS NOT NULL) OR state <> 'failed'),
      CHECK ((state = 'paused' AND paused_at IS NOT NULL) OR (state <> 'paused' AND paused_at IS NULL)),
      CHECK (error_code IS DISTINCT FROM 'provider_outcome_unknown' OR state = 'paused'),
      CHECK (expires_at IS NULL OR expires_at > queued_at),
      CHECK (
        runtime_profile->>'harnessKind' IS DISTINCT FROM 'pi'
        OR (
          kind = 'task_agent'
          AND scope->>'kind' = 'task_attempt'
          AND goal_run_id IS NOT NULL
          AND task_id IS NOT NULL
          AND scope->>'subjectId' = task_id::text
          AND runtime_version = 'omp-rpc-v2@18.1.2'
          AND runtime_profile->>'policy' = 'isolated_exec'
        )
      )
    );

    CREATE INDEX IF NOT EXISTS runtime_runs_goal_idx
      ON runtime_runs(goal_run_id, queued_at, id);
    CREATE INDEX IF NOT EXISTS runtime_runs_task_idx
      ON runtime_runs(task_id, attempt DESC, queued_at DESC);
    CREATE INDEX IF NOT EXISTS runtime_runs_recovery_idx
      ON runtime_runs(state, heartbeat_at, updated_at)
      WHERE state IN ('provisioning', 'ready', 'running', 'awaiting_approval', 'paused');

    CREATE TABLE IF NOT EXISTS runtime_run_events (
      id uuid PRIMARY KEY,
      runtime_run_id uuid NOT NULL REFERENCES runtime_runs(id) ON DELETE RESTRICT,
      sequence bigint NOT NULL CHECK (sequence > 0),
      type text NOT NULL CHECK (type IN (
        'state.changed', 'progress.updated', 'tool.started', 'tool.completed',
        'checkpoint.created', 'usage.updated', 'error.recorded', 'owner.action'
      )),
      phase text NOT NULL CHECK (phase IN (
        'queued', 'provisioning', 'ready', 'executing', 'compacting',
        'reconciling', 'paused', 'completed'
      )),
      summary text NOT NULL CHECK (length(btrim(summary)) BETWEEN 1 AND 1000),
      tool_name text CHECK (tool_name IS NULL OR length(btrim(tool_name)) BETWEEN 1 AND 200),
      progress_percent integer CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
      usage jsonb CHECK (usage IS NULL OR (jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 1000)),
      error_code text CHECK (error_code IS NULL OR length(btrim(error_code)) BETWEEN 1 AND 120),
      actor_type text NOT NULL CHECK (actor_type IN ('owner', 'system', 'runtime')),
      occurred_at timestamptz NOT NULL,
      UNIQUE (runtime_run_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS runtime_run_events_replay_idx
      ON runtime_run_events(runtime_run_id, sequence);

    CREATE OR REPLACE FUNCTION runtime_runs_enforce_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF ROW(
        NEW.id, NEW.kind, NEW.scope, NEW.runtime_profile, NEW.goal_run_id, NEW.task_id,
        NEW.agent_id, NEW.agent_revision, NEW.role_id, NEW.role_revision, NEW.attempt,
        NEW.idempotency_key, NEW.queued_at, NEW.runtime_version
      ) IS DISTINCT FROM ROW(
        OLD.id, OLD.kind, OLD.scope, OLD.runtime_profile, OLD.goal_run_id, OLD.task_id,
        OLD.agent_id, OLD.agent_revision, OLD.role_id, OLD.role_revision, OLD.attempt,
        OLD.idempotency_key, OLD.queued_at, OLD.runtime_version
      ) THEN
        RAISE EXCEPTION 'runtime_runs immutable binding changed';
      END IF;
      IF OLD.provider_session_id IS NOT NULL AND NEW.provider_session_id IS DISTINCT FROM OLD.provider_session_id THEN
        RAISE EXCEPTION 'runtime_runs provider session binding is immutable';
      END IF;
      IF OLD.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id THEN
        RAISE EXCEPTION 'runtime_runs lease binding is immutable';
      END IF;
      IF NEW.revision <> OLD.revision + 1 THEN
        RAISE EXCEPTION 'runtime_runs revision must increase by one';
      END IF;
      IF NEW.event_cursor < OLD.event_cursor THEN
        RAISE EXCEPTION 'runtime_runs event cursor cannot move backwards';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS runtime_runs_enforce_mutation_trigger ON runtime_runs;
    CREATE TRIGGER runtime_runs_enforce_mutation_trigger
      BEFORE UPDATE ON runtime_runs
      FOR EACH ROW EXECUTE FUNCTION runtime_runs_enforce_mutation();

    CREATE OR REPLACE FUNCTION runtime_run_events_reject_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'runtime_run_events are append-only';
    END;
    $$;

    DROP TRIGGER IF EXISTS runtime_run_events_reject_update_delete ON runtime_run_events;
    CREATE TRIGGER runtime_run_events_reject_update_delete
      BEFORE UPDATE OR DELETE ON runtime_run_events
      FOR EACH ROW EXECUTE FUNCTION runtime_run_events_reject_mutation();
  `
}] as const;

export interface UtteranceProjectionBackfillResult {
  sourceCount: number;
  processedCount: number;
  insertedCount: number;
  complete: boolean;
}

interface UtteranceProjectionProgressRow {
  source_count: string | null;
  processed_count: string;
}

function parseBackfillCount(value: string, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid Utterance projection ${label}: ${value}`);
  }
  return count;
}

export async function backfillMeetingUtterances(
  pool: Pool,
  batchSize = 100
): Promise<UtteranceProjectionBackfillResult> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("Utterance projection backfill batch size must be a positive safe integer.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const progressResult = await client.query<UtteranceProjectionProgressRow>(`
      SELECT source_count::text, processed_count::text
      FROM utterance_projection_backfill_progress
      WHERE singleton_id = 1
      FOR UPDATE
    `);
    const progress = progressResult.rows[0];
    if (progressResult.rowCount !== 1 || !progress) {
      throw new Error("Migration 021_utterance_projection_expand must be applied before its backfill runs.");
    }

    const processedCount = parseBackfillCount(progress.processed_count, "processed count");
    let sourceCount: number;
    if (progress.source_count === null) {
      const sourceResult = await client.query<{ source_count: string }>(`
        SELECT jsonb_array_length(COALESCE(state->'utterances', '[]'::jsonb))::text AS source_count
        FROM platform_state
        WHERE singleton_id = 1
      `);
      const source = sourceResult.rows[0];
      if (sourceResult.rowCount !== 1 || !source) {
        throw new Error("Cannot fix the Utterance projection source count without platform state.");
      }
      sourceCount = parseBackfillCount(source.source_count, "source count");
      await client.query(`
        UPDATE utterance_projection_backfill_progress
        SET source_count = $1::bigint,
            completed_at = CASE WHEN processed_count >= $1::bigint THEN now() ELSE NULL END,
            updated_at = now()
        WHERE singleton_id = 1
      `, [sourceCount]);
    } else {
      sourceCount = parseBackfillCount(progress.source_count, "source count");
    }

    if (processedCount > sourceCount) {
      throw new Error("Utterance projection progress exceeds its fixed source count.");
    }

    const nextProcessedCount = processedCount + Math.min(batchSize, sourceCount - processedCount);
    let insertedCount = 0;
    if (nextProcessedCount > processedCount) {
      const inserted = await client.query(`
        INSERT INTO meeting_utterances(utterance_id, turn_id, meeting_id, created_at, snapshot)
        SELECT
          (utterance->>'id')::uuid,
          utterance->>'turnId',
          (utterance->>'meetingId')::uuid,
          (utterance->>'createdAt')::timestamptz,
          utterance
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'utterances', '[]'::jsonb))
          WITH ORDINALITY AS entries(utterance, source_position)
        WHERE platform.singleton_id = 1
          AND source_position > $1::bigint
          AND source_position <= $2::bigint
        ORDER BY source_position
        ON CONFLICT DO NOTHING
      `, [processedCount, nextProcessedCount]);
      insertedCount = inserted.rowCount ?? 0;

      await client.query(`
        UPDATE utterance_projection_backfill_progress
        SET processed_count = $1::bigint,
            completed_at = CASE WHEN $1::bigint >= source_count THEN now() ELSE NULL END,
            updated_at = now()
        WHERE singleton_id = 1
      `, [nextProcessedCount]);
    }

    await client.query("COMMIT");
    return {
      sourceCount,
      processedCount: nextProcessedCount,
      insertedCount,
      complete: nextProcessedCount >= sourceCount
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeMeetingUtteranceBackfill(
  pool: Pool,
  batchSize = 1_000
): Promise<UtteranceProjectionBackfillResult> {
  let previousProcessedCount = -1;
  while (true) {
    const result = await backfillMeetingUtterances(pool, batchSize);
    if (result.complete) return result;
    if (result.processedCount <= previousProcessedCount) {
      throw new Error("Utterance projection backfill did not advance.");
    }
    previousProcessedCount = result.processedCount;
  }
}

export interface UtteranceProjectionCutoverResult {
  legacyCount: number;
  reconciledCount: number;
  utteranceCount: number;
  platformRevision: number;
}

export async function cutoverMeetingUtteranceProjection(
  pool: Pool
): Promise<UtteranceProjectionCutoverResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Deployment stops both writers before this operation. This lock also makes
    // a rollback-era legacy reconciliation and JSONB compaction one boundary.
    await client.query("LOCK TABLE meeting_utterances IN SHARE ROW EXCLUSIVE MODE");
    const progressResult = await client.query<UtteranceProjectionSyncProgressRow>(`
      SELECT
        source_count::text,
        processed_count::text,
        completed_at IS NOT NULL AS complete,
        cutover_at IS NOT NULL AS cutover
      FROM utterance_projection_backfill_progress
      WHERE singleton_id = 1
      FOR UPDATE
    `);
    const progress = progressResult.rows[0];
    if (progressResult.rowCount !== 1 || !progress) {
      throw new Error("Migration 021_utterance_projection_expand must be applied before projection cutover.");
    }
    const sourceCount = progress.source_count === null
      ? null
      : parseBackfillCount(progress.source_count, "source count");
    const processedCount = parseBackfillCount(progress.processed_count, "processed count");
    if (!progress.complete || sourceCount === null || processedCount !== sourceCount) {
      throw new Error("Utterance projection backfill is not complete; projection cutover is unsafe.");
    }

    const legacyResult = await client.query<{ utterances: unknown }>(`
      SELECT COALESCE(state->'utterances', '[]'::jsonb) AS utterances
      FROM platform_state
      WHERE singleton_id = 1
      FOR UPDATE
    `);
    const legacyUtterances = legacyResult.rows[0]?.utterances;
    if (legacyResult.rowCount !== 1 || !Array.isArray(legacyUtterances)) {
      throw new Error("Platform state is missing or has an invalid legacy Utterance collection.");
    }
    const legacyCount = legacyUtterances.length;
    const serializedLegacyUtterances = JSON.stringify(legacyUtterances);
    const reconciled = await client.query(`
      INSERT INTO meeting_utterances(utterance_id, turn_id, meeting_id, created_at, snapshot)
      SELECT
        (utterance->>'id')::uuid,
        utterance->>'turnId',
        (utterance->>'meetingId')::uuid,
        (utterance->>'createdAt')::timestamptz,
        utterance
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entries(utterance, source_position)
      ORDER BY source_position
      ON CONFLICT DO NOTHING
    `, [serializedLegacyUtterances]);
    const mismatchResult = await client.query<{ mismatch_count: string }>(`
      SELECT count(*)::text AS mismatch_count
      FROM jsonb_array_elements($1::jsonb) AS entries(utterance)
      LEFT JOIN meeting_utterances AS projected
        ON projected.utterance_id = (utterance->>'id')::uuid
      WHERE projected.utterance_id IS NULL OR projected.snapshot <> utterance
    `, [serializedLegacyUtterances]);
    const mismatchCount = parseBackfillCount(mismatchResult.rows[0]?.mismatch_count ?? "-1", "reconciliation mismatch count");
    if (mismatchCount !== 0) {
      throw new Error("Legacy Utterances conflict with the durable projection; projection cutover is unsafe.");
    }

    const countResult = await client.query<{ total_count: string }>(
      "SELECT count(*)::text AS total_count FROM meeting_utterances"
    );
    const utteranceCount = parseBackfillCount(countResult.rows[0]?.total_count ?? "-1", "projected count");
    if (utteranceCount < sourceCount) {
      throw new Error("Utterance projection contains fewer rows than its completed backfill source.");
    }
    const updateResult = await client.query<{ revision: string }>(`
      UPDATE platform_state
      SET state = jsonb_set(state, '{utterances}', '[]'::jsonb, true),
          revision = revision + 1,
          updated_at = now()
      WHERE singleton_id = 1
      RETURNING revision::text
    `);
    const updated = updateResult.rows[0];
    if (updateResult.rowCount !== 1 || !updated) {
      throw new Error("Platform state is missing during Utterance projection cutover.");
    }
    const platformRevision = parseBackfillCount(updated.revision, "platform revision");
    await client.query(`
      UPDATE utterance_projection_backfill_progress
      SET cutover_at = now(), updated_at = now()
      WHERE singleton_id = 1
    `);
    await client.query("COMMIT");
    return {
      legacyCount,
      reconciledCount: reconciled.rowCount ?? 0,
      utteranceCount,
      platformRevision
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface UtteranceProjectionSyncResult {
  utteranceCount: number;
  platformRevision: number;
}

interface UtteranceProjectionSyncProgressRow extends UtteranceProjectionProgressRow {
  complete: boolean;
  cutover: boolean;
}

export async function synchronizeMeetingUtterancesToPlatformState(
  pool: Pool
): Promise<UtteranceProjectionSyncResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Rollback preparation runs with API and Worker stopped. The table lock also
    // prevents an unexpected writer from racing the compatibility snapshot.
    await client.query("LOCK TABLE meeting_utterances IN SHARE MODE");
    const progressResult = await client.query<UtteranceProjectionSyncProgressRow>(`
      SELECT
        source_count::text,
        processed_count::text,
        completed_at IS NOT NULL AS complete,
        cutover_at IS NOT NULL AS cutover
      FROM utterance_projection_backfill_progress
      WHERE singleton_id = 1
      FOR UPDATE
    `);
    const progress = progressResult.rows[0];
    if (progressResult.rowCount !== 1 || !progress) {
      throw new Error("Migration 021_utterance_projection_expand must be applied before rollback synchronization.");
    }
    const sourceCount = progress.source_count === null
      ? null
      : parseBackfillCount(progress.source_count, "source count");
    const processedCount = parseBackfillCount(progress.processed_count, "processed count");
    if (!progress.complete || !progress.cutover || sourceCount === null || processedCount !== sourceCount) {
      throw new Error("Utterance projection backfill is not complete; rollback synchronization is unsafe.");
    }

    const projectionResult = await client.query<{ utterances: unknown; utterance_count: string }>(`
      SELECT
        COALESCE(
          jsonb_agg(snapshot ORDER BY created_at, sequence_no),
          '[]'::jsonb
        ) AS utterances,
        count(*)::text AS utterance_count
      FROM meeting_utterances
    `);
    const projection = projectionResult.rows[0];
    if (projectionResult.rowCount !== 1 || !projection || !Array.isArray(projection.utterances)) {
      throw new Error("Utterance projection could not be serialized for rollback compatibility.");
    }
    const utteranceCount = parseBackfillCount(projection.utterance_count, "synchronized count");
    if (projection.utterances.length !== utteranceCount || utteranceCount < sourceCount) {
      throw new Error("Utterance projection count is inconsistent with the completed backfill.");
    }

    const updateResult = await client.query<{ revision: string; utterance_count: string }>(`
      UPDATE platform_state
      SET state = jsonb_set(state, '{utterances}', $1::jsonb, true),
          revision = revision + 1,
          updated_at = now()
      WHERE singleton_id = 1
      RETURNING
        revision::text,
        jsonb_array_length(state->'utterances')::text AS utterance_count
    `, [JSON.stringify(projection.utterances)]);
    const updated = updateResult.rows[0];
    if (updateResult.rowCount !== 1 || !updated) {
      throw new Error("Platform state is missing during rollback synchronization.");
    }
    const synchronizedCount = parseBackfillCount(updated.utterance_count, "legacy snapshot count");
    if (synchronizedCount !== utteranceCount) {
      throw new Error("Legacy Utterance snapshot verification failed.");
    }
    const platformRevision = parseBackfillCount(updated.revision, "platform revision");

    await client.query("COMMIT");
    return { utteranceCount, platformRevision };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      SELECT pg_advisory_xact_lock(
        hashtext('council-agent-meeting-platform:migrations'),
        hashtext(COALESCE(current_schema()::text, ''))
      )
    `);
    await client.query(initialSchema);
    const applied = await client.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", ["001_initial"]);
    if (applied.rowCount === 0) {
      await client.query(
        "INSERT INTO platform_state(singleton_id, state) VALUES (1, $1::jsonb) ON CONFLICT (singleton_id) DO NOTHING",
        [JSON.stringify(createSeedSnapshot())]
      );
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", ["001_initial"]);
    }
    const platformState = await client.query<{ singleton_id: number }>(
      "SELECT singleton_id FROM platform_state WHERE singleton_id = 1 FOR UPDATE"
    );
    if (platformState.rowCount !== 1) {
      throw new Error("Platform state is missing during migration.");
    }
    for (const migration of additiveMigrations) {
      const existing = await client.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [migration.version]);
      if (existing.rowCount === 0) {
        if ("validate" in migration) await migration.validate(client);
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [migration.version]);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
