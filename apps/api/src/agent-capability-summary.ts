import {
  toolPackGrantIsCurrentAndApproved,
  type Agent,
  type AgentRevision,
  type EffectiveAgentConfigurationResponse,
  type PlatformSnapshot
} from "@council/contracts";
import {
  skillHasCurrentApprovedValidation,
  StoreNotFoundError,
  type PlatformStore
} from "@council/database";
import { getPublishedAgentRuntime } from "./published-agent-readiness.js";

type CapabilitySummaryStore = Pick<PlatformStore, "getAgentRevision">;

interface ConfigurationSelection {
  source: EffectiveAgentConfigurationResponse["source"];
  configuration: Agent | AgentRevision;
  publishedRevision: AgentRevision | null;
  missingRevisionError: StoreNotFoundError | null;
}

function claimedPublishedRevision(agent: Agent): number | null {
  if (agent.publishedRevision !== undefined) return agent.publishedRevision;
  return agent.lifecycleStatus === undefined ? 1 : null;
}

async function selectConfiguration(
  store: CapabilitySummaryStore,
  agent: Agent
): Promise<ConfigurationSelection> {
  const publishedRevision = claimedPublishedRevision(agent);
  if (publishedRevision !== null) {
    try {
      const revision = await store.getAgentRevision(agent.id, publishedRevision);
      return {
        source: { kind: "published", revision: revision.revision },
        configuration: revision,
        publishedRevision: revision,
        missingRevisionError: null
      };
    } catch (error) {
      if (!(error instanceof StoreNotFoundError)) throw error;
      return {
        source: { kind: "published_missing", revision: publishedRevision },
        configuration: agent,
        publishedRevision: null,
        missingRevisionError: error
      };
    }
  }
  return {
    source: { kind: "draft", revision: agent.draftRevision ?? 1 },
    configuration: agent,
    publishedRevision: null,
    missingRevisionError: null
  };
}

function selectedRevisionStore(
  store: CapabilitySummaryStore,
  agent: Agent,
  selection: ConfigurationSelection
): CapabilitySummaryStore {
  const selectedRevision = claimedPublishedRevision(agent);
  return {
    async getAgentRevision(agentId, revision) {
      if (agentId === agent.id && revision === selectedRevision) {
        if (selection.publishedRevision) return selection.publishedRevision;
        if (selection.missingRevisionError) throw selection.missingRevisionError;
      }
      return store.getAgentRevision(agentId, revision);
    }
  };
}

export async function buildAgentCapabilitySummary(
  store: CapabilitySummaryStore,
  snapshot: PlatformSnapshot,
  agent: Agent
): Promise<EffectiveAgentConfigurationResponse> {
  const selection = await selectConfiguration(store, agent);
  const configuration = selection.configuration;
  const runtime = await getPublishedAgentRuntime(selectedRevisionStore(store, agent, selection), snapshot, agent.id);
  const bindingsAvailable = selection.source.kind !== "published_missing";
  const model = bindingsAvailable
    ? snapshot.modelConnectors.find((item) => item.id === configuration.modelConnectorId) ?? null
    : null;
  const credential = model?.credentialId
    ? (snapshot.credentials ?? []).find((item) => item.id === model.credentialId) ?? null
    : null;
  const promptBinding = bindingsAvailable ? configuration.promptBinding ?? null : null;
  const prompt = promptBinding
    ? (snapshot.prompts ?? []).find((item) => item.id === promptBinding.promptId) ?? null
    : null;
  const skills = bindingsAvailable ? configuration.skillIds.flatMap((skillId) => {
    const skill = snapshot.skills.find((item) => item.id === skillId);
    if (!skill || !skillHasCurrentApprovedValidation(skill)) return [];
    return [{
      id: skill.id,
      name: skill.name,
      version: skill.version,
      source: skill.source,
      owner: skill.owner
    }];
  }) : [];
  const tools = bindingsAvailable ? configuration.toolGrants.flatMap((grant) => {
    const connector = snapshot.mcpConnectors.find((item) => item.id === grant.connectorId);
    const registration = connector?.toolRegistrations.find((item) => item.toolName === grant.toolName);
    if (!connector?.enabled || !connector.approvedTools.includes(grant.toolName) || !registration) return [];
    return [{
      connectorId: connector.id,
      connectorName: connector.name,
      toolName: registration.toolName,
      displayName: registration.displayName,
      kind: registration.kind,
      version: registration.version,
      owner: registration.owner,
      goal: registration.goal
    }];
  }) : [];
  const toolPacks = bindingsAvailable ? configuration.toolPackGrants.flatMap((grant) => {
    if (!toolPackGrantIsCurrentAndApproved(grant, snapshot.toolPacks ?? [])) return [];
    const pack = (snapshot.toolPacks ?? []).find((item) => item.id === grant.packId)!;
    const tool = pack.tools.find((item) => item.name === grant.toolName)!;
    return [{
      packId: pack.id,
      packName: pack.name,
      revision: pack.revision,
      version: pack.version,
      toolName: tool.name,
      toolGoal: tool.goal
    }];
  }) : [];
  const teams = (snapshot.agentTeams ?? []).flatMap((team) => {
    if (team.status !== "active") return [];
    const member = team.members.find((item) => item.agentId === agent.id);
    if (!member) return [];
    const role = snapshot.roles.find((item) => item.id === member.roleId && item.deletedAt === null);
    if (!role) return [];
    return [{
      id: team.id,
      name: team.name,
      isChair: member.isChair,
      role: {
        id: role.id,
        name: role.name,
        version: role.version,
        toolPolicy: role.toolPolicy,
        dataPolicy: role.dataPolicy
      }
    }];
  });
  const runtimeProfileBinding = bindingsAvailable ? configuration.runtimeProfileBinding : null;

  return {
    source: selection.source,
    agent: {
      id: agent.id,
      name: configuration.name,
      description: configuration.description,
      lifecycleStatus: agent.lifecycleStatus ?? "published",
      draftRevision: agent.draftRevision ?? 1,
      publishedRevision: agent.publishedRevision ?? null,
      goalSummary: configuration.goalSummary,
      toolsSummary: configuration.toolsSummary,
      dataSummary: configuration.dataSummary
    },
    bindingCounts: {
      skills: { configured: configuration.skillIds.length, ready: skills.length },
      tools: { configured: configuration.toolGrants.length, ready: tools.length },
      toolPacks: { configured: configuration.toolPackGrants.length, ready: toolPacks.length }
    },
    model: model ? {
      id: model.id,
      name: model.name,
      location: model.location,
      model: model.model,
      enabled: model.enabled
    } : null,
    credential: credential ? {
      id: credential.id,
      name: credential.name,
      location: credential.location,
      status: credential.status,
      hasSecret: credential.hasSecret,
      maskedHint: credential.maskedHint,
      expiresAt: credential.expiresAt
    } : null,
    prompt: prompt && promptBinding ? { ...prompt, version: promptBinding.version } : null,
    skills,
    tools,
    toolPacks,
    teams,
    runtimeProfile: runtimeProfileBinding ? {
      binding: runtimeProfileBinding,
      current: (snapshot.runtimeProfiles ?? []).find((item) => item.id === runtimeProfileBinding.profileId) ?? null,
      revision: (snapshot.runtimeProfileRevisions ?? []).find((item) =>
        item.profileId === runtimeProfileBinding.profileId && item.revision === runtimeProfileBinding.revision
      ) ?? null,
      snapshot: runtime.runtimeProfileSnapshot
    } : null,
    readiness: runtime.readiness
  };
}
