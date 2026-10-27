import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import {
  createRuntimeProfileSnapshot,
  type AgentTurnJobData,
  type RuntimeHarnessKind,
  type RuntimeProfileSnapshot
} from "@council/contracts";
import { createQueuedRuntimeRun, runtimeRunQueueTtlMs, SecretVault } from "@council/domain";
import type {
  AgentHarness,
  AgentHarnessProfile,
  AgentHarnessTurnInput,
  CompletionRequest,
  CompletionResult
} from "@council/runtime";
import { agentTurnFailureDisposition } from "./job-lifecycle.js";
import { processAgentTurn, recordAgentTurnFailure } from "./process-agent-turn.js";

const runIds = {
  cloud: "77000000-0000-4000-8000-000000000001",
  gb10: "77000000-0000-4000-8000-000000000002",
  codex: "77000000-0000-4000-8000-000000000003",
  codexFailure: "77000000-0000-4000-8000-000000000004"
} as const;

class RecordingHarness implements AgentHarness {
  readonly calls: AgentHarnessTurnInput[] = [];

  constructor(
    private readonly harnessKind: RuntimeHarnessKind,
    private readonly result: CompletionResult | Error
  ) {}

  profile(): AgentHarnessProfile {
    return { kind: this.harnessKind, version: "fake-1", capabilities: ["text", "abort"] };
  }

  async health() {
    return { healthy: true };
  }

