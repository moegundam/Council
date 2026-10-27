import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerApiObservability, type ApiRequestLog } from "./observability.js";

describe("API observability", () => {
  it("accepts a safe request ID, returns it, and logs only route metadata", async () => {
    const logs: ApiRequestLog[] = [];
    const clock = [100, 112.345];
    const app = Fastify({ logger: false });
    app.post("/api/things/:id", async () => ({ ok: true }));

    registerApiObservability(app, {
      emit: (entry) => logs.push(entry),
      now: () => clock.shift() ?? 112.345,
      timestamp: () => "2026-08-09T00:00:00.000Z"
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/things/private-value?token=query-secret",
      headers: { "x-request-id": "request-123" },
      payload: { token: "body-secret" }
    });

    expect(response.headers["x-request-id"]).toBe("request-123");
    expect(logs).toEqual([{
      timestamp: "2026-08-09T00:00:00.000Z",
      level: "info",
      service: "api",
      event: "http.request.completed",
      outcome: "success",
      requestId: "request-123",
      method: "POST",
      route: "/api/things/:id",
      statusCode: 200,
      durationMs: 12.345
    }]);
    expect(JSON.stringify(logs)).not.toContain("private-value");
    expect(JSON.stringify(logs)).not.toContain("query-secret");
    expect(JSON.stringify(logs)).not.toContain("body-secret");

    await app.close();
  });

  it("replaces an unsafe request ID and labels unmatched routes without echoing the URL", async () => {
    const logs: ApiRequestLog[] = [];
    const app = Fastify({ logger: false });
    registerApiObservability(app, {
      emit: (entry) => logs.push(entry),
      generateRequestId: () => "generated-request-id"
    });

    const response = await app.inject({
      method: "GET",
      url: "/not-found/private-secret",
      headers: { "x-request-id": "unsafe id\nwith newline" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe("generated-request-id");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      requestId: "generated-request-id",
      method: "GET",
      route: "unmatched",
      statusCode: 404,
      level: "warn",
      outcome: "client_error"
    });
    expect(JSON.stringify(logs)).not.toContain("private-secret");

    await app.close();
  });

  it("marks server failures as errors without serializing exception details", async () => {
    const logs: ApiRequestLog[] = [];
    const app = Fastify({ logger: false });
    app.get("/api/failure", async () => {
      throw new Error("credential=secret-value");
    });
    registerApiObservability(app, { emit: (entry) => logs.push(entry) });

    const response = await app.inject({ method: "GET", url: "/api/failure" });

    expect(response.statusCode).toBe(500);
    expect(logs[0]).toMatchObject({ level: "error", outcome: "server_error", statusCode: 500 });
    expect(JSON.stringify(logs)).not.toContain("secret-value");
    await app.close();
  });
});
