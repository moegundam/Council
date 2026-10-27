import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeRun, RuntimeRunEvent } from "@council/contracts";
import { runtimeRunEventSchema, runtimeRunSchema } from "@council/contracts";
import { applyRuntimeRunMutation } from "@council/domain";
import type { Pool, PoolClient } from "pg";
import {
  StoreConflictError,
  StoreNotFoundError,
  type AppendRuntimeRunEventInput,
  type RuntimeRunHeartbeatInput,
  type RuntimeRunMutationInput
} from "./store.js";

type DbTimestamp = string | Date;

const runtimeRunColumns = `
  id,
  kind,
  scope,
  runtime_profile AS "runtimeProfile",
  goal_run_id AS "goalRunId",
  task_id AS "taskId",
  agent_id AS "agentId",
  agent_revision AS "agentRevision",
  role_id AS "roleId",
  role_revision AS "roleRevision",
  state,
  attempt,
  idempotency_key AS "idempotencyKey",
  evidence_ids AS "evidenceIds",
  queued_at AS "queuedAt",
  started_at AS "startedAt",
  completed_at AS "completedAt",
  expires_at AS "expiresAt",
  error_code AS "errorCode",
  runtime_version AS "runtimeVersion",
  provider_session_id AS "providerSessionId",
  lease_id AS "leaseId",
  revision,
  heartbeat_at AS "heartbeatAt",
  event_cursor AS "eventCursor",
  paused_at AS "pausedAt",
  updated_at AS "updatedAt"
`;

const runtimeRunEventColumns = `
  id,
  runtime_run_id AS "runtimeRunId",
  sequence,
  type,
  phase,
  summary,
  tool_name AS "toolName",
  progress_percent AS "progressPercent",
  usage,
  error_code AS "errorCode",
  actor_type AS "actorType",
  occurred_at AS "occurredAt"
`;

function iso(value: DbTimestamp): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function runtimeRunFromRow(row: Record<string, unknown>): RuntimeRun {
  const normalized = { ...row };
  for (const key of ["queuedAt", "startedAt", "completedAt", "expiresAt", "heartbeatAt", "pausedAt", "updatedAt"] as const) {
    const value = normalized[key];
    if (value !== null && value !== undefined) normalized[key] = iso(value as DbTimestamp);
  }
  for (const key of ["revision", "eventCursor", "attempt", "agentRevision", "roleRevision"] as const) {
    if (typeof normalized[key] === "string") normalized[key] = Number(normalized[key]);
  }
  return runtimeRunSchema.parse(normalized);
}

function runtimeRunEventFromRow(row: Record<string, unknown>): RuntimeRunEvent {
  const normalized: Record<string, unknown> = { ...row, occurredAt: iso(row.occurredAt as DbTimestamp) };
  if (typeof normalized.sequence === "string") normalized.sequence = Number(normalized.sequence);
  if (typeof normalized.progressPercent === "string") normalized.progressPercent = Number(normalized.progressPercent);
  return runtimeRunEventSchema.parse(normalized);
}

export class PostgresRuntimeRunRepository {
  constructor(private readonly pool: Pool) {}

