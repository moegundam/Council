import { randomUUID } from "node:crypto";
import type { AgentTurnJobData, ChairAutomationJobData } from "@council/contracts";
import { createQueuedRuntimeRun, runtimeRunQueueTtlMs } from "@council/domain";
import {
  automaticChairTurnJobId,
  decideSnapshotChairAutoApply,
  type PlatformStore
} from "@council/database";

export type ChairAutomationStore = Pick<PlatformStore,
  | "applyChairAutomation"
  | "getSnapshot"
  | "recordAudit"
  | "releaseChairSuggestion"
  | "releaseSpeakerTurn"
>;

export type ProcessChairAutomationStatus =
  | "stale"
  | "deferred"
  | "applied"
  | "queued"
  | "queue_unavailable"
  | "queue_unknown";

export interface ProcessChairAutomationInput {
  store: ChairAutomationStore;
  data: ChairAutomationJobData;
  automationJobId: string;
  enqueueAgentTurn: (job: AgentTurnJobData, requestedJobId: string) => Promise<{ jobId: string }>;
  hasJob?: (jobId: string) => Promise<boolean>;
}

export interface ProcessChairAutomationResult {
  status: ProcessChairAutomationStatus;
  agentTurnJobId: string | null;
}

export function shouldCoordinateChairAfterAgentTurn(job: Pick<AgentTurnJobData, "requestedBy">): boolean {
  return job.requestedBy !== "system";
}

export async function recordAutomaticChairTurnFailure(
  store: ChairAutomationStore,
  job: AgentTurnJobData,
  jobId: string,
  classification = "provider_or_runtime_failure"
): Promise<void> {
  if (job.chairSuggestionId) {
    await store.releaseChairSuggestion(job.chairSuggestionId, jobId, classification);
  }
  await (job.reservationId
    ? store.releaseSpeakerTurn(jobId, classification, job.reservationId)
    : store.releaseSpeakerTurn(jobId, classification));
  await store.recordAudit("chair.automation.failed", "chair_suggestion", job.chairSuggestionId ?? job.meetingId, {
    meetingId: job.meetingId,
    classification,
    jobId,
    automationRevision: job.automationRevision ?? null
  });
}

