const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const OMP_RPC_RUNTIME_VERSION = "omp-rpc-v2@18.1.2";
export const OMP_RPC_MAX_FRAME_BYTES = 1_048_576;
export const OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES = 67_108_864;

type JsonObject = Record<string, unknown>;

export interface OmpRpcWire {
  writeLine(line: string): Promise<void>;
}

export interface OmpRpcEvent {
  type:
    | "agent.started"
    | "agent.completed"
    | "tool.started"
    | "tool.progress"
    | "tool.completed"
    | "compaction.started"
    | "compaction.completed"
    | "runtime.error";
  summary: string;
  toolName: string | null;
}

export type OmpRpcEventListener = (event: OmpRpcEvent) => void | Promise<void>;

export interface OmpPromptOutcome {
  completion: "agent" | "local";
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingRequest {
  command: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface ActivePrompt {
  id: string;
  completion: Deferred<OmpPromptOutcome>;
}

interface ChunkAssembly {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

export class OmpRpcProtocolError extends Error {
  readonly code = "omp_rpc_protocol_error";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OmpRpcProtocolError";
  }
}

export class OmpRpcCommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = "OmpRpcCommandError";
  }
}

export class OmpProviderOutcomeUnknownError extends Error {
  readonly code = "provider_outcome_unknown";

  constructor(message = "The OMP transport closed while an agent turn was active.", options?: ErrorOptions) {
    super(message, options);
    this.name = "OmpProviderOutcomeUnknownError";
  }
}

export class OmpPromptAbortedError extends Error {
  readonly code = "prompt_aborted";

