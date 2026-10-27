import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type {
  ActionAdapter,
  ActionRun,
  GoalPlanRevision,
  GoalPlanTask,
  GoalReviewJobData,
  GoalRun,
  GoalTaskBinding,
  TaskAgentRunJobData
} from "@council/contracts";
import {
  actionAdapterEndpointDigest,
  createExecutionContract,
  createExecutionRuntimeBinding,
  createQueuedRuntimeRun,
  goalPlanDigest,
  resolveRuntimeProfileAdmission,
  runtimeRunQueueTtlMs
} from "@council/domain";
import {
  backfillMeetingUtterances,
  cutoverMeetingUtteranceProjection,
  migrateDatabase,
  synchronizeMeetingUtterancesToPlatformState
} from "./migrations.js";
import { PostgresPlatformStore } from "./postgres-store.js";
import {
  goalReviewRequestFingerprint,
  requestFingerprint,
  roleExecutionSnapshotDigest,
  taskExecutionFingerprint
} from "./store.js";

const connectionString = process.env.MIGRATION_TEST_DATABASE_URL;
if (process.env.REQUIRE_MIGRATION_TEST_DATABASE === "1" && !connectionString) {
  throw new Error("MIGRATION_TEST_DATABASE_URL is required for release verification.");
}
const integration = connectionString ? describe : describe.skip;
const integrationOptions = { timeout: 15_000 } as const;
const adminPool = connectionString ? new Pool({ connectionString }) : null;

async function withDisposableSchema<T>(run: (pool: Pool, schema: string) => Promise<T>): Promise<T> {
  if (!adminPool || !connectionString) throw new Error("MIGRATION_TEST_DATABASE_URL is required.");
  const schema = `role_migration_${randomUUID().replaceAll("-", "")}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    return await run(pool, schema);
  } finally {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
}

async function seedPre007State(pool: Pool, state: Record<string, unknown>): Promise<void> {
  await pool.query(`
    CREATE TABLE schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE platform_state (
      singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
      revision bigint NOT NULL DEFAULT 0,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(
    "INSERT INTO schema_migrations(version) SELECT unnest($1::text[])",
    [[
      "002_idempotency_fingerprint",
      "003_chair_suggestions_snapshot",
      "004_task_work_items_snapshot",
      "005_skill_governance_snapshot",
      "006_meeting_summary_delivery_snapshot"
    ]]
  );
  await pool.query(
    "INSERT INTO platform_state(singleton_id, state) VALUES (1, $1::jsonb)",
    [JSON.stringify({ meetings: [], participants: [], ...state })]
  );
}

async function seedPre008State(pool: Pool, state: Record<string, unknown>): Promise<void> {
  await seedPre007State(pool, state);
  await pool.query("INSERT INTO schema_migrations(version) VALUES ('007_role_policy_snapshots')");
}

async function seedPre009State(pool: Pool, state: Record<string, unknown>): Promise<void> {
  await seedPre008State(pool, state);
  await pool.query("INSERT INTO schema_migrations(version) VALUES ('008_tool_catalog_evidence_snapshot')");
}

async function seedPre010State(pool: Pool, state: Record<string, unknown>, versions: Array<{ roleId: string; version: number; snapshot: Record<string, unknown> }>): Promise<void> {
  await seedPre009State(pool, state);
  await pool.query(`
    CREATE TABLE role_versions (
      role_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (role_id, version)
    )
  `);
  for (const entry of versions) {
    await pool.query(
      "INSERT INTO role_versions(role_id, version, snapshot, created_at) VALUES ($1, $2, $3::jsonb, '2026-07-01T00:00:00.000Z')",
      [entry.roleId, entry.version, JSON.stringify(entry.snapshot)]
    );
  }
  await pool.query("INSERT INTO schema_migrations(version) VALUES ('009_role_version_history')");
}

async function seedPre011State(pool: Pool, state: Record<string, unknown>): Promise<void> {
  await seedPre010State(pool, state, []);
  await pool.query("INSERT INTO schema_migrations(version) VALUES ('010_role_usage_context')");
}

integration("Migration runner concurrency against PostgreSQL", integrationOptions, () => {
  it("serializes concurrent callers and applies revision migrations exactly once", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query(
        "DELETE FROM schema_migrations WHERE version = ANY($1::text[])",
        [["024_topic_revision", "025_task_revisions", "026_connector_revisions"]]
      );
      await pool.query(`
        UPDATE platform_state
        SET state = state || jsonb_build_object(
          'threads', $1::jsonb,
          'tasks', $2::jsonb,
          'modelConnectors', $3::jsonb,
          'mcpConnectors', $4::jsonb
        )
        WHERE singleton_id = 1
      `, [
        JSON.stringify([{ id: "topic-concurrent" }]),
        JSON.stringify([{ id: "task-a" }, { id: "task-b" }]),
        JSON.stringify([{ id: "model-concurrent" }]),
        JSON.stringify([{ id: "mcp-concurrent" }])
      ]);
      const before = await pool.query<{ platform_revision: string }>(
        "SELECT revision::text AS platform_revision FROM platform_state WHERE singleton_id = 1"
      );

      const migrations = [migrateDatabase(pool), migrateDatabase(pool)];
      await expect(Promise.all(migrations)).resolves.toEqual([undefined, undefined]);

      const markers = await pool.query<{ version: string; marker_count: number }>(`
        SELECT version, count(*)::int AS marker_count
        FROM schema_migrations
        WHERE version = ANY($1::text[])
        GROUP BY version
        ORDER BY version
      `, [["024_topic_revision", "025_task_revisions", "026_connector_revisions"]]);
      expect(markers.rows).toEqual([
        { version: "024_topic_revision", marker_count: 1 },
        { version: "025_task_revisions", marker_count: 1 },
        { version: "026_connector_revisions", marker_count: 1 }
      ]);

      const result = await pool.query<{
        platform_revision: string;
        topics: Array<{ id: string; revision: number }>;
        tasks: Array<{ id: string; revision: number; boardRevision: number }>;
        model_connectors: Array<{ id: string; revision: number }>;
        mcp_connectors: Array<{ id: string; revision: number }>;
      }>(`
        SELECT
          revision::text AS platform_revision,
          state->'threads' AS topics,
          state->'tasks' AS tasks,
          state->'modelConnectors' AS model_connectors,
          state->'mcpConnectors' AS mcp_connectors
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(result.rows[0]).toEqual({
        platform_revision: String(BigInt(before.rows[0]!.platform_revision) + 3n),
        topics: [{ id: "topic-concurrent", revision: 1 }],
        tasks: [
          { id: "task-a", revision: 1, boardRevision: 1 },
          { id: "task-b", revision: 1, boardRevision: 1 }
        ],
        model_connectors: [{ id: "model-concurrent", revision: 1 }],
        mcp_connectors: [{ id: "mcp-concurrent", revision: 1 }]
      });
    });
  });
});

integration("Meeting Record migration against PostgreSQL", integrationOptions, () => {
  it("restores a legacy close timestamp only from its durable Meeting close audit event", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const meeting = await pool.query<{ meeting_id: string }>(`
        SELECT state->'meetings'->0->>'id' AS meeting_id
        FROM platform_state
        WHERE singleton_id = 1
      `);
      const meetingId = meeting.rows[0]!.meeting_id;
      const closedAt = "2026-08-28T12:34:56.000Z";
      await pool.query("DELETE FROM schema_migrations WHERE version = '040_meeting_records'");
      await pool.query("DROP TABLE meeting_records");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          state #- '{meetings,0,closedAt}',
          '{meetings,0,state}',
          '"closed"'::jsonb
        )
        WHERE singleton_id = 1
      `);
      await pool.query(
        `INSERT INTO audit_events(id, event, entity_type, entity_id, detail, created_at)
         VALUES ($1, 'meeting.close', 'meeting', $2, '{}'::jsonb, $3::timestamptz)`,
        [randomUUID(), meetingId, closedAt]
      );

      await migrateDatabase(pool);

      const result = await pool.query<{
        state: { meetings: Array<{ closedAt?: string | null }> };
        record_table: string | null;
      }>(`
        SELECT
          state,
          to_regclass('meeting_records')::text AS record_table
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(new Date(result.rows[0]!.state.meetings[0]!.closedAt!).toISOString()).toBe(closedAt);
      expect(result.rows[0]!.record_table).toBe("meeting_records");
    });
  });
});

integration("Role policy migration against PostgreSQL", integrationOptions, () => {
  it("uses stable legacy IDs, preserves custom provenance, and snapshots least privilege", async () => {
    await withDisposableSchema(async (pool) => {
      const chairId = "60000000-0000-4000-8000-000000000002";
      const customId = "60000000-0000-4000-8000-000000000099";
      await seedPre007State(pool, {
        roles: [
          { id: chairId, name: "會議主席", responsibility: "主持已知的內建會議。" },
          { id: customId, name: "會議主席", responsibility: "同名但屬於自訂角色。" }
        ],
        participants: [
          { id: "90000000-0000-4000-8000-000000000001", meetingId: "80000000-0000-4000-8000-000000000001", agentId: "50000000-0000-4000-8000-000000000001", roleId: chairId, isChair: true },
          { id: "90000000-0000-4000-8000-000000000002", meetingId: "80000000-0000-4000-8000-000000000001", agentId: "50000000-0000-4000-8000-000000000002", roleId: customId, isChair: false }
        ]
      });

      await migrateDatabase(pool);

      const result = await pool.query<{ state: { roles: Array<Record<string, unknown>>; participants: Array<Record<string, unknown>> } }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      const state = result.rows[0]!.state;
      expect(state.roles.find((role) => role.id === chairId)).toMatchObject({
        templateKey: "meeting_chair",
        usageContext: "用於需要控制議程、發言秩序與時間的會議。",
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      });
      expect(state.roles.find((role) => role.id === customId)).toMatchObject({
        templateKey: null,
        usageContext: "同名但屬於自訂角色。",
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      });
      expect(state.participants.map((participant) => participant.roleSnapshot)).toEqual([
        expect.objectContaining({ roleId: chairId, usageContext: "用於需要控制議程、發言秩序與時間的會議。", templateKey: "meeting_chair", toolPolicy: "none", dataPolicy: "meeting_only" }),
        expect.objectContaining({ roleId: customId, usageContext: "同名但屬於自訂角色。", templateKey: null, toolPolicy: "none", dataPolicy: "meeting_only" })
      ]);
    });
  });

  it("rolls back migration 007 when a participant references a missing Role", async () => {
    await withDisposableSchema(async (pool) => {
      await seedPre007State(pool, {
        roles: [],
        participants: [{
          id: "90000000-0000-4000-8000-000000000001",
          meetingId: "80000000-0000-4000-8000-000000000001",
          agentId: "50000000-0000-4000-8000-000000000001",
          roleId: "60000000-0000-4000-8000-000000000404",
          isChair: true
        }]
      });

      await expect(migrateDatabase(pool)).rejects.toThrow(/orphan participant Role/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '007_role_policy_snapshots'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ state: { participants: Array<Record<string, unknown>> } }>("SELECT state FROM platform_state WHERE singleton_id = 1");
      expect(result.rows[0]!.state.participants[0]).not.toHaveProperty("roleSnapshot");
    });
  });
});

integration("Tool Catalog migration against PostgreSQL", integrationOptions, () => {
  it("backfills conservative metadata, removes stale grants, and never widens legacy approval", async () => {
    await withDisposableSchema(async (pool) => {
      const enabledId = "d0000000-0000-4000-8000-000000000001";
      const disabledId = "d0000000-0000-4000-8000-000000000002";
      await seedPre008State(pool, {
        mcpConnectors: [
          { id: enabledId, name: "Docs", approvedTools: ["search", "search", "", 42], enabled: true },
          { id: disabledId, name: "Archive", approvedTools: ["read"], enabled: false }
        ],
        agents: [{
          id: "50000000-0000-4000-8000-000000000001",
          toolGrants: [
            { connectorId: enabledId, toolName: "search" },
            { connectorId: enabledId, toolName: "write" },
            { connectorId: disabledId, toolName: "read" }
          ]
        }],
        toolRuns: [{
          id: "e0000000-0000-4000-8000-000000000001",
          jobId: "legacy-tool-job",
          meetingId: "80000000-0000-4000-8000-000000000001",
          agentId: "50000000-0000-4000-8000-000000000001",
          connectorId: enabledId,
          toolName: "search",
          status: "succeeded",
          utteranceId: "a0000000-0000-4000-8000-000000000001",
          createdAt: "2026-07-18T00:00:00.000Z"
        }]
      });

      await migrateDatabase(pool);
      const first = await pool.query<{ state: Record<string, unknown> }>("SELECT state FROM platform_state WHERE singleton_id = 1");
      const state = first.rows[0]!.state as {
        mcpConnectors: Array<{ id: string; location: "cloud" | "local"; approvedTools: string[]; toolRegistrations: Array<Record<string, unknown>> }>;
        agents: Array<{ toolGrants: Array<Record<string, unknown>> }>;
        toolRuns: unknown[];
      };

      expect(state.mcpConnectors.find((item) => item.id === enabledId)).toMatchObject({
        location: "local",
        approvedTools: ["search"],
        toolRegistrations: [{
          toolName: "search",
          displayName: "search",
          kind: "mcp_tool",
          version: "unversioned",
          owner: "Platform Owner",
          goal: "以唯讀方式執行 search。"
        }]
      });
      expect(state.mcpConnectors.find((item) => item.id === disabledId)).toMatchObject({
        approvedTools: ["read"],
        toolRegistrations: []
      });
      expect(state.agents[0]!.toolGrants).toEqual([{ connectorId: enabledId, toolName: "search" }]);
      expect(state.toolRuns).toEqual([expect.objectContaining({
        jobId: "legacy-tool-job",
        requestFingerprint: "legacy-unverifiable",
        toolSnapshot: {
          connectorName: "Unknown legacy connector",
          toolName: "search",
          displayName: "search",
          kind: "mcp_tool",
          version: "legacy-unknown",
          owner: "Unknown legacy owner",
          goal: "Legacy Tool Run did not capture request-time metadata."
        }
      })]);

      await migrateDatabase(pool);
      const second = await pool.query<{ state: Record<string, unknown> }>("SELECT state FROM platform_state WHERE singleton_id = 1");
      expect(second.rows[0]!.state).toEqual(first.rows[0]!.state);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '008_tool_catalog_evidence_snapshot'"))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '022_mcp_connector_location'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rejects null, empty, and unknown existing MCP Connector locations", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '022_mcp_connector_location'");

      for (const invalidLocation of [null, "", "edge"]) {
        await pool.query(
          "UPDATE platform_state SET state = jsonb_set(state, '{mcpConnectors}', $1::jsonb, true)",
          [JSON.stringify([{ id: "legacy-mcp", location: invalidLocation }])]
        );
        await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing MCP Connector location/i);
        await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '022_mcp_connector_location'"))
          .resolves.toMatchObject({ rowCount: 0 });
        const result = await pool.query<{ location: unknown }>(
          "SELECT state->'mcpConnectors'->0->'location' AS location FROM platform_state WHERE singleton_id = 1"
        );
        expect(result.rows[0]!.location).toBe(invalidLocation);
      }
    });
  });
});

integration("MCP queue request fingerprint migration against PostgreSQL", integrationOptions, () => {
  it("backfills legacy reservations with an unverifiable null marker and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '023_mcp_queue_request_fingerprint'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          state,
          '{speakerQueue}',
          jsonb_build_array(jsonb_build_object('kind', 'mcp_tool_call')),
          true
        )
      `);

      await migrateDatabase(pool);
      const first = await pool.query<{ request_fingerprint: unknown }>(
        "SELECT state->'speakerQueue'->0->'requestFingerprint' AS request_fingerprint FROM platform_state WHERE singleton_id = 1"
      );
      expect(first.rows[0]!.request_fingerprint).toBeNull();

      await migrateDatabase(pool);
      const second = await pool.query<{ request_fingerprint: unknown }>(
        "SELECT state->'speakerQueue'->0->'requestFingerprint' AS request_fingerprint FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '023_mcp_queue_request_fingerprint'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rejects a fingerprint on a non-MCP reservation without changing persisted state", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '023_mcp_queue_request_fingerprint'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          state,
          '{speakerQueue}',
          jsonb_build_array(jsonb_build_object(
            'kind', 'agent_turn',
            'requestFingerprint', 'must-not-be-present'
          )),
          true
        )
      `);

      await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing MCP queue request fingerprint/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '023_mcp_queue_request_fingerprint'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ request_fingerprint: unknown }>(
        "SELECT state->'speakerQueue'->0->'requestFingerprint' AS request_fingerprint FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.request_fingerprint).toBe("must-not-be-present");
    });
  });
});

integration("Topic revision migration against PostgreSQL", integrationOptions, () => {
  it("backfills a missing Topic revision exactly once", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '024_topic_revision'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          state,
          '{threads,0}',
          (state->'threads'->0) - 'revision',
          false
        )
      `);
      const before = await pool.query<{ revision: string }>(
        "SELECT revision::text FROM platform_state WHERE singleton_id = 1"
      );

      await migrateDatabase(pool);
      const first = await pool.query<{ platform_revision: string; topic_revision: unknown }>(`
        SELECT
          revision::text AS platform_revision,
          state->'threads'->0->'revision' AS topic_revision
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(first.rows[0]).toEqual({
        platform_revision: String(Number(before.rows[0]!.revision) + 1),
        topic_revision: 1
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ platform_revision: string; topic_revision: unknown }>(`
        SELECT
          revision::text AS platform_revision,
          state->'threads'->0->'revision' AS topic_revision
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '024_topic_revision'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rejects invalid existing Topic revisions without changing persisted state", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '024_topic_revision'");

      for (const invalidRevision of [null, 0, -1, 1.5, "1"]) {
        await pool.query(
          "UPDATE platform_state SET state = jsonb_set(state, '{threads,0,revision}', $1::jsonb, true)",
          [JSON.stringify(invalidRevision)]
        );
        await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Topic revision/i);
        await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '024_topic_revision'"))
          .resolves.toMatchObject({ rowCount: 0 });
        const result = await pool.query<{ topic_revision: unknown }>(
          "SELECT state->'threads'->0->'revision' AS topic_revision FROM platform_state WHERE singleton_id = 1"
        );
        expect(result.rows[0]!.topic_revision).toBe(invalidRevision);
      }
    });
  });
});

