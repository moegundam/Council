import { z } from "zod";

const externalExecutionInputLimits = {
  maxBytes: 1024 * 1024,
  maxContainerItems: 10_000,
  maxDepth: 32,
  maxKeyLength: 200,
  maxNodes: 10_000
} as const;

const forbiddenInputKeys = new Set(["__proto__", "constructor", "prototype"]);

interface ValidationFrame {
  value: unknown;
  path: Array<string | number>;
  depth: number;
  exiting?: boolean;
}

function addIssue(context: z.RefinementCtx, path: Array<string | number>, message: string): void {
  context.addIssue({ code: "custom", path, message });
}

function validateExternalExecutionInputs(value: Record<string, unknown>, context: z.RefinementCtx): void {
  const activeContainers = new WeakSet<object>();
  const stack: ValidationFrame[] = [{ value, path: [], depth: -1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exiting) {
      activeContainers.delete(frame.value as object);
      continue;
    }
    if (frame.depth > externalExecutionInputLimits.maxDepth) {
      addIssue(context, frame.path, `External execution inputs may be at most ${externalExecutionInputLimits.maxDepth} levels deep.`);
      continue;
    }
    nodes += 1;
    if (nodes > externalExecutionInputLimits.maxNodes) {
      addIssue(context, frame.path, `External execution inputs may contain at most ${externalExecutionInputLimits.maxNodes} values and containers.`);
      break;
    }

    const { value: current } = frame;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) addIssue(context, frame.path, "External execution input numbers must be finite.");
      continue;
    }
    if (typeof current !== "object") {
      addIssue(context, frame.path, "External execution inputs must contain JSON values only.");
      continue;
    }

    if (activeContainers.has(current)) {
      addIssue(context, frame.path, "External execution inputs must not contain circular references.");
      continue;
    }
    if (!Array.isArray(current)) {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        addIssue(context, frame.path, "External execution inputs must contain plain JSON objects only.");
        continue;
      }
    }

    const entries: Array<[string | number, unknown]> = Array.isArray(current)
      ? current.map((entry, index) => [index, entry])
      : Object.entries(current);
    if (entries.length > externalExecutionInputLimits.maxContainerItems) {
      addIssue(context, frame.path, `External execution input containers may contain at most ${externalExecutionInputLimits.maxContainerItems} items.`);
      continue;
    }
    activeContainers.add(current);
    stack.push({ ...frame, exiting: true });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, nested] = entries[index]!;
      if (typeof key === "string"
        && (!key.trim() || key.length > externalExecutionInputLimits.maxKeyLength || forbiddenInputKeys.has(key.toLowerCase()))) {
        addIssue(context, [...frame.path, key], "External execution input field name is invalid or unsafe.");
        continue;
      }
      stack.push({ value: nested, path: [...frame.path, key], depth: frame.depth + 1 });
    }
  }

  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > externalExecutionInputLimits.maxBytes) {
      addIssue(context, [], `External execution inputs may contain at most ${externalExecutionInputLimits.maxBytes} UTF-8 bytes.`);
    }
  } catch {
    addIssue(context, [], "External execution inputs must be serializable JSON.");
  }
}

export const externalExecutionInputsSchema = z.record(
  z.string().trim().min(1).max(externalExecutionInputLimits.maxKeyLength),
  z.unknown()
).superRefine(validateExternalExecutionInputs);
