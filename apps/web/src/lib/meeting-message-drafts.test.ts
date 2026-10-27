import { describe, expect, it } from "vitest";
import {
  MeetingMessageDraftOwnership,
  MeetingMessageRetryOwnership,
  restoreMeetingMessageDraft,
  updateMeetingMessageDraft
} from "./meeting-message-drafts";

describe("Meeting message drafts", () => {
  it("keeps unsent messages isolated by Meeting", () => {
    const first = updateMeetingMessageDraft({}, "meeting-a", "Draft A");
    const second = updateMeetingMessageDraft(first, "meeting-b", "Draft B");

    expect(second).toEqual({ "meeting-a": "Draft A", "meeting-b": "Draft B" });
    expect(updateMeetingMessageDraft(second, "meeting-a", "")).toEqual({ "meeting-b": "Draft B" });
  });

  it("restores a failed send without overwriting newer input", () => {
    expect(restoreMeetingMessageDraft({}, "meeting-a", "Failed draft"))
      .toEqual({ "meeting-a": "Failed draft" });
    expect(restoreMeetingMessageDraft({ "meeting-a": "New input" }, "meeting-a", "Failed draft"))
      .toEqual({ "meeting-a": "New input" });
  });

  it("allows only the newest concurrent send to restore its failed draft", () => {
    const ownership = new MeetingMessageDraftOwnership();
    const olderSend = ownership.beginSend("meeting-a");
    const newerSend = ownership.beginSend("meeting-a");

    const afterOlderFailure = ownership.restoreAfterFailure({}, olderSend, "Older draft");
    const afterNewerFailure = ownership.restoreAfterFailure(afterOlderFailure, newerSend, "Newer draft");

    expect(afterOlderFailure).toEqual({});
    expect(afterNewerFailure).toEqual({ "meeting-a": "Newer draft" });
    expect(ownership.restoreAfterFailure(afterNewerFailure, olderSend, "Older draft"))
      .toBe(afterNewerFailure);
  });

  it("tracks failed-send ownership independently for each Meeting", () => {
    const ownership = new MeetingMessageDraftOwnership();
    const meetingASend = ownership.beginSend("meeting-a");
    const meetingBSend = ownership.beginSend("meeting-b");

    const afterA = ownership.restoreAfterFailure({}, meetingASend, "Draft A");
    const afterB = ownership.restoreAfterFailure(afterA, meetingBSend, "Draft B");

    expect(afterB).toEqual({ "meeting-a": "Draft A", "meeting-b": "Draft B" });
  });

  it("retains an ambiguous retry key when the owner switches to another Meeting", () => {
    const ownership = new MeetingMessageRetryOwnership();
    const meetingA = ownership.acquire("meeting-a", "same draft", () => "key-a");
    const meetingB = ownership.acquire("meeting-b", "other draft", () => "key-b");

    expect(ownership.acquire("meeting-a", "same draft", () => "replacement-key")).toBe(meetingA);
    ownership.clear(meetingB);
    expect(ownership.acquire("meeting-a", "same draft", () => "replacement-key")).toBe(meetingA);
  });

  it("keeps ambiguous retry keys separate by Meeting and message signature", () => {
    const ownership = new MeetingMessageRetryOwnership();
    const messageA = ownership.acquire("meeting-a", "draft-a", () => "key-a");
    const messageB = ownership.acquire("meeting-a", "draft-b", () => "key-b");

    expect(messageB).not.toBe(messageA);
    expect(ownership.acquire("meeting-a", "draft-a", () => "replacement-a")).toBe(messageA);
    expect(ownership.acquire("meeting-a", "draft-b", () => "replacement-b")).toBe(messageB);
  });

  it("retains unresolved message signatures and only clears the exact current slot", () => {
    const ownership = new MeetingMessageRetryOwnership();
    const messageA = ownership.acquire("meeting-a", "draft-a", () => "key-a");
    ownership.acquire("meeting-a", "draft-b", () => "key-b");
    const messageC = ownership.acquire("meeting-a", "draft-c", () => "key-c");

    expect(ownership.acquire("meeting-a", "draft-a", () => "replacement-a")).toBe(messageA);
    ownership.clear(messageA);
    const replacementA = ownership.acquire("meeting-a", "draft-a", () => "replacement-a-2");
    expect(replacementA.idempotencyKey).toBe("replacement-a-2");
    expect(ownership.acquire("meeting-a", "draft-c", () => "replacement-c")).toBe(messageC);
  });

  it("does not evict an unresolved signature after more than 32 distinct messages", () => {
    const ownership = new MeetingMessageRetryOwnership();
    const first = ownership.acquire("meeting-a", "draft-0", () => "key-0");

    for (let index = 1; index <= 40; index += 1) {
      ownership.acquire("meeting-a", `draft-${index}`, () => `key-${index}`);
    }

    expect(ownership.acquire("meeting-a", "draft-0", () => "replacement-0")).toBe(first);
  });
});
