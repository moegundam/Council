import type {
  GoalReviewJobData,
  GoalReviewModelConnectorBinding,
  LegacyGoalReviewJobData,
  ParticipantAssignment,
  PlatformSnapshot
} from "@council/contracts";
import { goalReviewJobDataSchema, legacyGoalReviewJobDataSchema } from "@council/contracts";
import { goalReviewRequestFingerprint, roleExecutionSnapshotDigest } from "@council/database";
import { credentialIsExpired } from "@council/domain";

type GoalReviewBinding = Pick<GoalReviewJobData,
  | "reviewerParticipantId"
  | "reviewerRoleId"
  | "reviewerRoleRevision"
  | "reviewerRoleSnapshotDigest"
  | "modelConnectorBinding"
  | "credentialBinding"
>;

function sameBinding(left: GoalReviewBinding, right: GoalReviewBinding): boolean {
  return left.reviewerParticipantId === right.reviewerParticipantId
    && left.reviewerRoleId === right.reviewerRoleId
    && left.reviewerRoleRevision === right.reviewerRoleRevision
    && left.reviewerRoleSnapshotDigest === right.reviewerRoleSnapshotDigest
    && left.modelConnectorBinding.id === right.modelConnectorBinding.id
    && left.modelConnectorBinding.revision === right.modelConnectorBinding.revision
    && left.modelConnectorBinding.location === right.modelConnectorBinding.location
    && left.modelConnectorBinding.baseUrl === right.modelConnectorBinding.baseUrl
    && left.modelConnectorBinding.model === right.modelConnectorBinding.model
    && left.modelConnectorBinding.credentialId === right.modelConnectorBinding.credentialId
    && left.modelConnectorBinding.secretRevision === right.modelConnectorBinding.secretRevision
    && (left.credentialBinding?.credentialId ?? null) === (right.credentialBinding?.credentialId ?? null)
    && (left.credentialBinding?.secretRevision ?? 0) === (right.credentialBinding?.secretRevision ?? 0)
    && (left.credentialBinding?.provider ?? null) === (right.credentialBinding?.provider ?? null)
    && (left.credentialBinding?.location ?? null) === (right.credentialBinding?.location ?? null);
}

export function createGoalReviewBinding(
  snapshot: PlatformSnapshot,
  modelConnectorId: string,
  participant: ParticipantAssignment
): GoalReviewBinding {
  const agent = snapshot.agents.find((candidate) => candidate.id === participant.agentId);
  if (!agent || agent.lifecycleStatus === "disabled") {
    throw new Error("Reviewer Agent authorization is unavailable or changed.");
  }
  const roleHistory = participant.roleHistory.find((entry) => entry.revision === participant.roleRevision);
  if (!roleHistory
    || roleHistory.roleId !== participant.roleId
    || roleHistory.roleSnapshot.roleId !== participant.roleId
    || !roleHistory.roleSnapshot.orchestrationFunctions.includes("reviewer")
    || roleExecutionSnapshotDigest(roleHistory.roleSnapshot) !== roleExecutionSnapshotDigest(participant.roleSnapshot)) {
    throw new Error("Reviewer Role authorization is unavailable or changed.");
  }
  const roleBinding = {
    reviewerParticipantId: participant.id,
    reviewerRoleId: roleHistory.roleId,
    reviewerRoleRevision: roleHistory.revision,
    reviewerRoleSnapshotDigest: roleExecutionSnapshotDigest(roleHistory.roleSnapshot)
  };
  const connector = snapshot.modelConnectors.find((candidate) => candidate.id === modelConnectorId && candidate.enabled);
  if (!connector) throw new Error("Reviewer Model Connector is unavailable or changed.");
  const modelConnectorBinding: GoalReviewModelConnectorBinding = {
    id: connector.id,
    revision: connector.revision,
    location: connector.location,
    baseUrl: connector.baseUrl,
    model: connector.model,
    credentialId: connector.credentialId ?? null,
    secretRevision: connector.secretRevision
  };
  if (!connector.credentialId) {
    if (connector.location !== "local" || connector.hasSecret) {
      throw new Error("Reviewer Model Connector has no usable Credential binding.");
    }
    return { ...roleBinding, modelConnectorBinding };
  }
  const credential = (snapshot.credentials ?? []).find((candidate) => candidate.id === connector.credentialId);
  if (!credential
    || credential.location !== connector.location
    || credential.status !== "active"
    || !credential.hasSecret
    || !connector.hasSecret
    || credentialIsExpired(credential.expiresAt)
    || credential.secretRevision !== connector.secretRevision) {
    throw new Error("Reviewer Credential binding is unavailable, expired, or changed.");
  }
  return {
    ...roleBinding,
    modelConnectorBinding,
    credentialBinding: {
      credentialId: credential.id,
      secretRevision: credential.secretRevision,
      provider: credential.provider,
      location: credential.location
    }
  };
}

