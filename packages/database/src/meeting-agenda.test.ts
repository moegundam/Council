import { describe, expect, it } from "vitest";
import type {
  AdvanceMeetingAgendaInput,
  Meeting,
  ParticipantRoleBinding,
  PlatformSnapshot,
  SetMeetingAgendaInput
} from "@council/contracts";
import { InMemoryPlatformStore } from "./memory-store.js";
import { createSeedSnapshot } from "./seed.js";

type AgendaStore = InMemoryPlatformStore & {
  setMeetingAgenda(id: string, input: SetMeetingAgendaInput): Promise<Meeting>;
  advanceMeetingAgenda(id: string, input: AdvanceMeetingAgendaInput): Promise<Meeting>;
};

function agendaStore(store: InMemoryPlatformStore): AgendaStore {
  return store as AgendaStore;
}

function participantRoleBinding(
  snapshot: PlatformSnapshot,
  meetingId: string,
  agentId: string
): ParticipantRoleBinding {
  const participant = snapshot.participants.find(
    (item) => item.meetingId === meetingId && item.agentId === agentId
  );
  if (!participant) throw new Error(`Participant ${agentId} is not assigned to Meeting ${meetingId}.`);
  return {
    participantId: participant.id,
    roleRevision: participant.roleRevision,
    roleId: participant.roleId,
    roleVersion: participant.roleSnapshot.version
  };
}

class AuditedAgendaStore extends InMemoryPlatformStore {
  readonly audits: Array<{ event: string; entityType: string; entityId: string; detail: Record<string, unknown> }> = [];

  override async recordAudit(event: string, entityType: string, entityId: string, detail: Record<string, unknown> = {}): Promise<void> {
    this.audits.push({ event, entityType, entityId, detail });
  }
}

async function createDraftMeeting(store: InMemoryPlatformStore): Promise<Meeting> {
  const snapshot = await store.getSnapshot();
  await store.setMeetingState(snapshot.meetings[0]!.id, "closed");
  return store.createMeeting({
    threadId: snapshot.threads[0]!.id,
    title: "Agenda lifecycle",
    goal: "Verify ordered Meeting Agenda behavior.",
    mode: "open",
    durationMinutes: 30,
    participants: [{
      agentId: snapshot.agents[0]!.id,
      roleId: snapshot.roles[0]!.id,
      isChair: true
    }],
    agendaItems: [
      { title: "確認範圍", description: "鎖定本次輸出。" },
      { title: "檢視風險", description: "整理風險。" }
    ]
  });
}

