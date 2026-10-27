import { describe, expect, it } from "vitest";
import type { MeetingViewSnapshot, PlatformSnapshot } from "@council/contracts";
import { meetingViewFromSnapshot, mergeMeetingView, platformViewEndpoint } from "./platform-projection";

describe("platform page projections", () => {
  it.each([
    ["/", "/api/v1/views/discussions"],
    ["/discussions", "/api/v1/views/discussions"],
    ["/tasks", "/api/v1/views/tasks"],
    ["/tasks/task-1", "/api/v1/views/tasks"],
    ["/agents", "/api/v1/views/agents"],
    ["/settings", "/api/v1/views/settings"],
    ["/login", "/api/v1/views/discussions"],
    ["/docs", null],
    ["/docs/api", null]
  ])("maps %s to its bounded API view", (pathname, endpoint) => {
    expect(platformViewEndpoint(pathname)).toBe(endpoint);
  });

  it("keeps only the focused meeting's live collections", () => {
    const original = {
      meetings: [{ id: "m-1", title: "old" }, { id: "m-2", title: "other" }],
      participants: [{ id: "p-old", meetingId: "m-1" }, { id: "p-other", meetingId: "m-2" }],
      speakerQueue: [{ id: "q-old", meetingId: "m-1" }, { id: "q-other", meetingId: "m-2" }],
      utterances: [{ id: "u-old", meetingId: "m-1" }, { id: "u-other", meetingId: "m-2" }],
      toolRuns: [{ id: "r-old", meetingId: "m-1" }, { id: "r-other", meetingId: "m-2" }],
      chairSuggestions: [{ id: "c-old", meetingId: "m-1" }, { id: "c-other", meetingId: "m-2" }],
      decisions: [{ id: "d-old", meetingId: "m-1" }, { id: "d-other", meetingId: "m-2" }],
      tasks: [{ id: "t-old", meetingId: "m-1" }, { id: "t-other", meetingId: "m-2" }]
    } as unknown as PlatformSnapshot;
    const view = {
      meeting: { id: "m-1", title: "fresh" },
      participants: [{ id: "p-new", meetingId: "m-1" }],
      speakerQueue: [],
      utterances: [{ id: "u-new", meetingId: "m-1" }],
      toolRuns: [],
      chairSuggestions: [],
      decisions: [],
      tasks: []
    } as unknown as MeetingViewSnapshot;

    const merged = mergeMeetingView(original, view);

    expect(merged.meetings).toEqual([{ id: "m-1", title: "fresh" }, { id: "m-2", title: "other" }]);
    expect(merged.participants.map((item) => item.id)).toEqual(["p-new"]);
    expect(merged.utterances.map((item) => item.id)).toEqual(["u-new"]);
    expect(merged.speakerQueue).toEqual([]);
    expect(merged.toolRuns).toEqual([]);
    expect(merged.chairSuggestions).toEqual([]);
    expect(merged.decisions).toEqual([]);
    expect(merged.tasks).toEqual([]);
    expect(original.utterances.map((item) => item.id)).toEqual(["u-old", "u-other"]);
  });

  it("extracts the current focused Meeting view so a stale full refresh cannot erase newer work", () => {
    const current = {
      meetings: [{ id: "m-1", title: "fresh" }, { id: "m-2", title: "other" }],
      participants: [{ id: "p-1", meetingId: "m-1" }, { id: "p-2", meetingId: "m-2" }],
      speakerQueue: [],
      utterances: [{ id: "u-1", meetingId: "m-1" }],
      toolRuns: [],
      chairSuggestions: [],
      decisions: [{ id: "d-new", meetingId: "m-1" }],
      tasks: [{ id: "t-new", meetingId: "m-1" }]
    } as unknown as PlatformSnapshot;
    const base = {
      ...current,
      meetings: [{ id: "m-1", title: "base" }, { id: "m-2", title: "other" }],
      participants: [],
      utterances: [],
      decisions: [],
      tasks: []
    } as unknown as PlatformSnapshot;

    const latestView = meetingViewFromSnapshot(current, "m-1");
    const merged = latestView ? mergeMeetingView(base, latestView) : base;

    expect(merged.meetings.find((meeting) => meeting.id === "m-1")?.title).toBe("fresh");
    expect(merged.decisions.map((decision) => decision.id)).toEqual(["d-new"]);
    expect(merged.tasks.map((task) => task.id)).toEqual(["t-new"]);
    expect(meetingViewFromSnapshot(current, "missing")).toBeNull();
  });
});
