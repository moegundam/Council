import {
  toolPackGrantIsCurrentAndApproved,
  toolPackGrantSchema,
  type AgentReadiness,
  type AgentReadinessCheck,
  type PlatformSnapshot
} from "@council/contracts";
import { resolveRuntimeProfileAdmission, RuntimeProfileAdmissionError } from "#runtime-policy";
import { credentialIsExpired } from "#credential-policy";

type UnknownRecord = Record<string, unknown>;
type ReadinessSnapshot = Omit<PlatformSnapshot, "credentials" | "prompts"> & {
  credentials?: UnknownRecord[];
  prompts?: UnknownRecord[];
};

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function check(
  code: AgentReadinessCheck["code"],
  status: AgentReadinessCheck["status"],
  message: string
): AgentReadinessCheck {
  return { code, status, message };
}

function promptVersionIsPublished(prompt: UnknownRecord, version: number): boolean {
  const versions = Array.isArray(prompt.versions) ? prompt.versions.map(record) : [];
  if (versions.length === 0) return (numberValue(prompt.publishedVersion) ?? -1) >= version;

  const exact = versions.find((entry) => numberValue(entry.version) === version);
  if (!exact) return false;
  return exact.status === "published" || exact.published === true || typeof exact.publishedAt === "string";
}

function evaluatePrompt(agent: UnknownRecord, snapshot: ReadinessSnapshot): AgentReadinessCheck {
  const binding = record(agent.promptBinding);
  const promptId = stringValue(binding.promptId);
  const version = numberValue(binding.version);
  const lifecycle = stringValue(agent.lifecycleStatus);

  if (!promptId || version === null) {
    if (lifecycle === "draft") return check("prompt", "blocked", "草稿 Agent 必須綁定已發布 Prompt。");
    return check("prompt", "warning", "沿用舊版 Agent Prompt，尚未建立版本綁定。");
  }

  const prompt = (snapshot.prompts ?? []).find((candidate) => candidate.id === promptId);
  if (!prompt) return check("prompt", "blocked", "找不到綁定的 Prompt。");
  const promptRecord = record(prompt);
  if (promptRecord.kind !== "agent") return check("prompt", "blocked", "Agent 只能綁定 Agent 類型的 Prompt。");
  if (promptRecord.status === "archived") return check("prompt", "blocked", "綁定的 Prompt 已封存。");

  const publishedVersion = numberValue(promptRecord.publishedVersion);
  if (publishedVersion === null || publishedVersion < version || !promptVersionIsPublished(promptRecord, version)) {
    return check("prompt", "blocked", "綁定的 Prompt 版本尚未發布。");
  }
  return check("prompt", "passed", "Prompt 版本已發布。");
}

function evaluateCredential(
  connector: UnknownRecord | undefined,
  snapshot: ReadinessSnapshot
): AgentReadinessCheck {
  if (!connector) return check("credential", "blocked", "沒有可檢查的模型 Connector 憑證。");

  const credentialId = stringValue(connector.credentialId);
  if (!credentialId) {
    if (connector.location === "local" && connector.hasSecret === false) {
      return check("credential", "passed", "地端 Connector 不需要雲端憑證。");
    }
    return check("credential", "blocked", "模型 Connector 未綁定有效憑證。");
  }

  const credential = (snapshot.credentials ?? []).find((candidate) => candidate.id === credentialId);
  if (!credential) return check("credential", "blocked", "找不到模型 Connector 憑證。");
  if (credential.status !== "active" || credential.hasSecret !== true) {
    return check("credential", "blocked", "模型 Connector 憑證未啟用或沒有密鑰。");
  }
  if (credentialIsExpired(credential.expiresAt)) {
    return check("credential", "blocked", "模型 Connector 憑證已過期。");
  }
  if (numberValue(credential.secretRevision) !== numberValue(connector.secretRevision)) {
    return check("credential", "blocked", "模型 Connector 憑證版本不一致。");
  }
  return check("credential", "passed", "模型 Connector 憑證有效。");
}

function evaluateSkills(agent: UnknownRecord, snapshot: ReadinessSnapshot): AgentReadinessCheck {
  const skillIds = Array.isArray(agent.skillIds) ? agent.skillIds.filter((id): id is string => typeof id === "string") : [];
  for (const skillId of skillIds) {
    const skill = snapshot.skills.find((candidate) => candidate.id === skillId);
    if (!skill) return check("skill", "blocked", "有 Skill 尚未註冊。");
    if (skill.status !== "approved") return check("skill", "blocked", "所有 Skill 必須已核准。");
    if (skill.validation.result !== "passed") return check("skill", "blocked", "所有 Skill 必須通過驗證。");
    if (skill.validation.contentDigest !== skill.contentDigest) return check("skill", "blocked", "Skill 內容摘要已變更，請重新驗證。");
  }
  return check("skill", "passed", skillIds.length === 0 ? "未綁定 Skill。" : "所有 Skill 均已核准且驗證有效。");
}

