import type {
  Agent,
  AgentReadiness,
  AgentRevision,
  PlatformSnapshot,
  RuntimeProfileSnapshot
} from "@council/contracts";
import { StoreNotFoundError, type PlatformStore } from "@council/database";
import { evaluateAgentReadiness } from "@council/domain/agent-readiness";
import { resolveRuntimeProfileAdmission } from "@council/domain";

export interface PublishedAgentRuntime {
  agent: Agent | null;
  revision: AgentRevision | null;
  readiness: AgentReadiness;
  runtimeProfileSnapshot: RuntimeProfileSnapshot | null;
}

export type PublishedAgentRuntimeStore = Pick<PlatformStore, "getAgentRevision">;

function unavailable(message: string): AgentReadiness {
  return {
    status: "blocked",
    checks: [{ code: "lifecycle", status: "blocked", message }]
  };
}

function agentFromRevision(agent: Agent, revision: AgentRevision): Agent {
  return {
    id: agent.id,
    name: revision.name,
    description: revision.description,
    modelConnectorId: revision.modelConnectorId,
    goalSummary: revision.goalSummary,
    toolsSummary: revision.toolsSummary,
    dataSummary: revision.dataSummary,
    skillIds: [...revision.skillIds],
    toolGrants: revision.toolGrants.map((grant) => ({ ...grant })),
    toolPackGrants: revision.toolPackGrants.map((grant) => ({ ...grant })),
    status: revision.modelConnectorId ? "online" : "attention",
    lifecycleStatus: agent.lifecycleStatus === "disabled" ? "disabled" : "published",
    promptBinding: revision.promptBinding ? { ...revision.promptBinding } : null,
    runtimeProfileBinding: revision.runtimeProfileBinding ? { ...revision.runtimeProfileBinding } : null,
    draftRevision: revision.revision,
    publishedRevision: revision.revision
  };
}

export async function getPublishedAgentRuntime(
  store: PublishedAgentRuntimeStore,
  snapshot: PlatformSnapshot,
  agentId: string
): Promise<PublishedAgentRuntime> {
  const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    return {
      agent: null,
      revision: null,
      readiness: unavailable("找不到 Agent。"),
      runtimeProfileSnapshot: null
    };
  }
  if (agent.lifecycleStatus === "disabled") {
    return {
      agent,
      revision: null,
      readiness: unavailable("Agent 已停用。"),
      runtimeProfileSnapshot: null
    };
  }
  const publishedRevision = agent.publishedRevision ?? (agent.lifecycleStatus === undefined ? 1 : null);
  if (!publishedRevision) {
    return {
      agent,
      revision: null,
      readiness: unavailable("Agent 尚未發布。"),
      runtimeProfileSnapshot: null
    };
  }
  let revision: AgentRevision;
  try {
    revision = await store.getAgentRevision(agent.id, publishedRevision);
  } catch (error) {
    if (!(error instanceof StoreNotFoundError)) throw error;
    return {
      agent,
      revision: null,
      readiness: unavailable("找不到 Agent 已發布版本。"),
      runtimeProfileSnapshot: null
    };
  }
  const runtimeAgent = agentFromRevision(agent, revision);
  const runtimeSnapshot: PlatformSnapshot = {
    ...snapshot,
    agents: snapshot.agents.map((candidate) => candidate.id === agent.id ? runtimeAgent : candidate)
  };
  let runtimeProfileSnapshot: RuntimeProfileSnapshot | null = null;
  const binding = runtimeAgent.runtimeProfileBinding;
  if (binding) {
    const profileRevision = runtimeSnapshot.runtimeProfileRevisions?.find((candidate) => (
      candidate.profileId === binding.profileId && candidate.revision === binding.revision
    ));
    if (profileRevision) {
      try {
        runtimeProfileSnapshot = resolveRuntimeProfileAdmission({
          binding,
          revision: profileRevision,
          agentModelConnectorId: runtimeAgent.modelConnectorId
        });
      } catch {
        runtimeProfileSnapshot = null;
      }
    }
  }
  return {
    agent: runtimeAgent,
    revision,
    readiness: evaluateAgentReadiness(runtimeSnapshot, runtimeAgent.id),
    runtimeProfileSnapshot
  };
}
