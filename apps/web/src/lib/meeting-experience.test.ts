import { describe, expect, it } from "vitest";
import type { MeetingExperienceData } from "./meeting-experience";
import { meetingActivity, meetingCanvasProjection } from "./meeting-experience";

const data = {
  meeting: {
    id: "meeting-1", title: "產品決策", goal: "決定下一步", state: "active", createdAt: "2026-07-11T09:00:00.000Z",
    agenda: { revision: 1, items: [{ id: "agenda-1", title: "確認範圍", description: "", position: 0, status: "completed" }] }
  },
  participants: [{ id: "participant-1", agentId: "agent-1", isChair: true, roleSnapshot: { name: "主持人", responsibility: "協調" } }],
  messages: [{ id: "message-1", meetingId: "meeting-1", agentId: "agent-1", speakerType: "agent", speakerName: "Alex", roleName: "主持人", content: "提出選項", kind: "inference", evidenceCount: 0, createdAt: "2026-07-11T09:02:00.000Z" }],
  decisions: [{ id: "decision-1", meetingId: "meeting-1", title: "核准方向", description: "先做第一階段", status: "approved", createdAt: "2026-07-11T09:03:00.000Z" }],
  tasks: [{ id: "task-1", meetingId: "meeting-1", decisionId: "decision-1", title: "建立原型", assignee: "Demo Owner", acceptanceCriteria: "可供審閱", status: "todo", createdAt: "2026-07-11T09:04:00.000Z" }],
  evidence: [{ id: "evidence-1", title: "研究筆記", subtitle: "來源已連結", status: "linked", createdAt: "2026-07-11T09:01:00.000Z" }]
} as unknown as MeetingExperienceData;

describe("meeting experience projections", () => {
  it("creates a chronological activity stream with stable tie-breaking", () => {
    expect(meetingActivity(data).map((item) => item.id)).toEqual([
      "meeting:meeting-1", "evidence:evidence-1", "message:message-1", "decision:decision-1", "task:task-1"
    ]);
  });

  it("projects progress links only between available deterministic nodes", () => {
    const projection = meetingCanvasProjection(data, "progress");

    expect(projection.nodes.map((node) => node.id)).toEqual(["meeting:meeting-1", "agenda:agenda-1", "decision:decision-1", "task:task-1"]);
    expect(projection.edges).toContainEqual(expect.objectContaining({ source: "decision:decision-1", target: "task:task-1", label: "落實" }));
  });

  it("keeps collaboration and resource lens projections distinct", () => {
    expect(meetingCanvasProjection(data, "collaboration").nodes.map((node) => node.kind)).toEqual(["meeting", "participant", "message"]);
    expect(meetingCanvasProjection(data, "resources").nodes.map((node) => node.kind)).toEqual(["meeting", "evidence", "task"]);
  });
});
