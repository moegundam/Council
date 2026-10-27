import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AddTaskEvidenceInput,
  ApproveToolPackInput,
  ApplyChairSuggestedRoleInput,
  AdvanceMeetingAgendaInput,
  Agent,
  AgentReadiness,
  AgentRevision,
  AgentTeam,
  AgentTurnJobData,
  Category,
  ChairAutomationJobAdmission,
  ChairAutomationJobReconciliationReason,
  ChairSuggestion,
  ChairSuggestionRecord,
  CreateAgentInput,
  CreateAgentTeamInput,
  CreateCategoryInput,
  CreateDecisionInput,
  CreateGroupInput,
  CreateMeetingInput,
  CreateMeetingPresetInput,
  CreatePromptInput,
  CreateRoleInput,
  CreateRuntimeProfileInput,
  CreateSkillInput,
  CreateTagInput,
  CreateToolPackInput,
  UpdateCategoryInput,
  UpdateGroupInput,
  CreateTaskInput,
  CreateThreadInput,
  CreateUtteranceInput,
  Credential,
  Decision,
  DiscussionGroup,
  DiscussionThread,
  GoalEvent,
  GoalReviewJobData,
  GoalRun,
  GoalTaskBinding,
  ReviewerVerdict,
  ActionAdapter,
  ActionRun,
  McpConnector,
  McpConnectorUpdateResult,
  Meeting,
  MeetingRecord,
  MeetingViewSnapshot,
  MeetingPreset,
  MeetingSummaryState,
  MeetingState,
  ModelConnector,
  ModelConnectorUpdateResult,
  MoveTaskInput,
  ParticipantAssignment,
  PlatformSnapshot,
  PlatformViewName,
  PublishAgentInput,
  PublishPromptInput,
  PromptTemplate,
  PromptVersion,
  Role,
  RoleDeletionResult,
  RoleLifecycleView,
  RoleVersion,
  RuntimeProfile,
  RuntimeProfileRevision,
  RuntimeRun,
  RuntimeRunEvent,
  RollbackAgentInput,
  RollbackPromptInput,
  ArchivePromptInput,
  SetAgentModelInput,
  SetAgentStatusInput,
  SetMeetingAgendaInput,
  SetMeetingAutomationInput,
  SetMeetingModeInput,
  SetTaskApprovalInput,
  SpeakerQueueItem,
  SetSkillStatusInput,
  Skill,
  SkillRevocationResult,
  Task,
  TaskAgentRunJobData,
  TaskSyncRequestInput,
  TaskAdapterConnector,
  Tag,
  ToolPack,
  ToolPackRevision,
  UpdateAgentInput,
  UpdateAgentTeamInput,
  UpdateMeetingPresetInput,
  UpdatePromptInput,
  UpdateCredentialStatusInput,
  UpdateRuntimeProfileInput,
  UpdateTagInput,
  UpdateThreadInput,
  UpdateRoleInput,
  UpdateTaskInput,
  UpdateToolPackInput,
  SwitchParticipantRoleInput,
  ValidateSkillInput,
  ValidateToolPackInput,
  RevokeSkillInput,
  RevokeToolPackInput,
  Utterance
} from "@council/contracts";
import {
  meetingViewCollectionNames,
  platformSnapshotCollectionNames,
  platformSnapshotSourceCollectionNames,
  platformViewSourceCollectionNames,
  projectMeetingView,
  projectPlatformView,
  type PlatformSnapshotCollectionName
} from "@council/domain/platform-views";
import {
  agentRevisionSchema,
  meetingRecordSchema,
  promptVersionSchema,
  roleVersionSchema,
  runtimeProfileRevisionSchema,
  runtimeProfileSchema,
  toolPackRevisionSchema,
  toolPackSchema
} from "@council/contracts";
import type { ExternalExecution } from "@council/domain";
import type { Pool, PoolClient } from "pg";
import { InMemoryPlatformStore } from "./memory-store.js";
import { agentRevisionContentDigestIsValid } from "./agent-revision-governance.js";
import { toolPackManifestDigestIsValid } from "./tool-pack-governance.js";
import {
  externalExecutionStartFingerprint,
  externalExecutionStartOperation,
  assertGoalPlanDecisionBindings,
  canonicalTaskMatchesGoalDispatch,
  goalPlanTaskCreateInput,
  isMeetingSummaryUtterance,
  meetingStateAuditEvent,
  parseExternalExecutionStartEnvelope,
  requestFingerprint,
  taskChangedFields,
  utteranceReplayMatches,
  StoreConflictError,
  StoreNotFoundError,
  type AgentTurnCommitInput,
  type AgentTurnCommitResult,
  type AgentTurnFailureCommitInput,
  type AgentTurnFailureCommitResult,
  type ApplyChairAutomationInput,
  type ApplyChairAutomationResult,
  type ChairAutomationJobAdmissionMutationResult,
  type ChairSuggestionCreateResult,
  type ChairSuggestionPolicyBinding,
  type ChairSuggestionMutationResult,
  type ChairSuggestionRoleApplyResult,
  type ActionRunMutationInput,
  type AppendGoalEventInput,
  type AppendRuntimeRunEventInput,
  type CreateCredentialMetadataInput,
  type CreateModelConnectorStateInput,
  type CreateMcpConnectorStateInput,
  type CreateTaskAdapterConnectorStateInput,
  type ExternalExecutionStartAdmission,
  type ExternalExecutionStartEnvelope,
  type ExternalExecutionStartRequest,
  type GoalActionExecutionAdmissionInput,
  type GoalActionExecutionAdmissionResult,
  type GoalApprovalMutationInput,
  type GoalJobAdmission,
  type GoalJobAdmissionState,
  type GoalJobDispatchClaimInput,
  type GoalJobDispatchClaimResult,
  type GoalPlanMutationInput,
  type GoalRunDetail,
  type GoalRunStateMutationInput,
  type GoalTaskDispatchClaimInput,
  type GoalTaskDispatchClaimResult,
  type GoalTaskBindingMutationInput,
  type MeetingSummaryCommitInput,
  type MeetingSummaryCommitResult,
  type MeetingUtterancePage,
  type MeetingUtterancePageInput,
  type MeetingModeChangeResult,
  type McpToolCallAdmissionInput,
  type McpToolCallAdmissionResult,
  type McpToolCallReservationInput,
  type McpToolRunCommitInput,
  type McpToolRunCommitResult,
  type OwnerUser,
  type PlatformStore,
  type RuntimeRunHeartbeatInput,
  type RuntimeRunMutationInput,
  type SecretInput,
  credentialCreateIdempotencyInput,
  credentialRotationIdempotencyInput,
  mcpConnectorCreateIdempotencyInput,
  modelConnectorCreateIdempotencyInput,
  taskAdapterConnectorCreateIdempotencyInput,
  type SessionRecord,
  type TaskAgentCompletionUsage,
  type TaskAgentRunFailureBinding,
  type TaskExecutionMutationResult,
  type TaskSyncFailureBinding,
  type TaskSyncMutationResult,
  type RotateCredentialMetadataInput,
  type UpdateCredentialMetadataInput,
  type UpdateMcpConnectorStateInput,
  type UpdateModelConnectorStateInput,
  type UtteranceCreateResult
} from "./store.js";
import { PostgresGoalRunRepository } from "./goal-run-postgres.js";
import { PostgresRuntimeRunRepository } from "./runtime-run-postgres.js";
import {
  decodeMeetingUtteranceCursor,
  encodeMeetingUtteranceCursor,
  MeetingUtteranceCursorError
} from "./meeting-utterance-pagination.js";

interface ChairAutomationJobAdmissionRow {
  chairSuggestionId: string;
  meetingId: string;
  jobId: string;
  automationRevision: number;
  status: ChairAutomationJobAdmission["status"];
  reservedAt: string | Date;
  admittedAt: string | Date | null;
  reconciliationRequiredAt: string | Date | null;
  reconciliationReason: ChairAutomationJobAdmission["reconciliationReason"];
  updatedAt: string | Date;
}

