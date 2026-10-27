import { randomUUID } from "node:crypto";
import type {
  AgentTurnJobData,
  CredentialBinding,
  PlatformSnapshot,
  RuntimeProfileSnapshot,
  Utterance
} from "@council/contracts";
import type { PlatformStore } from "@council/database";
import { skillHasCurrentApprovedValidation } from "@council/database";
import {
  createQueuedRuntimeRun,
  credentialIsExpired,
  permittedAgentIdsForMeeting,
  resolveRuntimeProfileAdmission,
  runtimeRunQueueTtlMs,
  type SecretVault
} from "@council/domain";
import type { AgentHarness } from "@council/runtime";
import { processAgentTurn, recordAgentTurnFailure } from "./process-agent-turn.js";

const autonomousMeetingTurnMaxTokens = 256;

export interface RunGoalMeetingRoundInput {
  store: PlatformStore;
  goalRunId: string;
  meetingId: string;
  round: number;
  secretVault: SecretVault;
  harnessFor?(runtime: RuntimeProfileSnapshot): AgentHarness | undefined;
  onUtterance?(utterance: Utterance, jobId: string): Promise<void>;
}

export interface GoalMeetingRoundResult {
  utterances: Utterance[];
  modelCalls: number;
}

function credentialBinding(
  snapshot: PlatformSnapshot,
  connector: PlatformSnapshot["modelConnectors"][number]
): CredentialBinding | null {
  if (!connector.credentialId) {
    if (connector.location === "local" && !connector.hasSecret) return null;
    throw new Error("Goal Meeting Agent Model Connector has no active Credential binding.");
  }
  const credential = (snapshot.credentials ?? []).find((candidate) => candidate.id === connector.credentialId);
  if (!credential || credential.status !== "active" || !credential.hasSecret || credentialIsExpired(credential.expiresAt)) {
    throw new Error("Goal Meeting Agent Credential is unavailable or expired.");
  }
  if (credential.secretRevision !== connector.secretRevision) {
    throw new Error("Goal Meeting Agent Credential revision is stale.");
  }
  return {
    credentialId: credential.id,
    secretRevision: credential.secretRevision,
    provider: credential.provider,
    location: credential.location
  };
}

async function ensureCurrentAgenda(store: PlatformStore, meetingId: string, round: number): Promise<void> {
  let meeting = (await store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId);
  if (meeting && round > 1) {
    const current = meeting.agenda.items.find((item) => item.status === "current");
    if (current) {
      await store.advanceMeetingAgenda(meeting.id, {
        expectedRevision: meeting.agenda.revision,
        action: "complete",
        itemId: current.id
      });
      meeting = (await store.getSnapshot()).meetings.find((candidate) => candidate.id === meetingId);
    }
  }
  if (!meeting || meeting.agenda.items.some((item) => item.status === "current")) return;
  if (meeting.agenda.items.some((item) => item.status === "pending")) {
    await store.advanceMeetingAgenda(meeting.id, { expectedRevision: meeting.agenda.revision, action: "activate" });
  }
}

function selectNextAgent(snapshot: PlatformSnapshot, meetingId: string): string | null {
  const permitted = permittedAgentIdsForMeeting(snapshot, meetingId);
  if (permitted.length === 0) return null;
  const counts = new Map<string, number>();
  for (const utterance of snapshot.utterances.filter((candidate) => candidate.meetingId === meetingId && candidate.agentId)) {
    counts.set(utterance.agentId!, (counts.get(utterance.agentId!) ?? 0) + 1);
  }
  return [...permitted].sort((left, right) => (
    (counts.get(left) ?? 0) - (counts.get(right) ?? 0) || left.localeCompare(right)
  ))[0] ?? null;
}

