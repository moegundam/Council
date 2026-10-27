import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createReadOnlyMcpServer } from "./server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("read-only MCP server", () => {
  it("publishes one explicitly read-only status tool", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createReadOnlyMcpServer({ releaseVersion: "test-release" });
    const client = new Client({ name: "mcp-readonly-test", version: "0.1.0" });
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const discovered = await client.listTools();
    expect(discovered.tools).toHaveLength(1);
    expect(discovered.tools[0]).toMatchObject({
      name: "platform_status",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    });

    const result = await client.callTool({ name: "platform_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      service: "agent-meeting-platform",
      releaseVersion: "test-release",
      access: "read-only"
    });
  });
});
