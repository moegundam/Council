import type { PlatformSnapshot } from "@council/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import { createApp } from "./app.js";

class CountingTeamPresetAuditStore extends InMemoryPlatformStore {
  readonly createdAuditCount = new Map<string, number>();

  constructor(seed: PlatformSnapshot) {
    super(seed);
  }

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "agent_team.created" || event === "meeting_preset.created") {
      this.createdAuditCount.set(event, (this.createdAuditCount.get(event) ?? 0) + 1);
    }
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

async function readyStore(): Promise<CountingTeamPresetAuditStore> {
  const staging = new InMemoryPlatformStore();
  const seed = await staging.getSnapshot();
  const connectorId = "d0000000-0000-4000-8000-000000000099";
  seed.modelConnectors.push({
    id: connectorId,
    revision: 1,
    name: "Team retry fixture model",
    location: "local",
    baseUrl: "http://192.168.50.10:4000/v1",
    model: "meeting-local",
    enabled: true,
    hasSecret: false,
    secretRevision: 0,
    credentialId: null
  });
  for (const agent of seed.agents) agent.modelConnectorId = connectorId;
  return new CountingTeamPresetAuditStore(seed);
}

describe("Agent Team and Meeting Preset creation idempotency API", () => {
  it("requires caller-owned keys before either create mutation", async () => {
    const store = await readyStore();
    const snapshot = await store.getSnapshot();
    const app = await createApp({ store, authDisabled: true });

    try {
      const team = await app.inject({
        method: "POST",
        url: "/api/agent-teams",
        payload: {
          name: "Missing-key Team",
          description: "Must remain uncommitted.",
          members: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }]
        }
      });
      const preset = await app.inject({
        method: "POST",
        url: "/api/meeting-presets",
        payload: {
          name: "Missing-key Preset",
          description: "Must remain uncommitted.",
          teamId: null,
          mode: "chaired",
          automation: "suggest",
          durationMinutes: 30,
          agendaItems: [{ title: "Review", description: "Review one bounded goal." }]
        }
      });

      expect(team.statusCode).toBe(400);
      expect(team.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect(preset.statusCode).toBe(400);
      expect(preset.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
      expect((await store.getSnapshot()).agentTeams).toEqual([]);
      expect((await store.getSnapshot()).meetingPresets).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("replays one canonical Team and Preset and conflicts on changed payload", async () => {
    const store = await readyStore();
    const snapshot = await store.getSnapshot();
    const app = await createApp({ store, authDisabled: true });
    const teamPayload = {
      name: "Retry-safe Team",
      description: "One Team for one create intent.",
      members: [{ agentId: snapshot.agents[0]!.id, roleId: snapshot.roles[0]!.id, isChair: true }]
    };

    try {
      const teamRequest = {
        method: "POST" as const,
        url: "/api/agent-teams",
        headers: { "idempotency-key": "agent-team-create-retry" },
        payload: teamPayload
      };
      const [firstTeam, concurrentTeam] = await Promise.all([
        app.inject(teamRequest),
        app.inject({ ...teamRequest, payload: structuredClone(teamPayload) })
      ]);
      const laterTeam = await app.inject(teamRequest);
      const changedTeam = await app.inject({
        ...teamRequest,
        payload: { ...teamPayload, description: "Changed Team retry payload." }
      });

      expect(firstTeam.statusCode).toBe(201);
      expect(concurrentTeam.statusCode).toBe(201);
      expect(concurrentTeam.json()).toEqual(firstTeam.json());
      expect(laterTeam.json()).toEqual(firstTeam.json());
      expect(changedTeam.statusCode).toBe(409);
      expect(changedTeam.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });

      const presetPayload = {
        name: "Retry-safe Preset",
        description: "One Preset for one create intent.",
        teamId: firstTeam.json().id as string,
        mode: "chaired" as const,
        automation: "suggest" as const,
        durationMinutes: 30,
        agendaItems: [{ title: "Review", description: "Review one bounded goal." }]
      };
      const presetRequest = {
        method: "POST" as const,
        url: "/api/meeting-presets",
        headers: { "idempotency-key": "meeting-preset-create-retry" },
        payload: presetPayload
      };
      const [firstPreset, concurrentPreset] = await Promise.all([
        app.inject(presetRequest),
        app.inject({ ...presetRequest, payload: structuredClone(presetPayload) })
      ]);
      const laterPreset = await app.inject(presetRequest);
      const changedPreset = await app.inject({
        ...presetRequest,
        payload: { ...presetPayload, durationMinutes: 45 }
      });

      expect(firstPreset.statusCode).toBe(201);
      expect(concurrentPreset.statusCode).toBe(201);
      expect(concurrentPreset.json()).toEqual(firstPreset.json());
      expect(laterPreset.json()).toEqual(firstPreset.json());
      expect(changedPreset.statusCode).toBe(409);
      expect(changedPreset.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
      expect((await store.getSnapshot()).agentTeams?.filter((item) => item.name === teamPayload.name)).toHaveLength(1);
      expect((await store.getSnapshot()).meetingPresets?.filter((item) => item.name === presetPayload.name)).toHaveLength(1);
      expect(store.createdAuditCount.get("agent_team.created")).toBe(1);
      expect(store.createdAuditCount.get("meeting_preset.created")).toBe(1);
    } finally {
      await app.close();
    }
  });
});