  async runTurn(input: AgentHarnessTurnInput): Promise<CompletionResult> {
    this.calls.push(structuredClone(input));
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  async cancel() {
    return { accepted: false as const, reason: "not_active" as const };
  }
}

interface MixedRoute {
  name: "cloud" | "gb10" | "codex";
  agentId: string;
  connectorId: string;
  profileId: string;
  harnessKind: RuntimeHarnessKind;
}

interface QueuedTurn {
  turnId: string;
  data: AgentTurnJobData;
  runtimeProfile: RuntimeProfileSnapshot;
}

async function createMixedRuntimeMeeting() {
  const store = new InMemoryPlatformStore();
  const seed = await store.getSnapshot();
  const seedMeeting = seed.meetings[0]!;
  await store.setMeetingState(seedMeeting.id, "closed", "active");

  const secretVault = new SecretVault(Buffer.alloc(32, 6));
  const cloudCredential = await store.createCredential({
    name: "Synthetic cloud credential",
    provider: "openai-compatible-fixture",
    kind: "api_key",
    location: "cloud",
    expiresAt: null
  }, { ciphertext: secretVault.encrypt("synthetic-test-token") });

  const cloudConnector = await store.createModelConnector({
    name: "Cloud OpenAI-compatible fixture",
    location: "cloud",
    baseUrl: "https://cloud.example.test/v1",
    model: "cloud-meeting-model",
    credentialId: cloudCredential.id
  });
  const gb10Connector = await store.createModelConnector({
    name: "GB10 OpenAI-compatible fixture",
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "gb10-meeting-model"
  });
  const codexConnector = await store.createModelConnector({
    name: "Codex harness fixture",
    location: "local",
    baseUrl: "http://192.168.50.11:8789/v1",
    model: "codex-harness-model"
  });

  const cloudProfile = await store.createRuntimeProfile({
    name: "Cloud OpenAI-compatible runtime",
    harnessKind: "openai_compatible",
    modelConnectorId: cloudConnector.id,
    sandboxProfileId: null,
    policy: "text_only",
    capabilities: ["text", "abort"],
    timeoutMs: 45_000,
    maxConcurrency: 1,
    enabled: true
  });
  const gb10Profile = await store.createRuntimeProfile({
    name: "GB10 OpenAI-compatible runtime",
    harnessKind: "openai_compatible",
    modelConnectorId: gb10Connector.id,
    sandboxProfileId: null,
    policy: "text_only",
    capabilities: ["text", "abort"],
    timeoutMs: 60_000,
    maxConcurrency: 1,
    enabled: true
  });
  const codexProfile = await store.createRuntimeProfile({
    name: "Codex runtime",
    harnessKind: "codex",
    modelConnectorId: codexConnector.id,
    sandboxProfileId: null,
    policy: "text_only",
    capabilities: ["text", "abort"],
    timeoutMs: 75_000,
    maxConcurrency: 1,
    enabled: true
  });
  const prompt = await store.createPrompt({
    name: "Mixed runtime acceptance prompt",
    kind: "agent",
    description: "Published fixture Prompt shared by all mixed-runtime participants.",
    owner: "R6 acceptance test",
    content: "Contribute one concise finding for the current Meeting goal.",
    variables: []
  });
  await store.publishPrompt(prompt.id, { expectedCurrentVersion: 1, version: 1 });

  const routes: MixedRoute[] = [
    {
      name: "cloud",
      agentId: seed.agents[0]!.id,
      connectorId: cloudConnector.id,
      profileId: cloudProfile.id,
      harnessKind: "openai_compatible"
    },
    {
      name: "gb10",
      agentId: seed.agents[1]!.id,
      connectorId: gb10Connector.id,
      profileId: gb10Profile.id,
      harnessKind: "openai_compatible"
    },
    {
      name: "codex",
      agentId: seed.agents[2]!.id,
      connectorId: codexConnector.id,
      profileId: codexProfile.id,
      harnessKind: "codex"
    }
  ];

  for (const route of routes) {
    const draft = await store.updateAgent(route.agentId, {
      modelConnectorId: route.connectorId,
      runtimeProfileBinding: { profileId: route.profileId, revision: 1 },
      promptBinding: { promptId: prompt.id, version: 1 }
    });
    await store.publishAgent(route.agentId, { expectedDraftRevision: draft.draftRevision! });
  }

  for (const profile of [cloudProfile, gb10Profile, codexProfile]) {
    await store.updateRuntimeProfile(profile.id, {
      expectedRevision: 1,
      timeoutMs: profile.timeoutMs + 1_000
    });
  }

  const published = await store.getSnapshot();
  const meeting = await store.createMeeting({
    threadId: seedMeeting.threadId,
    title: "Mixed runtime acceptance",
    goal: "Prove cloud, GB10, and Codex participants can share one Meeting.",
    mode: "open",
    automation: "suggest",
    durationMinutes: 30,
    participants: routes.map((route, index) => ({
      agentId: route.agentId,
      roleId: published.roles[index]!.id,
      isChair: index === 0
    })),
    agendaItems: [{ title: "Run mixed runtimes", description: "Exercise all three immutable runtime bindings." }]
  });
  await store.setMeetingState(meeting.id, "active", "draft");

  return { store, secretVault, meetingId: meeting.id, routes };
}

async function queuedTurn(
  store: InMemoryPlatformStore,
  meetingId: string,
  agentId: string,
  turnId: string,
  runtimeRunId: string
): Promise<QueuedTurn> {
  const snapshot = await store.getSnapshot();
  const meeting = snapshot.meetings.find((item) => item.id === meetingId)!;
  const participant = snapshot.participants.find((item) => item.meetingId === meetingId && item.agentId === agentId)!;
  const agent = snapshot.agents.find((item) => item.id === agentId)!;
  if (participant.agentRevision === undefined) throw new Error("Meeting participant is not pinned to a published Agent revision.");
  const agentRevision = await store.getAgentRevision(agentId, participant.agentRevision);
  const connector = snapshot.modelConnectors.find((item) => item.id === agentRevision.modelConnectorId)!;
  const runtimeProfileBinding = agentRevision.runtimeProfileBinding!;
  const runtimeProfileRevision = snapshot.runtimeProfileRevisions!.find((item) => (
    item.profileId === runtimeProfileBinding.profileId && item.revision === runtimeProfileBinding.revision
  ))!;
  const runtimeProfile = createRuntimeProfileSnapshot(runtimeProfileRevision);
  const credential = connector.credentialId
    ? snapshot.credentials!.find((item) => item.id === connector.credentialId)!
    : undefined;
  const agendaCurrentItemId = meeting.agenda.items.find((item) => item.status === "current")?.id ?? null;
  const queuedAt = new Date().toISOString();
  const data: AgentTurnJobData = {
    meetingId,
    agentId,
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version,
    agendaRevision: meeting.agenda.revision,
    agendaCurrentItemId,
    requestedBy: "owner",
    agentRevision: agentRevision.revision,
    promptBinding: agentRevision.promptBinding,
    modelConnectorBinding: {
      id: connector.id,
      location: connector.location,
      baseUrl: connector.baseUrl,
      model: connector.model,
      secretRevision: connector.secretRevision
    },
    ...(credential ? {
      credentialBinding: {
        credentialId: credential.id,
        secretRevision: credential.secretRevision,
        provider: credential.provider,
        location: credential.location
      }
    } : {}),
    skillDigests: Object.fromEntries(agentRevision.skillIds.map((skillId) => {
      const skill = snapshot.skills.find((item) => item.id === skillId)!;
      return [skill.id, skill.contentDigest];
    })),
    runtimeProfileBinding,
    runtimeProfileSnapshot: runtimeProfile,
    runtimeRun: createQueuedRuntimeRun({
      id: runtimeRunId,
      kind: "meeting_turn",
      scope: {
        id: `meeting:${meetingId}:participant:${participant.id}`,
        kind: "meeting_participant",
        subjectId: participant.id,
        parentScopeId: `meeting:${meetingId}`
      },
      runtimeProfile,
      agentId,
      agentRevision: agentRevision.revision,
      roleId: participant.roleId,
      roleRevision: participant.roleRevision,
      attempt: 1,
      idempotencyKey: turnId,
      queuedAt,
      ttlMs: runtimeRunQueueTtlMs(runtimeProfile)
    })
  };
  return { turnId, data, runtimeProfile };
}

function expectExactQueuedBinding(turn: QueuedTurn): void {
  const data = turn.data;
  expect(data.runtimeRun).toEqual(expect.objectContaining({
    kind: "meeting_turn",
    state: "queued",
    agentId: data.agentId,
    agentRevision: data.agentRevision,
    roleId: data.roleId,
    roleRevision: data.roleRevision,
    idempotencyKey: turn.turnId,
    scope: {
      id: `meeting:${data.meetingId}:participant:${data.participantId}`,
      kind: "meeting_participant",
      subjectId: data.participantId,
      parentScopeId: `meeting:${data.meetingId}`
    }
  }));
  expect(data.runtimeRun!.runtimeProfile).toEqual(turn.runtimeProfile);
  expect(data.runtimeProfileSnapshot).toEqual(turn.runtimeProfile);
  expect(data.runtimeProfileBinding).toEqual({
    profileId: turn.runtimeProfile.profileId,
    revision: turn.runtimeProfile.revision
  });
  expect(turn.runtimeProfile.modelConnectorId).toBe(data.modelConnectorBinding!.id);
}

async function runQueuedTurn(
  store: InMemoryPlatformStore,
  secretVault: SecretVault,
  turn: QueuedTurn,
  runtime: { complete?: (request: CompletionRequest) => Promise<CompletionResult>; harness?: AgentHarness }
) {
  const reservation = await store.reserveSpeakerTurn(turn.turnId, turn.data);
  await store.markSpeakerTurnRunning(turn.turnId, reservation.reservationId!);
  return processAgentTurn({
    store,
    turnId: turn.turnId,
    reservationId: reservation.reservationId!,
    reservationRequired: true,
    secretVault,
    ...turn.data,
    ...runtime
  });
}

describe("mixed-runtime Meeting acceptance", () => {
  it("pins and executes cloud, GB10, and Codex participants, then pauses without losing prior state on runtime failure", async () => {
    const fixture = await createMixedRuntimeMeeting();
    const { store, secretVault, meetingId, routes } = fixture;
    const audit = vi.spyOn(store, "recordAudit");
    const turns = {
      cloud: await queuedTurn(store, meetingId, routes[0]!.agentId, "mixed-cloud-turn", runIds.cloud),
      gb10: await queuedTurn(store, meetingId, routes[1]!.agentId, "mixed-gb10-turn", runIds.gb10),
      codex: await queuedTurn(store, meetingId, routes[2]!.agentId, "mixed-codex-turn", runIds.codex)
    };

    for (const turn of Object.values(turns)) expectExactQueuedBinding(turn);

    const beforeExecution = await store.getSnapshot();
    const participants = beforeExecution.participants.filter((item) => item.meetingId === meetingId);
    expect(participants).toHaveLength(3);
    for (const route of routes) {
      const agent = beforeExecution.agents.find((item) => item.id === route.agentId)!;
      const participant = participants.find((item) => item.agentId === route.agentId)!;
      const currentProfile = beforeExecution.runtimeProfiles!.find((item) => item.id === route.profileId)!;
      const turn = turns[route.name];
      expect(agent).toMatchObject({ lifecycleStatus: "published", publishedRevision: participant.agentRevision });
      expect(currentProfile.revision).toBe(2);
      expect(turn.runtimeProfile).toMatchObject({
        profileId: route.profileId,
        revision: 1,
        harnessKind: route.harnessKind,
        modelConnectorId: route.connectorId
      });
      expect(turn.runtimeProfile.timeoutMs).not.toBe(currentProfile.timeoutMs);
    }

    const cloudComplete = vi.fn(async (request: CompletionRequest) => ({
      content: "Cloud analysis committed.",
      usage: { promptTokens: 11, completionTokens: 4, totalTokens: 15 }
    }));
    const gb10Complete = vi.fn(async (request: CompletionRequest) => ({
      content: "GB10 analysis committed.",
      usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 }
    }));
    const codexHarness = new RecordingHarness("codex", {
      content: "Codex analysis committed.",
      usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 }
    });

    await runQueuedTurn(store, secretVault, turns.cloud, { complete: cloudComplete });
    await runQueuedTurn(store, secretVault, turns.gb10, { complete: gb10Complete });
    await runQueuedTurn(store, secretVault, turns.codex, { harness: codexHarness });

    expect(cloudComplete).toHaveBeenCalledOnce();
    expect(cloudComplete.mock.calls[0]![0]).toMatchObject({
      baseUrl: "https://cloud.example.test/v1",
      model: "cloud-meeting-model",
      allowPrivate: false,
      apiKey: expect.any(String)
    });
    expect(gb10Complete).toHaveBeenCalledOnce();
    expect(gb10Complete.mock.calls[0]![0]).toMatchObject({
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "gb10-meeting-model",
      allowPrivate: true
    });
    expect(codexHarness.calls).toHaveLength(1);
    expect(codexHarness.calls[0]).toMatchObject({
      runId: "mixed-codex-turn",
      scopeId: `meeting:${meetingId}:participant:${turns.codex.data.participantId}`,
      model: {
        baseUrl: "http://192.168.50.11:8789/v1",
        model: "codex-harness-model",
        allowPrivate: true
      },
      timeoutMs: turns.codex.runtimeProfile.timeoutMs
    });

    const afterSuccess = await store.getSnapshot();
    expect(afterSuccess.utterances.filter((item) => item.meetingId === meetingId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "mixed-cloud-turn", agentId: routes[0]!.agentId, content: "Cloud analysis committed." }),
      expect.objectContaining({ turnId: "mixed-gb10-turn", agentId: routes[1]!.agentId, content: "GB10 analysis committed." }),
      expect.objectContaining({ turnId: "mixed-codex-turn", agentId: routes[2]!.agentId, content: "Codex analysis committed." })
    ]));

    const completedAudits = audit.mock.calls
      .filter(([event]) => event === "model.run.completed")
      .map(([, , , detail]) => detail!);
    for (const route of routes) {
      const detail = completedAudits.find((item) => item.agentId === route.agentId);
      expect(detail).toMatchObject({
        connectorId: route.connectorId,
        runtimeHarness: route.harnessKind,
        runtimeProfileId: route.profileId,
        runtimeProfileRevision: 1,
        agentRevision: turns[route.name].data.agentRevision,
        roleId: turns[route.name].data.roleId
      });
    }

    const priorTranscript = afterSuccess.utterances.filter((item) => item.meetingId === meetingId);
    const priorParticipants = afterSuccess.participants.filter((item) => item.meetingId === meetingId);
    const priorAgenda = structuredClone(afterSuccess.meetings.find((item) => item.id === meetingId)!.agenda);
    const failureTurn = await queuedTurn(
      store,
      meetingId,
      routes[2]!.agentId,
      "mixed-codex-failure",
      runIds.codexFailure
    );
    expectExactQueuedBinding(failureTurn);
    const failingHarness = new RecordingHarness("codex", new Error("synthetic Codex runtime failure"));

    await expect(runQueuedTurn(store, secretVault, failureTurn, { harness: failingHarness }))
      .rejects.toThrow("synthetic Codex runtime failure");
    expect(failingHarness.calls).toHaveLength(1);
    const failureDisposition = agentTurnFailureDisposition(false);
    expect(failureDisposition).toBe("provider_or_runtime_failure");
    await recordAgentTurnFailure(
      store,
      meetingId,
      failureTurn.turnId,
      "模型或執行器無法完成發言，會議已暫停。",
      failureTurn.data.runtimeRun!.id
    );
    await store.releaseSpeakerTurn(failureTurn.turnId, failureDisposition, failureTurn.data.runtimeRun!.id);

    const afterFailure = await store.getSnapshot();
    const meetingAfterFailure = afterFailure.meetings.find((item) => item.id === meetingId)!;
    const transcriptAfterFailure = afterFailure.utterances.filter((item) => item.meetingId === meetingId);
    expect(meetingAfterFailure.state).toBe("paused");
    expect(meetingAfterFailure.agenda).toEqual(priorAgenda);
    expect(afterFailure.participants.filter((item) => item.meetingId === meetingId)).toEqual(priorParticipants);
    expect(transcriptAfterFailure.slice(0, priorTranscript.length)).toEqual(priorTranscript);
    expect(transcriptAfterFailure).toHaveLength(priorTranscript.length + 1);
    expect(transcriptAfterFailure.at(-1)).toMatchObject({
      speakerType: "system",
      kind: "failure",
      content: "模型或執行器無法完成發言，會議已暫停。"
    });
    expect(transcriptAfterFailure.filter((item) => item.turnId === failureTurn.turnId)).toHaveLength(1);
    expect(afterFailure.speakerQueue.some((item) => item.meetingId === meetingId)).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      "model.run.failed",
      "meeting",
      meetingId,
      expect.objectContaining({
        classification: "provider_or_runtime_failure",
        jobId: failureTurn.turnId,
        reservationId: failureTurn.data.runtimeRun!.id
      })
    );
  });
});