  async createRuntimeRun(run: RuntimeRun, initialEvent: AppendRuntimeRunEventInput): Promise<RuntimeRun> {
    const parsed = runtimeRunSchema.parse(run);
    return this.transaction(async (client) => {
      const inserted = await client.query<Record<string, unknown>>(`
        INSERT INTO runtime_runs(
          id, kind, scope, runtime_profile, goal_run_id, task_id, agent_id, agent_revision,
          role_id, role_revision, state, attempt, idempotency_key, evidence_ids, queued_at,
          started_at, completed_at, expires_at, error_code, runtime_version,
          provider_session_id, lease_id, revision, heartbeat_at, event_cursor, paused_at, updated_at
        ) VALUES (
          $1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8,
          $9, $10, $11, $12, $13, $14::uuid[], $15,
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27
        )
        ON CONFLICT DO NOTHING
        RETURNING ${runtimeRunColumns}
      `, [
        parsed.id,
        parsed.kind,
        JSON.stringify(parsed.scope),
        JSON.stringify(parsed.runtimeProfile),
        parsed.goalRunId,
        parsed.taskId,
        parsed.agentId,
        parsed.agentRevision,
        parsed.roleId,
        parsed.roleRevision,
        parsed.state,
        parsed.attempt,
        parsed.idempotencyKey,
        parsed.evidenceIds,
        parsed.queuedAt,
        parsed.startedAt,
        parsed.completedAt,
        parsed.expiresAt,
        parsed.errorCode,
        parsed.runtimeVersion,
        parsed.providerSessionId,
        parsed.leaseId,
        parsed.revision,
        parsed.heartbeatAt,
        parsed.eventCursor,
        parsed.pausedAt,
        parsed.updatedAt
      ]);
      if (inserted.rows[0]) {
        await this.appendEvent(client, parsed.id, initialEvent);
        return runtimeRunFromRow(inserted.rows[0]);
      }

      const replay = await client.query<Record<string, unknown>>(`
        SELECT ${runtimeRunColumns}
        FROM runtime_runs
        WHERE id = $1 OR idempotency_key = $2
        FOR UPDATE
      `, [parsed.id, parsed.idempotencyKey]);
      const existing = replay.rows[0] ? runtimeRunFromRow(replay.rows[0]) : null;
      if (!existing || !isDeepStrictEqual(existing, parsed)) {
        throw new StoreConflictError("Runtime Run idempotency binding conflicts with an existing run.");
      }
      return existing;
    });
  }

