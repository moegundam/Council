import { describe, expect, it } from "vitest";
import type { PlatformSnapshot } from "@council/contracts";
import { eligibleMeetingSpeakers, meetingSpeakerQueue, speakerQueueStatusLabel } from "./speaker-queue-ui.js";

function fixture() {
  const snapshot = {
    speakerQueue: [
      { id: "queue-1", jobId: "job-1", meetingId: "meeting-1", participantId: "participant-1", agentId: "agent-1", roleRevision: 1, roleId: "role-1", roleVersion: 1, roleName: "主席", agendaRevision: 1, agendaCurrentItemId: null, status: "queued", requestedAt: "2026-07-20T00:00:00Z", startedAt: null }
    ],
    participants: [
      { id: "participant-1", meetingId: "meeting-1", agentId: "agent-1", roleId: "role-1", roleRevision: 1, roleHistory: [], isChair: true, roleSnapshot: { roleId: "role-1", name: "主席", usageContext: "", responsibility: "", speakingGuidance: "", decisionScope: "", constraints: "", version: 1, templateKey: "meeting_chair", toolPolicy: "none", dataPolicy: "meeting_only", source: "meeting_created" } },
      { id: "participant-2", meetingId: "meeting-1", agentId: "agent-2", roleId: "role-2", roleRevision: 1, roleHistory: [], isChair: false, roleSnapshot: { roleId: "role-2", name: "架構師", usageContext: "", responsibility: "", speakingGuidance: "", decisionScope: "", constraints: "", version: 1, templateKey: "platform_architect", toolPolicy: "none", dataPolicy: "meeting_only", source: "meeting_created" } }
    ],
    agents: [{ id: "agent-1", name: "Chair", description: "", modelConnectorId: null, goalSummary: "", toolsSummary: "", dataSummary: "", skillIds: [], toolGrants: [], status: "attention" }, { id: "agent-2", name: "Architect", description: "", modelConnectorId: null, goalSummary: "", toolsSummary: "", dataSummary: "", skillIds: [], toolGrants: [], status: "attention" }]
  } as unknown as PlatformSnapshot;
  return snapshot;
}

describe("speaker queue UI", () => {
  it("filters the durable queue to the selected meeting", () => {
    const snapshot = fixture();
    snapshot.speakerQueue.push({ ...snapshot.speakerQueue[0]!, meetingId: "other" });
    expect(meetingSpeakerQueue(snapshot, "meeting-1")).toHaveLength(1);
  });

  it("shows no eligible speaker while the Meeting already has an Agent action", () => {
    const snapshot = fixture();
    const queueIds = new Set(meetingSpeakerQueue(snapshot, "meeting-1").map((item) => item.participantId));
    expect(eligibleMeetingSpeakers({ id: "meeting-1", state: "active" }, snapshot.participants, snapshot.agents, ["agent-1", "agent-2"], queueIds)).toEqual([]);
    expect(eligibleMeetingSpeakers({ id: "meeting-1", state: "paused" }, snapshot.participants, snapshot.agents, ["agent-2"], queueIds)).toEqual([]);
  });

  it("labels queue states without implying work for an idle meeting", () => {
    expect(speakerQueueStatusLabel("queued")).toBe("排隊中");
    expect(speakerQueueStatusLabel("running")).toBe("發言中");
  });
});
