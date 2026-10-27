import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHarnessEvent } from "./agent-harness.js";
import {
  CodexCliAgentHarness,
  type CodexCliChildProcess,
  type CodexCliHarnessConfig,
  type CodexCliProcessRunner
} from "./codex-cli-harness.js";

class FakeChildProcess extends EventEmitter implements CodexCliChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  pid = 4242;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.stdin.end();
    this.emit("close", code, signal);
  }
}

class FakeProcessRunner implements CodexCliProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  readonly queue: FakeChildProcess[] = [];

  spawn(command: string, args: string[], options: Parameters<CodexCliProcessRunner["spawn"]>[2]): FakeChildProcess {
    const child = this.queue.shift();
    if (!child) throw new Error("No queued fake child process.");
    this.calls.push({ command, args, options: options as unknown as Record<string, unknown> });
    return child;
  }
}

function createHarness(
  runner: FakeProcessRunner,
  overrides: Partial<CodexCliHarnessConfig> = {}
): CodexCliAgentHarness {
  return new CodexCliAgentHarness({
    enabled: true,
    workingDirectory: "/tmp/codex-scope",
    environment: { PATH: "/usr/bin" },
    promptCharLimit: 200,
    outputCharLimit: 50,
    terminateGraceMs: 25,
    ...overrides
  }, runner);
}

async function collectStdin(child: FakeChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk) => { buffer += chunk; });
    child.stdin.once("end", () => resolve(buffer));
    child.stdin.once("error", reject);
  });
}

