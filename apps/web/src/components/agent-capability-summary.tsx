import type { ReactNode } from "react";
import { ChevronDown, Database, RefreshCw, Target, Wrench } from "lucide-react";
import type {
  AgentReadiness,
  CredentialStatus,
  EffectiveAgentConfigurationResponse,
  RoleDataPolicy,
  RoleToolPolicy,
  RuntimeHarnessKind,
  RuntimePolicy
} from "@council/contracts";

export type AgentConfigurationSource = {
  kind: "published" | "draft" | "published_missing";
  revision: number;
};

type BindingCount = {
  configured: number;
  ready: number;
};

type EffectiveRuntimeProfile = NonNullable<EffectiveAgentConfigurationResponse["runtimeProfile"]>;
type EffectiveRuntimeRevision = NonNullable<EffectiveRuntimeProfile["revision"]>;

export type AgentCapabilitySummaryConfiguration = {
  source: EffectiveAgentConfigurationResponse["source"];
  agent: Pick<EffectiveAgentConfigurationResponse["agent"], "goalSummary" | "toolsSummary" | "dataSummary">;
  bindingCounts: EffectiveAgentConfigurationResponse["bindingCounts"];
  model: Pick<NonNullable<EffectiveAgentConfigurationResponse["model"]>, "name" | "model" | "location" | "enabled"> | null;
  credential: Pick<NonNullable<EffectiveAgentConfigurationResponse["credential"]>, "name" | "location" | "status"> | null;
  prompt: Pick<NonNullable<EffectiveAgentConfigurationResponse["prompt"]>, "name" | "version"> | null;
  skills: Array<Pick<EffectiveAgentConfigurationResponse["skills"][number], "id" | "name" | "version">>;
  tools: Array<Pick<EffectiveAgentConfigurationResponse["tools"][number], "connectorId" | "connectorName" | "toolName" | "displayName" | "version">>;
  toolPacks: EffectiveAgentConfigurationResponse["toolPacks"];
  teams: EffectiveAgentConfigurationResponse["teams"];
  runtimeProfile: {
    binding: EffectiveRuntimeProfile["binding"];
    revision: Pick<EffectiveRuntimeRevision, "name" | "revision" | "harnessKind" | "policy" | "enabled"> | null;
  } | null;
  readiness: AgentReadiness;
};

type AgentCapabilitySummaryProps = {
  configuration: AgentCapabilitySummaryConfiguration | null;
  state: "loading" | "ready" | "unavailable";
  relationshipContent?: ReactNode;
  onRetry?: () => void;
};

const roleToolPolicyLabels: Record<RoleToolPolicy, string> = {
  none: "不使用外部工具",
  agent_read_only_grants: "Agent 唯讀授權"
};

const roleDataPolicyLabels: Record<RoleDataPolicy, string> = {
  meeting_only: "僅限會議資料",
  agent_declared_scope: "Agent 宣告範圍"
};

const credentialStatusLabels: Record<CredentialStatus, string> = {
  active: "啟用",
  disabled: "停用",
  revoked: "已撤銷"
};

const runtimeHarnessLabels: Record<RuntimeHarnessKind, string> = {
  openai_compatible: "OpenAI-compatible",
  codex: "Codex",
  pi: "Pi"
};

const runtimePolicyLabels: Record<RuntimePolicy, string> = {
  text_only: "純文字",
  read_only_tools: "唯讀工具",
  isolated_exec: "隔離執行"
};

export function agentConfigurationSourceLabel(source: AgentConfigurationSource): string {
  if (source.kind === "published") return `已發布 Rev ${source.revision}`;
  if (source.kind === "draft") return `草稿 Rev ${source.revision}`;
  return `已發布 Rev ${source.revision} 無法取得`;
}

function locationLabel(location: "cloud" | "local"): string {
  return location === "local" ? "地端" : "雲端";
}

function modelLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  if (!configuration.model) return "模型未設定";
  const enabled = configuration.model.enabled === undefined
    ? ""
    : ` · ${configuration.model.enabled ? "啟用" : "停用"}`;
  return `${configuration.model.name} · ${configuration.model.model} · ${locationLabel(configuration.model.location)}${enabled}`;
}

function compactModelLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  return configuration.model ? `${configuration.model.name} / ${configuration.model.model}` : "未設定";
}

function credentialLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  if (!configuration.credential) return "Credential 未綁定";
  return `${configuration.credential.name} · ${locationLabel(configuration.credential.location)} · ${credentialStatusLabels[configuration.credential.status]}`;
}

function runtimeLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  const runtime = configuration.runtimeProfile;
  if (!runtime) return "Runtime Profile 未綁定";
  if (!runtime.revision) return `Runtime Rev ${runtime.binding.revision} 無法取得`;
  return `${runtime.revision.name} · Rev ${runtime.revision.revision} · ${runtimeHarnessLabels[runtime.revision.harnessKind]} · ${runtimePolicyLabels[runtime.revision.policy]} · ${runtime.revision.enabled ? "啟用" : "停用"}`;
}

function compactRuntimeLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  const runtime = configuration.runtimeProfile;
  if (!runtime) return "未綁定";
  return runtime.revision
    ? `${runtime.revision.name} Rev ${runtime.revision.revision}`
    : `Rev ${runtime.binding.revision}`;
}

function readyCountLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  const { skills, tools, toolPacks } = configuration.bindingCounts;
  return `Skills ${skills.ready}/${skills.configured} · MCP ${tools.ready}/${tools.configured} · Tool Packs ${toolPacks.ready}/${toolPacks.configured}（就緒/已設定）`;
}

function blockedCount(count: BindingCount): number {
  return Math.max(0, count.configured - count.ready);
}

function blockedBindingsLabel(configuration: AgentCapabilitySummaryConfiguration): string {
  const skills = blockedCount(configuration.bindingCounts.skills);
  const tools = blockedCount(configuration.bindingCounts.tools);
  const toolPacks = blockedCount(configuration.bindingCounts.toolPacks);
  if (skills + tools + toolPacks === 0) return "目前沒有受阻的已設定能力";
  return `已設定但受阻：Skills ${skills}、MCP ${tools}、Tool Packs ${toolPacks}`;
}

function CapabilityRow({
  icon,
  tone,
  label,
  value,
  detail,
  context,
  children
}: {
  icon: ReactNode;
  tone: "blue" | "green" | "amber";
  label: string;
  value: string;
  detail: string;
  context: string;
  children: ReactNode;
}) {
  return (
    <details className="agent-summary-row agent-capability-row">
      <summary>
        <span className={`summary-icon ${tone}`}>{icon}</span>
        <span className="summary-label">{label}</span>
        <span className="summary-main">
          <strong>{value}</strong>
          <small>{detail}</small>
          <small className="agent-capability-context">{context}</small>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="agent-summary-expanded">{children}</div>
    </details>
  );
}

function TeamRoleList({
  configuration,
  policy
}: {
  configuration: AgentCapabilitySummaryConfiguration;
  policy?: "tool" | "data";
}) {
  if (configuration.teams.length === 0) {
    return <p className="agent-skill-empty">尚未指派 Team 角色</p>;
  }
  return (
    <ul className="agent-role-usage agent-capability-policy-list">
      {configuration.teams.map((team) => (
        <li key={`${team.id}:${team.role.id}`}>
          <strong>{team.name}</strong>
          <span>{team.role.name} v{team.role.version}{team.isChair ? " · 主席" : " · 成員"}</span>
          {policy === "tool" && <p>{roleToolPolicyLabels[team.role.toolPolicy]}</p>}
          {policy === "data" && <p>{roleDataPolicyLabels[team.role.dataPolicy]}</p>}
        </li>
      ))}
    </ul>
  );
}

function ReadyCapabilityLists({ configuration }: { configuration: AgentCapabilitySummaryConfiguration }) {
  return (
    <div className="agent-capability-lists">
      <section>
        <h3>就緒 Skills</h3>
        {configuration.skills.length > 0 ? (
          <ul className="agent-skill-summary">
            {configuration.skills.map((skill, index) => (
              <li key={skill.id ?? `${skill.name}:${skill.version}:${index}`}>
                <strong>{skill.name} v{skill.version}</strong>
              </li>
            ))}
          </ul>
        ) : <p className="agent-skill-empty">尚無已就緒 Skill</p>}
      </section>
      <section>
        <h3>就緒 MCP 工具</h3>
        {configuration.tools.length > 0 ? (
          <ul className="agent-tool-summary">
            {configuration.tools.map((tool, index) => (
              <li key={`${tool.connectorId ?? tool.connectorName}:${tool.toolName}:${index}`}>
                <strong>{tool.connectorName} / {tool.displayName}</strong>
                {tool.version && <span>{tool.toolName} · v{tool.version}</span>}
              </li>
            ))}
          </ul>
        ) : <p className="agent-skill-empty">尚無已就緒 MCP 工具</p>}
      </section>
      <section>
        <h3>就緒 Tool Packs</h3>
        {configuration.toolPacks.length > 0 ? (
          <ul className="agent-tool-summary">
            {configuration.toolPacks.map((toolPack, index) => {
              return (
                <li key={`${toolPack.packId}:${toolPack.revision}:${toolPack.toolName}:${index}`}>
                  <strong>{toolPack.packName} / {toolPack.toolName}</strong>
                  <span>v{toolPack.version} · Rev {toolPack.revision}</span>
                  <p>{toolPack.toolGoal}</p>
                </li>
              );
            })}
          </ul>
        ) : <p className="agent-skill-empty">尚無已就緒 Tool Pack</p>}
      </section>
    </div>
  );
}

