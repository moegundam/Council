import type { ToolPack } from "@council/contracts";

export type ToolPackRegistryItem = ToolPack;

export type ToolPackCommand = "edit" | "validate" | "approve" | "revoke";

export interface ToolPackUsageSummary {
  agentCount: number;
  grantCount: number;
  blockedAgentCount: number;
}

export interface ToolPackUsageAgent {
  id: string;
  blocked: boolean;
  grants: readonly { packId: string }[];
}

const statusLabels: Record<ToolPack["status"], string> = {
  draft: "草稿",
  validated: "待核准",
  approved: "已核准",
  revoked: "已撤銷"
};

const validationLabels: Record<ToolPack["validation"]["result"], string> = {
  pending: "待驗證",
  passed: "驗證通過",
  failed: "驗證失敗"
};

const toolKindLabels: Record<ToolPack["tools"][number]["kind"], string> = {
  command: "命令工具",
  function: "函式",
  library: "函式庫"
};

export function toolPackStatusLabel(status: ToolPack["status"]): string {
  return statusLabels[status];
}

export function toolPackValidationLabel(result: ToolPack["validation"]["result"]): string {
  return validationLabels[result];
}

export function toolPackToolKindLabel(kind: ToolPack["tools"][number]["kind"]): string {
  return toolKindLabels[kind];
}

export function toolPackStatusClass(status: ToolPack["status"]): string {
  if (status === "approved") return "approved";
  if (status === "revoked") return "revoked";
  if (status === "validated") return "ready";
  return "pending";
}

export function toolPackValidationClass(result: ToolPack["validation"]["result"]): string {
  if (result === "passed") return "approved";
  if (result === "failed") return "failed";
  return "pending";
}

export function maskToolPackDigest(digest: string | null | undefined): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest ?? "");
  const value = match?.[1];
  if (!value) return "未知";
  return `sha256:${value.slice(0, 8)}…${value.slice(-8)}`;
}

export function toolPackSourceName(sourceReference: string): string {
  const withoutDigest = sourceReference.replace(/@sha256:[a-f0-9]{64}$/i, "");
  const withoutQuery = withoutDigest.split(/[?#]/, 1)[0] ?? "";
  const segments = withoutQuery.split("/").filter(Boolean);
  const candidate = segments.at(-1) ?? withoutQuery.split("@").at(-1) ?? "";
  return candidate.trim() || "已遮罩來源";
}

export function redactToolPackSummary(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [已遮罩]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[已遮罩]")
    .replace(/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, "[已遮罩]");
}

export function availableToolPackCommands(
  pack: Pick<ToolPack, "status" | "validation" | "manifestDigest">
): ToolPackCommand[] {
  if (pack.status === "revoked") return [];
  if (pack.status === "approved") return ["revoke"];

  const commands: ToolPackCommand[] = ["edit", "validate"];
  if (pack.status === "validated"
    && pack.validation.result === "passed"
    && pack.validation.manifestDigest === pack.manifestDigest) {
    commands.push("approve");
  }
  return commands;
}

export function toolPackUsageSummary(
  agents: readonly ToolPackUsageAgent[],
  packId: string
): ToolPackUsageSummary {
  return agents.reduce<ToolPackUsageSummary>((summary, agent) => {
    const grantCount = agent.grants.filter((grant) => grant.packId === packId).length;
    if (grantCount === 0) return summary;
    return {
      agentCount: summary.agentCount + 1,
      grantCount: summary.grantCount + grantCount,
      blockedAgentCount: summary.blockedAgentCount + (agent.blocked ? 1 : 0)
    };
  }, { agentCount: 0, grantCount: 0, blockedAgentCount: 0 });
}

export function formatToolPackUsage(usage: ToolPackUsageSummary): string {
  return `${usage.agentCount} 個 Agent · ${usage.grantCount} 個綁定 · ${usage.blockedAgentCount} 個阻擋`;
}

export function toolPackLifecycleMessage(pack: Pick<ToolPack, "status" | "validation" | "manifestDigest">): string {
  if (pack.status === "approved") return "可綁定 Agent 草稿";
  if (pack.status === "revoked") return "已撤銷，既有綁定會被阻擋";
  if (pack.validation.result === "failed") return "驗證未通過";
  if (pack.status === "validated" && pack.validation.manifestDigest === pack.manifestDigest) {
    return "驗證通過，可進行核准";
  }
  return "等待目前 revision 驗證";
}
