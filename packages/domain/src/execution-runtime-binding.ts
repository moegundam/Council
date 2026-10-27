import { createHash } from "node:crypto";
import type {
  AgentRevision,
  ExecutionRuntimeBinding,
  GoalPlanTask,
  ModelConnector,
  RuntimeHarnessKind,
  RuntimeProfileSnapshot
} from "@council/contracts";
import { adviseExecution } from "#execution-advisor";
import { runtimePolicyCanTighten } from "#runtime-policy";

export const OMP_BUILTIN_TOOL_ALLOWLIST = ["read", "grep", "glob", "lsp", "edit", "bash"] as const;

const runtimeVersions: Record<RuntimeHarnessKind, string> = {
  openai_compatible: "council-openai-compatible-v1",
  codex: "council-codex-cli-v1",
  pi: "omp-rpc-v2@18.1.2"
};

export interface OmpExecutionOperatorBinding {
  enabled: boolean;
  sandboxProfileId: string;
  sandboxImageDigest: string;
  workspaceSourceId: string;
  workspaceArchiveDigest: string;
}

export class ExecutionRuntimeBindingError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ExecutionRuntimeBindingError";
  }
}

export function runtimeDataScopeDigest(dataScope: string): string {
  return createHash("sha256").update(JSON.stringify({ dataScope })).digest("hex");
}

export function createExecutionRuntimeBinding(input: {
  task: GoalPlanTask;
  agentRevision: AgentRevision;
  runtimeProfile: RuntimeProfileSnapshot;
  modelConnector: ModelConnector;
  omp?: OmpExecutionOperatorBinding;
  ompHostToolsEnabled?: boolean;
}): ExecutionRuntimeBinding {
  const { task, agentRevision, runtimeProfile, modelConnector } = input;
  if (task.executionMode !== "worker" && task.executionMode !== "advisor") {
    throw new ExecutionRuntimeBindingError("Only automatic non-Action tasks receive Runtime bindings.", "RUNTIME_TASK_UNSUPPORTED");
  }
  if (!task.assigneeAgentId || task.assigneeAgentId !== agentRevision.agentId) {
    throw new ExecutionRuntimeBindingError("Automatic Goal tasks require their assigned Agent revision.", "RUNTIME_ASSIGNEE_REQUIRED");
  }
  if (agentRevision.modelConnectorId !== modelConnector.id) {
    throw new ExecutionRuntimeBindingError("Agent and Model Connector bindings do not match.", "RUNTIME_MODEL_STALE");
  }
  if (!agentRevision.runtimeProfileBinding
    || agentRevision.runtimeProfileBinding.profileId !== runtimeProfile.profileId
    || agentRevision.runtimeProfileBinding.revision !== runtimeProfile.revision) {
    throw new ExecutionRuntimeBindingError("Agent and Runtime Profile revisions do not match.", "RUNTIME_PROFILE_STALE");
  }
  if (runtimeProfile.modelConnectorId !== null && runtimeProfile.modelConnectorId !== modelConnector.id) {
    throw new ExecutionRuntimeBindingError("Runtime Profile and Model Connector bindings do not match.", "RUNTIME_MODEL_STALE");
  }

  const approvedTools = runtimeProfile.harnessKind === "pi"
    ? [...OMP_BUILTIN_TOOL_ALLOWLIST]
    : agentRevision.toolGrants.map((grant) => `${grant.connectorId}:${grant.toolName}`);
  const advice = adviseExecution({
    task,
    approvedCapabilities: runtimeProfile.capabilities,
    approvedTools
  });
  if (!runtimePolicyCanTighten(runtimeProfile.policy, advice.policy)) {
    throw new ExecutionRuntimeBindingError("ExecutionAdvisor route exceeds the approved Runtime Profile policy.", "RUNTIME_CAPABILITY_ESCALATION");
  }
  if (advice.route === "read_only_research" && input.ompHostToolsEnabled !== true) {
    throw new ExecutionRuntimeBindingError("Read-only research requires the separately gated OMP Host Tools phase.", "RUNTIME_HOST_TOOLS_DISABLED");
  }

  const omp = advice.route === "omp_coding";
  if (omp) {
    if (runtimeProfile.harnessKind !== "pi") {
      throw new ExecutionRuntimeBindingError("OMP coding requires the Pi-compatible Runtime Profile.", "OMP_PROFILE_REQUIRED");
    }
    if (!input.omp?.enabled) {
      throw new ExecutionRuntimeBindingError("OMP Runtime is not operator-enabled.", "OMP_RUNTIME_DISABLED");
    }
    if (modelConnector.location !== "local") {
      throw new ExecutionRuntimeBindingError("OMP Phase 1 accepts local Model Connectors only.", "OMP_LOCAL_MODEL_REQUIRED");
    }
    if (runtimeProfile.sandboxProfileId !== input.omp.sandboxProfileId) {
      throw new ExecutionRuntimeBindingError("OMP Runtime Profile does not match the operator-approved Sandbox Profile.", "OMP_SANDBOX_STALE");
    }
  } else if (runtimeProfile.harnessKind === "pi") {
    throw new ExecutionRuntimeBindingError("Pi-compatible Runtime Profiles are reserved for OMP coding tasks.", "OMP_TASK_REQUIRED");
  }

  return {
    planTaskId: task.id,
    route: advice.route,
    runtimeProfileId: runtimeProfile.profileId,
    runtimeProfileRevision: runtimeProfile.revision,
    harnessKind: runtimeProfile.harnessKind,
    runtimeVersion: runtimeVersions[runtimeProfile.harnessKind],
    policy: advice.policy,
    capabilities: [...advice.capabilities],
    agentId: agentRevision.agentId,
    agentRevision: agentRevision.revision,
    modelConnectorId: modelConnector.id,
    modelConnectorRevision: modelConnector.revision,
    modelConnectorSecretRevision: modelConnector.secretRevision,
    sandboxProfileId: omp ? runtimeProfile.sandboxProfileId : null,
    sandboxImageDigest: omp ? input.omp!.sandboxImageDigest : null,
    workspaceSource: omp ? {
      sourceId: input.omp!.workspaceSourceId,
      archiveDigest: input.omp!.workspaceArchiveDigest
    } : null,
    allowedTools: omp ? [...OMP_BUILTIN_TOOL_ALLOWLIST] : [...advice.tools],
    dataScopeDigest: runtimeDataScopeDigest(task.dataScope),
    timeoutMs: runtimeProfile.timeoutMs
  };
}
