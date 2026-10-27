import type { ExternalExecution, ExternalExecutionRequest } from "@council/contracts";

export type { ExternalExecution, ExternalExecutionRequest } from "@council/contracts";

export interface ExternalExecutor {
  validate(request: ExternalExecutionRequest): Promise<void>;
  start(request: ExternalExecutionRequest): Promise<ExternalExecution>;
  status(executionId: string): Promise<ExternalExecution>;
  cancel(executionId: string): Promise<ExternalExecution>;
}

export interface ExternalExecutorBackend extends ExternalExecutor {}

export interface GuardedExecutorConfig {
  enabled: boolean;
  allowedResourceIds: string[];
}

export class ExternalExecutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalExecutionPolicyError";
  }
}

export class GuardedExternalExecutor implements ExternalExecutor {
  private readonly allowlist: Set<string>;

  constructor(
    private readonly config: GuardedExecutorConfig,
    private readonly backend?: ExternalExecutorBackend
  ) {
    this.allowlist = new Set(config.allowedResourceIds);
  }

  private requireAllowedBackend(request: ExternalExecutionRequest): ExternalExecutorBackend {
    if (!this.config.enabled) throw new ExternalExecutionPolicyError("External executor is disabled.");
    if (!this.allowlist.has(request.resourceId)) {
      throw new ExternalExecutionPolicyError("Resource is not in the execution allowlist.");
    }
    if (!this.backend) throw new Error("External executor backend is not configured.");
    return this.backend;
  }

  async validate(request: ExternalExecutionRequest): Promise<void> {
    await this.requireAllowedBackend(request).validate(request);
  }

  async start(request: ExternalExecutionRequest): Promise<ExternalExecution> {
    return this.requireAllowedBackend(request).start(request);
  }

  async status(executionId: string): Promise<ExternalExecution> {
    if (!this.config.enabled) throw new ExternalExecutionPolicyError("External executor is disabled.");
    if (!this.backend) throw new Error("External executor backend is not configured.");
    return this.backend.status(executionId);
  }

  async cancel(executionId: string): Promise<ExternalExecution> {
    if (!this.config.enabled) throw new ExternalExecutionPolicyError("External executor is disabled.");
    if (!this.backend) throw new Error("External executor backend is not configured.");
    return this.backend.cancel(executionId);
  }
}
