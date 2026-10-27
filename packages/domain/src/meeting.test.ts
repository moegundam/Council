import { describe, expect, it } from "vitest";
import { transitionMeeting } from "./meeting.js";

describe("meeting state machine", () => {
  it("supports draft -> active -> paused -> active -> closed", () => {
    expect(transitionMeeting("draft", "start")).toBe("active");
    expect(transitionMeeting("active", "pause")).toBe("paused");
    expect(transitionMeeting("paused", "resume")).toBe("active");
    expect(transitionMeeting("active", "close")).toBe("closed");
  });

  it("rejects reopening a closed meeting", () => {
    expect(() => transitionMeeting("closed", "resume")).toThrow(/invalid meeting transition/i);
  });
});