function evaluateTools(agent: UnknownRecord, snapshot: ReadinessSnapshot): AgentReadinessCheck {
  const grants = Array.isArray(agent.toolGrants) ? agent.toolGrants.map(record) : [];
  for (const grant of grants) {
    const connectorId = stringValue(grant.connectorId);
    const toolName = stringValue(grant.toolName);
    const connector = snapshot.mcpConnectors.find((candidate) => candidate.id === connectorId);
    if (!connector || !connector.enabled) return check("tool", "blocked", "有工具授權指向未啟用的 MCP Connector。");
    if (!toolName || !connector.approvedTools.includes(toolName)) return check("tool", "blocked", "有工具未列入 MCP 核准白名單。");
    if (!connector.toolRegistrations.some((registration) => registration.toolName === toolName)) {
      return check("tool", "blocked", "有工具尚未完成 MCP 註冊。");
    }
  }
  const toolPackGrants = Array.isArray(agent.toolPackGrants) ? agent.toolPackGrants : [];
  for (const rawGrant of toolPackGrants) {
    const grant = toolPackGrantSchema.safeParse(rawGrant);
    if (!grant.success || !toolPackGrantIsCurrentAndApproved(grant.data, snapshot.toolPacks ?? [])) {
      return check("tool", "blocked", "有 Tool Pack 授權不是目前已核准的唯讀工具版本。");
    }
  }
  const grantCount = grants.length + toolPackGrants.length;
  return check("tool", "passed", grantCount === 0 ? "未綁定外部工具。" : "所有工具授權均已核准並完成註冊。");
}

function runtimeBlockedMessage(error: unknown): string {
  if (!(error instanceof RuntimeProfileAdmissionError)) {
    return "Runtime Profile 無法通過執行許可檢查。";
  }
  switch (error.reason) {
    case "binding_missing":
      return "Agent 尚未綁定 Runtime Profile。";
    case "profile_unavailable":
      return "Runtime Profile 不存在或已停用。";
    case "revision_unavailable":
      return "找不到綁定的 Runtime Profile 版本。";
    case "revision_disabled":
      return "綁定的 Runtime Profile 版本已停用。";
    case "model_mismatch":
      return "Runtime Profile 與 Agent 模型綁定不一致。";
    case "isolation_unattested":
      return "Runtime Profile 的隔離執行環境尚未通過驗證。";
    case "snapshot_mismatch":
      return "Runtime Profile 執行快照已失效。";
    default:
      return "Runtime Profile 無法通過執行許可檢查。";
  }
}

function evaluateRuntime(
  agent: UnknownRecord,
  snapshot: ReadinessSnapshot,
  executionIsolationAttested: boolean | undefined
): AgentReadinessCheck {
  const binding = record(agent.runtimeProfileBinding);
  const profileId = stringValue(binding.profileId);
  const revisionNumber = numberValue(binding.revision);
  try {
    const admitted = resolveRuntimeProfileAdmission({
      binding: profileId && revisionNumber !== null ? { profileId, revision: revisionNumber } : null,
      platform: snapshot,
      agentModelConnectorId: stringValue(agent.modelConnectorId),
      executionIsolationAttested
    });
    return check("runtime", "passed", `Runtime Profile Rev ${admitted.revision} 可用。`);
  } catch (error) {
    return check("runtime", "blocked", runtimeBlockedMessage(error));
  }
}

export function evaluateAgentReadiness(
  snapshot: PlatformSnapshot,
  agentId: string,
  options: { executionIsolationAttested?: boolean } = {}
): AgentReadiness {
  const readinessSnapshot = snapshot as unknown as ReadinessSnapshot;
  const agent = readinessSnapshot.agents.find((candidate) => candidate.id === agentId);
  const agentRecord = record(agent);
  const lifecycle = stringValue(agentRecord.lifecycleStatus);
  const hasPublishedRevision = numberValue(agentRecord.publishedRevision) !== null;
  const agentCheck = !agent
    ? check("lifecycle", "blocked", "找不到 Agent。")
    : lifecycle === "disabled" || agent.status === "offline"
      ? check("lifecycle", "blocked", "Agent 已停用。")
      : lifecycle === "draft"
        ? hasPublishedRevision
          ? check("lifecycle", "warning", "有尚未發布的草稿；正式執行仍使用上一個已發布版本。")
          : check("lifecycle", "blocked", "草稿 Agent 尚未發布。")
        : check("lifecycle", "passed", "Agent 已可供檢查。");

  const connector = agent?.modelConnectorId
    ? readinessSnapshot.modelConnectors.find((candidate) => candidate.id === agent.modelConnectorId)
    : undefined;
  const connectorCheck = !agent
    ? check("model", "blocked", "Agent 不存在，無法解析模型 Connector。")
    : !connector || !connector.enabled
      ? check("model", "blocked", "模型 Connector 不存在或已停用。")
      : check("model", "passed", "模型 Connector 已啟用。");

  const checks = [
    agentCheck,
    agent
      ? evaluateRuntime(agentRecord, readinessSnapshot, options.executionIsolationAttested)
      : check("runtime", "blocked", "Agent 不存在，無法解析 Runtime Profile。"),
    connectorCheck,
    evaluateCredential(connector ? record(connector) : undefined, readinessSnapshot),
    agent ? evaluatePrompt(agentRecord, readinessSnapshot) : check("prompt", "blocked", "Agent 不存在，無法解析 Prompt。"),
    agent ? evaluateSkills(agentRecord, readinessSnapshot) : check("skill", "blocked", "Agent 不存在，無法解析 Skill。"),
    agent ? evaluateTools(agentRecord, readinessSnapshot) : check("tool", "blocked", "Agent 不存在，無法解析工具。")
  ];
  const blocked = checks.some((item) => item.status === "blocked");
  const warning = checks.some((item) => item.status === "warning");
  return {
    status: blocked ? "blocked" : warning ? "warning" : "ready",
    checks
  };
}
