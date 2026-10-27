import { describe, expect, it, vi } from "vitest";
import {
  OMP_RPC_MAX_FRAME_BYTES,
  OmpProviderOutcomeUnknownError,
  OmpPromptAbortedError,
  OmpRpcCommandError,
  OmpRpcHarness,
  OmpRpcProtocolError,
  type OmpRpcWire
} from "./omp-rpc-harness.js";

class FakeWire implements OmpRpcWire {
  readonly writes: string[] = [];

  async writeLine(line: string): Promise<void> {
    this.writes.push(line);
  }

  frame(index: number): Record<string, unknown> {
    return JSON.parse(this.writes[index]!.trim()) as Record<string, unknown>;
  }
}

async function connectedHarness() {
  const wire = new FakeWire();
  const harness = new OmpRpcHarness(wire);
  const ready = harness.ready();
  await harness.ingestLine(JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1_048_576,
    maxReassembledFrameBytes: 67_108_864
  }));
  expect(wire.frame(0)).toEqual({ id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 });
  await harness.ingestLine(JSON.stringify({
    id: "protocol-1",
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 }
  }));
  await ready;
  return { harness, wire };
}

describe("OmpRpcHarness", () => {
  it("ignores UI-only extension requests while protocol negotiation is in progress", async () => {
    const wire = new FakeWire();
    const harness = new OmpRpcHarness(wire);
    const ready = harness.ready();

    await harness.ingestLine(JSON.stringify({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: 1_048_576,
      maxReassembledFrameBytes: 67_108_864
    }));
    await expect(harness.ingestLine(JSON.stringify({
      type: "extension_ui_request",
      id: "widget-1",
      method: "setWidget",
      widgetKey: "autoresearch"
    }))).resolves.toBeUndefined();

    await harness.ingestLine(JSON.stringify({
      id: "protocol-1",
      type: "response",
      command: "negotiate_protocol",
      success: true,
      data: { protocolVersion: 2 }
    }));

    await expect(ready).resolves.toBeUndefined();
  });

  it.each(["host_tool_call", "host_uri_request", "subagent_lifecycle", "subagent_progress", "subagent_event"])(
    "fails closed on disabled first-phase capability %s",
    async (type) => {
      const { harness } = await connectedHarness();
      await expect(harness.ingestLine(JSON.stringify({ type }))).rejects.toBeInstanceOf(OmpRpcProtocolError);
    }
  );

  it("negotiates RPC v2 and correlates out-of-order responses by id", async () => {
    const { harness, wire } = await connectedHarness();
    const state = harness.getState();
    const session = harness.newSession();
    const stateCommand = wire.frame(1);
    const sessionCommand = wire.frame(2);

    await harness.ingestLine(JSON.stringify({
      id: sessionCommand.id,
      type: "response",
      command: "new_session",
      success: true,
      data: { sessionId: "session-2" }
    }));
    await harness.ingestLine(JSON.stringify({
      id: stateCommand.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "session-1", isStreaming: false }
    }));

    await expect(state).resolves.toMatchObject({ sessionId: "session-1" });
    await expect(session).resolves.toMatchObject({ sessionId: "session-2" });
  });

  it("reassembles an uninterrupted v2 chunk sequence with strict lengths", async () => {
    const { harness, wire } = await connectedHarness();
    const pending = harness.getState();
    const command = wire.frame(1);
    const logical = Buffer.from(JSON.stringify({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "chunked-session", payload: "x".repeat(800) }
    }));
    const split = Math.floor(logical.byteLength / 2);

    for (const [index, bytes] of [logical.subarray(0, split), logical.subarray(split)].entries()) {
      await harness.ingestLine(JSON.stringify({
        type: "rpc_chunk",
        chunkId: "rpc-1",
        index,
        count: 2,
        byteLength: logical.byteLength,
        data: bytes.toString("base64")
      }));
    }

    await expect(pending).resolves.toMatchObject({ sessionId: "chunked-session" });
  });

  it("fails closed on interleaved chunks, malformed JSON, and oversized physical frames", async () => {
    const first = await connectedHarness();
    await first.harness.ingestLine(JSON.stringify({
      type: "rpc_chunk",
      chunkId: "rpc-a",
      index: 0,
      count: 2,
      byteLength: 4,
      data: Buffer.from("ab").toString("base64")
    }));
    await expect(first.harness.ingestLine(JSON.stringify({ type: "notice" })))
      .rejects.toBeInstanceOf(OmpRpcProtocolError);

    const second = await connectedHarness();
    await expect(second.harness.ingestLine("{not-json"))
      .rejects.toBeInstanceOf(OmpRpcProtocolError);

    const third = await connectedHarness();
    await expect(third.harness.ingestLine(`{"type":"notice","padding":"${"x".repeat(OMP_RPC_MAX_FRAME_BYTES)}"}`))
      .rejects.toBeInstanceOf(OmpRpcProtocolError);
  });

  it.each(["session_busy", "stale_cursor"])("preserves the %s command error code", async (code) => {
    const { harness, wire } = await connectedHarness();
    const pending = harness.getMessagesPage("cursor", 100);
    const command = wire.frame(1);
    await harness.ingestLine(JSON.stringify({
      id: command.id,
      type: "response",
      command: "get_messages_page",
      success: false,
      error: `Rejected with ${code}`,
      code
    }));
    await expect(pending).rejects.toMatchObject({ code });
    await expect(pending).rejects.toBeInstanceOf(OmpRpcCommandError);
  });

  it("treats prompt acknowledgement separately from terminal agent_end", async () => {
    const { harness, wire } = await connectedHarness();
    let settled = false;
    const pending = harness.prompt("Implement the approved task.").finally(() => { settled = true; });
    const command = wire.frame(1);

    await harness.ingestLine(JSON.stringify({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { agentInvoked: true }
    }));
    await Promise.resolve();
    expect(settled).toBe(false);

    await harness.ingestLine(JSON.stringify({ type: "agent_end", isTerminal: false, messages: [] }));
    await Promise.resolve();
    expect(settled).toBe(false);

    await harness.ingestLine(JSON.stringify({ type: "agent_end", messages: [] }));
    await expect(pending).resolves.toEqual({ completion: "agent" });
  });

  it("completes a local-only prompt without waiting for agent_end", async () => {
    const { harness, wire } = await connectedHarness();
    const pending = harness.prompt("/status");
    const command = wire.frame(1);
    await harness.ingestLine(JSON.stringify({
      id: command.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { agentInvoked: false }
    }));
    await expect(pending).resolves.toEqual({ completion: "local" });
  });

  it("marks an active prompt outcome unknown when the transport closes", async () => {
    const { harness } = await connectedHarness();
    const pending = harness.prompt("Keep working.");
    harness.transportClosed(new Error("container connection lost"));
    await expect(pending).rejects.toBeInstanceOf(OmpProviderOutcomeUnknownError);
  });

  it("clears an active prompt after a host-controlled abort", async () => {
    const { harness, wire } = await connectedHarness();
    const pending = harness.prompt("Keep working.");
    const aborting = harness.abortPrompt();
    const abort = wire.frame(2);
    await harness.ingestLine(JSON.stringify({
      id: abort.id,
      type: "response",
      command: "abort",
      success: true
    }));
    await expect(aborting).resolves.toBeUndefined();
    await expect(pending).rejects.toBeInstanceOf(OmpPromptAbortedError);
    const resumed = harness.prompt("Resume the approved work.");
    harness.transportClosed(new Error("test transport closed"));
    await expect(resumed).rejects.toBeInstanceOf(OmpProviderOutcomeUnknownError);
  });

  it("emits bounded tool lifecycle summaries and never forwards thinking deltas", async () => {
    const { harness } = await connectedHarness();
    const listener = vi.fn();
    harness.subscribe(listener);

    await harness.ingestLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "private chain of thought" }
    }));
    await harness.ingestLine(JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "grep"
    }));
    await harness.ingestLine(JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "grep",
      result: "secret file contents must not be copied"
    }));

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "tool.started", summary: "Tool started.", toolName: "grep" },
      { type: "tool.completed", summary: "Tool completed.", toolName: "grep" }
    ]);
    expect(JSON.stringify(listener.mock.calls)).not.toContain("private chain of thought");
    expect(JSON.stringify(listener.mock.calls)).not.toContain("secret file contents");
  });
});
