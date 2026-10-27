import type {
  ChairAutomationJobData,
  ChairSuggestionRecord,
  PlatformSnapshot
} from "@council/contracts";
import {
  decideChairAutoApply,
  evaluateMeetingChairSuggestion,
  type ChairAutoApplyDecision
} from "@council/domain";
import {
  type PlatformStore,
  StoreConflictError
} from "./store.js";
import { resolveRuntimeProfileSnapshotForBinding } from "./runtime-profiles.js";
import { skillHasCurrentApprovedValidation } from "./skill-governance.js";

export type ChairAutomationDisposition =
  | "manual"
  | "no_suggestion"
  | "suggested"
  | "deferred"
  | "queued"
  | "queue_unavailable"
  | "reconciliation_required"
  | "stale_policy";

export interface ChairInterventionResult {
  suggestion: ChairSuggestionRecord | null;
  disposition: ChairAutomationDisposition;
  jobId: string | null;
}

type ChairAutomationStore = Pick<
  PlatformStore,
  | "confirmChairAutomationJobAdmission"
  | "createChairSuggestion"
  | "getAgentRevision"
  | "getSnapshot"
  | "recordAudit"
  | "releaseChairAutomationJobAdmission"
  | "requireChairAutomationJobReconciliation"
  | "reserveChairAutomationJobAdmission"
>;

export interface CoordinateChairInterventionInput {
  store: ChairAutomationStore;
  meetingId: string;
  sourceUtteranceId: string;
  now?: number;
  enqueue?: (job: ChairAutomationJobData, requestedJobId: string) => Promise<{ jobId: string }>;
  hasJob?: (jobId: string) => Promise<boolean>;
  getJobState?: (jobId: string) => Promise<string | null>;
}

const chairQueueOwnedStates = new Set([
  "active",
  "delayed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children"
]);

export function chairAutomationJobId(meetingId: string, suggestionId: string): string {
  return `${meetingId}-chair-auto-${suggestionId}`;
}

export function automaticChairTurnJobId(meetingId: string, agentId: string, suggestionId: string): string {
  return `${meetingId}-${agentId}-chair-auto-${suggestionId}`;
}

export function decideSnapshotChairAutoApply(
  snapshot: PlatformSnapshot,
  meetingId: string,
  suggestion: ChairSuggestionRecord,
  now?: number
): ChairAutoApplyDecision {
  const meeting = snapshot.meetings.find((item) => item.id === meetingId);
  if (!meeting) return { allowed: false, reason: "meeting_not_active" };
  const chairAgentId = snapshot.participants.find(
    (participant) => participant.meetingId === meeting.id && participant.isChair
  )?.agentId;
  return decideChairAutoApply({
    meeting,
    suggestion,
    history: snapshot.chairSuggestions,
    contributions: snapshot.utterances
      .filter((utterance) => utterance.meetingId === meeting.id)
      .map((utterance) => ({
        id: utterance.id,
        createdAt: utterance.createdAt,
        speakerType: utterance.speakerType,
        speakerName: utterance.speakerName,
        ...(utterance.agentId ? { speakerId: utterance.agentId } : {}),
        isChair: Boolean(utterance.agentId && utterance.agentId === chairAgentId),
        content: utterance.content
      })),
    ...(now === undefined ? {} : { now })
  });
}

