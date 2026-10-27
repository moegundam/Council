import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleConnector } from "./model-connector.js";

interface TrackedStream {
  stream: ReadableStream<Uint8Array>;
  pulledChunks: number;
  pulledBytes: number;
  canceled: boolean;
}

function createTrackedStream(chunks: string[]): TrackedStream {
  const tracker: TrackedStream = {
    stream: new ReadableStream<Uint8Array>(),
    pulledChunks: 0,
    pulledBytes: 0,
    canceled: false
  };
  const encoder = new TextEncoder();
  tracker.stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
        return;
      }
      tracker.pulledChunks += 1;
      const bytes = encoder.encode(chunk);
      tracker.pulledBytes += bytes.byteLength;
      controller.enqueue(bytes);
    },
    cancel() {
      tracker.canceled = true;
    }
  });
  return tracker;
}

describe("OpenAI-compatible model connector", () => {
  it("returns assistant content without exposing the API key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "同意採用唯讀 MCP 白名單。" } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = new OpenAICompatibleConnector(fetcher, async () => ["93.184.216.34"]);

    const result = await connector.complete({
      baseUrl: "https://models.example.com/v1",
      model: "meeting-model",
      apiKey: "secret-key",
      messages: [{ role: "user", content: "請提出安全建議" }]
    });

    expect(result.content).toContain("唯讀 MCP");
    expect(result.usage?.totalTokens).toBe(20);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("同意採用");
  });

  it("requests provider JSON mode only when the governed caller explicitly selects it", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "{\"verdict\":\"pass\"}" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connector = new OpenAICompatibleConnector(fetcher, async () => ["93.184.216.34"]);

    await connector.complete({
      baseUrl: "https://models.example.com/v1",
      model: "reviewer-model",
      messages: [{ role: "user", content: "Return one JSON object." }],
      responseFormat: "json_object"
    });

    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("classifies provider failures without returning response bodies", async () => {
    const connector = new OpenAICompatibleConnector(async () => new Response("upstream-secret", { status: 503 }), async () => ["93.184.216.34"]);
    await expect(connector.complete({
      baseUrl: "https://models.example.com/v1",
      model: "meeting-model",
      messages: [{ role: "user", content: "hello" }]
    })).rejects.toThrow(/503/);
  });

  it("rejects empty or oversized model output", async () => {
    for (const content of ["", "x".repeat(20_001)]) {
      const connector = new OpenAICompatibleConnector(
        async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
        async () => ["93.184.216.34"]
      );
      await expect(connector.complete({
        baseUrl: "https://models.example.com/v1",
        model: "meeting-model",
        messages: [{ role: "user", content: "hello" }]
      })).rejects.toThrow();
    }
  });

  it("pins the approved lookup, disables redirects, and closes the dispatcher", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("redirect blocked");
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:9000/models" }
      });
    });
    const close = vi.fn(async () => undefined);
    const dispatcher = { close };
    const createDispatcher = vi.fn(() => dispatcher);
    const connector = new OpenAICompatibleConnector(
      fetcher,
      async () => ["93.184.216.34"],
      createDispatcher
    );

    await expect(connector.health("https://models.example.com/v1")).rejects.toThrow(/redirect/i);

    const requestInit = fetcher.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
    expect(requestInit.redirect).toBe("error");
    expect(requestInit.dispatcher).toBe(dispatcher);
    expect(createDispatcher).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects responses exceeding the adapter envelope cap via Content-Length", async () => {
    const streamTracker = createTrackedStream(["{" + "x".repeat(65_537) + "}"]);
    const fetcher = vi.fn(async () => new Response(streamTracker.stream, {
      status: 200,
      headers: { "content-length": String(256 * 1024 + 1), "content-type": "application/json" }
    }));
    const connector = new OpenAICompatibleConnector(fetcher, async () => ["93.184.216.34"]);

    await expect(connector.complete({
      baseUrl: "https://models.example.com/v1",
      model: "meeting-model",
      messages: [{ role: "user", content: "hello" }]
    })).rejects.toThrow(/response exceeds the size limit/i);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(streamTracker.canceled).toBe(true);
  });

  it("rejects chunked responses that exceed the envelope cap and cancels mid-stream", async () => {
    const payloadChunk = "x".repeat(80_000);
    const streamTracker = createTrackedStream([
      payloadChunk,
      payloadChunk,
      payloadChunk,
      payloadChunk,
      payloadChunk,
      payloadChunk,
      payloadChunk,
      payloadChunk
    ]);
    const connector = new OpenAICompatibleConnector(async () => new Response(streamTracker.stream, {
      status: 200,
      headers: { "content-type": "application/json" }
    }), async () => ["93.184.216.34"]);

    await expect(connector.complete({
      baseUrl: "https://models.example.com/v1",
      model: "meeting-model",
      messages: [{ role: "user", content: "hello" }]
    })).rejects.toThrow();

    expect(streamTracker.canceled).toBe(true);
    expect(streamTracker.pulledChunks).toBeGreaterThan(1);
    expect(streamTracker.pulledChunks).toBeLessThan(8);
    expect(streamTracker.pulledBytes).toBeGreaterThan(256 * 1024);
  });
});
