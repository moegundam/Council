import { describe, expect, it } from "vitest";
import { TaskAgentRunRetryOwnership } from "./task-agent-run-retry-ownership";

describe("Task Agent run retry ownership", () => {
  it("reuses a Task revision key after switching to another Task and back", () => {
    const ownership = new TaskAgentRunRetryOwnership();
    const taskA = ownership.acquire("task-a", 7, () => "key-a");
    const taskB = ownership.acquire("task-b", 3, () => "key-b");

    expect(ownership.acquire("task-a", 7, () => "replacement-a")).toBe(taskA);
    expect(ownership.acquire("task-b", 3, () => "replacement-b")).toBe(taskB);
  });

  it("keeps every unresolved execution revision until its exact owner clears it", () => {
    const ownership = new TaskAgentRunRetryOwnership();
    const revisionOne = ownership.acquire("task-a", 1, () => "key-a-1");
    const revisionTwo = ownership.acquire("task-a", 2, () => "key-a-2");
    const taskB = ownership.acquire("task-b", 1, () => "key-b-1");

    expect(ownership.acquire("task-a", 1, () => "replacement-a-1")).toBe(revisionOne);
    expect(ownership.acquire("task-a", 2, () => "replacement-a-2")).toBe(revisionTwo);
    expect(ownership.acquire("task-b", 1, () => "replacement-b-1")).toBe(taskB);

    ownership.clear(revisionOne);
    const replacement = ownership.acquire("task-a", 1, () => "replacement-a-1");
    expect(replacement.idempotencyKey).toBe("replacement-a-1");
    ownership.clear(revisionOne);
    expect(ownership.acquire("task-a", 1, () => "replacement-a-1-again")).toBe(replacement);
  });

  it("does not evict an unresolved key after more than 32 distinct intents", () => {
    const ownership = new TaskAgentRunRetryOwnership();
    const first = ownership.acquire("task-0", 1, () => "key-0");

    for (let index = 1; index <= 40; index += 1) {
      ownership.acquire(`task-${index}`, 1, () => `key-${index}`);
    }

    expect(ownership.acquire("task-0", 1, () => "replacement-0")).toBe(first);
  });
});
