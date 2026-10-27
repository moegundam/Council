import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type {
  AgentHarness,
  AgentHarnessCancelResult,
  AgentHarnessEvent,
  AgentHarnessEventSink,
  AgentHarnessHealth,
  AgentHarnessHealthTarget,
  AgentHarnessProfile,
  AgentHarnessTurnInput
} from "./agent-harness.js";
import type { CompletionResult, ModelMessage } from "./model-connector.js";

const DEFAULT_COMMAND = "codex";
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT_CHAR_LIMIT = 40_000;
const DEFAULT_OUTPUT_CHAR_LIMIT = 20_000;
const DEFAULT_TERMINATE_GRACE_MS = 250;
const DEFAULT_RUN_TIMEOUT_MS = 90_000;

const jsonEventSchema = z.object({
  type: z.string().trim().min(1)
}).passthrough();

const agentMessageItemSchema = z.object({
  id: z.string().trim().min(1).optional(),
  type: z.literal("agent_message"),
  text: z.string()
}).passthrough();

const errorItemSchema = z.object({
  id: z.string().trim().min(1).optional(),
  type: z.literal("error"),
  message: z.string().trim().min(1)
}).passthrough();

const turnUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative().optional(),
  reasoning_output_tokens: z.number().int().nonnegative().optional()
}).passthrough();

interface CodexCliProcessTermination {
  closed: boolean;
  terminationPromise?: Promise<void>;
  resolveTermination?: () => void;
  killHandle?: ReturnType<typeof setTimeout>;
}

interface CodexCliActiveRun extends CodexCliProcessTermination {
  process: CodexCliChildProcess;
  phase: "active" | "cancelling" | "settling";
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export interface CodexCliHarnessConfig {
  enabled?: boolean;
  command?: string;
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  healthTimeoutMs?: number;
  promptCharLimit?: number;
  outputCharLimit?: number;
  terminateGraceMs?: number;
}

export interface CodexCliProcessRunner {
  spawn(command: string, args: string[], options: SpawnOptions): CodexCliChildProcess;
}

export interface CodexCliChildProcess {
  readonly stdin: ChildProcessWithoutNullStreams["stdin"];
  readonly stdout: ChildProcessWithoutNullStreams["stdout"];
  readonly stderr: ChildProcessWithoutNullStreams["stderr"];
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: string | symbol, listener: (...args: unknown[]) => void): this;
  once(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

const defaultProcessRunner: CodexCliProcessRunner = {
  spawn(command, args, options) {
    return spawn(command, args, options) as unknown as CodexCliChildProcess;
  }
};

function now(): string {
  return new Date().toISOString();
}

function parsePositiveBound(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error(`Codex CLI harness ${label} must be a positive integer.`);
  }
  return resolved;
}

function trimDetail(detail: string, limit = 200): string {
  const normalized = detail.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function composePrompt(messages: ModelMessage[], limit: number): string {
  if (messages.length === 0) {
    throw new Error("Codex CLI harness requires at least one prompt message.");
  }

  const prompt = messages.map((message, index) => {
    const content = message.content.trim();
    if (content.length === 0) {
      throw new Error(`Codex CLI harness does not accept empty ${message.role} messages.`);
    }
    return `${message.role.toUpperCase()} ${index + 1}:\n${content}`;
  }).join("\n\n");

  if (prompt.length > limit) {
    throw new Error(`Codex CLI prompt exceeded ${limit} characters.`);
  }

  return `${prompt}\n`;
}

function usageFromEvent(rawUsage: unknown): CompletionResult["usage"] | undefined {
  if (rawUsage === undefined) return undefined;
  const usage = turnUsageSchema.parse(rawUsage);
  const completionTokens = usage.output_tokens + (usage.reasoning_output_tokens ?? 0);
  return {
    promptTokens: usage.input_tokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? usage.input_tokens + completionTokens
  };
}

function closeStdin(process: CodexCliChildProcess): void {
  try {
    process.stdin.end();
  } catch {
    // Best effort; the process may already be gone.
  }
}

function terminateProcess(process: CodexCliChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(signal);
  } catch {
    // Best effort; ChildProcess.kill can throw if the process already exited.
  }
}

function observeProcessClose(
  process: CodexCliChildProcess,
  termination: CodexCliProcessTermination,
  onClose?: () => void
): void {
  process.once("close", () => {
    termination.closed = true;
    if (termination.killHandle) {
      clearTimeout(termination.killHandle);
      delete termination.killHandle;
    }
    termination.resolveTermination?.();
    onClose?.();
  });
}

function terminateProcessBounded(
  process: CodexCliChildProcess,
  termination: CodexCliProcessTermination,
  terminateGraceMs: number
): Promise<void> {
  if (termination.terminationPromise) return termination.terminationPromise;

  termination.terminationPromise = new Promise((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      delete termination.resolveTermination;
      resolve();
    };
    termination.resolveTermination = finish;

    if (termination.closed) {
      finish();
      return;
    }

    closeStdin(process);
    terminateProcess(process, "SIGTERM");
    if (termination.closed) {
      finish();
      return;
    }

    termination.killHandle = setTimeout(() => {
      delete termination.killHandle;
      terminateProcess(process, "SIGKILL");
      finish();
    }, terminateGraceMs);
  });

