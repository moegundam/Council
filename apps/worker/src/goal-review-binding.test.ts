import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GoalReviewJobData } from "@council/contracts";
import { createSeedSnapshot } from "@council/database/seed";
import {
  assertCurrentGoalReviewBinding,
  createGoalReviewBinding,
  goalReviewAdmissionFingerprint,
  goalReviewJobIdDigest,
  legacyGoalReviewAdmissionFingerprint,
  recoverLegacyGoalReviewJobData
} from "./goal-review-binding.js";

function reviewJob(): { data: GoalReviewJobData; snapshot: ReturnType<typeof createSeedSnapshot> } {
  const snapshot = createSeedSnapshot();
  const reviewer = snapshot.participants.find((participant) => (
    participant.roleSnapshot.orchestrationFunctions.includes("reviewer")
  ))!;
  const connector = {
    id: randomUUID(),
    revision: 1,
    name: "Local Reviewer",
    location: "local" as const,
    baseUrl: "http://127.0.0.1:4000/v1",
    model: "reviewer-local",
    enabled: true,
    hasSecret: false,
    secretRevision: 0,
    credentialId: null
  };
  snapshot.modelConnectors.push(connector);
  const binding = createGoalReviewBinding(snapshot, connector.id, reviewer);
  return {
    snapshot,
    data: {
      goalRunId: randomUUID(),
      scope: "task",
      scopeId: randomUUID(),
      reviewerAgentId: reviewer.agentId,
      reviewerAgentRevision: reviewer.agentRevision ?? 1,
      modelConnectorId: connector.id,
      ...binding,
      contractDigest: "a".repeat(64),
      requestedBy: "system"
    }
  };
}

describe("Goal Reviewer immutable runtime binding", () => {
  it("creates a constant-size digest fingerprint while the exact binding remains current", () => {
    const { data, snapshot } = reviewJob();
    const fingerprint = goalReviewAdmissionFingerprint(data);

    expect(fingerprint).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(Buffer.byteLength(fingerprint)).toBe(67);
    expect(goalReviewJobIdDigest(data)).toMatch(/^[a-f0-9]{16}$/);
    expect(assertCurrentGoalReviewBinding(data, snapshot)).toEqual(data.modelConnectorBinding);
  });

  it.each(["endpoint", "model", "revision"] as const)("rejects recovery after Connector %s drift", (drift) => {
    const { data, snapshot } = reviewJob();
    const connector = snapshot.modelConnectors.find((candidate) => candidate.id === data.modelConnectorId)!;
    if (drift === "endpoint") connector.baseUrl = `${connector.baseUrl}/changed`;
    if (drift === "model") connector.model = `${connector.model}-changed`;
    if (drift === "revision") connector.revision += 1;

    expect(() => assertCurrentGoalReviewBinding(data, snapshot)).toThrow(/changed|binding/i);
  });

  it("rejects queued Reviewer authority after its participant switches to a non-Reviewer Role", () => {
    const { data, snapshot } = reviewJob();
    const participant = snapshot.participants.find((candidate) => candidate.agentId === data.reviewerAgentId)!;
    const replacement = snapshot.roles.find((role) => !role.orchestrationFunctions?.includes("reviewer"))!;
    participant.roleId = replacement.id;
    participant.roleRevision += 1;
    participant.roleSnapshot = {
      ...participant.roleSnapshot,
      roleId: replacement.id,
      orchestrationFunctions: [...(replacement.orchestrationFunctions ?? [])]
    };

    expect(() => assertCurrentGoalReviewBinding(data, snapshot)).toThrow(/Reviewer Role|authorization|binding/i);
  });

  it("rejects queued Reviewer authority after its Agent is disabled", () => {
    const { data, snapshot } = reviewJob();
    const agent = snapshot.agents.find((candidate) => candidate.id === data.reviewerAgentId)!;
    agent.lifecycleStatus = "disabled";

    expect(() => assertCurrentGoalReviewBinding(data, snapshot)).toThrow(/Reviewer Agent|authorization|binding/i);
  });

  it("pins cloud Credential identity, provider, location, and secret revision", () => {
    const { data, snapshot } = reviewJob();
    const connector = snapshot.modelConnectors.find((candidate) => candidate.id === data.modelConnectorId)!;
    const credentialId = randomUUID();
    snapshot.credentials = [{
      id: credentialId,
      name: "Queued Reviewer",
      provider: "openai",
      kind: "api_key",
      location: "cloud",
      status: "active",
      expiresAt: null,
      hasSecret: true,
      secretRevision: 7,
      maskedHint: "****test",
      lastUsedAt: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      rotatedAt: null
    }];
    Object.assign(connector, {
      revision: connector.revision + 1,
      location: "cloud",
      credentialId,
      hasSecret: true,
      secretRevision: 7
    });
    const participant = snapshot.participants.find((candidate) => candidate.id === data.reviewerParticipantId)!;
    const cloudBinding = createGoalReviewBinding(snapshot, connector.id, participant);
    const cloudData: GoalReviewJobData = { ...data, modelConnectorId: connector.id, ...cloudBinding };
    const fingerprint = goalReviewAdmissionFingerprint(cloudData);

    expect(cloudData.credentialBinding).toEqual({
      credentialId,
      secretRevision: 7,
      provider: "openai",
      location: "cloud"
    });
    snapshot.credentials![0]!.provider = "different-provider";
    expect(fingerprint).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(() => assertCurrentGoalReviewBinding(cloudData, snapshot)).toThrow(/changed|binding/i);
  });

  it("keeps a valid long Connector configuration inside the fixed-size admission limit", () => {
    const { data } = reviewJob();
    data.modelConnectorBinding.baseUrl = `https://reviewer.example/${"a".repeat(1_500)}`;
    data.modelConnectorBinding.model = `reviewer-${"m".repeat(400)}`;

    expect(goalReviewAdmissionFingerprint(data)).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(Buffer.byteLength(goalReviewAdmissionFingerprint(data))).toBe(67);
  });

  it("parses only the exact bounded v1 legacy Reviewer identity", () => {
    const { data } = reviewJob();
    const legacy = {
      goalRunId: data.goalRunId,
      scope: data.scope,
      scopeId: data.scopeId,
      reviewerAgentId: data.reviewerAgentId,
      reviewerAgentRevision: data.reviewerAgentRevision,
      modelConnectorId: data.modelConnectorId,
      contractDigest: data.contractDigest,
      requestedBy: "system" as const
    };
    const fingerprint = legacyGoalReviewAdmissionFingerprint(legacy);

    expect(recoverLegacyGoalReviewJobData(fingerprint, data.goalRunId)).toEqual(legacy);
    expect(() => recoverLegacyGoalReviewJobData(`${fingerprint}:extra`, data.goalRunId)).toThrow(/invalid/i);
  });
});
