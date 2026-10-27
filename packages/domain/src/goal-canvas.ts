import type {
  ActionAdapter,
  ActionRun,
  Agent,
  GoalCanvasLens,
  GoalCanvasSnapshot,
  GoalPlanRevision,
  GoalRun,
  GoalTaskBinding,
  McpConnector,
  Meeting,
  ModelConnector,
  ParticipantAssignment,
  ReviewerVerdict,
  Role,
  RuntimeRun,
  Skill,
  SpeakerQueueItem
} from "@council/contracts";

type CanvasNode = GoalCanvasSnapshot["nodes"][number];
type CanvasEdge = GoalCanvasSnapshot["edges"][number];

export interface GoalCanvasProjectionInput {
  goalRun: GoalRun;
  plan: GoalPlanRevision | null;
  taskBindings: readonly GoalTaskBinding[];
  actionRuns: readonly ActionRun[];
  reviewerVerdicts: readonly ReviewerVerdict[];
  runtimeRuns?: readonly RuntimeRun[];
  meeting?: Meeting | null;
  participants?: readonly ParticipantAssignment[];
  speakerQueue?: readonly SpeakerQueueItem[];
  agents?: readonly Agent[];
  roles?: readonly Role[];
  modelConnectors?: readonly ModelConnector[];
  skills?: readonly Skill[];
  mcpConnectors?: readonly McpConnector[];
  actionAdapters?: readonly ActionAdapter[];
}

class CanvasBuilder {
  private readonly nodes = new Map<string, CanvasNode>();
  private readonly edges = new Map<string, CanvasEdge>();

  addNode(node: CanvasNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: CanvasEdge): void {
    if (edge.source !== edge.target) this.edges.set(edge.id, edge);
  }

  build(goalRun: GoalRun, lens: GoalCanvasLens, generatedAt: string): GoalCanvasSnapshot {
    const nodes = [...this.nodes.values()];
    const ids = new Set(nodes.map((node) => node.id));
    return {
      goalRunId: goalRun.id,
      revision: goalRun.revision,
      lens,
      nodes,
      edges: [...this.edges.values()].filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      generatedAt
    };
  }
}

function taskStatus(state: GoalTaskBinding["state"] | undefined): CanvasNode["status"] {
  if (state === "running" || state === "reviewing") return "running";
  if (state === "completed") return "completed";
  if (state === "blocked") return "blocked";
  if (state === "failed" || state === "cancelled") return "failed";
  return "waiting";
}

function actionStatus(state: ActionRun["state"] | undefined): CanvasNode["status"] {
  if (state === "reserved" || state === "running") return "running";
  if (state === "succeeded") return "completed";
  if (state === "outcome_unknown" || state === "awaiting_review") return "blocked";
  if (state === "failed" || state === "cancelled" || state === "denied" || state === "expired") return "failed";
  return "waiting";
}

function reviewStatus(verdict: ReviewerVerdict["verdict"]): CanvasNode["status"] {
  return verdict === "pass" ? "completed" : verdict === "fail" ? "failed" : "blocked";
}

function runtimeStatus(state: RuntimeRun["state"]): CanvasNode["status"] {
  if (state === "completed") return "completed";
  if (state === "paused") return "paused";
  if (state === "failed" || state === "cancelled" || state === "expired") return "failed";
  if (state === "awaiting_approval") return "blocked";
  if (state === "provisioning" || state === "ready" || state === "running") return "running";
  return "waiting";
}

function runtimeLabel(run: RuntimeRun): string {
  if (run.runtimeProfile.harnessKind === "pi") return "OMP Session";
  if (run.runtimeProfile.harnessKind === "codex") return "Codex Runtime";
  return "OpenAI-compatible Runtime";
}

function currentPhase(run: GoalRun): number {
  if (run.state === "draft" || run.state === "planning" || run.state === "replanning") return 0;
  if (run.state === "awaiting_approval") return 1;
  if (run.state === "executing") return 2;
  if (run.state === "reviewing") return 3;
  return 4;
}

function phaseStatus(input: GoalCanvasProjectionInput, index: number): CanvasNode["status"] {
  const run = input.goalRun;
  if (run.state === "failed" || run.state === "cancelled") return "failed";
  if (run.state === "paused") {
    const paused = run.pausedFromState === "planning" || run.pausedFromState === "replanning"
      ? 0
      : run.pausedFromState === "awaiting_approval"
        ? 1
        : run.pausedFromState === "reviewing"
          ? 3
          : 2;
    if (index === paused) return "paused";
    return index < paused ? "completed" : "waiting";
  }
  const current = currentPhase(run);
  if (run.state === "completed" || index < current) return "completed";
  return index === current ? "running" : "waiting";
}

