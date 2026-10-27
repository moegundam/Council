import { describe, expect, it, vi } from "vitest";
import { InMemoryPlatformStore } from "@council/database";
import {
  GuardedExternalExecutor,
  type ExternalExecution,
  type ExternalExecutionRequest,
  type ExternalExecutor,
  type ExternalExecutorBackend
} from "@council/domain";
import { createApp } from "./app.js";

const payload = {
  resourceId: "pipeline-safe-start",
  inputs: { prompt: "classified-input", priority: 1 }
};

const execution = {
  executionId: "external-execution-api-1",
  status: "queued"
} satisfies ExternalExecution;

class AuditedExecutionStore extends InMemoryPlatformStore {
  readonly audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  failRequestedAuditCount = 0;

  override async recordAudit(
    event: string,
    _entityType: string,
    _entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "external_execution.requested" && this.failRequestedAuditCount > 0) {
      this.failRequestedAuditCount -= 1;
      throw new Error("private database diagnostic");
    }
    this.audits.push({ event, detail: structuredClone(detail) });
  }
}

class SettlementFailureStore extends AuditedExecutionStore {
  async settleExternalExecutionStart(
    _input: Pick<ExternalExecutionRequest, "resourceId" | "inputs">,
    _idempotencyKey: string,
    _execution: ExternalExecution
  ): Promise<ExternalExecution> {
    throw new Error("private settlement diagnostic");
  }
}

function executor(start: ExternalExecutor["start"]): ExternalExecutor {
  return {
    validate: vi.fn(async () => undefined),
    start,
    status: vi.fn(async () => execution),
    cancel: vi.fn(async () => execution)
  };
}

