import type {
  Agent,
  AgentReadiness,
  Category,
  DiscussionGroup,
  DiscussionThread,
  Meeting,
  MeetingMode,
  MeetingPresetPreflightResponse,
  ParticipantAssignment,
  PublicPlatformSnapshot as PlatformSnapshot,
  Skill,
  Tag,
  PublicTask as Task,
  TaskStatus,
  ToolRegistrationKind,
  ThreadStatus
} from "@council/contracts";
import type { MeetingSseEventEnvelope } from "@council/contracts/api-contracts";

const toolRegistrationKindLabels: Record<ToolRegistrationKind, string> = {
  mcp_tool: "MCP Tool",
  function_wrapper: "Function Wrapper",
  library_wrapper: "Library Wrapper",
  program_adapter: "Program Adapter",
  api_wrapper: "API Wrapper"
};

export function toolRegistrationKindLabel(kind: ToolRegistrationKind): string {
  return toolRegistrationKindLabels[kind];
}

export interface IdempotencyRetryToken {
  signature: string;
  idempotencyKey: string;
}

export function idempotencyRetryToken(
  previous: IdempotencyRetryToken | null,
  signature: string,
  createKey: () => string
): IdempotencyRetryToken {
  return previous?.signature === signature ? previous : { signature, idempotencyKey: createKey() };
}

export class IdempotencyRetryRegistry {
  private readonly tokens = new Map<string, IdempotencyRetryToken>();

  acquire(signature: string, createKey: () => string): IdempotencyRetryToken {
    const current = this.tokens.get(signature);
    if (current) return current;
    const token = { signature, idempotencyKey: createKey() };
    this.tokens.set(signature, token);
    return token;
  }

  settle(token: IdempotencyRetryToken): void {
    if (this.tokens.get(token.signature) === token) this.tokens.delete(token.signature);
  }
}

export function persistedToolRunOutcome(
  snapshot: Pick<PlatformSnapshot, "speakerQueue" | "toolRuns">,
  meetingId: string,
  jobId: string,
  queueWasObserved: boolean
): "success" | "failure" | "cancelled" | null {
  if (snapshot.speakerQueue.some((item) => item.meetingId === meetingId && item.jobId === jobId)) return null;
  const run = snapshot.toolRuns.find((item) => item.meetingId === meetingId && item.jobId === jobId);
  if (run) return run.status === "failed" ? "failure" : "success";
  return queueWasObserved ? "cancelled" : null;
}

export function persistedAgentRunOutcome(
  snapshot: Pick<PlatformSnapshot, "meetings" | "speakerQueue" | "utterances">,
  meetingId: string,
  jobId: string,
  queueWasObserved: boolean
): "success" | "failure" | "cancelled" | null {
  if (snapshot.speakerQueue.some((item) => item.meetingId === meetingId && item.jobId === jobId)) return null;
  const utterance = snapshot.utterances.find((item) => item.meetingId === meetingId && item.turnId === jobId);
  if (utterance) return utterance.kind === "failure" ? "failure" : "success";
  const meeting = snapshot.meetings.find((item) => item.id === meetingId);
  if (meeting?.state === "paused") return "failure";
  if (meeting?.state === "closed" || queueWasObserved) return "cancelled";
  return null;
}

export type ClientMeetingEvent = MeetingSseEventEnvelope;

export interface MeetingEvidenceItem {
  id: string;
  source: "tool_run" | "utterance" | "task";
  status: "verified" | "failed" | "linked";
  title: string;
  subtitle: string;
  excerpt: string;
  createdAt: string;
  reference?: string;
  tool?: {
    connectorName: string;
    kind: ToolRegistrationKind;
    version: string;
    owner: string;
    goal: string;
  };
}

export type SkillValidationResult = "pending" | "passed" | "failed";
export type SkillLifecycleStatus = "draft" | "approved" | "revoked";

export interface SkillValidationRecord {
  result: SkillValidationResult;
  summary: string;
  checkedAt: string | null;
  contentDigest: string | null;
}

export interface SkillRecord {
  id: string;
  name: string;
  version: string;
  instructions: string;
  source: string;
  owner: string;
  contentDigest: string;
  validation: SkillValidationRecord;
  status: SkillLifecycleStatus;
  approvedAt: string | null;
  revokedAt: string | null;
  revocationReason: string | null;
}