function meetingDetail(input: GoalCanvasProjectionInput, generatedAt: string): CanvasNode["detail"] {
  const meeting = input.meeting;
  const agenda = meeting?.agenda.items.find((item) => item.status === "current");
  const speaker = input.speakerQueue?.find((item) => item.meetingId === meeting?.id && item.status === "running");
  const endAt = meeting?.startedAt ? Date.parse(meeting.startedAt) + meeting.durationMinutes * 60_000 : Number.NaN;
  return {
    agenda: agenda?.title ?? "尚未開始",
    round: input.goalRun.usage.discussionRounds,
    speaker: speaker?.roleName ?? speaker?.label ?? null,
    remainingMinutes: Number.isFinite(endAt) ? Math.max(0, Math.ceil((endAt - Date.parse(generatedAt)) / 60_000)) : null
  };
}

function progress(builder: CanvasBuilder, input: GoalCanvasProjectionInput, generatedAt: string): void {
  const phases = [
    ["discussion", "會議討論"],
    ["decision", "決議與核准"],
    ["execution", "任務執行"],
    ["review", "雙重審查"]
  ] as const;
  phases.forEach(([id, label], index) => builder.addNode({
    id: `phase:${id}`,
    type: "phase",
    label,
    status: phaseStatus(input, index),
    entityId: id === "discussion" ? input.goalRun.meetingId : input.goalRun.id,
    detail: id === "discussion" ? meetingDetail(input, generatedAt) : {}
  }));
  for (let index = 0; index < phases.length - 1; index += 1) {
    builder.addEdge({ id: `sequence:${phases[index]![0]}:${phases[index + 1]![0]}`, source: `phase:${phases[index]![0]}`, target: `phase:${phases[index + 1]![0]}`, type: "sequence", label: index === 1 ? "Owner 核准" : null });
  }

  const bindings = new Map(input.taskBindings.map((binding) => [binding.planTaskId, binding]));
  const actionRuns = new Map(input.actionRuns.map((run) => [run.planTaskId, run]));
  const runtimeRuns = new Map((input.runtimeRuns ?? []).map((run) => [run.taskId, run]));
  for (const task of input.plan?.tasks ?? []) {
    const binding = bindings.get(task.id);
    builder.addNode({ id: `task:${task.id}`, type: "task", label: task.title, status: taskStatus(binding?.state), entityId: binding?.taskId ?? task.id, detail: { mode: task.executionMode, attempts: binding?.attemptCount ?? 0 } });
    if (task.dependencyIds.length === 0) builder.addEdge({ id: `sequence:execution:${task.id}`, source: "phase:execution", target: `task:${task.id}`, type: "sequence", label: null });
    task.dependencyIds.forEach((dependencyId) => builder.addEdge({ id: `dependency:${dependencyId}:${task.id}`, source: `task:${dependencyId}`, target: `task:${task.id}`, type: "dependency", label: "依賴" }));
    if (task.action) {
      const run = actionRuns.get(task.id);
      const id = `action:${run?.id ?? task.id}`;
      builder.addNode({ id, type: "action", label: task.action.actionKey, status: actionStatus(run?.state), entityId: run?.id ?? null, detail: { target: task.action.targetId, risk: task.action.riskClass } });
      builder.addEdge({ id: `usage:${task.id}:${id}`, source: `task:${task.id}`, target: id, type: "usage", label: "Action Adapter" });
    }
    const runtimeRun = binding?.taskId ? runtimeRuns.get(binding.taskId) : undefined;
    if (runtimeRun) {
      const id = `runtime:${runtimeRun.id}`;
      builder.addNode({
        id,
        type: "runtime",
        label: runtimeLabel(runtimeRun),
        status: runtimeStatus(runtimeRun.state),
        entityId: runtimeRun.id,
        detail: {
          taskId: runtimeRun.taskId,
          engine: runtimeRun.runtimeVersion,
          phase: runtimeRun.state,
          checkpoint: runtimeRun.eventCursor,
          session: runtimeRun.providerSessionId
        }
      });
      builder.addEdge({ id: `usage:${task.id}:${id}`, source: `task:${task.id}`, target: id, type: "usage", label: "執行 Runtime" });
    }
  }
  for (const verdict of input.reviewerVerdicts) {
    const id = `review:${verdict.id}`;
    builder.addNode({ id, type: "review", label: verdict.scope === "goal" ? "Goal Reviewer" : "Task Reviewer", status: reviewStatus(verdict.verdict), entityId: verdict.id, detail: { verdict: verdict.verdict, modelConnectorId: verdict.modelConnectorId } });
    const source = verdict.scope === "goal"
      ? "phase:review"
      : verdict.scope === "action"
        ? `action:${verdict.scopeId}`
        : `task:${verdict.scopeId}`;
    builder.addEdge({ id: `review:${verdict.scope}:${verdict.scopeId}:${verdict.id}`, source, target: id, type: "review", label: "獨立審查" });
  }
}

