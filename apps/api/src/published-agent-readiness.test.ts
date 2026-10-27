import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore, StoreNotFoundError } from "@council/database";
import { getPublishedAgentRuntime } from "./published-agent-readiness.js";

describe("published Agent readiness revision failures", () => {
  it("reports a genuinely missing published revision as blocked readiness", async () => {
    const snapshot = await new InMemoryPlatformStore().getSnapshot();
    const agent = snapshot.agents[0]!;
    const result = await getPublishedAgentRuntime({
      async getAgentRevision() {
        throw new StoreNotFoundError("Published Agent revision is missing.");
      }
    }, snapshot, agent.id);

    expect(result).toMatchObject({
      agent,
      revision: null,
      readiness: {
        status: "blocked",
        checks: [{ code: "lifecycle", status: "blocked", message: "找不到 Agent 已發布版本。" }]
      }
    });
  });

  it("does not disguise a revision-store failure as missing published data", async () => {
    const snapshot = await new InMemoryPlatformStore().getSnapshot();
    const agent = snapshot.agents[0]!;

    await expect(getPublishedAgentRuntime({
      async getAgentRevision() {
        throw new Error("revision database unavailable");
      }
    }, snapshot, agent.id)).rejects.toThrow("revision database unavailable");
  });
});
