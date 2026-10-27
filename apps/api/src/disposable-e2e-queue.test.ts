import { describe, expect, it } from "vitest";
import {
  disposableE2eAgentQueueFromEnv,
  disposableE2eOwnerSeedFromEnv,
  disposableE2eTestLoginEnabledFromEnv
} from "./disposable-e2e-queue.js";

const marker = "council-agent-meeting-platform-disposable-e2e-v1";

describe("disposable E2E Agent queue", () => {
  it("is absent unless the disposable deployment class is explicit", () => {
    expect(disposableE2eAgentQueueFromEnv({ NODE_ENV: "development" })).toBeUndefined();
  });

  it("fails closed for a bad marker, production, or a real Redis queue", () => {
    expect(() => disposableE2eAgentQueueFromEnv({ E2E_DEPLOYMENT_CLASS: "disposable", NODE_ENV: "development" })).toThrow(/marker/i);
    expect(() => disposableE2eAgentQueueFromEnv({ E2E_DEPLOYMENT_CLASS: "disposable", E2E_DISPOSABLE_MARKER: marker, NODE_ENV: "production" })).toThrow(/production/i);
    expect(() => disposableE2eAgentQueueFromEnv({ E2E_DEPLOYMENT_CLASS: "disposable", E2E_DISPOSABLE_MARKER: marker, NODE_ENV: "development", REDIS_URL: "redis://127.0.0.1:6379" })).toThrow(/Redis/i);
  });

  it("accepts stable requested IDs only in a valid disposable run", async () => {
    const queue = disposableE2eAgentQueueFromEnv({
      E2E_DEPLOYMENT_CLASS: "disposable",
      E2E_DISPOSABLE_MARKER: marker,
      NODE_ENV: "development"
    });
    expect(queue).toBeDefined();
    await expect(queue!.enqueueGoalOrchestrate!({
      goalRunId: "90000000-0000-4000-8000-000000000001",
      expectedRevision: 1,
      requestFingerprint: "a".repeat(64),
      requestedBy: "owner"
    }, "goal-job-1")).resolves.toEqual({ jobId: "goal-job-1" });
  });

  it("exposes an Owner seed only with explicit disposable credentials", () => {
    expect(disposableE2eOwnerSeedFromEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(() => disposableE2eOwnerSeedFromEnv({
      E2E_DEPLOYMENT_CLASS: "disposable",
      E2E_DISPOSABLE_MARKER: marker,
      NODE_ENV: "development"
    })).toThrow(/credentials/i);
    expect(disposableE2eOwnerSeedFromEnv({
      E2E_DEPLOYMENT_CLASS: "disposable",
      E2E_DISPOSABLE_MARKER: marker,
      E2E_OWNER_EMAIL: "owner@disposable.test",
      E2E_OWNER_PASSWORD: "disposable-owner-password",
      NODE_ENV: "development"
    })).toEqual({ email: "owner@disposable.test", password: "disposable-owner-password" });
  });

  it("enables direct test login only inside an explicitly marked non-production disposable runtime", () => {
    expect(disposableE2eTestLoginEnabledFromEnv({ NODE_ENV: "development" })).toBe(false);
    expect(disposableE2eTestLoginEnabledFromEnv({ TEST_LOGIN_ENABLED: "false", NODE_ENV: "production" })).toBe(false);
    expect(() => disposableE2eTestLoginEnabledFromEnv({
      TEST_LOGIN_ENABLED: "true",
      E2E_DEPLOYMENT_CLASS: "production",
      E2E_DISPOSABLE_MARKER: marker,
      NODE_ENV: "development"
    })).toThrow(/deployment class/i);
    expect(() => disposableE2eTestLoginEnabledFromEnv({
      TEST_LOGIN_ENABLED: "true",
      E2E_DEPLOYMENT_CLASS: "disposable",
      NODE_ENV: "development"
    })).toThrow(/marker/i);
    expect(() => disposableE2eTestLoginEnabledFromEnv({
      TEST_LOGIN_ENABLED: "true",
      E2E_DEPLOYMENT_CLASS: "disposable",
      E2E_DISPOSABLE_MARKER: marker,
      NODE_ENV: "production"
    })).toThrow(/production/i);
    expect(disposableE2eTestLoginEnabledFromEnv({
      TEST_LOGIN_ENABLED: "true",
      E2E_DEPLOYMENT_CLASS: "disposable",
      E2E_DISPOSABLE_MARKER: marker,
      NODE_ENV: "development"
    })).toBe(true);
  });
});
