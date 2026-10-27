import { describe, expect, it } from "vitest";
import type { PlatformSnapshot } from "@council/contracts";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

type CreateFixture = {
  url: string;
  payload: Record<string, unknown>;
  missingKeyPayload: Record<string, unknown>;
  conflictingPayload: Record<string, unknown>;
  count: (snapshot: PlatformSnapshot) => number;
};

type CreateCase = {
  name: string;
  setup: (store: InMemoryPlatformStore) => Promise<CreateFixture>;
};

const createCases: CreateCase[] = [
  {
    name: "Group",
    setup: async () => ({
      url: "/api/groups",
      payload: { name: "Idempotent Group" },
      missingKeyPayload: { name: "Missing-key Group" },
      conflictingPayload: { name: "Conflicting Group" },
      count: (snapshot) => snapshot.groups.length
    })
  },
  {
    name: "Category",
    setup: async (store) => {
      const group = await store.createGroup({ name: "Idempotent Category Group" });
      return {
        url: "/api/categories",
        payload: { groupId: group.id, name: "Idempotent Category" },
        missingKeyPayload: { groupId: group.id, name: "Missing-key Category" },
        conflictingPayload: { groupId: group.id, name: "Conflicting Category" },
        count: (snapshot) => snapshot.categories.length
      };
    }
  },
  {
    name: "Thread",
    setup: async (store) => {
      const group = await store.createGroup({ name: "Idempotent Thread Group" });
      const category = await store.createCategory({ groupId: group.id, name: "Idempotent Thread Category" });
      return {
        url: "/api/threads",
        payload: { categoryId: category.id, title: "Idempotent Thread", summary: "Stable intent", tagIds: [] },
        missingKeyPayload: { categoryId: category.id, title: "Missing-key Thread", summary: "Must not persist", tagIds: [] },
        conflictingPayload: { categoryId: category.id, title: "Conflicting Thread", summary: "Different intent", tagIds: [] },
        count: (snapshot) => snapshot.threads.length
      };
    }
  },
  {
    name: "Decision",
    setup: async (store) => {
      const meeting = (await store.getSnapshot()).meetings[0]!;
      return {
        url: "/api/decisions",
        payload: { meetingId: meeting.id, title: "Idempotent Decision", description: "Stable intent" },
        missingKeyPayload: { meetingId: meeting.id, title: "Missing-key Decision", description: "Must not persist" },
        conflictingPayload: { meetingId: meeting.id, title: "Conflicting Decision", description: "Different intent" },
        count: (snapshot) => snapshot.decisions.length
      };
    }
  },
  {
    name: "Task",
    setup: async (store) => {
      const meeting = (await store.getSnapshot()).meetings[0]!;
      const missingKeyDecision = await store.createDecision({
        meetingId: meeting.id,
        title: "Missing-key Task Decision",
        description: "Separate prerequisite for the rejected request."
      });
      await store.setDecisionStatus(missingKeyDecision.id, "approved");
      const decision = await store.createDecision({
        meetingId: meeting.id,
        title: "Idempotent Task Decision",
        description: "Approved prerequisite for replay."
      });
      await store.setDecisionStatus(decision.id, "approved");
      return {
        url: "/api/tasks",
        payload: { decisionId: decision.id, title: "Idempotent Task", description: "Stable intent" },
        missingKeyPayload: { decisionId: missingKeyDecision.id, title: "Missing-key Task", description: "Must not persist" },
        conflictingPayload: { decisionId: decision.id, title: "Conflicting Task", description: "Different intent" },
        count: (snapshot) => snapshot.tasks.length
      };
    }
  }
];

describe("caller-owned idempotency for core creates", () => {
  it.each(createCases)("requires a key and exactly replays $name creation", async ({ name, setup }) => {
    const store = new InMemoryPlatformStore();
    const fixture = await setup(store);
    const app = await createApp({ store, authDisabled: true });
    const before = fixture.count(await store.getSnapshot());
    const key = `core-create-${name.toLowerCase()}`;

    try {
      const missing = await app.inject({
        method: "POST",
        url: fixture.url,
        payload: fixture.missingKeyPayload
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(fixture.count(await store.getSnapshot())).toBe(before);

      const first = await app.inject({
        method: "POST",
        url: fixture.url,
        headers: { "idempotency-key": key },
        payload: fixture.payload
      });
      const replay = await app.inject({
        method: "POST",
        url: fixture.url,
        headers: { "idempotency-key": key },
        payload: fixture.payload
      });

      expect(first.statusCode).toBe(201);
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toEqual(first.json());
      expect(fixture.count(await store.getSnapshot())).toBe(before + 1);

      const conflict = await app.inject({
        method: "POST",
        url: fixture.url,
        headers: { "idempotency-key": key },
        payload: fixture.conflictingPayload
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect(fixture.count(await store.getSnapshot())).toBe(before + 1);
    } finally {
      await app.close();
    }
  });
});
