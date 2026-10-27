import { describe, expect, it } from "vitest";
import { SecretVault } from "@council/domain";
import { mcpToolRequestFingerprint } from "./store.js";

const request = {
  meetingId: "80000000-0000-4000-8000-000000000001",
  agentId: "50000000-0000-4000-8000-000000000001",
  participantId: "90000000-0000-4000-8000-000000000001",
  roleRevision: 1,
  roleId: "60000000-0000-4000-8000-000000000001",
  roleVersion: 1,
  connectorId: "d0000000-0000-4000-8000-000000000001",
  toolName: "search",
  arguments: { status: "active", limit: 1 }
};

describe("MCP request fingerprint", () => {
  it("uses a keyed production fingerprint while retaining a deterministic legacy candidate", () => {
    const vault = new SecretVault(Buffer.alloc(32, 16));
    const legacy = mcpToolRequestFingerprint(request);
    const keyed = mcpToolRequestFingerprint(request, vault);

    expect(legacy).toMatch(/^[a-f0-9]{64}$/);
    expect(keyed).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/);
    expect(keyed).not.toContain(legacy);
    expect(mcpToolRequestFingerprint(request, vault)).toBe(keyed);
    expect(mcpToolRequestFingerprint({ ...request, arguments: { status: "inactive", limit: 1 } }, vault))
      .not.toBe(keyed);
    expect(mcpToolRequestFingerprint(request, new SecretVault(Buffer.alloc(32, 17)))).not.toBe(keyed);
  });
});
