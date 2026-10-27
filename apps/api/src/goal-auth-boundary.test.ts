import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

describe("Goal Run owner-session boundary", () => {
  it("rejects every Goal Run read surface and Owner message without a session", async () => {
    const app = await createApp({
      store: new InMemoryPlatformStore(),
      authDisabled: false,
      goalRunEnabled: true
    });
    const goalRunId = "90000000-0000-4000-8000-000000000099";
    const requests = [
      { method: "GET", url: "/api/v1/goal-runs" },
      { method: "GET", url: `/api/v1/goal-runs/${goalRunId}` },
      { method: "GET", url: `/api/v1/goal-runs/${goalRunId}/canvas?lens=progress` },
      { method: "GET", url: `/api/v1/goal-runs/${goalRunId}/events` },
      {
        method: "POST",
        url: `/api/v1/goal-runs/${goalRunId}/messages`,
        payload: { message: "This instruction must remain private." }
      }
    ] as const;

    for (const request of requests) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    }

    await app.close();
  });
});