export function AgentCapabilitySummary({
  configuration,
  state,
  relationshipContent,
  onRetry
}: AgentCapabilitySummaryProps) {
  if (state === "loading") {
    return (
      <div className="agent-summary agent-capability-summary" aria-busy="true">
        <p className="agent-capability-state" role="status">正在載入 Agent 能力摘要…</p>
      </div>
    );
  }

  if (state === "unavailable" || !configuration) {
    return (
      <div className="agent-summary agent-capability-summary">
        <div className="agent-capability-state-row">
          <p className="agent-capability-state" role="status">Agent 能力摘要目前無法取得。</p>
          {onRetry && (
            <button className="secondary-button small" type="button" onClick={onRetry}>
              <RefreshCw size={13} aria-hidden="true" />重新載入
            </button>
          )}
        </div>
      </div>
    );
  }

  const prompt = configuration.prompt
    ? `${configuration.prompt.name} · v${configuration.prompt.version}`
    : "Prompt 未綁定";
  const source = agentConfigurationSourceLabel(configuration.source);
  const roleCount = configuration.teams.length;

  return (
    <div className="agent-summary agent-capability-summary">
      {configuration.source.kind === "published_missing" && (
        <p className="agent-capability-warning" role="alert">
          已發布 Agent 組態遺失；以下摘要不是可執行組態。
        </p>
      )}
      <CapabilityRow
        icon={<Target size={16} aria-hidden="true" />}
        tone="blue"
        label="目標"
        value={configuration.agent.goalSummary}
        detail={`${source} · ${prompt}`}
        context={`${roleCount} 個 Team 角色`}
      >
        <div className="agent-capability-expanded-section">
          <h3>Prompt 與組態來源</h3>
          <p>{source} · {prompt}</p>
        </div>
        <div className="agent-capability-expanded-section">
          <h3>目前 Team 角色</h3>
          <TeamRoleList configuration={configuration} />
        </div>
        {relationshipContent && (
          <div className="agent-capability-expanded-section agent-capability-relationships">
            <h3>任務與會議關係</h3>
            {relationshipContent}
          </div>
        )}
      </CapabilityRow>

      <CapabilityRow
        icon={<Wrench size={16} aria-hidden="true" />}
        tone="green"
        label="工具"
        value={configuration.agent.toolsSummary}
        detail={readyCountLabel(configuration)}
        context={`模型 ${compactModelLabel(configuration)} · Runtime ${compactRuntimeLabel(configuration)}`}
      >
        <p className={blockedBindingsLabel(configuration).startsWith("已設定") ? "agent-skill-warning" : "agent-skill-empty"}>
          {blockedBindingsLabel(configuration)}
        </p>
        <ReadyCapabilityLists configuration={configuration} />
        <div className="agent-capability-expanded-section">
          <h3>模型與 Runtime</h3>
          <p>{modelLabel(configuration)}</p>
          <p>{runtimeLabel(configuration)}</p>
        </div>
        <div className="agent-capability-expanded-section">
          <h3>角色工具政策</h3>
          <TeamRoleList configuration={configuration} policy="tool" />
        </div>
      </CapabilityRow>

      <CapabilityRow
        icon={<Database size={16} aria-hidden="true" />}
        tone="amber"
        label="資料"
        value={configuration.agent.dataSummary}
        detail={credentialLabel(configuration)}
        context={`${roleCount} 個角色資料政策`}
      >
        <div className="agent-capability-expanded-section">
          <h3>Credential</h3>
          <p>{credentialLabel(configuration)}</p>
        </div>
        <div className="agent-capability-expanded-section">
          <h3>角色資料政策</h3>
          <TeamRoleList configuration={configuration} policy="data" />
        </div>
      </CapabilityRow>
    </div>
  );
}
