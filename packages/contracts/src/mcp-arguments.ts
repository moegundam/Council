import { z } from "zod";

const mcpArgumentLimits = {
  maxBytes: 64 * 1_024,
  maxContainerItems: 100,
  maxDepth: 8,
  maxKeyLength: 200,
  maxNodes: 512,
  maxScalars: 256,
  maxStringLength: 20_000
} as const;

const forbiddenMcpArgumentKeys = new Set(["__proto__", "constructor", "prototype"]);

function validateMcpArgumentValue(
  value: unknown,
  context: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
  state: { nodes: number; scalars: number; seen: WeakSet<object> }
): void {
  if (depth > mcpArgumentLimits.maxDepth) {
    context.addIssue({ code: "custom", path, message: `MCP arguments may be at most ${mcpArgumentLimits.maxDepth} levels deep.` });
    return;
  }
  state.nodes += 1;
  if (state.nodes > mcpArgumentLimits.maxNodes) {
    context.addIssue({ code: "custom", path, message: `MCP arguments may contain at most ${mcpArgumentLimits.maxNodes} values and containers.` });
    return;
  }
  if (value === null || typeof value === "boolean") {
    state.scalars += 1;
  } else if (typeof value === "string") {
    state.scalars += 1;
    if (value.length > mcpArgumentLimits.maxStringLength) {
      context.addIssue({ code: "custom", path, message: `MCP argument strings may contain at most ${mcpArgumentLimits.maxStringLength} characters.` });
    }
  } else if (typeof value === "number") {
    state.scalars += 1;
    if (!Number.isFinite(value)) context.addIssue({ code: "custom", path, message: "MCP argument numbers must be finite." });
  } else if (Array.isArray(value)) {
    if (value.length > mcpArgumentLimits.maxContainerItems) {
      context.addIssue({ code: "custom", path, message: `MCP argument arrays may contain at most ${mcpArgumentLimits.maxContainerItems} items.` });
      return;
    }
    if (state.seen.has(value)) {
      context.addIssue({ code: "custom", path, message: "MCP arguments must not contain circular references." });
      return;
    }
    state.seen.add(value);
    value.forEach((item, index) => validateMcpArgumentValue(item, context, [...path, index], depth + 1, state));
  } else if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      context.addIssue({ code: "custom", path, message: "MCP arguments must contain plain JSON objects only." });
      return;
    }
    if (state.seen.has(value)) {
      context.addIssue({ code: "custom", path, message: "MCP arguments must not contain circular references." });
      return;
    }
    state.seen.add(value);
    const entries = Object.entries(value);
    if (entries.length > mcpArgumentLimits.maxContainerItems) {
      context.addIssue({ code: "custom", path, message: `MCP argument objects may contain at most ${mcpArgumentLimits.maxContainerItems} fields.` });
      return;
    }
    for (const [key, nested] of entries) {
      if (!key || key.length > mcpArgumentLimits.maxKeyLength || forbiddenMcpArgumentKeys.has(key.toLowerCase())) {
        context.addIssue({ code: "custom", path: [...path, key], message: "MCP argument field name is invalid or unsafe." });
        continue;
      }
      validateMcpArgumentValue(nested, context, [...path, key], depth + 1, state);
    }
  } else {
    context.addIssue({ code: "custom", path, message: "MCP arguments must contain JSON values only." });
  }
  if (state.scalars > mcpArgumentLimits.maxScalars) {
    context.addIssue({ code: "custom", path, message: `MCP arguments may contain at most ${mcpArgumentLimits.maxScalars} scalar values.` });
  }
}

export const mcpToolArgumentsSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "MCP arguments must be a JSON object."
).superRefine((value, context) => {
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > mcpArgumentLimits.maxBytes) {
      context.addIssue({ code: "custom", message: `MCP arguments may contain at most ${mcpArgumentLimits.maxBytes} UTF-8 bytes.` });
    }
  } catch {
    context.addIssue({ code: "custom", message: "MCP arguments must be serializable JSON." });
  }
  validateMcpArgumentValue(value, context, [], 0, { nodes: 0, scalars: 0, seen: new WeakSet() });
});
