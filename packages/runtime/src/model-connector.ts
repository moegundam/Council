import type { LookupFunction } from "node:net";
import { z } from "zod";
import { Agent, fetch as undiciFetch } from "undici";
import { createConnectorConnectionPolicy, type AddressResolver } from "@council/domain";

export interface ConnectorDispatcher {
  close(): Promise<void>;
}

export type ConnectorDispatcherFactory = (lookup: LookupFunction) => ConnectorDispatcher;
export type ConnectorFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { dispatcher?: ConnectorDispatcher }
) => Promise<Response>;

export interface ConnectorHttpDependencies {
  fetcher?: ConnectorFetch;
  resolver?: AddressResolver;
  createDispatcher?: ConnectorDispatcherFactory;
  allowedHosts?: readonly string[];
}

export interface ConnectorHttpSession {
  fetch: ConnectorFetch;
  close(): Promise<void>;
}

const defaultConnectorFetch = undiciFetch as unknown as ConnectorFetch;
const defaultDispatcherFactory: ConnectorDispatcherFactory = (lookup) => new Agent({ connect: { lookup } });

function toRequestUrl(input: RequestInfo | URL, baseUrl: URL): URL {
  if (typeof input === "string") return new URL(input, baseUrl);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

export async function openConnectorHttpSession(
  baseUrl: string,
  allowPrivate: boolean,
  dependencies: ConnectorHttpDependencies = {}
): Promise<ConnectorHttpSession> {
  const policy = dependencies.allowedHosts === undefined
    ? await createConnectorConnectionPolicy(baseUrl, allowPrivate, dependencies.resolver)
    : await createConnectorConnectionPolicy(baseUrl, allowPrivate, dependencies.resolver, dependencies.allowedHosts);
  const dispatcher = (dependencies.createDispatcher ?? defaultDispatcherFactory)(policy.lookup);
  const fetcher = dependencies.fetcher ?? defaultConnectorFetch;
  let closed = false;

  return {
    fetch: async (input, init) => {
      const requestUrl = toRequestUrl(input, policy.url);
      if (requestUrl.origin !== policy.url.origin) {
        throw new Error("Connector HTTP session cannot request a different origin.");
      }
      return fetcher(input, { ...init, redirect: "error", dispatcher });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await dispatcher.close();
    }
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  messages: ModelMessage[];
  allowPrivate?: boolean;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json_object";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().trim().min(1).max(20_000) }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative()
  }).optional()
});

const defaultModelResponseCapBytes = 256 * 1024;

async function readBoundedResponseText(response: Response, maxBytes = defaultModelResponseCapBytes): Promise<string> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new Error("Model provider response exceeds the size limit.");
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("Model provider response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class OpenAICompatibleConnector {
  constructor(
    private readonly fetcher: ConnectorFetch = defaultConnectorFetch,
    private readonly resolver?: AddressResolver,
    private readonly createDispatcher: ConnectorDispatcherFactory = defaultDispatcherFactory
  ) {}

  async health(baseUrl: string, apiKey?: string, allowPrivate = false): Promise<boolean> {
    const session = await openConnectorHttpSession(baseUrl, allowPrivate, {
      fetcher: this.fetcher,
      ...(this.resolver ? { resolver: this.resolver } : {}),
      createDispatcher: this.createDispatcher
    });
    let response: Response | undefined;
    try {
      response = await session.fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        signal: AbortSignal.timeout(5_000)
      });
      return response.ok;
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      await session.close();
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const session = await openConnectorHttpSession(request.baseUrl, request.allowPrivate ?? false, {
      fetcher: this.fetcher,
      ...(this.resolver ? { resolver: this.resolver } : {}),
      createDispatcher: this.createDispatcher
    });
    let response: Response | undefined;
    try {
      response = await session.fetch(`${request.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens ?? 1_200,
          ...(request.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}),
          stream: false
        }),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs ?? 90_000)])
          : AbortSignal.timeout(request.timeoutMs ?? 90_000)
      });

      if (!response.ok) throw new Error(`Model provider request failed with status ${response.status}.`);
      const bodyText = await readBoundedResponseText(response);
      const parsed = responseSchema.parse(JSON.parse(bodyText));
      const choice = parsed.choices[0]!;
      return {
        content: choice.message.content,
        ...(parsed.usage ? {
          usage: {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            totalTokens: parsed.usage.total_tokens
          }
        } : {})
      };
    } finally {
      await response?.body?.cancel().catch(() => undefined);
      await session.close();
    }
  }
}
