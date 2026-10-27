import { externalExecutionInputsSchema, type ExternalExecution } from "@council/contracts";
import type { ExternalExecutorBackend } from "@council/domain";
import { z } from "zod";

const actionIdSchema = z.string().trim().min(1).max(200);
const targetIdSchema = z.string().trim().min(1).max(200);
const resourceIdSchema = z.string().trim().min(1).max(200);
const requestIdSchema = z.string().trim().min(1).max(500);
const executionIdSchema = z.string().trim().min(1).max(500);

type JsonInputs = Record<string, unknown>;

export interface ActionCatalogEntry<TInputs extends JsonInputs = JsonInputs> {
  actionId: string;
  targetId: string;
  resourceId: string;
  inputSchema: z.ZodType<TInputs>;
}

export interface ActionCatalogSnapshot {
  catalogId: string;
  version: number;
  actions: ReadonlyArray<Readonly<Pick<ActionCatalogEntry, "actionId" | "targetId" | "resourceId">>>;
}

export interface ActionAdapterIdentity {
  actionId: string;
  targetId: string;
  resourceId: string;
}

export interface ActionPreviewRequest extends ActionAdapterIdentity {
  requestId: string;
  inputs: unknown;
}

export interface ActionPreview extends ActionAdapterIdentity {
  requestId: string;
  catalog: ActionCatalogSnapshot;
  inputs: Readonly<JsonInputs>;
}

export interface ActionExecutionReference extends ActionAdapterIdentity {
  requestId: string;
  executionId?: string;
}

export interface ActionExecution extends ActionExecutionReference {
  executionId: string;
  status: ExternalExecution["status"];
}

export interface ActionAdapter {
  catalog(): ActionCatalogSnapshot;
  preview(request: ActionPreviewRequest): Promise<ActionPreview>;
  execute(request: ActionPreviewRequest): Promise<ActionExecution>;
  status(reference: ActionExecutionReference): Promise<ActionExecution>;
  verify(reference: ActionExecutionReference): Promise<ActionExecution>;
  cancel(reference: ActionExecutionReference): Promise<ActionExecution>;
  compensate(reference: ActionExecutionReference): Promise<ActionExecution>;
}

export class ActionAdapterPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionAdapterPolicyError";
  }
}

export class ActionOutcomeUnknownError extends Error {
  constructor(message = "The action outcome is unknown; do not retry across the effect boundary.") {
    super(message);
    this.name = "ActionOutcomeUnknownError";
  }
}

interface StoredAction {
  readonly actionId: string;
  readonly targetId: string;
  readonly resourceId: string;
  readonly inputSchema: z.ZodType<JsonInputs>;
}

interface PlannedAction {
  readonly identity: Readonly<ActionAdapterIdentity>;
  readonly inputs: Readonly<JsonInputs>;
  readonly fingerprint: string;
  state: "previewed" | "effect_started" | "known" | "unknown";
  execution?: ActionExecution;
}

export interface HarnessActionAdapterConfig {
  catalogId: string;
  catalogVersion: number;
  actions: ReadonlyArray<ActionCatalogEntry>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneInputs(value: JsonInputs): Readonly<JsonInputs> {
  return deepFreeze(structuredClone(value));
}

/**
 * Fail-closed adapter for the Harness effect boundary. The catalog is copied at
 * construction so later caller mutations cannot widen an action's authority.
 */
export class HarnessActionAdapter implements ActionAdapter {
  private readonly actions = new Map<string, StoredAction>();
  private readonly snapshot: ActionCatalogSnapshot;
  private readonly planned = new Map<string, PlannedAction>();