export async function processChairAutomation(
  input: ProcessChairAutomationInput
): Promise<ProcessChairAutomationResult> {
  const snapshot = await input.store.getSnapshot();
  const suggestion = snapshot.chairSuggestions.find((item) => item.id === input.data.chairSuggestionId);
  const meeting = snapshot.meetings.find((item) => item.id === input.data.meetingId);
  const agentTurnJobId = suggestion?.suggestedAgentId
    ? automaticChairTurnJobId(input.data.meetingId, suggestion.suggestedAgentId, suggestion.id)
    : undefined;
  const participant = suggestion?.suggestedAgentId
    ? snapshot.participants.find((item) => item.meetingId === input.data.meetingId
        && item.agentId === suggestion.suggestedAgentId
        && item.isChair)
    : undefined;
  const recoveryReservation = meeting
    && suggestion
    && participant
    && agentTurnJobId
    && input.data.agentRevision !== undefined
    && input.data.modelConnectorBinding
    && input.data.runtimeProfileBinding
    && input.data.runtimeProfileSnapshot
    && input.data.skillDigests
    && meeting.state === "active"
    && meeting.automation === "auto"
    && (meeting.automationRevision ?? 0) === input.data.automationRevision
    && suggestion.meetingId === meeting.id
    && suggestion.sourceUtteranceId === input.data.sourceUtteranceId
    && suggestion.status === "pending"
    && suggestion.requestedAgentId === suggestion.suggestedAgentId
    && suggestion.requestedAgentJobId === agentTurnJobId
    ? snapshot.speakerQueue.find((item) => item.id === agentTurnJobId
        && item.jobId === agentTurnJobId
        && item.kind === "agent_turn"
        && item.status === "queued"
        && item.meetingId === meeting.id
        && item.agentId === suggestion.suggestedAgentId
        && item.participantId === participant.id
        && item.requestedBy === "system"
        && item.chairSuggestionId === suggestion.id
        && item.automationRevision === input.data.automationRevision
        && item.agendaRevision !== null
        && item.runtimeProfileBinding?.profileId === input.data.runtimeProfileBinding!.profileId
        && item.runtimeProfileBinding.revision === input.data.runtimeProfileBinding!.revision)
    : undefined;
  if (suggestion && !recoveryReservation) {
    const decision = decideSnapshotChairAutoApply(snapshot, input.data.meetingId, suggestion);
    if (!decision.allowed) {
      const deferred = [
        "mode_would_broaden",
        "maximum_auto_applications",
        "time_already_applied",
        "short_acknowledgement",
        "repetition_different_speakers",
        "cooldown",
        "insufficient_contributions"
      ].includes(decision.reason);
      await input.store.recordAudit(
        deferred ? "chair.automation.deferred" : "chair.automation.cancelled",
        "chair_suggestion",
        suggestion.id,
        {
          meetingId: input.data.meetingId,
          classification: decision.reason,
          automationRevision: input.data.automationRevision,
          automationJobId: input.automationJobId
        }
      );
      return { status: deferred ? "deferred" : "stale", agentTurnJobId: null };
    }
  }
  const runtimeRun = agentTurnJobId
    && participant
    && input.data.agentRevision !== undefined
    && input.data.runtimeProfileSnapshot
    ? createQueuedRuntimeRun({
        id: randomUUID(),
        kind: "meeting_turn",
        scope: {
          id: `meeting:${input.data.meetingId}:participant:${participant.id}`,
          kind: "meeting_participant",
          subjectId: participant.id,
          parentScopeId: `meeting:${input.data.meetingId}`
        },
        runtimeProfile: input.data.runtimeProfileSnapshot,
        agentId: suggestion!.suggestedAgentId!,
        agentRevision: input.data.agentRevision,
        roleId: recoveryReservation?.roleId ?? participant.roleId,
        roleRevision: recoveryReservation?.roleRevision ?? participant.roleRevision,
        attempt: 1,
        idempotencyKey: agentTurnJobId,
        queuedAt: recoveryReservation?.requestedAt ?? new Date().toISOString(),
        ttlMs: runtimeRunQueueTtlMs(input.data.runtimeProfileSnapshot)
      })
    : undefined;
  const recoveredAgentTurnJob: AgentTurnJobData | null = recoveryReservation
    && suggestion
    && runtimeRun
    && recoveryReservation.agendaRevision !== null
    ? {
        meetingId: recoveryReservation.meetingId,
        agentId: recoveryReservation.agentId,
        ...(recoveryReservation.reservationId ? { reservationId: recoveryReservation.reservationId } : {}),
        participantId: recoveryReservation.participantId,
        roleRevision: recoveryReservation.roleRevision,
        roleId: recoveryReservation.roleId,
        roleVersion: recoveryReservation.roleVersion,
        agendaRevision: recoveryReservation.agendaRevision,
        agendaCurrentItemId: recoveryReservation.agendaCurrentItemId,
        requestedBy: "system",
        chairSuggestionId: suggestion.id,
        automationRevision: input.data.automationRevision,
        ...(input.data.modelConnectorBinding ? { modelConnectorBinding: input.data.modelConnectorBinding } : {}),
        ...(input.data.agentRevision === undefined ? {} : { agentRevision: input.data.agentRevision }),
        ...(input.data.promptBinding === undefined ? {} : { promptBinding: input.data.promptBinding }),
        ...(input.data.credentialBinding ? { credentialBinding: input.data.credentialBinding } : {}),
        ...(input.data.skillDigests ? { skillDigests: input.data.skillDigests } : {}),
        ...(input.data.runtimeProfileBinding ? { runtimeProfileBinding: input.data.runtimeProfileBinding } : {}),
        ...(input.data.runtimeProfileSnapshot ? { runtimeProfileSnapshot: input.data.runtimeProfileSnapshot } : {}),
        runtimeRun
      }
    : null;
  const applied = recoveredAgentTurnJob && recoveryReservation && meeting && suggestion
    ? {
        status: "applied" as const,
        meeting,
        suggestion,
        queueItem: recoveryReservation,
        agentTurnJob: recoveredAgentTurnJob
      }
    : await input.store.applyChairAutomation({
      meetingId: input.data.meetingId,
      chairSuggestionId: input.data.chairSuggestionId,
      sourceUtteranceId: input.data.sourceUtteranceId,
      automationRevision: input.data.automationRevision,
      ...(input.data.modelConnectorBinding ? { modelConnectorBinding: input.data.modelConnectorBinding } : {}),
      ...(input.data.agentRevision === undefined ? {} : { agentRevision: input.data.agentRevision }),
      ...(input.data.promptBinding === undefined ? {} : { promptBinding: input.data.promptBinding }),
      ...(input.data.credentialBinding ? { credentialBinding: input.data.credentialBinding } : {}),
      ...(input.data.skillDigests ? { skillDigests: input.data.skillDigests } : {}),
      ...(input.data.runtimeProfileBinding ? { runtimeProfileBinding: input.data.runtimeProfileBinding } : {}),
      ...(input.data.runtimeProfileSnapshot ? { runtimeProfileSnapshot: input.data.runtimeProfileSnapshot } : {}),
      ...(runtimeRun ? { runtimeRun } : {}),
      ...(agentTurnJobId ? { agentTurnJobId } : {})
    });
  if (applied.status === "stale") {
    await input.store.recordAudit("chair.automation.cancelled", "chair_suggestion", input.data.chairSuggestionId, {
      meetingId: input.data.meetingId,
      classification: "stale_policy",
      automationRevision: input.data.automationRevision,
      automationJobId: input.automationJobId
    });
    return { status: "stale", agentTurnJobId: null };
  }
  if (!applied.agentTurnJob || !applied.queueItem || !agentTurnJobId) {
    return { status: "applied", agentTurnJobId: null };
  }

  try {
    const queued = await input.enqueueAgentTurn(applied.agentTurnJob, agentTurnJobId);
    if (queued.jobId !== agentTurnJobId) throw new Error("Agent turn queue returned a mismatched automatic Chair job ID.");
  } catch (error) {
    const accepted = input.hasJob
      ? await input.hasJob(agentTurnJobId).catch(() => null)
      : null;
    if (accepted !== true) {
      if (accepted === false) {
        await input.store.releaseSpeakerTurn(
          agentTurnJobId,
          "automatic_chair_enqueue_failed",
          applied.queueItem.reservationId ?? undefined
        );
        await input.store.releaseChairSuggestion(
          input.data.chairSuggestionId,
          agentTurnJobId,
          "Automatic Chair turn could not be enqueued."
        );
      }
      await input.store.recordAudit("chair.automation.failed", "chair_suggestion", input.data.chairSuggestionId, {
        meetingId: input.data.meetingId,
        classification: accepted === false ? "queue_unavailable" : "queue_acceptance_unknown",
        automationRevision: input.data.automationRevision,
        automationJobId: input.automationJobId,
        agentTurnJobId
      });
      return {
        status: accepted === false ? "queue_unavailable" : "queue_unknown",
        agentTurnJobId
      };
    }
  }
  await input.store.recordAudit("agent.turn.queued", "meeting", input.data.meetingId, {
    agentId: applied.agentTurnJob.agentId,
    participantId: applied.agentTurnJob.participantId,
    roleRevision: applied.agentTurnJob.roleRevision,
    roleId: applied.agentTurnJob.roleId,
    roleVersion: applied.agentTurnJob.roleVersion,
    jobId: agentTurnJobId,
    agendaRevision: applied.agentTurnJob.agendaRevision,
    agendaCurrentItemId: applied.agentTurnJob.agendaCurrentItemId,
    requestedBy: "system",
    automationRevision: input.data.automationRevision
  });
  return { status: "queued", agentTurnJobId };
}
