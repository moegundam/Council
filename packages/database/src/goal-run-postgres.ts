import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ActionAdapter,
  ActionRun,
  ActionRunState,
  ExecutionContract,
  GoalEvent,
  GoalPlanRevision,
  GoalReviewJobData,
  GoalRun,
  GoalTaskState,
  GoalTaskBinding,
  PlatformSnapshot,
  ReviewerVerdict
} from "@council/contracts";
import {
  actionAdapterEndpointDigest,
  goalBudgetFailureReason,
  goalBudgetReservationFailureReason
} from "@council/domain";
import {
  actionAdapterSchema,
  actionRunSchema,
  executionContractSchema,
  goalEventSchema,
  goalPlanRevisionSchema,
  goalReviewJobDataSchema,
  goalRunSchema,
  goalTaskBindingSchema,
  reviewerVerdictSchema
} from "@council/contracts";
import type { Pool, PoolClient } from "pg";
import {
  assertExecutionActionBindings,
  assertGoalPlannerProvenance,
  assertGoalReviewJobAdmission,
  assertReservedGoalOrchestrationAdmission,
  normalizeGoalJobAdmission,
  normalizeGoalJobDispatchClaimInput,
  requestFingerprint,
  goalRunCreateIdempotencyInput,
  goalCancellationActionStates,
  goalCancellationBlockingActionStates,
  goalCancellationTaskStates,
  StoreConflictError,
  StoreNotFoundError,
  validateGoalJobDispatchToken,
  type ActionRunMutationInput,
  type AppendGoalEventInput,
  type GoalApprovalMutationInput,
  type GoalActionExecutionAdmissionInput,
  type GoalActionExecutionAdmissionResult,
  type GoalJobAdmission,
  type GoalJobAdmissionState,
  type GoalJobDispatchClaimInput,
  type GoalJobDispatchClaimResult,
  type GoalPlanMutationInput,
  type GoalRunDetail,
  type GoalRunStateMutationInput,
  type GoalTaskDispatchClaimInput,
  type GoalTaskDispatchClaimResult,
  type GoalTaskBindingMutationInput
} from "./store.js";

type DbTimestamp = string | Date;

const goalRunColumns = `
  id,
  title,
  goal,
  thread_id AS "threadId",
  meeting_id AS "meetingId",
  state,
  revision,
  active_plan_revision AS "activePlanRevision",
  execution_contract_id AS "executionContractId",
  limits,
  usage,
  deadline_at AS "deadlineAt",
  paused_from_state AS "pausedFromState",
  terminal_reason AS "terminalReason",
  created_by AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const planColumns = `
  id,
  goal_run_id AS "goalRunId",
  revision,
  status,
  digest,
  tasks,
  planner_provenance AS "plannerProvenance",
  created_at AS "createdAt"
`;

const contractColumns = `
  id,
  goal_run_id AS "goalRunId",
  plan_revision AS "planRevision",
  plan_digest AS "planDigest",
  contract_digest AS "contractDigest",
  approved_by AS "approvedBy",
  approved_at AS "approvedAt",
  limits,
  plan_snapshot AS "planSnapshot",
  action_bindings AS "actionBindings",
  runtime_bindings AS "runtimeBindings"
`;

const bindingColumns = `
  id,
  goal_run_id AS "goalRunId",
  plan_revision AS "planRevision",
  plan_task_id AS "planTaskId",
  task_id AS "taskId",
  state,
  attempt_count AS "attemptCount",
  active_job_id AS "activeJobId",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const eventColumns = `
  id,
  goal_run_id AS "goalRunId",
  sequence,
  type,
  actor_type AS "actorType",
  actor_id AS "actorId",
  entity_type AS "entityType",
  entity_id AS "entityId",
  summary,
  detail,
  occurred_at AS "occurredAt"
`;

const reviewColumns = `
  id,
  goal_run_id AS "goalRunId",
  scope,
  scope_id AS "scopeId",
  reviewer_agent_id AS "reviewerAgentId",
  reviewer_agent_revision AS "reviewerAgentRevision",
  model_connector_id AS "modelConnectorId",
  verdict,
  summary,
  evidence_ids AS "evidenceIds",
  contract_digest AS "contractDigest",
  review_job_id AS "reviewJobId",
  review_request_fingerprint AS "reviewRequestFingerprint",
  created_at AS "createdAt"
`;

const adapterColumns = `
  id,
  name,
  kind,
  enabled,
  base_url AS "baseUrl",
  credential_id AS "credentialId",
  catalog_revision AS "catalogRevision",
  actions,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const actionRunColumns = `
  id,
  goal_run_id AS "goalRunId",
  plan_task_id AS "planTaskId",
  adapter_id AS "adapterId",
  adapter_catalog_revision AS "adapterCatalogRevision",
  action_key AS "actionKey",
  target_id AS "targetId",
  inputs,
  state,
  request_fingerprint AS "requestFingerprint",
  contract_digest AS "contractDigest",
  external_execution_id AS "externalExecutionId",
  verification_summary AS "verificationSummary",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const admissionColumns = `
  job_id AS "jobId",
  goal_run_id AS "goalRunId",
  job_name AS "jobName",
  entity_id AS "entityId",
  request_fingerprint AS "requestFingerprint",
  state,
  dispatch_token AS "dispatchToken",
  dispatch_lease_expires_at AS "dispatchLeaseExpiresAt",
  reserved_at AS "reservedAt",
  admitted_at AS "admittedAt",
  started_at AS "startedAt",
  settled_at AS "settledAt",
  updated_at AS "updatedAt"
`;

const reviewAdmissionColumns = `
  admission.job_id AS "jobId",
  admission.goal_run_id AS "goalRunId",
  admission.job_name AS "jobName",
  admission.entity_id AS "entityId",
  admission.request_fingerprint AS "requestFingerprint",
  admission.state,
  admission.dispatch_token AS "dispatchToken",
  admission.dispatch_lease_expires_at AS "dispatchLeaseExpiresAt",
  admission.reserved_at AS "reservedAt",
  admission.admitted_at AS "admittedAt",
  admission.started_at AS "startedAt",
  admission.settled_at AS "settledAt",
  admission.updated_at AS "updatedAt"
`;

function iso(value: DbTimestamp): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function withIso(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...row };
  for (const key of keys) {
    const value = normalized[key];
    if (value !== null && value !== undefined) normalized[key] = iso(value as DbTimestamp);
  }
  return normalized;
}

function goalRunFromRow(row: Record<string, unknown>): GoalRun {
  return goalRunSchema.parse(withIso(row, ["deadlineAt", "createdAt", "updatedAt"]));
}

function planFromRow(row: Record<string, unknown>): GoalPlanRevision {
  const normalized = withIso(row, ["createdAt"]);
  if (normalized.plannerProvenance === null) delete normalized.plannerProvenance;
  return goalPlanRevisionSchema.parse(normalized);
}

function contractFromRow(row: Record<string, unknown>): ExecutionContract {
  return executionContractSchema.parse(withIso(row, ["approvedAt"]));
}

function bindingFromRow(row: Record<string, unknown>): GoalTaskBinding {
  return goalTaskBindingSchema.parse(withIso(row, ["createdAt", "updatedAt"]));
}

function eventFromRow(row: Record<string, unknown>): GoalEvent {
  const normalized = withIso(row, ["occurredAt"]);
  if (typeof normalized.sequence === "string") normalized.sequence = Number(normalized.sequence);
  return goalEventSchema.parse(normalized);
}

function verdictFromRow(row: Record<string, unknown>): ReviewerVerdict {
  return reviewerVerdictSchema.parse(withIso(row, ["createdAt"]));
}

function adapterFromRow(row: Record<string, unknown>): ActionAdapter {
  return actionAdapterSchema.parse(withIso(row, ["createdAt", "updatedAt"]));
}

function actionRunFromRow(row: Record<string, unknown>): ActionRun {
  return actionRunSchema.parse(withIso(row, ["createdAt", "updatedAt"]));
}

function admissionFromRow(row: Record<string, unknown>): GoalJobAdmission {
  return {
    jobId: String(row.jobId),
    goalRunId: String(row.goalRunId),
    jobName: row.jobName as GoalJobAdmission["jobName"],
    entityId: String(row.entityId),
    requestFingerprint: String(row.requestFingerprint),
    state: row.state as GoalJobAdmissionState,
    dispatchToken: row.dispatchToken === null || row.dispatchToken === undefined ? null : String(row.dispatchToken),
    dispatchLeaseExpiresAt: row.dispatchLeaseExpiresAt === null || row.dispatchLeaseExpiresAt === undefined
      ? null
      : iso(row.dispatchLeaseExpiresAt as DbTimestamp),
    reservedAt: iso(row.reservedAt as DbTimestamp),
    admittedAt: row.admittedAt === null ? null : iso(row.admittedAt as DbTimestamp),
    startedAt: row.startedAt === null ? null : iso(row.startedAt as DbTimestamp),
    settledAt: row.settledAt === null ? null : iso(row.settledAt as DbTimestamp),
    updatedAt: iso(row.updatedAt as DbTimestamp)
  };
}

