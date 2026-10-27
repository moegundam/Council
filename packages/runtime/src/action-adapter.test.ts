import { describe, expect, it, vi } from "vitest";
import type { ExternalExecutorBackend } from "@council/domain";
import { z } from "zod";
import {
  ActionAdapterPolicyError,
  ActionOutcomeUnknownError,
  HarnessActionAdapter
} from "./action-adapter.js";

const identity = { actionId: "deploy-preview", targetId: "staging", resourceId: "pipeline-preview" };
const request = { ...identity, requestId: "request-42", inputs: { release: "20260720T072200Z" } };

function harnessFixture(): ExternalExecutorBackend {
  return {
    validate: vi.fn(async () => undefined),
    start: vi.fn(async () => ({ executionId: "execution-42", status: "queued" as const })),
    status: vi.fn(async () => ({ executionId: "execution-42", status: "running" as const })),
    cancel: vi.fn(async () => ({ executionId: "execution-42", status: "cancelled" as const }))
  };
}

function adapter(harness = harnessFixture()): HarnessActionAdapter {
  return new HarnessActionAdapter({
    catalogId: "meeting-actions",
    catalogVersion: 1,
    actions: [{
      ...identity,
      inputSchema: z.object({ release: z.string().regex(/^\d{8}T\d{6}Z$/) }).strict()
    }]
  }, harness);
}

describe("Harness action adapter", () => {
  it("uses an immutable catalog allowlist and fixed action identity", async () => {
    const harness = harnessFixture();
    const catalog = [{ ...identity, inputSchema: z.object({ release: z.string() }).strict() }];
    const subject = new HarnessActionAdapter({ catalogId: "meeting-actions", catalogVersion: 1, actions: catalog }, harness);
    catalog[0]!.resourceId = "mutated-resource";

    expect(Object.isFrozen(subject.catalog())).toBe(true);
    expect(Object.isFrozen(subject.catalog().actions)).toBe(true);
    await expect(subject.preview({ ...request, actionId: "not-catalogued" })).rejects.toBeInstanceOf(ActionAdapterPolicyError);
    await expect(subject.preview({ ...request, targetId: "production" })).rejects.toThrow(/target and resource/i);
    await expect(subject.preview({ ...request, resourceId: "mutated-resource" })).rejects.toThrow(/target and resource/i);
    await expect(subject.preview(request)).resolves.toMatchObject({ catalog: { catalogId: "meeting-actions", version: 1 } });
    expect(harness.validate).toHaveBeenCalledWith({ resourceId: "pipeline-preview", inputs: request.inputs });
  });

  it("enforces each action's typed input schema and the global bounded JSON input limits", async () => {
    const harness = harnessFixture();
    const subject = adapter(harness);

    await expect(subject.preview({ ...request, inputs: { release: "bad" } })).rejects.toThrow();
    await expect(subject.preview({ ...request, inputs: { release: "20260720T072200Z", extra: true } })).rejects.toThrow();
    await expect(subject.preview({ ...request, inputs: { release: "20260720T072200Z".repeat(60_000) } })).rejects.toThrow();
    expect(harness.validate).not.toHaveBeenCalled();
  });

  it("requires preview before executing once, then supports status verification", async () => {
    const harness = harnessFixture();
    const subject = adapter(harness);

    await expect(subject.execute(request)).rejects.toThrow(/validated preview/i);
    await subject.preview(request);
    await expect(subject.execute(request)).resolves.toMatchObject({ executionId: "execution-42", status: "queued" });
    await expect(subject.verify(identityAndRequest())).resolves.toMatchObject({ executionId: "execution-42", status: "running" });
    await expect(subject.execute(request)).rejects.toThrow(/already been executed/i);
    expect(harness.start).toHaveBeenCalledTimes(1);
    expect(harness.status).toHaveBeenCalledWith("execution-42");
  });

  it("reconciles a persisted external execution after the runtime Adapter is recreated", async () => {
    const harness = harnessFixture();
    vi.mocked(harness.status).mockResolvedValueOnce({ executionId: "execution-42", status: "succeeded" });
    const restarted = adapter(harness);

    await expect(restarted.verify({
      ...identityAndRequest(),
      executionId: "execution-42"
    })).resolves.toMatchObject({ executionId: "execution-42", status: "succeeded" });
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.status).toHaveBeenCalledWith("execution-42");
  });

  it("completes the enabled preview, execute, and verify path against only the catalog-bound Harness resource", async () => {
    const harness = harnessFixture();
    vi.mocked(harness.status).mockResolvedValueOnce({ executionId: "execution-42", status: "succeeded" });
    const subject = adapter(harness);

    const preview = await subject.preview(request);
    const execution = await subject.execute(request);
    const verified = await subject.verify(identityAndRequest());

    expect(preview).toMatchObject({ actionId: identity.actionId, targetId: identity.targetId, resourceId: identity.resourceId });
    expect(execution).toMatchObject({ executionId: "execution-42", status: "queued" });
    expect(verified).toMatchObject({ executionId: "execution-42", status: "succeeded" });
    expect(harness.validate).toHaveBeenCalledWith({ resourceId: identity.resourceId, inputs: request.inputs });
    expect(harness.start).toHaveBeenCalledWith({ resourceId: identity.resourceId, inputs: request.inputs });
    expect(harness.status).toHaveBeenCalledWith("execution-42");
  });

  it("cancels and compensates through the same fixed Harness execution", async () => {
    const harness = harnessFixture();
    const subject = adapter(harness);
    await subject.preview(request);
    await subject.execute(request);

    await expect(subject.cancel(identityAndRequest())).resolves.toMatchObject({ status: "cancelled" });
    await expect(subject.compensate(identityAndRequest())).resolves.toMatchObject({ status: "cancelled" });
    expect(harness.cancel).toHaveBeenNthCalledWith(1, "execution-42");
    expect(harness.cancel).toHaveBeenNthCalledWith(2, "execution-42");
  });

  it("fences unknown outcomes and never retries after crossing the effect boundary", async () => {
    const harness = harnessFixture();
    vi.mocked(harness.start).mockRejectedValueOnce(new Error("timeout after send"));
    const subject = adapter(harness);
    await subject.preview(request);

    await expect(subject.execute(request)).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    await expect(subject.execute(request)).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    await expect(subject.status(identityAndRequest())).rejects.toBeInstanceOf(ActionOutcomeUnknownError);
    expect(harness.start).toHaveBeenCalledTimes(1);
    expect(harness.status).not.toHaveBeenCalled();
  });
});

function identityAndRequest() {
  return { ...identity, requestId: request.requestId };
}
