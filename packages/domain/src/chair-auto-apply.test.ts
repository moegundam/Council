import { describe, expect, it } from "vitest";
import type { ChairSuggestionRecord, Meeting } from "@council/contracts";
import {
  decideChairAutoApply,
  type ChairAutoApplyContribution
} from "./chair-auto-apply.js";

const startedAt = "2026-07-20T00:00:00.000Z";

function meeting(overrides: Partial<Pick<Meeting, "automation" | "mode" | "state" | "startedAt">> = {}): Pick<Meeting, "automation" | "mode" | "state" | "startedAt"> {
  return {
    automation: "auto",
    mode: "open",
    state: "active",
    startedAt,
    ...overrides
  };
}

function suggestion(
  reason: ChairSuggestionRecord["reason"],
  suggestedMode: ChairSuggestionRecord["suggestedMode"] = reason === "time_remaining" ? "fixed" : "chaired",
  id = "suggestion-current"
): ChairSuggestionRecord {
  return {
    id,
    meetingId: "meeting",
    sourceUtteranceId: "source-current",
    reason,
    suggestedMode,
    explanation: "bounded policy suggestion",
    score: 0.9,
    status: "open",
    modeAcceptedAt: null,
    requestedAgentId: null,
    requestedAgentJobId: null,
    resolution: null,
    resolutionNote: null,
    resolvedBy: null,
    transitions: [{ id: `${id}-created`, type: "created", actor: "system", at: startedAt }],
    createdAt: startedAt,
    resolvedAt: null
  };
}

function applied(
  reason: ChairSuggestionRecord["reason"],
  at: string,
  id: string,
  sourceUtteranceId = `${id}-source`
): ChairSuggestionRecord {
  return {
    ...suggestion(reason, reason === "time_remaining" ? "fixed" : "chaired", id),
    sourceUtteranceId,
    status: "resolved",
    modeAcceptedAt: at,
    resolution: "completed",
    resolvedBy: "system",
    resolvedAt: at,
    transitions: [
      { id: `${id}-created`, type: "created", actor: "system", at: startedAt },
      { id: `${id}-accepted`, type: "mode_accepted", actor: "system", at }
    ]
  };
}

function contribution(
  id: string,
  createdAt: string,
  speakerName: string,
  content = "針對議程提出具體分析",
  isChair = false
): ChairAutoApplyContribution {
  return { id, createdAt, speakerType: "human", speakerName, content, isChair };
}

