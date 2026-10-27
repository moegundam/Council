import type {
  Agent,
  AgentReadiness,
  PublicPlatformSnapshot as PlatformSnapshot,
  RuntimeCapability,
  RuntimeHarnessKind,
  RuntimePolicy,
  RuntimeProfile,
  RuntimeProfileBinding,
  RuntimeProfileRevision
} from "@council/contracts";

const runtimeHarnessLabels: Record<RuntimeHarnessKind, string> = {
  openai_compatible: "OpenAI-compatible",
  codex: "Codex",
  pi: "OMP (Pi-compatible)"
};

const runtimePolicyLabels: Record<RuntimePolicy, string> = {
  text_only: "text_only",
  read_only_tools: "read_only_tools",
  isolated_exec: "isolated_exec"
};

const runtimeCapabilityLabels: Record<RuntimeCapability, string> = {
  text: "文字",
  images: "圖像",
  fast_mode: "快速",
  abort: "取消",
  resume: "續跑",
  file_read: "讀檔",
  file_write: "寫檔",
  process: "程序",
  read_only_tool: "唯讀工具",
  external_write: "外部寫入"
};

const allowedCapabilitiesByPolicy: Record<RuntimePolicy, RuntimeCapability[]> = {
  text_only: ["text", "images", "fast_mode", "abort", "resume"],
  read_only_tools: ["text", "images", "fast_mode", "abort", "resume", "file_read", "read_only_tool"],
  isolated_exec: ["text", "images", "fast_mode", "abort", "resume", "file_read", "file_write", "process", "read_only_tool"]
};

const defaultCapabilitiesByPolicy: Record<RuntimePolicy, RuntimeCapability[]> = {
  text_only: ["text", "abort"],
  read_only_tools: ["text", "abort", "file_read", "read_only_tool"],
  isolated_exec: ["text", "abort", "file_read", "file_write", "process"]
};

export interface RuntimeBindingOption {
  key: string;
  binding: RuntimeProfileBinding | null;
  label: string;
  current: RuntimeProfile | null;
  revision: RuntimeProfileRevision | null;
}

export function initialRuntimeBindingKey(
  mode: "create" | "edit",
  currentBinding: RuntimeProfileBinding | null,
  defaultBindingKey: string
): string {
  if (mode === "create") return defaultBindingKey;
  return currentBinding ? `${currentBinding.profileId}:${currentBinding.revision}` : "";
}

export function runtimeHarnessLabel(kind: RuntimeHarnessKind): string {
  return runtimeHarnessLabels[kind];
}

export function runtimePolicyLabel(policy: RuntimePolicy): string {
  return runtimePolicyLabels[policy];
}

export function runtimeCapabilityLabel(capability: RuntimeCapability): string {
  return runtimeCapabilityLabels[capability];
}

export function allowedRuntimeCapabilities(policy: RuntimePolicy): RuntimeCapability[] {
  return [...allowedCapabilitiesByPolicy[policy]];
}

export function normalizeRuntimeCapabilities(
  policy: RuntimePolicy,
  selected: readonly RuntimeCapability[]
): RuntimeCapability[] {
  const allowed = new Set(allowedRuntimeCapabilities(policy));
  const normalized = selected.filter((capability, index) => allowed.has(capability) && selected.indexOf(capability) === index);
  return normalized.length > 0 ? normalized : [...defaultCapabilitiesByPolicy[policy]];
}

export function formatRuntimeCapabilitySummary(capabilities: readonly RuntimeCapability[]): string {
  return capabilities.map(runtimeCapabilityLabel).join(" / ");
}

export function formatRuntimeTimeout(timeoutMs: number): string {
  if (timeoutMs >= 60 * 60_000 && timeoutMs % (60 * 60_000) === 0) return `${timeoutMs / (60 * 60_000)} 小時`;
  if (timeoutMs >= 60_000 && timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000} 分鐘`;
  return `${Math.round(timeoutMs / 1000)} 秒`;
}

export function formatRuntimeBindingOption(
  profile: RuntimeProfile | null,
  revision: RuntimeProfileRevision
): string {
  const status = revision.enabled ? (profile?.enabled === false ? "disabled" : "enabled") : "disabled";
  return [
    revision.name,
    status,
    runtimeHarnessLabel(revision.harnessKind),
    runtimePolicyLabel(revision.policy),
    `Rev ${revision.revision}`
  ].join(" · ");
}

export function runtimeBindingOptions(
  snapshot: Pick<PlatformSnapshot, "runtimeProfiles" | "runtimeProfileRevisions">,
  currentBinding: RuntimeProfileBinding | null
): RuntimeBindingOption[] {
  const profiles = snapshot.runtimeProfiles ?? [];
  const revisions = snapshot.runtimeProfileRevisions ?? [];
  const currentById = new Map(profiles.map((profile) => [profile.id, profile]));
  const selectedKey = currentBinding ? `${currentBinding.profileId}:${currentBinding.revision}` : null;
  return revisions
    .slice()
    .sort((left, right) => {
      const leftCurrent = currentById.get(left.profileId)?.revision === left.revision ? 1 : 0;
      const rightCurrent = currentById.get(right.profileId)?.revision === right.revision ? 1 : 0;
      if (leftCurrent !== rightCurrent) return rightCurrent - leftCurrent;
      return right.revision - left.revision || left.name.localeCompare(right.name);
    })
    .filter((revision, index, items) => {
      const key = `${revision.profileId}:${revision.revision}`;
      return items.findIndex((candidate) => `${candidate.profileId}:${candidate.revision}` === key) === index;
    })
    .map((revision) => {
      const key = `${revision.profileId}:${revision.revision}`;
      const current = currentById.get(revision.profileId) ?? null;
      return {
        key,
        binding: { profileId: revision.profileId, revision: revision.revision },
        label: formatRuntimeBindingOption(current, revision),
        current,
        revision
      };
    })
    .filter((option) => option.key === selectedKey
      || (option.current?.enabled === true && option.revision?.enabled === true));
}

export function runtimeProfileUsageSummary(
  agents: readonly Pick<Agent, "id" | "runtimeProfileBinding">[],
  readAgentReadiness: (agentId: string) => AgentReadiness | null,
  profileId: string
): { total: number; blocked: number } {
  return agents.reduce((summary, agent) => {
    if (agent.runtimeProfileBinding?.profileId !== profileId) return summary;
    const readiness = readAgentReadiness(agent.id);
    return {
      total: summary.total + 1,
      blocked: summary.blocked + (readiness?.status === "blocked" ? 1 : 0)
    };
  }, { total: 0, blocked: 0 });
}

export function runtimeBlockedMessages(readiness: AgentReadiness | null): string[] {
  return (readiness?.checks ?? [])
    .filter((check) => check.status === "blocked" && (check.code === "runtime" || check.code === "lifecycle"))
    .map((check) => check.message);
}
