import { describe, expect, it, vi } from "vitest";
import type { CreateRoleInput, PlatformSnapshot, Role, RoleVersion } from "@council/contracts";
import type { Pool, PoolClient } from "pg";
import { InMemoryPlatformStore } from "./memory-store.js";
import { PostgresPlatformStore } from "./postgres-store.js";
import { createSeedSnapshot } from "./seed.js";

const rolePayload = {
  name: "Retry-safe Role",
  usageContext: "Use when a Role create acknowledgement may be lost.",
  responsibility: "Return one durable Role for every retried create request.",
  speakingGuidance: "Report the persisted Role without inventing another version.",
  decisionScope: "Recommend Role configuration without approving unrelated changes.",
  constraints: "Bind every retry to the complete create payload.",
  templateKey: null,
  toolPolicy: "none",
  dataPolicy: "meeting_only"
} satisfies CreateRoleInput;

type IdempotentRoleStore = {
  createRole(input: CreateRoleInput, idempotencyKey?: string): Promise<Role>;
};

class CountingRoleAuditStore extends InMemoryPlatformStore {
  roleCreatedAuditCount = 0;

  override async recordAudit(
    event: string,
    entityType: string,
    entityId: string,
    detail: Record<string, unknown> = {}
  ): Promise<void> {
    if (event === "role.created") this.roleCreatedAuditCount += 1;
    return super.recordAudit(event, entityType, entityId, detail);
  }
}

function postgresRoleHarness(seed = createSeedSnapshot()) {
  type IdempotencyRecord = { response: unknown; requestFingerprint: string };
  type DurableState = {
    state: PlatformSnapshot;
    idempotency: Map<string, IdempotencyRecord>;
    roleVersions: RoleVersion[];
    audits: Array<{ event: string; entityId: string }>;
  };

  let durable: DurableState = {
    state: structuredClone(seed),
    idempotency: new Map(),
    roleVersions: [],
    audits: []
  };
  let transaction: DurableState | null = null;

  const active = () => {
    if (!transaction) throw new Error("PostgreSQL test query escaped its transaction.");
    return transaction;
  };
  const cloneState = (state: DurableState): DurableState => ({
    state: structuredClone(state.state),
    idempotency: new Map([...state.idempotency].map(([key, value]) => [key, structuredClone(value)])),
    roleVersions: structuredClone(state.roleVersions),
    audits: structuredClone(state.audits)
  });
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
    if (text.includes("SELECT state FROM platform_state")) {
      return { rows: [{ state: structuredClone(active().state) }], rowCount: 1 };
    }
    if (text.includes("FROM idempotency_records")) {
      const record = active().idempotency.get(`${String(values[0])}:${String(values[1])}`);
      return record
        ? { rows: [structuredClone(record)], rowCount: 1 }
        : empty();
    }
    if (text.includes("INSERT INTO role_versions")) {
      active().roleVersions.push(JSON.parse(String(values[2])) as RoleVersion);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO idempotency_records")) {
      active().idempotency.set(`${String(values[0])}:${String(values[1])}`, {
        requestFingerprint: String(values[2]),
        response: JSON.parse(String(values[3]))
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("INSERT INTO audit_events")) {
      active().audits.push({ event: String(values[1]), entityId: String(values[3]) });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("utterance_projection_backfill_progress")) {
      return { rows: [{ complete: false }], rowCount: 1 };
    }
    if (text.includes("UPDATE platform_state")) {
      active().state = JSON.parse(String(values[0])) as PlatformSnapshot;
      return { rows: [], rowCount: 1 };
    }
    return empty();
  });

  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => empty())
  } as unknown as Pool;

  return {
    pool,
    clientQuery,
    readDurable: () => cloneState(durable)
  };
}

describe("Role creation idempotency", () => {
  it("replays one Memory Role, RoleVersion, and audit for the same key and complete payload", async () => {
    const store = new CountingRoleAuditStore();
    const idempotentStore = store as IdempotentRoleStore;

    const [first, concurrentReplay] = await Promise.all([
      idempotentStore.createRole(rolePayload, "role-create-retry"),
      idempotentStore.createRole(structuredClone(rolePayload), "role-create-retry")
    ]);
    const laterReplay = await idempotentStore.createRole(structuredClone(rolePayload), "role-create-retry");

    expect(concurrentReplay).toEqual(first);
    expect(laterReplay).toEqual(first);
    await expect(idempotentStore.createRole({
      ...rolePayload,
      responsibility: "A changed payload must not reuse the original Role."
    }, "role-create-retry")).rejects.toMatchObject({
      statusCode: 409,
      apiCode: "IDEMPOTENCY_KEY_CONFLICT"
    });

    const snapshot = await store.getSnapshot();
    expect(snapshot.roles.filter((role) => role.name === rolePayload.name)).toEqual([first]);
    expect(await store.getRoleVersions(first.id)).toHaveLength(1);
    expect(store.roleCreatedAuditCount).toBe(1);
  });

  it("persists the PostgreSQL idempotency record, Role, RoleVersion, and audit in one transaction", async () => {
    const harness = postgresRoleHarness();
    const store = new PostgresPlatformStore(harness.pool) as IdempotentRoleStore;

    const first = await store.createRole(rolePayload, "postgres-role-create-retry");
    const replay = await store.createRole(structuredClone(rolePayload), "postgres-role-create-retry");

    expect(replay).toEqual(first);
    await expect(store.createRole({ ...rolePayload, constraints: "Changed retry payload." }, "postgres-role-create-retry"))
      .rejects.toMatchObject({ statusCode: 409, apiCode: "IDEMPOTENCY_KEY_CONFLICT" });

    const durable = harness.readDurable();
    expect(durable.state.roles.filter((role) => role.name === rolePayload.name)).toEqual([first]);
    expect(durable.roleVersions.filter((version) => version.roleId === first.id)).toHaveLength(1);
    expect(durable.audits.filter((audit) => audit.event === "role.created" && audit.entityId === first.id)).toHaveLength(1);
    expect(durable.idempotency).toHaveLength(1);

    const firstTransaction = harness.clientQuery.mock.calls
      .map(([text]) => String(text))
      .slice(0, harness.clientQuery.mock.calls.findIndex(([text]) => text === "COMMIT") + 1);
    expect(firstTransaction.findIndex((text) => text.includes("INSERT INTO role_versions"))).toBeGreaterThan(0);
    expect(firstTransaction.findIndex((text) => text.includes("INSERT INTO idempotency_records")))
      .toBeGreaterThan(firstTransaction.findIndex((text) => text.includes("INSERT INTO role_versions")));
    expect(firstTransaction.findIndex((text) => text.includes("INSERT INTO audit_events")))
      .toBeGreaterThan(firstTransaction.findIndex((text) => text.includes("INSERT INTO idempotency_records")));
    expect(firstTransaction.findIndex((text) => text.includes("UPDATE platform_state")))
      .toBeGreaterThan(firstTransaction.findIndex((text) => text.includes("INSERT INTO audit_events")));
    expect(firstTransaction.at(-1)).toBe("COMMIT");
  });
});
