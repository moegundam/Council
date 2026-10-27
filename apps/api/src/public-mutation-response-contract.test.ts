import { describe, expect, it, vi } from "vitest";
import type { CreateRuntimeProfileInput } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const marker = "must-not-cross-the-public-mutation-boundary";

function drift<T extends object>(value: T): T {
  return { ...value, internalMarker: marker } as T;
}

async function expectContractViolations(responses: Record<string, Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>["inject"]>>>): Promise<void> {
  for (const [name, response] of Object.entries(responses)) {
    expect(response.statusCode, name).toBe(500);
    expect(response.json(), name).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
    expect(response.body, name).not.toContain(marker);
  }
}

describe("public mutation response contracts", () => {
  it("fails taxonomy mutations closed when Store entities contain an undeclared field", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const group = snapshot.groups[0]!;
    const category = snapshot.categories[0]!;
    const tag = snapshot.tags[0]!;
    vi.spyOn(store, "createGroup").mockResolvedValue(drift(group));
    vi.spyOn(store, "createCategory").mockResolvedValue(drift(category));
    vi.spyOn(store, "createTag").mockResolvedValue(drift(tag));
    vi.spyOn(store, "updateGroup").mockResolvedValue(drift(group));
    vi.spyOn(store, "updateCategory").mockResolvedValue(drift(category));
    vi.spyOn(store, "updateTag").mockResolvedValue(drift(tag));
    const app = await createApp({ store, authDisabled: true });

    try {
      await expectContractViolations({
        createGroup: await app.inject({
          method: "POST",
          url: "/api/groups",
          headers: { "idempotency-key": "strict-group-create" },
          payload: { name: "Strict Group" }
        }),
        createCategory: await app.inject({
          method: "POST",
          url: "/api/categories",
          headers: { "idempotency-key": "strict-category-create" },
          payload: { groupId: group.id, name: "Strict Category" }
        }),
        createTag: await app.inject({
          method: "POST",
          url: "/api/tags",
          headers: { "idempotency-key": "strict-tag-create" },
          payload: { name: "Strict Tag", color: "blue" }
        }),
        updateGroup: await app.inject({
          method: "PATCH",
          url: `/api/groups/${group.id}`,
          payload: { expectedRevision: group.revision, name: "Strict Group Update" }
        }),
        updateCategory: await app.inject({
          method: "PATCH",
          url: `/api/categories/${category.id}`,
          payload: { expectedRevision: category.revision, name: "Strict Category Update" }
        }),
        updateTag: await app.inject({
          method: "PATCH",
          url: `/api/tags/${tag.id}`,
          payload: { expectedRevision: tag.revision, color: "green" }
        })
      });
    } finally {
      await app.close();
    }
  });

  it("fails Meeting, Decision, and Task entity mutations closed on response drift", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const meeting = initial.meetings[0]!;
    const thread = initial.threads[0]!;
    const participant = initial.participants[0]!;
    const decision = await store.createDecision({
      meetingId: meeting.id,
      title: "Strict response Decision fixture",
      description: "Approved Task prerequisite."
    });
    await store.setDecisionStatus(decision.id, "approved");
    const task = await store.createTask({
      decisionId: decision.id,
      title: "Strict response Task fixture",
      description: "Returns a strict Task response."
    });

    vi.spyOn(store, "createThread").mockResolvedValue(drift(thread));
    vi.spyOn(store, "updateThread").mockResolvedValue(drift(thread));
    vi.spyOn(store, "createMeeting").mockResolvedValue(drift(meeting));
    vi.spyOn(store, "setMeetingAgenda").mockResolvedValue(drift(meeting));
    vi.spyOn(store, "advanceMeetingAgenda").mockResolvedValue(drift(meeting));
    vi.spyOn(store, "setMeetingState").mockResolvedValue(drift(meeting));
    vi.spyOn(store, "setMeetingAutomation").mockResolvedValue(drift(meeting));
    vi.spyOn(store, "setMeetingMode").mockResolvedValue({
      meeting: drift(meeting),
      chairSuggestion: null,
      resolvedSuggestionIds: []
    });
    vi.spyOn(store, "switchParticipantRole").mockResolvedValue(drift(participant));
    vi.spyOn(store, "createDecision").mockResolvedValue(drift(decision));
    vi.spyOn(store, "setDecisionStatus").mockResolvedValue(drift(decision));
    vi.spyOn(store, "createTask").mockResolvedValue(drift(task));
    vi.spyOn(store, "updateTask").mockResolvedValue(drift(task));
    vi.spyOn(store, "setTaskApproval").mockResolvedValue(drift(task));
    vi.spyOn(store, "addTaskEvidence").mockResolvedValue(drift(task));
    vi.spyOn(store, "moveTask").mockResolvedValue(drift(task));
    const app = await createApp({ store, authDisabled: true });
    const currentAgenda = meeting.agenda.items[0]!;

    try {
      await expectContractViolations({
        createThread: await app.inject({
          method: "POST",
          url: "/api/threads",
          headers: { "idempotency-key": "strict-thread-create" },
          payload: { categoryId: thread.categoryId, title: "Strict Thread", summary: "", tagIds: [] }
        }),
        updateThread: await app.inject({
          method: "PATCH",
          url: `/api/threads/${thread.id}`,
          payload: { expectedRevision: thread.revision, title: "Strict Thread Update" }
        }),
        createMeeting: await app.inject({
          method: "POST",
          url: "/api/meetings",
          headers: { "idempotency-key": "strict-meeting-create" },
          payload: {
            threadId: thread.id,
            title: "Strict Meeting",
            goal: "Reject response drift.",
            mode: "chaired",
            durationMinutes: 30,
            participants: [{ agentId: participant.agentId, roleId: participant.roleId, isChair: true }],
            agendaItems: [{ title: "Strict response", description: "" }]
          }
        }),
        setMeetingAgenda: await app.inject({
          method: "PATCH",
          url: `/api/meetings/${meeting.id}/agenda`,
          payload: {
            expectedRevision: meeting.agenda.revision,
            items: meeting.agenda.items.map(({ id, title, description }) => ({ id, title, description }))
          }
        }),
        advanceMeetingAgenda: await app.inject({
          method: "POST",
          url: `/api/meetings/${meeting.id}/agenda/advance`,
          payload: { expectedRevision: meeting.agenda.revision, action: "complete", itemId: currentAgenda.id }
        }),
        setMeetingState: await app.inject({ method: "POST", url: `/api/meetings/${meeting.id}/pause` }),
        setMeetingAutomation: await app.inject({
          method: "PATCH",
          url: `/api/meetings/${meeting.id}/automation`,
          payload: {
            automation: "auto",
            expectedAutomation: meeting.automation,
            expectedAutomationRevision: meeting.automationRevision
          }
        }),
        setMeetingMode: await app.inject({
          method: "POST",
          url: `/api/meetings/${meeting.id}/mode`,
          payload: { mode: "open", reason: "Strict response test." }
        }),
        switchParticipantRole: await app.inject({
          method: "PATCH",
          url: `/api/meetings/${meeting.id}/participants/${participant.id}/role`,
          payload: {
            roleId: participant.roleId,
            expectedRoleRevision: participant.roleRevision,
            reason: "Strict response test."
          }
        }),
        createDecision: await app.inject({
          method: "POST",
          url: "/api/decisions",
          headers: { "idempotency-key": "strict-decision-create" },
          payload: { meetingId: meeting.id, title: "Strict Decision", description: "Reject drift." }
        }),
        setDecisionStatus: await app.inject({ method: "POST", url: `/api/decisions/${decision.id}/approve` }),
        createTask: await app.inject({
          method: "POST",
          url: "/api/tasks",
          headers: { "idempotency-key": "strict-task-create" },
          payload: { decisionId: decision.id, title: "Strict Task", description: "Reject drift." }
        }),
        updateTask: await app.inject({
          method: "PATCH",
          url: `/api/tasks/${task.id}`,
          payload: {
            expectedRevision: task.revision,
            expectedExecutionRevision: task.execution.revision,
            title: "Strict Task Update"
          }
        }),
        setTaskApproval: await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/approval`,
          payload: { expectedExecutionRevision: task.execution.revision, action: "request" }
        }),
        addTaskEvidence: await app.inject({
          method: "POST",
          url: `/api/tasks/${task.id}/evidence`,
          headers: { "idempotency-key": "strict-task-evidence" },
          payload: { type: "note", label: "Strict evidence", reference: "Reject response drift." }
        }),
        moveTask: await app.inject({
          method: "PATCH",
          url: `/api/tasks/${task.id}/status`,
          payload: {
            status: "in_progress",
            position: 0,
            expectedBoardRevision: task.boardRevision,
            expectedExecutionRevision: task.execution.revision
          }
        })
      });
    } finally {
      await app.close();
    }
  });

  it("fails alternate Meeting workflow responses closed on nested Store drift", async () => {
    const store = new InMemoryPlatformStore();
    const initial = await store.getSnapshot();
    const meeting = initial.meetings[0]!;
    await store.setMeetingState(meeting.id, "closed");
    await store.setMeetingSummaryState(meeting.id, "completed", "strict-summary-job");
    const closedSnapshot = await store.getSnapshot();
    vi.spyOn(store, "getSnapshot").mockResolvedValue({
      ...closedSnapshot,
      meetings: closedSnapshot.meetings.map((candidate) => (
        candidate.id === meeting.id ? drift(candidate) : candidate
      ))
    });
    const app = await createApp({ store, authDisabled: true });

    try {
      await expectContractViolations({
        retryCompletedSummary: await app.inject({
          method: "POST",
          url: `/api/meetings/${meeting.id}/summary/retry`
        })
      });
    } finally {
      await app.close();
    }
  });

  it("fails unguarded management mutations closed on response drift", async () => {
    const store = new InMemoryPlatformStore();
    const snapshot = await store.getSnapshot();
    const agent = snapshot.agents[0]!;
    const role = snapshot.roles[0]!;
    const imageDigest = `sha256:${"d".repeat(64)}`;
    const packInput = {
      name: "Strict response Tool Pack",
      version: "1.0.0",
      description: "Strict response fixture.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/strict@${imageDigest}`,
      imageDigest,
      tools: [{
        name: "read_strict_fixture",
        kind: "command" as const,
        goal: "Read the strict response fixture.",
        access: "read_only" as const,
        argv: { executable: "/usr/bin/true", fixedArguments: [] },
        env: { allowedNames: [] },
        stdin: { mode: "none" as const }
      }]
    };
    const pack = await store.createToolPack(packInput);
    const profileInput = {
      name: "Strict response Runtime",
      harnessKind: "openai_compatible" as const,
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only" as const,
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    } satisfies CreateRuntimeProfileInput;
    const profile = await store.createRuntimeProfile(profileInput);
    const now = new Date().toISOString();
    const team = {
      id: "e0000000-0000-4000-8000-000000000001",
      revision: 1,
      name: "Strict response Team",
      description: "Strict response fixture.",
      members: [{ agentId: agent.id, roleId: role.id, isChair: true }],
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    };
    const preset = {
      id: "e0000000-0000-4000-8000-000000000002",
      revision: 1,
      name: "Strict response Preset",
      description: "Strict response fixture.",
      teamId: null,
      mode: "chaired" as const,
      automation: "suggest" as const,
      durationMinutes: 30,
      agendaItems: [{ title: "Strict response", description: "" }],
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    };

    vi.spyOn(store, "createToolPack").mockResolvedValue(drift(pack));
    vi.spyOn(store, "updateToolPack").mockResolvedValue(drift(pack));
    vi.spyOn(store, "validateToolPack").mockResolvedValue(drift(pack));
    vi.spyOn(store, "approveToolPack").mockResolvedValue(drift(pack));
    vi.spyOn(store, "revokeToolPack").mockResolvedValue(drift(pack));
    vi.spyOn(store, "createRuntimeProfile").mockResolvedValue(drift(profile));
    vi.spyOn(store, "updateRuntimeProfile").mockResolvedValue(drift(profile));
    vi.spyOn(store, "updateAgentTeam").mockResolvedValue(drift(team));
    vi.spyOn(store, "updateMeetingPreset").mockResolvedValue(drift(preset));
    const app = await createApp({ store, authDisabled: true });

    try {
      await expectContractViolations({
        createToolPack: await app.inject({
          method: "POST",
          url: "/api/tool-packs",
          headers: { "idempotency-key": "strict-tool-pack-create" },
          payload: packInput
        }),
        updateToolPack: await app.inject({
          method: "PATCH",
          url: `/api/tool-packs/${pack.id}`,
          payload: { expectedRevision: pack.revision, description: "Strict update." }
        }),
        validateToolPack: await app.inject({
          method: "POST",
          url: `/api/tool-packs/${pack.id}/validate`,
          payload: {
            expectedRevision: pack.revision,
            manifestDigest: pack.manifestDigest,
            result: "passed",
            summary: "Strict validation."
          }
        }),
        approveToolPack: await app.inject({
          method: "POST",
          url: `/api/tool-packs/${pack.id}/approve`,
          payload: { expectedRevision: pack.revision, manifestDigest: pack.manifestDigest }
        }),
        revokeToolPack: await app.inject({
          method: "POST",
          url: `/api/tool-packs/${pack.id}/revoke`,
          payload: { expectedRevision: pack.revision, reason: "Strict revocation." }
        }),
        createRuntimeProfile: await app.inject({
          method: "POST",
          url: "/api/runtime-profiles",
          headers: { "idempotency-key": "strict-runtime-profile-create" },
          payload: profileInput
        }),
        updateRuntimeProfile: await app.inject({
          method: "PATCH",
          url: `/api/runtime-profiles/${profile.id}`,
          payload: { expectedRevision: profile.revision, timeoutMs: 70_000 }
        }),
        updateAgentTeam: await app.inject({
          method: "PATCH",
          url: `/api/agent-teams/${team.id}`,
          payload: { expectedRevision: team.revision, description: "Strict Team update." }
        }),
        updateMeetingPreset: await app.inject({
          method: "PATCH",
          url: `/api/meeting-presets/${preset.id}`,
          payload: { expectedRevision: preset.revision, description: "Strict Preset update." }
        })
      });
    } finally {
      await app.close();
    }
  });
});