  return termination.terminationPromise;
}

function closeCodeLabel(code: number | null, signal: NodeJS.Signals | null): string {
  if (typeof code === "number") return `exit code ${code}`;
  if (signal) return `signal ${signal}`;
  return "unknown termination";
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function asSignal(value: unknown): NodeJS.Signals | null {
  return typeof value === "string" ? value as NodeJS.Signals : null;
}

export class CodexCliAgentHarness implements AgentHarness {
  private readonly activeRuns = new Map<string, CodexCliActiveRun>();
  private readonly enabled: boolean;
  private readonly command: string;
  private readonly healthTimeoutMs: number;
  private readonly promptCharLimit: number;
  private readonly outputCharLimit: number;
  private readonly terminateGraceMs: number;

  constructor(
    private readonly config: CodexCliHarnessConfig,
    private readonly processRunner: CodexCliProcessRunner = defaultProcessRunner
  ) {
    if (!isAbsolute(config.workingDirectory)) {
      throw new Error("Codex CLI harness workingDirectory must be an absolute path.");
    }
    this.enabled = config.enabled ?? false;
    this.command = config.command?.trim() || DEFAULT_COMMAND;
    this.healthTimeoutMs = parsePositiveBound(config.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, "healthTimeoutMs");
    this.promptCharLimit = parsePositiveBound(config.promptCharLimit, DEFAULT_PROMPT_CHAR_LIMIT, "promptCharLimit");
    this.outputCharLimit = parsePositiveBound(config.outputCharLimit, DEFAULT_OUTPUT_CHAR_LIMIT, "outputCharLimit");
    this.terminateGraceMs = parsePositiveBound(config.terminateGraceMs, DEFAULT_TERMINATE_GRACE_MS, "terminateGraceMs");
  }

  profile(): AgentHarnessProfile {
    return {
      kind: "codex",
      version: "1",
      capabilities: ["text", "abort", "file_read", "process"]
    };
  }

  async health(_target: AgentHarnessHealthTarget): Promise<AgentHarnessHealth> {
    if (!this.enabled) {
      return { healthy: false, detail: "Codex CLI harness is disabled." };
    }

    try {
      await this.spawnAndWait(["exec", "--help"], this.healthTimeoutMs);
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        detail: trimDetail(error instanceof Error ? error.message : "Codex CLI health check failed.")
      };
    }
  }

  async runTurn(input: AgentHarnessTurnInput, events?: AgentHarnessEventSink): Promise<CompletionResult> {
    if (!this.enabled) {
      throw new Error("Codex CLI harness is disabled.");
    }
    if (this.activeRuns.has(input.runId)) {
      throw new Error(`Runtime run ${input.runId} is already active.`);
    }

    const prompt = composePrompt(input.messages, this.promptCharLimit);
    const args = this.buildArgs(input.model.model);
    let process: CodexCliChildProcess;
    try {
      process = this.processRunner.spawn(this.command, args, {
        cwd: this.config.workingDirectory,
        env: { ...this.config.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw new Error(`Codex CLI spawn failed: ${error instanceof Error ? error.message : "unknown error"}.`);
    }

    const activeRun: CodexCliActiveRun = { process, phase: "active", closed: false };
    this.activeRuns.set(input.runId, activeRun);
    observeProcessClose(process, activeRun);

    let startedEventDelivery: Promise<void> | undefined;
    if (events) {
      try {
        startedEventDelivery = Promise.resolve(
          events({ type: "started", runId: input.runId, scopeId: input.scopeId, at: now() })
        );
      } catch (error) {
        startedEventDelivery = Promise.reject(error);
      }
    }

    try {
      return await this.collectRunResult(input, prompt, activeRun, events, startedEventDelivery);
    } catch (error) {
      activeRun.phase = "settling";
      await terminateProcessBounded(process, activeRun, this.terminateGraceMs);
      this.clearRun(input.runId, activeRun);
      throw error;
    }
  }

  async cancel(runId: string): Promise<AgentHarnessCancelResult> {
    const active = this.activeRuns.get(runId);
    if (!active || active.phase === "settling") return { accepted: false, reason: "not_active" };
    if (active.phase === "cancelling") return { accepted: true };
    active.phase = "cancelling";
    void terminateProcessBounded(active.process, active, this.terminateGraceMs);
    return { accepted: true };
  }

  private buildArgs(model: string): string[] {
    return [
      "exec",
      "--json",
      "--ephemeral",
      "--sandbox", "read-only",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--color", "never",
      "--model", model,
      "--cd", this.config.workingDirectory,
      "-"
    ];
  }

  private async collectRunResult(
    input: AgentHarnessTurnInput,
    prompt: string,
    activeRun: CodexCliActiveRun,
    events: AgentHarnessEventSink | undefined,
    startedEventDelivery: Promise<void> | undefined
  ): Promise<CompletionResult> {
    const process = activeRun.process;
    const timeoutMs = parsePositiveBound(input.timeoutMs, DEFAULT_RUN_TIMEOUT_MS, "timeoutMs");
    let settled = false;
    let lineBuffer = "";
    let outputChars = 0;
    const contentParts: string[] = [];
    let usage: CompletionResult["usage"];
    let turnCompleted = false;

    return await new Promise<CompletionResult>((resolve, reject) => {
      const rejectStartedEvent = async (error: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        activeRun.phase = "settling";
        await terminateProcessBounded(process, activeRun, this.terminateGraceMs);
        this.clearRun(input.runId, activeRun);
        reject(error);
      };

      const fail = async (error: Error): Promise<void> => {
        if (settled) return;
        settled = true;
        const wasCancelled = activeRun.phase === "cancelling";
        activeRun.phase = "settling";
        try {
          await startedEventDelivery;
        } catch (startedEventError) {
          await terminateProcessBounded(process, activeRun, this.terminateGraceMs);
          this.clearRun(input.runId, activeRun);
          reject(startedEventError);
          return;
        }
        await terminateProcessBounded(process, activeRun, this.terminateGraceMs);
        try {
          if (events) {
            await events({
              type: "failed",
              runId: input.runId,
              scopeId: input.scopeId,
              at: now(),
              code: wasCancelled ? "cancelled" : "provider_failure"
            });
          }
        } catch {
          // Preserve the original runtime failure.
        } finally {
          this.clearRun(input.runId, activeRun);
        }
        reject(error);
      };

      const succeed = async (): Promise<void> => {
        if (settled) return;
        settled = true;
        activeRun.phase = "settling";
        try {
          await startedEventDelivery;
          if (events) {
            await events({ type: "completed", runId: input.runId, scopeId: input.scopeId, at: now() });
          }
        } catch (error) {
          this.clearRun(input.runId, activeRun);
          reject(error instanceof Error ? error : new Error("Codex CLI event delivery failed."));
          return;
        }
        this.clearRun(input.runId, activeRun);
        resolve({
          content: contentParts.join("\n").trim(),
          ...(usage ? { usage } : {})
        });
      };

      const processLine = async (rawLine: string): Promise<void> => {
        const line = rawLine.trim();
        if (line.length === 0 || settled) return;

        try {
          const parsed = JSON.parse(line);
          const event = jsonEventSchema.parse(parsed);
          if (event.type === "item.completed") {
            const item = event.item;
            if (typeof item !== "object" || item === null) {
              await fail(new Error("Codex CLI emitted a malformed completion item."));
              return;
            }
            const record = item as Record<string, unknown>;
            if (record.type === "agent_message") {
              const agentMessage = agentMessageItemSchema.parse(record);
              outputChars += agentMessage.text.length;
              if (outputChars > this.outputCharLimit) {
                await fail(new Error(`Codex CLI output exceeded ${this.outputCharLimit} characters.`));
                return;
              }
              contentParts.push(agentMessage.text);
              return;
            }
            if (record.type === "error") {
              const errorItem = errorItemSchema.parse(record);
              await fail(new Error(trimDetail(errorItem.message)));
            }
            return;
          }

          if (event.type === "turn.completed") {
            usage = usageFromEvent(event.usage);
            turnCompleted = true;
            return;
          }

          if (event.type === "turn.failed") {
            const errorMessage = typeof event.error === "object"
              && event.error !== null
              && typeof (event.error as Record<string, unknown>).message === "string"
              ? (event.error as Record<string, unknown>).message as string
              : "Codex CLI turn failed.";
            await fail(new Error(trimDetail(errorMessage)));
            return;
          }

          if (event.type === "error") {
            const message = typeof event.message === "string" ? event.message : "Codex CLI execution failed.";
            await fail(new Error(trimDetail(message)));
          }
        } catch (error) {
          if (error instanceof Error && /output exceeded|turn failed|execution failed/i.test(error.message)) {
            await fail(error);
            return;
          }
          await fail(new Error("Codex CLI emitted malformed JSONL output."));
        }
      };

      process.stdout.setEncoding("utf8");
      process.stdout.on("data", (chunk: string | Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split(/\r?\n/u);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          void processLine(line);
        }
      });

      process.once("error", (error) => {
        const resolved = asError(error, "Codex CLI process failed.");
        void fail(new Error(`Codex CLI process failed: ${trimDetail(resolved.message)}`));
      });

      process.once("close", (code, signal) => {
        const exitCode = typeof code === "number" ? code : null;
        const exitSignal = asSignal(signal);
        const finalize = async (): Promise<void> => {
          if (lineBuffer.trim().length > 0) {
            await processLine(lineBuffer);
            lineBuffer = "";
          }
          if (settled) return;
          if (activeRun.phase === "cancelling") {
            await fail(new Error("Codex CLI run was cancelled."));
            return;
          }
          if (exitCode !== 0) {
            await fail(new Error(`Codex CLI process exited with ${closeCodeLabel(exitCode, exitSignal)}.`));
            return;
          }
          if (contentParts.length === 0) {
            await fail(new Error("Codex CLI returned no agent message."));
            return;
          }
          if (!turnCompleted) {
            await fail(new Error("Codex CLI process exited without a valid turn.completed marker."));
            return;
          }
          await succeed();
        };
        void finalize();
      });

      const startExecution = (): void => {
        if (settled || activeRun.closed || activeRun.phase !== "active") return;
        activeRun.timeoutHandle = setTimeout(() => {
          if (settled) return;
          void fail(new Error(`Codex CLI run exceeded ${timeoutMs}ms.`));
        }, timeoutMs);

        process.stdin.write(prompt, (error) => {
          if (error) {
            const resolved = asError(error, "Codex CLI stdin write failed.");
            void fail(new Error(`Codex CLI stdin write failed: ${trimDetail(resolved.message)}`));
            return;
          }
          closeStdin(process);
        });
      };

      if (startedEventDelivery) {
        void startedEventDelivery.then(startExecution, (error: unknown) => {
          void rejectStartedEvent(error);
        });
      } else {
        startExecution();
      }
    });
  }

  private clearRun(runId: string, expected?: CodexCliActiveRun): void {
    const active = this.activeRuns.get(runId);
    if (!active) return;
    if (expected && active !== expected) return;
    if (active.timeoutHandle) clearTimeout(active.timeoutHandle);
    if (active.killHandle) clearTimeout(active.killHandle);
    this.activeRuns.delete(runId);
  }

  private async spawnAndWait(args: string[], timeoutMs: number): Promise<void> {
    const process = this.processRunner.spawn(this.command, args, {
      cwd: this.config.workingDirectory,
      env: { ...this.config.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const termination: CodexCliProcessTermination = { closed: false };
    observeProcessClose(process, termination);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        void terminateProcessBounded(process, termination, this.terminateGraceMs).then(() => {
          reject(new Error(`Codex CLI health check exceeded ${timeoutMs}ms.`));
        });
      }, timeoutMs);

      process.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        void terminateProcessBounded(process, termination, this.terminateGraceMs).then(() => {
          reject(asError(error, "Codex CLI health check failed."));
        });
      });
      process.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        const exitCode = typeof code === "number" ? code : null;
        const exitSignal = asSignal(signal);
        clearTimeout(timeoutHandle);
        if (exitCode === 0) {
          resolve();
          return;
        }
        reject(new Error(`Codex CLI process exited with ${closeCodeLabel(exitCode, exitSignal)}.`));
      });
    });
  }
}
