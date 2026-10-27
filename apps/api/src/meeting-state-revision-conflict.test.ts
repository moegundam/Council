import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

describe("Meeting state revision conflicts", () => {
  it("returns REVISION_CONFLICT when another transition wins after the route snapshot", async () => {
    const store = new InMemoryPlatformStore();
    const meeting = (await store.getSnapshot()).meetings[0]!;
    if (meeting.state !== "active") {
      await store.setMeetingState(meeting.id, "active", meeting.state);
    }
    const setMeetingState = store.setMeetingState.bind(store);
    vi.spyOn(store, "setMeetingState").mockImplementationOnce(async (id, state, expectedState) => {
      await setMeetingState(id, "paused", expectedState);
      return setMeetingState(id, state, expectedState);
    });
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/meetings/${meeting.id}/pause`
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
      expect((await store.getSnapshot()).meetings.find((candidate) => candidate.id === meeting.id)?.state)
        .toBe("paused");
    } finally {
      await app.close();
    }
  });
});
