import { describe, expect, it } from "vitest";
import {
  buildAgentWorkspaceHref,
  buildGoalWorkspaceHref,
  buildMeetingWorkspaceHref,
  buildTaskWorkspaceHref,
  parseGoalWorkspaceRoute,
  parseMeetingWorkspaceRoute,
  parseWorkspaceSourceContext
} from "./workspace-navigation";

describe("workspace navigation", () => {
  it("parses only supported Goal views and Canvas lenses", () => {
    expect(parseGoalWorkspaceRoute(new URLSearchParams("goalId=goal-1&view=canvas&lens=resources"))).toEqual({
      goalId: "goal-1",
      view: "canvas",
      lens: "resources"
    });
    expect(parseGoalWorkspaceRoute(new URLSearchParams("goalId=&view=unknown&lens=unknown"))).toEqual({
      goalId: null,
      view: "overview",
      lens: "progress"
    });
  });

  it("builds a reloadable Goal URL without carrying unrelated parameters", () => {
    const href = buildGoalWorkspaceHref({ goalId: "goal / 1", view: "activity", lens: "collaboration" });
    const url = new URL(href, "https://example.test");
    expect(url.pathname).toBe("/goals");
    expect(Object.fromEntries(url.searchParams)).toEqual({ goalId: "goal / 1", view: "activity" });
  });

  it("keeps a Meeting shareable and carries only safe source identifiers", () => {
    const href = buildMeetingWorkspaceHref({
      meetingId: "meeting-1",
      threadId: "thread-1",
      fromGoalId: "goal-1",
      view: "canvas",
      lens: "collaboration"
    });
    const url = new URL(href, "https://example.test");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      threadId: "thread-1",
      meetingId: "meeting-1",
      fromGoalId: "goal-1",
      view: "canvas",
      lens: "collaboration"
    });
    expect(parseMeetingWorkspaceRoute(url.searchParams)).toEqual({
      threadId: "thread-1",
      meetingId: "meeting-1",
      fromGoalId: "goal-1",
      view: "canvas",
      lens: "collaboration"
    });
  });

  it("preserves Meeting and Goal lineage in Task and Agent management links", () => {
    const source = { meetingId: "meeting-1", threadId: "thread-1", goalId: "goal-1" };
    const taskUrl = new URL(buildTaskWorkspaceHref({ taskId: "task-1", source }), "https://example.test");
    const agentUrl = new URL(buildAgentWorkspaceHref({ agentId: "agent-1", source }), "https://example.test");

    expect(taskUrl.pathname).toBe("/tasks");
    expect(Object.fromEntries(taskUrl.searchParams)).toEqual({
      taskId: "task-1",
      fromMeetingId: "meeting-1",
      fromThreadId: "thread-1",
      fromGoalId: "goal-1"
    });
    expect(agentUrl.pathname).toBe("/agents");
    expect(Object.fromEntries(agentUrl.searchParams)).toEqual({
      agentId: "agent-1",
      fromMeetingId: "meeting-1",
      fromThreadId: "thread-1",
      fromGoalId: "goal-1"
    });
  });

  it("never treats an arbitrary returnUrl as navigation state", () => {
    const params = new URLSearchParams(
      "fromGoalId=goal-1&fromMeetingId=meeting-1&fromThreadId=thread-1&returnUrl=https://evil.example"
    );
    expect(parseWorkspaceSourceContext(params)).toEqual({
      goalId: "goal-1",
      meetingId: "meeting-1",
      threadId: "thread-1"
    });
    expect(buildTaskWorkspaceHref({ taskId: "task-1", source: parseWorkspaceSourceContext(params) }))
      .not.toContain("returnUrl");
  });
});
