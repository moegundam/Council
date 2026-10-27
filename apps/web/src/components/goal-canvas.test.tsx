import { describe, expect, it } from "vitest";
import { goalCanvasNodeActions } from "./goal-canvas";
import type { GoalCanvasSnapshot } from "@council/contracts";

type GoalCanvasNode = GoalCanvasSnapshot["nodes"][number];

const meetingId = "10000000-0000-4000-8000-000000000001";
const context = { meetingId, threadId: "thread-1", goalId: "goal-1" };

function node(overrides: Partial<GoalCanvasNode>): GoalCanvasNode {
  return { id: "phase:discussion", type: "phase", label: "會議討論", status: "running", entityId: meetingId, detail: {}, ...overrides };
}

describe("GoalCanvas interaction contracts", () => {
  it("keeps the owning meeting first and resolves evidence-adjacent data through its Agent ID", () => {
    const actions = goalCanvasNodeActions(node({ type: "data", entityId: "agent-1" }), context);
    expect(new URL(actions[0]!.href, "https://example.test").searchParams.get("fromGoalId")).toBe("goal-1");
    expect(new URL(actions[1]!.href, "https://example.test").searchParams.get("fromMeetingId")).toBe(meetingId);
  });

  it("creates entity-specific read-only deep links when task or Agent IDs are available", () => {
    const taskActions = goalCanvasNodeActions(node({ id: "task:task id", type: "task", entityId: "task id" }), context);
    const agentActions = goalCanvasNodeActions(node({ id: "agent:agent/id", type: "agent", entityId: "agent/id" }), context);
    expect(new URL(taskActions[1]!.href, "https://example.test").searchParams.get("taskId")).toBe("task id");
    expect(new URL(agentActions[1]!.href, "https://example.test").searchParams.get("agentId")).toBe("agent/id");
  });

  it("keeps fullscreen keyboard behavior and focus restoration in the component", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./goal-canvas.tsx", import.meta.url), "utf8"));
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("fullScreenTriggerRef.current?.focus()");
    expect(source).toContain('aria-modal={fullScreen || undefined}');
  });
});