export async function coordinateChairIntervention(
  input: CoordinateChairInterventionInput
): Promise<ChairInterventionResult> {
  const snapshot = await input.store.getSnapshot();
  const meeting = snapshot.meetings.find((item) => item.id === input.meetingId);
  if (!meeting || meeting.state !== "active") {
    return { suggestion: null, disposition: "stale_policy", jobId: null };
  }
  if (meeting.automation === "manual") {
    return { suggestion: null, disposition: "manual", jobId: null };
  }
  const latestContribution = snapshot.utterances
    .filter((item) => item.meetingId === meeting.id && (item.speakerType === "human" || item.speakerType === "agent"))
    .at(-1);
  if (!latestContribution || latestContribution.id !== input.sourceUtteranceId) {
    return { suggestion: null, disposition: "stale_policy", jobId: null };
  }
  const proposal = evaluateMeetingChairSuggestion(snapshot, meeting.id, input.now);
  if (!proposal) return { suggestion: null, disposition: "no_suggestion", jobId: null };

  let suggestion: ChairSuggestionRecord;
  try {
    suggestion = (await input.store.createChairSuggestion(
      meeting.id,
      input.sourceUtteranceId,
      proposal,
      {
        automation: meeting.automation,
        automationRevision: meeting.automationRevision ?? 0
      }
    )).suggestion;
  } catch (error) {
    if (error instanceof StoreConflictError) {
      return { suggestion: null, disposition: "stale_policy", jobId: null };
    }
    throw error;
  }
  if (meeting.automation === "suggest") {
    return { suggestion, disposition: "suggested", jobId: null };
  }

  const autoDecision = decideSnapshotChairAutoApply(snapshot, meeting.id, suggestion, input.now);
  if (!autoDecision.allowed) {
    await input.store.recordAudit("chair.automation.deferred", "chair_suggestion", suggestion.id, {
      meetingId: meeting.id,
      classification: autoDecision.reason,
      automationRevision: meeting.automationRevision ?? 0,
      reason: suggestion.reason,
      score: suggestion.score
    });
    return { suggestion, disposition: "deferred", jobId: null };
  }

  const suggestedAgent = suggestion.suggestedAgentId
    ? snapshot.agents.find((agent) => agent.id === suggestion.suggestedAgentId)
    : undefined;
  const suggestedParticipant = suggestion.suggestedAgentId
    ? snapshot.participants.find((participant) => participant.meetingId === meeting.id
        && participant.agentId === suggestion.suggestedAgentId
        && participant.isChair)
    : undefined;
  let suggestedRevision: Awaited<ReturnType<ChairAutomationStore["getAgentRevision"]>> | undefined;
  if (suggestedAgent && suggestedParticipant?.agentRevision !== undefined) {
    try {
      suggestedRevision = await input.store.getAgentRevision(suggestedAgent.id, suggestedParticipant.agentRevision);
    } catch {
      suggestedRevision = undefined;
    }
  }
  const suggestedConnectorId = suggestedRevision?.modelConnectorId ?? suggestedAgent?.modelConnectorId;
  const suggestedConnector = suggestedConnectorId
    ? snapshot.modelConnectors.find((connector) => connector.id === suggestedConnectorId && connector.enabled)
    : undefined;
  const suggestedSkillIds = suggestedRevision?.skillIds ?? suggestedAgent?.skillIds ?? [];
  const suggestedSkills = suggestedAgent
    ? suggestedSkillIds.map((skillId) => snapshot.skills.find((skill) => skill.id === skillId))
    : [];
  const suggestedPromptBinding = suggestedRevision?.promptBinding ?? null;
  const suggestedRuntimeProfileBinding = suggestedRevision?.runtimeProfileBinding ?? suggestedAgent?.runtimeProfileBinding ?? null;
  const suggestedRuntimeProfileSnapshot = resolveRuntimeProfileSnapshotForBinding({
    binding: suggestedRuntimeProfileBinding,
    runtimeProfiles: snapshot.runtimeProfiles,
    runtimeProfileRevisions: snapshot.runtimeProfileRevisions,
    agentModelConnectorId: suggestedRevision?.modelConnectorId ?? suggestedAgent?.modelConnectorId ?? null
  });
  const suggestedPrompt = suggestedPromptBinding
    ? (snapshot.prompts ?? []).find((prompt) => prompt.id === suggestedPromptBinding.promptId)
    : undefined;
  const suggestedCredential = suggestedConnector?.credentialId
    ? (snapshot.credentials ?? []).find((credential) => credential.id === suggestedConnector.credentialId)
    : undefined;
  const credentialBinding = suggestedCredential ? {
    credentialId: suggestedCredential.id,
    secretRevision: suggestedCredential.secretRevision,
    provider: suggestedCredential.provider,
    location: suggestedCredential.location
  } : undefined;
  const boundCredentialInvalid = Boolean(suggestedRevision && suggestedConnector && (
    suggestedConnector.credentialId
      ? !suggestedCredential
        || suggestedCredential.status !== "active"
        || !suggestedCredential.hasSecret
        || suggestedCredential.secretRevision !== suggestedConnector.secretRevision
      : suggestedConnector.location !== "local" || suggestedConnector.hasSecret
  ));
  const boundPromptInvalid = Boolean(suggestedRevision && suggestedPromptBinding && (
    !suggestedPrompt
      || suggestedPrompt.status === "archived"
      || suggestedPrompt.publishedVersion === null
      || suggestedPrompt.publishedVersion < suggestedPromptBinding.version
  ));
  if (suggestion.suggestedAgentId
    && (!suggestedAgent
      || suggestedAgent.lifecycleStatus === "disabled"
      || !suggestedParticipant
      || !suggestedRevision
      || !suggestedConnector
      || boundCredentialInvalid
      || boundPromptInvalid
      || !suggestedRuntimeProfileBinding
      || !suggestedRuntimeProfileSnapshot
      || suggestedSkills.some((skill) => !skill || !skillHasCurrentApprovedValidation(skill)))) {
    await input.store.recordAudit("chair.automation.deferred", "chair_suggestion", suggestion.id, {
      meetingId: meeting.id,
      classification: "execution_binding_unavailable",
      automationRevision: meeting.automationRevision ?? 0
    });
    return { suggestion, disposition: "deferred", jobId: null };
  }

  const job: ChairAutomationJobData = {
    meetingId: meeting.id,
    chairSuggestionId: suggestion.id,
    sourceUtteranceId: input.sourceUtteranceId,
    automationRevision: meeting.automationRevision ?? 0,
    requestedBy: "system",
    ...(suggestedConnector ? {
      modelConnectorBinding: {
        id: suggestedConnector.id,
        location: suggestedConnector.location,
        baseUrl: suggestedConnector.baseUrl,
        model: suggestedConnector.model,
        secretRevision: suggestedConnector.secretRevision
      }
    } : {}),
    ...(suggestedAgent ? {
      ...(suggestedRevision ? {
        agentRevision: suggestedRevision.revision,
        promptBinding: suggestedPromptBinding
      } : {}),
      ...(credentialBinding ? { credentialBinding } : {}),
      ...(suggestedRuntimeProfileBinding && suggestedRuntimeProfileSnapshot ? {
        runtimeProfileBinding: { ...suggestedRuntimeProfileBinding },
        runtimeProfileSnapshot: structuredClone(suggestedRuntimeProfileSnapshot)
      } : {}),
      skillDigests: Object.fromEntries(suggestedSkills.map((skill) => [skill!.id, skill!.contentDigest]))
    } : {})
  };
  const requestedJobId = chairAutomationJobId(meeting.id, suggestion.id);
  if (!input.enqueue) {
    await input.store.recordAudit("chair.automation.enqueue_failed", "chair_suggestion", suggestion.id, {
      meetingId: meeting.id,
      classification: "queue_unavailable",
      automationRevision: job.automationRevision
    });
    return { suggestion, disposition: "queue_unavailable", jobId: null };
  }

  let admission: Awaited<ReturnType<PlatformStore["reserveChairAutomationJobAdmission"]>>;
  try {
    admission = await input.store.reserveChairAutomationJobAdmission(
      suggestion.id,
      requestedJobId,
      job.automationRevision
    );
  } catch (error) {
    if (error instanceof StoreConflictError) {
      return { suggestion, disposition: "stale_policy", jobId: null };
    }
    throw error;
  }
  if (admission.admission?.status === "reconciliation_required") {
    return { suggestion, disposition: "reconciliation_required", jobId: requestedJobId };
  }
  if (admission.admission?.status === "admitted") {
    return { suggestion, disposition: "queued", jobId: requestedJobId };
  }

  try {
    const queued = await input.enqueue(job, requestedJobId);
    if (queued.jobId !== requestedJobId) throw new Error("Chair automation queue returned a mismatched job ID.");
  } catch (error) {
    let queueState: string | null | undefined;
    let ownershipKnown = false;
    try {
      if (input.getJobState) {
        queueState = await input.getJobState(requestedJobId);
        ownershipKnown = true;
      } else if (input.hasJob) {
        queueState = await input.hasJob(requestedJobId) ? "present" : undefined;
      }
    } catch {
      queueState = undefined;
    }
    const accepted = queueState === "present"
      || (typeof queueState === "string" && chairQueueOwnedStates.has(queueState));
    if (!accepted && ownershipKnown && queueState === null) {
      await input.store.releaseChairAutomationJobAdmission(
        suggestion.id,
        requestedJobId,
        "queue_unavailable"
      );
      return { suggestion, disposition: "queue_unavailable", jobId: null };
    }
    if (!accepted) {
      const reason = ownershipKnown && typeof queueState === "string"
        ? "queue_state_terminal"
        : "queue_ownership_unknown";
      await input.store.requireChairAutomationJobReconciliation(
        suggestion.id,
        requestedJobId,
        reason
      );
      return { suggestion, disposition: "reconciliation_required", jobId: requestedJobId };
    }
  }
  await input.store.confirmChairAutomationJobAdmission(suggestion.id, requestedJobId);
  return { suggestion, disposition: "queued", jobId: requestedJobId };
}
