import { describe, expect, it } from "vitest";
import { runMcpToolSchema } from "./index.js";

const request = (argumentsValue: Record<string, unknown>) => ({
  agentId: "50000000-0000-4000-8000-000000000001",
  connectorId: "d0000000-0000-4000-8000-000000000001",
  toolName: "search",
  arguments: argumentsValue
});

describe("MCP tool argument contract", () => {
  it("accepts bounded JSON and rejects oversized containers, scalar sets, and strings", () => {
    expect(runMcpToolSchema.parse(request({
      query: "bounded",
      filters: { tags: ["one", "two"], archived: false },
      limit: 20,
      cursor: null
    })).arguments).toEqual({
      query: "bounded",
      filters: { tags: ["one", "two"], archived: false },
      limit: 20,
      cursor: null
    });

    expect(runMcpToolSchema.safeParse(request(Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`field_${index}`, index])
    ))).success).toBe(false);
    expect(runMcpToolSchema.safeParse(request({
      first: Array.from({ length: 100 }, (_, index) => index),
      second: Array.from({ length: 100 }, (_, index) => index),
      third: Array.from({ length: 57 }, (_, index) => index)
    })).success).toBe(false);
    expect(runMcpToolSchema.safeParse(request({ text: "x".repeat(20_001) })).success).toBe(false);
  });

  it("rejects values beyond the redactor depth and non-JSON or dangerous object shapes", () => {
    let nested: unknown = "secret-at-depth-nine";
    for (let index = 0; index < 9; index += 1) nested = { nested };
    expect(runMcpToolSchema.safeParse(request({ nested })).success).toBe(false);
    expect(runMcpToolSchema.safeParse(request({ invalid: Number.POSITIVE_INFINITY })).success).toBe(false);
    expect(runMcpToolSchema.safeParse(request(JSON.parse('{"__proto__":{"polluted":true}}'))).success).toBe(false);
    expect(runMcpToolSchema.safeParse({ ...request({}), unexpected: true }).success).toBe(false);
  });
});
