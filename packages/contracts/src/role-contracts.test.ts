import { describe, expect, it } from "vitest";
import {
  builtInRoleTemplates,
  createRoleExecutionSnapshot,
  createRoleSchema,
  createRoleVersion,
  roleDataPolicies,
  roleOrchestrationFunctions,
  roleTemplateKeys,
  roleToolPolicies,
  rollbackRoleSchema,
  switchParticipantRoleSchema,
  updateRoleRequestSchema,
  updateRoleSchema
} from "./index.js";

const customRole = {
  name: "研究主持",
  usageContext: "用於需要收斂研究問題與查核證據的會議。",
  responsibility: "收斂研究問題與證據。",
  speakingGuidance: "先引用證據，再提出下一個問題。",
  decisionScope: "可整理候選決議，不代替擁有者核准。",
  constraints: "不得把推論描述為事實。"
};

describe("Role contracts", () => {
  it("publishes four unique, complete built-in Role templates", () => {
    expect(builtInRoleTemplates).toHaveLength(4);
    expect(new Set(builtInRoleTemplates.map((template) => template.key)).size).toBe(4);
    expect(builtInRoleTemplates.map((template) => template.key)).toEqual(roleTemplateKeys);
    expect(Object.fromEntries(builtInRoleTemplates.map((template) => [template.key, template.orchestrationFunctions]))).toEqual({
      platform_architect: ["planner", "worker"],
      meeting_chair: ["chair", "planner"],
      security_reviewer: ["reviewer"],
      evidence_analyst: ["reviewer"]
    });
    for (const template of builtInRoleTemplates) {
      expect(template).toMatchObject({
        name: expect.any(String),
        usageContext: expect.any(String),
        responsibility: expect.any(String),
        speakingGuidance: expect.any(String),
        decisionScope: expect.any(String),
        constraints: expect.any(String)
      });
      expect(roleToolPolicies).toContain(template.toolPolicy);
      expect(roleDataPolicies).toContain(template.dataPolicy);
      expect(template.orchestrationFunctions.every((capability) => roleOrchestrationFunctions.includes(capability))).toBe(true);
    }
  });

  it("defaults a custom Role to the least-privilege policy and keeps server fields protected", () => {
    expect(createRoleSchema.parse(customRole)).toEqual({
      ...customRole,
      templateKey: null,
      toolPolicy: "none",
      dataPolicy: "meeting_only",
      orchestrationFunctions: []
    });
    expect(() => createRoleSchema.parse({ ...customRole, version: 99 })).toThrow();
    expect(() => createRoleSchema.parse({ ...customRole, deletedAt: "2026-07-20T00:00:00.000Z" })).toThrow();
    expect(() => createRoleSchema.parse({ ...customRole, templateKey: "unknown" })).toThrow();
  });

  it("keeps legacy create payloads compatible without inventing Role context", () => {
    const { usageContext: _usageContext, ...legacyCustomRole } = customRole;
    expect(createRoleSchema.parse(legacyCustomRole)).toMatchObject({
      usageContext: legacyCustomRole.responsibility,
      templateKey: null
    });
    expect(createRoleSchema.parse({ ...legacyCustomRole, templateKey: "evidence_analyst" })).toMatchObject({
      usageContext: "用於彙整來源、驗證主張與指出證據缺口。",
      templateKey: "evidence_analyst"
    });
    expect(createRoleSchema.parse({ ...customRole, usageContext: "x".repeat(1000) }).usageContext).toHaveLength(1000);
    expect(() => createRoleSchema.parse({ ...customRole, usageContext: "x".repeat(1001) })).toThrow();
  });

  it("accepts only bounded Role policy updates", () => {
    expect(updateRoleSchema.parse({
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "agent_declared_scope"
    })).toEqual({
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "agent_declared_scope"
    });
    expect(() => updateRoleSchema.parse({ version: 2 })).toThrow();
    expect(() => updateRoleSchema.parse({ toolPolicy: "shell" })).toThrow();
    expect(() => updateRoleSchema.parse({
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "meeting_only"
    })).toThrow(/declared data scope/i);
  });

  it("rejects a Role that advertises external tools without external data scope", () => {
    expect(() => createRoleSchema.parse({
      ...customRole,
      toolPolicy: "agent_read_only_grants",
      dataPolicy: "meeting_only"
    })).toThrow(/declared data scope/i);
  });

  it("accepts only a server-resolved historical version for rollback", () => {
    expect(rollbackRoleSchema.parse({ version: 2, expectedCurrentVersion: 4 })).toEqual({ version: 2, expectedCurrentVersion: 4 });
    expect(() => rollbackRoleSchema.parse({ version: 0, expectedCurrentVersion: 4 })).toThrow();
    expect(() => rollbackRoleSchema.parse({ version: 1 })).toThrow();
    expect(() => rollbackRoleSchema.parse({ version: 1, expectedCurrentVersion: 4, responsibility: "forged" })).toThrow();
  });

  it("requires a current-version precondition for Role edits", () => {
    expect(updateRoleRequestSchema.parse({ usageContext: "新版適用情境", responsibility: "新版職責", expectedCurrentVersion: 2 })).toEqual({
      usageContext: "新版適用情境",
      responsibility: "新版職責",
      expectedCurrentVersion: 2
    });
    expect(() => updateRoleRequestSchema.parse({ responsibility: "新版職責" })).toThrow();
    expect(() => updateRoleRequestSchema.parse({ expectedCurrentVersion: 2 })).toThrow(/Role field/i);
  });

  it("copies usage context into immutable Role version and execution snapshots", () => {
    const role = {
      id: "60000000-0000-4000-8000-000000000099",
      ...createRoleSchema.parse(customRole),
      version: 3,
      deletedAt: null
    };

    expect(createRoleVersion(role, "updated")).toMatchObject({
      version: 3,
      usageContext: customRole.usageContext
    });
    expect(createRoleExecutionSnapshot(role)).toMatchObject({
      version: 3,
      usageContext: customRole.usageContext,
      source: "meeting_created"
    });
    expect(createRoleExecutionSnapshot(role, "meeting_role_switched")).toMatchObject({
      version: 3,
      source: "meeting_role_switched"
    });
  });

  it("pins orchestration functions in Meeting Role snapshots", () => {
    const role = {
      id: "60000000-0000-4000-8000-000000000098",
      ...createRoleSchema.parse({ ...customRole, orchestrationFunctions: ["reviewer"] }),
      version: 2,
      deletedAt: null
    };

    const snapshot = createRoleExecutionSnapshot(role);
    expect(snapshot.orchestrationFunctions).toEqual(["reviewer"]);
    role.orchestrationFunctions.push("worker");
    expect(snapshot.orchestrationFunctions).toEqual(["reviewer"]);
  });

  it("requires a bounded reason and current assignment revision for a Meeting Role switch", () => {
    expect(switchParticipantRoleSchema.parse({
      roleId: "60000000-0000-4000-8000-000000000099",
      expectedRoleRevision: 2,
      reason: "  改由證據分析師收斂來源。  "
    })).toEqual({
      roleId: "60000000-0000-4000-8000-000000000099",
      expectedRoleRevision: 2,
      reason: "改由證據分析師收斂來源。"
    });
    expect(() => switchParticipantRoleSchema.parse({
      roleId: "60000000-0000-4000-8000-000000000099",
      expectedRoleRevision: 0,
      reason: "invalid"
    })).toThrow();
    expect(() => switchParticipantRoleSchema.parse({
      roleId: "60000000-0000-4000-8000-000000000099",
      expectedRoleRevision: 2,
      reason: "",
      roleSnapshot: {}
    })).toThrow();
  });
});