integration("Task revision migration against PostgreSQL", integrationOptions, () => {
  it("backfills content and shared board revisions exactly once", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '025_task_revisions'");
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{tasks}', $1::jsonb, true)",
        [JSON.stringify([{ id: "task-a" }, { id: "task-b" }])]
      );
      const before = await pool.query<{ revision: string }>(
        "SELECT revision::text FROM platform_state WHERE singleton_id = 1"
      );

      await migrateDatabase(pool);
      const first = await pool.query<{
        platform_revision: string;
        tasks: Array<{ id: string; revision: number; boardRevision: number }>;
      }>(`
        SELECT revision::text AS platform_revision, state->'tasks' AS tasks
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(first.rows[0]).toEqual({
        platform_revision: String(Number(before.rows[0]!.revision) + 1),
        tasks: [
          { id: "task-a", revision: 1, boardRevision: 1 },
          { id: "task-b", revision: 1, boardRevision: 1 }
        ]
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ platform_revision: string; tasks: unknown }>(`
        SELECT revision::text AS platform_revision, state->'tasks' AS tasks
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '025_task_revisions'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rejects invalid or inconsistent existing Task revisions", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '025_task_revisions'");

      for (const invalidRevision of [null, 0, -1, 1.5, "1"]) {
        const tasks = [{ id: "task-a", revision: invalidRevision, boardRevision: 1 }];
        await pool.query(
          "UPDATE platform_state SET state = jsonb_set(state, '{tasks}', $1::jsonb, true)",
          [JSON.stringify(tasks)]
        );
        await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Task revision/i);
        const result = await pool.query<{ tasks: unknown }>(
          "SELECT state->'tasks' AS tasks FROM platform_state WHERE singleton_id = 1"
        );
        expect(result.rows[0]!.tasks).toEqual(tasks);
      }

      const inconsistent = [
        { id: "task-a", revision: 1, boardRevision: 1 },
        { id: "task-b", revision: 1, boardRevision: 2 }
      ];
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{tasks}', $1::jsonb, true)",
        [JSON.stringify(inconsistent)]
      );
      await expect(migrateDatabase(pool)).rejects.toThrow(/Inconsistent existing Task board revisions/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '025_task_revisions'"))
        .resolves.toMatchObject({ rowCount: 0 });
    });
  });
});

integration("Connector revision migration against PostgreSQL", integrationOptions, () => {
  it("backfills missing Model and MCP Connector revisions exactly once", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '026_connector_revisions'");
      await pool.query(`
        UPDATE platform_state
        SET state = state || jsonb_build_object(
          'modelConnectors', $1::jsonb,
          'mcpConnectors', $2::jsonb
        )
        WHERE singleton_id = 1
      `, [
        JSON.stringify([{ id: "model-a" }, { id: "model-b", revision: 4 }]),
        JSON.stringify([{ id: "mcp-a" }, { id: "mcp-b", revision: 7 }])
      ]);
      const before = await pool.query<{ revision: string }>(
        "SELECT revision::text FROM platform_state WHERE singleton_id = 1"
      );

      await migrateDatabase(pool);
      const first = await pool.query<{
        platform_revision: string;
        model_connectors: Array<{ id: string; revision: number }>;
        mcp_connectors: Array<{ id: string; revision: number }>;
      }>(`
        SELECT
          revision::text AS platform_revision,
          state->'modelConnectors' AS model_connectors,
          state->'mcpConnectors' AS mcp_connectors
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(first.rows[0]).toEqual({
        platform_revision: String(Number(before.rows[0]!.revision) + 1),
        model_connectors: [{ id: "model-a", revision: 1 }, { id: "model-b", revision: 4 }],
        mcp_connectors: [{ id: "mcp-a", revision: 1 }, { id: "mcp-b", revision: 7 }]
      });

      await migrateDatabase(pool);
      const second = await pool.query<{
        platform_revision: string;
        model_connectors: unknown;
        mcp_connectors: unknown;
      }>(`
        SELECT
          revision::text AS platform_revision,
          state->'modelConnectors' AS model_connectors,
          state->'mcpConnectors' AS mcp_connectors
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '026_connector_revisions'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rejects invalid existing Model or MCP Connector revisions without changing state", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '026_connector_revisions'");

      for (const [collection, invalidRevision] of [
        ["modelConnectors", null],
        ["modelConnectors", 0],
        ["modelConnectors", 1.5],
        ["mcpConnectors", -1],
        ["mcpConnectors", "1"]
      ] as const) {
        const modelConnectors = collection === "modelConnectors" ? [{ id: "model-invalid", revision: invalidRevision }] : [];
        const mcpConnectors = collection === "mcpConnectors" ? [{ id: "mcp-invalid", revision: invalidRevision }] : [];
        await pool.query(`
          UPDATE platform_state
          SET state = state || jsonb_build_object(
            'modelConnectors', $1::jsonb,
            'mcpConnectors', $2::jsonb
          )
          WHERE singleton_id = 1
        `, [JSON.stringify(modelConnectors), JSON.stringify(mcpConnectors)]);

        await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Connector revision/i);
        const current = await pool.query<{ model_connectors: unknown; mcp_connectors: unknown }>(`
          SELECT
            state->'modelConnectors' AS model_connectors,
            state->'mcpConnectors' AS mcp_connectors
          FROM platform_state
          WHERE singleton_id = 1
        `);
        expect(current.rows[0]).toEqual({ model_connectors: modelConnectors, mcp_connectors: mcpConnectors });
        await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '026_connector_revisions'"))
          .resolves.toMatchObject({ rowCount: 0 });
      }
    });
  });
});