export function assertCurrentGoalReviewBinding(
  data: GoalReviewJobData,
  snapshot: PlatformSnapshot,
  expectedMeetingId?: string
): GoalReviewModelConnectorBinding {
  if (data.modelConnectorId !== data.modelConnectorBinding.id) {
    throw new Error("Reviewer Model Connector binding changed after queue admission.");
  }
  const participant = snapshot.participants.find((candidate) => candidate.id === data.reviewerParticipantId);
  if (!participant
    || participant.agentId !== data.reviewerAgentId
    || participant.agentRevision !== data.reviewerAgentRevision
    || (expectedMeetingId !== undefined && participant.meetingId !== expectedMeetingId)) {
    throw new Error("Reviewer participant authorization changed after queue admission.");
  }
  const current = createGoalReviewBinding(snapshot, data.modelConnectorId, participant);
  if (!sameBinding(data, current)) {
    throw new Error("Reviewer Role, Model Connector, or Credential binding changed after queue admission.");
  }
  return current.modelConnectorBinding;
}

export function goalReviewAdmissionFingerprint(data: GoalReviewJobData): string {
  const parsed = goalReviewJobDataSchema.parse(data);
  return goalReviewRequestFingerprint(parsed);
}

export function goalReviewJobIdDigest(data: GoalReviewJobData): string {
  return goalReviewAdmissionFingerprint(data).slice(3, 19);
}

export function legacyGoalReviewAdmissionFingerprint(data: LegacyGoalReviewJobData): string {
  return [
    data.goalRunId,
    data.scope,
    data.scopeId,
    data.reviewerAgentId,
    data.reviewerAgentRevision,
    data.modelConnectorId,
    data.contractDigest
  ].join(":");
}

export function recoverLegacyGoalReviewJobData(
  fingerprint: string,
  expectedGoalRunId: string
): LegacyGoalReviewJobData {
  const parts = fingerprint.split(":");
  if (parts.length !== 7 || parts[0] !== expectedGoalRunId) {
    throw new Error("Legacy Goal Review recovery fingerprint is invalid.");
  }
  const scope = parts[1];
  const reviewerAgentRevision = Number(parts[4]);
  if ((scope !== "task" && scope !== "goal" && scope !== "action")
    || !Number.isSafeInteger(reviewerAgentRevision)
    || reviewerAgentRevision <= 0
    || !/^[a-f0-9]{64}$/.test(parts[6]!)) {
    throw new Error("Legacy Goal Review recovery fingerprint is invalid.");
  }
  return legacyGoalReviewJobDataSchema.parse({
    goalRunId: parts[0]!,
    scope,
    scopeId: parts[2]!,
    reviewerAgentId: parts[3]!,
    reviewerAgentRevision,
    modelConnectorId: parts[5]!,
    contractDigest: parts[6]!,
    requestedBy: "system"
  });
}