function admissionTimestamp(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

interface MeetingRecordRow {
  meetingId: string;
  revision: number;
  closedAt: string | Date;
  generatedAt: string | Date;
  generationMode: MeetingRecord["generationMode"];
  content: unknown;
  sourceDigest: string;
  createdBy: MeetingRecord["createdBy"];
}

const meetingRecordColumns = `
  meeting_id AS "meetingId",
  revision,
  closed_at AS "closedAt",
  generated_at AS "generatedAt",
  generation_mode AS "generationMode",
  content,
  source_digest AS "sourceDigest",
  created_by AS "createdBy"
`;

function meetingRecordFromRow(row: MeetingRecordRow): MeetingRecord {
  return meetingRecordSchema.parse({
    ...row,
    closedAt: admissionTimestamp(row.closedAt),
    generatedAt: admissionTimestamp(row.generatedAt)
  });
}

function chairAutomationJobAdmissionFromRow(
  row: ChairAutomationJobAdmissionRow
): ChairAutomationJobAdmission {
  return {
    ...row,
    reservedAt: admissionTimestamp(row.reservedAt),
    admittedAt: row.admittedAt === null ? null : admissionTimestamp(row.admittedAt),
    reconciliationRequiredAt: row.reconciliationRequiredAt === null
      ? null
      : admissionTimestamp(row.reconciliationRequiredAt),
    updatedAt: admissionTimestamp(row.updatedAt)
  };
}

const chairAutomationJobAdmissionColumns = `
  chair_suggestion_id AS "chairSuggestionId",
  meeting_id AS "meetingId",
  job_id AS "jobId",
  automation_revision AS "automationRevision",
  status,
  reserved_at AS "reservedAt",
  admitted_at AS "admittedAt",
  reconciliation_required_at AS "reconciliationRequiredAt",
  reconciliation_reason AS "reconciliationReason",
  updated_at AS "updatedAt"
`;

export class PostgresPlatformStore implements PlatformStore {
  private readonly goals: PostgresGoalRunRepository;
  private readonly runtimeRuns: PostgresRuntimeRunRepository;

  constructor(private readonly pool: Pool) {
    this.goals = new PostgresGoalRunRepository(pool);
    this.runtimeRuns = new PostgresRuntimeRunRepository(pool);
  }

  async checkHealth(): Promise<void> {
    const result = await this.pool.query<{ initialized: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM platform_state WHERE singleton_id = 1) AS initialized"
    );
    if (result.rows[0]?.initialized !== true) {
      throw new Error("Platform database is not initialized.");
    }
  }

  async getSnapshot(): Promise<PlatformSnapshot> {
    return this.repeatableRead(async (client) => {
      const result = await client.query<{ state: PlatformSnapshot }>("SELECT state FROM platform_state WHERE singleton_id = 1");
      if (!result.rows[0]) throw new Error("Platform database is not initialized.");
      const utterances = await this.loadProjectedUtterances(client);
      const state = utterances === null ? result.rows[0].state : { ...result.rows[0].state, utterances };
      return new InMemoryPlatformStore(state).getSnapshot();
    });
  }

  async getViewSnapshot(view: PlatformViewName): Promise<PlatformSnapshot> {
    return projectPlatformView(await this.loadSnapshotProjection(platformViewSourceCollectionNames(view)), view);
  }

  async getMeetingView(meetingId: string): Promise<MeetingViewSnapshot | null> {
    return projectMeetingView(
      await this.loadSnapshotProjection(platformSnapshotSourceCollectionNames(meetingViewCollectionNames), meetingId),
      meetingId
    );
  }

  async appendMeetingRecord(record: MeetingRecord): Promise<MeetingRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const persisted = await this.appendMeetingRecordWithClient(client, record);
      await client.query("COMMIT");
      return persisted;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async appendMeetingRecordWithClient(
    client: PoolClient,
    record: MeetingRecord
  ): Promise<MeetingRecord> {
    const parsed = meetingRecordSchema.parse(record);
    const sourceMatch = await client.query<MeetingRecordRow>(`
      SELECT ${meetingRecordColumns}
      FROM meeting_records
      WHERE meeting_id = $1::uuid AND source_digest = $2
      FOR UPDATE
    `, [parsed.meetingId, parsed.sourceDigest]);
    const existingBySource = sourceMatch.rows[0] ? meetingRecordFromRow(sourceMatch.rows[0]) : null;
    if (existingBySource) {
      if (!isDeepStrictEqual(existingBySource, parsed)) {
        throw new StoreConflictError("Meeting Record source digest already belongs to a different immutable record.");
      }
      return existingBySource;
    }

    const inserted = await client.query<MeetingRecordRow>(`
      INSERT INTO meeting_records (
        meeting_id, revision, closed_at, generated_at, generation_mode, content, source_digest, created_by
      ) VALUES ($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb, $7, $8)
      ON CONFLICT DO NOTHING
      RETURNING ${meetingRecordColumns}
    `, [
      parsed.meetingId,
      parsed.revision,
      parsed.closedAt,
      parsed.generatedAt,
      parsed.generationMode,
      JSON.stringify(parsed.content),
      parsed.sourceDigest,
      parsed.createdBy
    ]);
    if (inserted.rows[0]) return meetingRecordFromRow(inserted.rows[0]);

    const revisionMatch = await client.query<MeetingRecordRow>(`
      SELECT ${meetingRecordColumns}
      FROM meeting_records
      WHERE meeting_id = $1::uuid AND revision = $2
      FOR UPDATE
    `, [parsed.meetingId, parsed.revision]);
    const existingByRevision = revisionMatch.rows[0] ? meetingRecordFromRow(revisionMatch.rows[0]) : null;
    if (!existingByRevision) {
      throw new StoreConflictError("Meeting Record insertion did not return a persisted record.");
    }
    if (!isDeepStrictEqual(existingByRevision, parsed)) {
      throw new StoreConflictError("Meeting Record revision already belongs to a different immutable record.");
    }
    return existingByRevision;
  }

  async getLatestMeetingRecord(meetingId: string): Promise<MeetingRecord | null> {
    const result = await this.pool.query<MeetingRecordRow>(`
      SELECT ${meetingRecordColumns}
      FROM meeting_records
      WHERE meeting_id = $1::uuid
      ORDER BY revision DESC, generated_at DESC
      LIMIT 1
    `, [meetingId]);
    return result.rows[0] ? meetingRecordFromRow(result.rows[0]) : null;
  }

  async listMeetingUtterances(
    meetingId: string,
    input: MeetingUtterancePageInput
  ): Promise<MeetingUtterancePage | null> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new MeetingUtteranceCursorError();
    }
    return this.repeatableRead(async (client) => {
      const meetingResult = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM platform_state,
            jsonb_array_elements(COALESCE(state->'meetings', '[]'::jsonb)) AS entries(meeting)
          WHERE singleton_id = 1 AND meeting->>'id' = $1
        ) AS exists
      `, [meetingId]);
      if (meetingResult.rows[0]?.exists !== true) return null;
      if (!(await this.utteranceProjectionIsComplete(client))) {
        throw new StoreConflictError(
          "Meeting transcript projection is not ready.",
          "business_rule",
          "UTTERANCE_PROJECTION_NOT_READY"
        );
      }
      const cursor = input.cursor ? decodeMeetingUtteranceCursor(input.cursor, meetingId) : null;
      const result = await client.query<{
        snapshot: Utterance;
        createdAt: string | Date;
        sequenceNo: string;
      }>(`
        SELECT
          snapshot,
          created_at AS "createdAt",
          sequence_no::text AS "sequenceNo"
        FROM meeting_utterances
        WHERE meeting_id = $1::uuid
          AND (
            $2::timestamptz IS NULL
            OR (created_at, sequence_no) > ($2::timestamptz, $3::bigint)
          )
        ORDER BY created_at, sequence_no
        LIMIT $4
      `, [
        meetingId,
        cursor?.createdAt ?? null,
        cursor?.sequenceNo.toString() ?? null,
        input.limit + 1
      ]);
      const rows = result.rows.slice(0, input.limit);
      const last = rows.at(-1);
      return {
        items: rows.map(({ snapshot }) => structuredClone(snapshot)),
        nextCursor: result.rows.length > input.limit && last
          ? encodeMeetingUtteranceCursor(
            meetingId,
            last.createdAt instanceof Date ? last.createdAt.toISOString() : new Date(last.createdAt).toISOString(),
            last.sequenceNo
          )
          : null
      };
    });
  }

  async getSpeakerQueue(): Promise<SpeakerQueueItem[]> {
    return (await this.getSnapshot()).speakerQueue;
  }

  async createRuntimeRun(run: RuntimeRun, initialEvent: AppendRuntimeRunEventInput): Promise<RuntimeRun> {
    return this.runtimeRuns.createRuntimeRun(run, initialEvent);
  }

  async getRuntimeRun(id: string): Promise<RuntimeRun | null> {
    return this.runtimeRuns.getRuntimeRun(id);
  }

  async getRuntimeRunForTask(taskId: string): Promise<RuntimeRun | null> {
    return this.runtimeRuns.getRuntimeRunForTask(taskId);
  }

  async listRuntimeRunsForGoal(goalRunId: string): Promise<RuntimeRun[]> {
    return this.runtimeRuns.listRuntimeRunsForGoal(goalRunId);
  }

  async listRecoverableOmpRuntimeRuns(limit?: number): Promise<RuntimeRun[]> {
    return this.runtimeRuns.listRecoverableOmpRuntimeRuns(limit);
  }

  async updateRuntimeRun(id: string, input: RuntimeRunMutationInput): Promise<RuntimeRun> {
    return this.runtimeRuns.updateRuntimeRun(id, input);
  }

  async heartbeatRuntimeRun(id: string, input: RuntimeRunHeartbeatInput): Promise<RuntimeRun> {
    return this.runtimeRuns.heartbeatRuntimeRun(id, input);
  }

  async appendRuntimeRunEvent(id: string, input: AppendRuntimeRunEventInput): Promise<RuntimeRunEvent> {
    return this.runtimeRuns.appendRuntimeRunEvent(id, input);
  }

  async getRuntimeRunEvents(id: string, afterSequence?: number, limit?: number): Promise<RuntimeRunEvent[]> {
    return this.runtimeRuns.getRuntimeRunEvents(id, afterSequence, limit);
  }

  async listGoalRuns(): Promise<GoalRun[]> {
    return this.goals.listGoalRuns();
  }

  async getGoalRun(id: string): Promise<GoalRun | null> {
    return this.goals.getGoalRun(id);
  }

  async getGoalRunDetail(id: string): Promise<GoalRunDetail | null> {
    const [detail, runtimeRuns] = await Promise.all([
      this.goals.getGoalRunDetail(id),
      this.runtimeRuns.listRuntimeRunsForGoal(id)
    ]);
    return detail ? { ...detail, runtimeRuns } : null;
  }

  async createGoalRun(
    run: GoalRun,
    event: AppendGoalEventInput,
    idempotencyKey: string,
    orchestrationAdmission?: GoalJobAdmission
  ): Promise<GoalRun> {
    return this.transact(async (client, store) => {
      const meeting = (await store.getSnapshot()).meetings.find((candidate) => candidate.id === run.meetingId);
      if (!meeting || meeting.threadId !== run.threadId) {
        throw new StoreConflictError("Goal Run meeting and Topic binding is invalid.");
      }
      return {
        result: await this.goals.createGoalRun(run, event, idempotencyKey, orchestrationAdmission, client),
        persistState: false
      };
    }, { loadManagementHistory: false });
  }

  async saveGoalPlan(id: string, input: GoalPlanMutationInput): Promise<GoalRunDetail> {
    return this.transact(async (client, store) => {
      const run = await this.goals.getGoalRun(id, client);
      if (!run) throw new StoreNotFoundError("Goal Run was not found.");
      assertGoalPlanDecisionBindings(run, input.plan, await store.getSnapshot());
      return {
        result: await this.goals.saveGoalPlan(id, input, client),
        persistState: false
      };
    }, { loadManagementHistory: false });
  }

  async approveGoalRun(id: string, input: GoalApprovalMutationInput): Promise<GoalRunDetail> {
    return this.transact(async (client, store) => {
      const run = await this.goals.getGoalRun(id, client);
      if (!run) throw new StoreNotFoundError("Goal Run was not found.");
      const snapshot = await store.getSnapshot();
      assertGoalPlanDecisionBindings(run, { tasks: input.contract.planSnapshot }, snapshot);
      const bindingByPlanTaskId = new Map(input.bindings.map((binding) => [binding.planTaskId, structuredClone(binding)]));
      for (const planTask of input.contract.planSnapshot) {
        const decision = snapshot.decisions.find((candidate) => candidate.id === planTask.decisionId)!;
        const decisionWasProposed = decision.status === "proposed";
        if (decisionWasProposed) {
          await store.setDecisionStatus(decision.id, "approved");
          await this.insertAudit(client, "decision.approve", "decision", decision.id, {
            meetingId: decision.meetingId,
            goalRunId: id
          });
        }
        let task = (await store.getSnapshot()).tasks.find((candidate) => candidate.decisionId === decision.id) ?? null;
        const taskWasCreated = task === null;
        if (!task) {
          task = await store.createTask(goalPlanTaskCreateInput(planTask));
          await this.insertAudit(client, "task.created", "task", task.id, {
            decisionId: decision.id,
            meetingId: decision.meetingId,
            goalRunId: id
          });
        }
        if (task.executionProfile === "worker" && task.approvalState === "pending") {
          task = await store.setTaskApproval(task.id, {
            expectedExecutionRevision: task.execution.revision,
            action: "approve"
          });
          await this.insertAudit(client, "task.approval_changed", "task", task.id, {
            decisionId: decision.id,
            goalRunId: id,
            approvalState: task.approvalState
          });
        }
        const binding = bindingByPlanTaskId.get(planTask.id);
        if (!binding) throw new StoreConflictError("Goal task binding is missing from the approved Plan.");
        if (binding.taskId !== null && binding.taskId !== task.id) {
          throw new StoreConflictError("Goal task binding references a different canonical Task.");
        }
        binding.taskId = task.id;
        if (!taskWasCreated && !decisionWasProposed) {
          await this.insertAudit(client, "goal_task.rebound", "task", task.id, {
            decisionId: decision.id,
            goalRunId: id,
            planTaskId: planTask.id
          });
        }
      }
      return {
        result: await this.goals.approveGoalRun(id, {
          ...input,
          bindings: [...bindingByPlanTaskId.values()]
        }, client),
        persistState: true
      };
    }, { loadManagementHistory: false });
  }

  async setGoalRunState(id: string, input: GoalRunStateMutationInput): Promise<GoalRun> {
    return this.goals.setGoalRunState(id, input);
  }

  async appendGoalEvent(id: string, input: AppendGoalEventInput): Promise<GoalEvent> {
    return this.goals.appendGoalEvent(id, input);
  }

  async getGoalEvents(id: string, afterSequence?: number, limit?: number): Promise<GoalEvent[]> {
    return this.goals.getGoalEvents(id, afterSequence, limit);
  }

  async updateGoalTaskBinding(id: string, input: GoalTaskBindingMutationInput): Promise<GoalTaskBinding> {
    return this.goals.updateGoalTaskBinding(id, input);
  }

  async claimGoalTaskDispatch(input: GoalTaskDispatchClaimInput): Promise<GoalTaskDispatchClaimResult> {
    if (!input.taskAgentJob) return this.goals.claimGoalTaskDispatch(input);
    return this.transact(async (client, store) => {
      const snapshot = await store.getSnapshot();
      const canonicalTask = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
      if (!canonicalTaskMatchesGoalDispatch(canonicalTask, input)) {
        return {
          result: { status: "rejected" as const, reason: "Canonical Task execution ownership changed before Goal dispatch claim." },
          persistState: false
        };
      }
      return {
        result: await this.goals.claimGoalTaskDispatch(input, client),
        persistState: false
      };
    }, { loadManagementHistory: false });
  }

  async addReviewerVerdict(verdict: ReviewerVerdict, event: AppendGoalEventInput): Promise<ReviewerVerdict> {
    return this.goals.addReviewerVerdict(verdict, event);
  }

  async createActionAdapter(adapter: ActionAdapter): Promise<ActionAdapter> {
    return this.goals.createActionAdapter(adapter);
  }

  async listActionAdapters(): Promise<ActionAdapter[]> {
    return this.goals.listActionAdapters();
  }

  async createActionRun(run: ActionRun, event: AppendGoalEventInput): Promise<ActionRun> {
    return this.goals.createActionRun(run, event);
  }

  async updateActionRun(id: string, input: ActionRunMutationInput): Promise<ActionRun> {
    return this.goals.updateActionRun(id, input);
  }

  async admitGoalActionExecution(
    id: string,
    input: GoalActionExecutionAdmissionInput
  ): Promise<GoalActionExecutionAdmissionResult> {
    return this.transact(async (client) => ({
      result: await this.goals.admitGoalActionExecution(id, input, client),
      persistState: false
    }), { loadManagementHistory: false });
  }

  async reserveGoalJob(admission: GoalJobAdmission): Promise<GoalJobAdmission> {
    return this.goals.reserveGoalJob(admission);
  }

  async reserveGoalReviewJob(admission: GoalJobAdmission, data: GoalReviewJobData): Promise<GoalJobAdmission> {
    return this.goals.reserveGoalReviewJob(admission, data);
  }

  async getGoalJobAdmission(jobId: string): Promise<GoalJobAdmission | null> {
    return this.goals.getGoalJobAdmission(jobId);
  }

  async getGoalReviewJobData(jobId: string): Promise<GoalReviewJobData | null> {
    return this.goals.getGoalReviewJobData(jobId);
  }

  async claimGoalJobDispatch(
    jobId: string,
    input: GoalJobDispatchClaimInput
  ): Promise<GoalJobDispatchClaimResult> {
    return this.goals.claimGoalJobDispatch(jobId, input);
  }

  async completeGoalJobDispatch(jobId: string, dispatchToken: string): Promise<GoalJobAdmission> {
    return this.goals.completeGoalJobDispatch(jobId, dispatchToken);
  }

  async setGoalJobState(
    jobId: string,
    expectedState: GoalJobAdmissionState,
    state: GoalJobAdmissionState
  ): Promise<GoalJobAdmission> {
    return this.goals.setGoalJobState(jobId, expectedState, state);
  }

  async getRecoverableGoalJobs(): Promise<GoalJobAdmission[]> {
    return this.goals.getRecoverableGoalJobs();
  }

  async getToolPacks(): Promise<ToolPack[]> {
    return this.repeatableRead(async (client) => {
      const result = await client.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM tool_packs ORDER BY created_at, pack_id"
      );
      const stateResult = await client.query<{ state: PlatformSnapshot }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      if (!stateResult.rows[0]) throw new Error("Platform database is not initialized.");
      const packs = result.rows.map((row) => {
        const pack = toolPackSchema.parse(row.snapshot);
        if (!toolPackManifestDigestIsValid(pack)) {
          throw new StoreConflictError("Tool Pack manifest digest does not match its immutable content.");
        }
        return pack;
      });
      const snapshotPacks = (await new InMemoryPlatformStore(stateResult.rows[0].state).getSnapshot()).toolPacks ?? [];
      const sorted = (values: ToolPack[]) => [...values].sort((left, right) => left.id.localeCompare(right.id));
      if (JSON.stringify(sorted(packs)) !== JSON.stringify(sorted(snapshotPacks))) {
        throw new StoreConflictError("Tool Pack registry projection does not match platform state.");
      }
      return packs;
    });
  }

  async createToolPack(input: CreateToolPackInput, idempotencyKey?: string): Promise<ToolPack> {
    return this.idempotent(
      "tool_pack.create",
      idempotencyKey,
      input,
      "tool_pack.created",
      "tool_pack",
      async (store, client) => {
        const pack = await store.createToolPack(input);
        const revision = (await store.getToolPackRevisions(pack.id))[0]!;
        await this.insertToolPack(client, pack);
        await this.insertToolPackRevision(client, revision);
        return pack;
      },
      (pack) => ({ revision: pack.revision, manifestDigest: pack.manifestDigest }),
      true
    );
  }

  async updateToolPack(id: string, input: UpdateToolPackInput): Promise<ToolPack> {
    return this.transact(async (client, store) => {
      const previous = (await store.getToolPacks()).find((pack) => pack.id === id);
      const pack = await store.updateToolPack(id, input);
      const changed = previous?.revision !== pack.revision;
      if (changed) {
        const revision = (await store.getToolPackRevisions(id))[0]!;
        await this.insertToolPack(client, pack);
        await this.insertToolPackRevision(client, revision);
        await this.insertAudit(client, "tool_pack.updated", "tool_pack", id, {
          fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
          previousRevision: previous?.revision ?? null,
          revision: pack.revision,
          manifestDigest: pack.manifestDigest
        });
      }
      return { result: pack, persistState: changed };
    });
  }

  async validateToolPack(id: string, input: ValidateToolPackInput): Promise<ToolPack> {
    return this.transact(async (client, store) => {
      const pack = await store.validateToolPack(id, input);
      const revision = (await store.getToolPackRevisions(id))[0]!;
      await this.insertToolPack(client, pack);
      await this.insertToolPackRevision(client, revision);
      await this.insertAudit(client, `tool_pack.validation.${input.result}`, "tool_pack", id, {
        revision: pack.revision,
        manifestDigest: pack.manifestDigest
      });
      return { result: pack, persistState: true };
    });
  }

  async approveToolPack(id: string, input: ApproveToolPackInput): Promise<ToolPack> {
    return this.transact(async (client, store) => {
      const pack = await store.approveToolPack(id, input);
      const revision = (await store.getToolPackRevisions(id))[0]!;
      await this.insertToolPack(client, pack);
      await this.insertToolPackRevision(client, revision);
      await this.insertAudit(client, "tool_pack.approved", "tool_pack", id, {
        revision: pack.revision,
        manifestDigest: pack.manifestDigest
      });
      return { result: pack, persistState: true };
    });
  }

  async revokeToolPack(id: string, input: RevokeToolPackInput): Promise<ToolPack> {
    return this.transact(async (client, store) => {
      const pack = await store.revokeToolPack(id, input);
      const revision = (await store.getToolPackRevisions(id))[0]!;
      await this.insertToolPack(client, pack);
      await this.insertToolPackRevision(client, revision);
      await this.insertAudit(client, "tool_pack.revoked", "tool_pack", id, {
        revision: pack.revision,
        manifestDigest: pack.manifestDigest,
        reason: input.reason
      });
      return { result: pack, persistState: true };
    });
  }

  async getToolPackRevisions(id: string): Promise<ToolPackRevision[]> {
    return this.repeatableRead(async (client) => {
      const result = await client.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM tool_pack_revisions WHERE pack_id = $1 ORDER BY revision DESC",
        [id]
      );
      const stateResult = await client.query<{ state: PlatformSnapshot }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      if (!stateResult.rows[0]) throw new Error("Platform database is not initialized.");
      const snapshot = await new InMemoryPlatformStore(stateResult.rows[0].state).getSnapshot();
      if (result.rowCount === 0 && !(snapshot.toolPacks ?? []).some((pack) => pack.id === id)) {
        throw new StoreNotFoundError("Tool Pack revision history not found.");
      }
      const revisions = result.rows.map((row) => {
        const revision = toolPackRevisionSchema.parse(row.snapshot);
        if (!toolPackManifestDigestIsValid(revision)) {
          throw new StoreConflictError("Tool Pack revision manifest digest does not match its immutable content.");
        }
        return revision;
      });
      const snapshotRevisions = (snapshot.toolPackRevisions ?? []).filter((revision) => revision.packId === id);
      const sorted = (values: ToolPackRevision[]) => [...values].sort((left, right) => left.revision - right.revision);
      if (JSON.stringify(sorted(revisions)) !== JSON.stringify(sorted(snapshotRevisions))) {
        throw new StoreConflictError("Tool Pack revision projection does not match platform state.");
      }
      return revisions;
    });
  }

  async getRuntimeProfiles(): Promise<RuntimeProfile[]> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM runtime_profiles ORDER BY created_at, profile_id"
    );
    return result.rows.map((row) => runtimeProfileSchema.parse(row.snapshot));
  }

  async createRuntimeProfile(input: CreateRuntimeProfileInput, idempotencyKey?: string): Promise<RuntimeProfile> {
    return this.idempotent(
      "runtime_profile.create",
      idempotencyKey,
      input,
      "runtime_profile.created",
      "runtime_profile",
      async (store, client) => {
        const profile = await store.createRuntimeProfile(input);
        const revision = (await store.getRuntimeProfileRevisions(profile.id))
          .find((item) => item.revision === profile.revision)!;
        await this.insertRuntimeProfile(client, profile);
        await this.insertRuntimeProfileRevision(client, revision);
        return profile;
      },
      (profile) => ({ revision: profile.revision })
    );
  }

  async updateRuntimeProfile(id: string, input: UpdateRuntimeProfileInput): Promise<RuntimeProfile> {
    return this.transact(async (client, store) => {
      const previous = (await store.getRuntimeProfiles()).find((profile) => profile.id === id);
      const profile = await store.updateRuntimeProfile(id, input);
      const changed = previous?.revision !== profile.revision;
      if (changed) {
        const revision = (await store.getRuntimeProfileRevisions(id)).find((item) => item.revision === profile.revision)!;
        await this.insertRuntimeProfile(client, profile);
        await this.insertRuntimeProfileRevision(client, revision);
        await this.insertAudit(client, "runtime_profile.updated", "runtime_profile", id, {
          fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
          previousRevision: previous?.revision ?? null,
          revision: profile.revision
        });
      }
      return { result: profile, persistState: changed };
    });
  }

  async getRuntimeProfileRevisions(id: string): Promise<RuntimeProfileRevision[]> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM runtime_profile_revisions WHERE profile_id = $1 ORDER BY revision DESC",
      [id]
    );
    if (result.rowCount === 0 && !(await this.getRuntimeProfiles()).some((profile) => profile.id === id)) {
      throw new StoreNotFoundError("Runtime Profile revision history not found.");
    }
    return result.rows.map((row) => runtimeProfileRevisionSchema.parse(row.snapshot));
  }

  async createGroup(input: CreateGroupInput, key?: string): Promise<DiscussionGroup> {
    const group = await this.idempotent("group.create", key, input, "group.created", "group", (store) => store.createGroup(input));
    return this.normalizeLegacyTaxonomyRevision(group);
  }

  async createCategory(input: CreateCategoryInput, key?: string): Promise<Category> {
    const category = await this.idempotent("category.create", key, input, "category.created", "category", (store) => store.createCategory(input));
    return this.normalizeLegacyTaxonomyRevision(category);
  }

  async createTag(input: CreateTagInput, key?: string): Promise<Tag> {
    const tag = await this.idempotent("tag.create", key, input, "tag.created", "tag", (store) => store.createTag(input));
    return this.normalizeLegacyTaxonomyRevision(tag);
  }

  async updateGroup(id: string, input: UpdateGroupInput): Promise<DiscussionGroup> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).groups.find((group) => group.id === id);
      const group = await store.updateGroup(id, input);
      if (previous?.revision === group.revision) return { result: group, persistState: false };
      const { expectedRevision: _expectedRevision, ...changes } = input;
      await this.insertAudit(client, "group.updated", "group", id, {
        fields: Object.keys(changes),
        previousRevision: input.expectedRevision,
        revision: group.revision,
        previous: previous && { name: previous.name },
        current: { name: group.name }
      });
      return { result: group, persistState: true };
    });
  }

  async updateCategory(id: string, input: UpdateCategoryInput): Promise<Category> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).categories.find((category) => category.id === id);
      const category = await store.updateCategory(id, input);
      if (previous?.revision === category.revision) return { result: category, persistState: false };
      const { expectedRevision: _expectedRevision, ...changes } = input;
      await this.insertAudit(client, "category.updated", "category", id, {
        fields: Object.keys(changes),
        previousRevision: input.expectedRevision,
        revision: category.revision,
        previous: previous && { groupId: previous.groupId, name: previous.name },
        current: { groupId: category.groupId, name: category.name }
      });
      return { result: category, persistState: true };
    });
  }

  async updateTag(id: string, input: UpdateTagInput): Promise<Tag> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).tags.find((tag) => tag.id === id);
      const tag = await store.updateTag(id, input);
      if (previous?.revision === tag.revision) return { result: tag, persistState: false };
      const { expectedRevision: _expectedRevision, ...changes } = input;
      await this.insertAudit(client, "tag.updated", "tag", id, {
        fields: Object.keys(changes),
        previousRevision: input.expectedRevision,
        revision: tag.revision,
        previous: previous && { name: previous.name, color: previous.color },
        current: { name: tag.name, color: tag.color }
      });
      return { result: tag, persistState: true };
    });
  }

  async createThread(input: CreateThreadInput, key?: string): Promise<DiscussionThread> {
    return this.idempotent("thread.create", key, input, "thread.created", "thread", (store) => store.createThread(input));
  }

  async updateThread(id: string, input: UpdateThreadInput): Promise<DiscussionThread> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).threads.find((thread) => thread.id === id);
      const thread = await store.updateThread(id, input);
      if (previous?.revision === thread.revision) return { result: thread, persistState: false };
      const { expectedRevision: _expectedRevision, ...changes } = input;
      await this.insertAudit(client, "thread.updated", "thread", id, {
        fields: Object.keys(changes),
        previousRevision: input.expectedRevision,
        revision: thread.revision,
        previousStatus: previous?.status,
        status: thread.status
      });
      return { result: thread, persistState: true };
    });
  }

  async createMeeting(
    input: CreateMeetingInput,
    key?: string,
    participantAdmission: "structural" | "runnable" = "structural"
  ): Promise<Meeting> {
    const idempotencyInput = participantAdmission === "runnable"
      ? { input, participantAdmission }
      : input;
    return this.idempotent(
      "meeting.create",
      key,
      idempotencyInput,
      "meeting.created",
      "meeting",
      (store) => store.createMeeting(input, undefined, participantAdmission),
      undefined,
      true
    );
  }

  async setMeetingState(id: string, state: MeetingState, expectedState?: MeetingState): Promise<Meeting> {
    return this.transact(async (client, store) => {
      const before = await store.getSnapshot();
      const meeting = await store.setMeetingState(id, state, expectedState);
      const after = await store.getSnapshot();
      const previousMeeting = before.meetings.find((item) => item.id === id);
      if (previousMeeting && previousMeeting.agenda.revision !== meeting.agenda.revision) {
        await this.insertAudit(client, "meeting.agenda.advanced", "meeting", id, {
          action: "activate",
          previousRevision: previousMeeting.agenda.revision,
          revision: meeting.agenda.revision,
          currentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
          source: "meeting_state"
        });
      }
      const resolved = after.chairSuggestions.filter((item) =>
        item.meetingId === id
        && item.resolution === "meeting_closed"
        && before.chairSuggestions.some((previous) => previous.id === item.id && previous.status !== "resolved")
      );
      for (const suggestion of resolved) {
        await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", suggestion.id, {
          meetingId: id,
          resolution: suggestion.resolution
        });
      }
      const reopened = after.chairSuggestions.filter((item) =>
        item.meetingId === id
        && item.status !== "resolved"
        && item.transitions.at(-1)?.type === "close_reverted"
        && before.chairSuggestions.some((previous) => previous.id === item.id && previous.resolution === "meeting_closed")
      );
      for (const suggestion of reopened) {
        await this.insertAudit(client, "chair.suggestion.reopened", "chair_suggestion", suggestion.id, { meetingId: id });
      }
      const releasedActions = before.speakerQueue.filter((item) =>
        item.meetingId === id && !after.speakerQueue.some((current) => current.jobId === item.jobId)
      );
      for (const item of releasedActions) {
        await this.insertAudit(client, "speaker.queue.released", "meeting", id, {
          jobId: item.jobId,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          reason: "meeting_closed"
        });
      }
      if (previousMeeting) {
        const auditEvent = meetingStateAuditEvent(previousMeeting.state, meeting.state);
        if (auditEvent) {
          await this.insertAudit(client, auditEvent, "meeting", id, {
            previousState: previousMeeting.state,
            state: meeting.state
          });
        }
      }
      return { result: meeting, persistState: true };
    });
  }

  async setMeetingAgenda(id: string, input: SetMeetingAgendaInput): Promise<Meeting> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).meetings.find((meeting) => meeting.id === id);
      const meeting = await store.setMeetingAgenda(id, input);
      const changed = before?.agenda.revision !== meeting.agenda.revision;
      if (changed) {
        const beforeItems = new Map(before?.agenda.items.map((item) => [item.id, item]) ?? []);
        const afterItems = new Map(meeting.agenda.items.map((item) => [item.id, item]));
        const changedItemIds = [...new Set([...beforeItems.keys(), ...afterItems.keys()])].filter((itemId) => {
          const previous = beforeItems.get(itemId);
          const current = afterItems.get(itemId);
          return !previous || !current || JSON.stringify(previous) !== JSON.stringify(current);
        });
        await this.insertAudit(client, "meeting.agenda.updated", "meeting", id, {
          previousRevision: before?.agenda.revision ?? input.expectedRevision,
          revision: meeting.agenda.revision,
          previousItemCount: before?.agenda.items.length ?? 0,
          itemCount: meeting.agenda.items.length,
          changedItemIds
        });
      }
      return { result: meeting, persistState: changed };
    });
  }

  async advanceMeetingAgenda(id: string, input: AdvanceMeetingAgendaInput): Promise<Meeting> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).meetings.find((meeting) => meeting.id === id);
      const meeting = await store.advanceMeetingAgenda(id, input);
      await this.insertAudit(client, "meeting.agenda.advanced", "meeting", id, {
        action: input.action,
        itemId: "itemId" in input ? input.itemId : null,
        previousRevision: before?.agenda.revision ?? input.expectedRevision,
        revision: meeting.agenda.revision,
        currentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null
      });
      return { result: meeting, persistState: true };
    });
  }

  async setMeetingSummaryState(id: string, state: MeetingSummaryState, jobId: string | null = null): Promise<Meeting> {
    return this.mutate((store) => store.setMeetingSummaryState(id, state, jobId));
  }

  async commitMeetingSummary(input: MeetingSummaryCommitInput): Promise<MeetingSummaryCommitResult> {
    return this.stateTransact(async (client, store) => {
      const before = (await store.getSnapshot()).meetings.find((meeting) => meeting.id === input.meetingId);
      const memoryResult = await store.commitMeetingSummary(input);
      const result = memoryResult.status === "stale" || !memoryResult.record
        ? memoryResult
        : {
          ...memoryResult,
          record: await this.appendMeetingRecordWithClient(client, memoryResult.record)
        };
      if (result.status === "created") {
        await this.insertUtteranceProjection(client, result.utterance);
        await this.insertAudit(client, "meeting.summary.created", "meeting", input.meetingId, {
          ...input.auditDetail,
          meetingRecordRevision: result.record?.revision ?? null,
          meetingRecordSourceDigest: result.record?.sourceDigest ?? null
        });
      } else if (result.status === "stale") {
        await this.insertAudit(client, "meeting.summary.cancelled", "meeting", input.meetingId, {
          classification: "stale_summary_job",
          jobId: input.jobId,
          currentJobId: result.meeting.summaryJobId
        });
      }
      const summaryStateChanged = result.status !== "stale"
        && (before?.summaryState !== result.meeting.summaryState || before?.summaryJobId !== result.meeting.summaryJobId);
      return { result, persistState: result.status === "created" || summaryStateChanged };
    }, input.meetingId);
  }

  async setMeetingMode(
    id: string,
    input: SetMeetingModeInput,
    actor: "owner" | "system" = "owner"
  ): Promise<MeetingModeChangeResult> {
    return this.transact(async (client, store) => {
      const result = await store.setMeetingMode(id, input, actor);
      await this.insertAudit(client, "meeting.mode.changed", "meeting", id, {
        mode: input.mode,
        reason: input.reason,
        chairSuggestionId: input.chairSuggestionId ?? null
        ,actor
      });
      if (result.chairSuggestion) {
        await this.insertAudit(client, "chair.suggestion.mode.accepted", "chair_suggestion", result.chairSuggestion.id, {
          meetingId: id,
          mode: input.mode,
          resolved: result.chairSuggestion.status === "resolved"
        });
      }
      for (const suggestionId of result.resolvedSuggestionIds) {
        await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", suggestionId, {
          meetingId: id,
          resolution: result.chairSuggestion?.id === suggestionId
            ? result.chairSuggestion.resolution
            : "manual_override"
        });
      }
      return { result, persistState: true };
    });
  }

  async setMeetingAutomation(
    id: string,
    input: SetMeetingAutomationInput,
    actor: "owner" | "system" = "owner"
  ): Promise<Meeting> {
    return this.transact(async (client, store) => {
      const beforeSnapshot = await store.getSnapshot();
      const before = beforeSnapshot.meetings.find((meeting) => meeting.id === id);
      const meeting = await store.setMeetingAutomation(id, input, actor);
      const changed = before?.automation !== meeting.automation;
      if (changed) {
        const afterSnapshot = await store.getSnapshot();
        const resolvedSuggestionIds = afterSnapshot.chairSuggestions
          .filter((suggestion) => suggestion.meetingId === id
            && suggestion.resolution === "manual_override"
            && beforeSnapshot.chairSuggestions.some((previous) => previous.id === suggestion.id && previous.status !== "resolved"))
          .map((suggestion) => suggestion.id);
        const remainingJobIds = new Set(afterSnapshot.speakerQueue.map((item) => item.jobId));
        const releasedQueueItems = beforeSnapshot.speakerQueue.filter((item) => item.meetingId === id
          && item.requestedBy === "system"
          && !remainingJobIds.has(item.jobId));
        await this.insertAudit(client, "meeting.automation.changed", "meeting", id, {
          from: before?.automation ?? input.expectedAutomation,
          to: meeting.automation,
          actor,
          automationRevision: meeting.automationRevision ?? 0,
          resolvedSuggestionIds,
          releasedJobIds: releasedQueueItems.map((item) => item.jobId)
        });
        for (const suggestionId of resolvedSuggestionIds) {
          await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", suggestionId, {
            meetingId: id,
            resolution: "manual_override",
            actor
          });
        }
        for (const item of releasedQueueItems) {
          await this.insertAudit(client, "speaker.queue.released", "meeting", id, {
            jobId: item.jobId,
            participantId: item.participantId,
            agentId: item.agentId,
            roleRevision: item.roleRevision,
            reason: "chair_automation_downshift"
          });
        }
      }
      return { result: meeting, persistState: changed };
    });
  }

  async applyChairAutomation(input: ApplyChairAutomationInput): Promise<ApplyChairAutomationResult> {
    return this.transact<ApplyChairAutomationResult>(async (client, store) => {
      const result = await store.applyChairAutomation(input);
      if (result.status === "stale") return { result, persistState: false };
      await this.insertAudit(client, "meeting.mode.changed", "meeting", result.meeting.id, {
        mode: result.meeting.mode,
        reason: result.suggestion.reason,
        chairSuggestionId: result.suggestion.id,
        actor: "system"
      });
      await this.insertAudit(client, "chair.suggestion.mode.accepted", "chair_suggestion", result.suggestion.id, {
        meetingId: result.meeting.id,
        mode: result.meeting.mode,
        actor: "system"
      });
      if (result.queueItem) {
        await this.insertAudit(client, "speaker.queue.reserved", "meeting", result.meeting.id, {
          jobId: result.queueItem.jobId,
          participantId: result.queueItem.participantId,
          agentId: result.queueItem.agentId,
          roleRevision: result.queueItem.roleRevision,
          automationRevision: input.automationRevision,
          requestedBy: "system"
        });
        await this.insertAudit(client, "chair.suggestion.agent.requested", "chair_suggestion", result.suggestion.id, {
          meetingId: result.meeting.id,
          agentId: result.queueItem.agentId,
          jobId: result.queueItem.jobId,
          actor: "system"
        });
      } else {
        await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", result.suggestion.id, {
          meetingId: result.meeting.id,
          resolution: result.suggestion.resolution,
          actor: "system"
        });
      }
      await this.insertAudit(client, "chair.automation.applied", "chair_suggestion", result.suggestion.id, {
        meetingId: result.meeting.id,
        reason: result.suggestion.reason,
        score: result.suggestion.score,
        sourceUtteranceId: result.suggestion.sourceUtteranceId,
        automationRevision: input.automationRevision,
        jobId: result.queueItem?.jobId ?? null,
        policyVersion: "deterministic-v1"
      });
      return { result, persistState: true };
    }, { utteranceScope: { kind: "meeting", meetingId: input.meetingId } });
  }

  async switchParticipantRole(
    meetingId: string,
    participantId: string,
    input: SwitchParticipantRoleInput
  ): Promise<ParticipantAssignment> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).participants.find((participant) => participant.id === participantId);
      const participant = await store.switchParticipantRole(meetingId, participantId, input);
      await this.insertAudit(client, "meeting.participant.role.changed", "participant", participantId, {
        meetingId,
        agentId: participant.agentId,
        previousRoleId: before?.roleId ?? null,
        previousRoleVersion: before?.roleSnapshot.version ?? null,
        roleId: participant.roleId,
        roleVersion: participant.roleSnapshot.version,
        previousRoleRevision: before?.roleRevision ?? null,
        roleRevision: participant.roleRevision,
        reason: input.reason
      });
      return { result: participant, persistState: true };
    });
  }

  async reserveSpeakerTurn(jobId: string, input: AgentTurnJobData): Promise<SpeakerQueueItem> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).speakerQueue.some((item) => item.jobId === jobId);
      const item = await store.reserveSpeakerTurn(jobId, input);
      if (!before) {
        await this.insertAudit(client, "speaker.queue.reserved", "meeting", item.meetingId, {
          jobId,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          roleId: item.roleId,
          roleVersion: item.roleVersion,
          agendaRevision: item.agendaRevision,
          agendaCurrentItemId: item.agendaCurrentItemId
        });
      }
      return { result: item, persistState: !before };
    }, { utteranceScope: { kind: "meeting", meetingId: input.meetingId } });
  }

  async reserveMcpToolCall(jobId: string, input: McpToolCallReservationInput): Promise<SpeakerQueueItem> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).speakerQueue.some((item) => item.jobId === jobId);
      const item = await store.reserveMcpToolCall(jobId, input);
      if (!before) {
        await this.insertAudit(client, "speaker.queue.reserved", "meeting", item.meetingId, {
          kind: item.kind,
          jobId,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          roleId: item.roleId,
          roleVersion: item.roleVersion,
          toolName: item.toolName
        });
      }
      return { result: item, persistState: !before };
    }, { agentRevisionIds: [input.agentId], connectorSecretIds: [input.connectorId] });
  }

  async admitMcpToolCall(jobId: string, input: McpToolCallAdmissionInput): Promise<McpToolCallAdmissionResult> {
    return this.transact(async (client, store) => {
      const result = await store.admitMcpToolCall(jobId, input);
      if (result.status === "reserved") {
        await this.insertAudit(client, "speaker.queue.reserved", "meeting", result.reservation.meetingId, {
          kind: result.reservation.kind,
          jobId,
          participantId: result.reservation.participantId,
          agentId: result.reservation.agentId,
          roleRevision: result.reservation.roleRevision,
          roleId: result.reservation.roleId,
          roleVersion: result.reservation.roleVersion,
          toolName: result.reservation.toolName
        });
      }
      return { result, persistState: result.status === "reserved" || result.clearedReservation };
    }, { agentRevisionIds: [input.agentId], connectorSecretIds: [input.connectorId] });
  }

  async markSpeakerTurnRunning(jobId: string, reservationId?: string): Promise<SpeakerQueueItem | null> {
    return this.stateTransact(async (client, store) => {
      const before = (await store.getSnapshot()).speakerQueue.find((item) => item.jobId === jobId);
      const item = await store.markSpeakerTurnRunning(jobId, reservationId);
      const changed = before?.status === "queued" && item?.status === "running";
      if (changed && item) {
        await this.insertAudit(client, "speaker.queue.started", "meeting", item.meetingId, {
          jobId,
          reservationId: item.reservationId ?? null,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision
        });
      }
      return { result: item, persistState: changed };
    });
  }

  async renewSpeakerTurnLease(jobId: string, now?: string, reservationId?: string): Promise<SpeakerQueueItem | null> {
    return this.stateTransact(async (_client, store) => {
      const before = (await store.getSpeakerQueue()).find((item) => item.jobId === jobId);
      const item = await store.renewSpeakerTurnLease(jobId, now, reservationId);
      const changed = Boolean(item && before?.leaseExpiresAt !== item.leaseExpiresAt);
      return { result: item, persistState: changed };
    });
  }

  async releaseSpeakerTurn(jobId: string, reason: string, reservationId?: string): Promise<SpeakerQueueItem | null> {
    return this.stateTransact(async (client, store) => {
      const item = await store.releaseSpeakerTurn(jobId, reason, reservationId);
      if (item) {
        await this.insertAudit(client, "speaker.queue.released", "meeting", item.meetingId, {
          jobId,
          reservationId: item.reservationId ?? null,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          reason: reason.slice(0, 200)
        });
      }
      return { result: item, persistState: item !== null };
    });
  }

  async releaseExpiredSpeakerTurns(now?: string): Promise<SpeakerQueueItem[]> {
    return this.stateTransact(async (client, store) => {
      const before = await store.getSnapshot();
      const expired = await store.releaseExpiredSpeakerTurns(now);
      const after = expired.length > 0 ? await store.getSnapshot() : before;
      for (const item of expired) {
        await this.insertAudit(client, "speaker.queue.released", "meeting", item.meetingId, {
          jobId: item.jobId,
          participantId: item.participantId,
          agentId: item.agentId,
          roleRevision: item.roleRevision,
          reason: "lease_expired"
        });
        if (item.chairSuggestionId) {
          const previous = before.chairSuggestions.find((suggestion) => suggestion.id === item.chairSuggestionId);
          const current = after.chairSuggestions.find((suggestion) => suggestion.id === item.chairSuggestionId);
          if (previous?.status === "pending" && current?.status === "open") {
            await this.insertAudit(client, "chair.suggestion.agent.released", "chair_suggestion", current.id, {
              meetingId: item.meetingId,
              jobId: item.jobId,
              note: "Speaker reservation lease expired."
            });
          }
        }
      }
      return { result: expired, persistState: expired.length > 0 };
    });
  }

  async addUtterance(meetingId: string, input: CreateUtteranceInput): Promise<Utterance> {
    return (await this.addUtteranceWithDisposition(meetingId, input)).utterance;
  }

  async addUtteranceWithDisposition(
    meetingId: string,
    input: CreateUtteranceInput
  ): Promise<UtteranceCreateResult> {
    if (await this.utteranceProjectionIsComplete(this.pool)) {
      return this.addProjectedUtterance(meetingId, input);
    }
    return this.stateTransact(async (client, store) => {
      const result = await store.addUtteranceWithDisposition(meetingId, input);
      if (result.status === "created") {
        await this.insertUtteranceProjection(client, result.utterance);
      }
      return { result, persistState: result.status === "created" };
    }, meetingId);
  }

  async createChairSuggestion(
    meetingId: string,
    sourceUtteranceId: string,
    suggestion: ChairSuggestion,
    policyBinding?: ChairSuggestionPolicyBinding
  ): Promise<ChairSuggestionCreateResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.createChairSuggestion(meetingId, sourceUtteranceId, suggestion, policyBinding);
      if (result.status === "created") {
        for (const suggestionId of result.supersededSuggestionIds) {
          await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", suggestionId, {
            meetingId,
            resolution: "superseded"
          });
        }
        await this.insertAudit(client, "chair.suggestion.created", "chair_suggestion", result.suggestion.id, {
          meetingId,
          sourceUtteranceId,
          reason: result.suggestion.reason,
          suggestedMode: result.suggestion.suggestedMode,
          suggestedAgentId: result.suggestion.suggestedAgentId ?? null,
          suggestedParticipantId: result.suggestion.suggestedParticipantId ?? null,
          suggestedParticipantRoleRevision: result.suggestion.suggestedParticipantRoleRevision ?? null,
          suggestedRoleId: result.suggestion.suggestedRoleId ?? null,
          suggestedRoleVersion: result.suggestion.suggestedRoleVersion ?? null,
          supersededSuggestionIds: result.supersededSuggestionIds
        });
      }
      return { result, persistState: result.status === "created" };
    }, meetingId);
  }

  async getChairAutomationJobAdmissions(): Promise<ChairAutomationJobAdmission[]> {
    const result = await this.pool.query<ChairAutomationJobAdmissionRow>(`
      SELECT ${chairAutomationJobAdmissionColumns}
      FROM chair_automation_job_admissions
      ORDER BY reserved_at, job_id
    `);
    return result.rows.map(chairAutomationJobAdmissionFromRow);
  }

  async reserveChairAutomationJobAdmission(
    id: string,
    jobId: string,
    automationRevision: number
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    return this.withChairAutomationAdmissionTransaction(async (client, state) => {
      const suggestion = state.chairSuggestions.find((item) => item.id === id);
      const meeting = suggestion
        ? state.meetings.find((item) => item.id === suggestion.meetingId)
        : undefined;
      if (!suggestion || !meeting) throw new StoreNotFoundError("Chair suggestion not found.");
      const existing = await this.lockChairAutomationJobAdmission(client, id);
      if (existing) {
        if (existing.jobId !== jobId || existing.automationRevision !== automationRevision) {
          throw new StoreConflictError("Chair suggestion already has another parent job admission.");
        }
        return { status: "unchanged", admission: existing };
      }
      if (!jobId.trim()
        || !Number.isInteger(automationRevision)
        || automationRevision < 0
        || suggestion.status !== "open"
        || meeting.state !== "active"
        || meeting.automation !== "auto"
        || (meeting.automationRevision ?? 0) !== automationRevision) {
        throw new StoreConflictError("Chair automation policy changed before parent job reservation.");
      }
      const inserted = await client.query<ChairAutomationJobAdmissionRow>(`
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
        ) VALUES ($1::uuid, $2::uuid, $3, $4, 'reserved', now(), NULL, NULL, NULL, now())
        RETURNING ${chairAutomationJobAdmissionColumns}
      `, [id, suggestion.meetingId, jobId, automationRevision]);
      const row = inserted.rows[0];
      if (!row) throw new Error("Chair automation parent job reservation was not persisted.");
      const admission = chairAutomationJobAdmissionFromRow(row);
      await this.insertAudit(client, "chair.automation.admission.reserved", "chair_suggestion", id, {
        meetingId: suggestion.meetingId,
        jobId,
        automationRevision
      });
      return { status: "updated", admission };
    });
  }

  async confirmChairAutomationJobAdmission(
    id: string,
    jobId: string
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    return this.withChairAutomationAdmissionTransaction(async (client, state) => {
      const suggestion = state.chairSuggestions.find((item) => item.id === id);
      if (!suggestion) throw new StoreNotFoundError("Chair suggestion not found.");
      const existing = await this.lockChairAutomationJobAdmission(client, id);
      if (!existing || existing.jobId !== jobId) {
        throw new StoreConflictError("Chair automation parent job reservation is missing.");
      }
      if (existing.status === "reconciliation_required") {
        throw new StoreConflictError("Chair automation parent job requires reconciliation before it can be admitted.");
      }
      if (existing.status === "admitted") return { status: "unchanged", admission: existing };
      const updated = await client.query<ChairAutomationJobAdmissionRow>(`
        UPDATE chair_automation_job_admissions
        SET status = 'admitted',
            admitted_at = COALESCE(admitted_at, now()),
            reconciliation_required_at = NULL,
            reconciliation_reason = NULL,
            updated_at = now()
        WHERE chair_suggestion_id = $1::uuid AND job_id = $2
        RETURNING ${chairAutomationJobAdmissionColumns}
      `, [id, jobId]);
      const row = updated.rows[0];
      if (!row) throw new StoreConflictError("Chair automation parent job admission changed concurrently.");
      const admission = chairAutomationJobAdmissionFromRow(row);
      await this.insertAudit(client, "chair.automation.queued", "chair_suggestion", id, {
        meetingId: suggestion.meetingId,
        jobId,
        automationRevision: admission.automationRevision,
        reason: suggestion.reason,
        score: suggestion.score
      });
      return { status: "updated", admission };
    });
  }

  async releaseChairAutomationJobAdmission(
    id: string,
    jobId: string,
    classification: string
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    return this.withChairAutomationAdmissionTransaction(async (client, state) => {
      const suggestion = state.chairSuggestions.find((item) => item.id === id);
      if (!suggestion) throw new StoreNotFoundError("Chair suggestion not found.");
      const existing = await this.lockChairAutomationJobAdmission(client, id);
      if (!existing || existing.jobId !== jobId || existing.status === "admitted") {
        return { status: "unchanged", admission: existing };
      }
      await client.query(
        "DELETE FROM chair_automation_job_admissions WHERE chair_suggestion_id = $1::uuid AND job_id = $2",
        [id, jobId]
      );
      await this.insertAudit(client, "chair.automation.enqueue_failed", "chair_suggestion", id, {
        meetingId: suggestion.meetingId,
        jobId,
        classification,
        automationRevision: existing.automationRevision
      });
      return { status: "updated", admission: null };
    });
  }

  async requireChairAutomationJobReconciliation(
    id: string,
    jobId: string,
    reason: ChairAutomationJobReconciliationReason,
    at = new Date().toISOString()
  ): Promise<ChairAutomationJobAdmissionMutationResult> {
    return this.withChairAutomationAdmissionTransaction(async (client, state) => {
      const suggestion = state.chairSuggestions.find((item) => item.id === id);
      if (!suggestion) throw new StoreNotFoundError("Chair suggestion not found.");
      const existing = await this.lockChairAutomationJobAdmission(client, id);
      if (!existing || existing.jobId !== jobId || suggestion.status !== "open") {
        return { status: "unchanged", admission: existing };
      }
      if (existing.status === "reconciliation_required") {
        return { status: "unchanged", admission: existing };
      }
      if (!Number.isFinite(Date.parse(at))) {
        throw new StoreConflictError("Chair automation reconciliation time is invalid.");
      }
      const updated = await client.query<ChairAutomationJobAdmissionRow>(`
        UPDATE chair_automation_job_admissions
        SET status = 'reconciliation_required',
            reconciliation_required_at = $3::timestamptz,
            reconciliation_reason = $4,
            updated_at = $3::timestamptz
        WHERE chair_suggestion_id = $1::uuid AND job_id = $2
        RETURNING ${chairAutomationJobAdmissionColumns}
      `, [id, jobId, at, reason]);
      const row = updated.rows[0];
      if (!row) throw new StoreConflictError("Chair automation parent job admission changed concurrently.");
      const admission = chairAutomationJobAdmissionFromRow(row);
      await this.insertAudit(client, "chair.automation.reconciliation_required", "chair_suggestion", id, {
        meetingId: suggestion.meetingId,
        jobId,
        classification: reason,
        automationRevision: admission.automationRevision
      });
      return { status: "updated", admission };
    });
  }

  async setChairSuggestionPending(
    id: string,
    agentId: string,
    jobId: string,
    actor: "owner" | "system" = "owner"
  ): Promise<ChairSuggestionMutationResult> {
    return this.transact(async (client, store) => {
      const result = await store.setChairSuggestionPending(id, agentId, jobId, actor);
      if (result.status === "updated") {
        await this.insertAudit(client, "chair.suggestion.agent.requested", "chair_suggestion", id, {
          meetingId: result.suggestion.meetingId,
          agentId,
          jobId,
          actor
        });
      }
      return { result, persistState: result.status === "updated" };
    }, { loadManagementHistory: false, utteranceScope: { kind: "all" } });
  }

  async releaseChairSuggestion(id: string, jobId: string, note: string): Promise<ChairSuggestionMutationResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.releaseChairSuggestion(id, jobId, note);
      if (result.status === "updated") {
        await this.insertAudit(client, "chair.suggestion.agent.released", "chair_suggestion", id, {
          meetingId: result.suggestion.meetingId,
          jobId,
          note
        });
      }
      return { result, persistState: result.status === "updated" };
    });
  }

  async dismissChairSuggestion(id: string, note: string): Promise<ChairSuggestionMutationResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.dismissChairSuggestion(id, note);
      if (result.status === "updated") {
        await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", id, {
          meetingId: result.suggestion.meetingId,
          resolution: result.suggestion.resolution,
          note
        });
      }
      return { result, persistState: result.status === "updated" };
    });
  }

  async applyChairSuggestedRole(
    id: string,
    input: ApplyChairSuggestedRoleInput
  ): Promise<ChairSuggestionRoleApplyResult> {
    return this.stateTransact(async (client, store) => {
      const before = await store.getSnapshot();
      const previous = before.participants.find((participant) => participant.id === before.chairSuggestions.find((item) => item.id === id)?.suggestedParticipantId);
      const result = await store.applyChairSuggestedRole(id, input);
      await this.insertAudit(client, "meeting.participant.role.changed", "participant", result.participant.id, {
        meetingId: result.participant.meetingId,
        agentId: result.participant.agentId,
        previousRoleId: previous?.roleId ?? null,
        previousRoleVersion: previous?.roleSnapshot.version ?? null,
        roleId: result.participant.roleId,
        roleVersion: result.participant.roleSnapshot.version,
        previousRoleRevision: previous?.roleRevision ?? null,
        roleRevision: result.participant.roleRevision,
        reason: "owner_accepted_chair_role_suggestion"
      });
      await this.insertAudit(client, "chair.suggestion.role.accepted", "chair_suggestion", id, {
        meetingId: result.suggestion.meetingId,
        participantId: result.participant.id,
        agentId: result.participant.agentId,
        roleId: result.participant.roleId,
        roleVersion: result.participant.roleSnapshot.version,
        roleRevision: result.participant.roleRevision
      });
      return { result, persistState: true };
    });
  }

  async commitAgentTurn(input: AgentTurnCommitInput): Promise<AgentTurnCommitResult> {
    const action = async (client: PoolClient, store: InMemoryPlatformStore) => {
      const hadQueueItem = (await store.getSnapshot()).speakerQueue.some((item) => item.jobId === input.turnId);
      const result = await store.commitAgentTurn(input);
      if (result.status === "created") {
        await this.insertUtteranceProjection(client, result.utterance);
        await this.insertAudit(client, "model.run.completed", "meeting", input.meetingId, input.auditDetail);
        if (result.chairSuggestion) {
          await this.insertAudit(client, "chair.suggestion.resolved", "chair_suggestion", result.chairSuggestion.id, {
            meetingId: input.meetingId,
            resolution: result.chairSuggestion.resolution,
            turnId: input.turnId
          });
        }
      }
      return { result, persistState: result.status === "created" || (result.status === "existing" && hadQueueItem) };
    };
    if (!input.executionBinding) return this.stateTransact(action, input.meetingId);
    return this.transact(action, {
      agentRevisionIds: [input.agentId],
      promptIds: input.executionBinding.promptBinding ? [input.executionBinding.promptBinding.promptId] : [],
      credentialSecretIds: input.executionBinding.credentialBinding
        ? [input.executionBinding.credentialBinding.credentialId]
        : [],
      utteranceScope: { kind: "meeting", meetingId: input.meetingId }
    });
  }

  async commitAgentTurnFailure(input: AgentTurnFailureCommitInput): Promise<AgentTurnFailureCommitResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.commitAgentTurnFailure(input);
      if (result.status === "created") {
        await this.insertUtteranceProjection(client, result.utterance);
        await this.insertAudit(client, "model.run.failed", "meeting", input.meetingId, {
          classification: input.classification,
          jobId: input.jobId
        });
        await this.insertAudit(client, "meeting.pause", "meeting", input.meetingId, {
          previousState: "active",
          state: "paused",
          reason: "agent_turn_failure",
          jobId: input.jobId
        });
      }
      return { result, persistState: result.status === "created" };
    }, input.meetingId);
  }

  async commitMcpToolRun(input: McpToolRunCommitInput): Promise<McpToolRunCommitResult> {
    return this.transact(async (client, store) => {
      const hadQueueItem = (await store.getSnapshot()).speakerQueue.some((item) => item.jobId === input.jobId);
      const result = await store.commitMcpToolRun(input);
      if (result.status === "created") {
        await this.insertUtteranceProjection(client, result.utterance);
        await this.insertAudit(
          client,
          input.status === "succeeded" ? "mcp.tool.succeeded" : "mcp.tool.failed",
          "meeting",
          input.meetingId,
          {
            jobId: input.jobId,
            agentId: input.agentId,
            connectorId: input.connectorId,
            toolName: input.toolName,
            toolRunId: result.run.id
          }
        );
        if (result.meetingPaused) {
          await this.insertAudit(client, "meeting.state.changed", "meeting", input.meetingId, {
            state: "paused",
            reason: "mcp_tool_failure",
            jobId: input.jobId,
            toolRunId: result.run.id
          });
        }
      }
      return { result, persistState: result.status === "created" || (result.status === "existing" && hadQueueItem) };
    }, {
      agentRevisionIds: [input.agentId],
      connectorSecretIds: [input.connectorId],
      utteranceScope: { kind: "meeting", meetingId: input.meetingId }
    });
  }

  async createDecision(input: CreateDecisionInput, key?: string): Promise<Decision> {
    return this.idempotent(
      "decision.create",
      key,
      input,
      "decision.proposed",
      "decision",
      (store) => store.createDecision(input),
      (decision) => ({ meetingId: decision.meetingId })
    );
  }

  async setDecisionStatus(id: string, status: "approved" | "rejected"): Promise<Decision> {
    return this.stateTransact(async (client, store) => {
      const before = (await store.getSnapshot()).decisions.find((decision) => decision.id === id);
      const decision = await store.setDecisionStatus(id, status);
      const changed = before?.status !== decision.status;
      if (changed) {
        await this.insertAudit(client, status === "approved" ? "decision.approve" : "decision.reject", "decision", id);
      }
      return { result: decision, persistState: changed };
    });
  }

  async createTask(input: CreateTaskInput, key?: string): Promise<Task> {
    return this.idempotent(
      "task.create",
      key,
      input,
      "task.created",
      "task",
      (store) => store.createTask(input),
      (task) => ({ decisionId: task.decisionId, meetingId: task.meetingId })
    );
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
    return this.stateTransact(async (client, store) => {
      const before = (await store.getSnapshot()).tasks.find((task) => task.id === id);
      const task = await store.updateTask(id, input);
      const changed = before?.revision !== task.revision;
      if (changed) {
        await this.insertAudit(client, "task.updated", "task", id, {
          fields: before ? taskChangedFields(before, task) : [],
          previousRevision: before?.revision,
          revision: task.revision
        });
      }
      return { result: task, persistState: changed };
    });
  }

  async setTaskApproval(id: string, input: SetTaskApprovalInput): Promise<Task> {
    return this.stateTransact(async (client, store) => {
      const before = (await store.getSnapshot()).tasks.find((task) => task.id === id);
      const task = await store.setTaskApproval(id, input);
      const changed = before?.approvalState !== task.approvalState;
      if (changed) {
        await this.insertAudit(client, "task.approval.changed", "task", id, {
          action: input.action,
          from: before?.approvalState,
          to: task.approvalState,
          executionRevision: task.execution.revision
        });
      }
      return { result: task, persistState: changed };
    });
  }

  async addTaskEvidence(id: string, input: AddTaskEvidenceInput, idempotencyKey?: string): Promise<Task> {
    return this.idempotent(
      "task.evidence.add",
      idempotencyKey,
      { taskId: id, input },
      "task.evidence.added",
      "task",
      (store) => store.addTaskEvidence(id, input),
      (task) => {
        const evidence = task.evidence.at(-1)!;
        return { evidenceId: evidence.id, type: evidence.type };
      },
      false
    );
  }

  async moveTask(id: string, input: MoveTaskInput): Promise<Task> {
    return this.stateTransact(async (client, store) => {
      const before = (await store.getSnapshot()).tasks.find((task) => task.id === id);
      const task = await store.moveTask(id, input);
      const changed = before?.status !== task.status || before.position !== task.position;
      if (changed) {
        await this.insertAudit(client, "task.moved", "task", id, {
          fromStatus: before?.status,
          toStatus: task.status,
          fromPosition: before?.position,
          toPosition: task.position,
          previousBoardRevision: before?.boardRevision,
          boardRevision: task.boardRevision
        });
      }
      return { result: task, persistState: changed };
    });
  }

  async markTaskAgentRunQueued(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult> {
    return this.transact(async (client, store) => {
      const result = await store.markTaskAgentRunQueued(jobId, input);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.agent_run.requested", "task", input.taskId, {
          jobId,
          agentId: input.agentId,
          executionProfile: input.executionProfile,
          executionRevision: input.executionRevision,
          requestFingerprint: input.requestFingerprint
        });
      }
      return { result, persistState: result.status === "updated" };
    }, { goalRuntimeAdmissionIds: input.goalRunId ? [input.goalRunId] : [] });
  }

  async markTaskAgentRunRunning(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult> {
    return this.transact(async (client, store) => {
      const result = await store.markTaskAgentRunRunning(jobId, input);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.agent_run.started", "task", input.taskId, {
          jobId,
          agentId: input.agentId,
          executionProfile: input.executionProfile,
          executionRevision: input.executionRevision,
          requestFingerprint: input.requestFingerprint
        });
      }
      return { result, persistState: result.status === "updated" };
    }, { goalRuntimeAdmissionIds: input.goalRunId ? [input.goalRunId] : [] });
  }

  async claimTaskAgentProviderAttempt(jobId: string, input: TaskAgentRunJobData): Promise<TaskExecutionMutationResult> {
    return this.transact(async (client, store) => {
      const result = await store.claimTaskAgentProviderAttempt(jobId, input);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.agent_run.provider_started", "task", input.taskId, {
          jobId,
          agentId: input.agentId,
          executionProfile: input.executionProfile,
          executionRevision: input.executionRevision,
          requestFingerprint: input.requestFingerprint
        });
      }
      return { result, persistState: result.status === "updated" };
    }, { goalRuntimeAdmissionIds: input.goalRunId ? [input.goalRunId] : [] });
  }

  async completeTaskAgentRun(
    jobId: string,
    input: TaskAgentRunJobData,
    content: string,
    usage?: TaskAgentCompletionUsage
  ): Promise<TaskExecutionMutationResult> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).tasks.find((task) => task.id === input.taskId);
      const result = await store.completeTaskAgentRun(jobId, input, content, usage);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.agent_run.completed", "task", input.taskId, {
          jobId,
          agentId: input.agentId,
          executionProfile: input.executionProfile,
          executionRevision: input.executionRevision,
          requestFingerprint: input.requestFingerprint,
          evidenceId: result.task.execution.resultEvidenceId,
          outputLength: content.trim().slice(0, 4_000).length,
          usage: usage ?? null,
          taskStatus: result.task.status
        });
        if (before?.status !== result.task.status) {
          await this.insertAudit(client, "task.moved", "task", input.taskId, {
            fromStatus: before?.status,
            toStatus: result.task.status,
            fromPosition: before?.position,
            toPosition: result.task.position,
            previousBoardRevision: before?.boardRevision,
            boardRevision: result.task.boardRevision,
            source: "task_agent_run"
          });
        }
      }
      return { result, persistState: result.status === "updated" };
    }, { goalRuntimeAdmissionIds: input.goalRunId ? [input.goalRunId] : [] });
  }

  async failTaskAgentRun(binding: TaskAgentRunFailureBinding, error: string): Promise<TaskExecutionMutationResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.failTaskAgentRun(binding, error);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.agent_run.failed", "task", binding.taskId, {
          jobId: binding.jobId,
          agentId: result.task.execution.agentId,
          executionProfile: result.task.execution.profile,
          executionRevision: binding.executionRevision,
          requestFingerprint: binding.requestFingerprint,
          classification: result.task.execution.lastError
        });
      }
      return { result, persistState: result.status === "updated" };
    });
  }

  async markTaskSyncPending(id: string, jobId: string, input: TaskSyncRequestInput): Promise<TaskSyncMutationResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.markTaskSyncPending(id, jobId, input);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.sync.requested", "task", id, {
          adapterId: input.adapterId,
          jobId,
          expectedRevision: input.expectedRevision,
          expectedStatus: input.expectedStatus,
          expectedApprovalState: input.expectedApprovalState,
          expectedSyncAttemptCount: input.expectedSyncAttemptCount,
          requestFingerprint: result.task.sync.requestFingerprint
        });
      }
      return { result, persistState: result.status === "updated" };
    });
  }

  async completeTaskSync(id: string, jobId: string, externalId: string, requestFingerprint: string): Promise<TaskSyncMutationResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.completeTaskSync(id, jobId, externalId, requestFingerprint);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.sync.succeeded", "task", id, {
          adapterId: result.task.sync.adapterId,
          jobId,
          requestFingerprint,
          externalId
        });
      }
      return { result, persistState: result.status === "updated" };
    });
  }

  async failTaskSync(binding: TaskSyncFailureBinding, error: string): Promise<TaskSyncMutationResult> {
    return this.stateTransact(async (client, store) => {
      const result = await store.failTaskSync(binding, error);
      if (result.status === "updated") {
        await this.insertAudit(client, "task.sync.failed", "task", binding.taskId, {
          adapterId: result.task.sync.adapterId,
          jobId: binding.jobId,
          requestFingerprint: binding.requestFingerprint,
          error: result.task.sync.lastError
        });
      }
      return { result, persistState: result.status === "updated" };
    });
  }

  async createAgent(input: CreateAgentInput, idempotencyKey?: string): Promise<Agent> {
    return this.idempotent(
      "agent.create",
      idempotencyKey,
      input,
      "agent.created",
      "agent",
      async (store, client) => {
        const agent = await store.createAgent(input);
        const revision = await store.getAgentRevision(agent.id, agent.draftRevision ?? 1);
        await this.insertAgentRevision(client, revision);
        return agent;
      },
      (agent) => ({ revision: agent.draftRevision ?? 1 }),
      true
    );
  }

  async updateAgent(id: string, input: UpdateAgentInput, expectedDraftRevision?: number): Promise<Agent> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).agents.find((agent) => agent.id === id);
      const agent = await store.updateAgent(id, input, expectedDraftRevision);
      const changed = previous?.draftRevision !== agent.draftRevision;
      if (changed) {
        const revision = await store.getAgentRevision(id, agent.draftRevision ?? 1);
        await this.insertAgentRevision(client, revision);
        await this.insertAudit(client, "agent.updated", "agent", id, {
          fields: Object.keys(input),
          previousRevision: previous?.draftRevision ?? null,
          revision: revision.revision
        });
      }
      return { result: agent, persistState: changed };
    });
  }

  async setAgentModel(id: string, input: SetAgentModelInput, expectedDraftRevision?: number): Promise<Agent> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).agents.find((agent) => agent.id === id);
      const agent = await store.setAgentModel(id, input, expectedDraftRevision);
      const changed = previous?.draftRevision !== agent.draftRevision;
      if (changed) {
        const revision = await store.getAgentRevision(id, agent.draftRevision ?? 1);
        await this.insertAgentRevision(client, revision);
        await this.insertAudit(client, "agent.model.changed", "agent", id, {
          modelConnectorId: agent.modelConnectorId,
          previousRevision: previous?.draftRevision ?? null,
          revision: revision.revision
        });
      }
      return { result: agent, persistState: changed };
    });
  }

  async getAgentReadiness(id: string, options: { executionIsolationAttested?: boolean } = {}): Promise<AgentReadiness> {
    return this.read((store) => store.getAgentReadiness(id, options));
  }

  async getAgentRevisions(id: string): Promise<AgentRevision[]> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM agent_revisions WHERE agent_id = $1 ORDER BY revision DESC",
      [id]
    );
    if (result.rowCount === 0 && !(await this.getSnapshot()).agents.some((agent) => agent.id === id)) {
      throw new StoreNotFoundError("Agent revision history not found.");
    }
    return result.rows.map((row) => {
      const revision = agentRevisionSchema.parse(row.snapshot);
      if (!agentRevisionContentDigestIsValid(revision)) {
        throw new StoreConflictError("Agent revision content digest does not match its immutable execution binding.");
      }
      return revision;
    });
  }

  async getAgentRevision(id: string, revision: number): Promise<AgentRevision> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM agent_revisions WHERE agent_id = $1 AND revision = $2",
      [id, revision]
    );
    if (!result.rows[0]) throw new StoreNotFoundError("Agent revision not found.");
    const parsedRevision = agentRevisionSchema.parse(result.rows[0].snapshot);
    if (!agentRevisionContentDigestIsValid(parsedRevision)) {
      throw new StoreConflictError("Agent revision content digest does not match its immutable execution binding.");
    }
    return parsedRevision;
  }

  async publishAgent(id: string, input: PublishAgentInput): Promise<Agent> {
    return this.transact(async (client, store) => {
      const agent = await store.publishAgent(id, input);
      const revision = await store.getAgentRevision(id, input.expectedDraftRevision);
      await this.insertAgentRevision(client, revision);
      await this.insertAudit(client, "agent.published", "agent", id, { revision: revision.revision });
      return { result: agent, persistState: true };
    });
  }

  async rollbackAgent(id: string, input: RollbackAgentInput): Promise<Agent> {
    return this.transact(async (client, store) => {
      const agent = await store.rollbackAgent(id, input);
      const revision = await store.getAgentRevision(id, agent.draftRevision ?? 1);
      await this.insertAgentRevision(client, revision);
      await this.insertAudit(client, "agent.rolled_back", "agent", id, {
        previousPublishedRevision: input.expectedPublishedRevision,
        revision: revision.revision,
        restoredFromRevision: input.revision
      });
      return { result: agent, persistState: true };
    });
  }

  async setAgentStatus(id: string, input: SetAgentStatusInput): Promise<Agent> {
    return this.transact(async (client, store) => {
      const previousStatus = (await store.getSnapshot()).agents.find((agent) => agent.id === id)?.lifecycleStatus;
      const agent = await store.setAgentStatus(id, input);
      const changed = previousStatus !== agent.lifecycleStatus;
      if (changed) await this.insertAudit(client, "agent.status.changed", "agent", id, {
        previousStatus,
        status: agent.lifecycleStatus,
        previousRevision: input.expectedRevision,
        revision: agent.revision ?? null
      });
      return { result: agent, persistState: changed };
    });
  }

  async getCredentials(): Promise<Credential[]> {
    return (await this.loadSnapshotProjection(["credentials"])).credentials ?? [];
  }

  async createCredential(
    input: CreateCredentialMetadataInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<Credential> {
    const replayInput = credentialCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.idempotent(
      "credential.create",
      idempotencyKey,
      replayInput,
      "credential.created",
      "credential",
      async (store, client) => {
        const encryptedSecret = secret?.ciphertext ? { ciphertext: secret.ciphertext } : undefined;
        const credential = await store.createCredential(input, encryptedSecret);
        if (secret?.ciphertext) await this.saveCredentialSecret(client, credential.id, secret.ciphertext);
        return credential;
      },
      (credential) => ({
        provider: credential.provider,
        kind: credential.kind,
        location: credential.location,
        hasSecret: credential.hasSecret,
        secretRevision: credential.secretRevision
      })
    );
  }

  async updateCredential(id: string, input: UpdateCredentialMetadataInput): Promise<Credential> {
    return this.transact(async (client, store) => {
      const credential = await store.updateCredential(id, input);
      const { expectedUpdatedAt: _expectedUpdatedAt, ...changes } = input;
      await this.insertAudit(client, "credential.updated", "credential", id, {
        fields: Object.keys(changes),
        secretRotated: false,
        status: credential.status,
        secretRevision: credential.secretRevision
      });
      return { result: credential, persistState: true };
    });
  }

  async rotateCredential(
    input: RotateCredentialMetadataInput,
    secret: SecretInput,
    maskedHint?: string | null,
    idempotencyKey?: string
  ): Promise<Credential> {
    const replayInput = credentialRotationIdempotencyInput(input, secret, maskedHint, idempotencyKey);
    return this.idempotent(
      "credential.rotate",
      idempotencyKey,
      replayInput,
      "credential.rotated",
      "credential",
      async (store, client) => {
        const encryptedSecret = secret.ciphertext ? { ciphertext: secret.ciphertext } : {};
        const credential = await store.rotateCredential(input, encryptedSecret, maskedHint);
        if (secret.ciphertext) await this.persistCredentialBindingSecrets(client, store, credential.id, secret.ciphertext);
        return credential;
      },
      (credential) => ({
        secretRevision: credential.secretRevision,
        hasMaskedHint: Boolean(credential.maskedHint)
      })
    );
  }

  async replayCredentialRotation(
    input: RotateCredentialMetadataInput,
    secret: SecretInput,
    maskedHint: string | null | undefined,
    idempotencyKey: string
  ): Promise<Credential | null> {
    return this.replayIdempotent(
      "credential.rotate",
      idempotencyKey,
      credentialRotationIdempotencyInput(input, secret, maskedHint, idempotencyKey)
    );
  }

  async setCredentialStatus(
    id: string,
    input: UpdateCredentialStatusInput,
    idempotencyKey?: string
  ): Promise<Credential> {
    return this.idempotentStateMutation(
      "credential.status",
      idempotencyKey,
      { credentialId: id, ...input },
      async (client, store) => {
        const previousStatus = (await store.getSnapshot()).credentials?.find((item) => item.id === id)?.status;
        const credential = await store.setCredentialStatus(id, input);
        const changed = previousStatus !== credential.status;
        return {
          result: credential,
          persistState: changed,
          ...(changed
            ? {
                afterIdempotency: () => this.insertAudit(client, "credential.status.changed", "credential", id, {
                  previousStatus,
                  status: credential.status
                })
              }
            : {})
        };
      }
    );
  }

  async getCredentialSecret(id: string): Promise<string | null> {
    const result = await this.pool.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM credential_secrets WHERE credential_id = $1",
      [id]
    );
    return result.rows[0]?.ciphertext ?? null;
  }

  async getPrompts(): Promise<PromptTemplate[]> {
    return (await this.getSnapshot()).prompts ?? [];
  }

  async createPrompt(input: CreatePromptInput, idempotencyKey?: string): Promise<PromptTemplate> {
    return this.idempotent(
      "prompt.create",
      idempotencyKey,
      input,
      "prompt.created",
      "prompt",
      async (store, client) => {
        const prompt = await store.createPrompt(input);
        await this.insertPromptVersion(client, await store.getPromptVersion(prompt.id, prompt.currentVersion));
        return prompt;
      },
      (prompt) => ({ version: prompt.currentVersion, kind: prompt.kind })
    );
  }

  async updatePrompt(id: string, input: UpdatePromptInput): Promise<PromptTemplate> {
    return this.transact(async (client, store) => {
      const prompt = await store.updatePrompt(id, input);
      await this.insertPromptVersion(client, await store.getPromptVersion(id, prompt.currentVersion));
      await this.insertAudit(client, "prompt.updated", "prompt", id, {
        fields: Object.keys(input).filter((field) => field !== "expectedCurrentVersion"),
        previousVersion: input.expectedCurrentVersion,
        version: prompt.currentVersion
      });
      return { result: prompt, persistState: true };
    });
  }

  async publishPrompt(id: string, input: PublishPromptInput): Promise<PromptTemplate> {
    return this.transact(async (client, store) => {
      const prompt = await store.publishPrompt(id, input);
      await this.insertPromptVersion(client, await store.getPromptVersion(id, input.version));
      await this.insertAudit(client, "prompt.published", "prompt", id, { version: input.version });
      return { result: prompt, persistState: true };
    });
  }

  async rollbackPrompt(id: string, input: RollbackPromptInput): Promise<PromptTemplate> {
    return this.transact(async (client, store) => {
      const prompt = await store.rollbackPrompt(id, input);
      const version = await store.getPromptVersion(id, prompt.currentVersion);
      await this.insertPromptVersion(client, version);
      await this.insertAudit(client, "prompt.rolled_back", "prompt", id, {
        previousVersion: input.expectedCurrentVersion,
        version: version.version,
        restoredFromVersion: input.version
      });
      return { result: prompt, persistState: true };
    });
  }

  async archivePrompt(id: string, input: ArchivePromptInput): Promise<PromptTemplate> {
    return this.transact(async (client, store) => {
      const previousStatus = (await store.getSnapshot()).prompts?.find((prompt) => prompt.id === id)?.status;
      const prompt = await store.archivePrompt(id, input);
      const changed = previousStatus !== prompt.status;
      if (changed) await this.insertAudit(client, "prompt.archived", "prompt", id, { version: prompt.currentVersion });
      return { result: prompt, persistState: changed };
    });
  }

  async getPromptVersions(id: string): Promise<PromptVersion[]> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM prompt_versions WHERE prompt_id = $1 ORDER BY version DESC",
      [id]
    );
    if (result.rowCount === 0 && !(await this.getSnapshot()).prompts?.some((prompt) => prompt.id === id)) {
      throw new StoreNotFoundError("Prompt version history not found.");
    }
    return result.rows.map((row) => promptVersionSchema.parse(row.snapshot));
  }

  async getPromptVersion(id: string, version: number): Promise<PromptVersion> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM prompt_versions WHERE prompt_id = $1 AND version = $2",
      [id, version]
    );
    if (!result.rows[0]) throw new StoreNotFoundError("Prompt version not found.");
    return promptVersionSchema.parse(result.rows[0].snapshot);
  }

  async createAgentTeam(input: CreateAgentTeamInput, idempotencyKey?: string): Promise<AgentTeam> {
    return this.idempotent(
      "agent_team.create",
      idempotencyKey,
      input,
      "agent_team.created",
      "agent_team",
      (store) => store.createAgentTeam(input),
      (team) => ({ memberCount: team.members.length }),
      true
    );
  }

  async updateAgentTeam(id: string, input: UpdateAgentTeamInput): Promise<AgentTeam> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).agentTeams?.find((team) => team.id === id);
      const team = await store.updateAgentTeam(id, input);
      const changed = before?.revision !== team.revision;
      if (changed) {
        await this.insertAudit(client, "agent_team.updated", "agent_team", id, {
          fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
          previousRevision: input.expectedRevision,
          revision: team.revision,
          memberCount: team.members.length,
          status: team.status
        });
      }
      return { result: team, persistState: changed };
    });
  }

  async createMeetingPreset(input: CreateMeetingPresetInput, idempotencyKey?: string): Promise<MeetingPreset> {
    return this.idempotent(
      "meeting_preset.create",
      idempotencyKey,
      input,
      "meeting_preset.created",
      "meeting_preset",
      (store) => store.createMeetingPreset(input),
      (preset) => ({ teamId: preset.teamId, agendaItemCount: preset.agendaItems.length }),
      true
    );
  }

  async updateMeetingPreset(id: string, input: UpdateMeetingPresetInput): Promise<MeetingPreset> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).meetingPresets?.find((preset) => preset.id === id);
      const preset = await store.updateMeetingPreset(id, input);
      const changed = before?.revision !== preset.revision;
      if (changed) {
        await this.insertAudit(client, "meeting_preset.updated", "meeting_preset", id, {
          fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
          previousRevision: input.expectedRevision,
          revision: preset.revision,
          status: preset.status
        });
      }
      return { result: preset, persistState: changed };
    });
  }

  async createRole(input: CreateRoleInput, idempotencyKey?: string): Promise<Role> {
    return this.idempotent(
      "role.create",
      idempotencyKey,
      input,
      "role.created",
      "role",
      async (store, client) => {
        const role = await store.createRole(input);
        const version = (await store.getRoleVersions(role.id)).find((item) => item.version === role.version)!;
        await this.insertRoleVersion(client, version);
        return role;
      },
      (role) => ({
        version: role.version,
        templateKey: role.templateKey,
        toolPolicy: role.toolPolicy,
        dataPolicy: role.dataPolicy
      })
    );
  }

  async updateRole(id: string, input: UpdateRoleInput, expectedCurrentVersion: number): Promise<Role> {
    return this.transact(async (client, store) => {
      const before = (await store.getSnapshot()).roles.find((role) => role.id === id);
      const role = await store.updateRole(id, input, expectedCurrentVersion);
      const changed = before?.version !== role.version;
      if (before && changed) {
        const fields = Object.entries(input)
          .filter(([field, value]) => before[field as keyof Role] !== value)
          .map(([field]) => field);
        await this.insertAudit(client, "role.updated", "role", id, {
          fields,
          previousVersion: before.version,
          version: role.version,
          templateKey: role.templateKey,
          toolPolicy: role.toolPolicy,
          dataPolicy: role.dataPolicy
        });
        const version = (await store.getRoleVersions(id)).find((item) => item.version === role.version)!;
        await this.insertRoleVersion(client, version);
      }
      return { result: role, persistState: changed };
    });
  }

  async getRoleVersions(id: string): Promise<RoleVersion[]> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM role_versions WHERE role_id = $1 ORDER BY version DESC",
      [id]
    );
    if (result.rowCount === 0) {
      const role = (await this.getSnapshot()).roles.find((candidate) => candidate.id === id);
      if (!role) throw new StoreNotFoundError("Role version history not found.");
    }
    return result.rows.map((row) => roleVersionSchema.parse(row.snapshot));
  }

  async getRoleLifecycle(id: string): Promise<RoleLifecycleView> {
    const result = await this.pool.query<{ state: PlatformSnapshot; versions: unknown[] }>(
      `SELECT platform.state,
              COALESCE((
                SELECT jsonb_agg(role_versions.snapshot ORDER BY role_versions.version DESC)
                FROM role_versions
                WHERE role_versions.role_id = $1
              ), '[]'::jsonb) AS versions
       FROM platform_state AS platform
       WHERE platform.singleton_id = 1`,
      [id]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Platform database is not initialized.");
    const lifecycle = await new InMemoryPlatformStore(row.state).getRoleLifecycle(id);
    const versions = row.versions.map((version) => roleVersionSchema.parse(version));
    const recorded = new Set(versions.map((version) => version.version));
    return {
      ...lifecycle,
      versions,
      missingVersions: Array.from({ length: lifecycle.role.version }, (_value, index) => index + 1)
        .filter((version) => !recorded.has(version))
    };
  }

  async rollbackRole(id: string, version: number, expectedCurrentVersion: number): Promise<Role> {
    return this.transact(async (client, store) => {
      const target = await client.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM role_versions WHERE role_id = $1 AND version = $2",
        [id, version]
      );
      if (!target.rows[0]) throw new StoreNotFoundError("Role version not found.");
      const role = await store.restoreRoleVersion(id, roleVersionSchema.parse(target.rows[0].snapshot), expectedCurrentVersion);
      const restored = (await store.getRoleVersions(id)).find((item) => item.version === role.version)!;
      await this.insertRoleVersion(client, restored);
      await this.insertAudit(client, "role.rolled_back", "role", id, {
        previousVersion: expectedCurrentVersion,
        version: role.version,
        restoredFromVersion: version,
        templateKey: role.templateKey,
        toolPolicy: role.toolPolicy,
        dataPolicy: role.dataPolicy
      });
      return { result: role, persistState: true };
    });
  }

  async deleteRole(
    id: string,
    expectedCurrentVersion: number,
    idempotencyKey?: string
  ): Promise<RoleDeletionResult> {
    return this.idempotentStateMutation(
      "role.delete",
      idempotencyKey,
      { roleId: id, expectedCurrentVersion },
      async (client, store) => {
        const result = await store.deleteRole(id, expectedCurrentVersion);
        return {
          result,
          persistState: true,
          afterIdempotency: () => this.insertAudit(client, "role.deleted", "role", id, {
            version: expectedCurrentVersion,
            historicalMeetingCount: result.historicalMeetingCount,
            deletionMode: "tombstone"
          })
        };
      }
    );
  }

  async createSkill(input: CreateSkillInput, idempotencyKey?: string): Promise<Skill> {
    return this.idempotent(
      "skill.create",
      idempotencyKey,
      input,
      "skill.created",
      "skill",
      async (store) => store.createSkill(input),
      (skill) => this.skillAuditDetail(skill)
    );
  }

  async setSkillStatus(id: string, input: SetSkillStatusInput): Promise<Skill> {
    return this.transact(async (client, store) => {
      const previousStatus = (await store.getSnapshot()).skills.find((skill) => skill.id === id)?.status;
      const skill = await store.setSkillStatus(id, input);
      if (previousStatus !== skill.status) await this.insertAudit(client, "skill.status.changed", "skill", id, {
        ...this.skillAuditDetail(skill),
        previousStatus,
        currentStatus: skill.status
      });
      return { result: skill, persistState: previousStatus !== skill.status };
    });
  }

  async validateSkill(id: string, input: ValidateSkillInput): Promise<Skill> {
    return this.transact(async (client, store) => {
      const previousValidation = (await store.getSnapshot()).skills.find((skill) => skill.id === id)?.validation;
      const skill = await store.validateSkill(id, input);
      await this.insertAudit(client, "skill.validated", "skill", id, {
        ...this.skillAuditDetail(skill),
        previousValidation,
        currentValidation: skill.validation
      });
      return { result: skill, persistState: true };
    });
  }

  async revokeSkill(
    id: string,
    input: RevokeSkillInput,
    idempotencyKey?: string
  ): Promise<SkillRevocationResult> {
    return this.idempotentStateMutation(
      "skill.revoke",
      idempotencyKey,
      { skillId: id, ...input },
      async (client, store) => {
        const previousSnapshot = await store.getSnapshot();
        const previousStatus = previousSnapshot.skills.find((skill) => skill.id === id)?.status;
        const affectedAgentIds = previousSnapshot.agents
          .filter((agent) => agent.skillIds.includes(id))
          .map((agent) => agent.id);
        const result = await store.revokeSkill(id, input);
        const changed = previousStatus !== result.skill.status;
        const revisions: AgentRevision[] = [];
        if (changed) {
          const nextSnapshot = await store.getSnapshot();
          for (const agentId of affectedAgentIds) {
            const agent = nextSnapshot.agents.find((candidate) => candidate.id === agentId);
            if (!agent?.draftRevision) throw new StoreNotFoundError("Affected Agent draft revision not found.");
            revisions.push(await store.getAgentRevision(agentId, agent.draftRevision));
          }
        }
        return {
          result,
          persistState: changed,
          ...(changed
            ? {
                afterIdempotency: async () => {
                  for (const revision of revisions) await this.insertAgentRevision(client, revision);
                  await this.insertAudit(client, "skill.revoked", "skill", id, {
                    ...this.skillAuditDetail(result.skill),
                    previousStatus,
                    currentStatus: result.skill.status,
                    revocationReason: input.reason,
                    revokedAssignmentCount: result.revokedAssignmentCount,
                    affectedAgentRevisions: revisions.map((revision) => ({
                      agentId: revision.agentId,
                      revision: revision.revision
                    }))
                  });
                }
              }
            : {})
        };
      }
    );
  }

  async createModelConnector(
    input: CreateModelConnectorStateInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<ModelConnector> {
    const replayInput = modelConnectorCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.idempotent(
      "model_connector.create",
      idempotencyKey,
      replayInput,
      "model_connector.created",
      "model_connector",
      async (store, client) => {
        const encryptedSecret = secret?.ciphertext ? { ciphertext: secret.ciphertext } : undefined;
        const connector = await store.createModelConnector(input, encryptedSecret);
        if (secret?.ciphertext) {
          if (connector.credentialId) {
            await this.saveCredentialSecret(client, connector.credentialId, secret.ciphertext);
            await this.deleteConnectorSecret(client, connector.id);
            const credential = (await store.getSnapshot()).credentials?.find((item) => item.id === connector.credentialId);
            if (!credential) throw new StoreNotFoundError("Generated Model Connector Credential not found.");
            await this.insertCredentialCreatedAudit(client, credential);
          } else {
            await this.saveConnectorSecret(client, connector.id, secret.ciphertext);
          }
        }
        return connector;
      },
      (connector) => ({ location: connector.location }),
      true
    );
  }

  async replayModelConnectorCreate(
    input: CreateModelConnectorStateInput,
    secret: SecretInput | undefined,
    idempotencyKey: string
  ): Promise<ModelConnector | null> {
    return this.replayIdempotent(
      "model_connector.create",
      idempotencyKey,
      modelConnectorCreateIdempotencyInput(input, secret, idempotencyKey)
    );
  }

  async updateModelConnector(id: string, input: UpdateModelConnectorStateInput, secret?: SecretInput): Promise<ModelConnectorUpdateResult> {
    return this.transact(async (client, store) => {
      const previous = (await store.getSnapshot()).modelConnectors.find((connector) => connector.id === id);
      const result = await store.updateModelConnector(id, input, secret);
      if (previous?.revision === result.connector.revision) {
        return { result, persistState: false };
      }
      if (secret?.ciphertext) {
        if (result.connector.credentialId) {
          await this.saveCredentialSecret(client, result.connector.credentialId, secret.ciphertext);
          await this.deleteConnectorSecret(client, id);
          if (result.connector.credentialId !== (previous?.credentialId ?? null)) {
            const credential = (await store.getSnapshot()).credentials?.find((item) => item.id === result.connector.credentialId);
            if (!credential) throw new StoreNotFoundError("Generated Model Connector Credential not found.");
            await this.insertCredentialCreatedAudit(client, credential);
          }
        } else {
          await this.saveConnectorSecret(client, id, secret.ciphertext);
        }
      } else if (result.connector.credentialId || !result.connector.hasSecret) {
        await this.deleteConnectorSecret(client, id);
      }
      await this.insertAudit(client, "model_connector.updated", "model_connector", id, {
        fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
        secretRotated: Boolean(secret?.ciphertext),
        enabled: result.connector.enabled,
        assignedAgentCount: result.assignedAgentCount,
        previousRevision: previous?.revision,
        currentRevision: result.connector.revision,
        previous: previous && {
          name: previous.name,
          location: previous.location,
          baseUrl: previous.baseUrl,
          model: previous.model,
          enabled: previous.enabled,
          hasSecret: previous.hasSecret,
          secretRevision: previous.secretRevision
        },
        current: {
          name: result.connector.name,
          location: result.connector.location,
          baseUrl: result.connector.baseUrl,
          model: result.connector.model,
          enabled: result.connector.enabled,
          hasSecret: result.connector.hasSecret,
          secretRevision: result.connector.secretRevision
        }
      });
      return { result, persistState: true };
    });
  }

  async createMcpConnector(
    input: CreateMcpConnectorStateInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<McpConnector> {
    const replayInput = mcpConnectorCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.idempotent(
      "mcp_connector.create",
      idempotencyKey,
      replayInput,
      "mcp_connector.created",
      "mcp_connector",
      async (store, client) => {
        const encryptedSecret = secret?.ciphertext ? { ciphertext: secret.ciphertext } : undefined;
        const connector = await store.createMcpConnector(input, encryptedSecret);
        if (secret?.ciphertext) await this.saveConnectorSecret(client, connector.id, secret.ciphertext);
        return connector;
      },
      (connector) => ({
        location: connector.location,
        approvedTools: connector.approvedTools,
        hasSecret: connector.hasSecret,
        secretRevision: connector.secretRevision
      })
    );
  }

  async replayMcpConnectorCreate(
    input: CreateMcpConnectorStateInput,
    secret: SecretInput | undefined,
    idempotencyKey: string
  ): Promise<McpConnector | null> {
    return this.replayIdempotent(
      "mcp_connector.create",
      idempotencyKey,
      mcpConnectorCreateIdempotencyInput(input, secret, idempotencyKey)
    );
  }

  async updateMcpConnector(id: string, input: UpdateMcpConnectorStateInput, secret?: SecretInput): Promise<McpConnectorUpdateResult> {
    return this.transact(async (client, store) => {
      const previousSnapshot = await store.getSnapshot();
      const previousConnector = previousSnapshot.mcpConnectors.find((connector) => connector.id === id);
      const previousDraftRevisions = new Map(previousSnapshot.agents.map((agent) => [agent.id, agent.draftRevision]));
      const result = await store.updateMcpConnector(id, input, secret);
      if (previousConnector?.revision === result.connector.revision) {
        return { result, persistState: false };
      }
      if (secret?.ciphertext) await this.saveConnectorSecret(client, id, secret.ciphertext);
      const nextSnapshot = await store.getSnapshot();
      const affectedAgentRevisions = [];
      for (const agent of nextSnapshot.agents) {
        if (previousDraftRevisions.get(agent.id) === agent.draftRevision) continue;
        if (!agent.draftRevision) throw new StoreNotFoundError("Affected Agent draft revision not found.");
        const revision = await store.getAgentRevision(agent.id, agent.draftRevision);
        await this.insertAgentRevision(client, revision);
        affectedAgentRevisions.push({ agentId: agent.id, revision: revision.revision });
      }
      await this.insertAudit(client, "mcp_connector.updated", "mcp_connector", id, {
        fields: Object.keys(input).filter((field) => field !== "expectedRevision"),
        secretRotated: Boolean(secret?.ciphertext),
        previousRevision: previousConnector?.revision,
        currentRevision: result.connector.revision,
        enabled: result.connector.enabled,
        approvedTools: result.connector.approvedTools,
        revokedGrantCount: result.revokedGrantCount,
        affectedAgentRevisions
      });
      return { result, persistState: true };
    });
  }

  async replayTaskAdapterConnectorCreate(
    input: CreateTaskAdapterConnectorStateInput,
    secret: SecretInput | undefined,
    idempotencyKey: string
  ): Promise<TaskAdapterConnector | null> {
    return this.replayIdempotent(
      "task_adapter.create",
      idempotencyKey,
      taskAdapterConnectorCreateIdempotencyInput(input, secret, idempotencyKey)
    );
  }

  async createTaskAdapterConnector(
    input: CreateTaskAdapterConnectorStateInput,
    secret?: SecretInput,
    idempotencyKey?: string
  ): Promise<TaskAdapterConnector> {
    const replayInput = taskAdapterConnectorCreateIdempotencyInput(input, secret, idempotencyKey);
    return this.idempotent(
      "task_adapter.create",
      idempotencyKey,
      replayInput,
      "task_adapter.created",
      "task_adapter",
      async (store, client) => {
        const encryptedSecret = secret?.ciphertext ? { ciphertext: secret.ciphertext } : undefined;
        const connector = await store.createTaskAdapterConnector(input, encryptedSecret);
        if (secret?.ciphertext) await this.saveConnectorSecret(client, connector.id, secret.ciphertext);
        return connector;
      },
      (connector) => ({ location: connector.location, hasSecret: connector.hasSecret })
    );
  }

  async getConnectorSecret(connectorId: string): Promise<string | null> {
    const result = await this.pool.query<{ ciphertext: string }>(
      `WITH model_connector AS (
         SELECT connector
         FROM platform_state AS platform
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'modelConnectors', '[]'::jsonb)) AS connector
         WHERE platform.singleton_id = 1 AND connector->>'id' = $1::text
         LIMIT 1
       )
       SELECT CASE
         WHEN model.connector IS NULL THEN legacy.ciphertext
         WHEN NULLIF(model.connector->>'credentialId', '') IS NOT NULL THEN credential.ciphertext
         WHEN COALESCE((model.connector->>'hasSecret')::boolean, false) THEN legacy.ciphertext
         ELSE NULL
       END AS ciphertext
       FROM (SELECT 1) AS anchor
       LEFT JOIN model_connector AS model ON true
       LEFT JOIN connector_secrets AS legacy ON legacy.connector_id = $1::uuid
       LEFT JOIN credential_secrets AS credential
         ON credential.credential_id::text = model.connector->>'credentialId'`,
      [connectorId]
    );
    return result.rows[0]?.ciphertext ?? null;
  }

  async createOwner(email: string, passwordHash: string): Promise<OwnerUser> {
    const result = await this.pool.query<OwnerUser>(
      "INSERT INTO owner_users(id, email, password_hash) VALUES ($1, lower($2), $3) RETURNING id, email, password_hash AS \"passwordHash\"",
      [randomUUID(), email, passwordHash]
    );
    return result.rows[0]!;
  }

  async findOwnerByEmail(email: string): Promise<OwnerUser | null> {
    const result = await this.pool.query<OwnerUser>(
      "SELECT id, email, password_hash AS \"passwordHash\" FROM owner_users WHERE email = lower($1)",
      [email]
    );
    return result.rows[0] ?? null;
  }

  async createSession(session: SessionRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO owner_sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at",
      [session.tokenHash, session.userId, session.expiresAt]
    );
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const result = await this.pool.query<SessionRecord>(
      "SELECT user_id AS \"userId\", token_hash AS \"tokenHash\", expires_at AS \"expiresAt\" FROM owner_sessions WHERE token_hash = $1 AND expires_at > now()",
      [tokenHash]
    );
    return result.rows[0] ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM owner_sessions WHERE token_hash = $1", [tokenHash]);
  }

  async admitExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string
  ): Promise<ExternalExecutionStartAdmission> {
    const fingerprint = externalExecutionStartFingerprint(input);
    return this.withExternalExecutionTransaction(async (client) => {
      const reservationId = randomUUID();
      const reserved: ExternalExecutionStartEnvelope = { state: "reserved", reservationId };
      const inserted = await client.query(
        `INSERT INTO idempotency_records(operation, idempotency_key, request_fingerprint, response)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING request_fingerprint AS "requestFingerprint", response`,
        [externalExecutionStartOperation, idempotencyKey, fingerprint, JSON.stringify(reserved)]
      );
      if (inserted.rowCount === 1) {
        await this.insertAudit(client, "external_execution.requested", "external_execution", reservationId, {});
        return { status: "reserved", reservationId };
      }

      const existing = await client.query<{ requestFingerprint: string | null; response: unknown }>(
        'SELECT response, request_fingerprint AS "requestFingerprint" FROM idempotency_records WHERE operation = $1 AND idempotency_key = $2',
        [externalExecutionStartOperation, idempotencyKey]
      );
      const record = existing.rows[0];
      if (!record) {
        throw new StoreConflictError(
          "External execution admission requires manual reconciliation.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      if (record.requestFingerprint !== fingerprint) {
        throw new StoreConflictError(
          "Idempotency key was already used with a different request.",
          "business_rule",
          "IDEMPOTENCY_KEY_CONFLICT"
        );
      }
      const envelope = parseExternalExecutionStartEnvelope(record.response);
      if (!envelope) {
        throw new StoreConflictError(
          "External execution admission requires manual reconciliation.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      return envelope.state === "settled"
        ? {
            status: "settled",
            reservationId: envelope.reservationId,
            execution: structuredClone(envelope.execution)
          }
        : { status: "pending", reservationId: envelope.reservationId };
    });
  }

  async settleExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string,
    execution: ExternalExecution
  ): Promise<ExternalExecution> {
    const fingerprint = externalExecutionStartFingerprint(input);
    return this.withExternalExecutionTransaction(async (client) => {
      const existing = await client.query<{ requestFingerprint: string | null; response: unknown }>(
        'SELECT response, request_fingerprint AS "requestFingerprint" FROM idempotency_records WHERE operation = $1 AND idempotency_key = $2 FOR UPDATE',
        [externalExecutionStartOperation, idempotencyKey]
      );
      const record = existing.rows[0];
      if (!record) {
        throw new StoreConflictError(
          "External execution reservation was not found.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      if (record.requestFingerprint !== fingerprint) {
        throw new StoreConflictError(
          "Idempotency key was already used with a different request.",
          "business_rule",
          "IDEMPOTENCY_KEY_CONFLICT"
        );
      }
      const envelope = parseExternalExecutionStartEnvelope(record.response);
      if (!envelope) {
        throw new StoreConflictError(
          "External execution admission requires manual reconciliation.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      if (envelope.state === "settled") return structuredClone(envelope.execution);

      const settled: ExternalExecutionStartEnvelope = {
        state: "settled",
        reservationId: envelope.reservationId,
        execution: structuredClone(execution)
      };
      await this.insertAudit(client, "external_execution.accepted", "external_execution", envelope.reservationId, {
        reservationId: envelope.reservationId,
        status: execution.status
      });
      const updated = await client.query(
        `UPDATE idempotency_records
         SET response = $3::jsonb
         WHERE operation = $1
           AND idempotency_key = $2
           AND request_fingerprint = $4
           AND response->>'state' = 'reserved'`,
        [externalExecutionStartOperation, idempotencyKey, JSON.stringify(settled), fingerprint]
      );
      if (updated.rowCount !== 1) {
        throw new StoreConflictError(
          "External execution acceptance requires manual reconciliation.",
          "business_rule",
          "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED"
        );
      }
      return structuredClone(execution);
    });
  }

  async recordAudit(event: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.pool.query(
      "INSERT INTO audit_events(id, event, entity_type, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [randomUUID(), event, entityType, entityId, JSON.stringify(detail)]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withChairAutomationAdmissionTransaction<T>(
    action: (client: PoolClient, state: PlatformSnapshot) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const stateResult = await client.query<{ state: PlatformSnapshot }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1 FOR UPDATE"
      );
      const state = stateResult.rows[0]?.state;
      if (!state) throw new Error("Platform database is not initialized.");
      const result = await action(client, state);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockChairAutomationJobAdmission(
    client: PoolClient,
    chairSuggestionId: string
  ): Promise<ChairAutomationJobAdmission | null> {
    const result = await client.query<ChairAutomationJobAdmissionRow>(`
      SELECT ${chairAutomationJobAdmissionColumns}
      FROM chair_automation_job_admissions
      WHERE chair_suggestion_id = $1::uuid
      FOR UPDATE
    `, [chairSuggestionId]);
    return result.rows[0] ? chairAutomationJobAdmissionFromRow(result.rows[0]) : null;
  }

  private async withExternalExecutionTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
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

  private async saveConnectorSecret(client: PoolClient, connectorId: string, ciphertext: string): Promise<void> {
    await client.query(
      "INSERT INTO connector_secrets(connector_id, ciphertext) VALUES ($1, $2) ON CONFLICT (connector_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()",
      [connectorId, ciphertext]
    );
  }

  private async deleteConnectorSecret(client: PoolClient, connectorId: string): Promise<void> {
    await client.query("DELETE FROM connector_secrets WHERE connector_id = $1", [connectorId]);
  }

  private async saveCredentialSecret(client: PoolClient, credentialId: string, ciphertext: string): Promise<void> {
    await client.query(
      "INSERT INTO credential_secrets(credential_id, ciphertext) VALUES ($1, $2) ON CONFLICT (credential_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()",
      [credentialId, ciphertext]
    );
  }

  private async persistCredentialBindingSecrets(
    client: PoolClient,
    store: InMemoryPlatformStore,
    credentialId: string,
    ciphertext: string
  ): Promise<void> {
    await this.saveCredentialSecret(client, credentialId, ciphertext);
    const snapshot = await store.getSnapshot();
    for (const connector of snapshot.modelConnectors.filter((item) => item.credentialId === credentialId)) {
      await this.saveConnectorSecret(client, connector.id, ciphertext);
    }
  }

  private async insertPromptVersion(client: PoolClient, version: PromptVersion): Promise<void> {
    await client.query(
      `INSERT INTO prompt_versions(prompt_id, version, snapshot, created_at, published_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (prompt_id, version) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, published_at = EXCLUDED.published_at`,
      [version.promptId, version.version, JSON.stringify(version), version.createdAt, version.publishedAt]
    );
  }

  private async insertAgentRevision(client: PoolClient, revision: AgentRevision): Promise<void> {
    await client.query(
      `INSERT INTO agent_revisions(agent_id, revision, snapshot, created_at, published_at, runtime_profile_binding, tool_pack_grants)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz, $6::jsonb, $7::jsonb)
       ON CONFLICT (agent_id, revision) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           published_at = EXCLUDED.published_at,
           runtime_profile_binding = EXCLUDED.runtime_profile_binding,
           tool_pack_grants = EXCLUDED.tool_pack_grants`,
      [
        revision.agentId,
        revision.revision,
        JSON.stringify(revision),
        revision.createdAt,
        revision.publishedAt,
        JSON.stringify(revision.runtimeProfileBinding),
        JSON.stringify(revision.toolPackGrants)
      ]
    );
  }

  private async insertRuntimeProfile(client: PoolClient, profile: RuntimeProfile): Promise<void> {
    await client.query(
      `INSERT INTO runtime_profiles(profile_id, revision, snapshot, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (profile_id) DO UPDATE
       SET revision = EXCLUDED.revision, snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      [profile.id, profile.revision, JSON.stringify(profile), profile.createdAt, profile.updatedAt]
    );
  }

  private async insertRuntimeProfileRevision(client: PoolClient, revision: RuntimeProfileRevision): Promise<void> {
    await client.query(
      `INSERT INTO runtime_profile_revisions(profile_id, revision, snapshot, source, recorded_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)
       ON CONFLICT (profile_id, revision) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, source = EXCLUDED.source, recorded_at = EXCLUDED.recorded_at`,
      [revision.profileId, revision.revision, JSON.stringify(revision), revision.source, revision.recordedAt]
    );
  }

  private async insertToolPack(client: PoolClient, pack: ToolPack): Promise<void> {
    await client.query(
      `INSERT INTO tool_packs(pack_id, revision, snapshot, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (pack_id) DO UPDATE
       SET revision = EXCLUDED.revision, snapshot = EXCLUDED.snapshot, updated_at = EXCLUDED.updated_at`,
      [pack.id, pack.revision, JSON.stringify(pack), pack.createdAt, pack.updatedAt]
    );
  }

  private async insertToolPackRevision(client: PoolClient, revision: ToolPackRevision): Promise<void> {
    await client.query(
      `INSERT INTO tool_pack_revisions(pack_id, revision, snapshot, source, recorded_at)
       VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz)`,
      [revision.packId, revision.revision, JSON.stringify(revision), revision.source, revision.recordedAt]
    );
  }

  private async insertRoleVersion(client: PoolClient, version: RoleVersion): Promise<void> {
    await client.query(
      "INSERT INTO role_versions(role_id, version, snapshot, created_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz)",
      [version.roleId, version.version, JSON.stringify(version), version.recordedAt]
    );
  }

  private async insertAudit(
    client: PoolClient,
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    await client.query(
      "INSERT INTO audit_events(id, event, entity_type, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [randomUUID(), event, entityType, entityId, JSON.stringify(detail)]
    );
  }

  private async insertCredentialCreatedAudit(client: PoolClient, credential: Credential): Promise<void> {
    await this.insertAudit(client, "credential.created", "credential", credential.id, {
      provider: credential.provider,
      kind: credential.kind,
      location: credential.location,
      hasSecret: credential.hasSecret,
      secretRevision: credential.secretRevision
    });
  }

  private skillAuditDetail(skill: Skill): Record<string, unknown> {
    return {
      name: skill.name,
      version: skill.version,
      source: skill.source,
      owner: skill.owner,
      ownerAttribution: "declared_metadata",
      contentDigest: skill.contentDigest,
      status: skill.status,
      validation: skill.validation,
      approvedAt: skill.approvedAt,
      revokedAt: skill.revokedAt,
      revocationReason: skill.revocationReason
    };
  }

  private normalizeLegacyTaxonomyRevision<T extends { revision: number }>(record: T): T {
    return record.revision === undefined ? { ...record, revision: 1 } : record;
  }

  private async idempotentStateMutation<T>(
    operation: string,
    key: string | undefined,
    input: unknown,
    action: (
      client: PoolClient,
      store: InMemoryPlatformStore
    ) => Promise<{
      result: T;
      persistState: boolean;
      afterIdempotency?: () => Promise<void>;
    }>
  ): Promise<T> {
    const fingerprint = requestFingerprint(input);
    return this.transact(async (client, store) => {
      if (key) {
        const cached = await client.query<{ response: T; requestFingerprint: string | null }>(
          'SELECT response, request_fingerprint AS "requestFingerprint" FROM idempotency_records WHERE operation = $1 AND idempotency_key = $2',
          [operation, key]
        );
        if (cached.rows[0]) {
          if (!cached.rows[0].requestFingerprint || cached.rows[0].requestFingerprint !== fingerprint) {
            throw new StoreConflictError(
              "Idempotency key was already used with a different request.",
              "business_rule",
              "IDEMPOTENCY_KEY_CONFLICT"
            );
          }
          return { result: cached.rows[0].response, persistState: false };
        }
      }

      const mutation = await action(client, store);
      if (key) {
        await client.query(
          "INSERT INTO idempotency_records(operation, idempotency_key, request_fingerprint, response) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING",
          [operation, key, fingerprint, JSON.stringify(mutation.result)]
        );
      }
      await mutation.afterIdempotency?.();
      return { result: mutation.result, persistState: mutation.persistState };
    });
  }

  private async idempotent<T extends { id: string }>(
    operation: string,
    key: string | undefined,
    input: unknown,
    auditEvent: string,
    entityType: string,
    action: (store: InMemoryPlatformStore, client: PoolClient) => Promise<T>,
    auditDetail?: (result: T) => Record<string, unknown>,
    loadManagementHistory = false
  ): Promise<T> {
    const fingerprint = requestFingerprint(input);
    return this.transact(async (client, store) => {
      if (key) {
        const cached = await client.query<{ response: T; requestFingerprint: string | null }>(
          'SELECT response, request_fingerprint AS "requestFingerprint" FROM idempotency_records WHERE operation = $1 AND idempotency_key = $2',
          [operation, key]
        );
        if (cached.rows[0]) {
          if (!cached.rows[0].requestFingerprint || cached.rows[0].requestFingerprint !== fingerprint) {
            throw new StoreConflictError(
              "Idempotency key was already used with a different request.",
              "business_rule",
              "IDEMPOTENCY_KEY_CONFLICT"
            );
          }
          return { result: cached.rows[0].response, persistState: false };
        }
      }

      const result = await action(store, client);
      if (key) {
        await client.query(
          "INSERT INTO idempotency_records(operation, idempotency_key, request_fingerprint, response) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING",
          [operation, key, fingerprint, JSON.stringify(result)]
        );
      }
      await this.insertAudit(client, auditEvent, entityType, result.id, auditDetail?.(result) ?? {});
      return { result, persistState: true };
    }, { loadManagementHistory });
  }

  private async replayIdempotent<T>(operation: string, key: string, input: unknown): Promise<T | null> {
    const fingerprint = requestFingerprint(input);
    const cached = await this.pool.query<{ response: T; requestFingerprint: string | null }>(
      'SELECT response, request_fingerprint AS "requestFingerprint" FROM idempotency_records WHERE operation = $1 AND idempotency_key = $2',
      [operation, key]
    );
    if (!cached.rows[0]) return null;
    if (!cached.rows[0].requestFingerprint || cached.rows[0].requestFingerprint !== fingerprint) {
      throw new StoreConflictError(
        "Idempotency key was already used with a different request.",
        "business_rule",
        "IDEMPOTENCY_KEY_CONFLICT"
      );
    }
    return cached.rows[0].response;
  }

  private async mutate<T>(action: (store: InMemoryPlatformStore) => Promise<T>): Promise<T> {
    return this.transact(
      async (_client, store) => ({ result: await action(store), persistState: true }),
      { loadManagementHistory: false }
    );
  }

  private async loadSnapshotProjection(
    collectionNames: readonly PlatformSnapshotCollectionName[],
    meetingId: string | null = null
  ): Promise<PlatformSnapshot> {
    const included = new Set(collectionNames);
    const entries = platformSnapshotCollectionNames.flatMap((name) => [
      `'${name}'`,
      included.has(name) ? `COALESCE(state->'${name}', '[]'::jsonb)` : "'[]'::jsonb"
    ]);
    const load = async (queryable: Pool | PoolClient): Promise<PlatformSnapshot> => {
      const result = await queryable.query<{ state: PlatformSnapshot }>(`
        SELECT jsonb_build_object(${entries.join(", ")}) AS state
        FROM platform_state
        WHERE singleton_id = 1
      `);
      if (!result.rows[0]) throw new Error("Platform database is not initialized.");
      const utterances = included.has("utterances")
        ? await this.loadProjectedUtterances(queryable, meetingId)
        : null;
      const state = utterances === null ? result.rows[0].state : { ...result.rows[0].state, utterances };
      return new InMemoryPlatformStore(state).getSnapshot();
    };
    return included.has("utterances")
      ? this.repeatableRead(load)
      : load(this.pool);
  }

  private async utteranceProjectionIsComplete(queryable: Pool | PoolClient): Promise<boolean> {
    const result = await queryable.query<{ complete: boolean }>(`
      SELECT source_count IS NOT NULL
        AND processed_count = source_count
        AND cutover_at IS NOT NULL AS complete
      FROM utterance_projection_backfill_progress
      WHERE singleton_id = 1
    `);
    return result.rows[0]?.complete === true;
  }

  private async loadProjectedUtterances(
    queryable: Pool | PoolClient,
    meetingId: string | null = null
  ): Promise<Utterance[] | null> {
    const result = await queryable.query<{ complete: boolean; utterances: Utterance[] | null }>(`
      SELECT
        source_count IS NOT NULL AND processed_count = source_count AND cutover_at IS NOT NULL AS complete,
        CASE WHEN source_count IS NOT NULL AND processed_count = source_count AND cutover_at IS NOT NULL THEN
          COALESCE((
            SELECT jsonb_agg(snapshot ORDER BY created_at, sequence_no)
            FROM meeting_utterances
            WHERE $1::uuid IS NULL OR meeting_id = $1::uuid
          ), '[]'::jsonb)
        ELSE NULL END AS utterances
      FROM utterance_projection_backfill_progress
      WHERE singleton_id = 1
    `, [meetingId]);
    const row = result.rows[0];
    return row?.complete === true && Array.isArray(row.utterances) ? row.utterances : null;
  }

  private async addProjectedUtterance(
    meetingId: string,
    input: CreateUtteranceInput
  ): Promise<UtteranceCreateResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await this.utteranceProjectionIsComplete(client))) {
        throw new StoreConflictError("Utterance projection cutover is not complete.");
      }
      if (input.turnId) {
        const existing = await client.query<{ snapshot: Utterance }>(
          "SELECT snapshot FROM meeting_utterances WHERE turn_id = $1",
          [input.turnId]
        );
        if (existing.rows[0]) {
          if (!utteranceReplayMatches(meetingId, existing.rows[0].snapshot, input)) {
            throw new StoreConflictError(
              "Utterance turn ID was already used for different content or attribution.",
              "business_rule",
              "IDEMPOTENCY_KEY_CONFLICT"
            );
          }
          await client.query("COMMIT");
          return { status: "existing", utterance: existing.rows[0].snapshot };
        }
      }
      const meeting = await client.query<{ state: MeetingState }>(`
        SELECT meeting->>'state' AS state
        FROM platform_state AS platform
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(platform.state->'meetings', '[]'::jsonb)) AS entries(meeting)
        WHERE platform.singleton_id = 1 AND meeting->>'id' = $1
        FOR SHARE OF platform
      `, [meetingId]);
      if (!meeting.rows[0]) throw new StoreNotFoundError("Meeting not found.");
      const isClosedSummary = meeting.rows[0].state === "closed" && isMeetingSummaryUtterance(meetingId, input);
      if (meeting.rows[0].state !== "active" && !isClosedSummary) {
        throw new StoreConflictError("Meeting must be active before adding an Utterance.");
      }

      const utterance: Utterance = {
        id: randomUUID(),
        meetingId,
        ...input,
        createdAt: new Date().toISOString()
      };
      const inserted = await client.query<{ snapshot: Utterance }>(`
        INSERT INTO meeting_utterances(utterance_id, turn_id, meeting_id, created_at, snapshot)
        VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING snapshot
      `, [utterance.id, utterance.turnId ?? null, meetingId, utterance.createdAt, JSON.stringify(utterance)]);
      if (!inserted.rows[0]) {
        if (utterance.turnId) {
          const existing = await client.query<{ snapshot: Utterance }>(
            "SELECT snapshot FROM meeting_utterances WHERE turn_id = $1",
            [utterance.turnId]
          );
          if (existing.rows[0] && utteranceReplayMatches(meetingId, existing.rows[0].snapshot, input)) {
            await client.query("COMMIT");
            return { status: "existing", utterance: existing.rows[0].snapshot };
          }
          if (existing.rows[0]) {
            throw new StoreConflictError(
              "Utterance turn ID was already used for different content or attribution.",
              "business_rule",
              "IDEMPOTENCY_KEY_CONFLICT"
            );
          }
        }
        throw new StoreConflictError("Utterance projection rejected a conflicting identifier.");
      }
      await client.query("COMMIT");
      return { status: "created", utterance: inserted.rows[0].snapshot };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertUtteranceProjection(client: PoolClient, utterance: Utterance): Promise<void> {
    await client.query(`
      INSERT INTO meeting_utterances(utterance_id, turn_id, meeting_id, created_at, snapshot)
      VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::jsonb)
      ON CONFLICT DO NOTHING
    `, [utterance.id, utterance.turnId ?? null, utterance.meetingId, utterance.createdAt, JSON.stringify(utterance)]);
  }

  private async stateTransact<T>(
    action: (client: PoolClient, store: InMemoryPlatformStore) => Promise<{ result: T; persistState: boolean }>,
    utteranceMeetingId?: string
  ): Promise<T> {
    return this.transact(action, {
      loadManagementHistory: false,
      utteranceScope: utteranceMeetingId ? { kind: "meeting", meetingId: utteranceMeetingId } : { kind: "none" }
    });
  }

  private async read<T>(action: (store: InMemoryPlatformStore) => Promise<T>): Promise<T> {
    return this.repeatableRead(async (client) => {
      const result = await client.query<{ state: PlatformSnapshot }>(
        "SELECT state FROM platform_state WHERE singleton_id = 1"
      );
      if (!result.rows[0]) throw new Error("Platform database is not initialized.");
      const history = await this.loadManagementHistory(client);
      return action(new InMemoryPlatformStore(result.rows[0].state, history));
    });
  }

  private async repeatableRead<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

  private async transact<T>(
    action: (client: PoolClient, store: InMemoryPlatformStore) => Promise<{ result: T; persistState: boolean }>,
    options: {
      loadManagementHistory?: boolean;
      agentRevisionIds?: readonly string[];
      connectorSecretIds?: readonly string[];
      promptIds?: readonly string[];
      credentialSecretIds?: readonly string[];
      goalRuntimeAdmissionIds?: readonly string[];
      utteranceScope?: { kind: "none" } | { kind: "all" } | { kind: "meeting"; meetingId: string };
    } = {}
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const snapshot = await this.lockSnapshot(client, options.utteranceScope ?? { kind: "none" });
      const history = options.loadManagementHistory === false
        ? {}
        : await this.loadManagementHistory(client, {
          ...(options.agentRevisionIds ? { agentRevisionIds: options.agentRevisionIds } : {}),
          ...(options.connectorSecretIds ? { connectorSecretIds: options.connectorSecretIds } : {}),
          ...(options.promptIds ? { promptIds: options.promptIds } : {}),
          ...(options.credentialSecretIds ? { credentialSecretIds: options.credentialSecretIds } : {})
        });
      const goalRuntimeAdmissionDetails = await Promise.all(
        [...new Set(options.goalRuntimeAdmissionIds ?? [])].map(async (goalRunId) => {
          const detail = await this.goals.getGoalRunDetail(goalRunId, client);
          if (!detail) throw new StoreConflictError("Goal Runtime admission record was not found.");
          return {
            goalRun: detail.goalRun,
            executionContract: detail.executionContract,
            taskBindings: detail.taskBindings
          };
        })
      );
      const memory = new InMemoryPlatformStore(snapshot, {
        ...history,
        goalRuntimeAdmissionDetails
      });
      const { result, persistState } = await action(client, memory);
      if (persistState) {
        const next = await memory.getSnapshot();
        const persisted = await this.utteranceProjectionIsComplete(client)
          ? { ...next, utterances: [] }
          : next;
        await client.query(
          "UPDATE platform_state SET state = $1::jsonb, revision = revision + 1, updated_at = now() WHERE singleton_id = 1",
          [JSON.stringify(persisted)]
        );
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockSnapshot(
    client: PoolClient,
    utteranceScope: { kind: "none" } | { kind: "all" } | { kind: "meeting"; meetingId: string }
  ): Promise<PlatformSnapshot> {
    const result = await client.query<{ state: PlatformSnapshot }>(
      "SELECT state FROM platform_state WHERE singleton_id = 1 FOR UPDATE"
    );
    if (!result.rows[0]) throw new Error("Platform database is not initialized.");
    if (utteranceScope.kind === "none") return result.rows[0].state;
    const utterances = await this.loadProjectedUtterances(
      client,
      utteranceScope.kind === "meeting" ? utteranceScope.meetingId : null
    );
    return utterances === null ? result.rows[0].state : { ...result.rows[0].state, utterances };
  }

  private async loadManagementHistory(
    client: PoolClient,
    options: {
      agentRevisionIds?: readonly string[];
      connectorSecretIds?: readonly string[];
      promptIds?: readonly string[];
      credentialSecretIds?: readonly string[];
    } = {}
  ): Promise<{
    agentRevisions: AgentRevision[];
    promptVersions: PromptVersion[];
    credentialSecrets: Array<{ credentialId: string; ciphertext: string }>;
    runtimeProfileRevisions: RuntimeProfileRevision[];
    toolPackRevisions: ToolPackRevision[];
    connectorSecrets: Array<{ connectorId: string; ciphertext: string }>;
  }> {
    const loadAllHistory = options.agentRevisionIds === undefined
      && options.connectorSecretIds === undefined
      && options.promptIds === undefined
      && options.credentialSecretIds === undefined;
    const agentRevisions = await this.loadAgentRevisionHistory(client, options.agentRevisionIds);
    const normalizedPromptIds = [...new Set(options.promptIds ?? [])];
    const promptRows = loadAllHistory
      ? await client.query<{ snapshot: unknown }>("SELECT snapshot FROM prompt_versions ORDER BY prompt_id, version")
      : normalizedPromptIds.length
        ? await client.query<{ snapshot: unknown }>(
            "SELECT snapshot FROM prompt_versions WHERE prompt_id = ANY($1::uuid[]) ORDER BY prompt_id, version",
            [normalizedPromptIds]
          )
        : { rows: [] as { snapshot: unknown }[] };
    const runtimeProfileRows = loadAllHistory
      ? await client.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM runtime_profile_revisions ORDER BY profile_id, revision"
      )
      : { rows: [] as { snapshot: unknown }[] };
    const toolPackRows = loadAllHistory
      ? await client.query<{ snapshot: unknown }>(
        "SELECT snapshot FROM tool_pack_revisions ORDER BY pack_id, revision"
      )
      : { rows: [] as { snapshot: unknown }[] };
    const normalizedCredentialSecretIds = [...new Set(options.credentialSecretIds ?? [])];
    const credentialRows = loadAllHistory
      ? await client.query<{ credentialId: string; ciphertext: string }>(
          'SELECT credential_id AS "credentialId", ciphertext FROM credential_secrets'
        )
      : normalizedCredentialSecretIds.length
        ? await client.query<{ credentialId: string; ciphertext: string }>(
            'SELECT credential_id AS "credentialId", ciphertext FROM credential_secrets WHERE credential_id = ANY($1::uuid[])',
            [normalizedCredentialSecretIds]
          )
        : { rows: [] as { credentialId: string; ciphertext: string }[] };
    const normalizedConnectorSecretIds = [...new Set(options.connectorSecretIds ?? [])];
    const connectorRows = normalizedConnectorSecretIds.length
      ? await client.query<{ connectorId: string; ciphertext: string }>(`
          SELECT connector_id AS "connectorId", ciphertext FROM connector_secrets
          WHERE connector_id = ANY($1::uuid[])
        `, [normalizedConnectorSecretIds])
      : { rows: [] as { connectorId: string; ciphertext: string }[] };
    return {
      agentRevisions,
      promptVersions: promptRows.rows.map((row) => promptVersionSchema.parse(row.snapshot)),
      credentialSecrets: credentialRows.rows,
      runtimeProfileRevisions: runtimeProfileRows.rows.map((row) => runtimeProfileRevisionSchema.parse(row.snapshot)),
      toolPackRevisions: toolPackRows.rows.map((row) => {
        const revision = toolPackRevisionSchema.parse(row.snapshot);
        if (!toolPackManifestDigestIsValid(revision)) {
          throw new StoreConflictError("Tool Pack revision manifest digest does not match its immutable content.");
        }
        return revision;
      }),
      connectorSecrets: connectorRows.rows
    };
  }

  private async loadAgentRevisionHistory(
    client: PoolClient,
    agentIds?: readonly string[]
  ): Promise<AgentRevision[]> {
    if (agentIds?.length === 0) return [];
    const rows = agentIds
      ? await client.query<{ snapshot: unknown }>(
          "SELECT snapshot FROM agent_revisions WHERE agent_id = ANY($1::uuid[]) ORDER BY agent_id, revision",
          [[...new Set(agentIds)]]
        )
      : await client.query<{ snapshot: unknown }>(
          "SELECT snapshot FROM agent_revisions ORDER BY agent_id, revision"
        );
    return rows.rows.map((row) => {
      const revision = agentRevisionSchema.parse(row.snapshot);
      if (!agentRevisionContentDigestIsValid(revision)) {
        throw new StoreConflictError("Agent revision content digest does not match its immutable execution binding.");
      }
      return revision;
    });
  }
}