  constructor(
    config: HarnessActionAdapterConfig,
    private readonly harness: ExternalExecutorBackend
  ) {
    const catalogId = actionIdSchema.parse(config.catalogId);
    if (!Number.isInteger(config.catalogVersion) || config.catalogVersion < 1) {
      throw new ActionAdapterPolicyError("Action catalog version must be a positive integer.");
    }
    if (config.actions.length === 0) throw new ActionAdapterPolicyError("Action catalog must not be empty.");

    const snapshotActions: Array<Readonly<Pick<ActionCatalogEntry, "actionId" | "targetId" | "resourceId">>> = [];
    for (const entry of config.actions) {
      const actionId = actionIdSchema.parse(entry.actionId);
      if (this.actions.has(actionId)) throw new ActionAdapterPolicyError("Action catalog contains a duplicate action ID.");
      const stored: StoredAction = Object.freeze({
        actionId,
        targetId: targetIdSchema.parse(entry.targetId),
        resourceId: resourceIdSchema.parse(entry.resourceId),
        inputSchema: entry.inputSchema as z.ZodType<JsonInputs>
      });
      this.actions.set(actionId, stored);
      snapshotActions.push(Object.freeze({
        actionId: stored.actionId,
        targetId: stored.targetId,
        resourceId: stored.resourceId
      }));
    }
    this.snapshot = Object.freeze({
      catalogId,
      version: config.catalogVersion,
      actions: Object.freeze(snapshotActions)
    });
  }

  catalog(): ActionCatalogSnapshot {
    return this.snapshot;
  }

  async preview(request: ActionPreviewRequest): Promise<ActionPreview> {
    const { action, identity, requestId, inputs } = this.validateRequest(request);
    const fingerprint = canonicalJson({ identity, inputs });
    const existing = this.planned.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new ActionAdapterPolicyError("Action request ID is already bound to different action details.");
      if (existing.state !== "previewed") throw new ActionAdapterPolicyError("Action request has already crossed the effect boundary.");
      return this.previewResult(requestId, existing);
    }

    await this.harness.validate({ resourceId: action.resourceId, inputs });
    this.planned.set(requestId, { identity, inputs, fingerprint, state: "previewed" });
    return { ...identity, requestId, catalog: this.snapshot, inputs };
  }

  async execute(request: ActionPreviewRequest): Promise<ActionExecution> {
    const { identity, requestId, inputs } = this.validateRequest(request);
    const fingerprint = canonicalJson({ identity, inputs });
    const planned = this.planned.get(requestId);
    if (!planned || planned.fingerprint !== fingerprint) {
      throw new ActionAdapterPolicyError("Action execution requires an exact validated preview.");
    }
    if (planned.state === "unknown" || planned.state === "effect_started") {
      throw new ActionOutcomeUnknownError();
    }
    if (planned.state === "known") throw new ActionAdapterPolicyError("Action request has already been executed.");

    planned.state = "effect_started";
    try {
      const external = await this.harness.start({ resourceId: identity.resourceId, inputs });
      const execution = this.executionFrom(identity, requestId, external);
      planned.execution = execution;
      planned.state = external.status === "unknown" ? "unknown" : "known";
      if (planned.state === "unknown") throw new ActionOutcomeUnknownError();
      return execution;
    } catch (error) {
      planned.state = "unknown";
      if (error instanceof ActionOutcomeUnknownError) throw error;
      throw new ActionOutcomeUnknownError();
    }
  }

  async status(reference: ActionExecutionReference): Promise<ActionExecution> {
    return this.refresh(reference);
  }

  async verify(reference: ActionExecutionReference): Promise<ActionExecution> {
    return this.refresh(reference);
  }

  async cancel(reference: ActionExecutionReference): Promise<ActionExecution> {
    return this.interrupt(reference);
  }

  async compensate(reference: ActionExecutionReference): Promise<ActionExecution> {
    return this.interrupt(reference);
  }

  private validateRequest(request: ActionPreviewRequest): {
    action: StoredAction;
    identity: Readonly<ActionAdapterIdentity>;
    requestId: string;
    inputs: Readonly<JsonInputs>;
  } {
    const actionId = actionIdSchema.parse(request.actionId);
    const action = this.actions.get(actionId);
    if (!action) throw new ActionAdapterPolicyError("Action is not in the immutable catalog allowlist.");
    const identity = Object.freeze({ actionId, targetId: targetIdSchema.parse(request.targetId), resourceId: resourceIdSchema.parse(request.resourceId) });
    if (identity.targetId !== action.targetId || identity.resourceId !== action.resourceId) {
      throw new ActionAdapterPolicyError("Action target and resource IDs must match the catalog snapshot.");
    }
    const typed = action.inputSchema.parse(request.inputs);
    const inputs = cloneInputs(externalExecutionInputsSchema.parse(typed));
    return { action, identity, requestId: requestIdSchema.parse(request.requestId), inputs };
  }

