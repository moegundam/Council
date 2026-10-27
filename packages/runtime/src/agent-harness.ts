import type { RuntimeCapability, RuntimeHarnessKind } from "@council/contracts";
import type { CompletionRequest, CompletionResult, ModelMessage } from "./model-connector.js";

export interface AgentHarnessProfile {
  kind: RuntimeHarnessKind;
  version: string;
  capabilities: RuntimeCapability[];
}

export interface AgentHarnessHealth {
  healthy: boolean;
  detail?: string;
}

export interface AgentHarnessHealthTarget {
  baseUrl: string;
  apiKey?: string;
  allowPrivate?: boolean;
}

export interface AgentHarnessTurnInput {
  runId: string;
  scopeId: string;
  model: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    allowPrivate?: boolean;
  };
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export type AgentHarnessEvent =
  | { type: "started"; runId: string; scopeId: string; at: string }
  | { type: "completed"; runId: string; scopeId: string; at: string }
  | { type: "failed"; runId: string; scopeId: string; at: string; code: "cancelled" | "provider_failure" };

export type AgentHarnessEventSink = (event: AgentHarnessEvent) => void | Promise<void>;

export interface AgentHarnessCancelResult {
  accepted: boolean;
  reason?: "not_active";
}

export interface AgentHarness {
  profile(): AgentHarnessProfile;
  health(target: AgentHarnessHealthTarget): Promise<AgentHarnessHealth>;
  runTurn(input: AgentHarnessTurnInput, events?: AgentHarnessEventSink): Promise<CompletionResult>;
  cancel(runId: string): Promise<AgentHarnessCancelResult>;
  resetSession?(sessionId: string): Promise<void>;
}

export interface ModelConnectorPort {
  health(baseUrl: string, apiKey?: string, allowPrivate?: boolean): Promise<boolean>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

interface OpenAICompatibleActiveRun {
  controller: AbortController;
  phase: "active" | "cancelling" | "settling";
}

function now(): string {
  return new Date().toISOString();
}

async function emit(events: AgentHarnessEventSink | undefined, event: AgentHarnessEvent): Promise<void> {
  await events?.(event);
}

export class OpenAICompatibleAgentHarness implements AgentHarness {
  private readonly activeRuns = new Map<string, OpenAICompatibleActiveRun>();

  constructor(private readonly connector: ModelConnectorPort) {}

  profile(): AgentHarnessProfile {
    return {
      kind: "openai_compatible",
      version: "1",
      capabilities: ["text", "abort"]
    };
  }

  async health(target: AgentHarnessHealthTarget): Promise<AgentHarnessHealth> {
    return {
      healthy: await this.connector.health(target.baseUrl, target.apiKey, target.allowPrivate ?? false)
    };
  }

  async runTurn(input: AgentHarnessTurnInput, events?: AgentHarnessEventSink): Promise<CompletionResult> {
    if (this.activeRuns.has(input.runId)) {
      throw new Error(`Runtime run ${input.runId} is already active.`);
    }

    const activeRun: OpenAICompatibleActiveRun = {
      controller: new AbortController(),
      phase: "active"
    };
    this.activeRuns.set(input.runId, activeRun);
    try {
      await emit(events, { type: "started", runId: input.runId, scopeId: input.scopeId, at: now() });
      const result = await this.connector.complete({
        baseUrl: input.model.baseUrl,
        model: input.model.model,
        ...(input.model.apiKey ? { apiKey: input.model.apiKey } : {}),
        allowPrivate: input.model.allowPrivate ?? false,
        messages: input.messages,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        signal: activeRun.controller.signal
      });
      if (activeRun.controller.signal.aborted) {
        throw new Error(`Runtime run ${input.runId} was cancelled.`);
      }
      activeRun.phase = "settling";
      await emit(events, { type: "completed", runId: input.runId, scopeId: input.scopeId, at: now() });
      return result;
    } catch (error) {
      activeRun.phase = "settling";
      try {
        await emit(events, {
          type: "failed",
          runId: input.runId,
          scopeId: input.scopeId,
          at: now(),
          code: activeRun.controller.signal.aborted ? "cancelled" : "provider_failure"
        });
      } catch {
        // Preserve the original runtime failure while still releasing the active run.
      }
      throw error;
    } finally {
      if (this.activeRuns.get(input.runId) === activeRun) this.activeRuns.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<AgentHarnessCancelResult> {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun || activeRun.phase === "settling") return { accepted: false, reason: "not_active" };
    if (activeRun.phase === "cancelling") return { accepted: true };
    activeRun.phase = "cancelling";
    activeRun.controller.abort();
    return { accepted: true };
  }
}