integration("Role lifecycle migration against PostgreSQL", integrationOptions, () => {
  it("takes the platform-state write lock even when Role normalization is already complete", async () => {
    await withDisposableSchema(async (pool, schema) => {
      const roleId = "60000000-0000-4000-8000-000000000090";
      await seedPre009State(pool, {
        roles: [{
          id: roleId,
          name: "已正規化角色",
          responsibility: "驗證 migration lock。",
          speakingGuidance: "只使用已知事實。",
          decisionScope: "提出 migration 結論。",
          constraints: "不得略過鎖定。",
          version: 1,
          templateKey: null,
          toolPolicy: "none",
          dataPolicy: "meeting_only",
          deletedAt: null
        }],
        participants: []
      });

      const blocker = await pool.connect();
      const guardedPool = new Pool({
        connectionString,
        options: `-c search_path=${schema} -c lock_timeout=100ms`
      });
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT singleton_id FROM platform_state WHERE singleton_id = 1 FOR UPDATE");

        await expect(migrateDatabase(guardedPool)).rejects.toThrow(/lock timeout/i);
        await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '009_role_version_history'"))
          .resolves.toMatchObject({ rowCount: 0 });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await guardedPool.end();
      }

      await migrateDatabase(pool);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '009_role_version_history'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("backfills only known current and Meeting-snapshotted versions and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      const roleId = "60000000-0000-4000-8000-000000000091";
      const current = {
        id: roleId,
        name: "架構審查",
        responsibility: "審查目前架構。",
        speakingGuidance: "先界定邊界。",
        decisionScope: "提出候選決議。",
        constraints: "沒有證據時標示假設。",
        version: 3,
        templateKey: null,
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      };
      await seedPre009State(pool, {
        roles: [current],
        meetings: [{ id: "80000000-0000-4000-8000-000000000091", state: "closed", createdAt: "2026-07-01T00:00:00.000Z" }],
        participants: [{
          id: "90000000-0000-4000-8000-000000000091",
          meetingId: "80000000-0000-4000-8000-000000000091",
          agentId: "50000000-0000-4000-8000-000000000091",
          roleId,
          isChair: true,
          roleSnapshot: {
            roleId,
            name: current.name,
            responsibility: "審查初版架構。",
            speakingGuidance: current.speakingGuidance,
            decisionScope: current.decisionScope,
            constraints: current.constraints,
            version: 1,
            templateKey: null,
            toolPolicy: "none",
            dataPolicy: "meeting_only",
            source: "meeting_created"
          }
        }]
      });

      await migrateDatabase(pool);
      const rows = await pool.query<{ snapshot: Record<string, unknown> }>("SELECT snapshot FROM role_versions WHERE role_id = $1 ORDER BY version", [roleId]);
      expect(rows.rows).toEqual([
        { snapshot: expect.objectContaining({ roleId, version: 1, usageContext: "審查初版架構。", responsibility: "審查初版架構。", source: "legacy_backfilled" }) },
        { snapshot: expect.objectContaining({ roleId, version: 3, usageContext: "審查目前架構。", responsibility: "審查目前架構。", source: "legacy_backfilled" }) }
      ]);
      const state = await pool.query<{ state: { roles: Array<Record<string, unknown>>; participants: Array<{ roleSnapshot: Record<string, unknown> }> } }>("SELECT state FROM platform_state WHERE singleton_id = 1");
      expect(state.rows[0]!.state.roles[0]).toMatchObject({ usageContext: "審查目前架構。", deletedAt: null });
      expect(state.rows[0]!.state.participants[0]!.roleSnapshot).toMatchObject({ usageContext: "審查初版架構。" });

      await migrateDatabase(pool);
      await expect(pool.query("SELECT 1 FROM role_versions WHERE role_id = $1", [roleId])).resolves.toMatchObject({ rowCount: 2 });
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '009_role_version_history'"))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '010_role_usage_context'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rolls back when the same historical Role version has conflicting definitions", async () => {
    await withDisposableSchema(async (pool) => {
      const roleId = "60000000-0000-4000-8000-000000000092";
      const role = {
        id: roleId,
        name: "衝突角色",
        responsibility: "目前定義。",
        speakingGuidance: "目前準則。",
        decisionScope: "目前範圍。",
        constraints: "目前限制。",
        version: 1,
        templateKey: null,
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      };
      await seedPre009State(pool, {
        roles: [role],
        participants: [{
          id: "90000000-0000-4000-8000-000000000092",
          meetingId: "80000000-0000-4000-8000-000000000092",
          agentId: "50000000-0000-4000-8000-000000000092",
          roleId,
          isChair: true,
          roleSnapshot: { ...role, roleId, responsibility: "不同的歷史定義。", source: "meeting_created" }
        }]
      });

      await expect(migrateDatabase(pool)).rejects.toThrow(/conflicting Role version/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '009_role_version_history'"))
        .resolves.toMatchObject({ rowCount: 0 });
    });
  });
});

integration("Role usage context migration against PostgreSQL", integrationOptions, () => {
  it("backfills current, Meeting, and historical definitions independently and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      const roleId = "60000000-0000-4000-8000-000000000093";
      const definition = {
        name: "自訂審查",
        speakingGuidance: "先說明證據。",
        decisionScope: "提出候選決議。",
        constraints: "不得代替 Owner 核准。",
        templateKey: null,
        toolPolicy: "none",
        dataPolicy: "meeting_only"
      };
      const current = { id: roleId, ...definition, responsibility: "審查目前架構。", version: 2, deletedAt: null };
      const historical = { roleId, ...definition, responsibility: "審查初版架構。", version: 1, source: "meeting_created" };
      await seedPre010State(pool, {
        roles: [current],
        participants: [{ id: "90000000-0000-4000-8000-000000000093", meetingId: "80000000-0000-4000-8000-000000000093", agentId: "50000000-0000-4000-8000-000000000093", roleId, isChair: true, roleSnapshot: historical }]
      }, [
        { roleId, version: 1, snapshot: { ...historical, source: "legacy_backfilled", restoredFromVersion: null, recordedAt: "2026-07-01T00:00:00.000Z" } },
        { roleId, version: 2, snapshot: { roleId, ...definition, responsibility: current.responsibility, version: 2, source: "legacy_backfilled", restoredFromVersion: null, recordedAt: "2026-07-01T00:00:00.000Z" } }
      ]);

      await migrateDatabase(pool);
      const first = await pool.query<{ revision: string; state: { roles: Array<Record<string, unknown>>; participants: Array<{ roleSnapshot: Record<string, unknown> }> } }>("SELECT revision, state FROM platform_state WHERE singleton_id = 1");
      expect(first.rows[0]!.state.roles[0]).toMatchObject({ usageContext: "審查目前架構。" });
      expect(first.rows[0]!.state.participants[0]!.roleSnapshot).toMatchObject({ usageContext: "審查初版架構。" });
      const versions = await pool.query<{ snapshot: Record<string, unknown>; created_at: string }>("SELECT snapshot, created_at::text FROM role_versions WHERE role_id = $1 ORDER BY version", [roleId]);
      expect(versions.rows.map((row) => row.snapshot)).toEqual([
        expect.objectContaining({ version: 1, usageContext: "審查初版架構。", recordedAt: "2026-07-01T00:00:00.000Z" }),
        expect.objectContaining({ version: 2, usageContext: "審查目前架構。", recordedAt: "2026-07-01T00:00:00.000Z" })
      ]);
      expect(versions.rows.every((row) => row.created_at.startsWith("2026-07-01"))).toBe(true);

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: Record<string, unknown> }>("SELECT revision, state FROM platform_state WHERE singleton_id = 1");
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '010_role_usage_context'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rolls back when the same Role version has conflicting usage context", async () => {
    await withDisposableSchema(async (pool) => {
      const roleId = "60000000-0000-4000-8000-000000000094";
      const role = {
        id: roleId,
        name: "衝突角色",
        usageContext: "目前情境。",
        responsibility: "相同職責。",
        speakingGuidance: "相同準則。",
        decisionScope: "相同範圍。",
        constraints: "相同限制。",
        version: 1,
        templateKey: null,
        toolPolicy: "none",
        dataPolicy: "meeting_only",
        deletedAt: null
      };
      const roleVersion = { roleId, ...role, source: "legacy_backfilled", restoredFromVersion: null, recordedAt: "2026-07-01T00:00:00.000Z" };
      delete (roleVersion as { id?: string }).id;
      delete (roleVersion as { deletedAt?: string | null }).deletedAt;
      await seedPre010State(pool, {
        roles: [role],
        participants: [{ id: "90000000-0000-4000-8000-000000000094", meetingId: "80000000-0000-4000-8000-000000000094", agentId: "50000000-0000-4000-8000-000000000094", roleId, isChair: true, roleSnapshot: { ...roleVersion, usageContext: "不同情境。", source: "meeting_created" } }]
      }, [{ roleId, version: 1, snapshot: roleVersion }]);

      await expect(migrateDatabase(pool)).rejects.toThrow(/conflicting Role version definitions.*usage context/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '010_role_usage_context'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const state = await pool.query<{ state: { roles: Array<Record<string, unknown>>; participants: Array<{ roleSnapshot: Record<string, unknown> }> } }>("SELECT state FROM platform_state WHERE singleton_id = 1");
      expect(state.rows[0]!.state.roles[0]).toMatchObject({ usageContext: "目前情境。" });
      expect(state.rows[0]!.state.participants[0]!.roleSnapshot).toMatchObject({ usageContext: "不同情境。" });
    });
  });
});

integration("Meeting Agenda migration against PostgreSQL", integrationOptions, () => {
  const legacyMeeting = {
    id: "80000000-0000-4000-8000-000000000099",
    threadId: "40000000-0000-4000-8000-000000000099",
    title: "Legacy Meeting",
    goal: "Preserve known history only.",
    state: "closed",
    mode: "open",
    automation: "suggest",
    durationMinutes: 30,
    startedAt: "2026-07-01T00:00:00.000Z",
    summaryState: "completed",
    summaryJobId: null,
    createdAt: "2026-07-01T00:00:00.000Z"
  };

  it("adds an empty versioned Agenda to legacy Meetings and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      await seedPre011State(pool, { roles: [], participants: [], meetings: [legacyMeeting] });

      await migrateDatabase(pool);
      const first = await pool.query<{ revision: string; state: { meetings: Array<Record<string, unknown>> } }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(first.rows[0]!.state.meetings[0]).toMatchObject({
        id: legacyMeeting.id,
        agenda: { revision: 0, items: [] }
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: Record<string, unknown> }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '011_meeting_agenda_snapshot'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("preserves an existing valid Agenda without fabricating history", async () => {
    await withDisposableSchema(async (pool) => {
      const agenda = {
        revision: 4,
        items: [{
          id: "81000000-0000-4000-8000-000000000099",
          title: "Known item",
          description: "Known history",
          position: 0,
          status: "completed",
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:10:00.000Z",
          startedAt: "2026-07-01T00:01:00.000Z",
          resolvedAt: "2026-07-01T00:10:00.000Z"
        }]
      };
      await seedPre011State(pool, { roles: [], participants: [], meetings: [{ ...legacyMeeting, agenda }] });

      await migrateDatabase(pool);
      const result = await pool.query<{ state: { meetings: Array<{ agenda: unknown }> } }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.state.meetings[0]!.agenda).toEqual(agenda);
    });
  });

  it("rolls back when an existing Agenda is malformed", async () => {
    await withDisposableSchema(async (pool) => {
      const malformed = { revision: 1, items: "not-an-array" };
      await seedPre011State(pool, { roles: [], participants: [], meetings: [{ ...legacyMeeting, agenda: malformed }] });

      await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Meeting Agenda/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '011_meeting_agenda_snapshot'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ state: { meetings: Array<{ agenda: unknown }> } }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.state.meetings[0]!.agenda).toEqual(malformed);
    });
  });

  it.each([
    ["a non-ISO timestamp", {
      revision: 1,
      items: [{
        id: "81000000-0000-4000-8000-000000000091",
        title: "Timestamp validation",
        description: "",
        position: 0,
        status: "current",
        createdAt: "not-a-date",
        updatedAt: "2026-07-01T00:00:00.000Z",
        startedAt: "2026-07-01T00:00:00.000Z",
        resolvedAt: null
      }]
    }],
    ["NFKC-equivalent titles", {
      revision: 0,
      items: [
        { id: "81000000-0000-4000-8000-000000000092", title: "Risk", description: "", position: 0, status: "pending", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", startedAt: null, resolvedAt: null },
        { id: "81000000-0000-4000-8000-000000000093", title: "Ｒｉｓｋ", description: "", position: 1, status: "pending", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", startedAt: null, resolvedAt: null }
      ]
    }]
  ])("rolls back runtime-incompatible Agenda data: %s", async (_label, agenda) => {
    await withDisposableSchema(async (pool) => {
      await seedPre011State(pool, { roles: [], participants: [], meetings: [{ ...legacyMeeting, agenda }] });

      await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Meeting Agenda/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '011_meeting_agenda_snapshot'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ state: { meetings: Array<{ agenda: unknown }> } }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.state.meetings[0]!.agenda).toEqual(agenda);
    });
  });
});

integration("Participant Role and Speaker Queue migration against PostgreSQL", integrationOptions, () => {
  it("backfills the initial Role history, preserves an existing queue, and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      const roleId = "60000000-0000-4000-0000-000000000012";
      const meetingId = "80000000-0000-4000-0000-000000000012";
      const participantId = "90000000-0000-4000-0000-000000000012";
      const roleSnapshot = {
        roleId,
        name: "會議主席",
        responsibility: "控制議程、發言秩序與時間。",
        speakingGuidance: "先回應目前議題。",
        decisionScope: "提出候選決議。",
        constraints: "不得代替擁有者核准。",
        version: 1,
        templateKey: "meeting_chair",
        toolPolicy: "none",
        dataPolicy: "meeting_only",
        source: "meeting_created"
      };
      const existingQueue = [{
        id: "legacy-job",
        jobId: "legacy-job",
        meetingId,
        participantId,
        agentId: "50000000-0000-4000-0000-000000000012",
        roleRevision: 1,
        roleId,
        roleVersion: 1,
        roleName: "會議主席",
        agendaRevision: 0,
        agendaCurrentItemId: null,
        status: "queued",
        requestedAt: "2026-07-01T00:00:00.000Z",
        startedAt: null
      }];
      await seedPre011State(pool, {
        meetings: [{
          id: meetingId,
          threadId: "40000000-0000-4000-0000-000000000012",
          title: "Legacy meeting",
          goal: "Preserve role execution history.",
          state: "active",
          mode: "chaired",
          automation: "suggest",
          durationMinutes: 30,
          startedAt: null,
          summaryState: "not_requested",
          summaryJobId: null,
          createdAt: "2026-07-01T00:00:00.000Z"
        }],
        participants: [{
          id: participantId,
          meetingId,
          agentId: "50000000-0000-4000-0000-000000000012",
          roleId,
          isChair: true,
          roleSnapshot
        }],
        speakerQueue: existingQueue
      });

      await migrateDatabase(pool);
      const first = await pool.query<{ revision: string; state: { participants: Array<Record<string, unknown>>; speakerQueue: unknown[] } }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      const participant = first.rows[0]!.state.participants[0]!;
      expect(participant).toMatchObject({ roleRevision: 1 });
      expect(participant.roleHistory).toEqual([{
        revision: 1,
        roleId,
        roleSnapshot: { ...roleSnapshot, orchestrationFunctions: ["chair", "planner"] },
        changedAt: "2026-07-01T00:00:00.000Z",
        changedBy: "system",
        reason: "Migration 012 initialized the participant Role revision and history."
      }]);
      expect(first.rows[0]!.state.speakerQueue).toEqual([{
        ...existingQueue[0],
        kind: "agent_turn",
        label: "會議主席 發言",
        toolName: null,
        requestFingerprint: null,
        leaseExpiresAt: "2026-07-01T00:05:00.000Z",
        requestedBy: "owner",
        chairSuggestionId: null,
        automationRevision: null
      }]);

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: Record<string, unknown> }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '012_participant_role_history_and_speaker_queue'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("uses a migration timestamp when the participant's Meeting has no createdAt", async () => {
    await withDisposableSchema(async (pool) => {
      const roleId = "60000000-0000-4000-0000-000000000013";
      const meetingId = "80000000-0000-4000-0000-000000000013";
      const participantId = "90000000-0000-4000-0000-000000000013";
      await seedPre011State(pool, {
        meetings: [{ id: meetingId, state: "draft" }],
        participants: [{
          id: participantId,
          meetingId,
          agentId: "50000000-0000-4000-0000-000000000013",
          roleId,
          isChair: false,
          roleSnapshot: {
            roleId,
            name: "證據分析",
            responsibility: "整理來源與證據缺口。",
            speakingGuidance: "先列出已知證據。",
            decisionScope: "提出證據核對建議。",
            constraints: "不得把假設當成事實。",
            version: 2,
            templateKey: "evidence_analyst",
            toolPolicy: "none",
            dataPolicy: "meeting_only",
            source: "meeting_created"
          }
        }]
      });

      await migrateDatabase(pool);
      const result = await pool.query<{ state: { speakerQueue: unknown[]; participants: Array<{ roleHistory: Array<{ changedAt: string }> }> } }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.state.speakerQueue).toEqual([]);
      expect(result.rows[0]!.state.participants[0]!.roleHistory).toHaveLength(1);
      expect(result.rows[0]!.state.participants[0]!.roleHistory[0]!.changedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
    });
  });
});

integration("Chair automation migration against PostgreSQL", integrationOptions, () => {
  it("backfills legacy policy bindings, preserves valid levels, and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '013_chair_automation_level'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          jsonb_set(state #- '{meetings,0,automationRevision}', '{meetings,0,automation}', '"auto"'::jsonb, true),
          '{speakerQueue}',
          jsonb_build_array(jsonb_build_object(
            'id', 'legacy-chair-job',
            'jobId', 'legacy-chair-job',
            'meetingId', state->'meetings'->0->'id',
            'participantId', state->'participants'->0->'id',
            'agentId', state->'participants'->0->'agentId',
            'kind', 'agent_turn',
            'label', 'Legacy Chair',
            'toolName', null,
            'roleRevision', state->'participants'->0->'roleRevision',
            'roleId', state->'participants'->0->'roleId',
            'roleVersion', state->'participants'->0->'roleSnapshot'->'version',
            'roleName', state->'participants'->0->'roleSnapshot'->'name',
            'agendaRevision', state->'meetings'->0->'agenda'->'revision',
            'agendaCurrentItemId', null,
            'status', 'queued',
            'requestedAt', '2026-07-20T00:00:00.000Z',
            'startedAt', null,
            'leaseExpiresAt', '2026-07-20T00:05:00.000Z'
          )),
          true
        )
      `);

      await migrateDatabase(pool);
      const first = await pool.query<{ revision: string; state: {
        meetings: Array<{ automation: string; automationRevision: number }>;
        speakerQueue: Array<Record<string, unknown>>;
      } }>("SELECT revision, state FROM platform_state WHERE singleton_id = 1");
      expect(first.rows[0]!.state.meetings[0]).toMatchObject({ automation: "auto", automationRevision: 0 });
      expect(first.rows[0]!.state.speakerQueue[0]).toMatchObject({
        requestedBy: "owner",
        chairSuggestionId: null,
        automationRevision: null
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: Record<string, unknown> }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '013_chair_automation_level'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rolls back an unknown existing Chair automation value", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '013_chair_automation_level'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(state, '{meetings,0,automation}', '"unbounded"'::jsonb, true)
      `);

      await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Chair automation level/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '013_chair_automation_level'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ automation: string }>(
        "SELECT state->'meetings'->0->>'automation' AS automation FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.automation).toBe("unbounded");
    });
  });

  it("rolls back a system speaker reservation without its Chair binding", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '013_chair_automation_level'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          state,
          '{speakerQueue}',
          jsonb_build_array(jsonb_build_object('requestedBy', 'system')),
          true
        )
      `);

      await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Speaker Queue Chair automation binding/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '013_chair_automation_level'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ requested_by: string }>(
        "SELECT state->'speakerQueue'->0->>'requestedBy' AS requested_by FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.requested_by).toBe("system");
    });
  });
});

integration("Task Agent execution migration against PostgreSQL", integrationOptions, () => {
  const legacyTask = {
    id: "92000000-0000-4000-8000-000000000014",
    meetingId: "80000000-0000-4000-8000-000000000001",
    decisionId: "b0000000-0000-4000-8000-000000000014",
    title: "Legacy approved Worker metadata",
    description: "Approval predates auditable Task Agent execution.",
    status: "todo",
    position: 0,
    assignee: "Architect-R",
    assigneeAgentId: "50000000-0000-4000-8000-000000000001",
    dueAt: null,
    acceptanceCriteria: "Owner must approve again.",
    evidence: [],
    executionProfile: "worker",
    allowedTools: [],
    dataScope: "Task only",
    approvalState: "approved",
    transitions: [],
    sync: {
      status: "not_synced",
      adapterId: null,
      jobId: null,
      requestFingerprint: null,
      externalId: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      syncedAt: null
    },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z"
  };

  it("backfills idle execution, invalidates legacy Worker approval, and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '014_task_agent_execution'");
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{tasks}', $1::jsonb, true)",
        [JSON.stringify([legacyTask])]
      );

      await migrateDatabase(pool);
      const first = await pool.query<{ revision: string; state: { tasks: Array<Record<string, unknown>> } }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(first.rows[0]!.state.tasks[0]).toMatchObject({
        approvalState: "pending",
        execution: {
          revision: 0,
          status: "idle",
          jobId: null,
          requestFingerprint: null,
          agentId: null,
          profile: null,
          attemptCount: 0,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          lastError: null,
          resultEvidenceId: null
        },
        transitions: [expect.objectContaining({
          id: `migration014:approval:${legacyTask.id}`,
          type: "approval_changed",
          actor: "system",
          fromApprovalState: "approved",
          toApprovalState: "pending"
        })]
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: Record<string, unknown> }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '014_task_agent_execution'"))
        .resolves.toMatchObject({ rowCount: 1 });
    });
  });

  it("rolls back an invalid existing Task execution binding", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '014_task_agent_execution'");
      const invalidTask = {
        ...legacyTask,
        approvalState: "pending",
        execution: {
          revision: 1,
          status: "running",
          jobId: null,
          requestFingerprint: null,
          agentId: null,
          profile: "worker",
          attemptCount: 1,
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          lastError: null,
          resultEvidenceId: null
        }
      };
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{tasks}', $1::jsonb, true)",
        [JSON.stringify([invalidTask])]
      );

      await expect(migrateDatabase(pool)).rejects.toThrow(/Invalid existing Task Agent execution state/i);
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '014_task_agent_execution'"))
        .resolves.toMatchObject({ rowCount: 0 });
      const result = await pool.query<{ state: { tasks: Array<{ execution: { status: string; jobId: null } }> } }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      expect(result.rows[0]!.state.tasks[0]!.execution).toMatchObject({ status: "running", jobId: null });
    });
  });
});

integration("Agent management control-plane migrations against PostgreSQL", integrationOptions, () => {
  it("creates governed registries, backfills Agent revisions, and remains idempotent", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);

      const first = await pool.query<{
        revision: string;
        state: {
          credentials: unknown[];
          prompts: unknown[];
          agentTeams: unknown[];
          meetingPresets: unknown[];
          runtimeProfiles: Array<{ id: string; revision: number; policy: string; capabilities: string[] }>;
          runtimeProfileRevisions: Array<{ profileId: string; revision: number; source: string }>;
          toolPacks: unknown[];
          toolPackRevisions: unknown[];
          agents: Array<{
            id: string;
            draftRevision: number;
            publishedRevision: number;
            lifecycleStatus: string;
            promptBinding: null;
            runtimeProfileBinding: { profileId: string; revision: number };
            toolPackGrants: unknown[];
          }>;
          meetings: Array<{ sourceTeamId: null; sourcePresetId: null }>;
          participants: Array<{ agentRevision: number }>;
        };
      }>("SELECT revision, state FROM platform_state WHERE singleton_id = 1");
      const versions = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version >= '015' ORDER BY version"
      );
      const agentRevisionCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM agent_revisions");
      const promptVersionCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM prompt_versions");
      const runtimeProfileCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM runtime_profiles");
      const runtimeProfileRevisionCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM runtime_profile_revisions");
      const toolPackCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tool_packs");
      const toolPackRevisionCount = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM tool_pack_revisions");
      const legacyAgentRevisions = await pool.query<{
        snapshot: { contentDigest: string; contentDigestVersion: number; toolPackGrants?: unknown[] };
        toolPackGrants: unknown[];
      }>('SELECT snapshot, tool_pack_grants AS "toolPackGrants" FROM agent_revisions ORDER BY agent_id, revision');

      expect(versions.rows.map((row) => row.version)).toEqual([
        "015_credential_registry",
        "016_prompt_registry",
        "017_agent_revision_history",
        "018_agent_teams_and_meeting_presets",
        "019_runtime_profiles",
        "020_tool_pack_governance",
        "021_utterance_projection_expand",
        "022_mcp_connector_location",
        "023_mcp_queue_request_fingerprint",
        "024_topic_revision",
        "025_task_revisions",
        "026_connector_revisions",
        "027_chair_automation_job_admissions",
        "028_chair_automation_reconciliation_reasons",
        "029_goal_run_autonomy",
        "030_execution_contract_action_bindings",
        "031_goal_run_immutability",
        "032_role_orchestration_functions",
        "033_goal_plan_planner_provenance",
        "034_goal_contract_execution_history",
        "035_goal_job_dispatch_lease",
        "036_goal_planner_role_provenance",
        "037_goal_orchestration_admission_goal_run_identity",
        "038_goal_review_job_bindings",
        "039_reviewer_verdict_job_binding",
        "040_meeting_records",
        "041_omp_runtime_runs"
      ]);
      expect(first.rows[0]!.state).toMatchObject({
        credentials: [],
        prompts: [],
        agentTeams: [],
        meetingPresets: [],
        runtimeProfiles: [expect.objectContaining({
          id: "76000000-0000-4000-8000-000000000001",
          revision: 1,
          policy: "text_only",
          capabilities: ["text", "abort"]
        })],
        runtimeProfileRevisions: [expect.objectContaining({
          profileId: "76000000-0000-4000-8000-000000000001",
          revision: 1,
          source: "legacy_backfilled"
        })],
        toolPacks: [],
        toolPackRevisions: []
      });
      expect(first.rows[0]!.state.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          draftRevision: 1,
          publishedRevision: 1,
          lifecycleStatus: "published",
          promptBinding: null,
          toolPackGrants: [],
          runtimeProfileBinding: {
            profileId: "76000000-0000-4000-8000-000000000001",
            revision: 1
          }
        })
      ]));
      expect(first.rows[0]!.state.meetings).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceTeamId: null, sourcePresetId: null })
      ]));
      expect(first.rows[0]!.state.participants.every((participant) => participant.agentRevision === 1)).toBe(true);
      expect(Number(agentRevisionCount.rows[0]!.count)).toBe(first.rows[0]!.state.agents.length);
      expect(promptVersionCount.rows[0]!.count).toBe("0");
      expect(runtimeProfileCount.rows[0]!.count).toBe("1");
      expect(runtimeProfileRevisionCount.rows[0]!.count).toBe("1");
      expect(toolPackCount.rows[0]!.count).toBe("0");
      expect(toolPackRevisionCount.rows[0]!.count).toBe("0");
      expect(legacyAgentRevisions.rows.every((row) => row.snapshot.contentDigestVersion === 1)).toBe(true);
      expect(legacyAgentRevisions.rows.every((row) => !("toolPackGrants" in row.snapshot))).toBe(true);
      expect(legacyAgentRevisions.rows.every((row) => row.toolPackGrants.length === 0)).toBe(true);
      const parsedLegacyRevision = await new PostgresPlatformStore(pool).getAgentRevision(first.rows[0]!.state.agents[0]!.id, 1);
      expect(parsedLegacyRevision).toMatchObject({
        contentDigest: legacyAgentRevisions.rows[0]!.snapshot.contentDigest,
        contentDigestVersion: 1,
        toolPackGrants: []
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: Record<string, unknown> }>(
        "SELECT revision, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
    });
  });

  it("keeps Credential, Prompt, and Agent revisions usable across PostgreSQL transactions", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const store = new PostgresPlatformStore(pool);
      const seed = await store.getSnapshot();
      const agent = seed.agents[0]!;

      const credential = await store.createCredential({
        name: "Cloud test Credential",
        provider: "OpenAI",
        kind: "api_key",
        location: "cloud"
      }, { ciphertext: "encrypted-first" });
      await expect(store.rotateCredential(
        { credentialId: credential.id, expectedSecretRevision: 1 },
        { ciphertext: "encrypted-second" },
        "****test"
      )).resolves.toMatchObject({ secretRevision: 2, maskedHint: "****test" });
      await expect(store.getCredentialSecret(credential.id)).resolves.toBe("encrypted-second");

      const prompt = await store.createPrompt({
        name: "PostgreSQL Agent Prompt",
        kind: "agent",
        description: "Cross-transaction Prompt lifecycle.",
        owner: "Test Owner",
        content: "Focus on {{MEETING_GOAL}}.",
        variables: ["MEETING_GOAL"]
      });
      await expect(store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 }))
        .resolves.toMatchObject({ status: "published", publishedVersion: 1 });

      const connector = await store.createModelConnector({
        name: "PostgreSQL local model",
        location: "local",
        baseUrl: "http://192.168.50.10:4000/v1",
        model: "local-test"
      });
      const runtimeProfile = await store.createRuntimeProfile({
        name: "PostgreSQL text runtime",
        harnessKind: "openai_compatible",
        modelConnectorId: connector.id,
        sandboxProfileId: null,
        policy: "text_only",
        capabilities: ["text", "abort"],
        timeoutMs: 60_000,
        maxConcurrency: 1,
        enabled: true
      });
      const updatedRuntimeProfile = await store.updateRuntimeProfile(runtimeProfile.id, {
        expectedRevision: 1,
        timeoutMs: 75_000
      });
      expect(updatedRuntimeProfile).toMatchObject({ revision: 2, timeoutMs: 75_000 });
      const imageDigest = `sha256:${"a".repeat(64)}`;
      const toolPack = await store.createToolPack({
        name: "PostgreSQL documentation tools",
        version: "1.0.0",
        description: "Cross-transaction Tool Pack lifecycle.",
        owner: "Test Owner",
        sourceReference: `registry.example.com/council/docs@${imageDigest}`,
        imageDigest,
        tools: [{
          name: "search",
          kind: "command",
          goal: "Search immutable documentation.",
          access: "read_only",
          argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
          env: { allowedNames: ["LANG"] },
          stdin: { mode: "none" }
        }]
      });
      const validatedToolPack = await store.validateToolPack(toolPack.id, {
        expectedRevision: toolPack.revision,
        manifestDigest: toolPack.manifestDigest,
        result: "passed",
        summary: "Manifest reviewed."
      });
      const approvedToolPack = await store.approveToolPack(toolPack.id, {
        expectedRevision: validatedToolPack.revision,
        manifestDigest: validatedToolPack.manifestDigest
      });
      const toolPackGrant = {
        packId: approvedToolPack.id,
        revision: approvedToolPack.revision,
        manifestDigest: approvedToolPack.manifestDigest,
        toolName: "search"
      };
      const draft = await store.updateAgent(agent.id, {
        modelConnectorId: connector.id,
        promptBinding: { promptId: prompt.id, version: 1 },
        runtimeProfileBinding: { profileId: runtimeProfile.id, revision: 2 },
        toolPackGrants: [toolPackGrant]
      });
      expect(draft).toMatchObject({ lifecycleStatus: "draft", draftRevision: 2, publishedRevision: 1 });
      await expect(store.publishAgent(agent.id, { expectedDraftRevision: 2 }))
        .resolves.toMatchObject({ lifecycleStatus: "published", publishedRevision: 2 });
      await expect(store.getAgentRevision(agent.id, 2)).resolves.toMatchObject({
        revision: 2,
        contentDigestVersion: 3,
        modelConnectorId: connector.id,
        promptBinding: { promptId: prompt.id, version: 1 },
        runtimeProfileBinding: { profileId: runtimeProfile.id, revision: 2 },
        toolPackGrants: [toolPackGrant],
        publishedAt: expect.any(String)
      });
      await expect(store.getAgentReadiness(agent.id)).resolves.toMatchObject({ status: "ready" });

      const freshAgent = await store.createAgent({
        name: "PostgreSQL fresh draft Agent",
        description: "Cross-transaction create and publish lifecycle.",
        modelConnectorId: connector.id,
        promptBinding: { promptId: prompt.id, version: 1 },
        goalSummary: "Prove a new draft remains unpublished until explicitly published.",
        toolsSummary: "No tools.",
        dataSummary: "Meeting context only.",
        skillIds: [],
        toolGrants: [],
        runtimeProfileBinding: { profileId: runtimeProfile.id, revision: 2 }
      });
      expect(freshAgent).toMatchObject({ lifecycleStatus: "draft", draftRevision: 1, publishedRevision: null });
      await expect(store.publishAgent(freshAgent.id, { expectedDraftRevision: 1 }))
        .resolves.toMatchObject({ lifecycleStatus: "published", publishedRevision: 1 });

      const versionCounts = await pool.query<{ agent: string; prompt: string; runtime: string; toolPack: string; toolPackRevision: string }>(`
        SELECT
          (SELECT count(*)::text FROM agent_revisions WHERE agent_id = $1) AS agent,
          (SELECT count(*)::text FROM prompt_versions WHERE prompt_id = $2) AS prompt,
          (SELECT count(*)::text FROM runtime_profile_revisions WHERE profile_id = $3) AS runtime,
          (SELECT count(*)::text FROM tool_packs WHERE pack_id = $4) AS "toolPack",
          (SELECT count(*)::text FROM tool_pack_revisions WHERE pack_id = $4) AS "toolPackRevision"
      `, [agent.id, prompt.id, runtimeProfile.id, toolPack.id]);
      expect(versionCounts.rows[0]).toEqual({
        agent: "2",
        prompt: "1",
        runtime: "2",
        toolPack: "1",
        toolPackRevision: "3"
      });
    });
  }, 15_000);
});

integration("OMP Goal Runtime admission against PostgreSQL", integrationOptions, () => {
  it("hydrates the immutable Goal Contract for every Task Agent lifecycle transition", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const store = new PostgresPlatformStore(pool);
      const owner = await store.createOwner("omp-goal-owner@example.test", "test-only-hash");
      const initial = await store.getSnapshot();
      const meeting = initial.meetings[0]!;
      const thread = initial.threads.find((candidate) => candidate.id === meeting.threadId)!;

      const connector = await store.createModelConnector({
        name: "PostgreSQL OMP local model",
        location: "local",
        baseUrl: "http://192.168.50.10:4000/v1",
        model: "omp-test"
      });
      const prompt = await store.createPrompt({
        name: "PostgreSQL OMP Goal Prompt",
        kind: "agent",
        description: "Immutable OMP Goal admission fixture.",
        owner: "Test Owner",
        content: "Execute only the approved isolated coding task.",
        variables: []
      });
      await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });
      const profile = await store.createRuntimeProfile({
        name: "PostgreSQL OMP Goal Runtime",
        harnessKind: "pi",
        modelConnectorId: connector.id,
        sandboxProfileId: randomUUID(),
        policy: "isolated_exec",
        capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
        timeoutMs: 2 * 60 * 60_000,
        maxConcurrency: 1,
        enabled: true
      });
      const draftAgent = await store.createAgent({
        name: "PostgreSQL OMP Goal Executor",
        description: "Executes one contract-bound isolated task.",
        modelConnectorId: connector.id,
        goalSummary: "Produce bounded workspace evidence.",
        toolsSummary: "OMP phase-one workspace tools.",
        dataSummary: "Approved workspace archive only.",
        skillIds: [],
        toolGrants: [],
        toolPackGrants: [],
        runtimeProfileBinding: { profileId: profile.id, revision: profile.revision },
        promptBinding: { promptId: prompt.id, version: 1 }
      });
      const agent = await store.publishAgent(draftAgent.id, {
        expectedDraftRevision: draftAgent.draftRevision!
      });
      const decision = await store.createDecision({
        meetingId: meeting.id,
        title: "Create the PostgreSQL OMP canary",
        description: "Create one task-local canary artifact and retain its digest."
      });
      const now = new Date().toISOString();
      const goalRunId = randomUUID();
      const run: GoalRun = {
        id: goalRunId,
        title: "PostgreSQL OMP admission",
        goal: "Prove a Goal-approved OMP task can cross the PostgreSQL execution boundary.",
        threadId: thread.id,
        meetingId: meeting.id,
        state: "planning",
        revision: 1,
        activePlanRevision: 0,
        executionContractId: null,
        limits: {
          discussionRounds: 1,
          maxTasks: 1,
          maxConcurrentTasks: 1,
          maxAttemptsPerTask: 1,
          maxReplans: 0,
          maxDurationMinutes: 30,
          maxModelCalls: 10,
          maxActionCalls: 0
        },
        usage: { discussionRounds: 1, taskAttempts: 0, replans: 0, modelCalls: 1, actionCalls: 0 },
        deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        pausedFromState: null,
        terminalReason: null,
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now
      };
      await store.createGoalRun(run, {
        type: "goal.created",
        actorType: "owner",
        actorId: owner.id,
        entityType: "goal",
        entityId: goalRunId,
        summary: "PostgreSQL OMP Goal created."
      }, `omp-goal-${goalRunId}`);

      const task: GoalPlanTask = {
        id: randomUUID(),
        decisionId: decision.id,
        title: "Create the isolated canary artifact",
        description: "Write one exact task-local file.",
        acceptanceCriteria: "The file content and SHA-256 digest are recorded.",
        dependencyIds: [],
        assigneeAgentId: agent.id,
        executionMode: "worker",
        allowedTools: ["read", "grep", "glob", "lsp", "edit", "bash"],
        dataScope: "Approved immutable workspace archive only.",
        action: null
      };
      const platform = await store.getSnapshot();
      const agentRevision = await store.getAgentRevision(agent.id, agent.publishedRevision!);
      const runtimeProfile = resolveRuntimeProfileAdmission({
        binding: agentRevision.runtimeProfileBinding,
        platform,
        agentModelConnectorId: agentRevision.modelConnectorId,
        executionIsolationAttested: true
      });
      const runtimeBinding = createExecutionRuntimeBinding({
        task,
        agentRevision,
        runtimeProfile,
        modelConnector: connector,
        omp: {
          enabled: true,
          sandboxProfileId: profile.sandboxProfileId!,
          sandboxImageDigest: `sha256:${"a".repeat(64)}`,
          workspaceSourceId: "postgres-omp-test",
          workspaceArchiveDigest: `sha256:${"b".repeat(64)}`
        },
        ompHostToolsEnabled: false
      });
      const plan: GoalPlanRevision = {
        id: randomUUID(),
        goalRunId,
        revision: 1,
        status: "draft",
        digest: goalPlanDigest([task]),
        tasks: [task],
        createdAt: now
      };
      const planned = await store.saveGoalPlan(goalRunId, {
        expectedRevision: 1,
        expectedPlanRevision: 0,
        plan,
        event: {
          type: "plan.created",
          actorType: "owner",
          actorId: owner.id,
          entityType: "plan",
          entityId: plan.id,
          summary: "PostgreSQL OMP Plan created."
        }
      });
      const contract = createExecutionContract({
        goalRunId,
        planRevision: plan.revision,
        tasks: plan.tasks,
        limits: run.limits,
        approvedBy: owner.id,
        approvedAt: now,
        runtimeBindings: [runtimeBinding]
      });
      const approved = await store.approveGoalRun(goalRunId, {
        expectedRevision: planned.goalRun.revision,
        contract,
        bindings: [{
          id: randomUUID(),
          goalRunId,
          planRevision: plan.revision,
          planTaskId: task.id,
          taskId: null,
          state: "ready",
          attemptCount: 0,
          activeJobId: null,
          lastError: null,
          createdAt: now,
          updatedAt: now
        }],
        event: {
          type: "contract.approved",
          actorType: "owner",
          actorId: owner.id,
          entityType: "plan",
          entityId: plan.id,
          summary: "PostgreSQL OMP Contract approved."
        }
      });
      const goalTaskBinding = approved.taskBindings[0]!;
      const canonicalTask = (await store.getSnapshot()).tasks.find((candidate) => (
        candidate.id === goalTaskBinding.taskId
      ))!;
      const makeRuntimeRun = (jobId: string) => createQueuedRuntimeRun({
        id: randomUUID(),
        kind: "task_agent",
        scope: {
          id: `task:${canonicalTask.id}:attempt:1`,
          kind: "task_attempt",
          subjectId: canonicalTask.id,
          parentScopeId: null
        },
        runtimeProfile,
        goalRunId,
        taskId: canonicalTask.id,
        runtimeVersion: runtimeBinding.runtimeVersion,
        agentId: agent.id,
        agentRevision: agentRevision.revision,
        roleId: null,
        roleRevision: null,
        attempt: 1,
        idempotencyKey: jobId,
        queuedAt: new Date().toISOString(),
        ttlMs: runtimeRunQueueTtlMs(runtimeProfile)
      });
      const jobId = `goal-task-${goalRunId}-a1-e1`;
      const job: TaskAgentRunJobData = {
        taskId: canonicalTask.id,
        goalRunId,
        planTaskId: task.id,
        agentId: agent.id,
        executionProfile: "worker",
        executionRevision: canonicalTask.execution.revision + 1,
        taskFingerprint: taskExecutionFingerprint(canonicalTask),
        requestFingerprint: requestFingerprint({ goalRunId, taskId: canonicalTask.id, attempt: 1 }),
        modelConnectorBinding: {
          id: connector.id,
          location: connector.location,
          baseUrl: connector.baseUrl,
          model: connector.model,
          secretRevision: connector.secretRevision
        },
        agentRevision: agentRevision.revision,
        promptBinding: agentRevision.promptBinding,
        skillDigests: {},
        runtimeProfileBinding: { ...agentRevision.runtimeProfileBinding! },
        runtimeProfileSnapshot: runtimeProfile,
        runtimeRun: makeRuntimeRun(jobId),
        executionRuntimeBinding: runtimeBinding,
        requestedBy: "owner"
      };
      const forgedJobId = `${jobId}-forged`;
      await expect(store.markTaskAgentRunQueued(forgedJobId, {
        ...job,
        requestFingerprint: requestFingerprint({ goalRunId, forged: true }),
        runtimeRun: makeRuntimeRun(forgedJobId),
        executionRuntimeBinding: {
          ...runtimeBinding,
          sandboxImageDigest: `sha256:${"c".repeat(64)}`
        }
      })).rejects.toThrow(/execution binding is stale/i);

      await expect(store.markTaskAgentRunQueued(jobId, job)).resolves.toMatchObject({
        status: "updated",
        task: { execution: { status: "queued" } }
      });
      const runningBinding = await store.updateGoalTaskBinding(goalTaskBinding.id, {
        expectedState: "ready",
        state: "running",
        activeJobId: jobId,
        attemptCount: 1,
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: task.id,
          summary: "PostgreSQL OMP Task entered bounded execution."
        }
      });
      await expect(store.markTaskAgentRunRunning(jobId, job)).resolves.toMatchObject({
        status: "updated",
        task: { execution: { status: "running" } }
      });
      await expect(store.claimTaskAgentProviderAttempt(jobId, job)).resolves.toMatchObject({
        status: "updated",
        task: { execution: { providerStartedAt: expect.any(String) } }
      });
      await expect(store.failTaskAgentRun({
        taskId: canonicalTask.id,
        jobId,
        executionRevision: job.executionRevision,
        requestFingerprint: job.requestFingerprint,
        agentId: job.agentId,
        executionProfile: job.executionProfile
      }, "provider_outcome_unknown")).resolves.toMatchObject({
        status: "updated",
        task: { execution: { status: "failed", lastError: "provider_outcome_unknown" } }
      });
      await store.updateGoalTaskBinding(runningBinding.id, {
        expectedState: "running",
        state: "failed",
        activeJobId: null,
        lastError: "provider_outcome_unknown",
        event: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: task.id,
          summary: "PostgreSQL OMP Task fenced an unknown provider outcome."
        }
      });
      await expect(store.completeTaskAgentRun(jobId, {
        ...job,
        runtimeRun: { ...job.runtimeRun!, attempt: 2 }
      }, "Mismatched OMP recovery evidence.")).resolves.toMatchObject({
        status: "stale",
        task: { execution: { status: "failed", resultEvidenceId: null } }
      });
      await expect(store.completeTaskAgentRun(jobId, job, "PostgreSQL OMP canary evidence.")).resolves.toMatchObject({
        status: "updated",
        task: { status: "review", execution: { status: "completed", resultEvidenceId: expect.any(String) } }
      });
    });
  }, 15_000);
});

integration("Utterance projection migration against PostgreSQL", integrationOptions, () => {
  it("creates the additive schema idempotently without running the JSONB backfill", async () => {
    await withDisposableSchema(async (pool, schema) => {
      await migrateDatabase(pool);

      const source = await pool.query<{ count: number }>(`
        SELECT jsonb_array_length(state->'utterances') AS count
        FROM platform_state
        WHERE singleton_id = 1
      `);
      const projected = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM meeting_utterances");
      const progress = await pool.query<{ source_count: string | null; processed_count: string }>(`
        SELECT source_count::text, processed_count::text
        FROM utterance_projection_backfill_progress
        WHERE singleton_id = 1
      `);
      expect(source.rows[0]!.count).toBeGreaterThan(0);
      expect(projected.rows[0]!.count).toBe("0");
      expect(progress.rows[0]).toEqual({ source_count: null, processed_count: "0" });

      const columns = await pool.query<{ column_name: string; data_type: string; is_nullable: string; is_identity: string }>(`
        SELECT column_name, data_type, is_nullable, is_identity
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'meeting_utterances'
      `, [schema]);
      expect(Object.fromEntries(columns.rows.map((column) => [column.column_name, column]))).toMatchObject({
        utterance_id: { data_type: "uuid", is_nullable: "NO", is_identity: "NO" },
        turn_id: { data_type: "text", is_nullable: "YES", is_identity: "NO" },
        meeting_id: { data_type: "uuid", is_nullable: "NO", is_identity: "NO" },
        created_at: { data_type: "timestamp with time zone", is_nullable: "NO", is_identity: "NO" },
        sequence_no: { data_type: "bigint", is_nullable: "NO", is_identity: "YES" },
        snapshot: { data_type: "jsonb", is_nullable: "NO", is_identity: "NO" }
      });
      const progressColumns = await pool.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'utterance_projection_backfill_progress'
      `, [schema]);
      expect(progressColumns.rows.map((column) => column.column_name)).toContain("cutover_at");

      const indexes = await pool.query<{ indexdef: string }>(`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'meeting_utterances'
      `, [schema]);
      expect(indexes.rows.some((row) =>
        row.indexdef.includes("UNIQUE")
        && row.indexdef.includes("(turn_id)")
        && row.indexdef.includes("turn_id IS NOT NULL")
      )).toBe(true);
      expect(indexes.rows.some((row) => row.indexdef.includes("(meeting_id, created_at, sequence_no)"))).toBe(true);

      const foreignKeys = await pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM information_schema.table_constraints
        WHERE table_schema = $1
          AND table_name = 'meeting_utterances'
          AND constraint_type = 'FOREIGN KEY'
      `, [schema]);
      expect(foreignKeys.rows[0]!.count).toBe("0");

      await pool.query("DELETE FROM schema_migrations WHERE version = '021_utterance_projection_expand'");
      await migrateDatabase(pool);
      const versions = await pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM schema_migrations
        WHERE version = '021_utterance_projection_expand'
      `);
      expect(versions.rows[0]!.count).toBe("1");
      await expect(pool.query("SELECT count(*)::text AS count FROM meeting_utterances"))
        .resolves.toMatchObject({ rows: [{ count: "0" }] });
    });
  });

  it("resumes in source order, freezes the first source count, and reruns without duplicates", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const meetingId = "82000000-0000-4000-8000-000000000001";
      const createdAt = "2026-08-07T01:00:00.000Z";
      const utterances = Array.from({ length: 5 }, (_, index) => ({
        id: `a2000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        meetingId,
        ...(index === 0 ? {} : { turnId: `turn-${index + 1}` }),
        speakerType: "agent",
        speakerName: `Agent ${index + 1}`,
        roleName: "Reviewer",
        content: `Contribution ${index + 1}`,
        kind: "inference",
        evidenceCount: 0,
        createdAt
      }));
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{utterances}', $1::jsonb, true) WHERE singleton_id = 1",
        [JSON.stringify(utterances)]
      );

      await expect(backfillMeetingUtterances(pool, 2)).resolves.toEqual({
        sourceCount: 5,
        processedCount: 2,
        insertedCount: 2,
        complete: false
      });
      const firstBatch = await pool.query<{ utterance_id: string }>(
        "SELECT utterance_id FROM meeting_utterances ORDER BY sequence_no"
      );
      expect(firstBatch.rows.map((row) => row.utterance_id)).toEqual(utterances.slice(0, 2).map((item) => item.id));

      const lateUtterance = {
        ...utterances[0],
        id: "a2000000-0000-4000-8000-000000000099",
        turnId: "turn-late",
        content: "Appended after the source count was fixed."
      };
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(state, '{utterances}', (state->'utterances') || $1::jsonb, true)
        WHERE singleton_id = 1
      `, [JSON.stringify([lateUtterance])]);

      await expect(backfillMeetingUtterances(pool, 2)).resolves.toMatchObject({
        sourceCount: 5,
        processedCount: 4,
        insertedCount: 2,
        complete: false
      });
      await expect(backfillMeetingUtterances(pool, 2)).resolves.toMatchObject({
        sourceCount: 5,
        processedCount: 5,
        insertedCount: 1,
        complete: true
      });
      await expect(backfillMeetingUtterances(pool, 2)).resolves.toEqual({
        sourceCount: 5,
        processedCount: 5,
        insertedCount: 0,
        complete: true
      });

      const rows = await pool.query<{ utterance_id: string; sequence_no: number; snapshot: { id: string } }>(`
        SELECT utterance_id, sequence_no::integer, snapshot
        FROM meeting_utterances
        ORDER BY sequence_no
      `);
      expect(rows.rows.map((row) => row.utterance_id)).toEqual(utterances.map((item) => item.id));
      expect(rows.rows.map((row) => row.sequence_no)).toEqual([1, 2, 3, 4, 5]);
      expect(rows.rows.map((row) => row.snapshot.id)).toEqual(utterances.map((item) => item.id));
      expect(rows.rows.some((row) => row.utterance_id === lateUtterance.id)).toBe(false);

      const progress = await pool.query<{ source_count: string; processed_count: string; completed: boolean }>(`
        SELECT source_count::text, processed_count::text, completed_at IS NOT NULL AS completed
        FROM utterance_projection_backfill_progress
        WHERE singleton_id = 1
      `);
      expect(progress.rows[0]).toEqual({ source_count: "5", processed_count: "5", completed: true });
    });
  });

  it("tolerates an Utterance inserted while its source batch is in flight", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const meetingId = "83000000-0000-4000-8000-000000000001";
      const utterances = [1, 2].map((position) => ({
        id: `a3000000-0000-4000-8000-${String(position).padStart(12, "0")}`,
        meetingId,
        turnId: `concurrent-turn-${position}`,
        speakerType: "agent",
        speakerName: `Agent ${position}`,
        roleName: "Reviewer",
        content: `Concurrent contribution ${position}`,
        kind: "inference",
        evidenceCount: 0,
        createdAt: "2026-08-07T02:00:00.000Z"
      }));
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{utterances}', $1::jsonb, true) WHERE singleton_id = 1",
        [JSON.stringify(utterances)]
      );

      const liveClient = await pool.connect();
      let committed = false;
      try {
        await liveClient.query("BEGIN");
        await liveClient.query(`
          INSERT INTO meeting_utterances(utterance_id, turn_id, meeting_id, created_at, snapshot)
          VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
        `, [utterances[0]!.id, utterances[0]!.turnId, meetingId, utterances[0]!.createdAt, JSON.stringify(utterances[0])]);

        const backfill = backfillMeetingUtterances(pool, 2);
        await new Promise((resolve) => setTimeout(resolve, 25));
        await liveClient.query("COMMIT");
        committed = true;

        await expect(backfill).resolves.toEqual({
          sourceCount: 2,
          processedCount: 2,
          insertedCount: 1,
          complete: true
        });
      } finally {
        if (!committed) await liveClient.query("ROLLBACK");
        liveClient.release();
      }

      const rows = await pool.query<{ utterance_id: string }>(
        "SELECT utterance_id FROM meeting_utterances ORDER BY snapshot->>'id'"
      );
      expect(rows.rows.map((row) => row.utterance_id)).toEqual(utterances.map((item) => item.id));
      await expect(backfillMeetingUtterances(pool, 2)).resolves.toMatchObject({
        insertedCount: 0,
        complete: true
      });
    });
  });

  it("rebuilds the legacy Utterance array from the completed projection for rollback", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const meetingId = "84000000-0000-4000-8000-000000000001";
      const sourceUtterance = {
        id: "a4000000-0000-4000-8000-000000000001",
        meetingId,
        turnId: "source-turn",
        speakerType: "agent",
        speakerName: "Architect",
        roleName: "Reviewer",
        content: "Source contribution",
        kind: "inference",
        evidenceCount: 0,
        createdAt: "2026-08-07T03:00:00.000Z"
      };
      const projectedUtterance = {
        ...sourceUtterance,
        id: "a4000000-0000-4000-8000-000000000002",
        turnId: "projected-turn",
        content: "Contribution written after projection cutover",
        createdAt: "2026-08-07T03:01:00.000Z"
      };
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{utterances}', $1::jsonb, true) WHERE singleton_id = 1",
        [JSON.stringify([sourceUtterance])]
      );
      await expect(backfillMeetingUtterances(pool, 10)).resolves.toMatchObject({ complete: true });
      await cutoverMeetingUtteranceProjection(pool);
      await pool.query(`
        INSERT INTO meeting_utterances(utterance_id, turn_id, meeting_id, created_at, snapshot)
        VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
      `, [
        projectedUtterance.id,
        projectedUtterance.turnId,
        meetingId,
        projectedUtterance.createdAt,
        JSON.stringify(projectedUtterance)
      ]);

      const before = await pool.query<{ revision: string }>(
        "SELECT revision::text FROM platform_state WHERE singleton_id = 1"
      );
      await expect(synchronizeMeetingUtterancesToPlatformState(pool)).resolves.toEqual({
        utteranceCount: 2,
        platformRevision: Number(before.rows[0]!.revision) + 1
      });

      const restored = await pool.query<{ utterances: Array<{ id: string }> }>(`
        SELECT state->'utterances' AS utterances
        FROM platform_state
        WHERE singleton_id = 1
      `);
      expect(restored.rows[0]!.utterances.map((item) => item.id)).toEqual([
        sourceUtterance.id,
        projectedUtterance.id
      ]);
    });
  });

  it("reconciles rollback-era legacy writes before compacting the JSONB source", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const meetingId = "86000000-0000-4000-8000-000000000001";
      const first = {
        id: "a6000000-0000-4000-8000-000000000001",
        meetingId,
        turnId: "first",
        speakerType: "human",
        speakerName: "Owner",
        roleName: "Owner",
        content: "Before first cutover",
        kind: "human",
        evidenceCount: 0,
        createdAt: "2026-08-07T05:00:00.000Z"
      };
      const rollbackEra = {
        ...first,
        id: "a6000000-0000-4000-8000-000000000002",
        turnId: "rollback-era",
        content: "Written by a legacy release after rollback",
        createdAt: "2026-08-07T05:01:00.000Z"
      };
      await pool.query(
        "UPDATE platform_state SET state = jsonb_set(state, '{utterances}', $1::jsonb, true) WHERE singleton_id = 1",
        [JSON.stringify([first])]
      );
      await expect(backfillMeetingUtterances(pool, 10)).resolves.toMatchObject({ complete: true });
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(state, '{utterances}', $1::jsonb, true)
        WHERE singleton_id = 1
      `, [JSON.stringify([first, rollbackEra])]);

      await expect(cutoverMeetingUtteranceProjection(pool)).resolves.toMatchObject({
        legacyCount: 2,
        reconciledCount: 1,
        utteranceCount: 2
      });

      const state = await pool.query<{ utterances: unknown[] }>(`
        SELECT state->'utterances' AS utterances FROM platform_state WHERE singleton_id = 1
      `);
      const rows = await pool.query<{ utterance_id: string }>(
        "SELECT utterance_id FROM meeting_utterances ORDER BY created_at, sequence_no"
      );
      const progress = await pool.query<{ cutover: boolean }>(`
        SELECT cutover_at IS NOT NULL AS cutover
        FROM utterance_projection_backfill_progress
        WHERE singleton_id = 1
      `);
      expect(state.rows[0]!.utterances).toEqual([]);
      expect(rows.rows.map((row) => row.utterance_id)).toEqual([first.id, rollbackEra.id]);
      expect(progress.rows[0]!.cutover).toBe(true);
    });
  });
});

integration("Goal Run autonomy persistence against PostgreSQL", integrationOptions, () => {
  it("rejects a mismatched Meeting and Topic without leaving Goal creation records", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const store = new PostgresPlatformStore(pool);
      const owner = await store.createOwner("invalid-goal-binding@example.test", "test-only-hash");
      const meeting = (await store.getSnapshot()).meetings[0]!;
      const now = new Date().toISOString();
      const goalRunId = randomUUID();
      const idempotencyKey = `invalid-goal-binding-${goalRunId}`;
      const run: GoalRun = {
        id: goalRunId,
        title: "Reject cross-Topic Goal",
        goal: "Keep the canonical Meeting and Topic relationship valid.",
        threadId: randomUUID(),
        meetingId: meeting.id,
        state: "planning",
        revision: 1,
        activePlanRevision: 0,
        executionContractId: null,
        limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
        usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
        deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        pausedFromState: null,
        terminalReason: null,
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now
      };
      const admission = {
        jobId: `goal-orchestrate-${goalRunId}`,
        goalRunId,
        jobName: "goal-orchestrate" as const,
        entityId: goalRunId,
        requestFingerprint: "e".repeat(64),
        state: "reserved" as const,
        reservedAt: now,
        admittedAt: null,
        startedAt: null,
        settledAt: null,
        updatedAt: now
      };

      await expect(store.createGoalRun(run, {
        type: "goal.created", actorType: "owner", actorId: owner.id, entityType: "goal", entityId: goalRunId, summary: "Invalid Goal Run created."
      }, idempotencyKey, admission)).rejects.toThrow(/meeting and Topic binding is invalid/i);

      const residue = await pool.query<{ goals: number; events: number; admissions: number; idempotency: number }>(`
        SELECT
          (SELECT count(*)::int FROM goal_runs WHERE id = $1) AS goals,
          (SELECT count(*)::int FROM goal_events WHERE goal_run_id = $1) AS events,
          (SELECT count(*)::int FROM goal_job_admissions WHERE goal_run_id = $1) AS admissions,
          (SELECT count(*)::int FROM idempotency_records WHERE operation = 'goal_run.create' AND idempotency_key = $2) AS idempotency
      `, [goalRunId, idempotencyKey]);
      expect(residue.rows[0]).toEqual({ goals: 0, events: 0, admissions: 0, idempotency: 0 });
    });
  });

  it("atomically terminalizes nonterminal task bindings when an Owner cancels a Goal", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const store = new PostgresPlatformStore(pool);
      const owner = await store.createOwner("goal-cancellation@example.test", "test-only-hash");
      const snapshot = await store.getSnapshot();
      const meeting = snapshot.meetings[0]!;
      const now = new Date().toISOString();
      const goalRunId = randomUUID();
      const planTask: GoalPlanTask = {
        id: randomUUID(),
        decisionId: randomUUID(),
        title: "Review the cancelled Goal",
        description: "",
        acceptanceCriteria: "Cancellation leaves no active task binding.",
        dependencyIds: [],
        assigneeAgentId: null,
        executionMode: "manual",
        allowedTools: [],
        dataScope: "meeting",
        action: null
      };
      const run: GoalRun = {
        id: goalRunId,
        title: "Owner cancellation",
        goal: "Cancel a paused Goal without leaving review work active.",
        threadId: meeting.threadId,
        meetingId: meeting.id,
        state: "paused",
        revision: 1,
        activePlanRevision: 1,
        executionContractId: null,
        limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
        usage: { discussionRounds: 3, taskAttempts: 1, replans: 0, modelCalls: 4, actionCalls: 0 },
        deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        pausedFromState: "reviewing",
        terminalReason: "review_interrupted",
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now
      };
      await store.createGoalRun(run, {
        type: "goal.created",
        actorType: "owner",
        actorId: owner.id,
        entityType: "goal",
        entityId: goalRunId,
        summary: "Paused Goal Run fixture created."
      }, `goal-cancellation-${goalRunId}`);
      await pool.query(`
        INSERT INTO goal_plan_revisions(id, goal_run_id, revision, status, digest, tasks, created_at)
        VALUES ($1, $2, 1, 'approved', $3, $4::jsonb, $5)
      `, [randomUUID(), goalRunId, goalPlanDigest([planTask]), JSON.stringify([planTask]), now]);
      const bindingId = randomUUID();
      await pool.query(`
        INSERT INTO goal_task_bindings(
          id, goal_run_id, plan_revision, plan_task_id, task_id, state,
          attempt_count, active_job_id, last_error, created_at, updated_at
        ) VALUES ($1, $2, 1, $3, NULL, 'reviewing', 1, $4, NULL, $5, $5)
      `, [bindingId, goalRunId, planTask.id, `goal-review-${bindingId}`, now]);
      const adapterId = randomUUID();
      await pool.query(`
        INSERT INTO action_adapters(
          id, name, kind, enabled, base_url, credential_id, catalog_revision, actions, created_at, updated_at
        ) VALUES ($1, $2, 'harness_pipeline', false, 'https://harness.example.test/', NULL, 1, $3::jsonb, $4, $4)
      `, [adapterId, `Cancellation adapter ${adapterId}`, JSON.stringify([{
        key: "preview",
        displayName: "Preview",
        targetIds: ["test-target"],
        inputKeys: [],
        riskClass: "ordinary",
        supportsPreview: true,
        supportsVerification: true,
        supportsCancellation: true,
        supportsCompensation: false
      }]), now]);
      const actionRunId = randomUUID();
      await pool.query(`
        INSERT INTO action_runs(
          id, goal_run_id, plan_task_id, adapter_id, adapter_catalog_revision,
          action_key, target_id, inputs, state, request_fingerprint, contract_digest,
          external_execution_id, verification_summary, last_error, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 1, 'preview', 'test-target', '{}'::jsonb, 'running', $5, $6, NULL, NULL, NULL, $7, $7)
      `, [actionRunId, goalRunId, planTask.id, adapterId, "a".repeat(64), "b".repeat(64), now]);

      const cancellationInput = {
        expectedRevision: 1,
        state: "cancelled" as const,
        pausedFromState: null,
        terminalReason: "cancelled_by_owner",
        event: {
          type: "goal.state.changed" as const,
          actorType: "owner" as const,
          actorId: owner.id,
          entityType: "goal" as const,
          entityId: goalRunId,
          summary: "Goal Run cancelled by Owner."
        }
      };
      await expect(store.setGoalRunState(goalRunId, cancellationInput)).rejects.toMatchObject({
        apiCode: "GOAL_ACTION_RECONCILIATION_REQUIRED"
      });
      expect(await store.getGoalRun(goalRunId)).toMatchObject({ state: "paused", revision: 1 });
      const beforeReconciliation = await pool.query<{ state: string; activeJobId: string | null }>(`
        SELECT state, active_job_id AS "activeJobId"
        FROM goal_task_bindings
        WHERE id = $1
      `, [bindingId]);
      expect(beforeReconciliation.rows[0]).toEqual({
        state: "reviewing",
        activeJobId: `goal-review-${bindingId}`
      });
      await pool.query("UPDATE action_runs SET state = 'approved' WHERE id = $1", [actionRunId]);

      await store.setGoalRunState(goalRunId, cancellationInput);

      const binding = await pool.query<{ state: string; activeJobId: string | null }>(`
        SELECT state, active_job_id AS "activeJobId"
        FROM goal_task_bindings
        WHERE id = $1
      `, [bindingId]);
      expect(binding.rows[0]).toEqual({ state: "cancelled", activeJobId: null });
      const actionRun = await pool.query<{ state: string }>("SELECT state FROM action_runs WHERE id = $1", [actionRunId]);
      expect(actionRun.rows[0]).toEqual({ state: "cancelled" });
      expect(await store.getGoalRun(goalRunId)).toMatchObject({
        state: "cancelled",
        pausedFromState: null,
        terminalReason: "cancelled_by_owner",
        revision: 2
      });
      const events = await store.getGoalEvents(goalRunId);
      expect(events.map((event) => event.type)).toEqual([
        "goal.created",
        "task.state.changed",
        "action.state.changed",
        "goal.state.changed"
      ]);
      expect(events[1]?.detail).toMatchObject({
        bindingId,
        fromState: "reviewing",
        toState: "cancelled",
        reason: "goal_cancelled"
      });
      expect(events[2]?.detail).toMatchObject({
        actionRunId,
        fromState: "approved",
        toState: "cancelled",
        reason: "goal_cancelled"
      });
    });
  });

  it("persists an approved immutable plan, action run, durable events, and job admission", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const store = new PostgresPlatformStore(pool);
      const owner = await store.createOwner("goal-owner@example.test", "test-only-hash");
      const snapshot = await store.getSnapshot();
      const thread = snapshot.threads[0]!;
      const meeting = snapshot.meetings.find((candidate) => candidate.threadId === thread.id) ?? snapshot.meetings[0]!;
      const now = new Date().toISOString();
      const goalRunId = randomUUID();
      const run: GoalRun = {
        id: goalRunId,
        title: "Verify the Goal Run persistence boundary",
        goal: "Hold a formal meeting, approve one immutable task, and retain all execution evidence.",
        threadId: thread.id,
        meetingId: meeting.id,
        state: "planning",
        revision: 1,
        activePlanRevision: 0,
        executionContractId: null,
        limits: {
          discussionRounds: 3,
          maxTasks: 12,
          maxConcurrentTasks: 2,
          maxAttemptsPerTask: 3,
          maxReplans: 2,
          maxDurationMinutes: 120,
          maxModelCalls: 60,
          maxActionCalls: 30
        },
        usage: { discussionRounds: 0, taskAttempts: 0, replans: 0, modelCalls: 0, actionCalls: 0 },
        deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        pausedFromState: null,
        terminalReason: null,
        createdBy: owner.id,
        createdAt: now,
        updatedAt: now
      };
      const creationJobId = `goal-orchestrate-${goalRunId}`;
      const creationAdmission = {
        jobId: creationJobId,
        goalRunId,
        jobName: "goal-orchestrate" as const,
        entityId: goalRunId,
        requestFingerprint: "c".repeat(64),
        state: "reserved" as const,
        reservedAt: now,
        admittedAt: null,
        startedAt: null,
        settledAt: null,
        updatedAt: now
      };
      await store.createGoalRun(run, {
        type: "goal.created",
        actorType: "owner",
        actorId: owner.id,
        entityType: "goal",
        entityId: goalRunId,
        summary: "Goal Run created"
      }, "goal-run-postgres-create", creationAdmission);
      await expect(store.getRecoverableGoalJobs()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId: creationJobId, goalRunId, state: "reserved" })
      ]));
      await expect(store.getGoalJobAdmission(creationJobId)).resolves.toMatchObject({
        dispatchToken: null,
        dispatchLeaseExpiresAt: null
      });
      await expect(store.reserveGoalJob({
        ...creationAdmission,
        jobName: "goal-review",
        entityId: `goal:${goalRunId}:reviewer`
      })).rejects.toThrow(/another request/);
      const reviewerAgentId = randomUUID();
      const reviewData: GoalReviewJobData = {
        goalRunId,
        scope: "goal",
        scopeId: goalRunId,
        reviewerAgentId,
        reviewerAgentRevision: 1,
        reviewerParticipantId: randomUUID(),
        reviewerRoleId: randomUUID(),
        reviewerRoleRevision: 1,
        reviewerRoleSnapshotDigest: "b".repeat(64),
        modelConnectorId: randomUUID(),
        modelConnectorBinding: {
          id: randomUUID(), revision: 1, location: "cloud",
          baseUrl: `https://review.example.test/${"a".repeat(1_900)}`,
          model: "m".repeat(500), credentialId: randomUUID(), secretRevision: 7
        },
        credentialBinding: { credentialId: randomUUID(), secretRevision: 7, provider: "review-provider", location: "cloud" },
        contractDigest: "a".repeat(64),
        requestedBy: "system"
      };
      reviewData.modelConnectorId = reviewData.modelConnectorBinding.id;
      reviewData.credentialBinding!.credentialId = reviewData.modelConnectorBinding.credentialId!;
      const reviewAdmission = {
        jobId: `goal-review-${goalRunId}`,
        goalRunId,
        jobName: "goal-review" as const,
        entityId: `goal:${goalRunId}:${reviewerAgentId}`,
        requestFingerprint: goalReviewRequestFingerprint(reviewData),
        state: "reserved" as const,
        reservedAt: now,
        admittedAt: null,
        startedAt: null,
        settledAt: null,
        updatedAt: now
      };
      expect(reviewAdmission.requestFingerprint).toHaveLength(67);
      await expect(store.reserveGoalReviewJob(reviewAdmission, reviewData)).resolves.toMatchObject(reviewAdmission);
      await expect(store.reserveGoalReviewJob(reviewAdmission, reviewData)).resolves.toMatchObject(reviewAdmission);
      await expect(store.getGoalReviewJobData(reviewAdmission.jobId)).resolves.toEqual(reviewData);
      await store.setGoalJobState(reviewAdmission.jobId, "reserved", "admitted");
      await store.setGoalJobState(reviewAdmission.jobId, "admitted", "running");
      const reviewVerdictId = randomUUID();
      await expect(store.addReviewerVerdict({
        id: reviewVerdictId,
        goalRunId,
        scope: reviewData.scope,
        scopeId: reviewData.scopeId,
        reviewerAgentId,
        reviewerAgentRevision: reviewData.reviewerAgentRevision,
        modelConnectorId: reviewData.modelConnectorId,
        verdict: "pass",
        summary: "The exact durable Reviewer job binding was verified.",
        evidenceIds: [],
        contractDigest: reviewData.contractDigest,
        reviewJobId: reviewAdmission.jobId,
        reviewRequestFingerprint: reviewAdmission.requestFingerprint,
        createdAt: now
      }, {
        type: "review.recorded",
        actorType: "agent",
        actorId: reviewerAgentId,
        entityType: "review",
        entityId: reviewVerdictId,
        summary: "Exact Reviewer job verdict recorded."
      })).resolves.toMatchObject({
        reviewJobId: reviewAdmission.jobId,
        reviewRequestFingerprint: reviewAdmission.requestFingerprint
      });
      await expect(store.addReviewerVerdict({
        id: randomUUID(),
        goalRunId,
        scope: reviewData.scope,
        scopeId: reviewData.scopeId,
        reviewerAgentId,
        reviewerAgentRevision: reviewData.reviewerAgentRevision,
        modelConnectorId: reviewData.modelConnectorId,
        verdict: "pass",
        summary: "This verdict carries a mismatched immutable request fingerprint.",
        evidenceIds: [],
        contractDigest: reviewData.contractDigest,
        reviewJobId: reviewAdmission.jobId,
        reviewRequestFingerprint: `v2:${"d".repeat(64)}`,
        createdAt: now
      }, {
        type: "review.recorded",
        actorType: "agent",
        actorId: reviewerAgentId,
        entityType: "review",
        entityId: randomUUID(),
        summary: "Mismatched Reviewer verdict rejected."
      })).rejects.toThrow(/does not match its durable Goal Review admission/i);
      await store.setGoalJobState(reviewAdmission.jobId, "running", "outcome_unknown");
      await expect(store.getRecoverableGoalJobs()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId: reviewAdmission.jobId, jobName: "goal-review", state: "outcome_unknown" })
      ]));
      await pool.query(
        "UPDATE goal_review_job_bindings SET request_fingerprint = $2 WHERE job_id = $1",
        [reviewAdmission.jobId, `v2:${"b".repeat(64)}`]
      );
      await expect(store.getGoalReviewJobData(reviewAdmission.jobId)).rejects.toThrow(/binding is invalid|immutable binding/i);
      const firstClaimAt = new Date(Date.parse(now) + 1_000).toISOString();
      const firstLeaseExpiresAt = new Date(Date.parse(firstClaimAt) + 30_000).toISOString();
      const firstClaim = await store.claimGoalJobDispatch(creationJobId, {
        dispatchToken: "postgres-dispatcher-a",
        leaseDurationMs: 30_000,
        now: firstClaimAt
      });
      expect(firstClaim).toEqual({
        status: "claimed",
        admission: expect.objectContaining({
          state: "dispatching",
          dispatchToken: "postgres-dispatcher-a",
          dispatchLeaseExpiresAt: firstLeaseExpiresAt,
          updatedAt: firstClaimAt
        })
      });
      await expect(store.claimGoalJobDispatch(creationJobId, {
        dispatchToken: "postgres-dispatcher-a",
        now: new Date(Date.parse(firstClaimAt) + 10_000).toISOString()
      })).resolves.toEqual(firstClaim);
      await expect(store.claimGoalJobDispatch(creationJobId, {
        dispatchToken: "postgres-dispatcher-b",
        now: new Date(Date.parse(firstLeaseExpiresAt) - 1).toISOString()
      })).resolves.toEqual({ status: "contended", admission: firstClaim.admission });
      await expect(store.getRecoverableGoalJobs()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ jobId: creationJobId, state: "dispatching" })
      ]));
      const reclaimed = await store.claimGoalJobDispatch(creationJobId, {
        dispatchToken: "postgres-dispatcher-b",
        leaseDurationMs: 1_000,
        now: firstLeaseExpiresAt
      });
      expect(reclaimed).toEqual({
        status: "claimed",
        admission: expect.objectContaining({
          state: "dispatching",
          dispatchToken: "postgres-dispatcher-b",
          dispatchLeaseExpiresAt: new Date(Date.parse(firstLeaseExpiresAt) + 1_000).toISOString()
        })
      });
      await expect(pool.query(`
        UPDATE goal_job_admissions
        SET state = 'admitted'
        WHERE job_id = $1
      `, [creationJobId])).rejects.toThrow(/goal_job_admissions_dispatch_lease_shape/i);
      await expect(store.setGoalJobState(creationJobId, "dispatching", "admitted"))
        .rejects.toThrow(/dispatch lease/i);
      await expect(store.completeGoalJobDispatch(creationJobId, "postgres-dispatcher-a"))
        .rejects.toThrow(/dispatch token/i);
      const completedDispatch = await store.completeGoalJobDispatch(creationJobId, "postgres-dispatcher-b");
      expect(completedDispatch).toMatchObject({
        state: "admitted",
        admittedAt: expect.any(String),
        dispatchToken: null,
        dispatchLeaseExpiresAt: null
      });
      await expect(store.completeGoalJobDispatch(creationJobId, "postgres-dispatcher-b"))
        .resolves.toEqual(completedDispatch);
      await expect(store.claimGoalJobDispatch(creationJobId, { dispatchToken: "postgres-dispatcher-c" }))
        .resolves.toEqual({ status: "already_dispatched", admission: completedDispatch });
      await store.setGoalJobState(creationJobId, "admitted", "settled");

      const decision = await store.createDecision({
        meetingId: meeting.id,
        title: "Execute a catalog-bound Harness action",
        description: "Use only the approved action and target."
      });

      const task: GoalPlanTask = {
        id: randomUUID(),
        decisionId: decision.id,
        title: "Execute a catalog-bound Harness action",
        description: "Use only the approved action and target.",
        acceptanceCriteria: "The execution is verified and recorded.",
        dependencyIds: [],
        assigneeAgentId: null,
        executionMode: "action",
        allowedTools: [],
        dataScope: "Execution Contract fields only",
        action: {
          adapterId: randomUUID(),
          actionKey: "preview-release",
          targetId: "staging",
          inputs: { release: "20260827T073000Z" },
          riskClass: "ordinary"
        }
      };
      const plannerParticipant = snapshot.participants.find((participant) => (
        participant.meetingId === meeting.id && participant.roleSnapshot.orchestrationFunctions.includes("planner")
      ))!;
      const plannerHistory = plannerParticipant.roleHistory.find((entry) => entry.revision === plannerParticipant.roleRevision)!;
      const plannerProvenance = {
        plannerParticipantId: plannerParticipant.id,
        plannerAgentId: plannerParticipant.agentId,
        plannerAgentRevision: plannerParticipant.agentRevision!,
        plannerModelConnectorId: randomUUID(),
        plannerRoleId: plannerHistory.roleId,
        plannerRoleRevision: plannerHistory.revision,
        plannerRoleSnapshotDigest: roleExecutionSnapshotDigest(plannerHistory.roleSnapshot)
      };
      const plan: GoalPlanRevision = {
        id: randomUUID(),
        goalRunId,
        revision: 1,
        status: "draft",
        digest: goalPlanDigest([task]),
        tasks: [task],
        plannerProvenance,
        createdAt: now
      };
      const planned = await store.saveGoalPlan(goalRunId, {
        expectedRevision: 1,
        expectedPlanRevision: 0,
        plan,
        event: {
          type: "plan.created",
          actorType: "agent",
          actorId: plannerParticipant.agentId,
          entityType: "plan",
          entityId: plan.id,
          summary: "Goal Plan created",
          detail: { revision: 1, ...plannerProvenance }
        }
      });
      expect(planned.goalRun).toMatchObject({ state: "awaiting_approval", revision: 2, activePlanRevision: 1 });

      const contract = createExecutionContract({
        goalRunId,
        planRevision: 1,
        tasks: [task],
        limits: run.limits,
        approvedBy: owner.id,
        approvedAt: now,
        actionBindings: [{
          planTaskId: task.id,
          adapterId: task.action!.adapterId,
          adapterCatalogRevision: 1,
          endpointDigest: actionAdapterEndpointDigest("https://harness.example.test/"),
          credentialId: null,
          credentialSecretRevision: null
        }]
      });
      const binding: GoalTaskBinding = {
        id: randomUUID(),
        goalRunId,
        planRevision: 1,
        planTaskId: task.id,
        taskId: null,
        state: "ready",
        attemptCount: 0,
        activeJobId: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      };
      const approvalJobId = `goal-orchestrate-${goalRunId}-approval`;
      const orchestrationAdmission = {
        jobId: approvalJobId,
        goalRunId,
        jobName: "goal-orchestrate" as const,
        entityId: goalRunId,
        requestFingerprint: "a".repeat(64),
        state: "reserved" as const,
        reservedAt: now,
        admittedAt: null,
        startedAt: null,
        settledAt: null,
        updatedAt: now
      };
      const approved = await store.approveGoalRun(goalRunId, {
        expectedRevision: 2,
        contract,
        bindings: [binding],
        orchestrationAdmission,
        event: {
          type: "contract.approved",
          actorType: "owner",
          actorId: owner.id,
          entityType: "plan",
          entityId: contract.id,
          summary: "Execution Contract approved"
        }
      });
      expect(approved.goalRun).toMatchObject({ state: "executing", revision: 3, executionContractId: contract.id });
      expect(approved.executionContract).toMatchObject({
        contractDigest: contract.contractDigest,
        actionBindings: contract.actionBindings
      });
      await expect(store.getGoalJobAdmission(approvalJobId)).resolves.toMatchObject({
        goalRunId,
        entityId: goalRunId,
        state: "reserved"
      });
      const dispatchingAdmissionJobId = `${approvalJobId}-dispatching`;
      const admittedAdmissionJobId = `${approvalJobId}-admitted`;
      const runningAdmissionJobId = `${approvalJobId}-running`;
      const terminalAdmissionJobId = `${approvalJobId}-settled`;
      const unrelatedAdmissionJobId = `${approvalJobId}-plan`;
      const dispatchLeaseExpiresAt = new Date(Date.parse(now) + 30_000).toISOString();
      await pool.query(`
        INSERT INTO goal_job_admissions(
          job_id, goal_run_id, job_name, entity_id, request_fingerprint, state,
          dispatch_token, dispatch_lease_expires_at,
          reserved_at, admitted_at, started_at, settled_at, updated_at
        ) VALUES
          ($1, $2, 'goal-orchestrate', $3, $4, 'dispatching', 'legacy-dispatch', $5, $6, NULL, NULL, NULL, $6),
          ($7, $2, 'goal-orchestrate', $3, $8, 'admitted', NULL, NULL, $6, $6, NULL, NULL, $6),
          ($9, $2, 'goal-orchestrate', $3, $10, 'running', NULL, NULL, $6, $6, $6, NULL, $6),
          ($11, $2, 'goal-orchestrate', $3, $12, 'settled', NULL, NULL, $6, $6, $6, $6, $6),
          ($13, $2, 'goal-plan', $3, $14, 'reserved', NULL, NULL, $6, NULL, NULL, NULL, $6)
      `, [
        dispatchingAdmissionJobId,
        goalRunId,
        contract.id,
        "b".repeat(64),
        dispatchLeaseExpiresAt,
        now,
        admittedAdmissionJobId,
        "c".repeat(64),
        runningAdmissionJobId,
        "d".repeat(64),
        terminalAdmissionJobId,
        "e".repeat(64),
        unrelatedAdmissionJobId,
        "f".repeat(64)
      ]);
      await pool.query("UPDATE goal_job_admissions SET entity_id = $2 WHERE job_id = $1", [approvalJobId, contract.id]);
      await pool.query("UPDATE goal_runs SET execution_contract_id = NULL WHERE id = $1", [goalRunId]);
      await pool.query("DELETE FROM schema_migrations WHERE version = '037_goal_orchestration_admission_goal_run_identity'");

      await migrateDatabase(pool);
      await expect(pool.query(`
        SELECT job_id, entity_id AS "entityId", state
        FROM goal_job_admissions
        WHERE job_id = ANY($1::text[])
        ORDER BY job_id
      `, [[
        approvalJobId,
        dispatchingAdmissionJobId,
        admittedAdmissionJobId,
        runningAdmissionJobId,
        terminalAdmissionJobId,
        unrelatedAdmissionJobId
      ]])).resolves.toMatchObject({
        rows: expect.arrayContaining([
          { job_id: approvalJobId, entityId: goalRunId, state: "reserved" },
          { job_id: dispatchingAdmissionJobId, entityId: goalRunId, state: "dispatching" },
          { job_id: admittedAdmissionJobId, entityId: goalRunId, state: "admitted" },
          { job_id: runningAdmissionJobId, entityId: goalRunId, state: "running" },
          { job_id: terminalAdmissionJobId, entityId: contract.id, state: "settled" },
          { job_id: unrelatedAdmissionJobId, entityId: contract.id, state: "reserved" }
        ])
      });
      await expect(pool.query("SELECT 1 FROM schema_migrations WHERE version = '037_goal_orchestration_admission_goal_run_identity'"))
        .resolves.toMatchObject({ rowCount: 1 });
      await pool.query("UPDATE goal_runs SET execution_contract_id = $2 WHERE id = $1", [goalRunId, contract.id]);
      expect(approved.taskBindings).toHaveLength(1);
      expect(approved.taskBindings[0]?.taskId).not.toBeNull();

      const approvedSnapshot = await store.getSnapshot();
      expect(approvedSnapshot.decisions.find((candidate) => candidate.id === decision.id)?.status).toBe("approved");
      const canonicalTask = approvedSnapshot.tasks.find((candidate) => candidate.id === approved.taskBindings[0]?.taskId);
      expect(canonicalTask).toMatchObject({
        decisionId: decision.id,
        meetingId: meeting.id,
        title: task.title,
        executionProfile: "manual",
        approvalState: "not_required"
      });
      const reloaded = await new PostgresPlatformStore(pool).getGoalRunDetail(goalRunId);
      expect(reloaded?.taskBindings).toEqual(approved.taskBindings);
      expect(reloaded?.executionContract?.actionBindings).toEqual(contract.actionBindings);
      expect(reloaded?.plans[0]?.plannerProvenance).toEqual(plannerProvenance);

      const adapter: ActionAdapter = {
        id: task.action!.adapterId,
        name: "Harness staging release",
        kind: "harness_pipeline",
        enabled: true,
        baseUrl: "https://harness.example.test/",
        credentialId: null,
        catalogRevision: 1,
        actions: [{
          key: task.action!.actionKey,
          displayName: "Preview release",
          targetIds: [task.action!.targetId],
          inputKeys: ["release"],
          riskClass: "ordinary",
          timeoutMs: 60_000,
          supportsCancellation: true,
          supportsCompensation: true
        }],
        createdAt: now,
        updatedAt: now
      };
      await store.createActionAdapter(adapter);
      const actionRun: ActionRun = {
        id: randomUUID(),
        goalRunId,
        planTaskId: task.id,
        adapterId: adapter.id,
        adapterCatalogRevision: adapter.catalogRevision,
        actionKey: task.action!.actionKey,
        targetId: task.action!.targetId,
        inputs: task.action!.inputs,
        state: "approved",
        requestFingerprint: requestFingerprint({
          goalRunId,
          planTaskId: task.id,
          contractDigest: contract.contractDigest,
          adapterCatalogRevision: adapter.catalogRevision,
          action: task.action
        }),
        contractDigest: contract.contractDigest,
        externalExecutionId: null,
        verificationSummary: null,
        lastError: null,
        createdAt: now,
        updatedAt: now
      };
      const actionJobId = `goal-action:${actionRun.id}`;
      const admission = {
        jobId: actionJobId,
        goalRunId,
        jobName: "goal-action-run" as const,
        entityId: actionRun.id,
        requestFingerprint: [goalRunId, task.id, actionRun.id, contract.contractDigest].join(":"),
        state: "reserved" as const,
        reservedAt: now,
        admittedAt: null,
        startedAt: null,
        settledAt: null,
        updatedAt: now
      };
      const dispatchClaim = {
        goalRunId,
        bindingId: approved.taskBindings[0]!.id,
        planRevision: plan.revision,
        planTaskId: task.id,
        taskId: approved.taskBindings[0]!.taskId,
        expectedAttemptCount: 0,
        jobId: actionJobId,
        contractDigest: contract.contractDigest,
        usageIncrements: { taskAttempts: 0, modelCalls: 0, actionCalls: 1 },
        budgetEvent: {
          type: "goal.state.changed" as const,
          actorType: "system" as const,
          actorId: null,
          entityType: "goal" as const,
          entityId: goalRunId,
          summary: "Action budget claimed"
        },
        bindingEvent: {
          type: "task.state.changed" as const,
          actorType: "system" as const,
          actorId: null,
          entityType: "task" as const,
          entityId: task.id,
          summary: "Action task claimed"
        },
        action: {
          actionRun,
          actionEvent: {
            type: "action.state.changed" as const,
            actorType: "system" as const,
            actorId: null,
            entityType: "action" as const,
            entityId: actionRun.id,
            summary: "Action Run approved"
          },
          jobAdmission: admission
        },
        now
      };
      const claims = await Promise.all([
        store.claimGoalTaskDispatch(dispatchClaim),
        new PostgresPlatformStore(pool).claimGoalTaskDispatch(dispatchClaim)
      ]);
      expect(claims.map((claim) => claim.status).sort()).toEqual(["claimed", "contended"]);
      expect((await store.getGoalRun(goalRunId))?.usage).toMatchObject({ actionCalls: 1 });
      expect((await store.getGoalRunDetail(goalRunId))?.taskBindings[0]).toMatchObject({
        state: "running",
        activeJobId: actionJobId,
        attemptCount: 1
      });
      expect((await store.getGoalRunDetail(goalRunId))?.actionRuns).toEqual([
        expect.objectContaining({ id: actionRun.id, state: "approved" })
      ]);
      expect((await store.getRecoverableGoalJobs()).filter((job) => job.jobName === "goal-action-run")).toEqual([
        expect.objectContaining({ jobId: actionJobId, state: "reserved" })
      ]);

      const rejectedAtDeadline = await store.admitGoalActionExecution(actionRun.id, {
        goalRunId,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        jobId: actionJobId,
        phase: "preview",
        now: run.deadlineAt,
        event: {
          type: "action.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "action",
          entityId: actionRun.id,
          summary: "Action preview admitted"
        },
        bindingEvent: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: task.id,
          summary: "Action task admitted"
        }
      });
      expect(rejectedAtDeadline).toEqual({
        status: "rejected",
        reason: "Goal Run duration budget was exhausted."
      });
      expect((await store.getGoalRunDetail(goalRunId))?.actionRuns[0]).toMatchObject({ state: "approved" });

      const previewAdmission = await store.admitGoalActionExecution(actionRun.id, {
        goalRunId,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        jobId: actionJobId,
        phase: "preview",
        now,
        event: {
          type: "action.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "action",
          entityId: actionRun.id,
          summary: "Action preview admitted"
        },
        bindingEvent: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: task.id,
          summary: "Action task admitted"
        }
      });
      expect(previewAdmission).toMatchObject({
        status: "admitted",
        actionRun: { state: "reserved" },
        taskBinding: { state: "running", activeJobId: actionJobId }
      });
      const executeAdmission = await store.admitGoalActionExecution(actionRun.id, {
        goalRunId,
        planTaskId: task.id,
        contractDigest: contract.contractDigest,
        jobId: actionJobId,
        phase: "execute",
        now,
        event: {
          type: "action.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "action",
          entityId: actionRun.id,
          summary: "Action execution admitted"
        },
        bindingEvent: {
          type: "task.state.changed",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: task.id,
          summary: "Action task retained execution ownership"
        }
      });
      expect(executeAdmission).toMatchObject({ status: "admitted", actionRun: { state: "running" } });

      await store.reserveGoalJob(admission);
      await expect(store.getGoalJobAdmission(admission.jobId)).resolves.toEqual(
        expect.objectContaining({ jobId: admission.jobId, state: "reserved" })
      );
      await expect(store.getGoalJobAdmission("missing-goal-job")).resolves.toBeNull();
      await store.setGoalJobState(admission.jobId, "reserved", "admitted");
      expect((await store.getRecoverableGoalJobs()).filter((job) => job.jobName === "goal-action-run")).toEqual([
        expect.objectContaining({ jobId: admission.jobId, state: "admitted" })
      ]);

      const events = await store.getGoalEvents(goalRunId, 0);
      expect(events.map((event) => event.type)).toEqual([
        "goal.created",
        "review.recorded",
        "plan.created",
        "task.bound",
        "contract.approved",
        "action.state.changed",
        "goal.state.changed",
        "task.state.changed",
        "action.state.changed",
        "action.state.changed"
      ]);
      expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
      expect((await store.getGoalEvents(goalRunId, events[1]!.sequence)).map((event) => event.type)).toEqual([
        "plan.created",
        "task.bound",
        "contract.approved",
        "action.state.changed",
        "goal.state.changed",
        "task.state.changed",
        "action.state.changed",
        "action.state.changed"
      ]);
    });
  });
});

