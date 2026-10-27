import { describe, expect, it, vi } from "vitest";
import { GuardedExternalExecutor, type ExternalExecutorBackend } from "./external-executor.js";

const request = {
  resourceId: "deploy_preview",
  inputs: { environment: "preview" },
  idempotencyKey: "preview-42"
};

function backendFixture() {
  return {
    validate: vi.fn(async () => undefined),
    start: vi.fn(async () => ({ executionId: "execution-42", status: "queued" as const })),
    status: vi.fn(async () => ({ executionId: "execution-42", status: "running" as const })),
    cancel: vi.fn(async () => ({ executionId: "execution-42", status: "cancelled" as const }))
  } satisfies ExternalExecutorBackend;
}

describe("guarded external executor", () => {
  it("delegates validate, start, status, and cancel for an enabled allowlisted resource", async () => {
    const backend = backendFixture();
    const executor = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: [request.resourceId]
    }, backend);

    await expect(executor.validate(request)).resolves.toBeUndefined();
    await expect(executor.start(request)).resolves.toEqual({ executionId: "execution-42", status: "queued" });
    await expect(executor.status("execution-42")).resolves.toEqual({ executionId: "execution-42", status: "running" });
    await expect(executor.cancel("execution-42")).resolves.toEqual({ executionId: "execution-42", status: "cancelled" });

    expect(backend.validate).toHaveBeenCalledOnce();
    expect(backend.validate).toHaveBeenCalledWith(request);
    expect(backend.start).toHaveBeenCalledOnce();
    expect(backend.start).toHaveBeenCalledWith(request);
    expect(backend.status).toHaveBeenCalledWith("execution-42");
    expect(backend.cancel).toHaveBeenCalledWith("execution-42");
  });

  it("rejects Harness operations while disabled without reaching the backend", async () => {
    const backend = backendFixture();
    const executor = new GuardedExternalExecutor({
      enabled: false,
      allowedResourceIds: ["deploy_preview"]
    }, backend);

    await expect(executor.validate(request)).rejects.toMatchObject({
      name: "ExternalExecutionPolicyError",
      message: expect.stringMatching(/disabled/i)
    });
    await expect(executor.start(request)).rejects.toMatchObject({ name: "ExternalExecutionPolicyError" });
    await expect(executor.status("execution-42")).rejects.toMatchObject({ name: "ExternalExecutionPolicyError" });
    await expect(executor.cancel("execution-42")).rejects.toMatchObject({ name: "ExternalExecutionPolicyError" });
    expect(backend.validate).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.status).not.toHaveBeenCalled();
    expect(backend.cancel).not.toHaveBeenCalled();
  });

  it("rejects resources outside the allowlist before reaching the backend", async () => {
    const backend = backendFixture();
    const executor = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: ["deploy_preview"]
    }, backend);

    const deniedRequest = { resourceId: "production_delete", inputs: {} };
    await expect(executor.validate(deniedRequest)).rejects.toMatchObject({
      name: "ExternalExecutionPolicyError",
      message: expect.stringMatching(/allowlist/i)
    });
    await expect(executor.start(deniedRequest)).rejects.toMatchObject({ name: "ExternalExecutionPolicyError" });
    expect(backend.validate).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.status).not.toHaveBeenCalled();
    expect(backend.cancel).not.toHaveBeenCalled();
  });

  it("preserves backend validation failures as non-policy errors", async () => {
    const backend = backendFixture();
    const validationFailure = new Error("private backend validation network diagnostic");
    backend.validate.mockRejectedValue(validationFailure);
    const executor = new GuardedExternalExecutor({
      enabled: true,
      allowedResourceIds: [request.resourceId]
    }, backend);

    await expect(executor.validate(request)).rejects.toBe(validationFailure);
    expect(validationFailure.name).toBe("Error");
    expect(backend.start).not.toHaveBeenCalled();
  });
});