function collaboration(builder: CanvasBuilder, input: GoalCanvasProjectionInput): void {
  const agents = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  const roles = new Map((input.roles ?? []).map((role) => [role.id, role]));
  for (const participant of input.participants ?? []) {
    if (participant.meetingId !== input.goalRun.meetingId) continue;
    const agent = agents.get(participant.agentId);
    const role = roles.get(participant.roleId);
    builder.addNode({ id: `agent:${participant.agentId}`, type: "agent", label: agent?.name ?? participant.agentId, status: agent?.status === "offline" ? "paused" : agent?.status === "attention" ? "blocked" : "running", entityId: participant.agentId, detail: { revision: participant.agentRevision ?? null } });
    builder.addNode({ id: `role:${participant.roleId}`, type: "role", label: role?.name ?? participant.roleSnapshot.name, status: "running", entityId: participant.roleId, detail: { version: participant.roleSnapshot.version } });
    builder.addEdge({ id: `assignment:${participant.id}`, source: `agent:${participant.agentId}`, target: `role:${participant.roleId}`, type: "assignment", label: participant.isChair ? "主席" : "代表" });
  }
  for (const task of input.plan?.tasks ?? []) {
    if (!task.assigneeAgentId) continue;
    const agent = agents.get(task.assigneeAgentId);
    builder.addNode({ id: `agent:${task.assigneeAgentId}`, type: "agent", label: agent?.name ?? task.assigneeAgentId, status: agent?.status === "offline" ? "paused" : agent?.status === "attention" ? "blocked" : "running", entityId: task.assigneeAgentId, detail: { assignment: "executor" } });
    builder.addNode({ id: `task:${task.id}`, type: "task", label: task.title, status: taskStatus(input.taskBindings.find((binding) => binding.planTaskId === task.id)?.state), entityId: task.id, detail: {} });
    builder.addEdge({ id: `assignment:${task.assigneeAgentId}:${task.id}`, source: `agent:${task.assigneeAgentId}`, target: `task:${task.id}`, type: "assignment", label: "負責" });
    const taskId = input.taskBindings.find((binding) => binding.planTaskId === task.id)?.taskId;
    const runtimeRun = input.runtimeRuns?.find((run) => run.taskId === taskId);
    if (runtimeRun) {
      const runtimeNode = `runtime:${runtimeRun.id}`;
      builder.addNode({ id: runtimeNode, type: "runtime", label: runtimeLabel(runtimeRun), status: runtimeStatus(runtimeRun.state), entityId: runtimeRun.id, detail: { taskId: runtimeRun.taskId, session: runtimeRun.providerSessionId } });
      builder.addEdge({ id: `assignment:${task.assigneeAgentId}:${runtimeNode}`, source: `agent:${task.assigneeAgentId}`, target: runtimeNode, type: "assignment", label: "執行" });
      builder.addEdge({ id: `usage:${runtimeNode}:${task.id}`, source: runtimeNode, target: `task:${task.id}`, type: "usage", label: "產出" });
    }
  }
}