integration("Goal Run immutability guards against PostgreSQL", integrationOptions, () => {
  it("rejects persisted-record mutations while permitting repository plan status transitions", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const ownerId = randomUUID();
      const goalRunId = randomUUID();
      const eventId = randomUUID();
      const contractId = randomUUID();
      const draftPlanId = randomUUID();
      const approvedPlanId = randomUUID();
      const supersededPlanId = randomUUID();
      const createdAt = "2026-08-27T00:00:00.000Z";
      const draftDigest = "a".repeat(64);
      const approvedDigest = "b".repeat(64);
      const supersededDigest = "c".repeat(64);

      await pool.query(
        "INSERT INTO owner_users(id, email, password_hash) VALUES ($1, $2, $3)",
        [ownerId, "immutability-owner@example.test", "test-only-hash"]
      );
      await pool.query(`
        INSERT INTO goal_runs(
          id, title, goal, thread_id, meeting_id, state, revision, limits, usage, deadline_at, created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'planning', 1, '{}'::jsonb, '{}'::jsonb, $6::timestamptz, $7, $6::timestamptz, $6::timestamptz)
      `, [goalRunId, "Immutability test Goal Run", "Verify database-level immutable records.", randomUUID(), randomUUID(), createdAt, ownerId]);
      await pool.query(`
        INSERT INTO goal_plan_revisions(id, goal_run_id, revision, status, digest, tasks, created_at)
        VALUES
          ($1, $2, 1, 'draft', $3, '[{"id":"draft-task"}]'::jsonb, $6::timestamptz),
          ($4, $2, 2, 'draft', $5, '[{"id":"approved-task"}]'::jsonb, $6::timestamptz),
          ($7, $2, 3, 'draft', $8, '[{"id":"superseded-task"}]'::jsonb, $6::timestamptz)
      `, [draftPlanId, goalRunId, draftDigest, approvedPlanId, approvedDigest, createdAt, supersededPlanId, supersededDigest]);
      await pool.query(`
        INSERT INTO execution_contracts(
          id, goal_run_id, plan_revision, plan_digest, contract_digest, approved_by, approved_at, limits, plan_snapshot
        ) VALUES ($1, $2, 1, $3, $4, $5, $6::timestamptz, '{"maxTasks":1}'::jsonb, '{"revision":1}'::jsonb)
      `, [contractId, goalRunId, draftDigest, "d".repeat(64), ownerId, createdAt]);
      await pool.query(`
        INSERT INTO goal_events(
          id, goal_run_id, type, actor_type, actor_id, entity_type, entity_id, summary, detail, occurred_at
        ) VALUES ($1, $2, 'goal.created', 'owner', $3, 'goal', $5, 'Goal Run created', '{"source":"test"}'::jsonb, $4::timestamptz)
      `, [eventId, goalRunId, ownerId, createdAt, goalRunId]);

      await expect(pool.query("UPDATE goal_events SET summary = 'tampered' WHERE id = $1", [eventId]))
        .rejects.toThrow(/goal_events are append-only/i);
      await expect(pool.query("DELETE FROM goal_events WHERE id = $1", [eventId]))
        .rejects.toThrow(/goal_events are append-only/i);
      await expect(pool.query("UPDATE execution_contracts SET limits = '{}'::jsonb WHERE id = $1", [contractId]))
        .rejects.toThrow(/execution_contracts are immutable/i);
      await expect(pool.query("DELETE FROM execution_contracts WHERE id = $1", [contractId]))
        .rejects.toThrow(/execution_contracts are immutable/i);
      await expect(pool.query("UPDATE goal_plan_revisions SET id = $2 WHERE id = $1", [draftPlanId, randomUUID()]))
        .rejects.toThrow(/goal_plan_revisions immutable fields cannot be changed/i);
      await expect(pool.query("UPDATE goal_plan_revisions SET digest = $2 WHERE id = $1", [draftPlanId, "e".repeat(64)]))
        .rejects.toThrow(/goal_plan_revisions immutable fields cannot be changed/i);
      await expect(pool.query("UPDATE goal_plan_revisions SET tasks = '[]'::jsonb WHERE id = $1", [draftPlanId]))
        .rejects.toThrow(/goal_plan_revisions immutable fields cannot be changed/i);
      await expect(pool.query(`
        UPDATE goal_plan_revisions
        SET planner_provenance = $2::jsonb
        WHERE id = $1
      `, [draftPlanId, JSON.stringify({
        plannerParticipantId: randomUUID(),
        plannerAgentId: randomUUID(),
        plannerAgentRevision: 1,
        plannerModelConnectorId: randomUUID(),
        plannerRoleId: randomUUID(),
        plannerRoleRevision: 1,
        plannerRoleSnapshotDigest: "a".repeat(64)
      })])).rejects.toThrow(/goal_plan_revisions immutable fields cannot be changed/i);
      await expect(pool.query("UPDATE goal_plan_revisions SET created_at = now() WHERE id = $1", [draftPlanId]))
        .rejects.toThrow(/goal_plan_revisions immutable fields cannot be changed/i);
      await expect(pool.query("UPDATE goal_plan_revisions SET status = 'draft' WHERE id = $1", [draftPlanId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query("UPDATE goal_plan_revisions SET status = 'approved' WHERE id = $1", [approvedPlanId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query("UPDATE goal_plan_revisions SET status = 'superseded' WHERE id = $1", [supersededPlanId]))
        .resolves.toMatchObject({ rowCount: 1 });
      await expect(pool.query("UPDATE goal_plan_revisions SET status = 'draft' WHERE id = $1", [approvedPlanId]))
        .rejects.toThrow(/goal_plan_revisions status transition is not permitted/i);
      await expect(pool.query("DELETE FROM goal_plan_revisions WHERE id = $1", [draftPlanId]))
        .rejects.toThrow(/goal_plan_revisions are immutable/i);

      const [event, contract, plans] = await Promise.all([
        pool.query<{ summary: string; detail: unknown }>("SELECT summary, detail FROM goal_events WHERE id = $1", [eventId]),
        pool.query<{ limits: unknown; plan_snapshot: unknown }>("SELECT limits, plan_snapshot FROM execution_contracts WHERE id = $1", [contractId]),
        pool.query<{ id: string; status: string; digest: string; tasks: unknown; created_at: Date }>(`
          SELECT id, status, digest, tasks, created_at
          FROM goal_plan_revisions
          WHERE goal_run_id = $1
          ORDER BY revision
        `, [goalRunId])
      ]);
      expect(event.rows).toEqual([{ summary: "Goal Run created", detail: { source: "test" } }]);
      expect(contract.rows).toEqual([{ limits: { maxTasks: 1 }, plan_snapshot: { revision: 1 } }]);
      expect(plans.rows.map(({ id, status, digest, tasks }) => ({ id, status, digest, tasks }))).toEqual([
        { id: draftPlanId, status: "draft", digest: draftDigest, tasks: [{ id: "draft-task" }] },
        { id: approvedPlanId, status: "approved", digest: approvedDigest, tasks: [{ id: "approved-task" }] },
        { id: supersededPlanId, status: "superseded", digest: supersededDigest, tasks: [{ id: "superseded-task" }] }
      ]);
      expect(plans.rows.every((plan) => plan.created_at.toISOString() === createdAt)).toBe(true);

      await pool.query("DELETE FROM schema_migrations WHERE version IN ('031_goal_run_immutability', '033_goal_plan_planner_provenance', '035_goal_job_dispatch_lease', '036_goal_planner_role_provenance')");
      await expect(migrateDatabase(pool)).resolves.toBeUndefined();
    });
  });
});

integration("Goal Contract execution history constraints against PostgreSQL", integrationOptions, () => {
  it("keys Action Runs and Reviewer verdicts by immutable Contract digest", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      const constraints = await pool.query<{ table_name: string; definition: string }>(`
        SELECT rel.relname AS table_name, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname IN ('action_runs', 'reviewer_verdicts')
          AND con.contype = 'u'
        ORDER BY rel.relname, con.conname
      `);

      expect(constraints.rows).toEqual(expect.arrayContaining([
        {
          table_name: "action_runs",
          definition: "UNIQUE (goal_run_id, plan_task_id, contract_digest)"
        },
        {
          table_name: "reviewer_verdicts",
          definition: "UNIQUE (goal_run_id, scope, scope_id, reviewer_agent_id, contract_digest)"
        }
      ]));
      expect(constraints.rows).not.toContainEqual({
        table_name: "action_runs",
        definition: "UNIQUE (goal_run_id, plan_task_id)"
      });
      expect(constraints.rows).not.toContainEqual({
        table_name: "reviewer_verdicts",
        definition: "UNIQUE (scope, scope_id, reviewer_agent_id)"
      });
      const reviewerBindingConstraints = await pool.query<{ name: string; definition: string }>(`
        SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'reviewer_verdicts'
          AND con.conname IN (
            'reviewer_verdicts_job_binding_shape',
            'reviewer_verdicts_job_binding_fkey'
          )
        ORDER BY con.conname
      `);
      expect(reviewerBindingConstraints.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "reviewer_verdicts_job_binding_shape",
          definition: expect.stringContaining("review_request_fingerprint")
        }),
        {
          name: "reviewer_verdicts_job_binding_fkey",
          definition: "FOREIGN KEY (review_job_id, review_request_fingerprint) REFERENCES goal_job_admissions(job_id, request_fingerprint) ON DELETE RESTRICT"
        }
      ]));
    });
  });
});

