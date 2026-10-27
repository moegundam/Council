import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

const marker = "must-not-cross-the-public-read-boundary";

function drift<T extends object>(value: T): T {
  return { ...value, internalMarker: marker } as T;
}

describe("public management read response contracts", () => {
  it("fails Store-backed registry and Agent reads closed on undeclared fields", async () => {
    const store = new InMemoryPlatformStore();
    const imageDigest = `sha256:${"d".repeat(64)}`;
    const pack = await store.createToolPack({
      name: "Strict read pack",
      version: "1.0.0",
      description: "Exercises strict management read responses.",
      owner: "Platform Owner",
      sourceReference: `registry.example.com/council/strict-read@${imageDigest}`,
      imageDigest,
      tools: [{
        name: "read_docs",
        kind: "command",
        goal: "Read an approved documentation snapshot.",
        access: "read_only",
        argv: { executable: "/usr/bin/rg", fixedArguments: ["--json"] },
        env: { allowedNames: ["LANG"] },
        stdin: { mode: "none" }
      }]
    });
    const packRevision = (await store.getToolPackRevisions(pack.id))[0]!;
    const profile = await store.createRuntimeProfile({
      name: "Strict read runtime",
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    });
    const profileRevision = (await store.getRuntimeProfileRevisions(profile.id))[0]!;
    const snapshot = await store.getSnapshot();
    const agent = snapshot.agents[0]!;
    const readiness = await store.getAgentReadiness(agent.id);
    const agentRevision = (await store.getAgentRevisions(agent.id))[0]!;

    vi.spyOn(store, "getToolPacks").mockResolvedValue([drift(pack)]);
    vi.spyOn(store, "getToolPackRevisions").mockResolvedValue([drift(packRevision)]);
    vi.spyOn(store, "getRuntimeProfileRevisions").mockResolvedValue([drift(profileRevision)]);
    vi.spyOn(store, "getAgentReadiness").mockResolvedValue(drift(readiness));
    vi.spyOn(store, "getAgentRevisions").mockResolvedValue([drift(agentRevision)]);
    vi.spyOn(store, "getRuntimeProfiles").mockResolvedValue([drift(profile)]);
    const app = await createApp({ store, authDisabled: true });

    try {
      const responses = {
        toolPacks: await app.inject({ method: "GET", url: "/api/tool-packs" }),
        toolPackRevisions: await app.inject({ method: "GET", url: `/api/tool-packs/${pack.id}/revisions` }),
        runtimeProfiles: await app.inject({ method: "GET", url: "/api/runtime-profiles" }),
        runtimeProfileRevisions: await app.inject({ method: "GET", url: `/api/runtime-profiles/${profile.id}/revisions` }),
        agentReadiness: await app.inject({ method: "GET", url: `/api/agents/${agent.id}/readiness` }),
        agentRevisions: await app.inject({ method: "GET", url: `/api/agents/${agent.id}/revisions` })
      };

      for (const [name, response] of Object.entries(responses)) {
        expect(response.statusCode, name).toBe(500);
        expect(response.json(), name).toMatchObject({ error: { code: "RESPONSE_CONTRACT_VIOLATION" } });
        expect(response.body, name).not.toContain(marker);
      }
    } finally {
      await app.close();
    }
  });

  it("applies the published schema to the constructed Meeting Preset preflight response", () => {
    const source = readFileSync(new URL("./routes/management-routes.ts", import.meta.url), "utf8");
    const preflight = source.slice(
      source.indexOf('  app.get("/api/meeting-presets/:id/preflight"'),
      source.indexOf("\n  });", source.indexOf('  app.get("/api/meeting-presets/:id/preflight"')) + 6
    );

    expect(preflight).toContain("parseResponse(meetingPresetPreflightSchema,");
  });
});