describe("Codex CLI Agent Harness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports disabled health without spawning", async () => {
    const runner = new FakeProcessRunner();
    const harness = new CodexCliAgentHarness({
      workingDirectory: "/tmp/codex-scope",
      environment: {}
    }, runner);

    await expect(harness.health({
      baseUrl: "https://ignored.example.com/v1",
      apiKey: "ignored"
    })).resolves.toEqual({ healthy: false, detail: "Codex CLI harness is disabled." });
    expect(runner.calls).toHaveLength(0);
    expect(harness.profile()).toEqual({
      kind: "codex",
      version: "1",
      capabilities: ["text", "abort", "file_read", "process"]
    });
  });

  it("escalates a timed-out health check to SIGKILL before reporting unhealthy", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner, {
      healthTimeoutMs: 10,
      terminateGraceMs: 25
    });

    const health = harness.health({
      baseUrl: "https://ignored.example.com/v1",
      apiKey: "ignored"
    });
    let healthSettled = false;
    void health.then(() => { healthSettled = true; });

    await vi.advanceTimersByTimeAsync(10);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(healthSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(24);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(healthSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(health).resolves.toEqual({
      healthy: false,
      detail: "Codex CLI health check exceeded 10ms."
    });
  });

  it("spawns codex exec with the exact safe argv and sends the prompt only via stdin", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner);
    const promptText = collectStdin(child);

    const turn = harness.runTurn({
      runId: "run-safe-argv",
      scopeId: "task:t1:attempt:1",
      model: {
        baseUrl: "https://models.example.com/v1",
        model: "gpt-5-codex",
        apiKey: "top-secret",
        allowPrivate: true
      },
      messages: [
        { role: "system", content: "You are the security reviewer." },
        { role: "user", content: "Inspect the runtime boundary." },
        { role: "assistant", content: "I will inspect it." }
      ],
      temperature: 0.1,
      maxTokens: 700
    });

    child.stdout.write(
      '{"type":"thread.started","thread_id":"thread-1"}\n'
      + '{"type":"turn.started"}\n'
      + '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n'
      + '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}\n'
    );
    child.stderr.write("WARN ignored stderr noise\n");
    child.close(0);

    await expect(turn).resolves.toEqual({
      content: "OK",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 }
    });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toEqual({
      command: "codex",
      args: [
        "exec",
        "--json",
        "--ephemeral",
        "--sandbox", "read-only",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--color", "never",
        "--model", "gpt-5-codex",
        "--cd", "/tmp/codex-scope",
        "-"
      ],
      options: {
        cwd: "/tmp/codex-scope",
        env: { PATH: "/usr/bin" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      }
    });
    expect(runner.calls[0]!.args).not.toContain("Inspect the runtime boundary.");
    expect(runner.calls[0]!.args).not.toContain("top-secret");
    expect(runner.calls[0]!.args).not.toContain("https://models.example.com/v1");
    expect(runner.calls[0]!.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(runner.calls[0]!.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(runner.calls[0]!.args).not.toContain("--add-dir");
    expect(runner.calls[0]!.args).not.toContain("workspace-write");

    await expect(promptText).resolves.toContain("USER 2:\nInspect the runtime boundary.");
    await expect(promptText).resolves.not.toContain("top-secret");
  });

  it("fails closed when a successful process omits turn.completed", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner);

    const turn = harness.runTurn({
      runId: "run-missing-completion-marker",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }]
    });

    child.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n');
    child.close(0);

    await expect(turn).rejects.toThrow(/turn\.completed/i);
  });

  it("captures a child exit while started-event delivery is pending", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner);
    let startedEventEntered!: () => void;
    const startedEventStarted = new Promise<void>((resolve) => {
      startedEventEntered = resolve;
    });
    let releaseStartedEvent!: () => void;
    const startedEventGate = new Promise<void>((resolve) => {
      releaseStartedEvent = resolve;
    });
    const events: AgentHarnessEvent["type"][] = [];

    const turn = harness.runTurn({
      runId: "run-exit-during-started-event",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }],
      timeoutMs: 10
    }, async (event) => {
      events.push(event.type);
      if (event.type !== "started") return;
      startedEventEntered();
      await startedEventGate;
    });
    await startedEventStarted;

    child.emit("close", 2, null);
    releaseStartedEvent();
    const outcome = turn.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error })
    );
    await vi.advanceTimersByTimeAsync(10);

    const settled = await outcome;
    expect(settled.result).toBeNull();
    expect(settled.error).toBeInstanceOf(Error);
    expect((settled.error as Error).message).toMatch(/exit code 2/i);
    expect(events).toEqual(["started", "failed"]);
    await expect(harness.cancel("run-exit-during-started-event"))
      .resolves.toEqual({ accepted: false, reason: "not_active" });
  });

  it("rejects oversized prompts before spawning", async () => {
    const runner = new FakeProcessRunner();
    const harness = createHarness(runner, { promptCharLimit: 20 });

    await expect(harness.runTurn({
      runId: "run-oversized-prompt",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "This prompt is definitely too large." }]
    })).rejects.toThrow(/prompt exceeded 20 characters/i);
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects malformed JSONL output and releases the active run", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner);

    const turn = harness.runTurn({
      runId: "run-malformed",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }]
    });

    child.stdout.write("not-json\n");
    child.close(1);

    await expect(turn).rejects.toThrow(/malformed jsonl/i);
    await expect(harness.cancel("run-malformed")).resolves.toEqual({ accepted: false, reason: "not_active" });
  });

  it("rejects oversized output and does not leak raw event logs", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner, { outputCharLimit: 5 });

    const turn = harness.runTurn({
      runId: "run-oversized-output",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }]
    });

    child.stdout.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"toolong"}}\n');
    child.close(0);

    await expect(turn).rejects.toThrow(/output exceeded 5 characters/i);
  });

  it("keeps a timed-out run owned until SIGKILL escalation when SIGTERM is ignored", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner, { terminateGraceMs: 25 });

    const turn = harness.runTurn({
      runId: "run-timeout-escalation",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }],
      timeoutMs: 10
    });
    let turnSettled = false;
    void turn.then(
      () => { turnSettled = true; },
      () => { turnSettled = true; }
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(turnSettled).toBe(false);
    await expect(harness.runTurn({
      runId: "run-timeout-escalation",
      scopeId: "task:t1:attempt:2",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "retry" }]
    })).rejects.toThrow(/already active/i);

    await vi.advanceTimersByTimeAsync(24);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    expect(turnSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(turn).rejects.toThrow(/run exceeded 10ms/i);
    await expect(harness.cancel("run-timeout-escalation"))
      .resolves.toEqual({ accepted: false, reason: "not_active" });
  });

  it("rejects duplicate run ids, cancels active runs, and escalates from SIGTERM to SIGKILL", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner, { terminateGraceMs: 25 });

    const events: AgentHarnessEvent["type"][] = [];
    const turn = harness.runTurn({
      runId: "run-cancel",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }]
    }, async (event) => {
      events.push(event.type);
    });

    await expect(harness.runTurn({
      runId: "run-cancel",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "duplicate" }]
    })).rejects.toThrow(/already active/i);

    await expect(harness.cancel("run-cancel")).resolves.toEqual({ accepted: true });
    expect(child.killSignals).toEqual(["SIGTERM"]);

    await vi.advanceTimersByTimeAsync(25);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

    child.close(143, "SIGTERM");
    await expect(turn).rejects.toThrow(/cancelled/i);
    expect(events).toEqual(["started", "failed"]);
    await expect(harness.cancel("run-cancel")).resolves.toEqual({ accepted: false, reason: "not_active" });
  });

  it("keeps terminal event delivery owned and no longer cancellable", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner);
    let startedEventEntered!: () => void;
    const startedEvent = new Promise<void>((resolve) => {
      startedEventEntered = resolve;
    });
    let completedEventEntered!: () => void;
    const completedEventStarted = new Promise<void>((resolve) => {
      completedEventEntered = resolve;
    });
    let releaseCompletedEvent!: () => void;
    const completedEventGate = new Promise<void>((resolve) => {
      releaseCompletedEvent = resolve;
    });

    const turn = harness.runTurn({
      runId: "run-terminal-delivery",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }]
    }, async (event) => {
      if (event.type === "started") {
        startedEventEntered();
        return;
      }
      if (event.type !== "completed") return;
      completedEventEntered();
      await completedEventGate;
    });

    await startedEvent;
    await vi.advanceTimersByTimeAsync(0);

    child.stdout.write(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\n'
      + '{"type":"turn.completed","usage":{"input_tokens":11,"output_tokens":7}}\n'
    );
    child.close(0);
    await completedEventStarted;

    await expect(harness.runTurn({
      runId: "run-terminal-delivery",
      scopeId: "task:t1:duplicate",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "duplicate" }]
    })).rejects.toThrow(/already active/i);
    await expect(harness.cancel("run-terminal-delivery"))
      .resolves.toEqual({ accepted: false, reason: "not_active" });
    releaseCompletedEvent();
    await expect(turn).resolves.toMatchObject({ content: "OK" });
  });

  it("escalates and cleans up when event delivery fails after spawn", async () => {
    const runner = new FakeProcessRunner();
    const child = new FakeChildProcess();
    runner.queue.push(child);
    const harness = createHarness(runner, { terminateGraceMs: 25 });

    const turn = harness.runTurn({
      runId: "run-event-failure",
      scopeId: "task:t1",
      model: { baseUrl: "https://ignored.example.com/v1", model: "gpt-5-codex" },
      messages: [{ role: "user", content: "work" }]
    }, async () => {
      throw new Error("event sink failed");
    });
    const rejection = expect(turn).rejects.toThrow(/event sink failed/i);

    await vi.advanceTimersByTimeAsync(0);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(24);
    expect(child.killSignals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    await rejection;
    await expect(harness.cancel("run-event-failure"))
      .resolves.toEqual({ accepted: false, reason: "not_active" });
  });
});
