import { describe, expect, it } from "vitest";
import { createMcpConnectorSchema, updateMcpConnectorSchema } from "./index.js";

const registration = {
  toolName: "search",
  displayName: "文件搜尋",
  kind: "mcp_tool" as const,
  version: "1.0.0",
  owner: "Platform Owner",
  goal: "搜尋已核准的唯讀文件。"
};

describe("MCP Tool Catalog contracts", () => {
  it("keeps approved tools deduplicated and accepts bounded wrapper metadata", () => {
    const parsed = createMcpConnectorSchema.parse({
      name: "Docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search", "search"],
      toolRegistrations: [registration]
    });

    expect(parsed.approvedTools).toEqual(["search"]);
    expect(parsed.toolRegistrations).toEqual([registration]);
    expect(parsed.location).toBe("cloud");
  });

  it("requires an explicit trust location when a Connector is moved to a private network", () => {
    expect(createMcpConnectorSchema.parse({
      name: "Local Docs",
      location: "local",
      baseUrl: "http://mcp-readonly:4100/mcp",
      approvedTools: ["search"]
    })).toMatchObject({ location: "local" });
    expect(updateMcpConnectorSchema.parse({ expectedRevision: 2, location: "cloud" })).toEqual({
      expectedRevision: 2,
      location: "cloud"
    });
  });

  it.each(["mcp_tool", "function_wrapper", "library_wrapper", "program_adapter", "api_wrapper"] as const)(
    "accepts the %s wrapper kind without adding executable configuration",
    (kind) => {
      expect(updateMcpConnectorSchema.parse({
        expectedRevision: 2,
        toolRegistrations: [{ ...registration, kind }]
      }).toolRegistrations?.[0]?.kind).toBe(kind);
    }
  );

  it("rejects duplicate or unapproved registrations", () => {
    expect(() => createMcpConnectorSchema.parse({
      name: "Docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      toolRegistrations: [registration, { ...registration, displayName: "Duplicate" }]
    })).toThrow(/only once|duplicate/i);

    expect(() => createMcpConnectorSchema.parse({
      name: "Docs",
      baseUrl: "https://mcp.example.com/mcp",
      approvedTools: ["search"],
      toolRegistrations: [{ ...registration, toolName: "write" }]
    })).toThrow(/approved|allowlist/i);
  });

  it("rejects direct shell execution and unbounded metadata", () => {
    expect(() => updateMcpConnectorSchema.parse({
      expectedRevision: 2,
      toolRegistrations: [{ ...registration, kind: "shell" }]
    })).toThrow();
    expect(() => updateMcpConnectorSchema.parse({
      expectedRevision: 2,
      toolRegistrations: [{ ...registration, goal: "x".repeat(2_001) }]
    })).toThrow();
  });

  it("requires a positive expected revision and an actual MCP mutation", () => {
    expect(() => updateMcpConnectorSchema.parse({ location: "cloud" })).toThrow();
    expect(() => updateMcpConnectorSchema.parse({ expectedRevision: 1 })).toThrow(/At least one MCP Connector field is required/);
    expect(() => updateMcpConnectorSchema.parse({ expectedRevision: 0, enabled: false })).toThrow();
  });
});
