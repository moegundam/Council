import type { Agent, AgentLifecycleStatus, McpConnector, PromptBinding, PromptTemplate, ToolRegistration } from "@council/contracts";

export type AgentEditableDraft = Pick<
  Agent,
  | "name"
  | "description"
  | "modelConnectorId"
  | "goalSummary"
  | "toolsSummary"
  | "dataSummary"
  | "skillIds"
  | "toolGrants"
  | "toolPackGrants"
  | "runtimeProfileBinding"
> & { promptBinding: PromptBinding | null };

const agentEditableFields: Array<keyof AgentEditableDraft> = [
  "name",
  "description",
  "modelConnectorId",
  "goalSummary",
  "toolsSummary",
  "dataSummary",
  "skillIds",
  "toolGrants",
  "toolPackGrants",
  "runtimeProfileBinding",
  "promptBinding"
];

export function agentEditableDraft(agent: Agent): AgentEditableDraft {
  return structuredClone({
    name: agent.name,
    description: agent.description,
    modelConnectorId: agent.modelConnectorId,
    goalSummary: agent.goalSummary,
    toolsSummary: agent.toolsSummary,
    dataSummary: agent.dataSummary,
    skillIds: agent.skillIds,
    toolGrants: agent.toolGrants,
    toolPackGrants: agent.toolPackGrants,
    runtimeProfileBinding: agent.runtimeProfileBinding,
    promptBinding: agent.promptBinding ?? null
  });
}

function agentDraftValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeAgentDraftAfterConflict(
  base: AgentEditableDraft,
  local: AgentEditableDraft,
  latest: AgentEditableDraft
): { draft: AgentEditableDraft; conflictingFields: Array<keyof AgentEditableDraft> } {
  const draft = structuredClone(latest);
  const conflictingFields: Array<keyof AgentEditableDraft> = [];
  for (const field of agentEditableFields) {
    const localChanged = !agentDraftValueEqual(local[field], base[field]);
    const remoteChanged = !agentDraftValueEqual(latest[field], base[field]);
    if (!localChanged) continue;
    if (!remoteChanged || agentDraftValueEqual(local[field], latest[field])) {
      (draft as Record<string, unknown>)[field] = structuredClone(local[field]);
      continue;
    }
    conflictingFields.push(field);
  }
  return { draft, conflictingFields };
}

export interface AgentPromptBindingOption {
  key: string;
  binding: PromptBinding;
  label: string;
}

export interface ApprovedAgentToolOption {
  connector: McpConnector;
  registration: ToolRegistration;
}

export function approvedAgentToolOptions(connectors: readonly McpConnector[]): ApprovedAgentToolOption[] {
  return connectors.flatMap((connector) => connector.enabled
    ? connector.toolRegistrations
      .filter((registration) => connector.approvedTools.includes(registration.toolName))
      .map((registration) => ({ connector, registration }))
    : []);
}

export function serializeAgentPromptBinding(binding: PromptBinding | null | undefined): string {
  return binding ? `${binding.promptId}:${binding.version}` : "";
}

export function parseAgentPromptBindingKey(value: string): PromptBinding | null | undefined {
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  const promptId = value.slice(0, separator);
  const version = Number(value.slice(separator + 1));
  return promptId && Number.isInteger(version) && version > 0
    ? { promptId, version }
    : undefined;
}

export function agentPromptBindingOptions(
  prompts: readonly PromptTemplate[],
  currentBinding: PromptBinding | null | undefined
): AgentPromptBindingOption[] {
  const currentKey = serializeAgentPromptBinding(currentBinding);
  const options = prompts
    .filter((prompt) => prompt.kind === "agent" && prompt.status !== "archived" && prompt.publishedVersion !== null)
    .map((prompt) => {
      const binding = { promptId: prompt.id, version: prompt.publishedVersion! };
      const key = serializeAgentPromptBinding(binding);
      return {
        key,
        binding,
        label: `${prompt.name} · v${binding.version}${key === currentKey ? " · 目前綁定" : ""}`
      };
    });

  if (!currentBinding || options.some((option) => option.key === currentKey)) return options;

  const currentPrompt = prompts.find((prompt) => prompt.id === currentBinding.promptId);
  const state = !currentPrompt
    ? "Prompt 不存在"
    : currentPrompt.kind !== "agent"
      ? "類型不符"
      : currentPrompt.status === "archived"
        ? "已封存"
        : "歷史版本";
  options.push({
    key: currentKey,
    binding: currentBinding,
    label: `${currentPrompt?.name ?? currentBinding.promptId} · v${currentBinding.version} · 目前綁定 · ${state}`
  });
  return options;
}

export function canEditAgentManagementItem(status: "active" | "archived"): boolean {
  return status === "active";
}

export function agentStatusTransition(
  agent: Pick<Agent, "lifecycleStatus" | "publishedRevision">
): AgentLifecycleStatus | null {
  if (agent.lifecycleStatus === "disabled") {
    return agent.publishedRevision == null ? "draft" : "published";
  }
  return agent.publishedRevision == null ? null : "disabled";
}
