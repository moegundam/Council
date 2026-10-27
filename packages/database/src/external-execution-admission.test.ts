import { describe, expect, it, vi } from "vitest";
import type { ExternalExecution, ExternalExecutionRequest } from "@council/domain";
import type { Pool, PoolClient } from "pg";
import { InMemoryPlatformStore } from "./memory-store.js";
import { PostgresPlatformStore } from "./postgres-store.js";

type ExternalExecutionStartRequest = Pick<ExternalExecutionRequest, "resourceId" | "inputs">;
type ExternalExecutionStartAdmission =
  | { status: "reserved"; reservationId: string }
  | { status: "pending"; reservationId: string }
  | { status: "settled"; reservationId: string; execution: ExternalExecution };
type ExternalExecutionAdmissionStore = {
  admitExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string
  ): Promise<ExternalExecutionStartAdmission>;
  settleExternalExecutionStart(
    input: ExternalExecutionStartRequest,
    idempotencyKey: string,
    execution: ExternalExecution
  ): Promise<ExternalExecution>;
};

const request = {
  resourceId: "pipeline-safe-start",
  inputs: { prompt: "classified-input", nested: { priority: 1 } }
} satisfies ExternalExecutionStartRequest;

const execution = {
  executionId: "external-execution-1",
  status: "queued"
} satisfies ExternalExecution;

class AuditedMemoryStore extends InMemoryPlatformStore {
  readonly audits: Array<{
    event: string;
    entityType: string;
    entityId: string;
    detail: Record<string, unknown>;
  }> = [];
  failRequestedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "external_execution.requested" && this.failRequestedAuditCount > 0) {
      this.failRequestedAuditCount -= 1;
      throw new Error("Injected requested audit failure.");
    }
    this.audits.push({ event, entityType, entityId, detail: structuredClone(detail) });
  }
}

interface IdempotencyRecord {
  requestFingerprint: string;
  response: unknown;
}