export type SkillSnapshotEntry = Pick<Skill, "id" | "name" | "version" | "instructions"> &
  Partial<Omit<SkillRecord, "id" | "name" | "version" | "instructions">> & {
    status: SkillLifecycleStatus;
  };

export function normalizeSkill(skill: SkillSnapshotEntry): SkillRecord {
  const validationResult = skill.validation?.result ?? "pending";
  return {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    instructions: skill.instructions,
    source: skill.source ?? "未提供",
    owner: skill.owner ?? "未指定",
    contentDigest: skill.contentDigest ?? "",
    validation: {
      result: validationResult,
      summary: skill.validation?.summary ?? "尚未記錄人工驗證證據。",
      checkedAt: skill.validation?.checkedAt ?? null,
      contentDigest: skill.validation?.contentDigest ?? null
    },
    status: skill.status,
    approvedAt: skill.approvedAt ?? null,
    revokedAt: skill.revokedAt ?? null,
    revocationReason: skill.revocationReason ?? null
  };
}

export function clampText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

export function skillLifecycleState(skill: Pick<SkillRecord, "status" | "validation">): {
  label: string;
  tone: "pending" | "failed" | "ready" | "approved" | "revoked";
} {
  if (skill.status === "revoked") return { label: "已撤銷", tone: "revoked" };
  if (skill.status === "approved" && skill.validation.result === "passed") return { label: "已核准", tone: "approved" };
  if (skill.status === "approved") return { label: "需重新驗證", tone: "failed" };
  if (skill.validation.result === "failed") return { label: "驗證失敗", tone: "failed" };
  if (skill.validation.result === "passed") return { label: "待核准", tone: "ready" };
  return { label: "待驗證", tone: "pending" };
}

export function isSkillAssignable(skill: Pick<SkillRecord, "status" | "validation">): boolean {
  return skill.status === "approved" && skill.validation.result === "passed";
}

