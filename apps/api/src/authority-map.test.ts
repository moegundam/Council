import { describe, expect, it } from "vitest";
import { createApiContractCapabilities } from "@council/contracts/openapi-contracts";
import {
  assertApiAuthorityCoverage,
  createApiAuthorityMap
} from "./authority-map.js";

describe("API AuthorityMap", () => {
  it("classifies every current operation exactly once and fails closed on route drift", () => {
    const authorityMap = createApiAuthorityMap();
    const keys = authorityMap.map(({ method, path }) => `${method} ${path}`);

    expect(authorityMap).toHaveLength(126);
    expect(new Set(keys).size).toBe(authorityMap.length);
    expect(new Set(authorityMap.map(({ operationId }) => operationId)).size).toBe(authorityMap.length);
    expect(() => assertApiAuthorityCoverage(authorityMap.map(({ method, path }) => ({ method, path })))).not.toThrow();
    expect(() => assertApiAuthorityCoverage([
      ...authorityMap.map(({ method, path }) => ({ method, path })),
      { method: "POST", path: "/api/unclassified" }
    ])).toThrow(/unclassified registered route/i);
    expect(() => assertApiAuthorityCoverage(authorityMap.slice(1).map(({ method, path }) => ({ method, path }))))
      .toThrow(/authority route is not registered/i);

    const typedOperationIds = new Set(createApiContractCapabilities().map(({ operationId }) => operationId));
    expect(authorityMap.filter(({ operationId }) => typedOperationIds.has(operationId))).toHaveLength(121);
  });

  it("keeps Runtime Run observation and control under the Owner authority surface", () => {
    const authorityMap = createApiAuthorityMap();
    const capabilityByOperation = new Map(
      createApiContractCapabilities().map((capability) => [capability.operationId, capability])
    );

    expect(authorityMap.filter(({ caller }) => caller === "agent_runtime")).toEqual([]);
    expect(authorityMap.filter(({ caller }) => caller === "public").map(({ operationId }) => operationId).sort())
      .toEqual(["getHealthLive", "getHealthReady", "loginOwner", "tailnetLoginOwner", "testLoginOwner"]);
    expect(authorityMap.filter(({ caller }) => caller === "owner_session").length).toBe(121);
    for (const operationId of [
      "getRuntimeRun",
      "getTaskRuntimeRun",
      "listRuntimeRunEvents",
      "steerRuntimeRun",
      "pauseRuntimeRun",
      "resumeRuntimeRun",
      "cancelRuntimeRun"
    ]) {
      expect(authorityMap.find((entry) => entry.operationId === operationId), operationId)
        .toMatchObject({ caller: "owner_session" });
    }
    for (const entry of authorityMap) {
      const capability = capabilityByOperation.get(entry.operationId);
      if (!capability) continue;
      expect(capability.security === "public", entry.operationId).toBe(entry.caller === "public");
    }
  });

  it("reserves governance and execution triggers for the owner control plane", () => {
    const byOperation = new Map(createApiAuthorityMap().map((entry) => [entry.operationId, entry]));
    const governanceOperations = [
      "publishAgent",
      "rollbackAgent",
      "setAgentStatus",
      "validateSkill",
      "setSkillStatus",
      "revokeSkill",
      "rollbackRole",
      "deleteRole",
      "approveDecision",
      "rejectDecision",
      "setTaskApproval",
      "createCredential",
      "updateCredential",
      "rotateCredential",
      "setCredentialStatus",
      "authorizeTool",
      "validateToolPack",
      "approveToolPack",
      "revokeToolPack",
      "publishPrompt",
      "rollbackPrompt",
      "archivePrompt",
      "createActionAdapter"
    ];
    for (const operationId of governanceOperations) {
      expect(byOperation.get(operationId), operationId).toMatchObject({
        caller: "owner_session",
        effect: "govern"
      });
    }

    for (const operationId of [
      "runMeetingAgent",
      "runMeetingTool",
      "runTaskAgent",
      "syncTask",
      "retryMeetingSummary"
    ]) {
      expect(byOperation.get(operationId), operationId).toMatchObject({
        caller: "owner_session",
        effect: "enqueue"
      });
    }
    expect(byOperation.get("startHarnessExecution")).toMatchObject({
      caller: "owner_session",
      effect: "enqueue"
    });
  });
});
