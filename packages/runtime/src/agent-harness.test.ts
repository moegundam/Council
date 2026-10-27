import { describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "./model-connector.js";
import { OpenAICompatibleAgentHarness } from "./agent-harness.js";

class FakeConnector {
  readonly complete = vi.fn(async (_request: CompletionRequest): Promise<CompletionResult> => ({
    content: "採用隔離執行環境。",
    usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 }
  }));

  readonly health = vi.fn(async () => true);
}

describe("OpenAI-compatible Agent Harness", () => {
  it("preserves the existing completion request and result contract", async () => {
    const connector = new FakeConnector();
    const harness = new OpenAICompatibleAgentHarness(connector);
    const events: string[] = [];

    const result = await harness.runTurn({
      runId: "run-1",
      scopeId: "meeting:m1:participant:p1",
      model: {
        baseUrl: "http://gb10.internal:4000/v1",
        model: "local-meeting-model",
        apiKey: "short-lived-secret",
        allowPrivate: true
      },
      messages: [
        { role: "system", content: "You are the security reviewer." },
        { role: "user", content: "Review the runtime boundary." }
      ],
      temperature: 0.1,
      maxTokens: 800,
      timeoutMs: 45_000
    }, (event) => { events.push(event.type); });

    expect(result).toEqual({
      content: "採用隔離執行環境。",
      usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 }
    });
    expect(connector.complete).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "http://gb10.internal:4000/v1",
      model: "local-meeting-model",
      apiKey: "short-lived-secret",
      allowPrivate: true,
      temperature: 0.1,
      maxTokens: 800,
      timeoutMs: 45_000
    }));
    expect(events).toEqual(["started", "completed"]);
    expect(JSON.stringify(result)).not.toContain("short-lived-secret");
  });

  it("reports health without retaining the credential", async () => {
    const connector = new FakeConnector();
    const harness = new OpenAICompatibleAgentHarness(connector);

    await expect(harness.health({
      baseUrl: "https://models.example.com/v1",
      apiKey: "ephemeral",
      allowPrivate: false
    })).resolves.toEqual({ healthy: true });
    expect(harness.profile()).toMatchObject({
      kind: "openai_compatible",
      capabilities: expect.arrayContaining(["text", "abort"])
    });
  });

  it("cancels an active turn and refuses duplicate active run ids", async () => {
    const complete = vi.fn((request: CompletionRequest) => new Promise<CompletionResult>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const harness = new OpenAICompatibleAgentHarness({
      health: vi.fn(async () => true),
      complete
    });

    const first = harness.runTurn({
      runId: "run-active",
      scopeId: "task:t1:attempt:1",
      model: { baseUrl: "https://models.example.com/v1", model: "test" },
      messages: [{ role: "user", content: "work" }]
    });
    await expect(harness.runTurn({
      runId: "run-active",
      scopeId: "task:t1:attempt:1",
      model: { baseUrl: "https://models.example.com/v1", model: "test" },
      messages: [{ role: "user", content: "duplicate" }]
    })).rejects.toThrow(/already active/i);

    await expect(harness.cancel("run-active")).resolves.toEqual({ accepted: true });
    await expect(first).rejects.toThrow(/aborted/i);
    await expect(harness.cancel("missing")).resolves.toEqual({ accepted: false, reason: "not_active" });
  });

  it("rejects a cancelled turn even when the provider ignores the abort signal", async () => {
    let resolveCompletion!: (result: CompletionResult) => void;
    const complete = vi.fn(() => new Promise<CompletionResult>((resolve) => {
      resolveCompletion = resolve;
    }));
    const harness = new OpenAICompatibleAgentHarness({
      health: vi.fn(async () => true),
      complete
    });
    const events: Array<{ type: string; code?: string }> = [];

    const run = harness.runTurn({
      runId: "run-provider-ignores-abort",
      scopeId: "task:t1:attempt:2",
      model: { baseUrl: "https://models.example.com/v1", model: "test" },
      messages: [{ role: "user", content: "work" }]
    }, (event) => { events.push(event); });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());

    await expect(harness.cancel("run-provider-ignores-abort")).resolves.toEqual({ accepted: true });
    resolveCompletion({ content: "late provider result" });

    await expect(run).rejects.toThrow(/cancelled/i);
    expect(events).toEqual([
      expect.objectContaining({ type: "started" }),
      expect.objectContaining({ type: "failed", code: "cancelled" })
    ]);
  });

  it("does not accept cancellation after a result enters terminal event delivery", async () => {
    let completedEventEntered!: () => void;
    const completedEventStarted = new Promise<void>((resolve) => {
      completedEventEntered = resolve;
    });
    let releaseCompletedEvent!: () => void;
    const completedEventGate = new Promise<void>((resolve) => {
      releaseCompletedEvent = resolve;
    });
    const harness = new OpenAICompatibleAgentHarness(new FakeConnector());

    const run = harness.runTurn({
      runId: "run-terminal-delivery",
      scopeId: "meeting:m1:participant:p1",
      model: { baseUrl: "https://models.example.com/v1", model: "test" },
      messages: [{ role: "user", content: "work" }]
    }, async (event) => {
      if (event.type !== "completed") return;
      completedEventEntered();
      await completedEventGate;
    });
    await completedEventStarted;

    await expect(harness.cancel("run-terminal-delivery"))
      .resolves.toEqual({ accepted: false, reason: "not_active" });
    releaseCompletedEvent();
    await expect(run).resolves.toMatchObject({ content: "採用隔離執行環境。" });
  });

  it("releases the active run when runtime event delivery fails", async () => {
    const connector = new FakeConnector();
    const harness = new OpenAICompatibleAgentHarness(connector);

    await expect(harness.runTurn({
      runId: "run-event-failure",
      scopeId: "meeting:m1:participant:p1",
      model: { baseUrl: "https://models.example.com/v1", model: "test" },
      messages: [{ role: "user", content: "work" }]
    }, () => { throw new Error("event sink failed"); })).rejects.toThrow(/event sink failed/i);

    expect(connector.complete).not.toHaveBeenCalled();
    await expect(harness.cancel("run-event-failure"))
      .resolves.toEqual({ accepted: false, reason: "not_active" });
  });
});