async function audit(
  client: PoolClient,
  event: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await client.query(
    "INSERT INTO audit_events(id, event, entity_type, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [randomUUID(), event, entityType, entityId, JSON.stringify(detail)]
  );
}

async function appendEvent(
  client: PoolClient,
  goalRunId: string,
  input: AppendGoalEventInput
): Promise<GoalEvent> {
  const result = await client.query<Record<string, unknown>>(`
    INSERT INTO goal_events(
      id, goal_run_id, type, actor_type, actor_id, entity_type, entity_id, summary, detail, occurred_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
    RETURNING ${eventColumns}
  `, [
    randomUUID(),
    goalRunId,
    input.type,
    input.actorType,
    input.actorId,
    input.entityType,
    input.entityId,
    input.summary,
    JSON.stringify(input.detail ?? {}),
    input.occurredAt ?? new Date().toISOString()
  ]);
  return eventFromRow(result.rows[0]!);
}

export class PostgresGoalRunRepository {
  constructor(private readonly pool: Pool) {}

  async listGoalRuns(): Promise<GoalRun[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${goalRunColumns}
      FROM goal_runs
      ORDER BY updated_at DESC, id
    `);
    return result.rows.map(goalRunFromRow);
  }

  async getGoalRun(id: string, existingClient?: PoolClient): Promise<GoalRun | null> {
    const result = await (existingClient ?? this.pool).query<Record<string, unknown>>(
      `SELECT ${goalRunColumns} FROM goal_runs WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? goalRunFromRow(result.rows[0]) : null;
  }

