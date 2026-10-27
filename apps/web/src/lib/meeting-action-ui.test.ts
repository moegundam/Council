import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { meetingActionRequestIsCurrent } from "./meeting-action-ui.js";

describe("Meeting action request ownership", () => {
  it("rejects a completion from the previously selected Meeting", () => {
    expect(meetingActionRequestIsCurrent(
      { meetingId: "meeting-a", workspaceRevision: 3 },
      { meetingId: "meeting-b", workspaceRevision: 4 }
    )).toBe(false);
    expect(meetingActionRequestIsCurrent(
      { meetingId: "meeting-b", workspaceRevision: 4 },
      { meetingId: "meeting-b", workspaceRevision: 4 }
    )).toBe(true);
  });

  const source = readFileSync(new URL("../components/discussions-view.tsx", import.meta.url), "utf8");

  function handlerSource(name: string): string {
    const start = source.indexOf(`  async function ${name}`);
    const next = source.indexOf("\n  async function ", start + 1);
    expect(start, `${name} should exist`).toBeGreaterThanOrEqual(0);
    return source.slice(start, next < 0 ? source.length : next);
  }

  it.each([
    "saveAgenda",
    "advanceAgenda",
    "submitDecision",
    "sendMessage",
    "changeMode",
    "changeAutomation",
    "approveChairSuggestionMode",
    "approveChairSuggestedRole",
    "dismissChairSuggestion",
    "runAgent",
    "meetingAction",
    "decisionAction",
    "createTask",
    "runTool",
    "closeMeeting",
    "retryMeetingSummary"
  ])("keeps %s completion owned by its original Meeting", (name) => {
    const handler = handlerSource(name);
    expect(handler).toContain("captureMeetingRequest(");
    expect(handler).toContain("requestIsCurrent()");
  });

  it("does not let an old Role switch unlock a newly selected Meeting", () => {
    const handler = handlerSource("switchParticipantRole");
    expect(handler).toContain("captureMeetingRequest(");
    expect(handler).toContain("if (!requestIsCurrent()) return;");
    expect(handler).toContain("if (requestIsCurrent()) setRoleSwitchBusy(false);");
  });

  it("resets Role-switch busy state when the selected Meeting changes", () => {
    const resetStart = source.indexOf("workspaceRevisionRef.current += 1;");
    const resetEnd = source.indexOf("  }, [meeting?.id, updatePendingAction]);", resetStart);
    expect(resetStart).toBeGreaterThanOrEqual(0);
    expect(resetEnd).toBeGreaterThan(resetStart);
    expect(source.slice(resetStart, resetEnd)).toContain("setRoleSwitchBusy(false);");
  });

  it("lets only the current Tool request release its own idempotency token", () => {
    const handler = handlerSource("runTool");
    const requestStart = handler.indexOf("      const queuedOutcome = await resolveCommittedMutation(() => mutate");
    const errorStart = handler.indexOf("    } catch (cause)", requestStart);
    const successBlock = handler.slice(requestStart, errorStart);
    const errorBlock = handler.slice(errorStart);

    expect(requestStart).toBeGreaterThanOrEqual(0);
    expect(errorStart).toBeGreaterThan(requestStart);
    expect(successBlock).toMatch(
      /toolRetryOwnershipRef\.current\.clear\(retry\);\s+if \(!requestIsCurrent\(\)\) return;/
    );
    expect(errorBlock).toMatch(
      /if \(cause instanceof ApiError && cause\.status < 500\) toolRetryOwnershipRef\.current\.clear\(retry\);\s+if \(!requestIsCurrent\(\)\) return;/
    );
  });

  it("does not expose a newly created Meeting until its automatic start settles", () => {
    const handler = handlerSource("submitMeeting");
    const startRequest = handler.indexOf("const startOutcome = await resolveCommittedMutation(() =>");
    const startMutation = handler.indexOf("mutate(`/api/meetings/${created.id}/start`", startRequest);
    const selectCreatedMeeting = handler.indexOf("setMeetingId(created.id)");
    const closeCreator = handler.indexOf("setMeetingModal(false)");

    expect(startRequest).toBeGreaterThanOrEqual(0);
    expect(startMutation).toBeGreaterThan(startRequest);
    expect(selectCreatedMeeting).toBeGreaterThan(startRequest);
    expect(closeCreator).toBeGreaterThan(startRequest);
  });

  it("rejects Agent runs unless the selected Meeting is active", () => {
    expect(handlerSource("runAgent")).toContain('if (!meeting || meeting.state !== "active") return false;');
  });
});