integration("Role orchestration function migration against PostgreSQL", integrationOptions, () => {
  it("backfills built-in Role definitions and Meeting snapshots without overriding explicit values", async () => {
    await withDisposableSchema(async (pool) => {
      await migrateDatabase(pool);
      await pool.query("DELETE FROM schema_migrations WHERE version = '032_role_orchestration_functions'");
      await pool.query(`
        UPDATE platform_state
        SET state = jsonb_set(
          jsonb_set(
            state,
            '{roles}',
            COALESCE((
              SELECT jsonb_agg(
                CASE
                  WHEN role->>'templateKey' IN ('platform_architect', 'meeting_chair')
                    THEN role - 'orchestrationFunctions'
                  WHEN role->>'templateKey' = 'security_reviewer'
                    THEN jsonb_set(role, '{orchestrationFunctions}', '["worker"]'::jsonb, true)
                  ELSE role
                END ORDER BY ordinal
              )
              FROM jsonb_array_elements(state->'roles') WITH ORDINALITY AS entries(role, ordinal)
            ), '[]'::jsonb),
            true
          ),
          '{participants}',
          COALESCE((
            SELECT jsonb_agg(
              participant
              || jsonb_build_object(
                'roleSnapshot', (participant->'roleSnapshot') - 'orchestrationFunctions',
                'roleHistory', COALESCE((
                  SELECT jsonb_agg(
                    history || jsonb_build_object(
                      'roleSnapshot', (history->'roleSnapshot') - 'orchestrationFunctions'
                    ) ORDER BY history_ordinal
                  )
                  FROM jsonb_array_elements(participant->'roleHistory') WITH ORDINALITY AS histories(history, history_ordinal)
                ), '[]'::jsonb)
              ) ORDER BY participant_ordinal
            )
            FROM jsonb_array_elements(state->'participants') WITH ORDINALITY AS participants(participant, participant_ordinal)
          ), '[]'::jsonb),
          true
        )
      `);
      await pool.query(`
        UPDATE role_versions
        SET snapshot = CASE
          WHEN snapshot->>'templateKey' IN ('platform_architect', 'meeting_chair')
            THEN snapshot - 'orchestrationFunctions'
          WHEN snapshot->>'templateKey' = 'security_reviewer'
            THEN jsonb_set(snapshot, '{orchestrationFunctions}', '["worker"]'::jsonb, true)
          ELSE snapshot
        END
        WHERE snapshot->>'templateKey' IN ('platform_architect', 'meeting_chair', 'security_reviewer')
      `);
      const before = await pool.query<{ revision: string }>(
        "SELECT revision::text FROM platform_state WHERE singleton_id = 1"
      );

      await migrateDatabase(pool);

      const first = await pool.query<{
        revision: string;
        state: {
          roles: Array<{ templateKey: string | null; orchestrationFunctions?: string[] }>;
          participants: Array<{
            roleSnapshot: { orchestrationFunctions?: string[] };
            roleHistory: Array<{ roleSnapshot: { orchestrationFunctions?: string[] } }>;
          }>;
        };
      }>("SELECT revision::text, state FROM platform_state WHERE singleton_id = 1");
      const roleFunctions = Object.fromEntries(first.rows[0]!.state.roles.map((role) => [role.templateKey, role.orchestrationFunctions]));
      expect(roleFunctions).toMatchObject({
        platform_architect: ["planner", "worker"],
        meeting_chair: ["chair", "planner"],
        security_reviewer: ["worker"]
      });
      expect(first.rows[0]!.state.participants[0]!.roleSnapshot.orchestrationFunctions).toEqual(["chair", "planner"]);
      expect(first.rows[0]!.state.participants[0]!.roleHistory[0]!.roleSnapshot.orchestrationFunctions).toEqual(["chair", "planner"]);
      expect(Number(first.rows[0]!.revision)).toBe(Number(before.rows[0]!.revision) + 1);

      const versions = await pool.query<{ template_key: string; functions: string[] }>(`
        SELECT snapshot->>'templateKey' AS template_key, snapshot->'orchestrationFunctions' AS functions
        FROM role_versions
        WHERE snapshot->>'templateKey' IN ('platform_architect', 'meeting_chair', 'security_reviewer')
        ORDER BY template_key
      `);
      expect(Object.fromEntries(versions.rows.map((row) => [row.template_key, row.functions]))).toMatchObject({
        meeting_chair: ["chair", "planner"],
        platform_architect: ["planner", "worker"],
        security_reviewer: ["worker"]
      });

      await migrateDatabase(pool);
      const second = await pool.query<{ revision: string; state: unknown }>(
        "SELECT revision::text, state FROM platform_state WHERE singleton_id = 1"
      );
      expect(second.rows[0]).toEqual(first.rows[0]);
    });
  });
});

afterAll(async () => {
  await adminPool?.end();
});