describe("deterministic Chair auto-apply policy", () => {
  it("requires auto automation and an active meeting", () => {
    const current = suggestion("off_topic");
    expect(decideChairAutoApply({ meeting: meeting({ automation: "suggest" }), suggestion: current, history: [], contributions: [] })).toEqual({
      allowed: false,
      reason: "automation_not_auto"
    });
    expect(decideChairAutoApply({ meeting: meeting({ state: "paused" }), suggestion: current, history: [], contributions: [] })).toEqual({
      allowed: false,
      reason: "meeting_not_active"
    });
  });

  it("never broadens the current meeting mode", () => {
    const current = suggestion("off_topic");
    expect(decideChairAutoApply({ meeting: meeting({ mode: "fixed" }), suggestion: current, history: [], contributions: [] })).toEqual({
      allowed: false,
      reason: "mode_would_broaden"
    });
  });

  it("does not auto-apply a short acknowledgement as off-topic", () => {
    const current = suggestion("off_topic");
    const source = contribution("source-current", "2026-07-20T00:02:00.000Z", "Owner", "好！");
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: current,
      history: [],
      contributions: [
        contribution("before", "2026-07-20T00:01:00.000Z", "Architect"),
        source
      ],
      now: Date.parse("2026-07-20T00:03:01.000Z")
    })).toEqual({ allowed: false, reason: "short_acknowledgement" });
  });

  it("keeps repetition across different speakers as suggestion-only", () => {
    const current = suggestion("repetition");
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: current,
      history: [],
      contributions: [
        contribution("previous", "2026-07-20T00:01:00.000Z", "Architect", "需要白名單"),
        contribution("source-current", "2026-07-20T00:02:00.000Z", "Reviewer", "需要白名單")
      ],
      now: Date.parse("2026-07-20T00:03:01.000Z")
    })).toEqual({ allowed: false, reason: "repetition_different_speakers" });
  });

  it("also blocks repetition when the previous speaker was the Chair", () => {
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: suggestion("repetition"),
      history: [],
      contributions: [
        contribution("previous", "2026-07-20T00:01:00.000Z", "Chair", "需要白名單", true),
        contribution("source-current", "2026-07-20T00:02:00.000Z", "Reviewer", "需要白名單")
      ],
      now: Date.parse("2026-07-20T00:03:01.000Z")
    })).toEqual({ allowed: false, reason: "repetition_different_speakers" });
  });

  it("requires sixty seconds and two non-chair contributions after the last auto application", () => {
    const current = suggestion("off_topic");
    const prior = applied("off_topic", "2026-07-20T00:05:00.000Z", "suggestion-prior");
    const base = {
      meeting: meeting(),
      suggestion: current,
      history: [prior],
      contributions: [
        contribution("one", "2026-07-20T00:05:10.000Z", "Architect"),
        contribution("source-current", "2026-07-20T00:05:20.000Z", "Reviewer")
      ]
    };
    expect(decideChairAutoApply({ ...base, now: Date.parse("2026-07-20T00:05:59.000Z") })).toEqual({
      allowed: false,
      reason: "cooldown"
    });
    expect(decideChairAutoApply({
      ...base,
      contributions: [contribution("source-current", "2026-07-20T00:06:20.000Z", "Reviewer")],
      now: Date.parse("2026-07-20T00:06:20.000Z")
    })).toEqual({ allowed: false, reason: "insufficient_contributions" });
    expect(decideChairAutoApply({ ...base, now: Date.parse("2026-07-20T00:06:01.000Z") })).toEqual({ allowed: true, reason: "allowed" });
  });

  it("allows the first non-time intervention after two contributions since meeting start", () => {
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: suggestion("off_topic"),
      history: [],
      contributions: [
        contribution("one", "2026-07-20T00:01:00.000Z", "Architect"),
        contribution("source-current", "2026-07-20T00:02:00.000Z", "Reviewer")
      ],
      now: Date.parse("2026-07-20T00:02:01.000Z")
    })).toEqual({ allowed: true, reason: "allowed" });
  });

  it("allows time convergence only once and never after six system applications", () => {
    const current = suggestion("time_remaining");
    expect(decideChairAutoApply({
      meeting: meeting({ mode: "chaired" }),
      suggestion: current,
      history: [applied("time_remaining", "2026-07-20T00:01:00.000Z", "time-prior")],
      contributions: [],
      now: Date.parse("2026-07-20T00:02:00.000Z")
    })).toEqual({ allowed: false, reason: "time_already_applied" });

    const six = Array.from({ length: 6 }, (_, index) => applied(
      "off_topic",
      `2026-07-20T00:0${index + 1}:00.000Z`,
      `applied-${index}`
    ));
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: suggestion("off_topic"),
      history: six,
      contributions: [
        contribution("one", "2026-07-20T00:07:00.000Z", "Architect"),
        contribution("source-current", "2026-07-20T00:08:00.000Z", "Reviewer")
      ],
      now: Date.parse("2026-07-20T00:09:01.000Z")
    })).toEqual({ allowed: false, reason: "maximum_auto_applications" });
  });

  it("counts only system mode acceptance, not owner acceptance or unrelated transitions", () => {
    const ownerApplied = suggestion("time_remaining", "fixed", "owner-applied");
    ownerApplied.transitions.push({ id: "owner-mode", type: "mode_accepted", actor: "owner", at: "2026-07-20T00:01:00.000Z" });
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: suggestion("time_remaining"),
      history: [ownerApplied],
      contributions: [],
      now: Date.parse("2026-07-20T00:02:00.000Z")
    })).toEqual({ allowed: true, reason: "allowed" });
  });

  it("counts system applications only from the same Meeting", () => {
    const otherMeeting = applied("off_topic", "2026-07-20T00:01:00.000Z", "other-meeting");
    otherMeeting.meetingId = "another-meeting";
    expect(decideChairAutoApply({
      meeting: meeting(),
      suggestion: suggestion("time_remaining"),
      history: [otherMeeting],
      contributions: [],
      now: Date.parse("2026-07-20T00:02:00.000Z")
    })).toEqual({ allowed: true, reason: "allowed" });
  });
});