describe("Meeting Agenda persistence", () => {
  it("normalizes only a missing legacy Agenda and rejects malformed existing Agenda data", async () => {
    const legacy = createSeedSnapshot() as unknown as { meetings: Array<Record<string, unknown>> };
    delete legacy.meetings[0]!.agenda;
    await expect(new InMemoryPlatformStore(legacy as never).getSnapshot()).resolves.toMatchObject({
      meetings: [expect.objectContaining({ agenda: { revision: 0, items: [] } })]
    });

    const malformed = createSeedSnapshot() as unknown as { meetings: Array<Record<string, unknown>> };
    malformed.meetings[0]!.agenda = { revision: 1, items: "not-an-array" };
    expect(() => new InMemoryPlatformStore(malformed as never)).toThrow(/Agenda/i);
  });

  it("creates ordered pending items and activates the first item when the Meeting starts", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = await createDraftMeeting(store);

    expect(meeting.agenda).toMatchObject({
      revision: 0,
      items: [
        { title: "確認範圍", position: 0, status: "pending", startedAt: null, resolvedAt: null },
        { title: "檢視風險", position: 1, status: "pending", startedAt: null, resolvedAt: null }
      ]
    });

    const active = await store.setMeetingState(meeting.id, "active", "draft");
    expect(active.agenda.revision).toBe(1);
    expect(active.agenda.items.map((item) => item.status)).toEqual(["current", "pending"]);
    expect(active.agenda.items[0]!.startedAt).toEqual(expect.any(String));
  });

  it("edits only the pending tail, rejects stale writes, and preserves no-op revisions", async () => {
    const store = new InMemoryPlatformStore();
    const draft = await createDraftMeeting(store);
    const active = await store.setMeetingState(draft.id, "active", "draft");
    const [locked, pending] = active.agenda.items;

    const updated = await agendaStore(store).setMeetingAgenda(active.id, {
      expectedRevision: active.agenda.revision,
      items: [
        { id: locked!.id, title: locked!.title, description: locked!.description },
        { id: pending!.id, title: "檢視主要風險", description: "只改尚未開始的項目。" },
        { title: "收斂決議", description: "" }
      ]
    });
    expect(updated.agenda.revision).toBe(2);
    expect(updated.agenda.items.map((item) => [item.title, item.status])).toEqual([
      ["確認範圍", "current"],
      ["檢視主要風險", "pending"],
      ["收斂決議", "pending"]
    ]);

    const unchanged = await agendaStore(store).setMeetingAgenda(updated.id, {
      expectedRevision: updated.agenda.revision,
      items: updated.agenda.items.map((item) => ({ id: item.id, title: item.title, description: item.description }))
    });
    expect(unchanged.agenda.revision).toBe(updated.agenda.revision);

    await expect(agendaStore(store).setMeetingAgenda(updated.id, {
      expectedRevision: active.agenda.revision,
      items: updated.agenda.items.map((item) => ({ id: item.id, title: item.title, description: item.description }))
    })).rejects.toThrow(/revision changed/i);

    await expect(agendaStore(store).setMeetingAgenda(updated.id, {
      expectedRevision: updated.agenda.revision,
      items: [
        { id: locked!.id, title: "改寫目前項目", description: locked!.description },
        ...updated.agenda.items.slice(1).map((item) => ({ id: item.id, title: item.title, description: item.description }))
      ]
    })).rejects.toThrow(/locked/i);
  });

  it("completes or skips current items, advances in order, and blocks invalid lifecycle actions", async () => {
    const store = new InMemoryPlatformStore();
    const draft = await createDraftMeeting(store);
    let meeting = await store.setMeetingState(draft.id, "active", "draft");
    const first = meeting.agenda.items[0]!;

    meeting = await agendaStore(store).advanceMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      action: "complete",
      itemId: first.id
    });
    expect(meeting.agenda.items.map((item) => item.status)).toEqual(["completed", "current"]);
    expect(meeting.agenda.items[0]!.resolvedAt).toEqual(expect.any(String));

    const second = meeting.agenda.items[1]!;
    meeting = await agendaStore(store).advanceMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      action: "skip",
      itemId: second.id
    });
    expect(meeting.agenda.items.map((item) => item.status)).toEqual(["completed", "skipped"]);
    expect(meeting.agenda.items[1]!.resolvedAt).toEqual(expect.any(String));

    await expect(agendaStore(store).advanceMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      action: "activate"
    })).rejects.toThrow(/pending/i);

    const paused = await store.setMeetingState(meeting.id, "paused", "active");
    await expect(agendaStore(store).advanceMeetingAgenda(paused.id, {
      expectedRevision: paused.agenda.revision,
      action: "activate"
    })).rejects.toThrow(/active Meeting/i);

    const closed = await store.setMeetingState(paused.id, "closed", "paused");
    await expect(agendaStore(store).setMeetingAgenda(closed.id, {
      expectedRevision: closed.agenda.revision,
      items: []
    })).rejects.toThrow(/closed/i);
  });

  it("records bounded audit details for in-memory Agenda edits and progress", async () => {
    const store = new AuditedAgendaStore();
    const draft = await createDraftMeeting(store);
    const active = await store.setMeetingState(draft.id, "active", "draft");
    expect(store.audits).toContainEqual({
      event: "meeting.agenda.advanced",
      entityType: "meeting",
      entityId: active.id,
      detail: {
        action: "activate",
        previousRevision: draft.agenda.revision,
        revision: active.agenda.revision,
        currentItemId: active.agenda.items[0]!.id,
        source: "meeting_state"
      }
    });
    store.audits.length = 0;
    const [current, pending] = active.agenda.items;

    const updated = await agendaStore(store).setMeetingAgenda(active.id, {
      expectedRevision: active.agenda.revision,
      items: [
        { id: current!.id, title: current!.title, description: current!.description },
        { id: pending!.id, title: "更新後風險", description: pending!.description }
      ]
    });
    expect(store.audits).toContainEqual({
      event: "meeting.agenda.updated",
      entityType: "meeting",
      entityId: active.id,
      detail: {
        previousRevision: active.agenda.revision,
        revision: updated.agenda.revision,
        previousItemCount: 2,
        itemCount: 2,
        changedItemIds: [pending!.id]
      }
    });

    store.audits.length = 0;
    const advanced = await agendaStore(store).advanceMeetingAgenda(active.id, {
      expectedRevision: updated.agenda.revision,
      action: "complete",
      itemId: current!.id
    });
    expect(store.audits).toEqual([{
      event: "meeting.agenda.advanced",
      entityType: "meeting",
      entityId: active.id,
      detail: {
        action: "complete",
        itemId: current!.id,
        previousRevision: updated.agenda.revision,
        revision: advanced.agenda.revision,
        currentItemId: pending!.id
      }
    }]);
  });

  it("rejects an Agent turn if the Agenda revision changed after inference began", async () => {
    const seed = createSeedSnapshot();
    seed.meetings[0]!.mode = "open";
    const store = new InMemoryPlatformStore(seed);
    const meeting = (await store.getSnapshot()).meetings[0]!;
    const current = meeting.agenda.items.find((item) => item.status === "current")!;

    await agendaStore(store).advanceMeetingAgenda(meeting.id, {
      expectedRevision: meeting.agenda.revision,
      action: "complete",
      itemId: current.id
    });
    const binding = participantRoleBinding(await store.getSnapshot(), meeting.id, seed.agents[0]!.id);

    await expect(store.commitAgentTurn({
      ...binding,
      meetingId: meeting.id,
      agentId: seed.agents[0]!.id,
      turnId: "stale-agenda-turn",
      agendaRevision: meeting.agenda.revision,
      speakerName: seed.agents[0]!.name,
      roleName: seed.roles[0]!.name,
      content: "This response used an old Agenda.",
      auditDetail: {}
    })).resolves.toMatchObject({ status: "stale", utterance: null });
  });
});