export function meetingsForThread(meetings: Meeting[], threadId: string): Meeting[] {
  return meetings
    .filter((meeting) => meeting.threadId === threadId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

export function latestMeetingForThread(meetings: Meeting[], threadId: string): Meeting | undefined {
  return meetingsForThread(meetings, threadId)[0];
}

export function preferredThreadId(threads: DiscussionThread[]): string | undefined {
  return [...threads]
    .sort((left, right) => {
      const leftOpen = left.status === "open";
      const rightOpen = right.status === "open";
      if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
      return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
    })[0]?.id;
}

export interface ThreadTaxonomy {
  groupName: string;
  categoryName: string;
  breadcrumb: string;
  tags: PlatformSnapshot["tags"];
}

export type ThreadStatusFilter = ThreadStatus | "all";

export interface ThreadDiscoveryFilter {
  query: string;
  tagIds: readonly string[];
  status: ThreadStatusFilter;
}

export interface ThreadDiscoverySource {
  threads: readonly DiscussionThread[];
  tags: readonly Tag[];
  categories: readonly Category[];
  groups: readonly DiscussionGroup[];
}

export interface DiscussionTaxonomyCategoryBranch {
  category: Category;
  threads: DiscussionThread[];
}

export interface DiscussionTaxonomyGroupBranch {
  group: DiscussionGroup;
  categories: DiscussionTaxonomyCategoryBranch[];
  threadCount: number;
}

export function discussionTaxonomyTree(
  groups: readonly DiscussionGroup[],
  categories: readonly Category[],
  threads: readonly DiscussionThread[],
  options: { hideEmptyBranches?: boolean } = {}
): DiscussionTaxonomyGroupBranch[] {
  const hideEmptyBranches = options.hideEmptyBranches ?? false;
  const categoriesByGroupId = new Map<string, Category[]>();
  for (const category of categories) {
    const groupCategories = categoriesByGroupId.get(category.groupId) ?? [];
    groupCategories.push(category);
    categoriesByGroupId.set(category.groupId, groupCategories);
  }
  const threadsByCategoryId = new Map<string, DiscussionThread[]>();
  for (const thread of threads) {
    const categoryThreads = threadsByCategoryId.get(thread.categoryId) ?? [];
    categoryThreads.push(thread);
    threadsByCategoryId.set(thread.categoryId, categoryThreads);
  }
  return groups.flatMap((group) => {
    const categoryBranches = (categoriesByGroupId.get(group.id) ?? [])
      .flatMap((category) => {
        const categoryThreads = threadsByCategoryId.get(category.id) ?? [];
        if (hideEmptyBranches && categoryThreads.length === 0) return [];
        return [{ category, threads: categoryThreads }];
      });
    const threadCount = categoryBranches.reduce((count, branch) => count + branch.threads.length, 0);
    if (hideEmptyBranches && threadCount === 0) return [];
    return [{ group, categories: categoryBranches, threadCount }];
  });
}

export function toggleCollapsedTaxonomyNode(collapsed: ReadonlySet<string>, nodeId: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(nodeId)) next.delete(nodeId);
  else next.add(nodeId);
  return next;
}

export function categoryBreadcrumb(snapshot: PlatformSnapshot, categoryId: string): string | null {
  const category = snapshot.categories.find((item) => item.id === categoryId);
  const group = category ? snapshot.groups.find((item) => item.id === category.groupId) : undefined;
  return category && group ? `${group.name} / ${category.name}` : null;
}

export function threadStatusLabel(status: ThreadStatus): string {
  if (status === "open") return "進行中";
  if (status === "resolved") return "已結案";
  return "已封存";
}

function normalizeString(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function threadHasOpenMeeting(snapshot: PlatformSnapshot, threadId: string): boolean {
  return snapshot.meetings.some((meeting) => meeting.threadId === threadId && meeting.state !== "closed");
}

export function canCreateMeetingForThread(snapshot: PlatformSnapshot, thread: DiscussionThread): boolean {
  return thread.status === "open" && !threadHasOpenMeeting(snapshot, thread.id);
}

export function canFinalizeThread(snapshot: PlatformSnapshot, thread: DiscussionThread, nextStatus: ThreadStatus): boolean {
  if (nextStatus === "open") return true;
  return !threadHasOpenMeeting(snapshot, thread.id);
}

export function filterThreadsByDiscovery(
  source: ThreadDiscoverySource,
  filter: ThreadDiscoveryFilter
): DiscussionThread[] {
  const normalizedQuery = normalizeString(filter.query);
  const selectedTags = new Set(filter.tagIds);
  return source.threads.filter((thread) => {
    if (filter.status !== "all" && thread.status !== filter.status) return false;
    if (selectedTags.size > 0) {
      for (const tagId of selectedTags) {
        if (!thread.tagIds.includes(tagId)) return false;
      }
    }
    if (!normalizedQuery) return true;
    const category = source.categories.find((item) => item.id === thread.categoryId);
    const group = category ? source.groups.find((item) => item.id === category.groupId) : undefined;
    const matchedTags = thread.tagIds
      .map((tagId) => source.tags.find((tag) => tag.id === tagId)?.name ?? "")
      .join(" ");
    const haystack = normalizeString(`${thread.title} ${thread.summary} ${group?.name ?? ""} ${category?.name ?? ""} ${matchedTags}`);
    return haystack.includes(normalizedQuery);
  });
}

export function compactTags(tags: PlatformSnapshot["tags"], limit: number): {
  visible: PlatformSnapshot["tags"];
  hidden: PlatformSnapshot["tags"];
} {
  const boundedLimit = Math.max(0, limit);
  return { visible: tags.slice(0, boundedLimit), hidden: tags.slice(boundedLimit) };
}

export function taskSyncNeedsPolling(task: Task): boolean {
  return task.sync.status === "queued";
}

export function taskExecutionNeedsPolling(task: Task): boolean {
  return task.execution.status === "queued" || task.execution.status === "running";
}

export function snapshotNeedsPolling(snapshot: PlatformSnapshot): boolean {
  return snapshot.tasks.some((task) => taskSyncNeedsPolling(task) || taskExecutionNeedsPolling(task));
}

export function taskSyncStateLabel(status: Task["sync"]["status"]): "未同步" | "排程中" | "已同步" | "失敗" {
  if (status === "queued") return "排程中";
  if (status === "synced") return "已同步";
  if (status === "failed") return "失敗";
  return "未同步";
}

export function orderedTaskTransitions(task: Task): Task["transitions"] {
  return [...task.transitions].sort((left, right) => right.at.localeCompare(left.at));
}

export function taxonomyForThread(snapshot: PlatformSnapshot, threadId: string): ThreadTaxonomy | null {
  const thread = snapshot.threads.find((item) => item.id === threadId);
  const category = thread ? snapshot.categories.find((item) => item.id === thread.categoryId) : undefined;
  const group = category ? snapshot.groups.find((item) => item.id === category.groupId) : undefined;
  if (!thread || !category || !group) return null;
  const tags = thread.tagIds.flatMap((tagId) => {
    const tag = snapshot.tags.find((item) => item.id === tagId);
    return tag ? [tag] : [];
  });
  return {
    groupName: group.name,
    categoryName: category.name,
    breadcrumb: `${group.name} / ${category.name}`,
    tags
  };
}

export function isAgentRunnable(snapshot: PlatformSnapshot, agentId: string): boolean {
  const agent = snapshot.agents.find((item) => item.id === agentId);
  return Boolean(agent?.modelConnectorId && snapshot.modelConnectors.some((connector) => connector.id === agent.modelConnectorId && connector.enabled));
}

export type PublishedAgentReadinessById = Readonly<Record<string, AgentReadiness | undefined>>;

export interface MeetingAgentAvailability {
  agent: Agent;
  readiness: AgentReadiness | null;
  available: boolean;
  blockingReason: string | null;
}

export interface MeetingParticipantPreflight {
  status: AgentReadiness["status"] | "checking";
  reason: string | null;
  blockedAgentIds: string[];
  warningAgentIds: string[];
}

export function agentReadinessBlockingReason(readiness: AgentReadiness): string | null {
  if (readiness.status !== "blocked") return null;
  return readiness.checks.find((check) => check.status === "blocked")?.message ?? "Agent readiness 未通過。";
}

export async function loadPublishedAgentReadiness(
  agentIds: readonly string[],
  loadReadinessBatch: (agentIds: readonly string[]) => Promise<readonly { agentId: string; readiness: AgentReadiness }[]>,
  batchSize = 50
): Promise<Record<string, AgentReadiness>> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error("Agent readiness batch size must be between 1 and 50.");
  }
  const requestedIds = [...new Set(agentIds)];
  if (requestedIds.length === 0) return {};
  const requested = new Set(requestedIds);
  const batches = Array.from({ length: Math.ceil(requestedIds.length / batchSize) }, (_item, index) => (
    requestedIds.slice(index * batchSize, (index + 1) * batchSize)
  ));
  const responses = (await Promise.all(batches.map((batch) => loadReadinessBatch(batch)))).flat();
  const readinessByAgentId: Record<string, AgentReadiness> = {};
  for (const result of responses) {
    if (!requested.has(result.agentId) || readinessByAgentId[result.agentId]) {
      throw new Error("Agent readiness batch response did not match the request.");
    }
    readinessByAgentId[result.agentId] = result.readiness;
  }
  if (requestedIds.some((agentId) => !readinessByAgentId[agentId])) {
    throw new Error("Agent readiness batch response was incomplete.");
  }
  return readinessByAgentId;
}