  async getRuntimeRun(id: string): Promise<RuntimeRun | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${runtimeRunColumns} FROM runtime_runs WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? runtimeRunFromRow(result.rows[0]) : null;
  }

  async getRuntimeRunForTask(taskId: string): Promise<RuntimeRun | null> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${runtimeRunColumns}
      FROM runtime_runs
      WHERE task_id = $1
      ORDER BY attempt DESC, queued_at DESC, id
      LIMIT 1
    `, [taskId]);
    return result.rows[0] ? runtimeRunFromRow(result.rows[0]) : null;
  }

  async listRuntimeRunsForGoal(goalRunId: string): Promise<RuntimeRun[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${runtimeRunColumns}
      FROM runtime_runs
      WHERE goal_run_id = $1
      ORDER BY queued_at, id
    `, [goalRunId]);
    return result.rows.map(runtimeRunFromRow);
  }

  async listRecoverableOmpRuntimeRuns(limit = 1_000): Promise<RuntimeRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("Runtime recovery limit is invalid.");
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${runtimeRunColumns}
      FROM runtime_runs
      WHERE runtime_profile->>'harnessKind' = 'pi'
        AND state NOT IN ('completed', 'failed', 'cancelled', 'expired')
      ORDER BY updated_at, id
      LIMIT $1
    `, [limit]);
    return result.rows.map(runtimeRunFromRow);
  }

  async updateRuntimeRun(id: string, input: RuntimeRunMutationInput): Promise<RuntimeRun> {
    return this.transaction(async (client) => {
      const current = await this.lockRuntimeRun(client, id);
      const updated = applyRuntimeRunMutation(current, input);
      const result = await this.persistMutation(client, updated, input.expectedRevision);
      await this.appendEvent(client, id, input.event);
      return result;
    });
  }

  async heartbeatRuntimeRun(id: string, input: RuntimeRunHeartbeatInput): Promise<RuntimeRun> {
    return this.transaction(async (client) => {
      const current = await this.lockRuntimeRun(client, id);
      const updated = applyRuntimeRunMutation(current, {
        expectedRevision: input.expectedRevision,
        state: input.state,
        heartbeatAt: input.heartbeatAt,
        eventCursor: input.eventCursor,
        at: input.heartbeatAt
      });
      return this.persistMutation(client, updated, input.expectedRevision);
    });
  }

  async appendRuntimeRunEvent(id: string, input: AppendRuntimeRunEventInput): Promise<RuntimeRunEvent> {
    return this.transaction(async (client) => {
      await this.lockRuntimeRun(client, id);
      return this.appendEvent(client, id, input);
    });
  }

  async getRuntimeRunEvents(id: string, afterSequence = 0, limit = 100): Promise<RuntimeRunEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("Runtime Run event sequence must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Runtime Run event limit must be between 1 and 500.");
    }
    const exists = await this.pool.query("SELECT 1 FROM runtime_runs WHERE id = $1", [id]);
    if (exists.rowCount !== 1) throw new StoreNotFoundError("Runtime Run was not found.");
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${runtimeRunEventColumns}
      FROM runtime_run_events
      WHERE runtime_run_id = $1 AND sequence > $2
      ORDER BY sequence
      LIMIT $3
    `, [id, afterSequence, limit]);
    return result.rows.map(runtimeRunEventFromRow);
  }

  private async persistMutation(
    client: PoolClient,
    run: RuntimeRun,
    expectedRevision: number
  ): Promise<RuntimeRun> {
    const result = await client.query<Record<string, unknown>>(`
      UPDATE runtime_runs
      SET state = $3,
          evidence_ids = $4::uuid[],
          started_at = $5,
          completed_at = $6,
          expires_at = $7,
          error_code = $8,
          provider_session_id = $9,
          lease_id = $10,
          revision = $11,
          heartbeat_at = $12,
          event_cursor = $13,
          paused_at = $14,
          updated_at = $15
      WHERE id = $1 AND revision = $2
      RETURNING ${runtimeRunColumns}
    `, [
      run.id,
      expectedRevision,
      run.state,
      run.evidenceIds,
      run.startedAt,
      run.completedAt,
      run.expiresAt,
      run.errorCode,
      run.providerSessionId,
      run.leaseId,
      run.revision,
      run.heartbeatAt,
      run.eventCursor,
      run.pausedAt,
      run.updatedAt
    ]);
    if (!result.rows[0]) {
      throw new StoreConflictError("Runtime Run revision changed.", "revision", "RUNTIME_RUN_REVISION_CONFLICT");
    }
    return runtimeRunFromRow(result.rows[0]);
  }

  private async appendEvent(
    client: PoolClient,
    runtimeRunId: string,
    input: AppendRuntimeRunEventInput
  ): Promise<RuntimeRunEvent> {
    const sequenceResult = await client.query<{ sequence: string }>(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM runtime_run_events
      WHERE runtime_run_id = $1
    `, [runtimeRunId]);
    const sequence = Number(sequenceResult.rows[0]?.sequence ?? 1);
    const event = runtimeRunEventSchema.parse({
      id: randomUUID(),
      runtimeRunId,
      sequence,
      ...input,
      occurredAt: input.occurredAt ?? new Date().toISOString()
    });
    const result = await client.query<Record<string, unknown>>(`
      INSERT INTO runtime_run_events(
        id, runtime_run_id, sequence, type, phase, summary, tool_name,
        progress_percent, usage, error_code, actor_type, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
      RETURNING ${runtimeRunEventColumns}
    `, [
      event.id,
      event.runtimeRunId,
      event.sequence,
      event.type,
      event.phase,
      event.summary,
      event.toolName,
      event.progressPercent,
      event.usage === null ? null : JSON.stringify(event.usage),
      event.errorCode,
      event.actorType,
      event.occurredAt
    ]);
    return runtimeRunEventFromRow(result.rows[0]!);
  }

  private async lockRuntimeRun(client: PoolClient, id: string): Promise<RuntimeRun> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${runtimeRunColumns} FROM runtime_runs WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!result.rows[0]) throw new StoreNotFoundError("Runtime Run was not found.");
    return runtimeRunFromRow(result.rows[0]);
  }

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