  private validateReference(reference: ActionExecutionReference): {
    identity: Readonly<ActionAdapterIdentity>;
    requestId: string;
  } {
    const requestId = requestIdSchema.parse(reference.requestId);
    const identity = Object.freeze({
      actionId: actionIdSchema.parse(reference.actionId),
      targetId: targetIdSchema.parse(reference.targetId),
      resourceId: resourceIdSchema.parse(reference.resourceId)
    });
    const action = this.actions.get(identity.actionId);
    if (!action || identity.targetId !== action.targetId || identity.resourceId !== action.resourceId) {
      throw new ActionAdapterPolicyError("Action execution reference does not match the immutable catalog.");
    }
    return { identity, requestId };
  }

  private requireKnown(reference: ActionExecutionReference): { identity: Readonly<ActionAdapterIdentity>; requestId: string; planned: PlannedAction; execution: ActionExecution } {
    const { identity, requestId } = this.validateReference(reference);
    const planned = this.planned.get(requestId);
    if (!planned) throw new ActionAdapterPolicyError("Action request is not known to this adapter.");
    if (canonicalJson(identity) !== canonicalJson(planned.identity)) {
      throw new ActionAdapterPolicyError("Action execution reference does not match the catalog-bound request.");
    }
    if (planned.state === "unknown" || planned.state === "effect_started") throw new ActionOutcomeUnknownError();
    if (!planned.execution) throw new ActionAdapterPolicyError("Action request has not been executed.");
    return { identity, requestId, planned, execution: planned.execution };
  }

  private executionReference(reference: ActionExecutionReference): {
    identity: Readonly<ActionAdapterIdentity>;
    requestId: string;
    planned: PlannedAction | null;
    executionId: string;
  } {
    if (reference.executionId) {
      const { identity, requestId } = this.validateReference(reference);
      return {
        identity,
        requestId,
        planned: null,
        executionId: executionIdSchema.parse(reference.executionId)
      };
    }
    const known = this.requireKnown(reference);
    return {
      identity: known.identity,
      requestId: known.requestId,
      planned: known.planned,
      executionId: known.execution.executionId
    };
  }

  private async refresh(reference: ActionExecutionReference): Promise<ActionExecution> {
    const { identity, requestId, planned, executionId } = this.executionReference(reference);
    try {
      const external = await this.harness.status(executionId);
      const updated = this.executionFrom(identity, requestId, external, executionId);
      if (planned) planned.execution = updated;
      if (updated.status === "unknown") {
        if (planned) planned.state = "unknown";
        throw new ActionOutcomeUnknownError();
      }
      return updated;
    } catch (error) {
      if (error instanceof ActionOutcomeUnknownError) throw error;
      if (!planned) throw error;
      planned.state = "unknown";
      throw new ActionOutcomeUnknownError();
    }
  }

  private async interrupt(reference: ActionExecutionReference): Promise<ActionExecution> {
    const { identity, requestId, planned, executionId } = this.executionReference(reference);
    try {
      const external = await this.harness.cancel(executionId);
      const updated = this.executionFrom(identity, requestId, external, executionId);
      if (planned) planned.execution = updated;
      if (updated.status === "unknown") {
        if (planned) planned.state = "unknown";
        throw new ActionOutcomeUnknownError();
      }
      return updated;
    } catch (error) {
      if (planned) planned.state = "unknown";
      if (error instanceof ActionOutcomeUnknownError) throw error;
      throw new ActionOutcomeUnknownError();
    }
  }

  private previewResult(requestId: string, planned: PlannedAction): ActionPreview {
    return { ...planned.identity, requestId, catalog: this.snapshot, inputs: planned.inputs };
  }

  private executionFrom(
    identity: Readonly<ActionAdapterIdentity>,
    requestId: string,
    execution: ExternalExecution,
    expectedExecutionId?: string
  ): ActionExecution {
    if (expectedExecutionId && execution.executionId !== expectedExecutionId) {
      throw new ActionAdapterPolicyError("Harness execution identity does not match the catalog-bound execution.");
    }
    return Object.freeze({ ...identity, requestId, executionId: execution.executionId, status: execution.status });
  }
}