export function meetingAgentAvailability(
  snapshot: Pick<PlatformSnapshot, "agents">,
  readinessByAgentId: PublishedAgentReadinessById
): MeetingAgentAvailability[] {
  return snapshot.agents.map((agent) => {
    const readiness = readinessByAgentId[agent.id] ?? null;
    return {
      agent,
      readiness,
      available: Boolean(readiness && readiness.status !== "blocked"),
      blockingReason: readiness ? agentReadinessBlockingReason(readiness) : null
    };
  });
}

export function meetingParticipantPreflight(
  snapshot: Pick<PlatformSnapshot, "agents">,
  participantIds: readonly string[],
  readinessByAgentId: PublishedAgentReadinessById
): MeetingParticipantPreflight {
  const uniqueIds = [...new Set(participantIds)];
  if (uniqueIds.length === 0) {
    return {
      status: "blocked",
      reason: "至少選擇一位可用 Agent。",
      blockedAgentIds: [],
      warningAgentIds: []
    };
  }

  const blockedAgentIds: string[] = [];
  const warningAgentIds: string[] = [];
  let checking = false;
  for (const agentId of uniqueIds) {
    const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      blockedAgentIds.push(agentId);
      continue;
    }
    const readiness = readinessByAgentId[agentId];
    if (!readiness) {
      checking = true;
      continue;
    }
    if (readiness.status === "blocked") blockedAgentIds.push(agentId);
    if (readiness.status === "warning") warningAgentIds.push(agentId);
  }

  if (blockedAgentIds.length > 0) {
    const firstId = blockedAgentIds[0]!;
    const firstAgent = snapshot.agents.find((agent) => agent.id === firstId);
    const readiness = readinessByAgentId[firstId];
    const reason = readiness ? agentReadinessBlockingReason(readiness) : "找不到 Agent。";
    const remaining = blockedAgentIds.length - 1;
    return {
      status: "blocked",
      reason: `${firstAgent?.name ?? "Agent"}：${reason ?? "Agent readiness 未通過。"}${remaining > 0 ? `（另有 ${remaining} 位不可用）` : ""}`,
      blockedAgentIds,
      warningAgentIds
    };
  }
  if (checking) return { status: "checking", reason: null, blockedAgentIds, warningAgentIds };
  return {
    status: warningAgentIds.length > 0 ? "warning" : "ready",
    reason: null,
    blockedAgentIds,
    warningAgentIds
  };
}

