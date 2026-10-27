import { describe, expect, it } from "vitest";
import type {
  MeetingViewSnapshot,
  PlatformSnapshot,
  PublicMeetingViewSnapshot,
  PublicPlatformSnapshot,
  PublicTask
} from "./index.js";
import {
  agentReadinessBatchRequestSchema,
  agentReadinessBatchResponseSchema,
  agentResponseSchema,
  apiErrorEnvelopeSchema,
  chairSuggestionResponseSchema,
  effectiveAgentConfigurationSchema,
  humanUtteranceResponseSchema,
  meetingPresetPreflightSchema,
  meetingSseEventEnvelopeSchema,
  meetingViewSnapshotSchema,
  platformSnapshotSchema,
  queuedJobAcceptanceSchema,
  suggestedRoleResponseSchema,
  taskRunResponseSchema,
  taskSyncResponseSchema,
  toolRunAcceptanceSchema,
  utteranceResponseSchema
} from "./api-contracts.js";

const now = "2026-08-07T00:00:00.000Z";
const later = "2026-08-07T00:05:00.000Z";
const uuid = (suffix: number): string =>
  `70000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

function createCurrentSnapshot(): PlatformSnapshot {
  const groupId = uuid(1);
  const categoryId = uuid(2);
  const tagId = uuid(3);
  const threadId = uuid(4);
  const agentId = uuid(5);
  const roleId = uuid(6);
  const skillId = uuid(7);
  const modelConnectorId = uuid(8);
  const mcpConnectorId = uuid(9);
  const taskAdapterConnectorId = uuid(10);
  const meetingId = uuid(11);
  const participantId = uuid(12);
  const agendaItemId = uuid(13);
  const utteranceId = uuid(14);
  const toolRunId = uuid(15);
  const suggestionId = uuid(16);
  const decisionId = uuid(17);
  const taskId = uuid(18);
  const credentialId = uuid(19);
  const promptId = uuid(20);
  const teamId = uuid(21);
  const presetId = uuid(22);
  const runtimeProfileId = uuid(23);
  const toolPackId = uuid(24);
  const evidenceId = uuid(25);
  const transitionId = uuid(26);
  const suggestionTransitionId = uuid(27);
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const manifestDigest = `sha256:${"b".repeat(64)}`;
  const skillDigest = "c".repeat(64);

  const role = {
    id: roleId,
    name: "Platform architect",
    usageContext: "Architecture reviews",
    responsibility: "Define maintainable system boundaries.",
    speakingGuidance: "State tradeoffs before recommendations.",
    decisionScope: "Propose decisions for owner approval.",
    constraints: "Do not claim unverified evidence.",
    version: 1,
    templateKey: "platform_architect" as const,
    toolPolicy: "agent_read_only_grants" as const,
    dataPolicy: "agent_declared_scope" as const,
    orchestrationFunctions: ["planner", "worker"] as Array<"planner" | "worker">,
    deletedAt: null
  };
  const roleSnapshot = {
    roleId,
    name: role.name,
    usageContext: role.usageContext,
    responsibility: role.responsibility,
    speakingGuidance: role.speakingGuidance,
    decisionScope: role.decisionScope,
    constraints: role.constraints,
    version: role.version,
    templateKey: role.templateKey,
    toolPolicy: role.toolPolicy,
    dataPolicy: role.dataPolicy,
    orchestrationFunctions: [...role.orchestrationFunctions],
    source: "meeting_created" as const
  };
  const toolRegistration = {
    toolName: "search_docs",
    displayName: "Search docs",
    kind: "mcp_tool" as const,
    version: "1.0.0",
    owner: "Platform",
    goal: "Search approved documentation."
  };
  const runtimeProfile = {
    id: runtimeProfileId,
    name: "Meeting runtime",
    harnessKind: "openai_compatible" as const,
    modelConnectorId,
    sandboxProfileId: null,
    policy: "text_only" as const,
    capabilities: ["text" as const],
    timeoutMs: 60_000,
    maxConcurrency: 1,
    enabled: true,
    revision: 1,
    createdAt: now,
    updatedAt: now
  };
  const toolPackContent = {
    name: "Docs reader",
    version: "1.0.0",
    description: "Read-only documentation tools.",
    owner: "Platform",
    sourceReference: `registry.example/council/docs@${imageDigest}`,
    imageDigest,
    manifestDigest,
    tools: [{
      name: "search_docs",
      kind: "command" as const,
      goal: "Search approved documentation.",
      access: "read_only" as const,
      argv: { executable: "/usr/bin/search-docs", fixedArguments: [] },
      env: { allowedNames: [] },
      stdin: { mode: "none" as const }
    }],
    revision: 1,
    status: "approved" as const,
    validation: {
      result: "passed" as const,
      summary: "Validated by the platform owner.",
      checkedAt: now,
      manifestDigest
    },
    approvedAt: now,
    revokedAt: null,
    revocationReason: null
  };
  const utterance = {
    id: utteranceId,
    meetingId,
    agentId,
    turnId: "meeting-turn:current",
    speakerType: "agent" as const,
    speakerName: "Architect",
    roleName: role.name,
    content: "Use strict response contracts.",
    kind: "verified" as const,
    evidenceCount: 1,
    createdAt: now
  };
  const suggestion = {
    reason: "time_remaining" as const,
    suggestedMode: "fixed" as const,
    explanation: "Converge on the current agenda item.",
    score: 0.9,
    suggestedAgentId: agentId,
    suggestedAgentName: "Architect",
    suggestedParticipantId: participantId,
    suggestedParticipantAgentId: agentId,
    suggestedParticipantAgentName: "Architect",
    suggestedParticipantRoleRevision: 1,
    suggestedRoleId: roleId,
    suggestedRoleName: role.name,
    suggestedRoleVersion: 1,
    id: suggestionId,
    meetingId,
    sourceUtteranceId: utteranceId,
    status: "open" as const,
    modeAcceptedAt: null,
    requestedAgentId: null,
    requestedAgentJobId: null,
    resolution: null,
    resolutionNote: null,
    resolvedBy: null,
    transitions: [{
      id: suggestionTransitionId,
      type: "created" as const,
      actor: "system" as const,
      at: now,
      note: "Policy threshold reached."
    }],
    createdAt: now,
    resolvedAt: null
  };
  const task = {
    id: taskId,
    meetingId,
    decisionId,
    revision: 1,
    boardRevision: 1,
    title: "Publish API contracts",
    description: "Validate API responses before use.",
    status: "todo" as const,
    position: 0,
    assignee: "Owner",
    assigneeAgentId: agentId,
    dueAt: null,
    acceptanceCriteria: "Malformed responses are rejected.",
    evidence: [{
      id: evidenceId,
      type: "decision" as const,
      label: "Approved decision",
      reference: decisionId,
      addedBy: "system" as const,
      agentId,
      jobId: "task-agent:current",
      executionProfile: "advisor" as const,
      createdAt: now
    }],
    executionProfile: "advisor" as const,
    allowedTools: ["search_docs"],
    dataScope: "meeting",
    approvalState: "not_required" as const,
    execution: {
      revision: 1,
      status: "idle" as const,
      jobId: null,
      requestFingerprint: null,
      agentId: null,
      profile: null,
      attemptCount: 0,
      requestedAt: null,
      startedAt: null,
      providerStartedAt: null,
      completedAt: null,
      lastError: null,
      resultEvidenceId: null,
      runtimeProfileBinding: null
    },
    transitions: [{
      id: transitionId,
      type: "created" as const,
      actor: "owner" as const,
      at: now,
      toStatus: "todo" as const,
      toPosition: 0
    }],
    sync: {
      status: "not_synced" as const,
      adapterId: null,
      jobId: null,
      requestFingerprint: null,
      externalId: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      syncedAt: null
    },
    createdAt: now,
    updatedAt: now
  };

  return {
    groups: [{ id: groupId, revision: 1, name: "Product" }],
    categories: [{ id: categoryId, revision: 1, groupId, name: "Architecture" }],
    tags: [{ id: tagId, revision: 1, name: "High priority", color: "red" }],
    threads: [{
      id: threadId,
      revision: 1,
      categoryId,
      title: "API response boundaries",
      summary: "Define runtime response contracts.",
      status: "open",
      tagIds: [tagId],
      createdAt: now
    }],
    agents: [{
      id: agentId,
      name: "Architect",
      description: "Architecture review agent.",
      modelConnectorId,
      goalSummary: "Define stable API boundaries.",
      toolsSummary: "Read-only documentation search.",
      dataSummary: "Meeting-scoped data.",
      skillIds: [skillId],
      toolGrants: [{ connectorId: mcpConnectorId, toolName: toolRegistration.toolName }],
      toolPackGrants: [{ packId: toolPackId, revision: 1, manifestDigest, toolName: "search_docs" }],
      runtimeProfileBinding: { profileId: runtimeProfileId, revision: 1 },
      status: "online",
      lifecycleStatus: "published",
      promptBinding: { promptId, version: 1 },
      draftRevision: 1,
      publishedRevision: 1
    }],
    roles: [role],
    skills: [{
      id: skillId,
      name: "Contract review",
      version: "1.0.0",
      instructions: "Validate every nested response field.",
      source: "Council registry",
      owner: "Platform",
      contentDigest: skillDigest,
      validation: {
        result: "passed",
        summary: "Reviewed.",
        checkedAt: now,
        contentDigest: skillDigest
      },
      status: "approved",
      approvedAt: now,
      revokedAt: null,
      revocationReason: null
    }],
    modelConnectors: [{
      id: modelConnectorId,
      revision: 1,
      name: "Local model",
      location: "local",
      baseUrl: "http://127.0.0.1:4000/v1",
      model: "council-local",
      enabled: true,
      hasSecret: true,
      secretRevision: 1,
      credentialId
    }],
    mcpConnectors: [{
      id: mcpConnectorId,
      revision: 1,
      name: "Docs MCP",
      location: "local",
      baseUrl: "http://127.0.0.1:4100",
      approvedTools: [toolRegistration.toolName],
      toolRegistrations: [toolRegistration],
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    }],
    taskAdapterConnectors: [{
      id: taskAdapterConnectorId,
      name: "Task adapter",
      location: "cloud",
      baseUrl: "https://tasks.example.com",
      enabled: true,
      hasSecret: true
    }],
    meetings: [{
      id: meetingId,
      threadId,
      title: "Contract review",
      goal: "Approve strict API response contracts.",
      state: "active",
      mode: "chaired",
      automation: "suggest",
      automationRevision: 1,
      durationMinutes: 30,
      startedAt: now,
      closedAt: null,
      agenda: {
        revision: 1,
        items: [{
          id: agendaItemId,
          title: "Review schemas",
          description: "Review strict runtime schemas.",
          position: 0,
          status: "current",
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          resolvedAt: null
        }]
      },
      summaryState: "not_requested",
      summaryJobId: null,
      createdAt: now,
      sourceTeamId: teamId,
      sourcePresetId: presetId
    }],
    participants: [{
      id: participantId,
      meetingId,
      agentId,
      roleId,
      isChair: true,
      agentRevision: 1,
      roleSnapshot,
      roleRevision: 1,
      roleHistory: [{
        revision: 1,
        roleId,
        roleSnapshot: { ...roleSnapshot },
        changedAt: now,
        changedBy: "owner",
        reason: "Assigned when the meeting was created."
      }]
    }],
    speakerQueue: [{
      id: uuid(28),
      jobId: "meeting-turn:current",
      requestFingerprint: null,
      meetingId,
      agentId,
      kind: "agent_turn",
      label: "Architect turn",
      toolName: null,
      roleName: role.name,
      agendaRevision: 1,
      agendaCurrentItemId: agendaItemId,
      status: "queued",
      requestedAt: now,
      startedAt: null,
      leaseExpiresAt: later,
      runtimeProfileBinding: { profileId: runtimeProfileId, revision: 1 },
      requestedBy: "owner",
      chairSuggestionId: null,
      automationRevision: null,
      participantId,
      roleRevision: 1,
      roleId,
      roleVersion: 1
    }],
    utterances: [utterance],
    toolRuns: [{
      id: toolRunId,
      jobId: "mcp-tool:current",
      requestFingerprint: "sha256:request-fingerprint",
      meetingId,
      agentId,
      connectorId: mcpConnectorId,
      toolName: toolRegistration.toolName,
      toolSnapshot: { connectorName: "Docs MCP", ...toolRegistration },
      status: "succeeded",
      utteranceId,
      createdAt: now
    }],
    chairSuggestions: [suggestion],
    decisions: [{
      id: decisionId,
      meetingId,
      title: "Use strict response schemas",
      description: "Reject malformed and secret-bearing response fields.",
      status: "approved",
      createdAt: now
    }],
    tasks: [task],
    credentials: [{
      id: credentialId,
      name: "Local model credential",
      provider: "openai-compatible",
      kind: "api_key",
      location: "local",
      status: "active",
      hasSecret: true,
      secretRevision: 1,
      maskedHint: "...1234",
      expiresAt: null,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now,
      rotatedAt: now
    }],
    prompts: [{
      id: promptId,
      name: "Architecture prompt",
      kind: "agent",
      description: "Architecture review instructions.",
      owner: "Platform",
      status: "published",
      currentVersion: 1,
      publishedVersion: 1,
      createdAt: now,
      updatedAt: now
    }],
    agentTeams: [{
      id: teamId,
      revision: 1,
      name: "Architecture team",
      description: "Reviews platform boundaries.",
      status: "active",
      members: [{ agentId, roleId, isChair: true }],
      createdAt: now,
      updatedAt: now
    }],
    meetingPresets: [{
      id: presetId,
      revision: 1,
      name: "Architecture review",
      description: "Standard architecture review meeting.",
      status: "active",
      teamId,
      mode: "chaired",
      automation: "suggest",
      durationMinutes: 30,
      agendaItems: [{ title: "Review schemas", description: "Review response contracts." }],
      createdAt: now,
      updatedAt: now
    }],
    runtimeProfiles: [runtimeProfile],
    runtimeProfileRevisions: [{
      profileId: runtimeProfileId,
      revision: 1,
      name: runtimeProfile.name,
      harnessKind: runtimeProfile.harnessKind,
      modelConnectorId,
      sandboxProfileId: null,
      policy: runtimeProfile.policy,
      capabilities: [...runtimeProfile.capabilities],
      timeoutMs: runtimeProfile.timeoutMs,
      maxConcurrency: runtimeProfile.maxConcurrency,
      enabled: true,
      source: "created",
      recordedAt: now
    }],
    toolPacks: [{
      id: toolPackId,
      ...toolPackContent,
      createdAt: now,
      updatedAt: now
    }],
    toolPackRevisions: [{
      packId: toolPackId,
      ...toolPackContent,
      source: "approved",
      recordedAt: now
    }]
  };
}

function createMeetingView(snapshot: PlatformSnapshot): MeetingViewSnapshot {
  return {
    meeting: snapshot.meetings[0]!,
    participants: snapshot.participants,
    speakerQueue: snapshot.speakerQueue,
    utterances: snapshot.utterances,
    toolRuns: snapshot.toolRuns,
    chairSuggestions: snapshot.chairSuggestions,
    decisions: snapshot.decisions,
    tasks: snapshot.tasks
  };
}

function projectPublicTask(task: PlatformSnapshot["tasks"][number]): PublicTask {
  const { requestFingerprint: _executionFingerprint, ...execution } = task.execution;
  const { requestFingerprint: _syncFingerprint, ...sync } = task.sync;
  const transitions = task.transitions.map(({ requestFingerprint: _fingerprint, ...transition }) => transition);
  return { ...task, execution, transitions, sync };
}

function projectPublicSnapshot(snapshot: PlatformSnapshot): PublicPlatformSnapshot {
  return {
    ...snapshot,
    speakerQueue: snapshot.speakerQueue.map((item) => {
      const {
        reservationId: _reservationId,
        requestFingerprint: _requestFingerprint,
        mcpExecutionBinding,
        ...publicItem
      } = item;
      if (!mcpExecutionBinding) return publicItem;
      const { connectorFingerprint: _connectorFingerprint, ...publicBinding } = mcpExecutionBinding;
      return { ...publicItem, mcpExecutionBinding: publicBinding };
    }),
    toolRuns: snapshot.toolRuns.map(({ requestFingerprint: _fingerprint, ...run }) => run),
    tasks: snapshot.tasks.map(projectPublicTask)
  };
}

function projectPublicMeetingView(view: MeetingViewSnapshot): PublicMeetingViewSnapshot {
  const snapshot = projectPublicSnapshot({
    groups: [],
    categories: [],
    tags: [],
    threads: [],
    agents: [],
    roles: [],
    skills: [],
    modelConnectors: [],
    mcpConnectors: [],
    taskAdapterConnectors: [],
    meetings: [view.meeting],
    participants: view.participants,
    speakerQueue: view.speakerQueue,
    utterances: view.utterances,
    toolRuns: view.toolRuns,
    chairSuggestions: view.chairSuggestions,
    decisions: view.decisions,
    tasks: view.tasks
  });
  return {
    meeting: view.meeting,
    participants: snapshot.participants,
    speakerQueue: snapshot.speakerQueue,
    utterances: snapshot.utterances,
    toolRuns: snapshot.toolRuns,
    chairSuggestions: snapshot.chairSuggestions,
    decisions: snapshot.decisions,
    tasks: snapshot.tasks
  };
}

describe("API response contracts", () => {
  it("accepts a current PlatformSnapshot and normalizes omitted management arrays", () => {
    const minimal = {
      groups: [],
      categories: [],
      tags: [],
      threads: [],
      agents: [],
      roles: [],
      skills: [],
      modelConnectors: [],
      mcpConnectors: [],
      taskAdapterConnectors: [],
      meetings: [],
      participants: [],
      speakerQueue: [],
      utterances: [],
      toolRuns: [],
      chairSuggestions: [],
      decisions: [],
      tasks: []
    };
    expect(platformSnapshotSchema.parse(minimal)).toEqual({
      ...minimal,
      credentials: [],
      prompts: [],
      agentTeams: [],
      meetingPresets: [],
      runtimeProfiles: [],
      runtimeProfileRevisions: [],
      toolPacks: [],
      toolPackRevisions: []
    });

    const current = createCurrentSnapshot();
    const parsedCurrent: PublicPlatformSnapshot = platformSnapshotSchema.parse(current);
    expect(parsedCurrent).toEqual(projectPublicSnapshot(current));

    const {
      credentials: _credentials,
      prompts: _prompts,
      agentTeams: _agentTeams,
      meetingPresets: _meetingPresets,
      runtimeProfiles: _runtimeProfiles,
      runtimeProfileRevisions: _runtimeProfileRevisions,
      toolPacks: _toolPacks,
      toolPackRevisions: _toolPackRevisions,
      ...legacyCore
    } = current;
    const normalized = platformSnapshotSchema.parse(legacyCore);

    expect(normalized).toMatchObject({
      credentials: [],
      prompts: [],
      agentTeams: [],
      meetingPresets: [],
      runtimeProfiles: [],
      runtimeProfileRevisions: [],
      toolPacks: [],
      toolPackRevisions: []
    });
  });

  it("accepts the bounded Task record IDs created by legacy migrations", () => {
    const snapshot = createCurrentSnapshot();
    const task = snapshot.tasks[0]!;
    const legacyMeetingEvidenceId = `meeting:${task.id}`;

    const normalized = platformSnapshotSchema.parse({
      ...snapshot,
      tasks: [{
        ...task,
        evidence: [{ ...task.evidence[0]!, id: legacyMeetingEvidenceId }],
        execution: { ...task.execution, resultEvidenceId: legacyMeetingEvidenceId },
        transitions: [{
          ...task.transitions[0]!,
          id: `migration014:approval:${task.id}`,
          evidenceId: legacyMeetingEvidenceId
        }]
      }]
    });

    expect(normalized.tasks[0]).toMatchObject({
      evidence: [{ id: legacyMeetingEvidenceId }],
      execution: { resultEvidenceId: legacyMeetingEvidenceId },
      transitions: [{
        id: `migration014:approval:${task.id}`,
        evidenceId: legacyMeetingEvidenceId
      }]
    });
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      tasks: [{ ...task, evidence: [{ ...task.evidence[0]!, id: "meeting:not-a-uuid" }] }]
    }).success).toBe(false);
  });

  it("accepts the opaque job ID used by an active Speaker Queue item", () => {
    const snapshot = createCurrentSnapshot();
    const queueItem = snapshot.speakerQueue[0]!;
    const queueId = `${queueItem.meetingId}-${queueItem.agentId}-${uuid(29)}`;

    const normalized = platformSnapshotSchema.parse({
      ...snapshot,
      speakerQueue: [{ ...queueItem, id: queueId, jobId: queueId }]
    });

    expect(normalized.speakerQueue[0]).toMatchObject({ id: queueId, jobId: queueId });
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      speakerQueue: [{ ...queueItem, id: "", jobId: queueId }]
    }).success).toBe(false);
  });

  it("rejects malformed fields deep inside snapshot collections", () => {
    const snapshot = createCurrentSnapshot();
    const participant = snapshot.participants[0]!;
    const history = participant.roleHistory[0]!;
    const task = snapshot.tasks[0]!;

    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      participants: [{
        ...participant,
        roleHistory: [{
          ...history,
          roleSnapshot: { ...history.roleSnapshot, roleId: "not-a-uuid" }
        }]
      }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      tasks: [{ ...task, execution: { ...task.execution, status: "sleeping" } }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      tasks: [{ ...task, execution: { ...task.execution, providerStartedAt: 42 } }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      meetings: [{ ...snapshot.meetings[0]!, state: "running" }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      modelConnectors: [{ ...snapshot.modelConnectors[0]!, baseUrl: "not a URL" }]
    }).success).toBe(false);
  });

  it("rejects unknown response keys that could expose secrets", () => {
    const snapshot = createCurrentSnapshot();

    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      modelConnectors: [{ ...snapshot.modelConnectors[0]!, apiKey: "plaintext-secret" }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      mcpConnectors: [{ ...snapshot.mcpConnectors[0]!, ciphertext: "encrypted-secret" }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      credentials: [{ ...snapshot.credentials![0]!, secret: "plaintext-secret" }]
    }).success).toBe(false);
    expect(platformSnapshotSchema.safeParse({
      ...snapshot,
      databasePassword: "plaintext-secret"
    }).success).toBe(false);
  });

  it("removes internal queue and idempotency bindings from public snapshots", () => {
    const snapshot = createCurrentSnapshot();
    const queueItem = snapshot.speakerQueue[0]!;
    const task = snapshot.tasks[0]!;
    const toolRun = snapshot.toolRuns[0]!;
    const projected = platformSnapshotSchema.parse({
      ...snapshot,
      speakerQueue: [{
        ...queueItem,
        reservationId: "speaker-reservation-internal",
        requestFingerprint: "speaker-request-internal",
        mcpExecutionBinding: {
          connectorId: toolRun.connectorId,
          toolSnapshot: toolRun.toolSnapshot,
          connectorFingerprint: "connector-fingerprint-internal"
        }
      }],
      tasks: [{
        ...task,
        execution: { ...task.execution, requestFingerprint: "task-run-internal" },
        transitions: [{ ...task.transitions[0]!, requestFingerprint: "task-transition-internal" }],
        sync: { ...task.sync, requestFingerprint: "task-sync-internal" }
      }]
    });

    expect(projected.speakerQueue[0]).not.toHaveProperty("reservationId");
    expect(projected.speakerQueue[0]).not.toHaveProperty("requestFingerprint");
    expect(projected.speakerQueue[0]?.mcpExecutionBinding).not.toHaveProperty("connectorFingerprint");
    expect(projected.toolRuns[0]).not.toHaveProperty("requestFingerprint");
    expect(projected.tasks[0]?.execution).not.toHaveProperty("requestFingerprint");
    expect(projected.tasks[0]?.transitions[0]).not.toHaveProperty("requestFingerprint");
    expect(projected.tasks[0]?.sync).not.toHaveProperty("requestFingerprint");
  });

  it("validates MeetingViewSnapshot entities instead of only checking arrays", () => {
    const view = createMeetingView(createCurrentSnapshot());
    const parsedView: PublicMeetingViewSnapshot = meetingViewSnapshotSchema.parse(view);
    expect(parsedView).toEqual(projectPublicMeetingView(view));
    expect(meetingViewSnapshotSchema.safeParse({
      ...view,
      utterances: [{ ...view.utterances[0]!, id: "bad-utterance-id" }]
    }).success).toBe(false);
    expect(meetingViewSnapshotSchema.safeParse({
      ...view,
      tasks: [{ ...view.tasks[0]!, ciphertext: "encrypted-secret" }]
    }).success).toBe(false);
  });

  it("accepts safe meeting SSE envelopes and rejects bad or secret-bearing data", () => {
    const snapshot = createCurrentSnapshot();
    const event = {
      type: "utterance.created",
      meetingId: snapshot.meetings[0]!.id,
      data: { utterance: snapshot.utterances[0]!, jobId: "meeting-turn:current" },
      occurredAt: now
    };

    expect(meetingSseEventEnvelopeSchema.parse(event)).toEqual(event);
    expect(meetingSseEventEnvelopeSchema.safeParse({ ...event, data: [] }).success).toBe(false);
    expect(meetingSseEventEnvelopeSchema.safeParse({
      ...event,
      data: { utterance: { ...snapshot.utterances[0]!, ciphertext: "encrypted-secret" } }
    }).success).toBe(false);
    expect(meetingSseEventEnvelopeSchema.safeParse({ ...event, occurredAt: "yesterday" }).success).toBe(false);
  });

  it("validates strict API error and queued-job acceptance envelopes", () => {
    const error = { error: { code: "MEETING_NOT_FOUND", message: "Meeting does not exist." } };
    expect(apiErrorEnvelopeSchema.parse(error)).toEqual(error);
    expect(apiErrorEnvelopeSchema.safeParse({
      error: { ...error.error, stack: "sensitive stack" }
    }).success).toBe(false);
    expect(apiErrorEnvelopeSchema.safeParse({ error: { code: "bad code", message: "Failed." } }).success).toBe(false);

    expect(queuedJobAcceptanceSchema.parse({ jobId: "meeting-turn:current" })).toEqual({ jobId: "meeting-turn:current" });
    expect(queuedJobAcceptanceSchema.parse({ jobId: "meeting-turn:current", replayed: true })).toEqual({
      jobId: "meeting-turn:current",
      replayed: true
    });
    expect(queuedJobAcceptanceSchema.safeParse({ jobId: "", replayed: false }).success).toBe(false);
    expect(queuedJobAcceptanceSchema.safeParse({
      jobId: "meeting-turn:current",
      replayed: false,
      status: "queued"
    }).success).toBe(false);
  });

  it("keeps Meeting workflow mutation envelopes strict at every nested boundary", () => {
    const snapshot = createCurrentSnapshot();
    const utterance = snapshot.utterances[0]!;
    const suggestion = snapshot.chairSuggestions[0]!;
    const participant = snapshot.participants[0]!;
    const task = snapshot.tasks[0]!;

    expect(utteranceResponseSchema.parse(utterance)).toEqual(utterance);
    expect(chairSuggestionResponseSchema.parse(suggestion)).toEqual(suggestion);
    expect(humanUtteranceResponseSchema.parse({ utterance, chairSuggestion: suggestion })).toEqual({
      utterance,
      chairSuggestion: suggestion
    });
    expect(suggestedRoleResponseSchema.parse({ participant, suggestion })).toEqual({ participant, suggestion });
    expect(taskRunResponseSchema.parse({ task, jobId: "task-agent:current", replayed: true })).toEqual({
      task: projectPublicTask(task),
      jobId: "task-agent:current",
      replayed: true
    });
    expect(taskSyncResponseSchema.parse({ task, jobId: "task-sync:current" })).toEqual({
      task: projectPublicTask(task),
      jobId: "task-sync:current"
    });
    expect(toolRunAcceptanceSchema.parse({ jobId: "mcp-tool:current", status: "succeeded" })).toEqual({
      jobId: "mcp-tool:current",
      status: "succeeded"
    });

    expect(humanUtteranceResponseSchema.safeParse({
      utterance: { ...utterance, internalMarker: "private" },
      chairSuggestion: suggestion
    }).success).toBe(false);
    expect(humanUtteranceResponseSchema.safeParse({
      utterance,
      chairSuggestion: { ...suggestion, internalMarker: "private" }
    }).success).toBe(false);
    expect(suggestedRoleResponseSchema.safeParse({
      participant: { ...participant, internalMarker: "private" },
      suggestion
    }).success).toBe(false);
    expect(taskRunResponseSchema.safeParse({
      task: { ...task, internalMarker: "private" },
      jobId: "task-agent:current"
    }).success).toBe(false);
    expect(taskSyncResponseSchema.safeParse({
      task: { ...task, internalMarker: "private" },
      jobId: "task-sync:current"
    }).success).toBe(false);
    expect(toolRunAcceptanceSchema.safeParse({
      jobId: "mcp-tool:current",
      status: "queued"
    }).success).toBe(false);
  });

  it("defines a strict compact Agent Capability Summary without secret-bearing fields", () => {
    const snapshot = createCurrentSnapshot();
    const agent = snapshot.agents[0]!;
    const model = snapshot.modelConnectors[0]!;
    const credential = snapshot.credentials![0]!;
    const prompt = snapshot.prompts![0]!;
    const skill = snapshot.skills[0]!;
    const connector = snapshot.mcpConnectors[0]!;
    const registration = connector.toolRegistrations[0]!;
    const pack = snapshot.toolPacks![0]!;
    const team = snapshot.agentTeams![0]!;
    const role = snapshot.roles[0]!;
    const response = {
      source: { kind: "published" as const, revision: 1 },
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        lifecycleStatus: agent.lifecycleStatus!,
        draftRevision: agent.draftRevision!,
        publishedRevision: agent.publishedRevision!,
        goalSummary: agent.goalSummary,
        toolsSummary: agent.toolsSummary,
        dataSummary: agent.dataSummary
      },
      bindingCounts: {
        skills: { configured: 2, ready: 1 },
        tools: { configured: 2, ready: 1 },
        toolPacks: { configured: 2, ready: 1 }
      },
      model: {
        id: model.id,
        name: model.name,
        location: model.location,
        model: model.model,
        enabled: model.enabled
      },
      credential: {
        id: credential.id,
        name: credential.name,
        location: credential.location,
        status: credential.status,
        hasSecret: credential.hasSecret,
        maskedHint: credential.maskedHint,
        expiresAt: credential.expiresAt
      },
      prompt: { ...prompt, version: 1 },
      skills: [{
        id: skill.id,
        name: skill.name,
        version: skill.version,
        source: skill.source,
        owner: skill.owner
      }],
      tools: [{ connectorId: connector.id, connectorName: connector.name, ...registration }],
      toolPacks: [{
        packId: pack.id,
        packName: pack.name,
        revision: pack.revision,
        version: pack.version,
        toolName: pack.tools[0]!.name,
        toolGoal: pack.tools[0]!.goal
      }],
      teams: [{
        id: team.id,
        name: team.name,
        isChair: true,
        role: {
          id: role.id,
          name: role.name,
          version: role.version,
          toolPolicy: role.toolPolicy,
          dataPolicy: role.dataPolicy
        }
      }],
      runtimeProfile: null,
      readiness: {
        status: "ready" as const,
        checks: [{ code: "lifecycle" as const, status: "passed" as const, message: "Agent is ready." }]
      }
    };

    expect(effectiveAgentConfigurationSchema.parse(response)).toEqual(response);
    expect(effectiveAgentConfigurationSchema.safeParse({
      ...response,
      source: { kind: "published_missing", revision: 7 }
    }).success).toBe(true);
    expect(effectiveAgentConfigurationSchema.safeParse({
      ...response,
      source: { kind: "draft", revision: 0 }
    }).success).toBe(false);
    expect(effectiveAgentConfigurationSchema.safeParse({
      ...response,
      bindingCounts: { ...response.bindingCounts, skills: { configured: -1, ready: 0 } }
    }).success).toBe(false);
    expect(effectiveAgentConfigurationSchema.safeParse({
      ...response,
      bindingCounts: { ...response.bindingCounts, skills: { configured: 1, ready: 2 } }
    }).success).toBe(false);

    const forbidden = [
      { ...response, model: { ...response.model, baseUrl: "https://secret.example" } },
      { ...response, model: { ...response.model, secretRevision: 4 } },
      { ...response, credential: { ...response.credential, provider: "secret-provider" } },
      { ...response, credential: { ...response.credential, secretRevision: 4 } },
      { ...response, skills: [{ ...response.skills[0]!, instructions: "private instructions" }] },
      { ...response, skills: [{ ...response.skills[0]!, contentDigest: "private-digest" }] },
      { ...response, ciphertext: "encrypted-secret" }
    ];
    for (const candidate of forbidden) {
      expect(effectiveAgentConfigurationSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("keeps the optional Agent resource revision while rejecting extra response fields", () => {
    const agent = createCurrentSnapshot().agents[0]!;
    const withResourceRevision = { ...agent, revision: 7 };

    expect(agentResponseSchema.parse(withResourceRevision)).toEqual(withResourceRevision);
    expect(agentResponseSchema.safeParse({ ...withResourceRevision, ciphertext: "replayed-secret" }).success).toBe(false);
  });

  it("bounds strict unique Agent readiness batch requests and canonical responses", () => {
    const firstAgentId = uuid(90);
    const secondAgentId = uuid(91);
    const request = { agentIds: [firstAgentId, secondAgentId] };
    expect(agentReadinessBatchRequestSchema.parse(request)).toEqual(request);

    expect(agentReadinessBatchRequestSchema.safeParse({ agentIds: [] }).success).toBe(false);
    expect(agentReadinessBatchRequestSchema.safeParse({ agentIds: [firstAgentId, firstAgentId] }).success).toBe(false);
    expect(agentReadinessBatchRequestSchema.safeParse({ agentIds: ["not-a-uuid"] }).success).toBe(false);
    expect(agentReadinessBatchRequestSchema.safeParse({
      agentIds: Array.from({ length: 51 }, (_item, index) => uuid(100 + index))
    }).success).toBe(false);
    expect(agentReadinessBatchRequestSchema.safeParse({
      agentIds: [firstAgentId],
      unexpected: true
    }).success).toBe(false);

    const response = {
      results: [{
        agentId: firstAgentId,
        readiness: {
          status: "blocked" as const,
          checks: [{ code: "lifecycle" as const, status: "blocked" as const, message: "Agent is unavailable." }]
        }
      }]
    };
    expect(agentReadinessBatchResponseSchema.parse(response)).toEqual(response);
    expect(agentReadinessBatchResponseSchema.safeParse({
      results: [{ ...response.results[0], readiness: { status: "unknown", checks: [] } }]
    }).success).toBe(false);
  });

  it("requires preset preflight responses to identify invalid Role references", () => {
    const response = {
      presetId: uuid(200),
      status: "blocked" as const,
      team: null,
      invalidRoleIds: [uuid(201)],
      agents: []
    };

    expect(meetingPresetPreflightSchema.parse(response)).toEqual(response);
    expect(meetingPresetPreflightSchema.safeParse({
      ...response,
      invalidRoleIds: undefined
    }).success).toBe(false);
    expect(meetingPresetPreflightSchema.safeParse({
      ...response,
      invalidRoleIds: ["not-a-uuid"]
    }).success).toBe(false);
  });
});