  constructor(message = "The active OMP prompt was aborted by its host.") {
    super(message);
    this.name = "OmpPromptAbortedError";
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new OmpRpcProtocolError(`OMP RPC ${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OmpRpcProtocolError(`OMP RPC ${field} must be a non-negative integer.`);
  }
  return value;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OmpRpcProtocolError(`OMP RPC ${field} must be a non-empty string.`);
  }
  return value;
}

function decodeBase64(value: unknown): Buffer {
  const encoded = stringField(value, "rpc_chunk.data");
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new OmpRpcProtocolError("OMP RPC chunk data is not canonical base64.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    throw new OmpRpcProtocolError("OMP RPC chunk data failed canonical base64 validation.");
  }
  return decoded;
}

function toolName(frame: JsonObject): string | null {
  if (typeof frame.toolName === "string" && frame.toolName.length > 0) return frame.toolName.slice(0, 200);
  if (isObject(frame.tool) && typeof frame.tool.name === "string" && frame.tool.name.length > 0) {
    return frame.tool.name.slice(0, 200);
  }
  return null;
}

export class OmpRpcHarness {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Set<OmpRpcEventListener>();
  private readonly readyState = deferred<void>();
  private requestSequence = 0;
  private maxFrameBytes = OMP_RPC_MAX_FRAME_BYTES;
  private maxReassembledFrameBytes = OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES;
  private negotiated = false;
  private sawReady = false;
  private fatalError: Error | null = null;
  private chunks: ChunkAssembly | null = null;
  private activePrompt: ActivePrompt | null = null;

  constructor(private readonly wire: OmpRpcWire) {}

  profile() {
    return {
      kind: "pi" as const,
      version: OMP_RPC_RUNTIME_VERSION,
      capabilities: ["text", "abort", "file_read", "file_write", "process"] as const
    };
  }

  ready(): Promise<void> {
    return this.readyState.promise;
  }

  subscribe(listener: OmpRpcEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async ingestLine(rawLine: string | Uint8Array): Promise<void> {
    this.assertUsable();
    const bytes = typeof rawLine === "string" ? Buffer.from(rawLine, "utf8") : Buffer.from(rawLine);
    if (bytes.byteLength > this.maxFrameBytes) {
      return this.failProtocol(`OMP RPC physical frame exceeds ${this.maxFrameBytes} bytes.`);
    }

    let decoded: string;
    try {
      decoded = textDecoder.decode(bytes);
    } catch (error) {
      return this.failProtocol("OMP RPC physical frame is not valid UTF-8.", error);
    }

    let frame: unknown;
    try {
      frame = JSON.parse(decoded.trim());
    } catch (error) {
      return this.failProtocol("OMP RPC emitted malformed JSON.", error);
    }
    if (!isObject(frame)) return this.failProtocol("OMP RPC frames must be JSON objects.");

    if (frame.type === "rpc_chunk") {
      const reassembled = this.acceptChunk(frame);
      if (reassembled) await this.processFrame(reassembled);
      return;
    }
    if (this.chunks) return this.failProtocol("OMP RPC chunk sequences must be uninterrupted.");
    await this.processFrame(frame);
  }

  transportClosed(cause?: Error): void {
    if (this.fatalError) return;
    const protocolError = new OmpRpcProtocolError("OMP RPC transport closed.", cause ? { cause } : undefined);
    this.fatalError = protocolError;
    this.readyState.reject(protocolError);
    for (const pending of this.pending.values()) pending.reject(protocolError);
    this.pending.clear();
    if (this.activePrompt) {
      this.activePrompt.completion.reject(new OmpProviderOutcomeUnknownError(undefined, cause ? { cause } : undefined));
      this.activePrompt = null;
    }
  }

  async getState(): Promise<JsonObject> {
    return this.objectResult(await this.command("get_state"), "get_state");
  }

  async newSession(parentSession?: string): Promise<JsonObject> {
    return this.objectResult(await this.command("new_session", parentSession ? { parentSession } : {}), "new_session");
  }

  async switchSession(sessionPath: string): Promise<JsonObject> {
    return this.objectResult(await this.command("switch_session", { sessionPath }), "switch_session");
  }

  async getMessagesPage(cursor?: string, limit = 100): Promise<JsonObject> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("OMP message page limit must be between 1 and 256.");
    }
    return this.objectResult(await this.command("get_messages_page", {
      ...(cursor ? { cursor } : {}),
      limit
    }), "get_messages_page");
  }

  async steer(message: string): Promise<void> {
    await this.command("steer", { message: this.requiredMessage(message) });
  }

  async followUp(message: string): Promise<void> {
    await this.command("follow_up", { message: this.requiredMessage(message) });
  }

  async abort(): Promise<void> {
    await this.command("abort");
  }

  async abortPrompt(): Promise<void> {
    await this.command("abort");
    if (this.activePrompt) {
      const active = this.activePrompt;
      this.activePrompt = null;
      active.completion.reject(new OmpPromptAbortedError());
    }
  }

  prompt(message: string): Promise<OmpPromptOutcome> {
    this.assertReady();
    if (this.activePrompt) throw new Error("OMP RPC already has an active prompt.");
    const request = this.startRequest("prompt", { message: this.requiredMessage(message) });
    const completion = deferred<OmpPromptOutcome>();
    const active: ActivePrompt = { id: request.id, completion };
    this.activePrompt = active;
    void request.promise.then((data) => {
      if (isObject(data) && data.agentInvoked === false) completion.resolve({ completion: "local" });
    }).catch((error) => completion.reject(error));
    return completion.promise.finally(() => {
      if (this.activePrompt === active) this.activePrompt = null;
    });
  }

  private requiredMessage(message: string): string {
    const normalized = message.trim();
    if (!normalized) throw new TypeError("OMP RPC messages must not be empty.");
    return normalized;
  }

  private objectResult(value: unknown, command: string): JsonObject {
    if (!isObject(value)) throw new OmpRpcProtocolError(`OMP RPC ${command} returned a non-object payload.`);
    return value;
  }

  private async command(command: string, payload: JsonObject = {}): Promise<unknown> {
    this.assertReady();
    return this.startRequest(command, payload).promise;
  }

  private startRequest(command: string, payload: JsonObject = {}, id?: string): { id: string; promise: Promise<unknown> } {
    this.assertUsable();
    const requestId = id ?? `council-${++this.requestSequence}`;
    if (this.pending.has(requestId)) throw new OmpRpcProtocolError(`Duplicate OMP RPC request id ${requestId}.`);
    const result = deferred<unknown>();
    this.pending.set(requestId, { command, resolve: result.resolve, reject: result.reject });
    void this.writeFrame({ id: requestId, type: command, ...payload }).catch((error) => {
      if (this.pending.delete(requestId)) result.reject(error);
    });
    return { id: requestId, promise: result.promise };
  }

  private async writeFrame(frame: JsonObject): Promise<void> {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.maxFrameBytes) {
      throw new OmpRpcProtocolError(`OMP RPC command exceeds ${this.maxFrameBytes} bytes.`);
    }
    await this.wire.writeLine(line);
  }

  private acceptChunk(frame: JsonObject): JsonObject | null {
    if (!this.negotiated) throw new OmpRpcProtocolError("OMP RPC chunks are forbidden before protocol v2 negotiation.");
    const chunkId = stringField(frame.chunkId, "rpc_chunk.chunkId");
    const index = nonNegativeInteger(frame.index, "rpc_chunk.index");
    const count = positiveInteger(frame.count, "rpc_chunk.count");
    const byteLength = positiveInteger(frame.byteLength, "rpc_chunk.byteLength");
    if (count > this.maxReassembledFrameBytes || byteLength > this.maxReassembledFrameBytes) {
      throw new OmpRpcProtocolError("OMP RPC chunk sequence exceeds the reassembly limit.");
    }
    const decoded = decodeBase64(frame.data);

    if (!this.chunks) {
      if (index !== 0) throw new OmpRpcProtocolError("OMP RPC chunk sequence must begin at index 0.");
      this.chunks = { chunkId, count, byteLength, nextIndex: 0, chunks: [], receivedBytes: 0 };
    }
    const assembly = this.chunks;
    if (assembly.chunkId !== chunkId || assembly.count !== count || assembly.byteLength !== byteLength) {
      throw new OmpRpcProtocolError("OMP RPC chunk sequences may not be interleaved or mutated.");
    }
    if (index !== assembly.nextIndex || index >= count) {
      throw new OmpRpcProtocolError("OMP RPC chunk sequence index is invalid.");
    }
    assembly.chunks.push(decoded);
    assembly.receivedBytes += decoded.byteLength;
    assembly.nextIndex += 1;
    if (assembly.receivedBytes > byteLength || assembly.receivedBytes > this.maxReassembledFrameBytes) {
      throw new OmpRpcProtocolError("OMP RPC chunk sequence exceeded its declared byte length.");
    }
    if (assembly.nextIndex !== count) return null;
    this.chunks = null;
    if (assembly.receivedBytes !== byteLength) {
      throw new OmpRpcProtocolError("OMP RPC chunk sequence byte length does not match its declaration.");
    }

    let logicalText: string;
    try {
      logicalText = textDecoder.decode(Buffer.concat(assembly.chunks, assembly.receivedBytes));
    } catch (error) {
      throw new OmpRpcProtocolError("OMP RPC logical frame is not valid UTF-8.", { cause: error });
    }
    let logicalFrame: unknown;
    try {
      logicalFrame = JSON.parse(logicalText);
    } catch (error) {
      throw new OmpRpcProtocolError("OMP RPC logical frame is malformed JSON.", { cause: error });
    }
    if (!isObject(logicalFrame)) throw new OmpRpcProtocolError("OMP RPC logical frames must be JSON objects.");
    return logicalFrame;
  }

  private async processFrame(frame: JsonObject): Promise<void> {
    const type = typeof frame.type === "string" ? frame.type : null;
    if (!type) return this.failProtocol("OMP RPC frame type is missing.");
    if (type === "ready") return this.processReady(frame);
    if (type === "response") return this.processResponse(frame);
    if (type === "prompt_result") {
      if (this.activePrompt && frame.id === this.activePrompt.id && frame.agentInvoked === false) {
        this.activePrompt.completion.resolve({ completion: "local" });
      }
      return;
    }
    if (type === "extension_ui_request") return;
    if (["host_tool_call", "host_uri_request", "subagent_lifecycle", "subagent_progress", "subagent_event"].includes(type)) {
      return this.failProtocol(`OMP RPC emitted disabled first-phase capability ${type}.`);
    }
    if (type === "message_update" || type === "message_start" || type === "message_end" || type === "command_output") {
      return;
    }
    if (type === "agent_start") {
      await this.emit({ type: "agent.started", summary: "Agent execution started.", toolName: null });
      return;
    }
    if (type === "agent_end") {
      await this.emit({ type: "agent.completed", summary: "Agent execution completed.", toolName: null });
      if (frame.isTerminal !== false && this.activePrompt) this.activePrompt.completion.resolve({ completion: "agent" });
      return;
    }
    if (type === "tool_execution_start") {
      await this.emit({ type: "tool.started", summary: "Tool started.", toolName: toolName(frame) });
      return;
    }
    if (type === "tool_execution_update") {
      await this.emit({ type: "tool.progress", summary: "Tool progress updated.", toolName: toolName(frame) });
      return;
    }
    if (type === "tool_execution_end") {
      await this.emit({ type: "tool.completed", summary: "Tool completed.", toolName: toolName(frame) });
      return;
    }
    if (type === "auto_compaction_start") {
      await this.emit({ type: "compaction.started", summary: "Session compaction started.", toolName: null });
      return;
    }
    if (type === "auto_compaction_end") {
      await this.emit({ type: "compaction.completed", summary: "Session compaction completed.", toolName: null });
      return;
    }
    if (type === "extension_error") {
      await this.emit({ type: "runtime.error", summary: "OMP extension reported an error.", toolName: null });
    }
  }

  private processReady(frame: JsonObject): void {
    if (this.sawReady) return this.failProtocol("OMP RPC emitted more than one ready frame.");
    this.sawReady = true;
    if (frame.protocolVersion !== 1 || !Array.isArray(frame.supportedProtocolVersions)
      || !frame.supportedProtocolVersions.includes(2)) {
      return this.failProtocol("OMP RPC v2 is required but was not advertised.");
    }
    const advertisedFrameBytes = positiveInteger(frame.maxFrameBytes, "ready.maxFrameBytes");
    const advertisedLogicalBytes = positiveInteger(frame.maxReassembledFrameBytes, "ready.maxReassembledFrameBytes");
    this.maxFrameBytes = Math.min(advertisedFrameBytes, OMP_RPC_MAX_FRAME_BYTES);
    this.maxReassembledFrameBytes = Math.min(advertisedLogicalBytes, OMP_RPC_MAX_REASSEMBLED_FRAME_BYTES);
    const negotiation = this.startRequest("negotiate_protocol", { protocolVersion: 2 }, "protocol-1");
    void negotiation.promise.then((data) => {
      if (isObject(data) && data.protocolVersion !== undefined && data.protocolVersion !== 2) {
        throw new OmpRpcProtocolError("OMP RPC negotiated an unexpected protocol version.");
      }
      this.negotiated = true;
      this.readyState.resolve();
    }).catch((error) => {
      this.readyState.reject(error);
      if (error instanceof Error) this.fatalError = error;
    });
  }

  private processResponse(frame: JsonObject): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    const command = typeof frame.command === "string" ? frame.command : "unknown";
    const success = frame.success;
    if (typeof success !== "boolean") return this.failProtocol("OMP RPC response success flag is invalid.");
    if (!id) return;
    const pending = this.pending.get(id);
    if (pending) {
      if (pending.command !== command) return this.failProtocol("OMP RPC response command does not match its request id.");
      this.pending.delete(id);
      if (success) pending.resolve(frame.data);
      else pending.reject(new OmpRpcCommandError(
        command,
        typeof frame.code === "string" ? frame.code : null,
        typeof frame.error === "string" ? frame.error : `OMP RPC ${command} failed.`
      ));
      return;
    }
    if (!success && this.activePrompt?.id === id) {
      this.activePrompt.completion.reject(new OmpRpcCommandError(
        command,
        typeof frame.code === "string" ? frame.code : null,
        typeof frame.error === "string" ? frame.error : `OMP RPC ${command} failed after acknowledgement.`
      ));
    }
  }

  private async emit(event: OmpRpcEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }

  private assertReady(): void {
    this.assertUsable();
    if (!this.negotiated) throw new OmpRpcProtocolError("OMP RPC v2 negotiation is not complete.");
  }

  private assertUsable(): void {
    if (this.fatalError) throw this.fatalError;
  }

  private failProtocol(message: string, cause?: unknown): never {
    const error = new OmpRpcProtocolError(message, cause === undefined ? undefined : { cause });
    this.fatalError = error;
    this.readyState.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.activePrompt) {
      this.activePrompt.completion.reject(new OmpProviderOutcomeUnknownError(undefined, { cause: error }));
      this.activePrompt = null;
    }
    throw error;
  }
}
