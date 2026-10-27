import { describe, expect, it } from "vitest";
import { parseQueuedCouncilJob } from "./job-contract.js";

const legacySummary = { meetingId: "meeting", requestedBy: "system" as const };
const legacyReview = {
  goalRunId: "90000000-0000-4000-8000-000000000001",
  scope: "task" as const,
  scopeId: "90000000-0000-4000-8000-000000000002",
  reviewerAgentId: "90000000-0000-4000-8000-000000000003",
  reviewerAgentRevision: 1,
  modelConnectorId: "90000000-0000-4000-8000-000000000004",
  contractDigest: "a".repeat(64),
  requestedBy: "system" as const
};

describe("Worker Council job boundary", () => {
  it("accepts and normalizes a legacy raw payload during the rolling upgrade", () => {
    expect(parseQueuedCouncilJob("meeting-summary", legacySummary)).toEqual({
      contractVersion: 1,
      name: "meeting-summary",
      data: legacySummary
    });
  });

  it("accepts a bounded v1 Reviewer payload for fail-closed rolling-upgrade reconciliation", () => {
    expect(parseQueuedCouncilJob("goal-review", legacyReview)).toEqual({
      contractVersion: 1,
      name: "goal-review",
      data: legacyReview
    });
  });

  it("accepts a versioned payload whose embedded name matches BullMQ", () => {
    const envelope = { contractVersion: 1 as const, name: "meeting-summary" as const, data: legacySummary };
    expect(parseQueuedCouncilJob("meeting-summary", envelope)).toEqual(envelope);
  });

  it("rejects corrupt, unknown-version, and name-mismatched payloads", () => {
    expect(() => parseQueuedCouncilJob("meeting-summary", { ...legacySummary, requestedBy: "owner" })).toThrow();
    expect(() => parseQueuedCouncilJob("meeting-summary", {
      contractVersion: 2,
      name: "meeting-summary",
      data: legacySummary
    })).toThrow();
    expect(() => parseQueuedCouncilJob("agent-turn", {
      contractVersion: 1,
      name: "meeting-summary",
      data: legacySummary
    })).toThrow();
  });
});
