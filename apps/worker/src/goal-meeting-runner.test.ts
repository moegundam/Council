import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { SecretVault } from "@council/domain";
import type { AgentHarness, AgentHarnessTurnInput } from "@council/runtime";
import { runGoalMeetingRound } from "./goal-meeting-runner.js";

describe("Goal Meeting runner", () => {
  it("caps every autonomous Meeting turn at 256 output tokens", async () => {
    const seed = createSeedSnapshot();
    const connectorId = "c0000000-0000-4000-8000-000000000200";
    seed.meetings[0]!.mode = "open";
    seed.modelConnectors.push({
      id: connectorId,
      revision: 1,
      name: "Bounded local model",
      location: "local",
      baseUrl: "http://192.168.50.10:4000/v1",
      model: "bounded-local",
      enabled: true,
      hasSecret: false,
      secretRevision: 0
    });
    for (const agent of seed.agents) agent.modelConnectorId = connectorId;
    const store = new InMemoryPlatformStore(seed);
    const observed: Array<number | undefined> = [];
    const harness: AgentHarness = {
      profile: () => ({ kind: "openai_compatible", version: "test", capabilities: ["text", "abort"] }),
      health: async () => ({ healthy: true }),
      runTurn: async (input: AgentHarnessTurnInput) => {
        observed.push(input.maxTokens);
        return { content: `Bounded formal Meeting turn ${observed.length}.` };
      },
      cancel: async () => ({ accepted: false, reason: "not_active" })
    };

    const result = await runGoalMeetingRound({
      store,
      goalRunId: "d0000000-0000-4000-8000-000000000200",
      meetingId: seed.meetings[0]!.id,
      round: 1,
      secretVault: new SecretVault(Buffer.alloc(32, 8)),
      harnessFor: () => harness
    });

    expect(result.modelCalls).toBe(seed.participants.length);
    expect(observed).toEqual(seed.participants.map(() => 256));
  });
});
