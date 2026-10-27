import { describe, expect, it } from "vitest";
import { authorizeRoleMcpAccess, ToolPolicy } from "./tool-policy.js";

describe("read-only MCP tool policy", () => {
  const policy = new ToolPolicy([
    { connectorId: "docs", toolName: "search", effect: "read" }
  ]);

  it("allows an explicitly granted read operation", () => {
    expect(policy.authorize("docs", "search")).toEqual({ allowed: true });
  });

  it("denies write and unknown operations", () => {
    expect(policy.authorize("docs", "update").allowed).toBe(false);
    expect(policy.authorize("github", "search").allowed).toBe(false);
  });

  it("allows MCP only when both Role tool and data policies permit external reads", () => {
    expect(authorizeRoleMcpAccess({
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "agent_declared_scope"
    })).toEqual({ allowed: true });
    expect(authorizeRoleMcpAccess({
      toolPolicy: "none",
      dataPolicy: "agent_declared_scope"
    })).toMatchObject({ allowed: false });
    expect(authorizeRoleMcpAccess({
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "meeting_only"
    })).toMatchObject({ allowed: false });
  });
});