async function createTurnJob(
  store: PlatformStore,
  snapshot: PlatformSnapshot,
  meetingId: string,
  agentId: string,
  jobId: string
): Promise<{ job: AgentTurnJobData; runtime: RuntimeProfileSnapshot }> {
  const meeting = snapshot.meetings.find((candidate) => candidate.id === meetingId);
  const participant = snapshot.participants.find((candidate) => candidate.meetingId === meetingId && candidate.agentId === agentId);
  const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
  if (!meeting || !participant || !agent || participant.agentRevision === undefined) {
    throw new Error("Goal Meeting participant binding is incomplete.");
  }
  const revision = await store.getAgentRevision(agentId, participant.agentRevision);
  if (!revision.modelConnectorId || !revision.runtimeProfileBinding) {
    throw new Error("Goal Meeting Agent runtime binding is incomplete.");
  }
  const connector = snapshot.modelConnectors.find((candidate) => candidate.id === revision.modelConnectorId && candidate.enabled);
  if (!connector) throw new Error("Goal Meeting Agent Model Connector is unavailable.");
  const runtime = resolveRuntimeProfileAdmission({
    binding: revision.runtimeProfileBinding,
    platform: snapshot,
    agentModelConnectorId: revision.modelConnectorId
  });
  const skills = revision.skillIds.map((skillId) => snapshot.skills.find((skill) => skill.id === skillId));
  if (skills.some((skill) => !skill || !skillHasCurrentApprovedValidation(skill))) {
    throw new Error("Goal Meeting Agent has a Skill binding that is no longer approved.");
  }
  const credential = credentialBinding(snapshot, connector);
  const runtimeRun = createQueuedRuntimeRun({
    id: randomUUID(),
    kind: "meeting_turn",
    scope: {
      id: `meeting:${meeting.id}:participant:${participant.id}`,
      kind: "meeting_participant",
      subjectId: participant.id,
      parentScopeId: `meeting:${meeting.id}`
    },
    runtimeProfile: runtime,
    agentId,
    agentRevision: revision.revision,
    roleId: participant.roleId,
    roleRevision: participant.roleRevision,
    attempt: 1,
    idempotencyKey: jobId,
    queuedAt: new Date().toISOString(),
    ttlMs: runtimeRunQueueTtlMs(runtime)
  });
  return {
    runtime,
    job: {
      meetingId,
      agentId,
      participantId: participant.id,
      roleRevision: participant.roleRevision,
      roleId: participant.roleId,
      roleVersion: participant.roleSnapshot.version,
      agendaRevision: meeting.agenda.revision,
      agendaCurrentItemId: meeting.agenda.items.find((item) => item.status === "current")?.id ?? null,
      requestedBy: "owner",
      modelConnectorBinding: {
        id: connector.id,
        location: connector.location,
        baseUrl: connector.baseUrl,
        model: connector.model,
        secretRevision: connector.secretRevision
      },
      agentRevision: revision.revision,
      promptBinding: revision.promptBinding,
      ...(credential ? { credentialBinding: credential } : {}),
      skillDigests: Object.fromEntries(skills.map((skill) => [skill!.id, skill!.contentDigest])),
      runtimeProfileBinding: { ...revision.runtimeProfileBinding },
      runtimeProfileSnapshot: runtime,
      runtimeRun
    }
  };
}

export async function runGoalMeetingRound(input: RunGoalMeetingRoundInput): Promise<GoalMeetingRoundResult> {
  await ensureCurrentAgenda(input.store, input.meetingId, input.round);
  const initial = await input.store.getSnapshot();
  const meeting = initial.meetings.find((candidate) => candidate.id === input.meetingId);
  if (!meeting || meeting.state !== "active") throw new Error("Goal Meeting must be active before autonomous discussion.");
  const participantCount = initial.participants.filter((candidate) => candidate.meetingId === meeting.id).length;
  if (participantCount < 2) throw new Error("Goal Meeting requires at least two runnable participants.");
  const utterances: Utterance[] = [];
  for (let turn = 1; turn <= participantCount; turn += 1) {
    const snapshot = await input.store.getSnapshot();
    const agentId = selectNextAgent(snapshot, meeting.id);
    if (!agentId) throw new Error("Goal Meeting has no Agent permitted to take the next formal turn.");
    const jobId = `goal-meeting-${input.goalRunId}-r${input.round}-t${turn}-${agentId}`;
    const existing = snapshot.utterances.find((candidate) => candidate.turnId === jobId);
    if (existing) {
      utterances.push(existing);
      continue;
    }
    const prepared = await createTurnJob(input.store, snapshot, meeting.id, agentId, jobId);
    const reservation = await input.store.reserveSpeakerTurn(jobId, prepared.job);
    if (!reservation.reservationId) throw new Error("Goal Meeting turn reservation has no execution identity.");
    const claimed = await input.store.markSpeakerTurnRunning(jobId, reservation.reservationId);
    if (!claimed) throw new Error("Goal Meeting turn reservation could not be claimed.");
    try {
      const harness = input.harnessFor?.(prepared.runtime);
      const utterance = await processAgentTurn({
        store: input.store,
        meetingId: meeting.id,
        agentId,
        participantId: prepared.job.participantId,
        roleRevision: prepared.job.roleRevision,
        roleId: prepared.job.roleId,
        roleVersion: prepared.job.roleVersion,
        turnId: jobId,
        reservationId: reservation.reservationId,
        agendaRevision: prepared.job.agendaRevision!,
        agendaCurrentItemId: prepared.job.agendaCurrentItemId ?? null,
        reservationRequired: true,
        requestedBy: "owner",
        maxTokens: autonomousMeetingTurnMaxTokens,
        modelConnectorBinding: prepared.job.modelConnectorBinding!,
        agentRevision: prepared.job.agentRevision!,
        ...(prepared.job.promptBinding !== undefined ? { promptBinding: prepared.job.promptBinding } : {}),
        ...(prepared.job.credentialBinding ? { credentialBinding: prepared.job.credentialBinding } : {}),
        skillDigests: prepared.job.skillDigests!,
        runtimeProfileBinding: prepared.job.runtimeProfileBinding!,
        runtimeProfileSnapshot: prepared.job.runtimeProfileSnapshot!,
        runtimeRun: prepared.job.runtimeRun!,
        secretVault: input.secretVault,
        ...(harness ? { harness } : {})
      });
      utterances.push(utterance);
      await input.onUtterance?.(utterance, jobId);
    } catch (error) {
      await recordAgentTurnFailure(
        input.store,
        meeting.id,
        jobId,
        `Goal Meeting Agent turn failed: ${error instanceof Error ? error.message : "unknown error"}`,
        reservation.reservationId,
        "goal_meeting_turn_failure"
      ).catch(() => undefined);
      throw error;
    }
  }
  return { utterances, modelCalls: utterances.length };
}