export function meetingPresetBlockingReason(
  preflight: MeetingPresetPreflightResponse,
  agents: readonly Pick<Agent, "id" | "name">[]
): string | null {
  if (preflight.status !== "blocked") return null;
  if (preflight.invalidRoleIds.length > 0) return "Agent Team 包含已刪除或不存在的角色。";
  const blocked = preflight.agents.find((item) => item.readiness.status === "blocked");
  if (blocked) {
    const agent = agents.find((candidate) => candidate.id === blocked.agentId);
    return `${agent?.name ?? "Agent"}：${agentReadinessBlockingReason(blocked.readiness) ?? "Agent readiness 未通過。"}`;
  }
  if (preflight.team && preflight.team.status !== "active") return `Agent Team ${preflight.team.name} 已封存。`;
  return "會議範本目前不可用。";
}

export function runnableParticipantsForMeeting(snapshot: PlatformSnapshot, meetingId: string): ParticipantAssignment[] {
  return snapshot.participants.filter((participant) => participant.meetingId === meetingId && isAgentRunnable(snapshot, participant.agentId));
}

export function discussionContext(snapshot: PlatformSnapshot, threadId: string | null, meetingId: string | null = null) {
  const fallbackId = preferredThreadId(snapshot.threads);
  const thread = snapshot.threads.find((item) => item.id === threadId) ?? snapshot.threads.find((item) => item.id === fallbackId);
  const meetings = thread ? meetingsForThread(snapshot.meetings, thread.id) : [];
  const meeting = meetings.find((item) => item.id === meetingId) ?? meetings[0];
  return {
    thread,
    meetings,
    meeting,
    messages: snapshot.utterances.filter((item) => item.meetingId === meeting?.id),
    decisions: snapshot.decisions.filter((item) => item.meetingId === meeting?.id),
    participants: snapshot.participants.filter((item) => item.meetingId === meeting?.id),
    runnableParticipants: meeting ? runnableParticipantsForMeeting(snapshot, meeting.id) : []
  };
}

export function meetingEvidenceItems(snapshot: PlatformSnapshot, meetingId: string): MeetingEvidenceItem[] {
  const linkedUtteranceIds = new Set(
    (snapshot.toolRuns ?? []).filter((run) => run.meetingId === meetingId).map((run) => run.utteranceId)
  );
  const toolRuns: MeetingEvidenceItem[] = (snapshot.toolRuns ?? [])
    .filter((run) => run.meetingId === meetingId)
    .map((run) => {
      const utterance = snapshot.utterances.find((item) => item.id === run.utteranceId);
      return {
        id: `tool-run:${run.id}`,
        source: "tool_run" as const,
        status: run.status === "succeeded" ? "verified" as const : "failed" as const,
        title: run.toolSnapshot.displayName,
        subtitle: `${run.toolSnapshot.connectorName} · ${run.toolName}`,
        excerpt: utterance?.content ?? "證據內容不存在。",
        createdAt: run.createdAt,
        tool: {
          connectorName: run.toolSnapshot.connectorName,
          kind: run.toolSnapshot.kind,
          version: run.toolSnapshot.version,
          owner: run.toolSnapshot.owner,
          goal: run.toolSnapshot.goal
        }
      };
    });
  const utterances: MeetingEvidenceItem[] = snapshot.utterances
    .filter((utterance) =>
      utterance.meetingId === meetingId
      && (utterance.kind === "verified" || utterance.kind === "failure")
      && !linkedUtteranceIds.has(utterance.id)
    )
    .map((utterance) => ({
      id: `utterance:${utterance.id}`,
      source: "utterance" as const,
      status: utterance.kind === "failure" ? "failed" as const : "verified" as const,
      title: utterance.speakerName,
      subtitle: utterance.roleName ?? (utterance.speakerType === "tool" ? "工具證據" : "會議證據"),
      excerpt: utterance.content,
      createdAt: utterance.createdAt
    }));
  const taskEvidence: MeetingEvidenceItem[] = snapshot.tasks
    .filter((task) => task.meetingId === meetingId)
    .flatMap((task) => task.evidence.map((evidence) => ({
      id: `task:${task.id}:${evidence.id}`,
      source: "task" as const,
      status: "linked" as const,
      title: evidence.label,
      subtitle: `${task.title} · ${evidence.type}`,
      excerpt: evidence.reference,
      reference: evidence.reference,
      createdAt: evidence.createdAt
    })));

  return [...toolRuns, ...utterances, ...taskEvidence]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
}

