import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  backfillMeetingUtterances,
  completeMeetingUtteranceBackfill,
  cutoverMeetingUtteranceProjection,
  migrateDatabase,
  synchronizeMeetingUtterancesToPlatformState
} from "./migrations.js";

describe("database migrations", () => {
  it("adds a payload fingerprint to idempotency records as an additive migration", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) return { rows: [], rowCount: 0 };
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state: { meetings: [] } }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);

    expect(query.mock.calls.some(([text]) => String(text).includes("ADD COLUMN IF NOT EXISTS request_fingerprint"))).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("002_idempotency_fingerprint"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("jsonb_set") && String(text).includes("chairSuggestions"))).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("003_chair_suggestions_snapshot"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("jsonb_agg") && String(text).includes("transitions") && String(text).includes("acceptanceCriteria"))).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("004_task_work_items_snapshot"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("contentDigest") && String(text).includes("此 Skill 在治理功能上線前已核准"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("治理紀錄不完整，必須重新人工驗證"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("Council legacy registry") && String(text).includes("Platform Owner"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("sha256(convert_to") && String(text).includes("chr(31)"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("CREATE EXTENSION"))).toBe(false);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("005_skill_governance_snapshot"))).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("summaryState") && String(text).includes("not_requested"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("COALESCE(meeting->'summaryState'")
      && String(text).includes("WHEN meeting ? 'summaryJobId' THEN meeting->'summaryJobId'")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("006_meeting_summary_delivery_snapshot"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("roleSnapshot")
      && String(text).includes("agent_read_only_grants")
      && String(text).includes("agent_declared_scope")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("60000000-0000-4000-8000-000000000002")
      && String(text).includes("meeting_chair")
      && !String(text).includes("CASE role->>'name'")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) => String(text).includes("legacy_backfilled"))).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("007_role_policy_snapshots"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("toolRegistrations")
      && String(text).includes("toolRuns")
      && String(text).includes("Platform Owner")
      && String(text).includes("toolGrants")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("008_tool_catalog_evidence_snapshot"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("usageContext")
      && String(text).includes("role_versions")
      && String(text).includes("responsibility")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("010_role_usage_context"))).toBe(true);
    const roleUsageMigration = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes("role_usage_context_candidates"));
    expect(roleUsageMigration).toContain("Conflicting Role version definitions detected during usage context migration");
    expect(roleUsageMigration).not.toContain("用於需要明確責任分工的會議");
    const agendaMigration = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes("meeting_agenda_candidates"));
    expect(agendaMigration).toContain("Invalid existing Meeting Agenda detected during migration");
    expect(agendaMigration).toContain("'revision', 0");
    expect(agendaMigration).toContain("'items', '[]'::jsonb");
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("011_meeting_agenda_snapshot"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("speakerQueue")
      && String(text).includes("leaseExpiresAt")
      && String(text).includes("duplicate Meeting or job reservations")
      && String(text).includes("roleRevision")
      && String(text).includes("roleHistory")
      && String(text).includes("participant->'roleSnapshot'")
      && String(text).includes("meeting->>'createdAt'")
      && String(text).includes("Migration 012")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("012_participant_role_history_and_speaker_queue"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing Chair automation level detected during migration")
      && String(text).includes("Invalid existing Speaker Queue Chair automation binding detected during migration")
      && String(text).includes("COALESCE(item->>'requestedBy', 'owner') = 'system'")
      && String(text).includes("'automationRevision', COALESCE")
      && String(text).includes("'requestedBy', COALESCE")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("013_chair_automation_level"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing Task Agent execution state detected during migration")
      && String(text).includes("Migration 014 requires fresh Owner approval")
      && String(text).includes("'requestFingerprint', null")
      && String(text).includes("'resultEvidenceId', null")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("014_task_agent_execution"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS credential_secrets")
      && String(text).includes("credential_id uuid PRIMARY KEY")
      && String(text).includes("connector_secrets")
      && String(text).includes("credentials")
      && String(text).includes("credentialId")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("015_credential_registry"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS prompt_versions")
      && String(text).includes("prompts")
      && String(text).includes("publishedVersion")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("016_prompt_registry"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS agent_revisions")
      && String(text).includes("draftRevision")
      && String(text).includes("publishedRevision")
      && String(text).includes("legacy_backfilled")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("017_agent_revision_history"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("agentTeams")
      && String(text).includes("meetingPresets")
      && String(text).includes("sourceTeamId")
      && String(text).includes("sourcePresetId")
      && String(text).includes("agentRevision")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("018_agent_teams_and_meeting_presets"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS runtime_profiles")
      && String(text).includes("runtime_profile_revisions")
      && String(text).includes("runtime_profile_binding")
      && String(text).includes("Default text runtime")
      && String(text).includes("openai_compatible")
      && String(text).includes("text_only")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("019_runtime_profiles"))).toBe(true);
    const runtimeProfileMigration = query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("CREATE TABLE IF NOT EXISTS runtime_profiles"));
    expect(runtimeProfileMigration).toContain("AS entries(runtime_revision)");
    expect(runtimeProfileMigration).toContain("(runtime_revision->>'profileId')::uuid");
    expect(runtimeProfileMigration).not.toContain("AS entries(revision)");
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS tool_packs")
      && String(text).includes("tool_pack_revisions")
      && String(text).includes("toolPackGrants")
      && String(text).includes("manifestDigest")
      && String(text).includes("contentDigestVersion")
      && !String(text).includes("snapshot || jsonb_build_object(\n          'toolPackGrants'")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("020_tool_pack_governance"))).toBe(true);
    const toolPackMigration = query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("CREATE TABLE IF NOT EXISTS tool_packs"));
    expect(toolPackMigration).toContain("AS entries(pack_revision)");
    expect(toolPackMigration).toContain("(pack_revision->>'packId')::uuid");
    expect(toolPackMigration).not.toContain("AS entries(revision)");
    const utteranceProjectionMigration = query.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes("CREATE TABLE IF NOT EXISTS meeting_utterances"));
    expect(utteranceProjectionMigration).toContain("utterance_id uuid PRIMARY KEY");
    expect(utteranceProjectionMigration).toContain("turn_id text");
    expect(utteranceProjectionMigration).toContain("meeting_id uuid NOT NULL");
    expect(utteranceProjectionMigration).toContain("created_at timestamptz NOT NULL");
    expect(utteranceProjectionMigration).toContain("sequence_no bigint GENERATED ALWAYS AS IDENTITY");
    expect(utteranceProjectionMigration).toContain("CHECK (jsonb_typeof(snapshot) = 'object')");
    expect(utteranceProjectionMigration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS meeting_utterances_turn_id_idx");
    expect(utteranceProjectionMigration).toContain("WHERE turn_id IS NOT NULL");
    expect(utteranceProjectionMigration).toContain("ON meeting_utterances(meeting_id, created_at, sequence_no)");
    expect(utteranceProjectionMigration).toContain("CREATE TABLE IF NOT EXISTS utterance_projection_backfill_progress");
    expect(utteranceProjectionMigration).toContain("source_count bigint");
    expect(utteranceProjectionMigration).toContain("processed_count bigint NOT NULL DEFAULT 0");
    expect(utteranceProjectionMigration).toContain("cutover_at timestamptz");
    expect(utteranceProjectionMigration).toContain("ON CONFLICT (singleton_id) DO NOTHING");
    expect(utteranceProjectionMigration).not.toContain("jsonb_array_elements");
    expect(utteranceProjectionMigration).not.toContain("INSERT INTO meeting_utterances");
    expect(utteranceProjectionMigration).not.toContain("REFERENCES");
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("021_utterance_projection_expand"))).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("022_mcp_connector_location"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing MCP queue request fingerprint detected during migration")
      && String(text).includes("'requestFingerprint', COALESCE")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("023_mcp_queue_request_fingerprint"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing Topic revision detected during migration")
      && String(text).includes("'revision', COALESCE(topic->'revision', '1'::jsonb)")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("024_topic_revision"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing Task revision detected during migration")
      && String(text).includes("Inconsistent existing Task board revisions detected during migration")
      && String(text).includes("'boardRevision', COALESCE(task->'boardRevision', to_jsonb(board_state.revision))")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("025_task_revisions"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing Connector revision detected during migration")
      && String(text).includes("'{modelConnectors}'")
      && String(text).includes("'{mcpConnectors}'")
      && String(text).includes("'revision', COALESCE(connector->'revision', '1'::jsonb)")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) => Array.isArray(values) && values.includes("026_connector_revisions"))).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS chair_automation_job_admissions")
      && String(text).includes("chair_suggestion_id uuid PRIMARY KEY")
      && String(text).includes("reconciliation_required")
      && String(text).includes("queue_state_terminal")
      && String(text).includes("queue_ownership_unknown")
      && String(text).includes("chair.automation.queued")
      && String(text).includes("jsonb_array_elements")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("027_chair_automation_job_admissions")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("DROP CONSTRAINT IF EXISTS chair_automation_job_admissions_reconciliation_reason_check")
      && String(text).includes("ADD CONSTRAINT chair_automation_job_admissions_reconciliation_reason_check")
      && String(text).includes("queue_state_terminal")
      && String(text).includes("queue_ownership_unknown")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("028_chair_automation_reconciliation_reasons")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS goal_runs")
      && String(text).includes("CREATE TABLE IF NOT EXISTS goal_events")
      && String(text).includes("CREATE TABLE IF NOT EXISTS execution_contracts")
      && String(text).includes("CREATE TABLE IF NOT EXISTS action_runs")
      && String(text).includes("CREATE TABLE IF NOT EXISTS goal_job_admissions")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("029_goal_run_autonomy")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("ADD COLUMN IF NOT EXISTS action_bindings")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("030_execution_contract_action_bindings")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("goal_events_reject_update_delete")
      && String(text).includes("execution_contracts_reject_update_delete")
      && String(text).includes("goal_plan_revisions_enforce_immutability")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("031_goal_run_immutability")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("Invalid existing Role orchestration functions detected during migration")
      && String(text).includes("orchestrationFunctions")
      && String(text).includes("role_versions")
      && String(text).includes("roleHistory")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("032_role_orchestration_functions")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("ADD COLUMN IF NOT EXISTS planner_provenance")
      && String(text).includes("goal_plan_revisions_planner_provenance_shape")
      && String(text).includes("NEW.planner_provenance IS DISTINCT FROM OLD.planner_provenance")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("033_goal_plan_planner_provenance")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("ADD COLUMN IF NOT EXISTS dispatch_token")
      && String(text).includes("ADD COLUMN IF NOT EXISTS dispatch_lease_expires_at")
      && String(text).includes("goal_job_admissions_dispatch_lease_shape")
      && String(text).includes("state = 'dispatching'")
      && String(text).includes("INTERVAL '1 second'")
      && String(text).includes("INTERVAL '60 seconds'")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("035_goal_job_dispatch_lease")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("UPDATE goal_plan_revisions")
      && String(text).includes("plannerParticipantId")
      && String(text).includes("plannerRoleSnapshotDigest")
      && String(text).includes("goal_plan_revisions_planner_provenance_shape")
      && String(text).includes("DISABLE TRIGGER goal_plan_revisions_enforce_immutability")
      && String(text).includes("ENABLE TRIGGER goal_plan_revisions_enforce_immutability")
      && !String(text).includes("roleHistory")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("036_goal_planner_role_provenance")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("UPDATE goal_job_admissions AS admission")
      && String(text).includes("INNER JOIN execution_contracts AS contract")
      && String(text).includes("contract.goal_run_id = run.id")
      && String(text).includes("admission.state IN ('reserved', 'dispatching', 'admitted', 'running')")
      && String(text).includes("admission.entity_id = contract.id::text")
      && String(text).includes("entity_id = run.id::text")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("037_goal_orchestration_admission_goal_run_identity")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS goal_review_job_bindings")
      && String(text).includes("octet_length(job_data::text) <= 20000")
      && String(text).includes("^v2:[a-f0-9]{64}$")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("038_goal_review_job_bindings")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) =>
      String(text).includes("reviewer_verdicts_job_binding_shape")
      && String(text).includes("FOREIGN KEY (review_job_id, review_request_fingerprint)")
      && String(text).includes("REFERENCES goal_job_admissions(job_id, request_fingerprint)")
      && String(text).includes("^v2:[a-f0-9]{64}$")
    )).toBe(true);
    expect(query.mock.calls.some(([_text, values]) =>
      Array.isArray(values) && values.includes("039_reviewer_verdict_job_binding")
    )).toBe(true);
    expect(query.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
  });

  it("serializes migration runners and locks platform state before additive work", async () => {
    const pending = new Set([
      "024_topic_revision",
      "025_task_revisions",
      "026_connector_revisions",
      "027_chair_automation_job_admissions",
      "028_chair_automation_reconciliation_reasons"
    ]);
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: pending.has(String(values?.[0])) ? 0 : 1 };
      }
      if (text.includes("SELECT singleton_id FROM platform_state") && text.includes("FOR UPDATE")) {
        return { rows: [{ singleton_id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);

    const beginIndex = query.mock.calls.findIndex(([text]) => text === "BEGIN");
    const advisoryLockIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("pg_advisory_xact_lock")
    );
    const initialSchemaIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS schema_migrations")
    );
    const platformStateLockIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("SELECT singleton_id FROM platform_state")
      && String(text).includes("FOR UPDATE")
    );
    const firstAdditiveLookupIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("SELECT version FROM schema_migrations")
      && values?.[0] === "002_idempotency_fingerprint"
    );
    const topicLookupIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("SELECT version FROM schema_migrations")
      && values?.[0] === "024_topic_revision"
    );
    const topicMigrationIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("Invalid existing Topic revision detected during migration")
    );
    const topicMarkerIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("INSERT INTO schema_migrations")
      && values?.[0] === "024_topic_revision"
    );
    const taskLookupIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("SELECT version FROM schema_migrations")
      && values?.[0] === "025_task_revisions"
    );
    const taskMigrationIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("Invalid existing Task revision detected during migration")
    );
    const taskMarkerIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("INSERT INTO schema_migrations")
      && values?.[0] === "025_task_revisions"
    );
    const connectorLookupIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("SELECT version FROM schema_migrations")
      && values?.[0] === "026_connector_revisions"
    );
    const connectorMigrationIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("Invalid existing Connector revision detected during migration")
    );
    const connectorMarkerIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("INSERT INTO schema_migrations")
      && values?.[0] === "026_connector_revisions"
    );
    const chairAdmissionLookupIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("SELECT version FROM schema_migrations")
      && values?.[0] === "027_chair_automation_job_admissions"
    );
    const chairAdmissionMigrationIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS chair_automation_job_admissions")
    );
    const chairAdmissionMarkerIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("INSERT INTO schema_migrations")
      && values?.[0] === "027_chair_automation_job_admissions"
    );
    const chairReasonLookupIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("SELECT version FROM schema_migrations")
      && values?.[0] === "028_chair_automation_reconciliation_reasons"
    );
    const chairReasonMigrationIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("DROP CONSTRAINT IF EXISTS chair_automation_job_admissions_reconciliation_reason_check")
    );
    const chairReasonMarkerIndex = query.mock.calls.findIndex(([text, values]) =>
      String(text).includes("INSERT INTO schema_migrations")
      && values?.[0] === "028_chair_automation_reconciliation_reasons"
    );
    const commitIndex = query.mock.calls.findIndex(([text]) => text === "COMMIT");

    expect(beginIndex).toBe(0);
    expect(advisoryLockIndex).toBeGreaterThan(beginIndex);
    expect(initialSchemaIndex).toBeGreaterThan(advisoryLockIndex);
    expect(platformStateLockIndex).toBeGreaterThan(initialSchemaIndex);
    expect(firstAdditiveLookupIndex).toBeGreaterThan(platformStateLockIndex);
    expect(topicMigrationIndex).toBeGreaterThan(topicLookupIndex);
    expect(topicMarkerIndex).toBeGreaterThan(topicMigrationIndex);
    expect(taskLookupIndex).toBeGreaterThan(topicMarkerIndex);
    expect(taskMigrationIndex).toBeGreaterThan(taskLookupIndex);
    expect(taskMarkerIndex).toBeGreaterThan(taskMigrationIndex);
    expect(connectorLookupIndex).toBeGreaterThan(taskMarkerIndex);
    expect(connectorMigrationIndex).toBeGreaterThan(connectorLookupIndex);
    expect(connectorMarkerIndex).toBeGreaterThan(connectorMigrationIndex);
    expect(chairAdmissionLookupIndex).toBeGreaterThan(connectorMarkerIndex);
    expect(chairAdmissionMigrationIndex).toBeGreaterThan(chairAdmissionLookupIndex);
    expect(chairAdmissionMarkerIndex).toBeGreaterThan(chairAdmissionMigrationIndex);
    expect(chairReasonLookupIndex).toBeGreaterThan(chairAdmissionMarkerIndex);
    expect(chairReasonMigrationIndex).toBeGreaterThan(chairReasonLookupIndex);
    expect(chairReasonMarkerIndex).toBeGreaterThan(chairReasonMigrationIndex);
    expect(commitIndex).toBeGreaterThan(chairReasonMarkerIndex);
  });

  it("does not reapply the Utterance projection migration after its version is committed", async () => {
    const applied = new Set<string>();
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: applied.has(String(values?.[0])) ? 1 : 0 };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state: { meetings: [] } }], rowCount: 1 };
      if (text.includes("INSERT INTO schema_migrations")) applied.add(String(values?.[0]));
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);
    await migrateDatabase(pool);

    const executions = query.mock.calls.filter(([text]) =>
      String(text).includes("CREATE TABLE IF NOT EXISTS meeting_utterances")
    );
    expect(executions).toHaveLength(1);
    expect([...applied]).toContain("021_utterance_projection_expand");
  });

  it("backfills one deterministic source batch and advances progress after conflict-tolerant inserts", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (text.includes("FROM utterance_projection_backfill_progress") && text.includes("FOR UPDATE")) {
        return { rows: [{ source_count: null, processed_count: "0" }], rowCount: 1 };
      }
      if (text.includes("jsonb_array_length")) {
        return { rows: [{ source_count: "125" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances")) {
        return { rows: [], rowCount: 100 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(backfillMeetingUtterances(pool)).resolves.toEqual({
      sourceCount: 125,
      processedCount: 100,
      insertedCount: 100,
      complete: false
    });

    const insertCall = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO meeting_utterances"));
    const insertSql = String(insertCall?.[0]);
    expect(insertSql).toContain("WITH ORDINALITY");
    expect(insertSql).toContain("ORDER BY source_position");
    expect(insertSql).toContain("ON CONFLICT DO NOTHING");
    expect(insertCall?.[1]).toEqual([0, 100]);

    const insertOrder = query.mock.invocationCallOrder[query.mock.calls.indexOf(insertCall!)];
    const progressCallIndex = query.mock.calls.findIndex(([text]) =>
      String(text).includes("UPDATE utterance_projection_backfill_progress")
      && String(text).includes("processed_count")
      && !String(text).includes("source_count =")
    );
    expect(progressCallIndex).toBeGreaterThan(-1);
    expect(query.mock.invocationCallOrder[progressCallIndex]).toBeGreaterThan(insertOrder!);
    expect(query.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
  });

  it("rolls back without advancing progress when a backfill batch fails", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (text.includes("FROM utterance_projection_backfill_progress") && text.includes("FOR UPDATE")) {
        return { rows: [{ source_count: "3", processed_count: "1" }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances")) {
        throw new Error("invalid source Utterance");
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(backfillMeetingUtterances(pool, 2)).rejects.toThrow("invalid source Utterance");

    expect(query.mock.calls.some(([text]) =>
      String(text).includes("UPDATE utterance_projection_backfill_progress")
      && String(text).includes("SET processed_count")
    )).toBe(false);
    expect(query.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
    expect(query.mock.calls.some(([text]) => text === "COMMIT")).toBe(false);
  });

  it("runs deterministic backfill batches until the frozen source is complete", async () => {
    let processedCount = 0;
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM utterance_projection_backfill_progress") && text.includes("FOR UPDATE")) {
        return { rows: [{ source_count: "5", processed_count: String(processedCount) }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances")) {
        return { rows: [], rowCount: Number(values?.[1]) - Number(values?.[0]) };
      }
      if (text.includes("UPDATE utterance_projection_backfill_progress") && text.includes("SET processed_count")) {
        processedCount = Number(values?.[0]);
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(completeMeetingUtteranceBackfill(pool, 2)).resolves.toEqual({
      sourceCount: 5,
      processedCount: 5,
      insertedCount: 1,
      complete: true
    });

    expect(query.mock.calls.filter(([text]) => String(text).includes("INSERT INTO meeting_utterances"))).toHaveLength(3);
  });

  it("synchronizes the completed Utterance projection back into the legacy snapshot", async () => {
    const utterances = [{ id: "a4000000-0000-4000-8000-000000000001" }];
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (text.includes("FROM utterance_projection_backfill_progress") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ source_count: "1", processed_count: "1", complete: true, cutover: true }],
          rowCount: 1
        };
      }
      if (text.includes("jsonb_agg(snapshot ORDER BY created_at, sequence_no)")) {
        return { rows: [{ utterances, utterance_count: "1" }], rowCount: 1 };
      }
      if (text.includes("UPDATE platform_state") && text.includes("jsonb_array_length(state->'utterances')")) {
        return { rows: [{ revision: "42", utterance_count: "1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(synchronizeMeetingUtterancesToPlatformState(pool)).resolves.toEqual({
      utteranceCount: 1,
      platformRevision: 42
    });

    const lockIndex = query.mock.calls.findIndex(([text]) => String(text).includes("LOCK TABLE meeting_utterances"));
    const aggregateIndex = query.mock.calls.findIndex(([text]) => String(text).includes("jsonb_agg(snapshot ORDER BY created_at, sequence_no)"));
    const updateIndex = query.mock.calls.findIndex(([text]) => String(text).includes("UPDATE platform_state"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(aggregateIndex).toBeGreaterThan(lockIndex);
    expect(updateIndex).toBeGreaterThan(aggregateIndex);
    expect(query.mock.calls[updateIndex]?.[1]).toEqual([JSON.stringify(utterances)]);
    expect(query.mock.calls.some(([text]) => text === "COMMIT")).toBe(true);
  });

  it("refuses to synchronize an incomplete Utterance projection", async () => {
    const query = vi.fn(async (text: string, _values?: unknown[]) => {
      if (text.includes("FROM utterance_projection_backfill_progress") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ source_count: "3", processed_count: "2", complete: false, cutover: false }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(synchronizeMeetingUtterancesToPlatformState(pool))
      .rejects.toThrow("Utterance projection backfill is not complete");

    expect(query.mock.calls.some(([text]) => String(text).includes("UPDATE platform_state"))).toBe(false);
    expect(query.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });

  it("reconciles legacy Utterances and compacts the singleton row before projection cutover", async () => {
    const legacyUtterances = [{
      id: "a5000000-0000-4000-8000-000000000001",
      meetingId: "85000000-0000-4000-8000-000000000001",
      turnId: "legacy-after-rollback",
      createdAt: "2026-08-07T04:00:00.000Z"
    }];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("FROM utterance_projection_backfill_progress") && text.includes("FOR UPDATE")) {
        return {
          rows: [{ source_count: "1", processed_count: "1", complete: true }],
          rowCount: 1
        };
      }
      if (text.includes("state->'utterances'") && text.includes("AS utterances") && text.includes("FOR UPDATE")) {
        return { rows: [{ utterances: legacyUtterances }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO meeting_utterances")) return { rows: [], rowCount: 1 };
      if (text.includes("AS mismatch_count")) return { rows: [{ mismatch_count: "0" }], rowCount: 1 };
      if (text.includes("count(*)::text AS total_count")) return { rows: [{ total_count: "2" }], rowCount: 1 };
      if (text.includes("UPDATE platform_state") && text.includes("RETURNING revision")) {
        return { rows: [{ revision: "12" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(cutoverMeetingUtteranceProjection(pool)).resolves.toEqual({
      legacyCount: 1,
      reconciledCount: 1,
      utteranceCount: 2,
      platformRevision: 12
    });

    const insert = query.mock.calls.find(([text]) => String(text).includes("INSERT INTO meeting_utterances"));
    expect(insert?.[1]).toEqual([JSON.stringify(legacyUtterances)]);
    const compact = query.mock.calls.find(([text]) =>
      String(text).includes("UPDATE platform_state") && String(text).includes("'{utterances}'")
    );
    expect(compact?.[0]).toContain("'[]'::jsonb");
    expect(query.mock.calls.some(([text]) => String(text).includes("SET cutover_at = now()"))).toBe(true);
  });

  it("does not reapply the Task work-item migration after its version is committed", async () => {
    const applied = new Set<string>();
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: applied.has(String(values?.[0])) ? 1 : 0 };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state: { meetings: [] } }], rowCount: 1 };
      if (text.includes("INSERT INTO schema_migrations")) applied.add(String(values?.[0]));
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);
    await migrateDatabase(pool);

    const taskMigrationExecutions = query.mock.calls.filter(([text]) =>
      String(text).includes("jsonb_agg") && String(text).includes("acceptanceCriteria")
    );
    expect(taskMigrationExecutions).toHaveLength(1);
    expect([...applied]).toContain("004_task_work_items_snapshot");
    expect(query.mock.calls.filter(([text]) => text === "COMMIT")).toHaveLength(2);
  });

  it("does not reapply the Tool Catalog migration after its version is committed", async () => {
    const applied = new Set<string>();
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: applied.has(String(values?.[0])) ? 1 : 0 };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state: { meetings: [] } }], rowCount: 1 };
      if (text.includes("INSERT INTO schema_migrations")) applied.add(String(values?.[0]));
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);
    await migrateDatabase(pool);

    const executions = query.mock.calls.filter(([text]) =>
      String(text).includes("toolRegistrations") && String(text).includes("toolRuns")
    );
    expect(executions).toHaveLength(1);
    expect([...applied]).toContain("008_tool_catalog_evidence_snapshot");
  });

  it("versions Action Runs and Reviewer verdict uniqueness by immutable Contract", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      calls.push(text);
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: values?.[0] === "034_goal_contract_execution_history" ? 0 : 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);

    const sql = calls.join("\n");
    expect(sql).toContain("UNIQUE (goal_run_id, plan_task_id, contract_digest)");
    expect(sql).toContain("UNIQUE (goal_run_id, scope, scope_id, reviewer_agent_id, contract_digest)");
  });

  it("does not reapply the Goal job dispatch lease migration after its version is committed", async () => {
    const applied = new Set<string>();
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: applied.has(String(values?.[0])) ? 1 : 0 };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state: { meetings: [] } }], rowCount: 1 };
      if (text.includes("INSERT INTO schema_migrations")) applied.add(String(values?.[0]));
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);
    await migrateDatabase(pool);

    const executions = query.mock.calls.filter(([text]) =>
      String(text).includes("ADD COLUMN IF NOT EXISTS dispatch_token")
    );
    expect(executions).toHaveLength(1);
    expect([...applied]).toContain("035_goal_job_dispatch_lease");
  });

  it("does not reapply the Planner role provenance migration after its version is committed", async () => {
    const applied = new Set<string>();
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: applied.has(String(values?.[0])) ? 1 : 0 };
      }
      if (text.includes("SELECT state FROM platform_state")) return { rows: [{ state: { meetings: [] } }], rowCount: 1 };
      if (text.includes("INSERT INTO schema_migrations")) applied.add(String(values?.[0]));
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await migrateDatabase(pool);
    await migrateDatabase(pool);

    const executions = query.mock.calls.filter(([text]) =>
      String(text).includes("plannerRoleSnapshotDigest") && String(text).includes("UPDATE goal_plan_revisions")
    );
    expect(executions).toHaveLength(1);
    expect([...applied]).toContain("036_goal_planner_role_provenance");
  });

  it.each([
    {
      label: "a non-ISO lifecycle timestamp",
      agenda: {
        revision: 1,
        items: [{
          id: "81000000-0000-4000-8000-000000000001",
          title: "Runtime parity",
          description: "",
          position: 0,
          status: "current",
          createdAt: "not-a-date",
          updatedAt: "2026-07-20T00:00:00.000Z",
          startedAt: "2026-07-20T00:00:00.000Z",
          resolvedAt: null
        }]
      }
    },
    {
      label: "titles that collide after NFKC normalization",
      agenda: {
        revision: 0,
        items: [
          { id: "81000000-0000-4000-8000-000000000001", title: "Risk", description: "", position: 0, status: "pending", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", startedAt: null, resolvedAt: null },
          { id: "81000000-0000-4000-8000-000000000002", title: "Ｒｉｓｋ", description: "", position: 1, status: "pending", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z", startedAt: null, resolvedAt: null }
        ]
      }
    }
  ])("rolls back before migration 011 for $label", async ({ agenda }) => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: [], rowCount: values?.[0] === "011_meeting_agenda_snapshot" ? 0 : 1 };
      }
      if (text.includes("SELECT state FROM platform_state")) {
        return { rows: [{ state: { meetings: [{ id: "meeting", agenda }] } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Meeting Agenda/i);
    expect(query.mock.calls.some(([text]) => String(text).includes("meeting_agenda_candidates"))).toBe(false);
    expect(query.mock.calls.some(([text]) => text === "ROLLBACK")).toBe(true);
  });
});
