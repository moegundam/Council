import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ToolPackRevision } from "@council/contracts";
import type { ToolPackRegistryItem } from "../lib/tool-pack-ui.js";
import { ToolPackRegistry } from "./tool-pack-registry";

const imageDigest = `sha256:${"a".repeat(64)}`;
const manifestDigest = `sha256:${"b".repeat(64)}`;

function buildPack(overrides: Partial<ToolPackRegistryItem> = {}): ToolPackRegistryItem {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    name: "Reader Pack",
    version: "1.4.0",
    description: "Governed report readers.",
    owner: "Platform",
    sourceReference: `ghcr.io/council/reader-pack@${imageDigest}`,
    imageDigest,
    manifestDigest,
    tools: [{
      name: "read-report",
      kind: "command",
      goal: "讀取已核准的會議報告",
      access: "read_only",
      argv: { executable: "/opt/tools/read-report", fixedArguments: ["--json"] },
      env: { allowedNames: [] },
      stdin: { mode: "json", maxBytes: 4_096 }
    }],
    revision: 3,
    status: "validated",
    validation: {
      result: "passed",
      summary: "Checks passed. token=do-not-render",
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

function buildRevision(pack: ToolPackRegistryItem, revision: number): ToolPackRevision {
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = pack;
  return {
    packId: id,
    ...content,
    revision,
    source: revision === pack.revision ? "validated" : "created",
    recordedAt: revision === pack.revision
      ? "2026-08-03T03:00:00.000Z"
      : "2026-08-03T01:00:00.000Z"
  };
}

function findButton(node: ReactNode, ariaLabel: string): ReactElement<{ onClick?: () => void }> | null {
  if (!isValidElement(node)) return null;
  const props = node.props as { children?: ReactNode; "aria-label"?: string; onClick?: () => void };
  if (node.type === "button" && props["aria-label"] === ariaLabel) {
    return node as ReactElement<{ onClick?: () => void }>;
  }
  for (const child of Children.toArray(props.children)) {
    const found = findButton(child, ariaLabel);
    if (found) return found;
  }
  return null;
}

describe("ToolPackRegistry", () => {
  it("renders governed list and detail data without execution or sensitive values", () => {
    const pack = buildPack();
    const markup = renderToStaticMarkup(createElement(ToolPackRegistry, {
      packs: [pack],
      revisions: [buildRevision(pack, 3), buildRevision(pack, 2)],
      selectedPackId: pack.id,
      readUsage: () => ({ agentCount: 2, grantCount: 3, blockedAgentCount: 1 }),
      pending: false,
      onSelect() {},
      onCreate() {},
      onValidate() {},
      onApprove() {},
      onRevoke() {},
      onEdit() {}
    }));

    expect(markup).toContain("Tool Packs");
    expect(markup).toContain("v1.4.0");
    expect(markup).toContain("Rev 3");
    expect(markup).toContain("驗證通過");
    expect(markup).toContain("讀取已核准的會議報告");
    expect(markup).toContain("2 個 Agent · 3 個綁定 · 1 個阻擋");
    expect(markup).toContain("2 個版本記錄");
    expect(markup).toContain("sha256:bbbbbbbb…bbbbbbbb");
    expect(markup).not.toContain(manifestDigest);
    expect(markup).not.toContain(imageDigest);
    expect(markup).not.toContain("/opt/tools/read-report");
    expect(markup).not.toContain("do-not-render");
    expect(markup).not.toContain("執行</button>");
    expect(markup).toContain("記錄驗證");
    expect(markup).toContain("核准");
    expect(markup).toContain("編輯");
    expect(markup).not.toContain("撤銷</button>");
  });

  it("wires only lifecycle-allowed callback commands", () => {
    const pack = buildPack();
    const onValidate = vi.fn();
    const onApprove = vi.fn();
    const onEdit = vi.fn();
    const element = ToolPackRegistry({
      packs: [pack],
      revisions: [buildRevision(pack, 3)],
      selectedPackId: pack.id,
      readUsage: () => ({ agentCount: 0, grantCount: 0, blockedAgentCount: 0 }),
      pending: false,
      onSelect() {},
      onCreate() {},
      onValidate,
      onApprove,
      onRevoke() {},
      onEdit
    });

    findButton(element, `記錄 ${pack.name} 驗證`)?.props.onClick?.();
    findButton(element, `核准 ${pack.name}`)?.props.onClick?.();
    findButton(element, `編輯 ${pack.name}`)?.props.onClick?.();

    expect(onValidate).toHaveBeenCalledWith(pack);
    expect(onApprove).toHaveBeenCalledWith(pack);
    expect(onEdit).toHaveBeenCalledWith(pack);
    expect(findButton(element, `撤銷 ${pack.name}`)).toBeNull();
  });

  it("offers revocation only for an approved Pack", () => {
    const pack = buildPack({
      status: "approved",
      approvedAt: "2026-08-03T04:00:00.000Z"
    });
    const onRevoke = vi.fn();
    const element = ToolPackRegistry({
      packs: [pack],
      revisions: [buildRevision(pack, 3)],
      selectedPackId: pack.id,
      readUsage: () => ({ agentCount: 1, grantCount: 1, blockedAgentCount: 0 }),
      pending: false,
      onSelect() {},
      onCreate() {},
      onValidate() {},
      onApprove() {},
      onRevoke,
      onEdit() {}
    });

    findButton(element, `撤銷 ${pack.name}`)?.props.onClick?.();

    expect(onRevoke).toHaveBeenCalledWith(pack);
    expect(findButton(element, `核准 ${pack.name}`)).toBeNull();
    expect(findButton(element, `記錄 ${pack.name} 驗證`)).toBeNull();
    expect(findButton(element, `編輯 ${pack.name}`)).toBeNull();
  });
});