describe("POST /api/executions/harness idempotency", () => {
  it("rejects deeply nested inputs before admission, audit, or external execution", async () => {
    const store = new AuditedExecutionStore();
    const start = vi.fn(async () => execution);
    let nested: unknown = "leaf";
    for (let index = 0; index < 64; index += 1) nested = { child: nested };
    const app = await createApp({ store, authDisabled: true, harnessEnabled: true, externalExecutor: executor(start) });

    const response = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-deep-input" },
      payload: { resourceId: "pipeline-safe-start", inputs: { nested } }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(store.audits).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it("checks executor presence first, then requires a bounded non-empty key", async () => {
    const disabled = await createApp({ store: new InMemoryPlatformStore(), authDisabled: true });
    const disabledResponse = await disabled.inject({ method: "POST", url: "/api/executions/harness" });
    expect(disabledResponse.statusCode).toBe(503);
    expect(disabledResponse.json()).toMatchObject({ error: { code: "EXECUTOR_UNAVAILABLE" } });
    await disabled.close();

    const start = vi.fn(async () => execution);
    const app = await createApp({
      store: new InMemoryPlatformStore(),
      authDisabled: true,
      harnessEnabled: true,
      externalExecutor: executor(start)
    });
    const missing = await app.inject({ method: "POST", url: "/api/executions/harness", payload });
    const blank = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "   " },
      payload
    });
    const overlong = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "x".repeat(201) },
      payload
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(blank.statusCode).toBe(400);
    expect(overlong.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a configured executor at the route boundary when the Harness feature flag is disabled", async () => {
    const store = new AuditedExecutionStore();
    const start = vi.fn(async () => execution);
    const app = await createApp({
      store,
      authDisabled: true,
      harnessEnabled: false,
      externalExecutor: executor(start)
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "disabled-harness-must-not-reserve" },
      payload
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "EXECUTOR_UNAVAILABLE" } });
    expect(store.audits).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a configured executor unless the Harness feature flag is explicitly enabled", async () => {
    const store = new AuditedExecutionStore();
    const start = vi.fn(async () => execution);
    const app = await createApp({
      store,
      authDisabled: true,
      externalExecutor: executor(start)
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/executions/harness",
      headers: { "idempotency-key": "omitted-harness-flag-must-not-reserve" },
      payload
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "EXECUTOR_UNAVAILABLE" } });
    expect(store.audits).toEqual([]);
    expect(start).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a non-allowlisted resource before admission on every retry", async () => {
    const store = new AuditedExecutionStore();
    const admission = vi.spyOn(store, "admitExternalExecutionStart");
    const backend = {
      validate: vi.fn(async () => undefined),
      start: vi.fn(async () => execution),
      status: vi.fn(async () => execution),
      cancel: vi.fn(async () => execution)
    } satisfies ExternalExecutorBackend;
    const guarded = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: ["pipeline-approved-start"]
    }, backend);
    const app = await createApp({
      store,
      authDisabled: true,
      harnessEnabled: true,
      externalExecutor: guarded
    });
    const request = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-denied-resource-retry" },
      payload
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    for (const response of [first, retry]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "EXTERNAL_EXECUTION_REJECTED",
          message: "Execution request was rejected before admission."
        }
      });
      expect(response.body).not.toContain("ACCEPTANCE_UNKNOWN");
      expect(response.body).not.toContain("RECONCILIATION_REQUIRED");
    }
    expect(admission).not.toHaveBeenCalled();
    expect(store.audits).toEqual([]);
    expect(backend.validate).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps backend validation failures retryable without durable admission", async () => {
    const store = new AuditedExecutionStore();
    const admission = vi.spyOn(store, "admitExternalExecutionStart");
    const privateDiagnostic = "private backend validation network diagnostic";
    const backend = {
      validate: vi.fn(async () => { throw new Error(privateDiagnostic); }),
      start: vi.fn(async () => execution),
      status: vi.fn(async () => execution),
      cancel: vi.fn(async () => execution)
    } satisfies ExternalExecutorBackend;
    const guarded = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: [payload.resourceId]
    }, backend);
    const app = await createApp({
      store,
      authDisabled: true,
      harnessEnabled: true,
      externalExecutor: guarded
    });
    const request = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-backend-validation-retry" },
      payload
    };

    const first = await app.inject(request);
    const retry = await app.inject(request);

    for (const response of [first, retry]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          code: "EXTERNAL_EXECUTION_VALIDATION_UNAVAILABLE",
          message: "Execution validation is temporarily unavailable."
        }
      });
      expect(response.body).not.toContain(privateDiagnostic);
      expect(response.body).not.toContain("ACCEPTANCE_UNKNOWN");
      expect(response.body).not.toContain("RECONCILIATION_REQUIRED");
    }
    expect(backend.validate).toHaveBeenCalledTimes(2);
    expect(backend.start).not.toHaveBeenCalled();
    expect(admission).not.toHaveBeenCalled();
    expect(store.audits).toEqual([]);
    await app.close();
  });

  it("fails closed before persisting or returning untrusted execution evidence", async () => {
    const store = new AuditedExecutionStore();
    const plaintextSecret = "dummy-plaintext-secret";
    const start = vi.fn(async () => ({
      executionId: "external-execution-secret-bearing",
      status: "queued" as const,
      evidence: { apiKey: plaintextSecret }
    }));
    const app = await createApp({ store, authDisabled: true, harnessEnabled: true, externalExecutor: executor(start) });
    const requestOptions = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-secret-evidence" },
      payload
    };

    const rejected = await app.inject(requestOptions);
    const fencedRetry = await app.inject(requestOptions);

    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({
      error: { code: "EXTERNAL_EXECUTION_ACCEPTANCE_UNKNOWN" }
    });
    expect(rejected.body).not.toContain("apiKey");
    expect(rejected.body).not.toContain(plaintextSecret);
    expect(fencedRetry.statusCode).toBe(409);
    expect(store.audits.map((audit) => audit.event)).toEqual(["external_execution.requested"]);
    expect(JSON.stringify(store.audits)).not.toContain(plaintextSecret);
    await app.close();
  });

  it("admits one concurrent start and replays the exact settled execution", async () => {
    const store = new AuditedExecutionStore();
    let observeStart!: () => void;
    let releaseStart!: () => void;
    const startObserved = new Promise<void>((resolve) => { observeStart = resolve; });
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const start = vi.fn(async (request: ExternalExecutionRequest) => {
      observeStart();
      await startGate;
      return execution;
    });
    const app = await createApp({ store, authDisabled: true, harnessEnabled: true, externalExecutor: executor(start) });
    const requestOptions = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-concurrent-start" },
      payload
    };

    const firstPromise = app.inject(requestOptions);
    await startObserved;
    const pending = await app.inject(requestOptions);
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({
      error: { code: "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED" }
    });
    releaseStart();
    const first = await firstPromise;
    const replay = await app.inject(requestOptions);
    const changed = await app.inject({
      ...requestOptions,
      payload: { ...payload, inputs: { ...payload.inputs, changed: true } }
    });

    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual(execution);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(execution);
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toEqual(payload);
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("idempotencyKey");
    expect(store.audits.map((audit) => audit.event)).toEqual([
      "external_execution.requested",
      "external_execution.accepted"
    ]);
    expect(JSON.stringify(store.audits)).not.toContain("api-concurrent-start");
    expect(JSON.stringify(store.audits)).not.toContain("classified-input");
    await app.close();
  });

  it("preserves a pending reservation after a start error and never retries downstream", async () => {
    const store = new AuditedExecutionStore();
    const start = vi.fn(async () => {
      throw new Error("downstream-secret-diagnostic");
    });
    const app = await createApp({ store, authDisabled: true, harnessEnabled: true, externalExecutor: executor(start) });
    const requestOptions = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-start-error" },
      payload
    };

    const first = await app.inject(requestOptions);
    const retry = await app.inject(requestOptions);

    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ error: { code: "EXTERNAL_EXECUTION_ACCEPTANCE_UNKNOWN" } });
    expect(first.body).not.toContain("downstream-secret-diagnostic");
    expect(first.body).not.toContain("api-start-error");
    expect(first.body).not.toContain("classified-input");
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      error: { code: "EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED" }
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(store.audits.map((audit) => audit.event)).toEqual(["external_execution.requested"]);
    await app.close();
  });

  it("keeps settlement uncertainty fenced, while a pre-reservation audit failure permits retry", async () => {
    const settlementStore = new SettlementFailureStore();
    const settlementStart = vi.fn(async () => execution);
    const settlementApp = await createApp({
      store: settlementStore,
      authDisabled: true,
      harnessEnabled: true,
      externalExecutor: executor(settlementStart)
    });
    const settlementRequest = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-settlement-error" },
      payload
    };
    const unknown = await settlementApp.inject(settlementRequest);
    const fenced = await settlementApp.inject(settlementRequest);
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json()).toMatchObject({ error: { code: "EXTERNAL_EXECUTION_ACCEPTANCE_UNKNOWN" } });
    expect(unknown.body).not.toContain("private settlement diagnostic");
    expect(fenced.statusCode).toBe(409);
    expect(settlementStart).toHaveBeenCalledTimes(1);
    await settlementApp.close();

    const auditStore = new AuditedExecutionStore();
    auditStore.failRequestedAuditCount = 1;
    const retryableStart = vi.fn(async () => execution);
    const auditApp = await createApp({
      store: auditStore,
      authDisabled: true,
      harnessEnabled: true,
      externalExecutor: executor(retryableStart)
    });
    const auditRequest = {
      method: "POST" as const,
      url: "/api/executions/harness",
      headers: { "idempotency-key": "api-audit-retry" },
      payload
    };
    const auditFailure = await auditApp.inject(auditRequest);
    const safeRetry = await auditApp.inject(auditRequest);
    expect(auditFailure.statusCode).toBe(503);
    expect(auditFailure.json()).toMatchObject({
      error: { code: "EXTERNAL_EXECUTION_ADMISSION_UNAVAILABLE" }
    });
    expect(auditFailure.body).not.toContain("private database diagnostic");
    expect(safeRetry.statusCode).toBe(202);
    expect(safeRetry.json()).toEqual(execution);
    expect(retryableStart).toHaveBeenCalledTimes(1);
    await auditApp.close();
  });
});
