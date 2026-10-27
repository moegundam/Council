import { pathToFileURL } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Request, Response } from "express";
import { z } from "zod";

type ServerOptions = {
  releaseVersion: string;
};

const statusSchema = {
  service: z.literal("agent-meeting-platform"),
  releaseVersion: z.string().min(1),
  access: z.literal("read-only")
};

export function createReadOnlyMcpServer(options: ServerOptions) {
  const server = new McpServer({
    name: "agent-meeting-platform-readonly",
    version: "0.1.0"
  });

  server.registerTool("platform_status", {
    title: "Platform status",
    description: "Returns the deployed platform release and read-only access mode.",
    inputSchema: {},
    outputSchema: statusSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, async () => {
    const status = {
      service: "agent-meeting-platform" as const,
      releaseVersion: options.releaseVersion,
      access: "read-only" as const
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status) }],
      structuredContent: status
    };
  });

  return server;
}

export function createHttpApp(options: ServerOptions) {
  const app = createMcpExpressApp({
    host: "0.0.0.0",
    allowedHosts: ["mcp-readonly", "127.0.0.1", "localhost"]
  });

  app.get("/health", (_request: Request, response: Response) => response.send({ status: "ready" }));
  app.post("/mcp", async (request: Request, response: Response) => {
    const server = createReadOnlyMcpServer(options);
    const transport = new StreamableHTTPServerTransport();
    try {
      // SDK 1.29's Node transport implements Transport at runtime but its optional callbacks
      // are not assignable when exactOptionalPropertyTypes is enabled.
      await server.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) {
        response.status(500).send({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    } finally {
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    }
  });

  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", (_request: Request, response: Response) => response.status(405).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    }));
  }

  return app;
}

function start() {
  const port = Number(process.env.PORT ?? "4100");
  const releaseVersion = process.env.RELEASE_VERSION ?? "development";
  const listener = createHttpApp({ releaseVersion }).listen(port, "0.0.0.0", () => {
    process.stdout.write(`read-only MCP ready on ${port}\n`);
  });
  listener.on("error", () => process.exit(1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
