import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentRevisionSchema, type AgentRevision } from "@council/contracts";
import {
  agentRevisionContentDigestIsValid,
  createAgentRevisionContentDigest,
  type AgentRevisionDigestInput
} from "./agent-revision-governance.js";

const agentId = "50000000-0000-4000-8000-000000000001";
const connectorId = "60000000-0000-4000-8000-000000000001";
const promptId = "70000000-0000-4000-8000-000000000001";
const profileId = "76000000-0000-4000-8000-000000000001";

function baseInput(): AgentRevisionDigestInput {
  return {
    agentId,
    revision: 2,
    name: "Architect-R",
    description: "Platform architecture Agent",
    modelConnectorId: connectorId,
    goalSummary: "Review the architecture.",
    toolsSummary: "Read-only platform status.",
    dataSummary: "Meeting evidence.",
    skillIds: [],
    toolGrants: [{ connectorId, toolName: "platform_status" }],
    toolPackGrants: [],
    runtimeProfileBinding: { profileId, revision: 1 },
    promptBinding: { promptId, version: 1 }
  };
}

function legacyPostgresMixedOrderDigest(input: AgentRevisionDigestInput): string {
  const payload = {
    ...input,
    toolGrants: input.toolGrants.map((grant) => ({
      toolName: grant.toolName,
      connectorId: grant.connectorId
    })),
    runtimeProfileBinding: input.runtimeProfileBinding
      ? { revision: input.runtimeProfileBinding.revision, profileId: input.runtimeProfileBinding.profileId }
      : null,
    promptBinding: input.promptBinding
      ? { promptId: input.promptBinding.promptId, version: input.promptBinding.version }
      : null
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

describe("Agent revision digest governance", () => {
  it("accepts a legitimate V2 digest after PostgreSQL jsonb and schema key reordering", () => {
    const input = baseInput();
    const persisted = {
      ...input,
      contentDigest: legacyPostgresMixedOrderDigest(input),
      contentDigestVersion: 2,
      source: "updated",
      restoredFromRevision: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      publishedAt: null
    } satisfies AgentRevision;

    const parsed = agentRevisionSchema.parse(JSON.parse(JSON.stringify(persisted)));

    expect(agentRevisionContentDigestIsValid(parsed)).toBe(true);
  });

  it("creates the same digest for semantically identical nested bindings", () => {
    const schemaOrdered = baseInput();
    const databaseOrdered = {
      ...schemaOrdered,
      toolGrants: schemaOrdered.toolGrants.map((grant) => ({
        toolName: grant.toolName,
        connectorId: grant.connectorId
      })),
      runtimeProfileBinding: { revision: 1, profileId },
      promptBinding: { version: 1, promptId }
    } satisfies AgentRevisionDigestInput;

    expect(createAgentRevisionContentDigest(databaseOrdered))
      .toBe(createAgentRevisionContentDigest(schemaOrdered));
  });
});
