import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

describe("Prompt revision conflicts", () => {
  it("returns REVISION_CONFLICT for a stale Prompt update", async () => {
    const store = new InMemoryPlatformStore();
    const prompt = await store.createPrompt({
      name: "Prompt CAS",
      kind: "agent",
      description: "Exercise optimistic concurrency.",
      owner: "Test Owner",
      content: "Version one.",
      variables: []
    });
    await store.updatePrompt(prompt.id, { expectedCurrentVersion: 1, content: "Version two." });
    const app = await createApp({ store, authDisabled: true });

    try {
      const response = await app.inject({
        method: "PATCH",
        url: `/api/prompts/${prompt.id}`,
        payload: { expectedCurrentVersion: 1, content: "Stale version three." }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    } finally {
      await app.close();
    }
  });
});
