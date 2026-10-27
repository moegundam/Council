import { describe, expect, it } from "vitest";
import { externalExecutionRequestSchema } from "./index.js";

function nestedValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("external execution request contracts", () => {
  it("rejects deeply nested input before durable fingerprinting", () => {
    const parsed = externalExecutionRequestSchema.safeParse({
      resourceId: "pipeline-safe-start",
      inputs: { nested: nestedValue(64) }
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts JSON values and rejects non-JSON or unsafe object shapes", () => {
    expect(externalExecutionRequestSchema.safeParse({
      resourceId: "pipeline-safe-start",
      inputs: { text: "safe", count: 1, enabled: true, empty: null, list: ["a", 2] }
    }).success).toBe(true);
    expect(externalExecutionRequestSchema.safeParse({
      resourceId: "pipeline-safe-start",
      inputs: { invalid: Number.POSITIVE_INFINITY }
    }).success).toBe(false);
    expect(externalExecutionRequestSchema.safeParse({
      resourceId: "pipeline-safe-start",
      inputs: { invalid: 1n }
    }).success).toBe(false);
    expect(externalExecutionRequestSchema.safeParse({
      resourceId: "pipeline-safe-start",
      inputs: { invalid: new Date() }
    }).success).toBe(false);
  });
});