function postgresAdmissionHarness() {
  type Audit = { event: string; entityType: string; entityId: string; detail: Record<string, unknown> };
  type DurableState = { idempotency: Map<string, IdempotencyRecord>; audits: Audit[] };

  let durable: DurableState = { idempotency: new Map(), audits: [] };
  let transaction: DurableState | null = null;
  let failNextAudit = false;

  const cloneState = (state: DurableState): DurableState => ({
    idempotency: new Map(
      [...state.idempotency].map(([key, value]) => [key, structuredClone(value)])
    ),
    audits: structuredClone(state.audits)
  });
  const active = (): DurableState => {
    if (!transaction) throw new Error("PostgreSQL test query escaped its transaction.");
    return transaction;
  };
  const empty = () => ({ rows: [], rowCount: 0 });

  const clientQuery = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text === "BEGIN") {
      transaction = cloneState(durable);
      return empty();
    }
    if (text === "COMMIT") {
      durable = cloneState(active());
      transaction = null;
      return empty();
    }
    if (text === "ROLLBACK") {
      transaction = null;
      return empty();
    }
    if (text.includes("INSERT INTO idempotency_records")) {
      const scopedKey = `${String(values[0])}:${String(values[1])}`;
      if (active().idempotency.has(scopedKey)) return empty();
      const record = {
        requestFingerprint: String(values[2]),
        response: JSON.parse(String(values[3]))
      };
      active().idempotency.set(scopedKey, record);
      return { rows: [structuredClone(record)], rowCount: 1 };
    }
    if (text.includes("FROM idempotency_records")) {
      const record = active().idempotency.get(`${String(values[0])}:${String(values[1])}`);
      return record ? { rows: [structuredClone(record)], rowCount: 1 } : empty();
    }
    if (text.includes("UPDATE idempotency_records")) {
      const scopedKey = `${String(values[0])}:${String(values[1])}`;
      const record = active().idempotency.get(scopedKey);
      if (!record || record.requestFingerprint !== String(values[3])) return empty();
      record.response = JSON.parse(String(values[2]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO audit_events")) {
      if (failNextAudit) {
        failNextAudit = false;
        throw new Error("Injected PostgreSQL audit failure.");
      }
      active().audits.push({
        event: String(values[1]),
        entityType: String(values[2]),
        entityId: String(values[3]),
        detail: JSON.parse(String(values[4]))
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected PostgreSQL query: ${text}`);
  });

  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => empty())
  } as unknown as Pool;

  return {
    pool,
    clientQuery,
    failOneAudit: () => { failNextAudit = true; },
    readDurable: () => cloneState(durable)
  };
}

function committedTransactions(queryTexts: string[]): string[][] {
  const transactions: string[][] = [];
  let current: string[] = [];
  for (const text of queryTexts) {
    if (text === "BEGIN") current = [];
    current.push(text);
    if (text === "COMMIT" || text === "ROLLBACK") transactions.push(current);
  }
  return transactions;
}

describe("external execution write-ahead admission", () => {
  it("serializes Memory admission, binds payload, and replays one exact settlement", async () => {
    const memory = new AuditedMemoryStore();
    const store = memory as unknown as ExternalExecutionAdmissionStore;

    const [first, concurrent] = await Promise.all([
      store.admitExternalExecutionStart(request, "external-start-key"),
      store.admitExternalExecutionStart(structuredClone(request), "external-start-key")
    ]);

    expect(first).toMatchObject({ status: "reserved" });
    expect(concurrent).toEqual({ status: "pending", reservationId: first.reservationId });
    await expect(store.admitExternalExecutionStart({
      ...request,
      inputs: { ...request.inputs, changed: true }
    }, "external-start-key")).rejects.toMatchObject({
      statusCode: 409,
      apiCode: "IDEMPOTENCY_KEY_CONFLICT"
    });

    await expect(store.settleExternalExecutionStart(request, "external-start-key", execution))
      .resolves.toEqual(execution);
    await expect(store.admitExternalExecutionStart(request, "external-start-key")).resolves.toEqual({
      status: "settled",
      reservationId: first.reservationId,
      execution
    });
    await expect(store.settleExternalExecutionStart(request, "external-start-key", structuredClone(execution)))
      .resolves.toEqual(execution);

    expect(memory.audits.map((audit) => audit.event)).toEqual([
      "external_execution.requested",
      "external_execution.accepted"
    ]);
    expect(memory.audits[0]?.detail).toEqual({});
    const auditJson = JSON.stringify(memory.audits);
    expect(auditJson).not.toContain("external-start-key");
    expect(auditJson).not.toContain("classified-input");
  });

  it("does not retain a Memory reservation when the required requested audit fails", async () => {
    const memory = new AuditedMemoryStore();
    memory.failRequestedAuditCount = 1;
    const store = memory as unknown as ExternalExecutionAdmissionStore;

    await expect(store.admitExternalExecutionStart(request, "audit-retry-key"))
      .rejects.toThrow("Injected requested audit failure");
    await expect(store.admitExternalExecutionStart(request, "audit-retry-key"))
      .resolves.toMatchObject({ status: "reserved" });
    await expect(store.admitExternalExecutionStart(request, "audit-retry-key"))
      .resolves.toMatchObject({ status: "pending" });
    expect(memory.audits.filter((audit) => audit.event === "external_execution.requested")).toHaveLength(1);
  });

  it("uses PostgreSQL conflict admission and atomic requested/accepted transactions", async () => {
    const harness = postgresAdmissionHarness();
    const firstStore = new PostgresPlatformStore(harness.pool) as unknown as ExternalExecutionAdmissionStore;
    const secondStore = new PostgresPlatformStore(harness.pool) as unknown as ExternalExecutionAdmissionStore;

    const first = await firstStore.admitExternalExecutionStart(request, "postgres-external-start");
    await expect(secondStore.admitExternalExecutionStart(request, "postgres-external-start"))
      .resolves.toEqual({ status: "pending", reservationId: first.reservationId });
    await expect(secondStore.admitExternalExecutionStart({ ...request, resourceId: "changed-pipeline" }, "postgres-external-start"))
      .rejects.toMatchObject({ statusCode: 409, apiCode: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(firstStore.settleExternalExecutionStart(request, "postgres-external-start", execution))
      .resolves.toEqual(execution);
    await expect(secondStore.admitExternalExecutionStart(request, "postgres-external-start"))
      .resolves.toEqual({ status: "settled", reservationId: first.reservationId, execution });

    const durable = harness.readDurable();
    expect(durable.idempotency).toHaveLength(1);
    expect(durable.audits.map((audit) => audit.event)).toEqual([
      "external_execution.requested",
      "external_execution.accepted"
    ]);
    expect(durable.audits[0]?.detail).toEqual({});
    expect(JSON.stringify(durable.audits)).not.toContain("postgres-external-start");
    expect(JSON.stringify(durable.audits)).not.toContain("classified-input");

    const transactions = committedTransactions(
      harness.clientQuery.mock.calls.map(([text]) => String(text))
    );
    const admission = transactions[0]!;
    const settlement = transactions.find((transaction) =>
      transaction.some((text) => text.includes("UPDATE idempotency_records"))
    )!;
    const admissionInsert = admission.find((text) => text.includes("INSERT INTO idempotency_records"))!;
    expect(admissionInsert).toContain("ON CONFLICT DO NOTHING");
    expect(admission.indexOf(admissionInsert)).toBeLessThan(
      admission.findIndex((text) => text.includes("INSERT INTO audit_events"))
    );
    expect(admission.at(-1)).toBe("COMMIT");
    expect(settlement.findIndex((text) => text.includes("SELECT"))).toBeLessThan(
      settlement.findIndex((text) => text.includes("INSERT INTO audit_events"))
    );
    expect(settlement.findIndex((text) => text.includes("INSERT INTO audit_events"))).toBeLessThan(
      settlement.findIndex((text) => text.includes("UPDATE idempotency_records"))
    );
    expect(settlement.at(-1)).toBe("COMMIT");
  });

  it("rolls back a PostgreSQL reservation when its requested audit fails", async () => {
    const harness = postgresAdmissionHarness();
    const store = new PostgresPlatformStore(harness.pool) as unknown as ExternalExecutionAdmissionStore;
    harness.failOneAudit();

    await expect(store.admitExternalExecutionStart(request, "postgres-audit-retry"))
      .rejects.toThrow("Injected PostgreSQL audit failure");
    expect(harness.readDurable().idempotency).toHaveLength(0);
    await expect(store.admitExternalExecutionStart(request, "postgres-audit-retry"))
      .resolves.toMatchObject({ status: "reserved" });

    const transactions = committedTransactions(
      harness.clientQuery.mock.calls.map(([text]) => String(text))
    );
    expect(transactions[0]?.at(-1)).toBe("ROLLBACK");
    expect(transactions[1]?.at(-1)).toBe("COMMIT");
  });
});
