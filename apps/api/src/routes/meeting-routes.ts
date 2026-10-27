import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  addTaskEvidenceSchema,
  applyChairSuggestedRoleSchema,
  createDecisionSchema,
  createHumanUtteranceSchema,
  createMeetingSchema,
  createTaskSchema,
  createThreadSchema,
  advanceMeetingAgendaSchema,
  updateThreadSchema,
  moveTaskSchema,
  runAgentSchema,
  runMcpToolSchema,
  runTaskAgentSchema,
  setMeetingAgendaSchema,
  setMeetingAutomationSchema,
  setMeetingModeSchema,
  setTaskApprovalSchema,
  safeParseCouncilJobEnvelope,
  switchParticipantRoleSchema,
  taskSyncRequestSchema,
  updateTaskSchema
} from "@council/contracts";
import type {
  AgentReadinessCheck,
  AgentTurnJobData,
  CredentialBinding,
  Decision,
  McpToolArgumentPayload,
  McpToolCallJobData,
  Meeting,
  ModelConnector,
  PlatformSnapshot,
  RuntimeProfileBinding,
  RuntimeProfileSnapshot,
  SpeakerQueueItem,
  Task,
  TaskAgentRunJobData
} from "@council/contracts";
import {
  chairSuggestionResponseSchema,
  decisionResponseSchema,
  discussionThreadResponseSchema,
  humanUtteranceResponseSchema,
  meetingResponseSchema,
  participantAssignmentResponseSchema,
  queuedJobAcceptanceSchema,
  suggestedRoleResponseSchema,
  taskResponseSchema,
  taskRunResponseSchema,
  taskSyncResponseSchema,
  toolRunAcceptanceSchema
} from "@council/contracts/api-contracts";
import { coordinateChairIntervention, mcpConnectorExecutionFingerprint, mcpToolRequestFingerprint, requestFingerprint, skillHasCurrentApprovedValidation, StoreConflictError, taskAgentAdmissionLeaseActive, taskExecutionFingerprint } from "@council/database";
import {
  authorizeRoleMcpAccess,
  credentialIsExpired,
  createQueuedRuntimeRun,
  encryptMcpToolArguments,
  permittedAgentIdsForMeeting,
  resolveRuntimeProfileAdmission,
  runtimeRunQueueTtlMs,
  stableRuntimeRunId,
  transitionMeeting
} from "@council/domain";
import type { MeetingEvent } from "../event-bus.js";
import { idempotencyKey, parse, parseResponse, sendError, type AppOptions, type AppOptionsFor } from "../route-support.js";
import { mcpToolJobId, meetingSummaryJobId, taskAgentRunJobId, taskSyncJobId } from "../agent-queue.js";
import { getPublishedAgentRuntime } from "../published-agent-readiness.js";

type MeetingAgendaAction = "set" | "activate" | "complete" | "skip";
type DecisionChangeAction = "created" | "approved" | "rejected";
type TaskChangeAction =
  | "created"
  | "updated"
  | "approval_changed"
  | "evidence_added"
  | "status_changed"
  | "agent_run_queued"
  | "agent_run_failed"
  | "sync_queued"
  | "sync_failed";
type MeetingStoreMethod =
  | "addTaskEvidence"
  | "addUtterance"
  | "addUtteranceWithDisposition"
  | "advanceMeetingAgenda"
  | "applyChairSuggestedRole"
  | "confirmChairAutomationJobAdmission"
  | "createRuntimeRun"
  | "createDecision"
  | "createChairSuggestion"
  | "createMeeting"
  | "createTask"
  | "createThread"
  | "dismissChairSuggestion"
  | "failTaskAgentRun"
  | "failTaskSync"
  | "findSession"
  | "getAgentRevision"
  | "getChairAutomationJobAdmissions"
  | "getConnectorSecret"
  | "getSnapshot"
  | "markTaskAgentRunQueued"
  | "markTaskSyncPending"
  | "moveTask"
  | "recordAudit"
  | "releaseChairAutomationJobAdmission"
  | "requireChairAutomationJobReconciliation"
  | "releaseChairSuggestion"
  | "releaseSpeakerTurn"
  | "admitMcpToolCall"
  | "reserveSpeakerTurn"
  | "reserveChairAutomationJobAdmission"
  | "setChairSuggestionPending"
  | "setDecisionStatus"
  | "setMeetingAgenda"
  | "setMeetingAutomation"
  | "setMeetingMode"
  | "setMeetingState"
  | "setMeetingSummaryState"
  | "setTaskApproval"
  | "switchParticipantRole"
  | "updateTask"
  | "updateThread";

type MeetingRouteOptions = AppOptionsFor<MeetingStoreMethod>;
type MeetingEventOptions = Pick<AppOptions, "eventBus">;
const maxSseBufferedBytes = 256 * 1024;
const queueOwnedJobStates = new Set([
  "active",
  "delayed",
  "paused",
  "prioritized",
  "present",
  "waiting",
  "waiting-children"
]);

function humanUtteranceTurnId(meetingId: string, requestKey: string): string {
  return `human:${requestFingerprint({ meetingId, requestKey })}`;
}

function ownerAgentTurnJobId(meetingId: string, requestKey: string): string {
  return `${meetingId}-agent-${requestFingerprint({ meetingId, requestKey }).slice(0, 40)}`;
}

async function inspectQueueJobState(
  queue: NonNullable<AppOptions["agentQueue"]>,
  jobId: string
): Promise<string | null | undefined> {
  if (queue.getJobState) return queue.getJobState(jobId);
  if (queue.hasJob) return await queue.hasJob(jobId) ? "present" : null;
  return undefined;
}

type QueueJobInspection = { state: string; data: unknown };