export function activeChairSuggestion(snapshot: PlatformSnapshot, meetingId: string) {
  return [...(snapshot.chairSuggestions ?? [])]
    .filter((item) => item.meetingId === meetingId && item.status !== "resolved")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function chairSuggestionHistory(snapshot: PlatformSnapshot, meetingId: string, limit = 20) {
  return [...(snapshot.chairSuggestions ?? [])]
    .filter((item) => item.meetingId === meetingId && item.status === "resolved")
    .sort((left, right) => (right.resolvedAt ?? right.createdAt).localeCompare(left.resolvedAt ?? left.createdAt))
    .slice(0, Math.max(0, limit));
}

export function meetingActionOutcome(
  pending: { meetingId: string; jobId: string },
  event: Pick<ClientMeetingEvent, "type" | "meetingId" | "data">
): "success" | "failure" | "cancelled" | null {
  if (event.meetingId !== pending.meetingId || event.data.jobId !== pending.jobId) return null;
  if (event.type.endsWith(".cancelled")) return "cancelled";
  if (event.type.endsWith(".failed")) return "failure";
  return event.type === "utterance.created" ? "success" : null;
}

export function meetingActionQueueWasReleased(
  pending: { meetingId: string; jobId: string },
  event: Pick<ClientMeetingEvent, "type" | "meetingId" | "data">
): boolean {
  return event.type === "speaker.queue.changed"
    && event.meetingId === pending.meetingId
    && event.data.jobId === pending.jobId
    && event.data.status === "released";
}

export function normalizeMeetingParticipantSelection(
  participantIds: string[],
  chairAgentId: string | null
): { participantIds: string[]; chairAgentId: string | null } {
  const uniqueIds = [...new Set(participantIds)];
  return {
    participantIds: uniqueIds,
    chairAgentId: chairAgentId && uniqueIds.includes(chairAgentId) ? chairAgentId : uniqueIds[0] ?? null
  };
}

export function meetingModeStateLabel(mode: MeetingMode, primaryAgentName?: string, chairTurn = false): string {
  if (mode === "open") return "所有參與者可回應";
  if (mode === "fixed") return `下一位 · ${primaryAgentName ?? "無可用 Agent"}`;
  return chairTurn && primaryAgentName ? `主席回合 · ${primaryAgentName}` : "選一位角色回應";
}

export function groupTasks(tasks: Task[]): Record<TaskStatus, Task[]> {
  return {
    todo: tasks.filter((task) => task.status === "todo").sort((a, b) => a.position - b.position),
    in_progress: tasks.filter((task) => task.status === "in_progress").sort((a, b) => a.position - b.position),
    review: tasks.filter((task) => task.status === "review").sort((a, b) => a.position - b.position),
    done: tasks.filter((task) => task.status === "done").sort((a, b) => a.position - b.position)
  };
}

export function preferredTaskStatus(tasks: Task[]): TaskStatus {
  const priority: TaskStatus[] = ["in_progress", "review", "todo", "done"];
  return priority.find((status) => tasks.some((task) => task.status === status)) ?? "todo";
}

export function isNearScrollEnd(
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 80
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function toolOutputView(content: string): { summary: string; details: string } {
  const compact = (value: string) => value.length > 120 ? `${value.slice(0, 117)}...` : value;
  try {
    const value = JSON.parse(content) as unknown;
    const details = JSON.stringify(value, null, 2);
    if (Array.isArray(value)) return { summary: `工具回傳 ${value.length} 筆資料`, details };
    if (value && typeof value === "object") return { summary: `工具回傳 ${Object.keys(value).length} 個欄位`, details };
    return { summary: compact(String(value)), details };
  } catch {
    return {
      summary: compact(content),
      details: content
    };
  }
}
