import { describe, expect, it } from "vitest";
import { TaskEvidenceRetryOwnership } from "./task-evidence-ui";

describe("Task Evidence retry ownership", () => {
  it("reuses Task A's unresolved key after an A -> B -> A sequence", () => {
    const ownership = new TaskEvidenceRetryOwnership();
    const createdKeys: string[] = [];
    const createKey = (key: string) => () => {
      createdKeys.push(key);
      return key;
    };

    const taskA = ownership.acquire("task-a", '{"type":"note","label":"A","reference":"first"}', createKey("key-a"));
    const taskB = ownership.acquire("task-b", '{"type":"note","label":"B","reference":"second"}', createKey("key-b"));
    const taskARetry = ownership.acquire("task-a", '{"type":"note","label":"A","reference":"first"}', createKey("replacement-key"));

    expect(taskARetry).toBe(taskA);
    expect(taskARetry.idempotencyKey).toBe("key-a");
    expect(taskB.idempotencyKey).toBe("key-b");
    expect(createdKeys).toEqual(["key-a", "key-b"]);
  });

  it("clears only the exact confirmed request", () => {
    const ownership = new TaskEvidenceRetryOwnership();
    const first = ownership.acquire("task-a", "first", () => "key-first");
    const second = ownership.acquire("task-a", "second", () => "key-second");

    ownership.clear(first);

    expect(ownership.acquire("task-a", "first", () => "key-first-retry").idempotencyKey).toBe("key-first-retry");
    expect(ownership.acquire("task-a", "second", () => "key-second-retry")).toBe(second);
  });
});