  async getGoalRunDetail(id: string, existingClient?: PoolClient): Promise<GoalRunDetail | null> {
    if (existingClient) return this.loadDetail(existingClient, id);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const detail = await this.loadDetail(client, id);
      await client.query("COMMIT");
      return detail;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createGoalRun(
    run: GoalRun,
    event: AppendGoalEventInput,
    idempotencyKey: string,
    orchestrationAdmission?: GoalJobAdmission,
    existingClient?: PoolClient
  ): Promise<GoalRun> {
    const parsed = goalRunSchema.parse(run);
    if (orchestrationAdmission) {
      assertReservedGoalOrchestrationAdmission(orchestrationAdmission, parsed.id, parsed.id);
    }
    const fingerprint = requestFingerprint(goalRunCreateIdempotencyInput(parsed, event));
    const create = async (client: PoolClient): Promise<GoalRun> => {
      const replay = await client.query<{ requestFingerprint: string | null; response: unknown }>(`
        SELECT request_fingerprint AS "requestFingerprint", response
        FROM idempotency_records
        WHERE operation = 'goal_run.create' AND idempotency_key = $1
        FOR UPDATE
      `, [idempotencyKey]);
      const existing = replay.rows[0];
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) throw new StoreConflictError("Idempotency key was reused with a different Goal Run request.");
        return goalRunSchema.parse(existing.response);
      }
      await client.query(`
        INSERT INTO goal_runs(
          id, title, goal, thread_id, meeting_id, state, revision, active_plan_revision,
          execution_contract_id, limits, usage, deadline_at, paused_from_state,
          terminal_reason, created_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17
        )
      `, [
        parsed.id, parsed.title, parsed.goal, parsed.threadId, parsed.meetingId, parsed.state,
        parsed.revision, parsed.activePlanRevision, parsed.executionContractId,
        JSON.stringify(parsed.limits), JSON.stringify(parsed.usage), parsed.deadlineAt,
        parsed.pausedFromState, parsed.terminalReason, parsed.createdBy, parsed.createdAt, parsed.updatedAt
      ]);
      await appendEvent(client, parsed.id, event);
      if (orchestrationAdmission) await this.reserveGoalJob(orchestrationAdmission, client);
      await audit(client, "goal_run.created", "goal_run", parsed.id, {
        threadId: parsed.threadId,
        meetingId: parsed.meetingId,
        state: parsed.state
      });
      await client.query(`
        INSERT INTO idempotency_records(operation, idempotency_key, request_fingerprint, response)
        VALUES ('goal_run.create', $1, $2, $3::jsonb)
      `, [idempotencyKey, fingerprint, JSON.stringify(parsed)]);
      return parsed;
    };
    return existingClient ? create(existingClient) : this.transaction(create);
  }

  async saveGoalPlan(id: string, input: GoalPlanMutationInput, existingClient?: PoolClient): Promise<GoalRunDetail> {
    const plan = goalPlanRevisionSchema.parse(input.plan);
    const action = async (client: PoolClient): Promise<GoalRunDetail> => {
      const run = await this.lockGoalRun(client, id);
      this.assertRevision(run, input.expectedRevision);
      if (run.executionContractId !== null && run.state !== "paused") {
        throw new StoreConflictError("An approved Goal Plan must be paused before a new revision is created.");
      }
      if (!["planning", "awaiting_approval", "replanning", "paused"].includes(run.state)) {
        throw new StoreConflictError("Goal Run is not in a state that permits Plan revision.");
      }
      if (run.activePlanRevision !== input.expectedPlanRevision) {
        throw new StoreConflictError("Goal Plan revision changed.", "revision", "GOAL_PLAN_REVISION_CONFLICT");
      }
      if (plan.goalRunId !== id || plan.revision !== input.expectedPlanRevision + 1 || plan.status !== "draft") {
        throw new StoreConflictError("Goal Plan identity or revision is invalid.");
      }
      const previousPlanResult = input.expectedPlanRevision > 0
        ? await client.query<Record<string, unknown>>(`
          SELECT ${planColumns}
          FROM goal_plan_revisions
          WHERE goal_run_id = $1 AND revision = $2
        `, [id, input.expectedPlanRevision])
        : { rows: [] };
      const previousPlan = previousPlanResult.rows[0] ? planFromRow(previousPlanResult.rows[0]) : null;
      if (input.event.actorType === "owner" && previousPlan
        && JSON.stringify(plan.plannerProvenance ?? null) !== JSON.stringify(previousPlan.plannerProvenance ?? null)) {
        throw new StoreConflictError("Owner Plan revisions must retain immutable Planner provenance.");
      }
      if (input.event.actorType === "agent"
        && (!plan.plannerProvenance || input.event.actorId !== plan.plannerProvenance.plannerAgentId)) {
        throw new StoreConflictError("Agent-authored Goal Plans require matching immutable Planner provenance.");
      }
      if (plan.plannerProvenance) {
        const platformState = await client.query<{ state: PlatformSnapshot }>(`
          SELECT state
          FROM platform_state
          WHERE singleton_id = 1
          FOR SHARE
        `);
        if (!platformState.rows[0]) throw new StoreConflictError("Platform state is missing for Planner provenance validation.");
        assertGoalPlannerProvenance(run, plan.plannerProvenance, platformState.rows[0].state);
      }
      await client.query("UPDATE goal_plan_revisions SET status = 'superseded' WHERE goal_run_id = $1 AND status = 'draft'", [id]);
      await client.query(`
        INSERT INTO goal_plan_revisions(
          id, goal_run_id, revision, status, digest, tasks, planner_provenance, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
      `, [
        plan.id, id, plan.revision, plan.status, plan.digest, JSON.stringify(plan.tasks),
        plan.plannerProvenance ? JSON.stringify(plan.plannerProvenance) : null, plan.createdAt
      ]);
      await client.query(`
        UPDATE goal_runs
        SET state = 'awaiting_approval',
            active_plan_revision = $2,
            execution_contract_id = NULL,
            paused_from_state = NULL,
            terminal_reason = NULL,
            revision = revision + 1,
            updated_at = now()
        WHERE id = $1
      `, [id, plan.revision]);
      await appendEvent(client, id, input.event);
      await audit(client, "goal_plan.created", "goal_run", id, {
        planRevision: plan.revision,
        planDigest: plan.digest,
        taskCount: plan.tasks.length
      });
      return (await this.loadDetail(client, id))!;
    };
    return existingClient ? action(existingClient) : this.transaction(action);
  }

  async approveGoalRun(id: string, input: GoalApprovalMutationInput, existingClient?: PoolClient): Promise<GoalRunDetail> {
    const contract = executionContractSchema.parse(input.contract);
    assertExecutionActionBindings(contract);
    const bindings = input.bindings.map((binding) => goalTaskBindingSchema.parse(binding));
    const action = async (client: PoolClient): Promise<GoalRunDetail> => {
      const run = await this.lockGoalRun(client, id);
      this.assertRevision(run, input.expectedRevision);
      if (run.state !== "awaiting_approval" || run.executionContractId !== null) {
        throw new StoreConflictError("Goal Run is not awaiting its one-time approval.");
      }
      if (input.orchestrationAdmission) {
        assertReservedGoalOrchestrationAdmission(input.orchestrationAdmission, id, id);
        await this.reserveGoalJob(input.orchestrationAdmission, client);
      }
      const planResult = await client.query<Record<string, unknown>>(`
        SELECT ${planColumns}
        FROM goal_plan_revisions
        WHERE goal_run_id = $1 AND revision = $2
        FOR UPDATE
      `, [id, contract.planRevision]);
      const planRow = planResult.rows[0];
      if (!planRow) throw new StoreConflictError("Approved Goal Plan was not found.");
      const plan = planFromRow(planRow);
      if (contract.goalRunId !== id || contract.planRevision !== run.activePlanRevision || contract.planDigest !== plan.digest) {
        throw new StoreConflictError("Execution Contract targets a stale or mismatched Goal Plan.", "revision", "GOAL_PLAN_REVISION_CONFLICT");
      }
      if (bindings.length !== plan.tasks.length
        || new Set(bindings.map((binding) => binding.planTaskId)).size !== plan.tasks.length
        || bindings.some((binding) => (
          binding.goalRunId !== id
          || binding.planRevision !== plan.revision
          || binding.taskId === null
        ))) {
        throw new StoreConflictError("Goal task bindings do not match the approved Plan.");
      }
      await client.query(`
        INSERT INTO execution_contracts(
          id, goal_run_id, plan_revision, plan_digest, contract_digest, approved_by,
          approved_at, limits, plan_snapshot, action_bindings, runtime_bindings
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)
      `, [
        contract.id, id, contract.planRevision, contract.planDigest, contract.contractDigest,
        contract.approvedBy, contract.approvedAt, JSON.stringify(contract.limits), JSON.stringify(contract.planSnapshot),
        JSON.stringify(contract.actionBindings), JSON.stringify(contract.runtimeBindings)
      ]);
      for (const binding of bindings) {
        await client.query(`
          INSERT INTO goal_task_bindings(
            id, goal_run_id, plan_revision, plan_task_id, task_id, state, attempt_count,
            active_job_id, last_error, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          binding.id, id, binding.planRevision, binding.planTaskId, binding.taskId, binding.state,
          binding.attemptCount, binding.activeJobId, binding.lastError, binding.createdAt, binding.updatedAt
        ]);
        const planTask = plan.tasks.find((task) => task.id === binding.planTaskId)!;
        await appendEvent(client, id, {
          type: "task.bound",
          actorType: "system",
          actorId: null,
          entityType: "task",
          entityId: binding.taskId!,
          summary: "Goal Plan task bound to its canonical Meeting Task.",
          detail: {
            planTaskId: binding.planTaskId,
            decisionId: planTask.decisionId,
            taskId: binding.taskId
          }
        });
      }
      await client.query("UPDATE goal_plan_revisions SET status = 'approved' WHERE goal_run_id = $1 AND revision = $2", [id, contract.planRevision]);
      await client.query(`
        UPDATE goal_runs
        SET state = 'executing', execution_contract_id = $2, revision = revision + 1, updated_at = now()
        WHERE id = $1
      `, [id, contract.id]);
      await appendEvent(client, id, input.event);
      await audit(client, "goal_contract.approved", "goal_run", id, {
        planRevision: contract.planRevision,
        planDigest: contract.planDigest,
        contractDigest: contract.contractDigest,
        approvedBy: contract.approvedBy
      });
      return (await this.loadDetail(client, id))!;
    };
    return existingClient ? action(existingClient) : this.transaction(action);
  }

  async setGoalRunState(id: string, input: GoalRunStateMutationInput, existingClient?: PoolClient): Promise<GoalRun> {
    const action = async (client: PoolClient): Promise<GoalRun> => {
      const run = await this.lockGoalRun(client, id);
      this.assertRevision(run, input.expectedRevision);
      let cancellableBindings: Array<{
        id: string;
        planTaskId: string;
        taskId: string | null;
        state: GoalTaskState;
      }> = [];
      let cancellableActions: Array<{
        id: string;
        planTaskId: string;
        state: ActionRunState;
      }> = [];
      if (input.state === "cancelled") {
        const bindings = await client.query<{
          id: string;
          planTaskId: string;
          taskId: string | null;
          state: GoalTaskState;
        }>(`
          SELECT id, plan_task_id AS "planTaskId", task_id AS "taskId", state
          FROM goal_task_bindings
          WHERE goal_run_id = $1
          ORDER BY created_at, id
          FOR UPDATE
        `, [id]);
        cancellableBindings = bindings.rows.filter((candidate) => goalCancellationTaskStates.includes(
          candidate.state as (typeof goalCancellationTaskStates)[number]
        ));

        const actions = await client.query<{ id: string; planTaskId: string; state: ActionRunState }>(`
          SELECT id, plan_task_id AS "planTaskId", state
          FROM action_runs
          WHERE goal_run_id = $1
          ORDER BY created_at, id
          FOR UPDATE
        `, [id]);
        if (actions.rows.some((candidate) => goalCancellationBlockingActionStates.includes(
          candidate.state as (typeof goalCancellationBlockingActionStates)[number]
        ))) {
          throw new StoreConflictError(
            "The Goal cannot be cancelled while an Action has an active or unknown external outcome.",
            "business_rule",
            "GOAL_ACTION_RECONCILIATION_REQUIRED"
          );
        }
        cancellableActions = actions.rows.filter((candidate) => goalCancellationActionStates.includes(
          candidate.state as (typeof goalCancellationActionStates)[number]
        ));
      }
      if (input.orchestrationAdmission) {
        assertReservedGoalOrchestrationAdmission(input.orchestrationAdmission, id, id);
        await this.reserveGoalJob(input.orchestrationAdmission, client);
      }
      if (cancellableBindings.length > 0) {
        await client.query(`
          UPDATE goal_task_bindings
          SET state = 'cancelled', active_job_id = NULL, updated_at = now()
          WHERE id = ANY($1::uuid[])
        `, [cancellableBindings.map((binding) => binding.id)]);
        for (const binding of cancellableBindings) {
          await appendEvent(client, id, {
            type: "task.state.changed",
            actorType: input.event.actorType,
            actorId: input.event.actorId,
            entityType: "task",
            entityId: binding.taskId ?? binding.planTaskId,
            summary: "Goal task cancelled because its Goal Run was cancelled.",
            detail: {
              bindingId: binding.id,
              planTaskId: binding.planTaskId,
              taskId: binding.taskId,
              fromState: binding.state,
              toState: "cancelled",
              reason: "goal_cancelled"
            },
            ...(input.event.occurredAt ? { occurredAt: input.event.occurredAt } : {})
          });
        }
      }
      if (cancellableActions.length > 0) {
        await client.query(`
          UPDATE action_runs
          SET state = 'cancelled', updated_at = now()
          WHERE id = ANY($1::uuid[])
        `, [cancellableActions.map((actionRun) => actionRun.id)]);
        for (const actionRun of cancellableActions) {
          await appendEvent(client, id, {
            type: "action.state.changed",
            actorType: input.event.actorType,
            actorId: input.event.actorId,
            entityType: "action",
            entityId: actionRun.id,
            summary: "Action Run cancelled before external write admission because its Goal Run was cancelled.",
            detail: {
              actionRunId: actionRun.id,
              planTaskId: actionRun.planTaskId,
              fromState: actionRun.state,
              toState: "cancelled",
              reason: "goal_cancelled"
            },
            ...(input.event.occurredAt ? { occurredAt: input.event.occurredAt } : {})
          });
        }
      }
      const result = await client.query<Record<string, unknown>>(`
        UPDATE goal_runs
        SET state = $2,
            paused_from_state = $3,
            terminal_reason = $4,
            usage = $5::jsonb,
            revision = revision + 1,
            updated_at = now()
        WHERE id = $1
        RETURNING ${goalRunColumns}
      `, [
        id,
        input.state,
        input.pausedFromState === undefined ? run.pausedFromState : input.pausedFromState,
        input.terminalReason === undefined ? run.terminalReason : input.terminalReason,
        JSON.stringify(input.usage ?? run.usage)
      ]);
      await appendEvent(client, id, input.event);
      const updated = goalRunFromRow(result.rows[0]!);
      await audit(client, "goal_run.state.changed", "goal_run", id, {
        state: updated.state,
        revision: updated.revision,
        terminalReason: updated.terminalReason,
        cancelledTaskCount: cancellableBindings.length,
        cancelledActionCount: cancellableActions.length
      });
      return updated;
    };
    return existingClient ? action(existingClient) : this.transaction(action);
  }

  async appendGoalEvent(id: string, input: AppendGoalEventInput): Promise<GoalEvent> {
    return this.transaction(async (client) => {
      await this.lockGoalRun(client, id);
      return appendEvent(client, id, input);
    });
  }

  async getGoalEvents(id: string, afterSequence = 0, limit = 500): Promise<GoalEvent[]> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new RangeError("Goal event sequence must be non-negative.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("Goal event limit must be between 1 and 500.");
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${eventColumns}
      FROM goal_events
      WHERE goal_run_id = $1 AND sequence > $2
      ORDER BY sequence
      LIMIT $3
    `, [id, afterSequence, limit]);
    if (result.rows.length === 0 && !(await this.getGoalRun(id))) throw new StoreNotFoundError("Goal Run was not found.");
    return result.rows.map(eventFromRow);
  }

  async updateGoalTaskBinding(id: string, input: GoalTaskBindingMutationInput): Promise<GoalTaskBinding> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<Record<string, unknown>>(`
        SELECT ${bindingColumns}
        FROM goal_task_bindings
        WHERE id = $1
        FOR UPDATE
      `, [id]);
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new StoreNotFoundError("Goal task binding was not found.");
      const current = bindingFromRow(currentRow);
      if (current.state !== input.expectedState) throw new StoreConflictError("Goal task binding state changed.", "revision", "GOAL_TASK_STATE_CONFLICT");
      const result = await client.query<Record<string, unknown>>(`
        UPDATE goal_task_bindings
        SET state = $2,
            active_job_id = $3,
            attempt_count = $4,
            task_id = $5,
            last_error = $6,
            updated_at = now()
        WHERE id = $1
        RETURNING ${bindingColumns}
      `, [
        id,
        input.state,
        input.activeJobId === undefined ? current.activeJobId : input.activeJobId,
        input.attemptCount === undefined ? current.attemptCount : input.attemptCount,
        input.taskId === undefined ? current.taskId : input.taskId,
        input.lastError === undefined ? current.lastError : input.lastError
      ]);
      await appendEvent(client, current.goalRunId, input.event);
      return bindingFromRow(result.rows[0]!);
    });
  }

  async claimGoalTaskDispatch(
    input: GoalTaskDispatchClaimInput,
    existingClient?: PoolClient
  ): Promise<GoalTaskDispatchClaimResult> {
    const occurredAt = input.now ?? new Date().toISOString();
    const now = Date.parse(occurredAt);
    if (!Number.isFinite(now)) throw new RangeError("Goal task dispatch claim time is invalid.");
    if (!Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 0) {
      throw new RangeError("Goal task dispatch attempt count is invalid.");
    }
    const increments = input.usageIncrements;
    if (Object.values(increments).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError("Goal task dispatch usage increments must be non-negative integers.");
    }
    const parsedActionRun = input.action ? actionRunSchema.parse(input.action.actionRun) : null;

    const claim = async (client: PoolClient): Promise<GoalTaskDispatchClaimResult> => {
      const goalRun = await this.lockGoalRun(client, input.goalRunId);
      if (goalRun.state !== "executing") {
        return { status: "contended", reason: "Goal Run is no longer executing." };
      }
      if (goalRun.activePlanRevision !== input.planRevision) {
        return { status: "contended", reason: "Goal Plan revision changed before task dispatch." };
      }
      if (!goalRun.executionContractId) {
        return { status: "rejected", reason: "Execution Contract is unavailable for task dispatch." };
      }
      const contractResult = await client.query<Record<string, unknown>>(`
        SELECT ${contractColumns}
        FROM execution_contracts
        WHERE id = $1
      `, [goalRun.executionContractId]);
      const contract = contractResult.rows[0] ? contractFromRow(contractResult.rows[0]) : null;
      if (!contract || contract.contractDigest !== input.contractDigest || contract.planRevision !== input.planRevision) {
        return { status: "rejected", reason: "Execution Contract identity changed before task dispatch." };
      }
      const contractTask = contract.planSnapshot.find((candidate) => candidate.id === input.planTaskId);
      if (!contractTask) {
        return { status: "rejected", reason: "Execution Contract task identity changed before dispatch." };
      }

      const bindingResult = await client.query<Record<string, unknown>>(`
        SELECT ${bindingColumns}
        FROM goal_task_bindings
        WHERE id = $1
        FOR UPDATE
      `, [input.bindingId]);
      const bindingRow = bindingResult.rows[0];
      if (!bindingRow) throw new StoreNotFoundError("Goal task binding was not found.");
      const binding = bindingFromRow(bindingRow);
      if (binding.goalRunId !== goalRun.id
        || binding.planRevision !== input.planRevision
        || binding.planTaskId !== input.planTaskId
        || binding.taskId !== input.taskId) {
        return { status: "rejected", reason: "Goal task binding identity changed before dispatch." };
      }
      if (binding.state !== "ready" || binding.attemptCount !== input.expectedAttemptCount) {
        return { status: "contended", reason: "Goal task dispatch was already claimed or superseded." };
      }
      if (binding.attemptCount >= goalRun.limits.maxAttemptsPerTask) {
        return { status: "rejected", reason: "Goal task exhausted its bounded execution attempts." };
      }
      const runningResult = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM goal_task_bindings
        WHERE goal_run_id = $1 AND plan_revision = $2 AND state = 'running'
      `, [goalRun.id, input.planRevision]);
      if ((runningResult.rows[0]?.count ?? 0) >= goalRun.limits.maxConcurrentTasks) {
        return { status: "contended", reason: "Goal task concurrency capacity is already occupied." };
      }
      const budgetReason = goalBudgetReservationFailureReason({
        limits: goalRun.limits,
        usage: goalRun.usage,
        increments,
        deadlineAt: goalRun.deadlineAt,
        now
      });
      if (budgetReason) return { status: "rejected", reason: budgetReason };

      let actionRun: ActionRun | null = null;
      let jobAdmission: GoalJobAdmission | null = null;
      if (input.action && parsedActionRun) {
        if (increments.actionCalls !== 1 || increments.taskAttempts !== 0 || increments.modelCalls !== 0) {
          return { status: "rejected", reason: "Action dispatch usage reservation is invalid." };
        }
        if (parsedActionRun.goalRunId !== goalRun.id
          || parsedActionRun.planTaskId !== binding.planTaskId
          || parsedActionRun.contractDigest !== contract.contractDigest
          || parsedActionRun.state !== "approved") {
          return { status: "rejected", reason: "Action Run identity is invalid for task dispatch." };
        }
        const approvedAction = contractTask.executionMode === "action" ? contractTask.action : null;
        const approvedBinding = contract.actionBindings.find((candidate) => candidate.planTaskId === contractTask.id);
        const expectedFingerprint = requestFingerprint({
          goalRunId: goalRun.id,
          planTaskId: contractTask.id,
          contractDigest: contract.contractDigest,
          adapterCatalogRevision: approvedBinding?.adapterCatalogRevision,
          action: approvedAction
        });
        if (!approvedAction || !approvedBinding
          || parsedActionRun.adapterId !== approvedAction.adapterId
          || parsedActionRun.adapterId !== approvedBinding.adapterId
          || parsedActionRun.adapterCatalogRevision !== approvedBinding.adapterCatalogRevision
          || parsedActionRun.actionKey !== approvedAction.actionKey
          || parsedActionRun.targetId !== approvedAction.targetId
          || requestFingerprint(parsedActionRun.inputs) !== requestFingerprint(approvedAction.inputs)
          || parsedActionRun.requestFingerprint !== expectedFingerprint) {
          return { status: "rejected", reason: "Action Run does not match the immutable Execution Contract snapshot." };
        }
        const adapterResult = await client.query<Record<string, unknown>>(`
          SELECT ${adapterColumns}
          FROM action_adapters
          WHERE id = $1
          FOR SHARE
        `, [parsedActionRun.adapterId]);
        const adapterRow = adapterResult.rows[0];
        const adapter = adapterRow ? adapterFromRow(adapterRow) : null;
        const catalogEntry = adapter?.actions.find((candidate) => (
          candidate.key === approvedAction.actionKey
          && candidate.targetIds.includes(approvedAction.targetId)
          && candidate.riskClass === approvedAction.riskClass
          && Object.keys(approvedAction.inputs).every((key) => candidate.inputKeys.includes(key))
        ));
        if (!adapter
          || !adapter.enabled
          || adapter.catalogRevision !== parsedActionRun.adapterCatalogRevision
          || adapter.credentialId !== approvedBinding.credentialId
          || actionAdapterEndpointDigest(adapter.baseUrl) !== approvedBinding.endpointDigest
          || !catalogEntry) {
          return { status: "rejected", reason: "Action Adapter is disabled or its catalog changed." };
        }
        const targetOccupiedResult = await client.query<{ occupied: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM goal_task_bindings binding
            JOIN action_runs action_run
              ON action_run.goal_run_id = binding.goal_run_id
             AND action_run.plan_task_id = binding.plan_task_id
             AND action_run.contract_digest = $4
            WHERE binding.goal_run_id = $1
              AND binding.plan_revision = $2
              AND binding.id <> $3
              AND binding.state = 'running'
              AND action_run.adapter_id = $5
              AND action_run.target_id = $6
          ) AS occupied
        `, [goalRun.id, input.planRevision, binding.id, contract.contractDigest, parsedActionRun.adapterId, parsedActionRun.targetId]);
        if (targetOccupiedResult.rows[0]?.occupied) {
          return { status: "contended", reason: "Another Action is already running against the same approved Adapter target." };
        }
        const requestedAdmission = input.action.jobAdmission;
        const expectedAdmissionFingerprint = [
          goalRun.id,
          binding.planTaskId,
          parsedActionRun.id,
          contract.contractDigest
        ].join(":");
        if (requestedAdmission.jobId !== input.jobId
          || requestedAdmission.goalRunId !== goalRun.id
          || requestedAdmission.jobName !== "goal-action-run"
          || requestedAdmission.entityId !== parsedActionRun.id
          || requestedAdmission.requestFingerprint !== expectedAdmissionFingerprint
          || requestedAdmission.state !== "reserved"
          || (requestedAdmission.dispatchToken ?? null) !== null
          || (requestedAdmission.dispatchLeaseExpiresAt ?? null) !== null) {
          return { status: "rejected", reason: "Goal Action job admission identity is invalid." };
        }
        const existingAdmissionResult = await client.query<Record<string, unknown>>(`
          SELECT ${admissionColumns}
          FROM goal_job_admissions
          WHERE job_id = $1
          FOR UPDATE
        `, [requestedAdmission.jobId]);
        const existingAdmission = existingAdmissionResult.rows[0]
          ? admissionFromRow(existingAdmissionResult.rows[0])
          : null;
        if (existingAdmission && (
          existingAdmission.goalRunId !== requestedAdmission.goalRunId
          || existingAdmission.jobName !== requestedAdmission.jobName
          || existingAdmission.entityId !== requestedAdmission.entityId
          || existingAdmission.requestFingerprint !== requestedAdmission.requestFingerprint
          || existingAdmission.state !== "reserved"
        )) {
          return { status: "rejected", reason: "Goal Action job admission is already bound to another execution." };
        }
        const existingActionResult = await client.query<Record<string, unknown>>(`
          SELECT ${actionRunColumns}
          FROM action_runs
          WHERE goal_run_id = $1 AND plan_task_id = $2 AND contract_digest = $3
          FOR UPDATE
        `, [goalRun.id, binding.planTaskId, contract.contractDigest]);
        const existingAction = existingActionResult.rows[0] ? actionRunFromRow(existingActionResult.rows[0]) : null;
        if (existingAction) {
          if (existingAction.id !== parsedActionRun.id
            || existingAction.requestFingerprint !== parsedActionRun.requestFingerprint
            || existingAction.contractDigest !== parsedActionRun.contractDigest
            || existingAction.state !== "approved") {
            return { status: "rejected", reason: "Existing Action Run does not match the approved dispatch request." };
          }
          actionRun = existingAction;
        } else {
          const insertedAction = await client.query<Record<string, unknown>>(`
            INSERT INTO action_runs(
              id, goal_run_id, plan_task_id, adapter_id, adapter_catalog_revision, action_key,
              target_id, inputs, state, request_fingerprint, contract_digest,
              external_execution_id, verification_summary, last_error, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16
            ) RETURNING ${actionRunColumns}
          `, [
            parsedActionRun.id, parsedActionRun.goalRunId, parsedActionRun.planTaskId,
            parsedActionRun.adapterId, parsedActionRun.adapterCatalogRevision, parsedActionRun.actionKey,
            parsedActionRun.targetId, JSON.stringify(parsedActionRun.inputs), parsedActionRun.state,
            parsedActionRun.requestFingerprint, parsedActionRun.contractDigest,
            parsedActionRun.externalExecutionId, parsedActionRun.verificationSummary, parsedActionRun.lastError,
            parsedActionRun.createdAt, parsedActionRun.updatedAt
          ]);
          actionRun = actionRunFromRow(insertedAction.rows[0]!);
          await appendEvent(client, goalRun.id, input.action.actionEvent);
        }
        if (existingAdmission) {
          jobAdmission = existingAdmission;
        } else {
          const insertedAdmission = await client.query<Record<string, unknown>>(`
            INSERT INTO goal_job_admissions(
              job_id, goal_run_id, job_name, entity_id, request_fingerprint, state,
              reserved_at, admitted_at, started_at, settled_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING ${admissionColumns}
          `, [
            requestedAdmission.jobId, requestedAdmission.goalRunId, requestedAdmission.jobName,
            requestedAdmission.entityId, requestedAdmission.requestFingerprint, requestedAdmission.state,
            requestedAdmission.reservedAt, requestedAdmission.admittedAt, requestedAdmission.startedAt,
            requestedAdmission.settledAt, requestedAdmission.updatedAt
          ]);
          jobAdmission = admissionFromRow(insertedAdmission.rows[0]!);
        }
      } else if (increments.taskAttempts !== 1
        || increments.modelCalls !== 1
        || increments.actionCalls !== 0
        || !input.taskId
        || !["worker", "advisor"].includes(contractTask.executionMode)
        || !contractTask.assigneeAgentId) {
        return { status: "rejected", reason: "Task Agent dispatch usage or canonical Task identity is invalid." };
      }

      const usage = {
        ...goalRun.usage,
        taskAttempts: goalRun.usage.taskAttempts + increments.taskAttempts,
        modelCalls: goalRun.usage.modelCalls + increments.modelCalls,
        actionCalls: goalRun.usage.actionCalls + increments.actionCalls
      };
      const updatedRunResult = await client.query<Record<string, unknown>>(`
        UPDATE goal_runs
        SET usage = $2::jsonb, revision = revision + 1, updated_at = $3
        WHERE id = $1
        RETURNING ${goalRunColumns}
      `, [goalRun.id, JSON.stringify(usage), occurredAt]);
      const updatedBindingResult = await client.query<Record<string, unknown>>(`
        UPDATE goal_task_bindings
        SET state = 'running', active_job_id = $2, attempt_count = $3, last_error = NULL, updated_at = $4
        WHERE id = $1
        RETURNING ${bindingColumns}
      `, [binding.id, input.jobId, binding.attemptCount + 1, occurredAt]);
      const updatedRun = goalRunFromRow(updatedRunResult.rows[0]!);
      const updatedBinding = bindingFromRow(updatedBindingResult.rows[0]!);
      await appendEvent(client, goalRun.id, input.budgetEvent);
      await appendEvent(client, goalRun.id, input.bindingEvent);
      await audit(client, "goal_task.dispatch.claimed", "goal_run", goalRun.id, {
        planRevision: input.planRevision,
        planTaskId: input.planTaskId,
        bindingId: binding.id,
        jobId: input.jobId,
        attemptCount: updatedBinding.attemptCount,
        usageIncrements: increments,
        actionRunId: actionRun?.id ?? null
      });
      return {
        status: "claimed",
        goalRun: updatedRun,
        taskBinding: updatedBinding,
        actionRun,
        jobAdmission
      };
    };
    return existingClient ? claim(existingClient) : this.transaction(claim);
  }

  async addReviewerVerdict(verdict: ReviewerVerdict, event: AppendGoalEventInput): Promise<ReviewerVerdict> {
    const parsed = reviewerVerdictSchema.parse(verdict);
    return this.transaction(async (client) => {
      if (parsed.reviewJobId !== null) {
        const admissionResult = await client.query<Record<string, unknown>>(`
          SELECT ${admissionColumns}
          FROM goal_job_admissions
          WHERE job_id = $1
          FOR SHARE
        `, [parsed.reviewJobId]);
        const admission = admissionResult.rows[0] ? admissionFromRow(admissionResult.rows[0]) : null;
        if (!admission
          || admission.goalRunId !== parsed.goalRunId
          || admission.jobName !== "goal-review"
          || admission.entityId !== `${parsed.scope}:${parsed.scopeId}:${parsed.reviewerAgentId}`
          || admission.requestFingerprint !== parsed.reviewRequestFingerprint) {
          throw new StoreConflictError("Reviewer verdict does not match its durable Goal Review admission.");
        }
      }
      const existingResult = await client.query<Record<string, unknown>>(`
        SELECT ${reviewColumns}
        FROM reviewer_verdicts
        WHERE goal_run_id = $1 AND scope = $2 AND scope_id = $3
          AND reviewer_agent_id = $4 AND contract_digest = $5
        FOR UPDATE
      `, [parsed.goalRunId, parsed.scope, parsed.scopeId, parsed.reviewerAgentId, parsed.contractDigest]);
      if (existingResult.rows[0]) {
        const existing = verdictFromRow(existingResult.rows[0]);
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new StoreConflictError("Reviewer already submitted a different verdict.");
        return existing;
      }
      await this.lockGoalRun(client, parsed.goalRunId);
      const result = await client.query<Record<string, unknown>>(`
        INSERT INTO reviewer_verdicts(
          id, goal_run_id, scope, scope_id, reviewer_agent_id, reviewer_agent_revision,
          model_connector_id, verdict, summary, evidence_ids, contract_digest,
          review_job_id, review_request_fingerprint, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
        RETURNING ${reviewColumns}
      `, [
        parsed.id, parsed.goalRunId, parsed.scope, parsed.scopeId, parsed.reviewerAgentId,
        parsed.reviewerAgentRevision, parsed.modelConnectorId, parsed.verdict, parsed.summary,
        JSON.stringify(parsed.evidenceIds), parsed.contractDigest, parsed.reviewJobId,
        parsed.reviewRequestFingerprint, parsed.createdAt
      ]);
      await appendEvent(client, parsed.goalRunId, event);
      await audit(client, "goal_review.recorded", "goal_run", parsed.goalRunId, {
        scope: parsed.scope,
        scopeId: parsed.scopeId,
        reviewerAgentId: parsed.reviewerAgentId,
        modelConnectorId: parsed.modelConnectorId,
        verdict: parsed.verdict,
        contractDigest: parsed.contractDigest,
        reviewJobId: parsed.reviewJobId
      });
      return verdictFromRow(result.rows[0]!);
    });
  }

  async createActionAdapter(adapter: ActionAdapter): Promise<ActionAdapter> {
    const parsed = actionAdapterSchema.parse(adapter);
    return this.transaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(`
        INSERT INTO action_adapters(
          id, name, kind, enabled, base_url, credential_id, catalog_revision, actions, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
        RETURNING ${adapterColumns}
      `, [
        parsed.id, parsed.name, parsed.kind, parsed.enabled, parsed.baseUrl, parsed.credentialId,
        parsed.catalogRevision, JSON.stringify(parsed.actions), parsed.createdAt, parsed.updatedAt
      ]);
      await audit(client, "action_adapter.created", "action_adapter", parsed.id, {
        kind: parsed.kind,
        enabled: parsed.enabled,
        catalogRevision: parsed.catalogRevision,
        actionCount: parsed.actions.length
      });
      return adapterFromRow(result.rows[0]!);
    });
  }

  async listActionAdapters(): Promise<ActionAdapter[]> {
    const result = await this.pool.query<Record<string, unknown>>(`SELECT ${adapterColumns} FROM action_adapters ORDER BY name, id`);
    return result.rows.map(adapterFromRow);
  }

  async createActionRun(run: ActionRun, event: AppendGoalEventInput): Promise<ActionRun> {
    const parsed = actionRunSchema.parse(run);
    return this.transaction(async (client) => {
      const adapterResult = await client.query<Record<string, unknown>>(`
        SELECT ${adapterColumns}
        FROM action_adapters
        WHERE id = $1
        FOR SHARE
      `, [parsed.adapterId]);
      const adapterRow = adapterResult.rows[0];
      if (!adapterRow) throw new StoreNotFoundError("Action Adapter was not found.");
      const adapter = adapterFromRow(adapterRow);
      if (!adapter.enabled || adapter.catalogRevision !== parsed.adapterCatalogRevision) {
        throw new StoreConflictError("Action Adapter is disabled or its catalog changed.");
      }
      const result = await client.query<Record<string, unknown>>(`
        INSERT INTO action_runs(
          id, goal_run_id, plan_task_id, adapter_id, adapter_catalog_revision, action_key,
          target_id, inputs, state, request_fingerprint, contract_digest,
          external_execution_id, verification_summary, last_error, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16
        ) RETURNING ${actionRunColumns}
      `, [
        parsed.id, parsed.goalRunId, parsed.planTaskId, parsed.adapterId, parsed.adapterCatalogRevision,
        parsed.actionKey, parsed.targetId, JSON.stringify(parsed.inputs), parsed.state,
        parsed.requestFingerprint, parsed.contractDigest, parsed.externalExecutionId,
        parsed.verificationSummary, parsed.lastError, parsed.createdAt, parsed.updatedAt
      ]);
      await appendEvent(client, parsed.goalRunId, event);
      return actionRunFromRow(result.rows[0]!);
    });
  }

  async updateActionRun(id: string, input: ActionRunMutationInput): Promise<ActionRun> {
    return this.transaction(async (client) => {
      const currentResult = await client.query<Record<string, unknown>>(`
        SELECT ${actionRunColumns}
        FROM action_runs
        WHERE id = $1
        FOR UPDATE
      `, [id]);
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new StoreNotFoundError("Action Run was not found.");
      const current = actionRunFromRow(currentRow);
      if (current.state !== input.expectedState) throw new StoreConflictError("Action Run state changed.", "revision", "ACTION_RUN_STATE_CONFLICT");
      const result = await client.query<Record<string, unknown>>(`
        UPDATE action_runs
        SET state = $2,
            external_execution_id = $3,
            verification_summary = $4,
            last_error = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING ${actionRunColumns}
      `, [
        id,
        input.state,
        input.externalExecutionId === undefined ? current.externalExecutionId : input.externalExecutionId,
        input.verificationSummary === undefined ? current.verificationSummary : input.verificationSummary,
        input.lastError === undefined ? current.lastError : input.lastError
      ]);
      await appendEvent(client, current.goalRunId, input.event);
      return actionRunFromRow(result.rows[0]!);
    });
  }

  async admitGoalActionExecution(
    id: string,
    input: GoalActionExecutionAdmissionInput,
    existingClient?: PoolClient
  ): Promise<GoalActionExecutionAdmissionResult> {
    const admit = async (client: PoolClient): Promise<GoalActionExecutionAdmissionResult> => {
      const goalRun = await this.lockGoalRun(client, input.goalRunId);
      const now = Date.parse(input.now ?? new Date().toISOString());
      if (!Number.isFinite(now)) throw new RangeError("Goal Action admission time is invalid.");
      const actionResult = await client.query<Record<string, unknown>>(`
        SELECT ${actionRunColumns}
        FROM action_runs
        WHERE id = $1
        FOR UPDATE
      `, [id]);
      const actionRow = actionResult.rows[0];
      if (!actionRow) throw new StoreNotFoundError("Action Run was not found.");
      const actionRun = actionRunFromRow(actionRow);
      if (actionRun.goalRunId !== goalRun.id || actionRun.planTaskId !== input.planTaskId) {
        return { status: "rejected", reason: "Action Run identity no longer matches the queued Goal task." };
      }
      if (goalRun.state !== "executing") {
        return { status: "rejected", reason: "Goal Run is not executing." };
      }
      const budgetReason = goalBudgetFailureReason({
        limits: goalRun.limits,
        usage: goalRun.usage,
        deadlineAt: goalRun.deadlineAt,
        now
      });
      if (budgetReason) return { status: "rejected", reason: budgetReason };
      if (!goalRun.executionContractId) {
        return { status: "rejected", reason: "Execution Contract identity changed before Action admission." };
      }
      const contractResult = await client.query<Record<string, unknown>>(`
        SELECT ${contractColumns}
        FROM execution_contracts
        WHERE id = $1
      `, [goalRun.executionContractId]);
      const contract = contractResult.rows[0] ? contractFromRow(contractResult.rows[0]) : null;
      if (!contract || contract.contractDigest !== input.contractDigest || actionRun.contractDigest !== input.contractDigest) {
        return { status: "rejected", reason: "Execution Contract identity changed before Action admission." };
      }
      const contractTask = contract.planSnapshot.find((candidate) => candidate.id === input.planTaskId);
      const approvedAction = contractTask?.executionMode === "action" ? contractTask.action : null;
      const approvedBinding = contract.actionBindings.find((candidate) => candidate.planTaskId === input.planTaskId);
      const expectedFingerprint = requestFingerprint({
        goalRunId: goalRun.id,
        planTaskId: input.planTaskId,
        contractDigest: contract.contractDigest,
        adapterCatalogRevision: approvedBinding?.adapterCatalogRevision,
        action: approvedAction
      });
      const adapterResult = approvedAction ? await client.query<Record<string, unknown>>(`
        SELECT ${adapterColumns}
        FROM action_adapters
        WHERE id = $1
        FOR SHARE
      `, [approvedAction.adapterId]) : { rows: [] };
      const adapter = adapterResult.rows[0] ? adapterFromRow(adapterResult.rows[0]) : null;
      const catalogEntry = adapter && approvedAction ? adapter.actions.find((candidate) => (
        candidate.key === approvedAction.actionKey
        && candidate.targetIds.includes(approvedAction.targetId)
        && candidate.riskClass === approvedAction.riskClass
        && Object.keys(approvedAction.inputs).every((key) => candidate.inputKeys.includes(key))
      )) : null;
      let credentialMatches = approvedBinding?.credentialId === null
        && adapter?.credentialId === null
        && approvedBinding.credentialSecretRevision === null;
      if (approvedBinding?.credentialId) {
        const credentialResult = await client.query<{ matches: boolean }>(`
          SELECT EXISTS (
            SELECT 1
            FROM (
              SELECT state
              FROM platform_state
              WHERE singleton_id = 1
              FOR SHARE
            ) AS platform_state,
                 jsonb_array_elements(COALESCE(state->'credentials', '[]'::jsonb)) AS credential
            WHERE credential->>'id' = $1
              AND credential->>'status' = 'active'
              AND credential->>'hasSecret' = 'true'
              AND (credential->>'secretRevision')::int = $2
              AND (
                credential->>'expiresAt' IS NULL
                OR (credential->>'expiresAt')::timestamptz > $3::timestamptz
              )
          ) AS matches
        `, [approvedBinding.credentialId, approvedBinding.credentialSecretRevision, new Date(now).toISOString()]);
        credentialMatches = credentialResult.rows[0]?.matches === true;
      }
      if (!approvedAction || !approvedBinding || !adapter || !adapter.enabled || !catalogEntry
        || actionRun.adapterId !== approvedAction.adapterId
        || actionRun.adapterId !== approvedBinding.adapterId
        || actionRun.adapterCatalogRevision !== approvedBinding.adapterCatalogRevision
        || actionRun.actionKey !== approvedAction.actionKey
        || actionRun.targetId !== approvedAction.targetId
        || requestFingerprint(actionRun.inputs) !== requestFingerprint(approvedAction.inputs)
        || actionRun.requestFingerprint !== expectedFingerprint
        || adapter.catalogRevision !== approvedBinding.adapterCatalogRevision
        || adapter.credentialId !== approvedBinding.credentialId
        || actionAdapterEndpointDigest(adapter.baseUrl) !== approvedBinding.endpointDigest
        || !credentialMatches) {
        return { status: "rejected", reason: "Action Run no longer matches the immutable Execution Contract and Adapter binding." };
      }
      const bindingResult = await client.query<Record<string, unknown>>(`
        SELECT ${bindingColumns}
        FROM goal_task_bindings
        WHERE goal_run_id = $1 AND plan_revision = $2 AND plan_task_id = $3
        FOR UPDATE
      `, [goalRun.id, goalRun.activePlanRevision, input.planTaskId]);
      const bindingRow = bindingResult.rows[0];
      if (!bindingRow) return { status: "rejected", reason: "Goal task binding is unavailable for Action admission." };
      let binding = bindingFromRow(bindingRow);
      const actionStateEligible = input.phase === "preview"
        ? actionRun.state === "approved" || actionRun.state === "reserved"
        : actionRun.state === "reserved";
      if (!actionStateEligible) {
        return { status: "rejected", reason: `Action Run is not eligible for ${input.phase} admission.` };
      }
      if (input.phase === "preview") {
        if (binding.state === "ready") {
          const updatedBinding = await client.query<Record<string, unknown>>(`
            UPDATE goal_task_bindings
            SET state = 'running', active_job_id = $2, updated_at = $3
            WHERE id = $1
            RETURNING ${bindingColumns}
          `, [binding.id, input.jobId, new Date(now).toISOString()]);
          binding = bindingFromRow(updatedBinding.rows[0]!);
          await appendEvent(client, goalRun.id, input.bindingEvent);
        } else if (binding.state !== "running" || binding.activeJobId !== input.jobId) {
          return { status: "rejected", reason: "Action task is not owned by the queued Goal job." };
        }
      } else if (binding.state !== "running" || binding.activeJobId !== input.jobId) {
        return { status: "rejected", reason: "Action task execution ownership changed before the external effect boundary." };
      }

      const actionNeedsTransition = input.phase === "execute" || actionRun.state === "approved";
      let updatedActionRun = actionRun;
      if (actionNeedsTransition) {
        const updatedActionResult = await client.query<Record<string, unknown>>(`
          UPDATE action_runs
          SET state = $2, updated_at = $3
          WHERE id = $1
          RETURNING ${actionRunColumns}
        `, [id, input.phase === "preview" ? "reserved" : "running", new Date(now).toISOString()]);
        updatedActionRun = actionRunFromRow(updatedActionResult.rows[0]!);
        await appendEvent(client, goalRun.id, input.event);
        await audit(client, "goal_action.execution.admitted", "action_run", id, {
          goalRunId: goalRun.id,
          planTaskId: input.planTaskId,
          jobId: input.jobId,
          phase: input.phase,
          contractDigest: input.contractDigest
        });
      }
      return { status: "admitted", actionRun: updatedActionRun, taskBinding: binding };
    };
    return existingClient ? admit(existingClient) : this.transaction(admit);
  }

  async reserveGoalJob(admission: GoalJobAdmission, existingClient?: PoolClient): Promise<GoalJobAdmission> {
    if (admission.state === "dispatching") {
      throw new StoreConflictError("Goal job dispatching state must be entered through a dispatch lease claim.");
    }
    if ((admission.dispatchToken ?? null) !== null || (admission.dispatchLeaseExpiresAt ?? null) !== null) {
      throw new StoreConflictError("Goal job dispatch lease fields require dispatching state.");
    }
    const action = async (client: PoolClient): Promise<GoalJobAdmission> => {
      const existingResult = await client.query<Record<string, unknown>>(`
        SELECT ${admissionColumns}
        FROM goal_job_admissions
        WHERE job_id = $1
        FOR UPDATE
      `, [admission.jobId]);
      if (existingResult.rows[0]) {
        const existing = admissionFromRow(existingResult.rows[0]);
        if (existing.goalRunId !== admission.goalRunId
          || existing.jobName !== admission.jobName
          || existing.entityId !== admission.entityId
          || existing.requestFingerprint !== admission.requestFingerprint) {
          throw new StoreConflictError("Goal job ID is already bound to another request.");
        }
        return existing;
      }
      const result = await client.query<Record<string, unknown>>(`
        INSERT INTO goal_job_admissions(
          job_id, goal_run_id, job_name, entity_id, request_fingerprint, state,
          dispatch_token, dispatch_lease_expires_at,
          reserved_at, admitted_at, started_at, settled_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING ${admissionColumns}
      `, [
        admission.jobId, admission.goalRunId, admission.jobName, admission.entityId,
        admission.requestFingerprint, admission.state, null, null, admission.reservedAt, admission.admittedAt,
        admission.startedAt, admission.settledAt, admission.updatedAt
      ]);
      return admissionFromRow(result.rows[0]!);
    };
    return existingClient ? action(existingClient) : this.transaction(action);
  }

  async reserveGoalReviewJob(admission: GoalJobAdmission, data: GoalReviewJobData): Promise<GoalJobAdmission> {
    const parsed = assertGoalReviewJobAdmission(admission, data);
    if (admission.state === "dispatching") {
      throw new StoreConflictError("Goal job dispatching state must be entered through a dispatch lease claim.");
    }
    if ((admission.dispatchToken ?? null) !== null || (admission.dispatchLeaseExpiresAt ?? null) !== null) {
      throw new StoreConflictError("Goal job dispatch lease fields require dispatching state.");
    }
    const normalized = normalizeGoalJobAdmission(admission);
    return this.transaction(async (client) => {
      await this.lockGoalRun(client, admission.goalRunId);
      const admissionResult = await client.query<Record<string, unknown>>(`
        SELECT ${admissionColumns}
        FROM goal_job_admissions
        WHERE job_id = $1
        FOR UPDATE
      `, [admission.jobId]);
      const existingRow = admissionResult.rows[0];
      if (existingRow) {
        const existing = admissionFromRow(existingRow);
        const bindingResult = await client.query<Record<string, unknown>>(`
          SELECT goal_run_id AS "goalRunId", job_data AS "jobData", request_fingerprint AS "requestFingerprint"
          FROM goal_review_job_bindings
          WHERE job_id = $1
          FOR UPDATE
        `, [admission.jobId]);
        const binding = bindingResult.rows[0];
        const stored = binding ? goalReviewJobDataSchema.safeParse(binding.jobData) : null;
        if (!binding || !stored?.success
          || binding.goalRunId !== parsed.goalRunId
          || binding.requestFingerprint !== normalized.requestFingerprint
          || existing.goalRunId !== normalized.goalRunId
          || existing.jobName !== normalized.jobName
          || existing.entityId !== normalized.entityId
          || existing.requestFingerprint !== normalized.requestFingerprint
          || !isDeepStrictEqual(stored.data, parsed)) {
          throw new StoreConflictError("Goal Review job ID is already bound to another request.");
        }
        return existing;
      }
      const inserted = await client.query<Record<string, unknown>>(`
        INSERT INTO goal_job_admissions(
          job_id, goal_run_id, job_name, entity_id, request_fingerprint, state,
          dispatch_token, dispatch_lease_expires_at,
          reserved_at, admitted_at, started_at, settled_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8, $9, $10, $11)
        RETURNING ${admissionColumns}
      `, [
        normalized.jobId, normalized.goalRunId, normalized.jobName, normalized.entityId,
        normalized.requestFingerprint, normalized.state, normalized.reservedAt, normalized.admittedAt,
        normalized.startedAt, normalized.settledAt, normalized.updatedAt
      ]);
      await client.query(`
        INSERT INTO goal_review_job_bindings(job_id, goal_run_id, job_data, request_fingerprint)
        VALUES ($1, $2, $3::jsonb, $4)
      `, [normalized.jobId, parsed.goalRunId, JSON.stringify(parsed), normalized.requestFingerprint]);
      return admissionFromRow(inserted.rows[0]!);
    });
  }

  async getGoalJobAdmission(jobId: string): Promise<GoalJobAdmission | null> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${admissionColumns}
      FROM goal_job_admissions
      WHERE job_id = $1
    `, [jobId]);
    return result.rows[0] ? admissionFromRow(result.rows[0]) : null;
  }

  async getGoalReviewJobData(jobId: string): Promise<GoalReviewJobData | null> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${reviewAdmissionColumns},
             binding.goal_run_id AS "bindingGoalRunId",
             binding.job_data AS "jobData",
             binding.request_fingerprint AS "bindingRequestFingerprint"
      FROM goal_review_job_bindings AS binding
      INNER JOIN goal_job_admissions AS admission ON admission.job_id = binding.job_id
      WHERE binding.job_id = $1
    `, [jobId]);
    const row = result.rows[0];
    if (!row) return null;
    const admission = admissionFromRow(row);
    const parsed = goalReviewJobDataSchema.safeParse(row.jobData);
    if (!parsed.success
      || admission.jobName !== "goal-review"
      || row.bindingGoalRunId !== admission.goalRunId
      || row.bindingRequestFingerprint !== admission.requestFingerprint) {
      throw new StoreConflictError("Goal Review job binding is invalid.");
    }
    assertGoalReviewJobAdmission(admission, parsed.data);
    return structuredClone(parsed.data);
  }

  async claimGoalJobDispatch(
    jobId: string,
    input: GoalJobDispatchClaimInput
  ): Promise<GoalJobDispatchClaimResult> {
    const claim = normalizeGoalJobDispatchClaimInput(input);
    return this.transaction(async (client) => {
      const currentResult = await client.query<Record<string, unknown>>(`
        SELECT ${admissionColumns}
        FROM goal_job_admissions
        WHERE job_id = $1
        FOR UPDATE
      `, [jobId]);
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new StoreNotFoundError("Goal job admission was not found.");
      const current = admissionFromRow(currentRow);

      if (current.state === "outcome_unknown") {
        throw new StoreConflictError("Goal job outcome is unknown; dispatch fails closed.");
      }
      if (current.state === "admitted" || current.state === "running" || current.state === "settled") {
        return { status: "already_dispatched", admission: current };
      }
      if (current.state === "dispatching") {
        if (!current.dispatchToken || !current.dispatchLeaseExpiresAt
          || !Number.isFinite(Date.parse(current.dispatchLeaseExpiresAt))) {
          throw new StoreConflictError("Goal job dispatch lease state is invalid.");
        }
        if (current.dispatchToken === claim.dispatchToken) {
          return { status: "claimed", admission: current };
        }
        if (Date.parse(current.dispatchLeaseExpiresAt) > Date.parse(claim.now)) {
          return { status: "contended", admission: current };
        }
      }

      const result = await client.query<Record<string, unknown>>(`
        UPDATE goal_job_admissions
        SET state = 'dispatching',
            dispatch_token = $2,
            dispatch_lease_expires_at = $3,
            admitted_at = NULL,
            started_at = NULL,
            settled_at = NULL,
            updated_at = $4
        WHERE job_id = $1
        RETURNING ${admissionColumns}
      `, [jobId, claim.dispatchToken, claim.leaseExpiresAt, claim.now]);
      return { status: "claimed", admission: admissionFromRow(result.rows[0]!) };
    });
  }

  async completeGoalJobDispatch(jobId: string, dispatchToken: string): Promise<GoalJobAdmission> {
    const validatedToken = validateGoalJobDispatchToken(dispatchToken);
    return this.transaction(async (client) => {
      const currentResult = await client.query<Record<string, unknown>>(`
        SELECT ${admissionColumns}
        FROM goal_job_admissions
        WHERE job_id = $1
        FOR UPDATE
      `, [jobId]);
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new StoreNotFoundError("Goal job admission was not found.");
      const current = admissionFromRow(currentRow);

      if (current.state === "admitted" || current.state === "running" || current.state === "settled") {
        return current;
      }
      if (current.state === "reserved") {
        throw new StoreConflictError("Reserved Goal job dispatch has not been claimed.");
      }
      if (current.state === "outcome_unknown") {
        throw new StoreConflictError("Goal job outcome is unknown; dispatch completion fails closed.");
      }
      if (current.dispatchToken !== validatedToken) {
        throw new StoreConflictError("Goal job dispatch token does not own the active lease.");
      }
      const now = new Date().toISOString();
      const result = await client.query<Record<string, unknown>>(`
        UPDATE goal_job_admissions
        SET state = 'admitted',
            dispatch_token = NULL,
            dispatch_lease_expires_at = NULL,
            admitted_at = $2,
            updated_at = $2
        WHERE job_id = $1
        RETURNING ${admissionColumns}
      `, [jobId, now]);
      return admissionFromRow(result.rows[0]!);
    });
  }

  async setGoalJobState(
    jobId: string,
    expectedState: GoalJobAdmissionState,
    state: GoalJobAdmissionState
  ): Promise<GoalJobAdmission> {
    if (expectedState === "dispatching" || state === "dispatching") {
      throw new StoreConflictError("Goal job dispatch lease transitions require the dispatch lease methods.");
    }
    return this.transaction(async (client) => {
      const currentResult = await client.query<Record<string, unknown>>(`
        SELECT ${admissionColumns}
        FROM goal_job_admissions
        WHERE job_id = $1
        FOR UPDATE
      `, [jobId]);
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new StoreNotFoundError("Goal job admission was not found.");
      const current = admissionFromRow(currentRow);
      if (current.state !== expectedState) throw new StoreConflictError("Goal job admission state changed.", "revision");
      const now = new Date().toISOString();
      const result = await client.query<Record<string, unknown>>(`
        UPDATE goal_job_admissions
        SET state = $2,
            admitted_at = $3,
            started_at = $4,
            settled_at = $5,
            updated_at = $6
        WHERE job_id = $1
        RETURNING ${admissionColumns}
      `, [
        jobId,
        state,
        state === "admitted" ? now : current.admittedAt,
        state === "running" ? now : current.startedAt,
        state === "settled" || state === "outcome_unknown" ? now : current.settledAt,
        now
      ]);
      return admissionFromRow(result.rows[0]!);
    });
  }

  async getRecoverableGoalJobs(): Promise<GoalJobAdmission[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT ${admissionColumns}
      FROM goal_job_admissions
      WHERE state IN ('reserved', 'dispatching', 'admitted', 'running')
         OR (state = 'outcome_unknown' AND job_name = 'goal-review')
      ORDER BY updated_at, job_id
    `);
    return result.rows.map(admissionFromRow);
  }

  private async loadDetail(client: PoolClient, id: string): Promise<GoalRunDetail | null> {
    const runResult = await client.query<Record<string, unknown>>(`SELECT ${goalRunColumns} FROM goal_runs WHERE id = $1`, [id]);
    const runRow = runResult.rows[0];
    if (!runRow) return null;
    const goalRun = goalRunFromRow(runRow);
    const plans = await client.query<Record<string, unknown>>(
      `SELECT ${planColumns} FROM goal_plan_revisions WHERE goal_run_id = $1 ORDER BY revision`,
      [id]
    );
    const bindings = await client.query<Record<string, unknown>>(
      `SELECT ${bindingColumns} FROM goal_task_bindings WHERE goal_run_id = $1 ORDER BY plan_revision, created_at, id`,
      [id]
    );
    const events = await client.query<Record<string, unknown>>(
      `SELECT ${eventColumns} FROM goal_events WHERE goal_run_id = $1 ORDER BY sequence`,
      [id]
    );
    const verdicts = await client.query<Record<string, unknown>>(
      `SELECT ${reviewColumns} FROM reviewer_verdicts WHERE goal_run_id = $1 ORDER BY created_at, id`,
      [id]
    );
    const actionRuns = await client.query<Record<string, unknown>>(
      `SELECT ${actionRunColumns} FROM action_runs WHERE goal_run_id = $1 ORDER BY created_at, id`,
      [id]
    );
    let executionContract: ExecutionContract | null = null;
    if (goalRun.executionContractId) {
      const result = await client.query<Record<string, unknown>>(`SELECT ${contractColumns} FROM execution_contracts WHERE id = $1`, [goalRun.executionContractId]);
      if (!result.rows[0]) throw new Error("Goal Run references a missing Execution Contract.");
      executionContract = contractFromRow(result.rows[0]);
    }
    return {
      goalRun,
      plans: plans.rows.map(planFromRow),
      executionContract,
      taskBindings: bindings.rows.map(bindingFromRow),
      events: events.rows.map(eventFromRow),
      reviewerVerdicts: verdicts.rows.map(verdictFromRow),
      actionRuns: actionRuns.rows.map(actionRunFromRow)
    };
  }

  private async lockGoalRun(client: PoolClient, id: string): Promise<GoalRun> {
    const result = await client.query<Record<string, unknown>>(`SELECT ${goalRunColumns} FROM goal_runs WHERE id = $1 FOR UPDATE`, [id]);
    if (!result.rows[0]) throw new StoreNotFoundError("Goal Run was not found.");
    return goalRunFromRow(result.rows[0]);
  }

  private assertRevision(run: GoalRun, expectedRevision: number): void {
    if (run.revision !== expectedRevision) {
      throw new StoreConflictError("Goal Run revision changed.", "revision", "GOAL_RUN_REVISION_CONFLICT");
    }
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
