import { describe, expect, it } from "vitest";
import type { ToolPack } from "@council/contracts";
import {
  availableToolPackCommands,
  formatToolPackUsage,
  maskToolPackDigest,
  redactToolPackSummary,
  toolPackSourceName,
  toolPackUsageSummary
} from "./tool-pack-ui.js";

const imageDigest = `sha256:${"a".repeat(64)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;

function buildPack(overrides: Partial<ToolPack> = {}): ToolPack {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    name: "Reader Pack",
    version: "1.4.0",
    description: "Approved read-only readers.",
    owner: "Platform",
    sourceReference: `ghcr.io/council/reader-pack@${imageDigest}`,
    imageDigest,
    manifestDigest,
    tools: [{
      name: "read-report",
      kind: "command",
      goal: "Read a governed report.",
      access: "read_only",
      argv: { executable: "/opt/tools/read-report", fixedArguments: ["--json"] },
      env: { allowedNames: [] },
      stdin: { mode: "json", maxBytes: 4_096 }
    }],
    revision: 3,
    status: "validated",
    validation: {
      result: "passed",
      summary: "All bounded checks passed.",
      checkedAt: "2026-08-03T03:00:00.000Z",
      manifestDigest
    },
    approvedAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: "2026-08-03T01:00:00.000Z",
    updatedAt: "2026-08-03T03:00:00.000Z",
    ...overrides
  };
}

describe("tool pack ui helpers", () => {
  it("shows only bounded source and digest identifiers", () => {
    expect(toolPackSourceName(`https://user:password@registry.example/team/reader-pack@${imageDigest}`))
      .toBe("reader-pack");
    expect(maskToolPackDigest(manifestDigest)).toBe("sha256:bbbbbbbb…bbbbbbbb");
    expect(maskToolPackDigest("not-a-digest")).toBe("未知");
  });

  it("derives commands from the governed lifecycle and matching validation", () => {
    expect(availableToolPackCommands(buildPack())).toEqual(["edit", "validate", "approve"]);
    expect(availableToolPackCommands(buildPack({
      validation: {
        result: "passed",
        summary: "Old validation.",
        checkedAt: "2026-08-03T02:00:00.000Z",
        manifestDigest: `sha256:${"c".repeat(64)}`
      }
    }))).toEqual(["edit", "validate"]);
    expect(availableToolPackCommands(buildPack({
      status: "approved",
      approvedAt: "2026-08-03T04:00:00.000Z"
    }))).toEqual(["revoke"]);
    expect(availableToolPackCommands(buildPack({
      status: "revoked",
      approvedAt: "2026-08-03T04:00:00.000Z",
      revokedAt: "2026-08-03T05:00:00.000Z",
      revocationReason: "Superseded"
    }))).toEqual([]);
  });

  it("summarizes unique Agent usage and redacts likely credentials", () => {
    const usage = toolPackUsageSummary([
      {
        id: "agent-a",
        blocked: false,
        grants: [{ packId: "70000000-0000-4000-8000-000000000001" }]
      },
      {
        id: "agent-b",
        blocked: true,
        grants: [
          { packId: "70000000-0000-4000-8000-000000000001" },
          { packId: "70000000-0000-4000-8000-000000000001" }
        ]
      },
      {
        id: "agent-c",
        blocked: false,
        grants: [{ packId: "80000000-0000-4000-8000-000000000001" }]
      }
    ], "70000000-0000-4000-8000-000000000001");

    expect(usage).toEqual({ agentCount: 2, grantCount: 3, blockedAgentCount: 1 });
    expect(formatToolPackUsage(usage)).toBe("2 個 Agent · 3 個綁定 · 1 個阻擋");
    expect(redactToolPackSummary("Bearer top-secret api_key=abc123 password: letmein"))
      .toBe("Bearer [已遮罩] api_key=[已遮罩] password=[已遮罩]");
  });
});
