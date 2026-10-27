import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryPlatformStore } from "@council/database";
import { createSeedSnapshot } from "@council/database/seed";
import { createApp } from "./app.js";

describe("Chair Role suggestion API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function fixture() {
    const seed = createSeedSnapshot();
    const store = new InMemoryPlatformStore(seed);
    const meeting = seed.meetings[0]!;
    const participant = seed.participants.find((item) => !item.isChair)!;
    const targetRole = seed.roles.find((role) => role.templateKey === "meeting_chair")!;
    const source = await store.addUtterance(meeting.id, {
      speakerType: "agent",
      speakerName: "Architect-R",
      roleName: participant.roleSnapshot.name,
      agentId: participant.agentId,
      content: "請重新聚焦議程。",
      kind: "inference",
      evidenceCount: 0
    });
    const suggestion = (await store.createChairSuggestion(meeting.id, source.id, {
      reason: "off_topic",
      suggestedMode: "chaired",
      explanation: "建議由會議主席角色重新聚焦。",
      score: 0.91,
      suggestedParticipantId: participant.id,
      suggestedParticipantAgentId: participant.agentId,
      suggestedParticipantAgentName: "Architect-R",
      suggestedParticipantRoleRevision: participant.roleRevision,
      suggestedRoleId: targetRole.id,
      suggestedRoleName: targetRole.name,
      suggestedRoleVersion: targetRole.version
    })).suggestion;
    return { store, meeting, participant, targetRole, suggestion };
  }

  it("rejects a mismatched Meeting path before mutating the recommendation", async () => {
    const value = await fixture();
    app = await createApp({ store: value.store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/00000000-0000-4000-8000-000000000099/chair-suggestions/${value.suggestion.id}/role`,
      payload: { expectedRoleRevision: value.participant.roleRevision }
    });

    expect(response.statusCode).toBe(404);
    expect((await value.store.getSnapshot()).participants.find((item) => item.id === value.participant.id))
      .toMatchObject({ roleId: value.participant.roleId, roleRevision: value.participant.roleRevision });
  });

  it("lets the Owner accept the bound Role and resolves the suggestion", async () => {
    const value = await fixture();
    app = await createApp({ store: value.store, authDisabled: true });

    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${value.meeting.id}/chair-suggestions/${value.suggestion.id}/role`,
      payload: { expectedRoleRevision: value.participant.roleRevision }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      participant: { id: value.participant.id, roleId: value.targetRole.id, roleRevision: value.participant.roleRevision + 1 },
      suggestion: { id: value.suggestion.id, status: "resolved", resolution: "completed" }
    });
  });
});