async function inspectQueueJobEnvelope(
  inspectJob: (jobId: string) => Promise<QueueJobInspection | null>,
  jobId: string,
  timeoutMs: number,
  queueName: string
): Promise<QueueJobInspection | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      inspectJob(jobId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${queueName} queue inspection timed out.`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function agentQueueEnvelopeMatches(
  inspection: QueueJobInspection,
  expected: AgentTurnJobData | SpeakerQueueItem,
  exact: boolean
): boolean {
  const parsed = safeParseCouncilJobEnvelope(inspection.data);
  if (!parsed.success || parsed.data.name !== "agent-turn") return false;
  const observed = parsed.data.data;
  if (exact) return requestFingerprint(observed) === requestFingerprint(expected);
  return "requestFingerprint" in expected
    && typeof expected.requestFingerprint === "string"
    && requestFingerprint(observed) === expected.requestFingerprint;
}

function mcpQueueEnvelopeMatches(inspection: QueueJobInspection, job: McpToolCallJobData): boolean {
  const parsed = safeParseCouncilJobEnvelope(inspection.data);
  if (!parsed.success || parsed.data.name !== "mcp-tool-call") return false;
  const observed = parsed.data.data;
  if (!observed.requestFingerprint || !job.requestFingerprint) return false;
  const ownershipBinding = (value: McpToolCallJobData) => ({
    meetingId: value.meetingId,
    agentId: value.agentId,
    participantId: value.participantId,
    roleRevision: value.roleRevision,
    roleId: value.roleId,
    roleVersion: value.roleVersion,
    requestFingerprint: value.requestFingerprint,
    connectorId: value.connectorId,
    toolName: value.toolName,
    toolSnapshot: value.toolSnapshot,
    connectorFingerprint: value.connectorFingerprint,
    requestedBy: value.requestedBy
  });
  return requestFingerprint(ownershipBinding(observed)) === requestFingerprint(ownershipBinding(job));
}

type TaskAgentRunBinding = Pick<
  TaskAgentRunJobData,
  "executionRevision" | "requestFingerprint" | "agentId" | "executionProfile"
>;

type TaskAgentQueueBinding = TaskAgentRunBinding & Pick<
  TaskAgentRunJobData,
  "taskId" | "taskFingerprint"
>;

function taskAgentQueueEnvelopeMatches(
  inspection: QueueJobInspection,
  expected: TaskAgentRunJobData | TaskAgentQueueBinding,
  exact: boolean
): boolean {
  const parsed = safeParseCouncilJobEnvelope(inspection.data);
  if (!parsed.success || parsed.data.name !== "task-agent-run") return false;
  const observed = parsed.data.data;
  if (exact) return requestFingerprint(observed) === requestFingerprint(expected);
  const ownershipBinding = (value: TaskAgentQueueBinding) => ({
    taskId: value.taskId,
    executionRevision: value.executionRevision,
    requestFingerprint: value.requestFingerprint,
    agentId: value.agentId,
    executionProfile: value.executionProfile,
    taskFingerprint: value.taskFingerprint
  });
  return requestFingerprint(ownershipBinding(observed)) === requestFingerprint(ownershipBinding(expected));
}

async function inspectTaskAgentQueueJob(
  queue: NonNullable<AppOptions["agentQueue"]>,
  jobId: string,
  expected: TaskAgentRunJobData | TaskAgentQueueBinding,
  exact: boolean
): Promise<{ state: string | null | undefined; envelopeMatches: boolean | undefined }> {
  if (queue.inspectJob) {
    const inspection = await inspectQueueJobEnvelope(queue.inspectJob.bind(queue), jobId, 3_000, "Task Agent");
    return {
      state: inspection?.state ?? null,
      envelopeMatches: inspection ? taskAgentQueueEnvelopeMatches(inspection, expected, exact) : undefined
    };
  }
  return { state: await inspectQueueJobState(queue, jobId), envelopeMatches: undefined };
}

function taskAgentRunBindingMatches(task: Task, jobId: string, binding: TaskAgentRunBinding): boolean {
  return task.execution.jobId === jobId
    && task.execution.revision === binding.executionRevision
    && task.execution.requestFingerprint === binding.requestFingerprint
    && task.execution.agentId === binding.agentId
    && task.execution.profile === binding.executionProfile;
}

function createBoundedSseWriter(
  raw: FastifyReply["raw"],
  onOverflow: () => void
): { write(frame: string): boolean; close(): void } {
  const pending: string[] = [];
  let pendingBytes = 0;
  let blocked = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    pendingBytes = 0;
    raw.off("drain", flush);
  };
  const flush = () => {
    if (closed) return;
    blocked = false;
    while (pending.length > 0) {
      const frame = pending.shift()!;
      pendingBytes -= Buffer.byteLength(frame);
      if (!raw.write(frame)) {
        blocked = true;
        raw.once("drain", flush);
        return;
      }
    }
  };
  const write = (frame: string): boolean => {
    if (closed) return false;
    if (blocked) {
      const frameBytes = Buffer.byteLength(frame);
      if (pendingBytes + frameBytes > maxSseBufferedBytes) {
        close();
        onOverflow();
        return false;
      }
      pending.push(frame);
      pendingBytes += frameBytes;
      return true;
    }
    if (!raw.write(frame)) {
      blocked = true;
      raw.once("drain", flush);
    }
    return true;
  };

  return { write, close };
}

async function publishMeetingEvent(
  request: FastifyRequest,
  options: MeetingEventOptions,
  event: MeetingEvent,
  context: Record<string, unknown>,
  failureMessage: string
): Promise<void> {
  try {
    await options.eventBus?.publish(event);
  } catch (error) {
    request.log.error({ err: error, ...context }, failureMessage);
    try {
      options.eventBus?.publishLocal(event);
    } catch (fallbackError) {
      request.log.error({ err: fallbackError, ...context }, "Meeting event local fallback could not be delivered.");
    }
  }
}

type MeetingSummaryScheduleOutcome = "queued" | "pending_reconciliation" | "failed" | "unchanged";

async function recordSecondaryAudit(
  request: FastifyRequest,
  options: MeetingRouteOptions,
  event: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
  failureMessage: string
): Promise<void> {
  try {
    await options.store.recordAudit(event, entityType, entityId, detail);
  } catch (error) {
    request.log.error({ err: error, entityType, entityId, ...detail }, failureMessage);
  }
}

async function recordMeetingSummaryAudit(
  request: FastifyRequest,
  options: MeetingRouteOptions,
  event: string,
  meetingId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await recordSecondaryAudit(
    request,
    options,
    event,
    "meeting",
    meetingId,
    detail,
    "Meeting summary audit could not be recorded."
  );
}

async function keepMeetingSummaryPending(
  request: FastifyRequest,
  options: MeetingRouteOptions,
  meeting: Meeting,
  jobId: string,
  error: unknown,
  classification: string
): Promise<{ meeting: Meeting; outcome: "pending_reconciliation" }> {
  request.log.error(
    { err: error, meetingId: meeting.id, jobId, classification },
    "Meeting summary queue ownership needs durable reconciliation."
  );
  await recordMeetingSummaryAudit(request, options, "meeting.summary.reconciliation_pending", meeting.id, {
    classification,
    jobId
  });
  return { meeting, outcome: "pending_reconciliation" };
}

async function scheduleMeetingSummary(
  request: FastifyRequest,
  options: MeetingRouteOptions,
  meetingId: string,
  queuedAuditEvent: "meeting.summary.queued" | "meeting.summary.requeued"
): Promise<{ meeting: Meeting; outcome: MeetingSummaryScheduleOutcome }> {
  const current = (await options.store.getSnapshot()).meetings.find((meeting) => meeting.id === meetingId);
  if (!current) throw new Error("Meeting not found while scheduling its summary.");
  if (current.summaryState === "completed" || current.summaryState === "queued") {
    return { meeting: current, outcome: "unchanged" };
  }
  if (!options.agentQueue) {
    const meeting = await options.store.setMeetingSummaryState(meetingId, "failed");
    await recordMeetingSummaryAudit(request, options, "meeting.summary.enqueue_failed", meetingId, {
      classification: "queue_unavailable"
    });
    return { meeting, outcome: "failed" };
  }

  const proposedJobId = current.summaryState === "pending" && current.summaryJobId
    ? current.summaryJobId
    : meetingSummaryJobId(meetingId);
  let meeting: Meeting;
  try {
    meeting = await options.store.setMeetingSummaryState(meetingId, "pending", proposedJobId);
  } catch (error) {
    request.log.error({ err: error, meetingId, jobId: proposedJobId }, "Meeting summary reservation could not be written.");
    let latest = current;
    try {
      latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId) ?? current;
    } catch (snapshotError) {
      request.log.error({ err: snapshotError, meetingId }, "Meeting summary state could not be reloaded after reservation failure.");
    }
    if (latest.summaryState === "queued" || latest.summaryState === "completed") {
      return { meeting: latest, outcome: "unchanged" };
    }
    if (latest.summaryState === "failed") return { meeting: latest, outcome: "failed" };
    if (latest.summaryState === "pending" && latest.summaryJobId) {
      meeting = latest;
    } else {
      try {
        meeting = await options.store.setMeetingSummaryState(meetingId, "failed");
      } catch (failureWriteError) {
        request.log.error({ err: failureWriteError, meetingId }, "Meeting summary reservation failure could not be persisted.");
        meeting = latest;
      }
      await recordMeetingSummaryAudit(request, options, "meeting.summary.enqueue_failed", meetingId, {
        classification: "reservation_write_failed",
        jobId: proposedJobId
      });
      return { meeting, outcome: "failed" };
    }
  }
  if (meeting.summaryState === "completed" || meeting.summaryState === "queued") {
    return { meeting, outcome: "unchanged" };
  }
  const requestedJobId = meeting.summaryJobId;
  if (!requestedJobId) throw new Error("Meeting summary reservation did not retain its canonical job ID.");
  const queueCanInspect = Boolean(options.agentQueue.getJobState || options.agentQueue.hasJob);
  let queueAccepted = false;
  try {
    const queued = await options.agentQueue.enqueueMeetingSummary(
      { meetingId, requestedBy: "system" },
      requestedJobId
    );
    if (queued.jobId !== requestedJobId) {
      throw new Error("Meeting summary queue did not honor its reserved job ID.");
    }
    queueAccepted = true;
    if (queueCanInspect) {
      let queueState: string | null | undefined;
      try {
        queueState = await inspectQueueJobState(options.agentQueue, requestedJobId);
      } catch (inspectionError) {
        const latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId) ?? meeting;
        if (latest.summaryState === "queued" || latest.summaryState === "completed") {
          return { meeting: latest, outcome: "unchanged" };
        }
        if (latest.summaryState === "failed") return { meeting: latest, outcome: "failed" };
        return keepMeetingSummaryPending(
          request,
          options,
          latest,
          requestedJobId,
          inspectionError,
          "queue_state_unavailable_after_enqueue"
        );
      }
      if (queueState === null) {
        const latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId) ?? meeting;
        if (latest.summaryState === "queued" || latest.summaryState === "completed") {
          return { meeting: latest, outcome: "unchanged" };
        }
        if (latest.summaryState === "failed") return { meeting: latest, outcome: "failed" };
        return keepMeetingSummaryPending(
          request,
          options,
          latest,
          requestedJobId,
          new Error("The accepted summary job is not yet visible to queue inspection."),
          "queue_state_missing_after_enqueue"
        );
      }
      if (queueState !== undefined && !queueOwnedJobStates.has(queueState)) {
        const latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId) ?? meeting;
        if (latest.summaryState === "queued" || latest.summaryState === "completed") {
          return { meeting: latest, outcome: "unchanged" };
        }
        meeting = await options.store.setMeetingSummaryState(meetingId, "failed", requestedJobId);
        await recordMeetingSummaryAudit(request, options, "meeting.summary.enqueue_failed", meetingId, {
          classification: "queue_state_terminal_after_enqueue",
          jobId: requestedJobId,
          queueState
        });
        return { meeting, outcome: "failed" };
      }
    }
    meeting = await options.store.setMeetingSummaryState(meetingId, "queued", requestedJobId);
    await recordMeetingSummaryAudit(request, options, queuedAuditEvent, meetingId, { jobId: requestedJobId });
    return { meeting, outcome: meeting.summaryState === "queued" ? "queued" : "unchanged" };
  } catch (error) {
    let latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId) ?? meeting;
    if (latest.summaryState === "queued" || latest.summaryState === "completed") {
      request.log.info({ meetingId, jobId: latest.summaryJobId }, "Meeting summary was queued concurrently.");
      return { meeting: latest, outcome: "unchanged" };
    }

    let queueState: string | null | undefined;
    let queueInspectionFailed = false;
    if (!queueAccepted && queueCanInspect) {
      try {
        queueState = await inspectQueueJobState(options.agentQueue, requestedJobId);
      } catch (inspectionError) {
        queueInspectionFailed = true;
        request.log.error(
          { err: inspectionError, meetingId, jobId: requestedJobId },
          "Meeting summary queue ownership could not be inspected."
        );
      }
    }
    const queueOwnsJob = queueState !== undefined && queueState !== null && queueOwnedJobStates.has(queueState);
    if (queueAccepted || queueOwnsJob || queueInspectionFailed || queueState === null) {
      latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId) ?? latest;
      if (latest.summaryState === "queued" || latest.summaryState === "completed") {
        return { meeting: latest, outcome: "unchanged" };
      }
      if (latest.summaryState === "failed") return { meeting: latest, outcome: "failed" };
      return keepMeetingSummaryPending(
        request,
        options,
        latest,
        requestedJobId,
        error,
        queueAccepted
          ? "state_write_failed_after_queue_acceptance"
          : queueOwnsJob
            ? "enqueue_error_but_queue_owned"
            : queueInspectionFailed
              ? "queue_acceptance_unknown"
              : "enqueue_error_queue_state_missing"
      );
    }

    meeting = await options.store.setMeetingSummaryState(
      meetingId,
      "failed",
      queueState !== undefined && queueState !== null ? requestedJobId : null
    );
    request.log.error({ err: error, meetingId }, "Meeting summary job could not be queued.");
    await recordMeetingSummaryAudit(request, options, "meeting.summary.enqueue_failed", meetingId, {
      classification: queueState !== undefined && queueState !== null ? "queue_state_terminal" : "queue_unavailable",
      ...(queueState !== undefined ? { queueState } : {})
    });
    return { meeting, outcome: "failed" };
  }
}

function resolveCredentialBinding(
  snapshot: PlatformSnapshot,
  connector: ModelConnector
): { binding?: CredentialBinding; error?: string } {
  if (!connector.credentialId) {
    if (connector.location === "local" && !connector.hasSecret) return {};
    return { error: "The selected Model Connector has no active Credential binding." };
  }
  const credential = (snapshot.credentials ?? []).find((item) => item.id === connector.credentialId);
  if (!credential || credential.status !== "active" || !credential.hasSecret) {
    return { error: "The selected Model Connector Credential is disabled, revoked, or missing its secret." };
  }
  if (credentialIsExpired(credential.expiresAt)) {
    return { error: "The selected Model Connector Credential is expired." };
  }
  if (credential.secretRevision !== connector.secretRevision) {
    return { error: "The selected Model Connector Credential revision is stale." };
  }
  return {
    binding: {
      credentialId: credential.id,
      secretRevision: credential.secretRevision,
      provider: credential.provider,
      location: credential.location
    }
  };
}

function taskAgentReadinessError(check: AgentReadinessCheck): { code: string; message: string } {
  switch (check.code) {
    case "lifecycle":
      return { code: "TASK_AGENT_NOT_PUBLISHED", message: "The assigned Agent must have a published revision." };
    case "runtime":
      return { code: "TASK_RUNTIME_PROFILE_NOT_READY", message: "The assigned Agent's Runtime Profile is unavailable or no longer permitted." };
    case "model":
      return { code: "MODEL_CONNECTOR_UNAVAILABLE", message: "The assigned Agent Model Connector is disabled or unavailable." };
    case "credential":
      return { code: "TASK_CREDENTIAL_NOT_READY", message: check.message };
    case "prompt":
      return { code: "TASK_PROMPT_NOT_READY", message: check.message };
    case "skill":
      return { code: "TASK_SKILL_BINDING_INVALID", message: check.message };
    case "tool":
      return { code: "TASK_AGENT_NOT_READY", message: `The assigned Agent is not ready: ${check.message}` };
  }
}

function resolveRuntimeProfileSnapshot(
  snapshot: PlatformSnapshot,
  binding: RuntimeProfileBinding | null | undefined,
  agentModelConnectorId: string | null
): RuntimeProfileSnapshot | null {
  try {
    return resolveRuntimeProfileAdmission({
      binding,
      platform: snapshot,
      agentModelConnectorId
    });
  } catch {
    return null;
  }
}

async function publishMeetingAgendaChanged(
  request: FastifyRequest,
  options: MeetingEventOptions,
  meeting: Meeting,
  action: MeetingAgendaAction
): Promise<void> {
  await publishMeetingEvent(
    request,
    options,
    {
      type: "meeting.agenda.changed",
      meetingId: meeting.id,
      data: {
        revision: meeting.agenda.revision,
        action,
        currentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null
      },
      occurredAt: new Date().toISOString()
    },
    { meetingId: meeting.id, revision: meeting.agenda.revision, action },
    "Meeting Agenda event could not be published."
  );
}

async function publishMeetingAutomationChanged(
  request: FastifyRequest,
  options: MeetingEventOptions,
  meeting: Meeting
): Promise<void> {
  await publishMeetingEvent(
    request,
    options,
    {
      type: "meeting.automation.changed",
      meetingId: meeting.id,
      data: {
        automation: meeting.automation,
        automationRevision: meeting.automationRevision ?? 0
      },
      occurredAt: new Date().toISOString()
    },
    {
      meetingId: meeting.id,
      automation: meeting.automation,
      automationRevision: meeting.automationRevision ?? 0
    },
    "Meeting Chair automation event could not be published."
  );
}

async function publishDecisionChanged(
  request: FastifyRequest,
  options: MeetingEventOptions,
  decision: Pick<Decision, "id" | "meetingId" | "status">,
  action: DecisionChangeAction
): Promise<void> {
  await publishMeetingEvent(
    request,
    options,
    {
      type: "decision.changed",
      meetingId: decision.meetingId,
      data: { decisionId: decision.id, status: decision.status, action },
      occurredAt: new Date().toISOString()
    },
    { meetingId: decision.meetingId, decisionId: decision.id, action },
    "Decision refresh event could not be published."
  );
}

async function publishTaskChanged(
  request: FastifyRequest,
  options: MeetingEventOptions,
  task: Pick<Task, "id" | "meetingId" | "status">,
  action: TaskChangeAction
): Promise<void> {
  await publishMeetingEvent(
    request,
    options,
    {
      type: "task.changed",
      meetingId: task.meetingId,
      data: { taskId: task.id, status: task.status, action },
      occurredAt: new Date().toISOString()
    },
    { meetingId: task.meetingId, taskId: task.id, action },
    "Task refresh event could not be published."
  );
}

async function publishSpeakerQueueChanged(
  request: FastifyRequest,
  options: MeetingEventOptions,
  item: SpeakerQueueItem,
  status: SpeakerQueueItem["status"] | "released",
  reason?: string
): Promise<void> {
  await publishMeetingEvent(
    request,
    options,
    {
      type: "speaker.queue.changed",
      meetingId: item.meetingId,
      data: {
        jobId: item.jobId,
        participantId: item.participantId,
        agentId: item.agentId,
        kind: item.kind,
        label: item.label,
        toolName: item.toolName,
        roleRevision: item.roleRevision,
        roleId: item.roleId,
        roleVersion: item.roleVersion,
        roleName: item.roleName,
        status,
        leaseExpiresAt: item.leaseExpiresAt,
        ...(reason ? { reason } : {})
      },
      occurredAt: new Date().toISOString()
    },
    { meetingId: item.meetingId, jobId: item.jobId, status },
    "Speaker queue event could not be published."
  );
}

type AgentTurnReplayDisposition = "missing" | "matching" | "conflict";
type AgentTurnTerminalReconciliation = Exclude<AgentTurnReplayDisposition, "missing"> | "released" | "unresolved";

function agentTurnReplayDisposition(
  snapshot: PlatformSnapshot,
  meetingId: string,
  agentId: string,
  jobId: string,
  chairSuggestionId: string | null
): AgentTurnReplayDisposition {
  const utterance = snapshot.utterances.find((item) => item.turnId === jobId);
  if (!utterance) return "missing";
  const boundSuggestion = snapshot.chairSuggestions.find((suggestion) => (
    suggestion.requestedAgentJobId === jobId
    || suggestion.transitions.some((transition) => transition.jobId === jobId)
  ));
  return utterance.meetingId === meetingId
    && utterance.agentId === agentId
    && (boundSuggestion?.id ?? null) === chairSuggestionId
    ? "matching"
    : "conflict";
}

async function reconcileTerminalAgentTurnReservation(
  request: FastifyRequest,
  options: MeetingRouteOptions,
  reservation: SpeakerQueueItem,
  queueState: string | null
): Promise<AgentTurnTerminalReconciliation> {
  const durableDisposition = agentTurnReplayDisposition(
    await options.store.getSnapshot(),
    reservation.meetingId,
    reservation.agentId,
    reservation.jobId,
    reservation.chairSuggestionId ?? null
  );
  if (durableDisposition !== "missing") return durableDisposition;

  const reason = queueState === null ? "queue_job_missing" : `queue_job_${queueState}`;
  let releaseFailed = false;
  if (reservation.chairSuggestionId) {
    await options.store.releaseChairSuggestion(
      reservation.chairSuggestionId,
      reservation.jobId,
      `Agent queue reconciliation released the reservation (${reason}).`
    ).catch((error) => {
      releaseFailed = true;
      request.log.error(
        { err: error, meetingId: reservation.meetingId, chairSuggestionId: reservation.chairSuggestionId, jobId: reservation.jobId },
        "Chair suggestion could not be released during Agent queue reconciliation."
      );
    });
  }
  const released = await options.store.releaseSpeakerTurn(
    reservation.jobId,
    reason,
    reservation.reservationId ?? undefined
  ).catch((error) => {
    releaseFailed = true;
    request.log.error(
      { err: error, meetingId: reservation.meetingId, jobId: reservation.jobId, queueState },
      "Speaker reservation could not be released during Agent queue reconciliation."
    );
    return null;
  });
  if (released) await publishSpeakerQueueChanged(request, options, released, "released", reason);

  const latest = await options.store.getSnapshot();
  const latestDisposition = agentTurnReplayDisposition(
    latest,
    reservation.meetingId,
    reservation.agentId,
    reservation.jobId,
    reservation.chairSuggestionId ?? null
  );
  if (latestDisposition !== "missing") return latestDisposition;
  return releaseFailed || latest.speakerQueue.some((item) => item.jobId === reservation.jobId)
    ? "unresolved"
    : "released";
}

function sendAgentTurnTerminalReconciliation(
  reply: FastifyReply,
  result: AgentTurnTerminalReconciliation,
  jobId: string
) {
  if (result === "matching") {
    return reply.code(202).send(parseResponse(queuedJobAcceptanceSchema, { jobId }));
  }
  if (result === "conflict") {
    return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different Agent turn.");
  }
  if (result === "unresolved") {
    return sendError(reply, 503, "AGENT_TURN_RECONCILIATION_REQUIRED", "The terminal Agent queue job could not be reconciled safely.");
  }
  return sendError(
    reply,
    409,
    "AGENT_TURN_RECONCILIATION_REQUIRED",
    "The retained Agent queue job is terminal and cannot be replayed; use a new Idempotency-Key for another turn."
  );
}

export function registerMeetingRoutes(app: FastifyInstance, options: MeetingRouteOptions): void {
  const activeEventStreamDisconnects = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const disconnect of [...activeEventStreamDisconnects]) disconnect();
  });

  app.get("/api/meetings/:id/events", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    if (!options.eventBus) return sendError(reply, 503, "EVENTS_UNAVAILABLE", "Event stream is not configured.");
    const ownerSession = request.ownerSession;
    const sessionAuthorizationRequired = !(options.authDisabled ?? false);
    if (sessionAuthorizationRequired && (
      !ownerSession
      || new Date(ownerSession.expiresAt).getTime() <= Date.now()
    )) {
      return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
    }
    const pendingEvents: string[] = [];
    let pendingEventBytes = 0;
    const pendingAuthorizedFrames: string[] = [];
    let pendingAuthorizedBytes = 0;
    let authorizationFlushRunning = false;
    let ready = false;
    let closed = Boolean(request.raw.destroyed);
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let sessionExpiry: ReturnType<typeof setTimeout> | null = null;
    let writer: ReturnType<typeof createBoundedSseWriter> | null = null;
    const cleanup = () => {
      closed = true;
      activeEventStreamDisconnects.delete(disconnect);
      writer?.close();
      pendingEvents.length = 0;
      pendingEventBytes = 0;
      pendingAuthorizedFrames.length = 0;
      pendingAuthorizedBytes = 0;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (sessionExpiry) {
        clearTimeout(sessionExpiry);
        sessionExpiry = null;
      }
      const stop = unsubscribe;
      unsubscribe = null;
      stop?.();
    };
    const disconnect = () => {
      if (closed) {
        activeEventStreamDisconnects.delete(disconnect);
        return;
      }
      cleanup();
      reply.raw.destroy();
    };
    const sessionIsActive = async (): Promise<boolean> => {
      if (!sessionAuthorizationRequired) return true;
      if (!ownerSession || new Date(ownerSession.expiresAt).getTime() <= Date.now()) return false;
      try {
        const current = await options.store.findSession(ownerSession.tokenHash);
        return Boolean(current
          && current.userId === ownerSession.userId
          && current.tokenHash === ownerSession.tokenHash
          && new Date(current.expiresAt).getTime() > Date.now());
      } catch (error) {
        request.log.error({ err: error, meetingId: id }, "Meeting event stream session could not be revalidated.");
        return false;
      }
    };
    const flushAuthorizedFrames = async () => {
      if (authorizationFlushRunning || closed) return;
      authorizationFlushRunning = true;
      try {
        while (!closed && pendingAuthorizedFrames.length > 0) {
          if (!(await sessionIsActive())) {
            disconnect();
            return;
          }
          const frame = pendingAuthorizedFrames.shift()!;
          pendingAuthorizedBytes -= Buffer.byteLength(frame);
          if (!writer?.write(frame)) return;
        }
      } finally {
        authorizationFlushRunning = false;
      }
    };
    const writeAuthorizedFrame = (frame: string): boolean => {
      if (closed) return false;
      if (!sessionAuthorizationRequired) return writer?.write(frame) ?? false;
      const frameBytes = Buffer.byteLength(frame);
      if (pendingAuthorizedBytes + frameBytes > maxSseBufferedBytes) {
        request.log.error({ meetingId: id }, "Meeting event stream exceeded its bounded authorization buffer.");
        disconnect();
        return false;
      }
      pendingAuthorizedFrames.push(frame);
      pendingAuthorizedBytes += frameBytes;
      void flushAuthorizedFrames();
      return true;
    };
    request.raw.once("close", cleanup);
    activeEventStreamDisconnects.add(disconnect);
    try {
      const stop = await options.eventBus.subscribe(id, (event) => {
        if (closed) return;
        const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        if (!ready) {
          const frameBytes = Buffer.byteLength(frame);
          if (pendingEventBytes + frameBytes > maxSseBufferedBytes) {
            request.log.error({ meetingId: id }, "Meeting event stream exceeded its bounded pre-ready buffer.");
            disconnect();
            return;
          }
          pendingEvents.push(frame);
          pendingEventBytes += frameBytes;
          return;
        }
        writeAuthorizedFrame(frame);
      });
      if (closed) {
        stop();
        cleanup();
        reply.hijack();
        return;
      }
      unsubscribe = stop;
      if (!(await sessionIsActive())) {
        request.raw.off("close", cleanup);
        cleanup();
        return sendError(reply, 401, "UNAUTHORIZED", "Authentication required.");
      }
      if (closed) {
        request.raw.off("close", cleanup);
        reply.hijack();
        return;
      }
    } catch (error) {
      request.raw.off("close", cleanup);
      if (closed) {
        reply.hijack();
        return;
      }
      request.log.error({ err: error, meetingId: id }, "Meeting event subscription could not be established.");
      return sendError(reply, 503, "EVENTS_UNAVAILABLE", "Event stream is temporarily unavailable.");
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    writer = createBoundedSseWriter(reply.raw, () => {
      request.log.error({ meetingId: id }, "Meeting event stream exceeded its bounded slow-client buffer.");
      cleanup();
      reply.raw.destroy();
    });
    writer.write(`event: ready\ndata: ${JSON.stringify({ meetingId: id })}\n\n`);
    ready = true;
    for (const frame of pendingEvents) {
      if (!writeAuthorizedFrame(frame)) break;
    }
    pendingEvents.length = 0;
    pendingEventBytes = 0;
    heartbeat = setInterval(() => writeAuthorizedFrame(": heartbeat\n\n"), 15_000);
    if (sessionAuthorizationRequired && ownerSession) {
      sessionExpiry = setTimeout(disconnect, new Date(ownerSession.expiresAt).getTime() - Date.now());
    }
  });

  app.post("/api/threads", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const thread = await options.store.createThread(parse(createThreadSchema, request.body), requestKey);
    return reply.code(201).send(parseResponse(discussionThreadResponseSchema, thread));
  });

  app.patch("/api/threads/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const thread = await options.store.updateThread(id, parse(updateThreadSchema, request.body));
    return reply.send(parseResponse(discussionThreadResponseSchema, thread));
  });

  app.post("/api/meetings", async (request, reply) => {
    const input = parse(createMeetingSchema, request.body);
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const meeting = await options.store.createMeeting(input, requestKey, "runnable");
    return reply.code(201).send(parseResponse(meetingResponseSchema, meeting));
  });

  app.patch("/api/meetings/:id/agenda", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(setMeetingAgendaSchema, request.body);
    const meeting = await options.store.setMeetingAgenda(id, input);
    if (meeting.agenda.revision !== input.expectedRevision) {
      await publishMeetingAgendaChanged(request, options, meeting, "set");
    }
    return reply.send(parseResponse(meetingResponseSchema, meeting));
  });

  app.post("/api/meetings/:id/agenda/advance", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(advanceMeetingAgendaSchema, request.body);
    const meeting = await options.store.advanceMeetingAgenda(id, input);
    await publishMeetingAgendaChanged(request, options, meeting, input.action);
    return reply.send(parseResponse(meetingResponseSchema, meeting));
  });

  for (const [action, event] of [["start", "start"], ["pause", "pause"], ["resume", "resume"], ["close", "close"]] as const) {
    app.post(`/api/meetings/:id/${action}`, async (request, reply) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
      const beforeSnapshot = await options.store.getSnapshot();
      const current = beforeSnapshot.meetings.find((meeting) => meeting.id === id);
      if (!current) return sendError(reply, 404, "NOT_FOUND", "Meeting not found.");
      const invalidatedAction = action === "close"
        ? beforeSnapshot.speakerQueue.find((item) => item.meetingId === id) ?? null
        : null;
      let alreadyClosed = action === "close" && current.state === "closed";
      let meeting: Meeting;
      if (alreadyClosed) {
        meeting = current;
      } else {
        try {
          meeting = await options.store.setMeetingState(id, transitionMeeting(current.state, event), current.state);
        } catch (error) {
          if (action !== "close" || !(error instanceof StoreConflictError)) throw error;
          const latest = (await options.store.getSnapshot()).meetings.find((candidate) => candidate.id === id);
          if (!latest || latest.state !== "closed") throw error;
          alreadyClosed = true;
          meeting = latest;
        }
      }
      if (!alreadyClosed && invalidatedAction) {
        await publishSpeakerQueueChanged(request, options, invalidatedAction, "released", "meeting_closed");
      }
      if (meeting.agenda.revision !== current.agenda.revision) {
        await publishMeetingAgendaChanged(request, options, meeting, "activate");
      }
      if (action === "close" && meeting.summaryState !== "completed" && meeting.summaryState !== "queued") {
        meeting = (await scheduleMeetingSummary(request, options, id, "meeting.summary.queued")).meeting;
      }
      return reply.send(parseResponse(meetingResponseSchema, meeting));
    });
  }

  app.post("/api/meetings/:id/summary/retry", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const current = (await options.store.getSnapshot()).meetings.find((meeting) => meeting.id === id);
    if (!current) return sendError(reply, 404, "NOT_FOUND", "Meeting not found.");
    if (current.state !== "closed") return sendError(reply, 409, "MEETING_NOT_CLOSED", "Only a closed Meeting can retry its summary.");
    if (current.summaryState === "completed" || current.summaryState === "queued") {
      return reply.send(parseResponse(meetingResponseSchema, current));
    }

    const scheduled = await scheduleMeetingSummary(request, options, id, "meeting.summary.requeued");
    if (scheduled.outcome === "pending_reconciliation") {
      return reply.code(202).send(parseResponse(meetingResponseSchema, scheduled.meeting));
    }
    if (scheduled.outcome === "failed") {
      return sendError(reply, 503, "SUMMARY_QUEUE_UNAVAILABLE", "Meeting summary could not be queued.");
    }
    return reply.send(parseResponse(meetingResponseSchema, scheduled.meeting));
  });

  app.post("/api/meetings/:id/utterances", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(createHumanUtteranceSchema, request.body);
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const turnId = humanUtteranceTurnId(id, requestKey);
    const snapshot = await options.store.getSnapshot();
    const current = snapshot.meetings.find((meeting) => meeting.id === id);
    if (!current) return sendError(reply, 404, "NOT_FOUND", "Meeting not found.");
    let utterance = snapshot.utterances.find((item) => item.turnId === turnId);
    if (utterance) {
      if (utterance.meetingId !== id
        || utterance.speakerType !== "human"
        || utterance.speakerName !== "Owner"
        || utterance.roleName !== "決策者"
        || utterance.kind !== "human"
        || utterance.evidenceCount !== 0
        || utterance.content !== input.content) {
        return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different Human utterance.");
      }
      const existingUtteranceId = utterance.id;
      const existingSuggestion = snapshot.chairSuggestions.find((suggestion) => suggestion.sourceUtteranceId === existingUtteranceId);
      if (existingSuggestion) {
        const admission = current.state === "active"
          && current.automation === "auto"
          && existingSuggestion.status === "open"
          ? (await options.store.getChairAutomationJobAdmissions())
              .find((item) => item.chairSuggestionId === existingSuggestion.id)
          : undefined;
        if (current.state !== "active"
          || current.automation !== "auto"
          || existingSuggestion.status !== "open"
          || admission?.status === "admitted"
          || admission?.status === "reconciliation_required") {
          return reply.code(201).send(parseResponse(humanUtteranceResponseSchema, {
            utterance,
            chairSuggestion: existingSuggestion
          }));
        }
      }
    } else {
      if (current.state !== "active") return sendError(reply, 409, "MEETING_NOT_ACTIVE", "The meeting must be active before posting a message.");
      const utteranceResult = await options.store.addUtteranceWithDisposition(id, {
        turnId,
        speakerType: "human",
        speakerName: "Owner",
        roleName: "決策者",
        content: input.content,
        kind: "human",
        evidenceCount: 0
      });
      utterance = utteranceResult.utterance;
      if (utteranceResult.status === "existing") {
        const latest = await options.store.getSnapshot();
        const existingUtteranceId = utterance.id;
        const chairSuggestion = latest.chairSuggestions.find((suggestion) => suggestion.sourceUtteranceId === existingUtteranceId) ?? null;
        return reply.code(201).send(parseResponse(humanUtteranceResponseSchema, {
          utterance,
          chairSuggestion
        }));
      }
      await publishMeetingEvent(
        request,
        options,
        { type: "utterance.created", meetingId: id, data: { utterance }, occurredAt: new Date().toISOString() },
        { meetingId: id, utteranceId: utterance.id },
        "Utterance event could not be published."
      );
    }
    let coordinated: Awaited<ReturnType<typeof coordinateChairIntervention>>;
    try {
      coordinated = await coordinateChairIntervention({
        store: options.store,
        meetingId: id,
        sourceUtteranceId: utterance.id,
        ...(options.agentQueue?.enqueueChairAutomation
          ? { enqueue: (job, requestedJobId) => options.agentQueue!.enqueueChairAutomation!(job, requestedJobId) }
          : {}),
        ...(options.agentQueue?.getJobState
          ? { getJobState: (jobId) => options.agentQueue!.getJobState!(jobId) }
          : {}),
        ...(options.agentQueue?.hasJob ? { hasJob: (jobId) => options.agentQueue!.hasJob!(jobId) } : {})
      });
    } catch (error) {
      request.log.error(
        { err: error, meetingId: id, utteranceId: utterance.id },
        "Chair coordination failed after the utterance was committed."
      );
      coordinated = { suggestion: null, disposition: "stale_policy", jobId: null };
    }
    const chairSuggestion = coordinated.suggestion;
    if (chairSuggestion) {
      await publishMeetingEvent(
        request,
        options,
        { type: "chair.suggestion", meetingId: id, data: { suggestion: chairSuggestion }, occurredAt: new Date().toISOString() },
        { meetingId: id, chairSuggestionId: chairSuggestion.id },
        "Chair suggestion event could not be published."
      );
    }
    if (coordinated.disposition === "queue_unavailable") {
      await publishMeetingEvent(
        request,
        options,
        {
          type: "chair.automation.failed",
          meetingId: id,
          data: {
            chairSuggestionId: chairSuggestion?.id ?? null,
            classification: "queue_unavailable"
          },
          occurredAt: new Date().toISOString()
        },
        { meetingId: id, chairSuggestionId: chairSuggestion?.id ?? null },
        "Chair automation failure event could not be published."
      );
    }
    return reply.code(201).send(parseResponse(humanUtteranceResponseSchema, {
      utterance,
      chairSuggestion
    }));
  });

  app.patch("/api/meetings/:id/automation", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(setMeetingAutomationSchema, request.body);
    const meeting = await options.store.setMeetingAutomation(id, input);
    await publishMeetingAutomationChanged(request, options, meeting);
    return reply.send(parseResponse(meetingResponseSchema, meeting));
  });

  app.post("/api/meetings/:id/mode", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(setMeetingModeSchema, request.body);
    const current = (await options.store.getSnapshot()).meetings.find((meeting) => meeting.id === id);
    if (!current) return sendError(reply, 404, "NOT_FOUND", "Meeting not found.");
    if (current.state === "closed") return sendError(reply, 409, "MEETING_CLOSED", "A closed Meeting cannot change mode.");
    const changed = await options.store.setMeetingMode(id, input);
    await publishMeetingEvent(
      request,
      options,
      {
        type: "meeting.mode.changed",
        meetingId: id,
        data: {
          mode: input.mode,
          reason: input.reason,
          chairSuggestion: changed.chairSuggestion,
          resolvedSuggestionIds: changed.resolvedSuggestionIds
        },
        occurredAt: new Date().toISOString()
      },
      { meetingId: id, mode: input.mode },
      "Meeting mode event could not be published."
    );
    return reply.send(parseResponse(meetingResponseSchema, changed.meeting));
  });

  app.patch("/api/meetings/:meetingId/participants/:participantId/role", async (request, reply) => {
    const { meetingId, participantId } = parse(
      z.object({ meetingId: z.string().uuid(), participantId: z.string().uuid() }),
      request.params
    );
    const participant = await options.store.switchParticipantRole(
      meetingId,
      participantId,
      parse(switchParticipantRoleSchema, request.body)
    );
    await publishMeetingEvent(
      request,
      options,
      {
        type: "meeting.participant.role.changed",
        meetingId,
        data: {
          participantId: participant.id,
          agentId: participant.agentId,
          roleId: participant.roleId,
          roleVersion: participant.roleSnapshot.version,
          roleRevision: participant.roleRevision
        },
        occurredAt: new Date().toISOString()
      },
      { meetingId, participantId },
      "Participant Role event could not be published."
    );
    return reply.send(parseResponse(participantAssignmentResponseSchema, participant));
  });

  app.post("/api/meetings/:meetingId/chair-suggestions/:suggestionId/role", async (request, reply) => {
    const { meetingId, suggestionId } = parse(
      z.object({ meetingId: z.string().uuid(), suggestionId: z.string().uuid() }),
      request.params
    );
    const suggestion = (await options.store.getSnapshot()).chairSuggestions.find((item) => item.id === suggestionId);
    if (!suggestion || suggestion.meetingId !== meetingId) {
      return sendError(reply, 404, "NOT_FOUND", "Chair Role suggestion not found for this Meeting.");
    }
    const result = await options.store.applyChairSuggestedRole(
      suggestionId,
      parse(applyChairSuggestedRoleSchema, request.body)
    );
    await publishMeetingEvent(
      request,
      options,
      {
        type: "meeting.participant.role.changed",
        meetingId,
        data: {
          participantId: result.participant.id,
          agentId: result.participant.agentId,
          roleId: result.participant.roleId,
          roleVersion: result.participant.roleSnapshot.version,
          roleRevision: result.participant.roleRevision,
          chairSuggestionId: result.suggestion.id
        },
        occurredAt: new Date().toISOString()
      },
      { meetingId, suggestionId, participantId: result.participant.id },
      "Chair-suggested participant Role event could not be published."
    );
    await publishMeetingEvent(
      request,
      options,
      {
        type: "chair.suggestion.updated",
        meetingId,
        data: { suggestion: result.suggestion },
        occurredAt: new Date().toISOString()
      },
      { meetingId, suggestionId },
      "Chair Role suggestion event could not be published."
    );
    return reply.send(parseResponse(suggestedRoleResponseSchema, result));
  });

  app.post("/api/meetings/:id/run", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { agentId, chairSuggestionId } = parse(runAgentSchema, request.body);
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const snapshot = await options.store.getSnapshot();
    const meeting = snapshot.meetings.find((item) => item.id === id);
    if (!meeting) return sendError(reply, 404, "NOT_FOUND", "Meeting not found.");
    const requestedJobId = ownerAgentTurnJobId(id, requestKey);
    const inspectAgentJobCapability = options.agentQueue?.inspectJob?.bind(options.agentQueue);
    const inspectAgentJob = inspectAgentJobCapability
      ? (jobId: string) => inspectQueueJobEnvelope(inspectAgentJobCapability, jobId, 3_000, "Agent")
      : null;
    const queuedReplay = snapshot.speakerQueue.find((item) => item.jobId === requestedJobId);
    if (queuedReplay) {
      if (queuedReplay.kind !== "agent_turn"
        || queuedReplay.meetingId !== id
        || queuedReplay.agentId !== agentId
        || (queuedReplay.chairSuggestionId ?? null) !== (chairSuggestionId ?? null)) {
        return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different Agent turn.");
      }
      if (!inspectAgentJob) {
        return sendError(reply, 503, "AGENT_TURN_QUEUE_UNAVAILABLE", "Agent queue cannot prove exact job-envelope ownership.");
      }
      let queueInspection: QueueJobInspection | null;
      try {
        queueInspection = await inspectAgentJob(requestedJobId);
      } catch (error) {
        request.log.error({ err: error, meetingId: id, jobId: requestedJobId }, "Agent turn replay queue envelope could not be inspected.");
        return sendError(reply, 503, "AGENT_TURN_QUEUE_UNAVAILABLE", "Agent queue ownership could not be verified safely.");
      }
      if (queueInspection === null || !queueOwnedJobStates.has(queueInspection.state)) {
        const reconciled = await reconcileTerminalAgentTurnReservation(request, options, queuedReplay, queueInspection?.state ?? null);
        return sendAgentTurnTerminalReconciliation(reply, reconciled, requestedJobId);
      }
      if (!agentQueueEnvelopeMatches(queueInspection, queuedReplay, false)) {
        return sendError(reply, 409, "AGENT_TURN_QUEUE_OWNERSHIP_CONFLICT", "The retained Agent queue job does not match the persisted reservation.");
      }
      return reply.code(202).send(parseResponse(queuedJobAcceptanceSchema, { jobId: requestedJobId }));
    }
    const terminalDisposition = agentTurnReplayDisposition(
      snapshot,
      id,
      agentId,
      requestedJobId,
      chairSuggestionId ?? null
    );
    if (terminalDisposition === "conflict") {
      return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different Agent turn.");
    }
    if (terminalDisposition === "matching") {
      return reply.code(202).send(parseResponse(queuedJobAcceptanceSchema, { jobId: requestedJobId }));
    }
    if (!options.agentQueue) return sendError(reply, 503, "QUEUE_UNAVAILABLE", "Agent worker queue is not configured.");
    if (meeting.state !== "active") return sendError(reply, 409, "MEETING_NOT_ACTIVE", "Meeting must be active.");
    const chairSuggestion = chairSuggestionId
      ? snapshot.chairSuggestions.find((item) => item.id === chairSuggestionId)
      : undefined;
    if (chairSuggestionId && !chairSuggestion) return sendError(reply, 404, "NOT_FOUND", "Chair suggestion not found.");
    if (chairSuggestion && (
      chairSuggestion.meetingId !== id
      || chairSuggestion.status !== "open"
      || chairSuggestion.suggestedAgentId !== agentId
    )) {
      return sendError(reply, 409, "CHAIR_SUGGESTION_STALE", "Chair suggestion is no longer available for this Agent action.");
    }
    if (chairSuggestion && chairSuggestion.suggestedMode !== meeting.mode) {
      return sendError(reply, 409, "CHAIR_MODE_REQUIRED", "Apply the suggested Meeting mode before requesting the Chair Agent.");
    }
    const participant = snapshot.participants.find((item) => item.meetingId === id && item.agentId === agentId);
    const agent = snapshot.agents.find((item) => item.id === agentId);
    if (!participant || !agent) return sendError(reply, 403, "AGENT_NOT_ASSIGNED", "Agent is not assigned to this meeting.");
    if (agent.lifecycleStatus === "disabled") return sendError(reply, 409, "AGENT_DISABLED", "Agent is disabled.");
    const revision = participant.agentRevision === undefined
      ? null
      : await options.store.getAgentRevision(agent.id, participant.agentRevision);
    if (!revision) {
      return sendError(reply, 409, "RUNTIME_PROFILE_NOT_READY", "The Agent's bound Runtime Profile is unavailable or no longer permitted.");
    }
    const modelConnectorId = revision.modelConnectorId;
    const runtimeProfileSnapshot = resolveRuntimeProfileSnapshot(
      snapshot,
      revision.runtimeProfileBinding,
      modelConnectorId
    );
    if (!runtimeProfileSnapshot) {
      return sendError(reply, 409, "RUNTIME_PROFILE_NOT_READY", "The Agent's bound Runtime Profile is unavailable or no longer permitted.");
    }
    const modelConnector = snapshot.modelConnectors.find((item) => item.id === modelConnectorId && item.enabled);
    if (!modelConnector) return sendError(reply, 409, "MODEL_NOT_CONFIGURED", "Agent has no enabled model connector.");
    const credential = resolveCredentialBinding(snapshot, modelConnector);
    if (credential.error) return sendError(reply, 409, "CREDENTIAL_NOT_READY", credential.error);
    const promptBinding = revision.promptBinding ?? null;
    if (promptBinding) {
      const prompt = (snapshot.prompts ?? []).find((item) => item.id === promptBinding.promptId);
      if (!prompt || prompt.kind !== "agent" || prompt.status === "archived" || prompt.publishedVersion === null || prompt.publishedVersion < promptBinding.version) {
        return sendError(reply, 409, "PROMPT_NOT_READY", "The Agent's published Prompt binding is no longer available.");
      }
    }
    const skillIds = revision.skillIds;
    const skills = skillIds.map((skillId) => snapshot.skills.find((skill) => skill.id === skillId));
    if (skills.some((skill) => !skill || !skillHasCurrentApprovedValidation(skill))) {
      return sendError(reply, 409, "AGENT_SKILL_BINDING_INVALID", "The Agent has a Skill that is no longer approved and valid.");
    }
    if (meeting.mode !== "open" && !permittedAgentIdsForMeeting(snapshot, id).includes(agentId)) {
      if (meeting.mode === "fixed") {
        return sendError(reply, 409, "FIXED_ORDER_VIOLATION", "The fixed meeting order requires another Agent to speak next.");
      }
      return sendError(reply, 409, "CHAIR_ORDER_VIOLATION", "The chair must alternate between moderating and inviting one role to speak.");
    }
    const runtimeRun = createQueuedRuntimeRun({
      id: randomUUID(),
      kind: "meeting_turn",
      scope: {
        id: `meeting:${meeting.id}:participant:${participant.id}`,
        kind: "meeting_participant",
        subjectId: participant.id,
        parentScopeId: `meeting:${meeting.id}`
      },
      runtimeProfile: runtimeProfileSnapshot,
      agentId,
      agentRevision: revision.revision,
      roleId: participant.roleId,
      roleRevision: participant.roleRevision,
      attempt: 1,
      idempotencyKey: requestedJobId,
      queuedAt: new Date().toISOString(),
      ttlMs: runtimeRunQueueTtlMs(runtimeProfileSnapshot)
    });
    const job = {
      meetingId: id,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner",
      modelConnectorBinding: {
        id: modelConnector.id,
        location: modelConnector.location,
        baseUrl: modelConnector.baseUrl,
        model: modelConnector.model,
        secretRevision: modelConnector.secretRevision
      },
      agentRevision: revision.revision,
      promptBinding,
      ...(credential.binding ? { credentialBinding: credential.binding } : {}),
      skillDigests: Object.fromEntries(skills.map((skill) => [skill!.id, skill!.contentDigest])),
      runtimeProfileBinding: { ...revision.runtimeProfileBinding! },
      runtimeProfileSnapshot,
      runtimeRun,
      ...(chairSuggestionId ? { chairSuggestionId } : {})
    } as const;
    if (!inspectAgentJob) {
      return sendError(reply, 503, "AGENT_TURN_QUEUE_UNAVAILABLE", "Agent queue cannot prove exact job-envelope ownership.");
    }
    const reservation = await options.store.reserveSpeakerTurn(requestedJobId, job);
    if (!reservation.reservationId) {
      throw new Error("Agent speaker reservation is missing its execution identity.");
    }
    const reservedJob: AgentTurnJobData = { ...job, reservationId: reservation.reservationId };
    let pendingSuggestion: Awaited<ReturnType<AppOptions["store"]["setChairSuggestionPending"]>> | null = null;
    let queued: { jobId: string } = { jobId: requestedJobId };
    try {
      if (chairSuggestionId) {
        pendingSuggestion = await options.store.setChairSuggestionPending(chairSuggestionId, agentId, requestedJobId);
        if (pendingSuggestion.suggestion.status !== "pending"
          || pendingSuggestion.suggestion.requestedAgentJobId !== requestedJobId) {
          throw Object.assign(new Error("Chair suggestion changed before its Agent action was queued."), { statusCode: 409 });
        }
      }
      queued = await options.agentQueue.enqueue(reservedJob, requestedJobId);
      if (queued.jobId !== requestedJobId) {
        throw Object.assign(new Error("The Agent queue returned a different job ID than the persisted reservation."), { statusCode: 409 });
      }
      let queueInspection: QueueJobInspection | null;
      try {
        queueInspection = await inspectAgentJob(requestedJobId);
      } catch (inspectionError) {
        throw Object.assign(
          new Error("Agent queue acceptance could not be inspected after enqueue."),
          { cause: inspectionError, statusCode: 503 }
        );
      }
      if (queueInspection === null || !queueOwnedJobStates.has(queueInspection.state)) {
        const reconciled = await reconcileTerminalAgentTurnReservation(request, options, reservation, queueInspection?.state ?? null);
        return sendAgentTurnTerminalReconciliation(reply, reconciled, requestedJobId);
      }
      if (!agentQueueEnvelopeMatches(queueInspection, reservedJob, true)) {
        return sendError(reply, 409, "AGENT_TURN_QUEUE_OWNERSHIP_CONFLICT", "The Agent queue job does not match the admitted immutable request.");
      }
    } catch (error) {
      let queueInspection: QueueJobInspection | null | undefined;
      try {
        queueInspection = await inspectAgentJob(requestedJobId);
      } catch (inspectionError) {
        request.log.error({ err: inspectionError, meetingId: id, jobId: requestedJobId }, "Agent queue envelope could not be inspected after enqueue failed.");
        queueInspection = undefined;
      }
      const durableDisposition = agentTurnReplayDisposition(
        await options.store.getSnapshot(),
        id,
        agentId,
        requestedJobId,
        chairSuggestionId ?? null
      );
      if (durableDisposition === "matching") {
        return reply.code(202).send(parseResponse(queuedJobAcceptanceSchema, { jobId: requestedJobId }));
      }
      if (durableDisposition === "conflict") {
        return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different Agent turn.");
      }
      if (queueInspection !== null
        && queueInspection !== undefined
        && queueOwnedJobStates.has(queueInspection.state)
        && agentQueueEnvelopeMatches(queueInspection, reservedJob, true)) {
        queued = { jobId: requestedJobId };
      } else if (queueInspection !== null
        && queueInspection !== undefined
        && !agentQueueEnvelopeMatches(queueInspection, reservedJob, true)) {
        return sendError(reply, 409, "AGENT_TURN_QUEUE_OWNERSHIP_CONFLICT", "The Agent queue job does not match the admitted immutable request.");
      } else if (queueInspection !== null && queueInspection !== undefined) {
        const reconciled = await reconcileTerminalAgentTurnReservation(request, options, reservation, queueInspection.state);
        return sendAgentTurnTerminalReconciliation(reply, reconciled, requestedJobId);
      } else if (queueInspection === null) {
        const released = await options.store.releaseSpeakerTurn(
          requestedJobId,
          "enqueue_failed",
          reservation.reservationId
        ).catch((releaseError) => {
          request.log.error({ err: releaseError, meetingId: id, jobId: requestedJobId }, "Speaker queue reservation could not be released.");
          return null;
        });
        if (released) await publishSpeakerQueueChanged(request, options, released, "released", "enqueue_failed");
        if (chairSuggestionId && pendingSuggestion) {
          await options.store.releaseChairSuggestion(chairSuggestionId, requestedJobId, "Agent queue enqueue failed.").catch((releaseError) => {
            request.log.error({ err: releaseError, meetingId: id, chairSuggestionId, jobId: requestedJobId }, "Chair suggestion reservation could not be released.");
          });
        }
        throw error;
      } else {
        throw Object.assign(new Error("Agent queue acceptance is unknown; the persisted reservation will expire automatically."), { statusCode: 503 });
      }
    }
    if (pendingSuggestion) {
      await publishMeetingEvent(
        request,
        options,
        {
          type: "chair.suggestion.updated",
          meetingId: id,
          data: { suggestion: pendingSuggestion.suggestion },
          occurredAt: new Date().toISOString()
        },
        { meetingId: id, chairSuggestionId },
        "Chair suggestion event could not be published."
      );
    }
    await publishSpeakerQueueChanged(request, options, reservation, "queued");
    try {
      await options.store.recordAudit("agent.turn.queued", "meeting", id, {
        agentId,
        participantId: participant.id,
        roleRevision: participant.roleRevision,
        roleId: participant.roleId,
        roleVersion: participant.roleSnapshot.version,
        jobId: queued.jobId,
        agendaRevision: meeting.agenda.revision,
        agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null
      });
    } catch (error) {
      request.log.error({ err: error, meetingId: id, jobId: queued.jobId }, "Queued Agent turn audit could not be recorded.");
    }
    return reply.code(202).send(parseResponse(queuedJobAcceptanceSchema, queued));
  });

  app.post("/api/meetings/:id/chair-suggestions/:suggestionId/dismiss", async (request, reply) => {
    const { id, suggestionId } = parse(z.object({ id: z.string().uuid(), suggestionId: z.string().uuid() }), request.params);
    const suggestion = (await options.store.getSnapshot()).chairSuggestions.find((item) => item.id === suggestionId);
    if (!suggestion || suggestion.meetingId !== id) return sendError(reply, 404, "NOT_FOUND", "Chair suggestion not found.");
    const dismissed = await options.store.dismissChairSuggestion(suggestionId, "Owner kept the current Meeting direction.");
    await publishMeetingEvent(
      request,
      options,
      { type: "chair.suggestion.updated", meetingId: id, data: { suggestion: dismissed.suggestion }, occurredAt: new Date().toISOString() },
      { meetingId: id, chairSuggestionId: suggestionId },
      "Chair suggestion dismissal event could not be published."
    );
    return reply.send(parseResponse(chairSuggestionResponseSchema, dismissed.suggestion));
  });

  app.post("/api/meetings/:id/tools/run", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(runMcpToolSchema, request.body);
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey || requestKey.length > 200) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    if (!options.agentQueue) return sendError(reply, 503, "QUEUE_UNAVAILABLE", "Background worker queue is not configured.");
    if (options.mcpArgumentEncryptionWriteEnabled && !options.secretVault) {
      return sendError(reply, 503, "MCP_ARGUMENT_ENCRYPTION_UNAVAILABLE", "MCP argument encryption is enabled but the Secret Vault is unavailable.");
    }
    const snapshot = await options.store.getSnapshot();
    const meeting = snapshot.meetings.find((item) => item.id === id);
    if (!meeting) return sendError(reply, 404, "NOT_FOUND", "Meeting not found.");
    const participant = snapshot.participants.find((item) => item.meetingId === id && item.agentId === input.agentId);
    const agent = snapshot.agents.find((item) => item.id === input.agentId);
    const connector = snapshot.mcpConnectors.find((item) => item.id === input.connectorId && item.enabled);
    const requestedJobId = mcpToolJobId(id, requestKey);
    const fingerprintInput = {
      meetingId: id,
      agentId: input.agentId,
      participantId: participant?.id,
      roleRevision: participant?.roleRevision,
      roleId: participant?.roleId,
      roleVersion: participant?.roleSnapshot.version,
      connectorId: input.connectorId,
      toolName: input.toolName,
      arguments: input.arguments
    };
    const legacyFingerprint = mcpToolRequestFingerprint(fingerprintInput);
    const keyedFingerprint = options.secretVault
      ? mcpToolRequestFingerprint(fingerprintInput, options.secretVault)
      : legacyFingerprint;
    if (options.mcpKeyedFingerprintWriteEnabled && !options.secretVault) {
      return sendError(reply, 503, "MCP_KEYED_FINGERPRINT_UNAVAILABLE", "Keyed MCP fingerprints are enabled but the Secret Vault is unavailable.");
    }
    const fingerprint = options.mcpKeyedFingerprintWriteEnabled ? keyedFingerprint : legacyFingerprint;
    const matchingFingerprints = new Set([keyedFingerprint, legacyFingerprint]);
    const toolRunMatchesRequest = (run: (typeof snapshot.toolRuns)[number]) => (
      matchingFingerprints.has(run.requestFingerprint)
      && run.meetingId === id
      && run.agentId === input.agentId
      && run.connectorId === input.connectorId
      && run.toolName === input.toolName
    );
    const findMatchingTerminalToolRun = async () => {
      const run = (await options.store.getSnapshot()).toolRuns.find((item) => item.jobId === requestedJobId);
      return run
        && toolRunMatchesRequest(run)
        && (run.status === "succeeded" || run.status === "failed")
        ? run
        : null;
    };
    const existingRun = snapshot.toolRuns.find((item) => item.jobId === requestedJobId);
    if (existingRun) {
      if (!toolRunMatchesRequest(existingRun)) {
        return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different tool request.");
      }
      return reply.send(parseResponse(toolRunAcceptanceSchema, {
        jobId: requestedJobId,
        replayed: true,
        status: existingRun.status
      }));
    }
    const observedReservation = snapshot.speakerQueue.find((item) => item.jobId === requestedJobId);
    if (observedReservation
      && (observedReservation.kind !== "mcp_tool_call"
        || !observedReservation.requestFingerprint
        || !matchingFingerprints.has(observedReservation.requestFingerprint))) {
      return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different tool request.");
    }
    if (meeting.state !== "active") return sendError(reply, 409, "MEETING_NOT_ACTIVE", "Meeting must be active.");
    if (!participant || !agent) return sendError(reply, 403, "AGENT_NOT_ASSIGNED", "Agent is not assigned to this meeting.");
    if (agent.lifecycleStatus === "disabled") return sendError(reply, 409, "AGENT_DISABLED", "Agent is disabled.");
    if (participant.agentRevision === undefined) {
      return sendError(reply, 409, "AGENT_REVISION_UNAVAILABLE", "The Meeting has no immutable Agent revision binding.");
    }
    const agentRevision = await options.store.getAgentRevision(agent.id, participant.agentRevision);
    if (!agentRevision.publishedAt) {
      return sendError(reply, 409, "AGENT_REVISION_UNAVAILABLE", "The Meeting Agent revision is not published.");
    }
    const roleAuthorization = authorizeRoleMcpAccess(participant.roleSnapshot);
    if (!roleAuthorization.allowed) {
      return sendError(reply, 403, "ROLE_TOOL_DENIED", roleAuthorization.reason ?? "The Meeting Role does not permit this tool call.");
    }
    const registration = connector?.toolRegistrations.find((item) => item.toolName === input.toolName);
    if (!connector
      || !connector.approvedTools.includes(input.toolName)
      || !registration
      || !agentRevision.toolGrants.some((grant) => grant.connectorId === connector.id && grant.toolName === input.toolName)) {
      return sendError(reply, 403, "TOOL_DENIED", "Tool is not approved for this Agent.");
    }
    const inspectMcpJobCapability = options.agentQueue.inspectJob?.bind(options.agentQueue);
    if (!inspectMcpJobCapability) {
      return sendError(
        reply,
        503,
        "MCP_QUEUE_INSPECTION_UNAVAILABLE",
        "The MCP queue cannot prove exact job-envelope ownership."
      );
    }
    const inspectMcpJob = (jobId: string) => inspectQueueJobEnvelope(
      inspectMcpJobCapability,
      jobId,
      options.mcpQueueInspectionTimeoutMs ?? 3_000,
      "MCP"
    );
    const toolSnapshot = { connectorName: connector.name, ...registration };
    let preAdmissionQueueInspection: QueueJobInspection | null;
    try {
      preAdmissionQueueInspection = await inspectMcpJob(requestedJobId);
    } catch (error) {
      request.log.error({ err: error, meetingId: id, jobId: requestedJobId }, "MCP queue state could not be inspected before reservation.");
      return sendError(reply, 503, "QUEUE_STATE_UNAVAILABLE", "MCP queue state could not be verified safely.");
    }
    if (preAdmissionQueueInspection !== null) {
      const currentReservation = observedReservation ?? (await options.store.getSnapshot()).speakerQueue
        .find((item) => item.jobId === requestedJobId);
      if (currentReservation
        && (currentReservation.kind !== "mcp_tool_call"
          || !currentReservation.requestFingerprint
          || !matchingFingerprints.has(currentReservation.requestFingerprint))) {
        return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different tool request.");
      }
      if (!currentReservation) {
        await recordSecondaryAudit(
          request,
          options,
          "mcp.tool.reconciliation.required",
          "meeting",
          id,
          {
            agentId: input.agentId,
            connectorId: input.connectorId,
            toolName: input.toolName,
            jobId: requestedJobId,
            queueState: preAdmissionQueueInspection.state,
            reason: "queue_job_preexisted_atomic_admission"
          },
          "MCP reconciliation audit could not be recorded."
        );
        return sendError(
          reply,
          409,
          "MCP_RECONCILIATION_REQUIRED",
          "The MCP idempotency key already existed in the queue before its durable reservation; reconcile it before retrying."
        );
      }
    }
    const connectorFingerprint = mcpConnectorExecutionFingerprint(
      connector,
      await options.store.getConnectorSecret(connector.id)
    );
    const argumentPayload: McpToolArgumentPayload = options.mcpArgumentEncryptionWriteEnabled
      ? {
          argumentEncoding: "vault_v1",
          argumentsCiphertext: encryptMcpToolArguments(options.secretVault!, requestedJobId, input.arguments)
        }
      : { arguments: input.arguments };
    const job: McpToolCallJobData = {
      meetingId: id,
      agentId: input.agentId,
      requestFingerprint: fingerprint,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      connectorId: input.connectorId,
      toolName: input.toolName,
      toolSnapshot,
      connectorFingerprint,
      ...argumentPayload,
      requestedBy: "owner"
    };
    const admission = await options.store.admitMcpToolCall(requestedJobId, {
      ...job,
      requestFingerprint: fingerprint,
      acceptedRequestFingerprints: [...matchingFingerprints]
    });
    if (admission.status === "existing_run") {
      return reply.send(parseResponse(toolRunAcceptanceSchema, {
        jobId: requestedJobId,
        replayed: true,
        status: admission.run.status
      }));
    }
    if (admission.status === "existing_reservation") {
      let queueInspection: QueueJobInspection | null;
      try {
        queueInspection = await inspectMcpJob(requestedJobId);
      } catch (error) {
        request.log.error({ err: error, meetingId: id, jobId: requestedJobId }, "MCP queue state could not be inspected after atomic admission.");
        return sendError(reply, 503, "QUEUE_STATE_UNAVAILABLE", "MCP queue state could not be verified safely.");
      }
      const reservedJob = {
        ...job,
        requestFingerprint: admission.reservation.requestFingerprint ?? undefined
      };
      const envelopeMatches = queueInspection ? mcpQueueEnvelopeMatches(queueInspection, reservedJob) : false;
      if (queueInspection
        && queueOwnedJobStates.has(queueInspection.state)
        && envelopeMatches) {
        return reply.code(202).send(parseResponse(toolRunAcceptanceSchema, { jobId: requestedJobId }));
      }
      return sendError(
        reply,
        409,
        "MCP_RECONCILIATION_REQUIRED",
        envelopeMatches === false
          ? "The active queue job does not match the persisted MCP reservation; reconcile it before retrying."
          : "The persisted MCP reservation is not owned by an active queue job; reconcile it before retrying."
      );
    }
    const reservation = admission.reservation;
    let queued: { jobId: string } = { jobId: requestedJobId };
    try {
      queued = await options.agentQueue.enqueueToolCall(job, requestedJobId);
      if (queued.jobId !== requestedJobId) {
        throw Object.assign(new Error("The MCP queue returned a different job ID than the persisted reservation."), { statusCode: 409 });
      }
      let queueInspection: QueueJobInspection | null;
      try {
        queueInspection = await inspectMcpJob(requestedJobId);
      } catch (inspectionError) {
        const durableRun = await findMatchingTerminalToolRun();
        if (durableRun) {
          return reply.send(parseResponse(toolRunAcceptanceSchema, {
            jobId: requestedJobId,
            replayed: true,
            status: durableRun.status
          }));
        }
        request.log.error({ err: inspectionError, meetingId: id, jobId: requestedJobId }, "MCP queue envelope could not be inspected after enqueue.");
        return sendError(reply, 503, "QUEUE_STATE_UNAVAILABLE", "MCP queue ownership could not be verified safely after enqueue.");
      }
      const envelopeMatches = queueInspection ? mcpQueueEnvelopeMatches(queueInspection, job) : false;
      if (!queueInspection
        || !queueOwnedJobStates.has(queueInspection.state)
        || !envelopeMatches) {
        if (!queueInspection || !queueOwnedJobStates.has(queueInspection.state)) {
          const durableRun = await findMatchingTerminalToolRun();
          if (durableRun) {
            return reply.send(parseResponse(toolRunAcceptanceSchema, {
              jobId: requestedJobId,
              replayed: true,
              status: durableRun.status
            }));
          }
        }
        await publishSpeakerQueueChanged(request, options, reservation, "queued");
        await recordSecondaryAudit(
          request,
          options,
          "mcp.tool.reconciliation.required",
          "meeting",
          id,
          {
            agentId: input.agentId,
            connectorId: input.connectorId,
            toolName: input.toolName,
            jobId: requestedJobId,
            queueState: queueInspection?.state ?? "missing",
            reason: queueInspection ? "queue_envelope_mismatch" : "queue_ownership_unverified"
          },
          "MCP reconciliation audit could not be recorded."
        );
        return sendError(
          reply,
          409,
          "MCP_RECONCILIATION_REQUIRED",
          "The queue job could not be proven to match the persisted MCP reservation; reconcile it before retrying."
        );
      }
    } catch (error) {
      let queueInspection: QueueJobInspection | null | undefined;
      try {
        queueInspection = await inspectMcpJob(requestedJobId);
      } catch {
        queueInspection = undefined;
      }
      const queueState = queueInspection?.state ?? queueInspection;
      const envelopeMatches = queueInspection ? mcpQueueEnvelopeMatches(queueInspection, job) : null;
      const accepted = queueInspection !== null
        && queueInspection !== undefined
        && queueOwnedJobStates.has(queueInspection.state)
        && envelopeMatches === true;
      if (!accepted && queueState !== null && queueState !== undefined) {
        const durableRun = await findMatchingTerminalToolRun();
        if (durableRun) {
          return reply.send(parseResponse(toolRunAcceptanceSchema, {
            jobId: requestedJobId,
            replayed: true,
            status: durableRun.status
          }));
        }
      }
      if (accepted) {
        queued = { jobId: requestedJobId };
      } else if (queueState === null) {
        const released = await options.store.releaseSpeakerTurn(requestedJobId, "enqueue_failed").catch((releaseError) => {
          request.log.error({ err: releaseError, meetingId: id, jobId: requestedJobId }, "MCP queue reservation could not be released.");
          return null;
        });
        if (released) await publishSpeakerQueueChanged(request, options, released, "released", "enqueue_failed");
      }
      if (!accepted) {
        if (queueState === undefined) {
          throw Object.assign(new Error("MCP queue acceptance is unknown; the persisted reservation will expire automatically."), { statusCode: 503 });
        }
        if (queueState !== null) {
          await publishSpeakerQueueChanged(request, options, reservation, "queued");
          await recordSecondaryAudit(
            request,
            options,
            "mcp.tool.reconciliation.required",
            "meeting",
            id,
            {
              agentId: input.agentId,
              connectorId: input.connectorId,
              toolName: input.toolName,
              jobId: requestedJobId,
              queueState,
              reason: envelopeMatches === false ? "queue_envelope_mismatch" : "ambiguous_enqueue_terminal_state"
            },
            "MCP reconciliation audit could not be recorded."
          );
          return sendError(
            reply,
            409,
            "MCP_RECONCILIATION_REQUIRED",
            "The MCP idempotency key reached a terminal or unsupported queue state; its durable reservation was preserved for reconciliation."
          );
        }
        throw error;
      }
    }
    await publishSpeakerQueueChanged(request, options, reservation, "queued");
    try {
      await options.store.recordAudit("mcp.tool.queued", "meeting", id, {
        agentId: input.agentId,
        connectorId: input.connectorId,
        toolName: input.toolName,
        jobId: queued.jobId,
        argumentEncoding: argumentPayload.argumentEncoding ?? "legacy_plaintext"
      });
    } catch (error) {
      request.log.error({ err: error, meetingId: id, jobId: queued.jobId }, "Queued MCP tool audit could not be recorded.");
    }
    return reply.code(202).send(parseResponse(toolRunAcceptanceSchema, queued));
  });

  app.post("/api/decisions", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const decision = await options.store.createDecision(
      parse(createDecisionSchema, request.body),
      requestKey
    );
    await publishDecisionChanged(request, options, decision, "created");
    return reply.code(201).send(parseResponse(decisionResponseSchema, decision));
  });

  for (const status of ["approve", "reject"] as const) {
    app.post(`/api/decisions/:id/${status}`, async (request, reply) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
      const decision = await options.store.setDecisionStatus(id, status === "approve" ? "approved" : "rejected");
      await publishDecisionChanged(request, options, decision, status === "approve" ? "approved" : "rejected");
      return reply.send(parseResponse(decisionResponseSchema, decision));
    });
  }

  app.post("/api/tasks", async (request, reply) => {
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const task = await options.store.createTask(parse(createTaskSchema, request.body), requestKey);
    await publishTaskChanged(request, options, task, "created");
    return reply.code(201).send(parseResponse(taskResponseSchema, task));
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const task = (await options.store.getSnapshot()).tasks.find((item) => item.id === id);
    if (!task) return sendError(reply, 404, "NOT_FOUND", "Task not found.");
    return reply.send(parseResponse(taskResponseSchema, task));
  });

  app.patch("/api/tasks/:id", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const task = await options.store.updateTask(id, parse(updateTaskSchema, request.body));
    await publishTaskChanged(request, options, task, "updated");
    return reply.send(parseResponse(taskResponseSchema, task));
  });

  app.post("/api/tasks/:id/approval", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const task = await options.store.setTaskApproval(id, parse(setTaskApprovalSchema, request.body));
    await publishTaskChanged(request, options, task, "approval_changed");
    return reply.send(parseResponse(taskResponseSchema, task));
  });

  app.post("/api/tasks/:id/run", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(runTaskAgentSchema, request.body);
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey || requestKey.length > 200) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const queue = options.agentQueue;
    if (!queue?.enqueueTaskAgentRun) {
      return sendError(reply, 503, "TASK_AGENT_QUEUE_UNAVAILABLE", "Task Agent execution is unavailable.");
    }
    const snapshot = await options.store.getSnapshot();
    const task = snapshot.tasks.find((item) => item.id === id);
    if (!task) return sendError(reply, 404, "NOT_FOUND", "Task not found.");
    const requestedJobId = taskAgentRunJobId(id, requestKey);
    const recordReconciliationAudit = async (detail: Record<string, unknown>) => {
      await recordSecondaryAudit(
        request,
        options,
        "task.agent_run.reconciliation.required",
        "task",
        task.id,
        detail,
        "Task Agent reconciliation audit could not be recorded."
      );
    };
    const runRequestFingerprint = requestFingerprint({
      taskId: id,
      expectedExecutionRevision: input.expectedExecutionRevision,
      assigneeAgentId: task.assigneeAgentId,
      executionProfile: task.executionProfile
    });
    if (task.execution.jobId === requestedJobId) {
      if (task.execution.requestFingerprint !== runRequestFingerprint) {
        return sendError(reply, 409, "IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for a different Task Agent request.");
      }
      if (task.execution.status === "queued" || task.execution.status === "running") {
        if (!task.execution.agentId || !task.execution.profile) {
          return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "The active Task Agent reservation has an incomplete durable binding.");
        }
        const replayBinding: TaskAgentRunBinding = {
          executionRevision: task.execution.revision,
          requestFingerprint: task.execution.requestFingerprint,
          agentId: task.execution.agentId,
          executionProfile: task.execution.profile
        };
        let queueState: string | null | undefined;
        let queueEnvelopeMatches: boolean | undefined;
        try {
          const inspection = await inspectTaskAgentQueueJob(queue, requestedJobId, {
            taskId: task.id,
            taskFingerprint: taskExecutionFingerprint(task),
            ...replayBinding
          }, false);
          queueState = inspection.state;
          queueEnvelopeMatches = inspection.envelopeMatches;
        } catch (inspectionError) {
          request.log.error({ err: inspectionError, taskId: task.id, jobId: requestedJobId }, "Task Agent replay queue state could not be inspected.");
          queueState = undefined;
        }
        if (queueEnvelopeMatches === false) {
          await recordReconciliationAudit({
            jobId: requestedJobId,
            executionRevision: replayBinding.executionRevision,
            requestFingerprint: replayBinding.requestFingerprint,
            queueState: queueState ?? null,
            reason: "replay_queue_envelope_mismatch"
          });
          return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "The Task Agent queue job does not match the durable reservation.");
        }
        if (queueState !== null && queueState !== undefined && queueOwnedJobStates.has(queueState)) {
          return reply.send(parseResponse(taskRunResponseSchema, {
            task,
            jobId: requestedJobId,
            replayed: true
          }));
        }

        const durableTask = (await options.store.getSnapshot()).tasks.find((candidate) => candidate.id === task.id);
        if (durableTask && taskAgentRunBindingMatches(durableTask, requestedJobId, replayBinding)
          && (durableTask.execution.status === "completed" || durableTask.execution.status === "failed")) {
          return reply.send(parseResponse(taskRunResponseSchema, {
            task: durableTask,
            jobId: requestedJobId,
            replayed: true
          }));
        }
        if (queueState === undefined) {
          return sendError(reply, 503, "TASK_AGENT_QUEUE_UNAVAILABLE", "Task Agent queue ownership is temporarily unavailable.");
        }
        if (queueState !== null) {
          await recordReconciliationAudit({
            jobId: requestedJobId,
            executionRevision: replayBinding.executionRevision,
            requestFingerprint: replayBinding.requestFingerprint,
            queueState,
            reason: "replay_terminal_before_durable_settlement"
          });
          return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "Task Agent replay reached a terminal or unsupported queue state before durable settlement.");
        }
        if (durableTask
          && taskAgentRunBindingMatches(durableTask, requestedJobId, replayBinding)
          && taskAgentAdmissionLeaseActive(durableTask.execution)) {
          return reply.code(202).send(parseResponse(taskRunResponseSchema, {
            task: durableTask,
            jobId: requestedJobId,
            replayed: true
          }));
        }

        const providerOutcomeUnknown = Boolean(
          durableTask
          && taskAgentRunBindingMatches(durableTask, requestedJobId, replayBinding)
          && durableTask.execution.providerStartedAt
        );
        const failure = await options.store.failTaskAgentRun({
          taskId: task.id,
          jobId: requestedJobId,
          ...replayBinding
        }, providerOutcomeUnknown ? "provider_outcome_unknown" : "queue_state_missing");
        if (failure.status === "updated") {
          await publishTaskChanged(request, options, failure.task, "agent_run_failed");
          if (providerOutcomeUnknown) {
            return sendError(
              reply,
              409,
              "TASK_AGENT_RECONCILIATION_REQUIRED",
              "The Task Agent provider started before queue ownership was lost; reconcile the external outcome before retrying."
            );
          }
          return sendError(reply, 409, "IDEMPOTENCY_REPLAY_EXPIRED", "The queued Task Agent job no longer exists; reload the Task before retrying.");
        }
        if (taskAgentRunBindingMatches(failure.task, requestedJobId, replayBinding)
          && failure.task.execution.status === "failed"
          && failure.task.execution.lastError === "provider_outcome_unknown") {
          return sendError(
            reply,
            409,
            "TASK_AGENT_RECONCILIATION_REQUIRED",
            "The Task Agent provider outcome remains unknown; reconcile it before retrying."
          );
        }
        if (taskAgentRunBindingMatches(failure.task, requestedJobId, replayBinding)
          && (failure.task.execution.status === "completed" || failure.task.execution.status === "failed")) {
          return reply.send(parseResponse(taskRunResponseSchema, {
            task: failure.task,
            jobId: requestedJobId,
            replayed: true
          }));
        }
        await recordReconciliationAudit({
          jobId: requestedJobId,
          executionRevision: replayBinding.executionRevision,
          requestFingerprint: replayBinding.requestFingerprint,
          reason: "replay_failure_binding_changed"
        });
        return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "Task Agent replay changed while missing queue ownership was being reconciled; reload the durable Task state.");
      }
      return reply.send(parseResponse(taskRunResponseSchema, {
        task,
        jobId: requestedJobId,
        replayed: true
      }));
    }
    if (task.transitions.some((transition) => transition.type === "agent_run_requested" && transition.jobId === requestedJobId)) {
      return sendError(reply, 409, "IDEMPOTENCY_REPLAY_EXPIRED", "This Task Agent request has already settled and is no longer the current run.");
    }
    if (task.execution.revision !== input.expectedExecutionRevision) {
      return sendError(reply, 409, "TASK_REVISION_CONFLICT", "Task execution settings changed before the run was requested.");
    }
    if (task.execution.status === "queued" || task.execution.status === "running") {
      return sendError(reply, 409, "TASK_AGENT_RUN_ACTIVE", "Task already has a queued or active Agent run.");
    }
    if (task.status === "done") return sendError(reply, 409, "TASK_ALREADY_DONE", "Completed Tasks cannot start an Agent run.");
    const sourceDecision = snapshot.decisions.find((decision) => decision.id === task.decisionId && decision.meetingId === task.meetingId);
    if (!sourceDecision || sourceDecision.status !== "approved") {
      return sendError(reply, 409, "TASK_DECISION_NOT_APPROVED", "The source Decision must remain approved before this Task can run an Agent.");
    }
    if (task.executionProfile === "manual") {
      return sendError(reply, 409, "TASK_AGENT_RUN_DISABLED", "Manual Tasks do not run an Agent.");
    }
    if (!task.assigneeAgentId) return sendError(reply, 409, "TASK_AGENT_REQUIRED", "Assign an Agent before starting this Task.");
    if (task.executionProfile === "worker" && !task.acceptanceCriteria.trim()) {
      return sendError(reply, 409, "TASK_ACCEPTANCE_REQUIRED", "Worker Task execution requires acceptance criteria.");
    }
    if (task.executionProfile === "worker" && task.approvalState !== "approved") {
      return sendError(reply, 409, "TASK_APPROVAL_REQUIRED", "Worker Task execution requires explicit Owner approval.");
    }
    const publishedRuntime = await getPublishedAgentRuntime(options.store, snapshot, task.assigneeAgentId);
    if (!publishedRuntime.agent) return sendError(reply, 409, "TASK_AGENT_UNAVAILABLE", "The assigned Agent is unavailable.");
    if (!publishedRuntime.revision) {
      return sendError(reply, 409, "TASK_AGENT_NOT_PUBLISHED", "The assigned Agent must have a published revision.");
    }
    const agent = publishedRuntime.agent;
    const revision = publishedRuntime.revision;
    if (!revision.modelConnectorId) return sendError(reply, 409, "MODEL_CONNECTOR_REQUIRED", "The assigned Agent has no Model Connector.");
    const blockedReadiness = publishedRuntime.readiness.checks.find((check) => check.status === "blocked");
    if (blockedReadiness) {
      const error = taskAgentReadinessError(blockedReadiness);
      return sendError(reply, 409, error.code, error.message);
    }
    const runtimeProfileSnapshot = publishedRuntime.runtimeProfileSnapshot;
    if (!runtimeProfileSnapshot) {
      return sendError(reply, 409, "TASK_RUNTIME_PROFILE_NOT_READY", "The assigned Agent's Runtime Profile is unavailable or no longer permitted.");
    }
    if (runtimeProfileSnapshot.harnessKind === "pi") {
      return sendError(reply, 409, "OMP_GOAL_CONTRACT_REQUIRED", "OMP execution requires an Owner-approved Goal Execution Contract.");
    }
    const connector = snapshot.modelConnectors.find((item) => item.id === revision.modelConnectorId && item.enabled);
    if (!connector) return sendError(reply, 409, "MODEL_CONNECTOR_UNAVAILABLE", "The assigned Agent Model Connector is disabled or unavailable.");
    const credential = resolveCredentialBinding(snapshot, connector);
    if (credential.error) return sendError(reply, 409, "TASK_CREDENTIAL_NOT_READY", credential.error);
    const skills = revision.skillIds.map((skillId) => snapshot.skills.find((skill) => skill.id === skillId));
    const runtimeRun = createQueuedRuntimeRun({
      id: stableRuntimeRunId(requestedJobId),
      kind: "task_agent",
      scope: {
        id: `task:${task.id}:attempt:${task.execution.attemptCount + 1}`,
        kind: "task_attempt",
        subjectId: task.id,
        parentScopeId: null
      },
      runtimeProfile: runtimeProfileSnapshot,
      agentId: agent.id,
      agentRevision: revision.revision,
      roleId: null,
      roleRevision: null,
      attempt: task.execution.attemptCount + 1,
      idempotencyKey: requestedJobId,
      queuedAt: new Date().toISOString(),
      ttlMs: runtimeRunQueueTtlMs(runtimeProfileSnapshot)
    });
    const job = {
      taskId: task.id,
      agentId: agent.id,
      executionProfile: task.executionProfile,
      executionRevision: task.execution.revision + 1,
      taskFingerprint: taskExecutionFingerprint(task),
      requestFingerprint: runRequestFingerprint,
      modelConnectorBinding: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        secretRevision: connector.secretRevision
      },
      agentRevision: revision.revision,
      promptBinding: revision.promptBinding,
      ...(credential.binding ? { credentialBinding: credential.binding } : {}),
      skillDigests: Object.fromEntries(skills.map((skill) => [skill!.id, skill!.contentDigest])),
      runtimeProfileBinding: { ...revision.runtimeProfileBinding! },
      runtimeProfileSnapshot,
      runtimeRun,
      requestedBy: "owner" as const
    };
    const reservation = await options.store.markTaskAgentRunQueued(requestedJobId, job);
    const requestedAt = reservation.task.execution.requestedAt;
    if (!requestedAt || !job.runtimeRun.expiresAt) {
      throw new Error("Task Agent admission did not retain the Runtime Run timestamp.");
    }
    const runtimeTtlMs = Date.parse(job.runtimeRun.expiresAt) - Date.parse(job.runtimeRun.queuedAt);
    job.runtimeRun = {
      ...job.runtimeRun,
      queuedAt: requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + runtimeTtlMs).toISOString(),
      updatedAt: requestedAt
    };
    await options.store.createRuntimeRun(job.runtimeRun, {
      type: "state.changed",
      phase: "queued",
      summary: "Runtime Run durably admitted before Task Agent queue dispatch.",
      toolName: null,
      progressPercent: 0,
      usage: null,
      errorCode: null,
      actorType: "system",
      occurredAt: requestedAt
    });
    if (reservation.status === "unchanged") {
      return reply.code(202).send(parseResponse(taskRunResponseSchema, {
        task: reservation.task,
        jobId: requestedJobId,
        replayed: true
      }));
    }
    await publishTaskChanged(request, options, reservation.task, "agent_run_queued");
    try {
      const queued = await queue.enqueueTaskAgentRun(job, requestedJobId);
      if (queued.jobId !== requestedJobId) {
        throw Object.assign(new Error("The Task Agent queue returned a different job ID."), { statusCode: 409 });
      }
    } catch (error) {
      let queueState: string | null | undefined;
      let queueEnvelopeMatches: boolean | undefined;
      try {
        const inspection = await inspectTaskAgentQueueJob(queue, requestedJobId, job, true);
        queueState = inspection.state;
        queueEnvelopeMatches = inspection.envelopeMatches;
      } catch (inspectionError) {
        request.log.error({ err: inspectionError, taskId: task.id, jobId: requestedJobId }, "Task Agent queue state could not be inspected after enqueue failed.");
        queueState = undefined;
      }
      if (queueEnvelopeMatches === false) {
        await recordReconciliationAudit({
          jobId: requestedJobId,
          executionRevision: job.executionRevision,
          requestFingerprint: job.requestFingerprint,
          queueState: queueState ?? null,
          reason: "enqueue_queue_envelope_mismatch"
        });
        return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "The Task Agent queue job does not match the durable reservation.");
      }
      if (queueState !== null && queueState !== undefined && queueOwnedJobStates.has(queueState)) {
        return reply.code(202).send(parseResponse(taskRunResponseSchema, {
          task: reservation.task,
          jobId: requestedJobId,
          replayed: false
        }));
      }

      const durableTask = (await options.store.getSnapshot()).tasks.find((candidate) => candidate.id === task.id);
      if (durableTask && taskAgentRunBindingMatches(durableTask, requestedJobId, job)) {
        if (durableTask.execution.status === "completed") {
          return reply.code(202).send(parseResponse(taskRunResponseSchema, {
            task: durableTask,
            jobId: requestedJobId,
            replayed: false
          }));
        }
        if (durableTask.execution.status === "failed") {
          return sendError(reply, 503, "TASK_AGENT_RUN_FAILED", "Task Agent execution failed after queue acceptance; the durable Task result was retained.");
        }
      }

      if (queueState === undefined) {
        await recordReconciliationAudit({
          jobId: requestedJobId,
          executionRevision: job.executionRevision,
          requestFingerprint: job.requestFingerprint,
          reason: "queue_acceptance_unknown"
        });
        return sendError(reply, 503, "TASK_AGENT_QUEUE_UNAVAILABLE", "Task Agent queue acceptance is unknown; the durable reservation will be reconciled.");
      }
      if (queueState !== null) {
        await recordReconciliationAudit({
          jobId: requestedJobId,
          executionRevision: job.executionRevision,
          requestFingerprint: job.requestFingerprint,
          queueState,
          reason: "ambiguous_enqueue_terminal_state"
        });
        return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "Task Agent execution reached a terminal or unsupported queue state before durable settlement; the reservation was preserved for reconciliation.");
      }

      const failureBinding = {
        taskId: task.id,
        jobId: requestedJobId,
        executionRevision: job.executionRevision,
        requestFingerprint: job.requestFingerprint,
        agentId: job.agentId,
        executionProfile: job.executionProfile
      };
      const failure = await options.store.failTaskAgentRun(failureBinding, "queue_unavailable").catch((failureError) => {
        request.log.error({ err: failureError, taskId: task.id, jobId: requestedJobId }, "Task Agent reservation could not be marked failed.");
        return null;
      });
      if (failure?.status === "updated") {
        await publishTaskChanged(request, options, failure.task, "agent_run_failed");
      }
      if (failure && failure.status !== "updated") {
        const currentTask = failure.task;
        if (taskAgentRunBindingMatches(currentTask, requestedJobId, job)) {
          if (currentTask.execution.status === "completed") {
            return reply.code(202).send(parseResponse(taskRunResponseSchema, {
              task: currentTask,
              jobId: requestedJobId,
              replayed: false
            }));
          }
          if (currentTask.execution.status === "failed") {
            return sendError(reply, 503, "TASK_AGENT_RUN_FAILED", "Task Agent execution failed after queue acceptance; the durable Task result was retained.");
          }
        }
        await recordReconciliationAudit({
          jobId: requestedJobId,
          executionRevision: job.executionRevision,
          requestFingerprint: job.requestFingerprint,
          reason: "failure_binding_changed"
        });
        return sendError(reply, 409, "TASK_AGENT_RECONCILIATION_REQUIRED", "Task Agent execution changed while queue failure was being reconciled; reload the durable Task state.");
      }

      const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
      if (statusCode === 409) {
        return sendError(reply, 409, "TASK_AGENT_RUN_ACTIVE", "Task already has a queued or active Agent run.");
      }
      return sendError(reply, 503, "TASK_AGENT_QUEUE_UNAVAILABLE", failure
        ? "Task Agent execution could not be queued; the durable reservation was marked failed."
        : "Task Agent execution could not be queued and the durable failure could not be confirmed.");
    }
    return reply.code(202).send(parseResponse(taskRunResponseSchema, {
      task: reservation.task,
      jobId: requestedJobId,
      replayed: false
    }));
  });

  app.post("/api/tasks/:id/evidence", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const requestKey = idempotencyKey(request.headers)?.trim();
    if (!requestKey) {
      return sendError(reply, 400, "IDEMPOTENCY_KEY_REQUIRED", "A non-empty Idempotency-Key header of at most 200 characters is required.");
    }
    const task = await options.store.addTaskEvidence(
      id,
      parse(addTaskEvidenceSchema, request.body),
      requestKey
    );
    await publishTaskChanged(request, options, task, "evidence_added");
    return reply.code(201).send(parseResponse(taskResponseSchema, task));
  });

  app.patch("/api/tasks/:id/status", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const task = await options.store.moveTask(id, parse(moveTaskSchema, request.body));
    await publishTaskChanged(request, options, task, "status_changed");
    return reply.send(parseResponse(taskResponseSchema, task));
  });

  app.post("/api/tasks/:id/sync", async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(taskSyncRequestSchema, request.body);
    const { adapterId } = input;
    if (!options.agentQueue?.enqueueTaskSync) {
      return sendError(reply, 503, "SYNC_QUEUE_UNAVAILABLE", "Task synchronization is unavailable.");
    }
    const snapshot = await options.store.getSnapshot();
    if (!snapshot.tasks.some((task) => task.id === id)) {
      return sendError(reply, 404, "NOT_FOUND", "Task not found.");
    }
    const adapter = snapshot.taskAdapterConnectors.find((item) => item.id === adapterId);
    if (!adapter) return sendError(reply, 404, "NOT_FOUND", "Task Adapter Connector not found.");
    const requestedJobId = taskSyncJobId(id);
    const pending = await options.store.markTaskSyncPending(id, requestedJobId, input);
    const jobId = pending.task.sync.jobId;
    if (!jobId) {
      throw new Error("Task synchronization admission did not retain its canonical job ID.");
    }
    const recordReconciliationAudit = async (detail: Record<string, unknown>) => {
      await recordSecondaryAudit(
        request,
        options,
        "task.sync.reconciliation.required",
        "task",
        id,
        {
          adapterId,
          jobId,
          ...detail
        },
        "Task synchronization reconciliation audit could not be recorded."
      );
    };
    if (pending.status === "updated") {
      await publishTaskChanged(request, options, pending.task, "sync_queued");
    }
    if (pending.status === "unchanged") {
      if (pending.task.sync.status === "synced") {
        return reply.code(202).send(parseResponse(taskSyncResponseSchema, { task: pending.task, jobId }));
      }
      if (pending.task.sync.status === "failed") {
        return sendError(
          reply,
          503,
          "TASK_SYNC_FAILED",
          "Task synchronization failed after queue acceptance; the internal Task was retained."
        );
      }
      let queueState: string | null | undefined;
      try {
        queueState = await inspectQueueJobState(options.agentQueue, jobId);
      } catch (inspectionError) {
        request.log.error({ err: inspectionError, taskId: id, jobId }, "Replayed Task synchronization queue state could not be inspected.");
        queueState = undefined;
      }
      if (queueState !== null && queueState !== undefined && queueOwnedJobStates.has(queueState)) {
        return reply.code(202).send(parseResponse(taskSyncResponseSchema, { task: pending.task, jobId }));
      }
      if (queueState === "completed" || queueState === "failed") {
        const durableTask = (await options.store.getSnapshot()).tasks.find((task) => task.id === id);
        if (durableTask?.sync.jobId === jobId && durableTask.sync.status === "synced") {
          return reply.code(202).send(parseResponse(taskSyncResponseSchema, { task: durableTask, jobId }));
        }
        if (durableTask?.sync.jobId === jobId && durableTask.sync.status === "failed") {
          return sendError(
            reply,
            503,
            "TASK_SYNC_FAILED",
            "Task synchronization failed after queue acceptance; the internal Task was retained."
          );
        }
      }
      if (queueState === undefined) {
        await recordReconciliationAudit({ reason: "replayed_queue_acceptance_unknown" });
        return sendError(
          reply,
          503,
          "TASK_SYNC_ACCEPTANCE_UNKNOWN",
          "Task synchronization queue acceptance is unknown; the durable reservation was preserved for reconciliation."
        );
      }
      await recordReconciliationAudit({
        queueState,
        reason: "replayed_reservation_without_queue_ownership"
      });
      return sendError(
        reply,
        409,
        "TASK_SYNC_RECONCILIATION_REQUIRED",
        "Task synchronization is not owned by an active queue job; the durable reservation was preserved for reconciliation."
      );
    }
    try {
      const queued = await options.agentQueue.enqueueTaskSync(
        { taskId: id, adapterId, requestedBy: "owner" },
        jobId
      );
      if (queued.jobId !== jobId) {
        throw Object.assign(
          new Error("The Task synchronization queue returned a different job ID than the durable reservation."),
          { statusCode: 409 }
        );
      }
    } catch (error) {
      let queueState: string | null | undefined;
      try {
        queueState = await inspectQueueJobState(options.agentQueue, jobId);
      } catch (inspectionError) {
        request.log.error({ err: inspectionError, taskId: id, jobId }, "Task synchronization queue state could not be inspected after enqueue failed.");
        queueState = undefined;
      }
      if (queueState !== null && queueState !== undefined && queueOwnedJobStates.has(queueState)) {
        return reply.code(202).send(parseResponse(taskSyncResponseSchema, { task: pending.task, jobId }));
      }
      if (queueState === undefined) {
        await recordReconciliationAudit({ reason: "queue_acceptance_unknown" });
        return sendError(
          reply,
          503,
          "TASK_SYNC_ACCEPTANCE_UNKNOWN",
          "Task synchronization queue acceptance is unknown; the durable reservation was preserved for reconciliation."
        );
      }
      if (queueState === "completed" || queueState === "failed") {
        const durableTask = (await options.store.getSnapshot()).tasks.find((task) => task.id === id);
        if (queueState === "completed"
          && durableTask?.sync.jobId === jobId
          && durableTask.sync.status === "synced") {
          return reply.code(202).send(parseResponse(taskSyncResponseSchema, { task: durableTask, jobId }));
        }
        if (queueState === "failed"
          && durableTask?.sync.jobId === jobId
          && durableTask.sync.status === "failed") {
          return sendError(
            reply,
            503,
            "TASK_SYNC_FAILED",
            "Task synchronization failed after queue acceptance; the internal Task was retained."
          );
        }
      }
      if (queueState !== null) {
        await recordReconciliationAudit({
          queueState,
          reason: "ambiguous_enqueue_terminal_state"
        });
        return sendError(
          reply,
          409,
          "TASK_SYNC_RECONCILIATION_REQUIRED",
          "Task synchronization reached a terminal or unsupported queue state; the durable reservation was preserved for reconciliation."
        );
      }
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
      const classification = statusCode === 409 ? "queue_conflict" : "queue_unavailable";
      try {
        const failed = await options.store.failTaskSync({
          taskId: id,
          adapterId,
          jobId,
          requestFingerprint: pending.task.sync.requestFingerprint!
        }, classification);
        if (failed.status === "updated") {
          await publishTaskChanged(request, options, failed.task, "sync_failed");
        }
      } catch (persistError) {
        request.log.error({ err: persistError, taskId: id, jobId }, "Task synchronization enqueue failure could not be persisted.");
      }
      if (statusCode === 409) {
        return sendError(reply, 409, "TASK_SYNC_ALREADY_QUEUED", "Task synchronization is already queued or active.");
      }
      return sendError(reply, 503, "SYNC_QUEUE_UNAVAILABLE", "Task synchronization could not be queued; the internal Task was retained.");
    }
    return reply.code(202).send(parseResponse(taskSyncResponseSchema, { task: pending.task, jobId }));
  });
}