function resources(builder: CanvasBuilder, input: GoalCanvasProjectionInput): void {
  const agents = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  const models = new Map((input.modelConnectors ?? []).map((model) => [model.id, model]));
  const skills = new Map((input.skills ?? []).map((skill) => [skill.id, skill]));
  const relevant = new Set<string>();
  input.participants?.filter((item) => item.meetingId === input.goalRun.meetingId).forEach((item) => relevant.add(item.agentId));
  input.plan?.tasks.forEach((task) => { if (task.assigneeAgentId) relevant.add(task.assigneeAgentId); });
  input.reviewerVerdicts.forEach((verdict) => relevant.add(verdict.reviewerAgentId));
  for (const agentId of relevant) {
    const agent = agents.get(agentId);
    if (!agent) continue;
    const agentNode = `agent:${agent.id}`;
    builder.addNode({ id: agentNode, type: "agent", label: agent.name, status: agent.status === "online" ? "running" : agent.status === "offline" ? "paused" : "blocked", entityId: agent.id, detail: { revision: agent.publishedRevision ?? agent.draftRevision ?? null } });
    if (agent.modelConnectorId) {
      const model = models.get(agent.modelConnectorId);
      const modelNode = `model:${agent.modelConnectorId}`;
      builder.addNode({ id: modelNode, type: "model", label: model?.name ?? agent.modelConnectorId, status: model?.enabled === false ? "blocked" : "running", entityId: agent.modelConnectorId, detail: { location: model?.location ?? null, model: model?.model ?? null } });
      builder.addEdge({ id: `usage:${agentNode}:${modelNode}`, source: agentNode, target: modelNode, type: "usage", label: "模型" });
    }
    agent.skillIds.forEach((skillId) => {
      const skill = skills.get(skillId);
      const node = `tool:skill:${skillId}`;
      builder.addNode({ id: node, type: "tool", label: skill?.name ?? skillId, status: skill?.status === "approved" ? "completed" : "blocked", entityId: skillId, detail: { kind: "skill", version: skill?.version ?? null } });
      builder.addEdge({ id: `usage:${agentNode}:${node}`, source: agentNode, target: node, type: "usage", label: "Skill" });
    });
    agent.toolGrants.forEach((grant) => {
      const connector = input.mcpConnectors?.find((item) => item.id === grant.connectorId);
      const node = `tool:mcp:${grant.connectorId}:${grant.toolName}`;
      builder.addNode({ id: node, type: "tool", label: grant.toolName, status: connector?.enabled === false ? "blocked" : "completed", entityId: grant.connectorId, detail: { kind: "read_only_mcp", connector: connector?.name ?? grant.connectorId } });
      builder.addEdge({ id: `usage:${agentNode}:${node}`, source: agentNode, target: node, type: "usage", label: "唯讀 MCP" });
    });
    const data = `data:${agent.id}`;
    builder.addNode({ id: data, type: "data", label: agent.dataSummary || "會議資料範圍", status: "completed", entityId: agent.id, detail: { scope: agent.dataSummary } });
    builder.addEdge({ id: `usage:${agentNode}:${data}`, source: agentNode, target: data, type: "usage", label: "資料" });
  }
  for (const task of input.plan?.tasks ?? []) {
    if (!task.action) continue;
    const adapter = input.actionAdapters?.find((item) => item.id === task.action!.adapterId);
    builder.addNode({ id: `action:${task.action.adapterId}:${task.action.actionKey}:${task.action.targetId}`, type: "action", label: adapter?.name ?? task.action.actionKey, status: adapter?.enabled === false ? "blocked" : "waiting", entityId: task.action.adapterId, detail: { target: task.action.targetId, catalogRevision: adapter?.catalogRevision ?? null, risk: task.action.riskClass } });
  }
  for (const run of input.runtimeRuns ?? []) {
    const runtimeNode = `runtime:${run.id}`;
    builder.addNode({
      id: runtimeNode,
      type: "runtime",
      label: runtimeLabel(run),
      status: runtimeStatus(run.state),
      entityId: run.id,
      detail: {
        taskId: run.taskId,
        policy: run.runtimeProfile.policy,
        timeoutMinutes: Math.round(run.runtimeProfile.timeoutMs / 60_000),
        checkpoint: run.eventCursor
      }
    });
    for (const capability of run.runtimeProfile.capabilities) {
      const toolNode = `tool:runtime:${run.id}:${capability}`;
      builder.addNode({ id: toolNode, type: "tool", label: capability, status: "completed", entityId: run.id, detail: { kind: "runtime_capability" } });
      builder.addEdge({ id: `usage:${runtimeNode}:${toolNode}`, source: runtimeNode, target: toolNode, type: "usage", label: "核准能力" });
    }
  }
}

export function projectGoalCanvas(input: GoalCanvasProjectionInput, lens: GoalCanvasLens, generatedAt = new Date().toISOString()): GoalCanvasSnapshot {
  const builder = new CanvasBuilder();
  if (lens === "progress") progress(builder, input, generatedAt);
  if (lens === "collaboration") collaboration(builder, input);
  if (lens === "resources") resources(builder, input);
  return builder.build(input.goalRun, lens, generatedAt);
}
