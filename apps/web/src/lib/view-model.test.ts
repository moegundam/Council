import { describe, expect, it, vi } from "vitest";
import type { DiscussionThread, Meeting, PlatformSnapshot, Task } from "@council/contracts";
import {
  activeChairSuggestion,
  canCreateMeetingForThread,
  canFinalizeThread,
  categoryBreadcrumb,
  chairSuggestionHistory,
  clampText,
  compactTags,
  discussionTaxonomyTree,
  discussionContext,
  filterThreadsByDiscovery,
  groupTasks,
  IdempotencyRetryRegistry,
  idempotencyRetryToken,
  isNearScrollEnd,
  isSkillAssignable,
  latestMeetingForThread,
  meetingsForThread,
  meetingActionOutcome,
  meetingActionQueueWasReleased,
  meetingEvidenceItems,
  meetingModeStateLabel,
  normalizeMeetingParticipantSelection,
  normalizeSkill,
  orderedTaskTransitions,
  preferredTaskStatus,
  preferredThreadId,
  persistedToolRunOutcome,
  persistedAgentRunOutcome,
  runnableParticipantsForMeeting,
  snapshotNeedsPolling,
  taskExecutionNeedsPolling,
  taskSyncNeedsPolling,
  taskSyncStateLabel,
  taxonomyForThread,
  threadHasOpenMeeting,
  threadStatusLabel,
  toggleCollapsedTaxonomyNode,
  toolRegistrationKindLabel,
  toolOutputView,
  skillLifecycleState,
  type ThreadDiscoveryFilter
} from "./view-model.js";

describe("web view model", () => {
  it("reuses an idempotency key only for the same uncertain request", () => {
    const createKey = vi.fn(() => "new-key");
    const pending = { signature: "same-request", idempotencyKey: "existing-key" };

    expect(idempotencyRetryToken(pending, "same-request", createKey)).toBe(pending);
    expect(createKey).not.toHaveBeenCalled();
    expect(idempotencyRetryToken(pending, "changed-request", createKey)).toEqual({
      signature: "changed-request",
      idempotencyKey: "new-key"
    });
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("retains independent uncertain create identities until each request settles", () => {
    const createKey = vi.fn()
      .mockReturnValueOnce("topic-key-a")
      .mockReturnValueOnce("topic-key-b")
      .mockReturnValueOnce("topic-key-a-after-settlement");
    const registry = new IdempotencyRetryRegistry();

    const topicA = registry.acquire("topic-a", createKey);
    const topicB = registry.acquire("topic-b", createKey);

    expect(registry.acquire("topic-a", createKey)).toBe(topicA);
    expect(registry.acquire("topic-b", createKey)).toBe(topicB);
    expect(createKey).toHaveBeenCalledTimes(2);

    registry.settle(topicB);
    expect(registry.acquire("topic-a", createKey)).toBe(topicA);
    registry.settle(topicA);
    expect(registry.acquire("topic-a", createKey)).toEqual({
      signature: "topic-a",
      idempotencyKey: "topic-key-a-after-settlement"
    });
  });

  it("reconciles a pending tool action from durable Tool Run state without SSE", () => {
    const snapshot = {
      speakerQueue: [],
      toolRuns: [{ meetingId: "meeting", jobId: "job", status: "succeeded" }]
    } as unknown as PlatformSnapshot;

    expect(persistedToolRunOutcome(snapshot, "meeting", "job", false)).toBe("success");
    expect(persistedToolRunOutcome(snapshot, "meeting", "missing", false)).toBeNull();
    snapshot.toolRuns[0]!.status = "failed";
    expect(persistedToolRunOutcome(snapshot, "meeting", "job", false)).toBe("failure");
  });

  it("reconciles an observed tool queue disappearance as cancelled without guessing for an unseen job", () => {
    const snapshot = {
      speakerQueue: [{ meetingId: "meeting", jobId: "job" }],
      toolRuns: []
    } as unknown as PlatformSnapshot;

    expect(persistedToolRunOutcome(snapshot, "meeting", "job", false)).toBeNull();
    snapshot.speakerQueue = [];
    expect(persistedToolRunOutcome(snapshot, "meeting", "job", false)).toBeNull();
    expect(persistedToolRunOutcome(snapshot, "meeting", "job", true)).toBe("cancelled");
  });

  it("correlates only an exact released speaker queue event to the pending Meeting action", () => {
    const pending = { meetingId: "meeting", jobId: "job" };
    const released = {
      type: "speaker.queue.changed",
      meetingId: "meeting",
      data: { jobId: "job", status: "released", reason: "stale_authorization" }
    } as Parameters<typeof meetingActionQueueWasReleased>[1];

    expect(meetingActionQueueWasReleased(pending, released)).toBe(true);
    expect(meetingActionQueueWasReleased(pending, {
      ...released,
      data: { ...released.data, status: "running" }
    })).toBe(false);
    expect(meetingActionQueueWasReleased(pending, { ...released, meetingId: "other-meeting" })).toBe(false);
    expect(meetingActionQueueWasReleased(pending, {
      ...released,
      data: { ...released.data, jobId: "other-job" }
    })).toBe(false);
  });

  it("reconciles a pending Agent action from durable Meeting state without terminal SSE", () => {
    const snapshot = {
      meetings: [{ id: "meeting", state: "active" }],
      speakerQueue: [{ meetingId: "meeting", jobId: "job" }],
      utterances: []
    } as unknown as PlatformSnapshot;

    expect(persistedAgentRunOutcome(snapshot, "meeting", "job", false)).toBeNull();
    snapshot.speakerQueue = [];
    snapshot.utterances = [{ meetingId: "meeting", turnId: "job", kind: "inference" }] as PlatformSnapshot["utterances"];
    expect(persistedAgentRunOutcome(snapshot, "meeting", "job", false)).toBe("success");

    snapshot.utterances = [];
    snapshot.meetings[0]!.state = "paused";
    expect(persistedAgentRunOutcome(snapshot, "meeting", "job", false)).toBe("failure");

    snapshot.meetings[0]!.state = "active";
    expect(persistedAgentRunOutcome(snapshot, "meeting", "job", false)).toBeNull();
    expect(persistedAgentRunOutcome(snapshot, "meeting", "job", true)).toBe("cancelled");
  });

  it("renders Tool Catalog kinds as user-facing labels", () => {
    expect(toolRegistrationKindLabel("mcp_tool")).toBe("MCP Tool");
    expect(toolRegistrationKindLabel("library_wrapper")).toBe("Library Wrapper");
  });

  it("fails closed when an approved Skill has no validation evidence", () => {
    const skill = normalizeSkill({
      id: "skill-1",
      name: "會議整理",
      version: "1.0.0",
      instructions: "整理決議",
      status: "approved"
    });

    expect(skill.source).toBe("未提供");
    expect(skill.validation.result).toBe("pending");
    expect(skillLifecycleState(skill)).toEqual({ label: "需重新驗證", tone: "failed" });
    expect(isSkillAssignable(skill)).toBe(false);
  });

  it("maps draft Skill validation states to the next lifecycle action", () => {
    const base = {
      status: "draft" as const,
      validation: { result: "pending" as const, summary: "", checkedAt: null, contentDigest: null }
    };

    expect(skillLifecycleState(base)).toEqual({ label: "待驗證", tone: "pending" });
    expect(skillLifecycleState({ ...base, validation: { ...base.validation, result: "failed" } })).toEqual({ label: "驗證失敗", tone: "failed" });
    expect(skillLifecycleState({ ...base, validation: { ...base.validation, result: "passed" } })).toEqual({ label: "待核准", tone: "ready" });
    expect(isSkillAssignable({ ...base, status: "approved", validation: { ...base.validation, result: "passed" } })).toBe(true);
    expect(isSkillAssignable({ ...base, status: "approved", validation: { ...base.validation, result: "failed" } })).toBe(false);
    expect(skillLifecycleState({ ...base, status: "approved", validation: { ...base.validation, result: "failed" } })).toEqual({ label: "需重新驗證", tone: "failed" });
  });

  it("clamps compact Skill copy without changing short text", () => {
    expect(clampText("短文字", 10)).toBe("短文字");
    expect(clampText("1234567890", 6)).toBe("123...");
  });

  it("selects the newest meeting for a thread", () => {
    const meetings = [
      { id: "old", threadId: "thread", createdAt: "2026-01-01T00:00:00Z", agenda: { revision: 0, items: [] } },
      { id: "new", threadId: "thread", createdAt: "2026-02-01T00:00:00Z", agenda: { revision: 0, items: [] } }
    ] as unknown as Meeting[];
    expect(latestMeetingForThread(meetings, "thread")?.id).toBe("new");
  });

  it("orders every meeting session for a topic from newest to oldest without mutating the snapshot", () => {
    const meetings = [
      { id: "old", threadId: "thread", createdAt: "2026-01-01T00:00:00Z", agenda: { revision: 0, items: [] } },
      { id: "foreign", threadId: "other", createdAt: "2026-03-01T00:00:00Z", agenda: { revision: 0, items: [] } },
      { id: "same-b", threadId: "thread", createdAt: "2026-02-01T00:00:00Z", agenda: { revision: 0, items: [] } },
      { id: "same-a", threadId: "thread", createdAt: "2026-02-01T00:00:00Z", agenda: { revision: 0, items: [] } }
    ] as unknown as Meeting[];

    expect(meetingsForThread(meetings, "thread").map((meeting) => meeting.id)).toEqual(["same-a", "same-b", "old"]);
    expect(meetingsForThread(meetings, "missing")).toEqual([]);
    expect(meetings.map((meeting) => meeting.id)).toEqual(["old", "foreign", "same-b", "same-a"]);
  });

  it("opens the most recent active discussion when no selection is stored", () => {
    const threads = [
      { id: "closed-new", status: "resolved", createdAt: "2026-07-16T12:00:00Z" },
      { id: "open-old", status: "open", createdAt: "2026-07-14T12:00:00Z" },
      { id: "open-new", status: "open", createdAt: "2026-07-15T12:00:00Z" }
    ] as DiscussionThread[];

    expect(preferredThreadId(threads)).toBe("open-new");
  });

  it("derives the Group, Category, and Tag labels for a Topic", () => {
    const snapshot = {
      groups: [{ id: "group", revision: 1, name: "產品研發" }],
      categories: [{ id: "category", revision: 1, groupId: "group", name: "平台架構" }],
      tags: [
        { id: "tag-a", name: "高優先", color: "red" },
        { id: "tag-b", name: "地端 AI", color: "blue" }
      ],
      threads: [{ id: "thread", categoryId: "category", tagIds: ["tag-a", "tag-b"] }]
    } as PlatformSnapshot;

    expect(taxonomyForThread(snapshot, "thread")).toEqual({
      groupName: "產品研發",
      categoryName: "平台架構",
      breadcrumb: "產品研發 / 平台架構",
      tags: [
        { id: "tag-a", name: "高優先", color: "red" },
        { id: "tag-b", name: "地端 AI", color: "blue" }
      ]
    });
    expect(taxonomyForThread(snapshot, "missing")).toBeNull();
  });

  it("keeps Group context in Category option labels", () => {
    const snapshot = {
      groups: [{ id: "group-a", revision: 1, name: "產品" }, { id: "group-b", revision: 1, name: "營運" }],
      categories: [
        { id: "category-a", revision: 1, groupId: "group-a", name: "驗收" },
        { id: "category-b", revision: 1, groupId: "group-b", name: "驗收" }
      ]
    } as PlatformSnapshot;

    expect(categoryBreadcrumb(snapshot, "category-a")).toBe("產品 / 驗收");
    expect(categoryBreadcrumb(snapshot, "category-b")).toBe("營運 / 驗收");
    expect(categoryBreadcrumb(snapshot, "missing")).toBeNull();
  });

  it("builds a visible Group, Category, and Topic tree while retaining empty taxonomy branches", () => {
    const groups = [
      { id: "group-a", revision: 1, name: "產品研發" },
      { id: "group-b", revision: 1, name: "平台營運" },
      { id: "group-c", revision: 1, name: "尚未分類" }
    ];
    const categories = [
      { id: "category-a", revision: 1, groupId: "group-a", name: "平台架構" },
      { id: "category-b", revision: 1, groupId: "group-a", name: "產品治理" },
      { id: "category-c", revision: 1, groupId: "group-b", name: "產品驗收" }
    ];
    const threads = [
      { id: "thread-a", categoryId: "category-a", title: "架構評審", summary: "", status: "open", tagIds: [], revision: 1, createdAt: "2026-07-20T00:00:00Z" },
      { id: "thread-b", categoryId: "category-a", title: "執行邊界", summary: "", status: "resolved", tagIds: [], revision: 1, createdAt: "2026-07-20T00:01:00Z" },
      { id: "thread-c", categoryId: "category-c", title: "正式驗收", summary: "", status: "open", tagIds: [], revision: 1, createdAt: "2026-07-20T00:02:00Z" }
    ] as DiscussionThread[];

    const tree = discussionTaxonomyTree(groups, categories, threads);

    expect(tree.map((branch) => [branch.group.id, branch.threadCount])).toEqual([
      ["group-a", 2],
      ["group-b", 1],
      ["group-c", 0]
    ]);
    expect(tree[0]?.categories.map((branch) => [branch.category.id, branch.threads.map((thread) => thread.id)])).toEqual([
      ["category-a", ["thread-a", "thread-b"]],
      ["category-b", []]
    ]);
    expect(tree[2]?.categories).toEqual([]);
  });

  it("prunes empty Group and Category branches when the tree represents discovery results", () => {
    const groups = [
      { id: "group-a", revision: 1, name: "產品研發" },
      { id: "group-b", revision: 1, name: "平台營運" }
    ];
    const categories = [
      { id: "category-a", revision: 1, groupId: "group-a", name: "平台架構" },
      { id: "category-b", revision: 1, groupId: "group-a", name: "產品治理" },
      { id: "category-c", revision: 1, groupId: "group-b", name: "產品驗收" }
    ];
    const matchingThreads = [
      { id: "thread-c", categoryId: "category-c", title: "正式驗收", summary: "", status: "open", tagIds: [], revision: 1, createdAt: "2026-07-20T00:02:00Z" }
    ] as DiscussionThread[];

    const tree = discussionTaxonomyTree(groups, categories, matchingThreads, { hideEmptyBranches: true });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.group.id).toBe("group-b");
    expect(tree[0]?.threadCount).toBe(1);
    expect(tree[0]?.categories.map((branch) => branch.category.id)).toEqual(["category-c"]);
    expect(tree[0]?.categories[0]?.threads.map((thread) => thread.id)).toEqual(["thread-c"]);
  });

  it("toggles taxonomy disclosure state without mutating the previous set", () => {
    const collapsed = new Set(["group:one"]);

    const expanded = toggleCollapsedTaxonomyNode(collapsed, "group:one");
    const collapsedAgain = toggleCollapsedTaxonomyNode(expanded, "group:one");

    expect([...collapsed]).toEqual(["group:one"]);
    expect([...expanded]).toEqual([]);
    expect([...collapsedAgain]).toEqual(["group:one"]);
  });

  it("reports Tags hidden by a compact summary", () => {
    const tags = [
      { id: "one", name: "一", color: "green" },
      { id: "two", name: "二", color: "blue" },
      { id: "three", name: "三", color: "amber" },
      { id: "four", name: "四", color: "red" }
    ] as PlatformSnapshot["tags"];

    expect(compactTags(tags, 3)).toEqual({ visible: tags.slice(0, 3), hidden: tags.slice(3) });
  });

  it("keeps all four stable task columns", () => {
    const task = { id: "task", status: "review", position: 0 } as Task;
    const columns = groupTasks([task]);
    expect(Object.keys(columns)).toEqual(["todo", "in_progress", "review", "done"]);
    expect(columns.review[0]?.id).toBe("task");
  });

  it("opens mobile tasks on the most actionable non-empty status", () => {
    const tasks = [
      { id: "todo", status: "todo" },
      { id: "review", status: "review" },
      { id: "progress", status: "in_progress" }
    ] as Task[];

    expect(preferredTaskStatus(tasks)).toBe("in_progress");
    expect(preferredTaskStatus([{ id: "done", status: "done" } as Task])).toBe("done");
    expect(preferredTaskStatus([])).toBe("todo");
  });

  it("distinguishes readers at the latest transcript edge from history readers", () => {
    expect(isNearScrollEnd({ scrollHeight: 1_000, scrollTop: 620, clientHeight: 300 })).toBe(true);
    expect(isNearScrollEnd({ scrollHeight: 1_000, scrollTop: 400, clientHeight: 300 })).toBe(false);
  });

  it("settles only the matching background meeting action", () => {
    const pending = { meetingId: "meeting-a", jobId: "job-a" };
    expect(meetingActionOutcome(pending, {
      type: "utterance.created",
      meetingId: "meeting-a",
      data: { utterance: { speakerType: "human" } }
    })).toBeNull();
    expect(meetingActionOutcome(pending, {
      type: "utterance.created",
      meetingId: "meeting-a",
      data: { jobId: "job-a", jobName: "agent-turn" }
    })).toBe("success");
    expect(meetingActionOutcome(pending, {
      type: "agent.failed",
      meetingId: "meeting-a",
      data: { jobId: "job-a", jobName: "agent-turn" }
    })).toBe("failure");
    expect(meetingActionOutcome(pending, {
      type: "agent.cancelled",
      meetingId: "meeting-a",
      data: { jobId: "job-a", jobName: "agent-turn" }
    })).toBe("cancelled");
    expect(meetingActionOutcome(pending, {
      type: "utterance.created",
      meetingId: "meeting-b",
      data: { jobId: "job-a", jobName: "agent-turn" }
    })).toBeNull();
    expect(meetingActionOutcome(pending, {
      type: "utterance.created",
      meetingId: "meeting-a",
      data: { jobId: "stale-job", jobName: "agent-turn" }
    })).toBeNull();
  });

  it("derives the reload-safe active Chair suggestion and bounded resolved history", () => {
    const base = {
      meetingId: "meeting-a",
      sourceUtteranceId: "utterance",
      reason: "off_topic" as const,
      suggestedMode: "chaired" as const,
      explanation: "請由主席重新聚焦。",
      score: 0.95,
      suggestedAgentId: "chair",
      suggestedAgentName: "Chair",
      modeAcceptedAt: null,
      requestedAgentId: null,
      requestedAgentJobId: null,
      resolutionNote: null,
      resolvedBy: null,
      transitions: [],
      resolvedAt: null
    } as unknown as PlatformSnapshot;
    const snapshot = {
      chairSuggestions: [
        { ...base, id: "resolved-old", status: "resolved", resolution: "dismissed", createdAt: "2026-07-16T01:00:00Z", resolvedAt: "2026-07-16T01:01:00Z" },
        { ...base, id: "active", status: "pending", resolution: null, createdAt: "2026-07-16T03:00:00Z", requestedAgentId: "chair", requestedAgentJobId: "job" },
        { ...base, id: "resolved-new", status: "resolved", resolution: "completed", createdAt: "2026-07-16T02:00:00Z", resolvedAt: "2026-07-16T02:01:00Z" },
        { ...base, id: "other-meeting", meetingId: "meeting-b", status: "open", resolution: null, createdAt: "2026-07-16T04:00:00Z" }
      ]
    } as unknown as PlatformSnapshot;

    expect(activeChairSuggestion(snapshot, "meeting-a")?.id).toBe("active");
    expect(chairSuggestionHistory(snapshot, "meeting-a", 1).map((item) => item.id)).toEqual(["resolved-new"]);
    expect(activeChairSuggestion({ ...snapshot, chairSuggestions: [] }, "meeting-a")).toBeNull();
  });

  it("keeps the meeting Chair inside the selected participant set", () => {
    expect(normalizeMeetingParticipantSelection(["chair", "reviewer", "reviewer"], "chair")).toEqual({
      participantIds: ["chair", "reviewer"],
      chairAgentId: "chair"
    });
    expect(normalizeMeetingParticipantSelection(["reviewer"], "chair")).toEqual({
      participantIds: ["reviewer"],
      chairAgentId: "reviewer"
    });
    expect(normalizeMeetingParticipantSelection([], "chair")).toEqual({ participantIds: [], chairAgentId: null });
  });

  it("presents a compact truthful state for each meeting mode", () => {
    expect(meetingModeStateLabel("open")).toBe("所有參與者可回應");
    expect(meetingModeStateLabel("fixed", "Architect-R")).toBe("下一位 · Architect-R");
    expect(meetingModeStateLabel("fixed")).toBe("下一位 · 無可用 Agent");
    expect(meetingModeStateLabel("chaired", "Chair-Local", true)).toBe("主席回合 · Chair-Local");
    expect(meetingModeStateLabel("chaired", "Architect-R", false)).toBe("選一位角色回應");
  });

  it("keeps only participants with an enabled assigned model runnable", () => {
    const snapshot = {
      agents: [
        { id: "ready", modelConnectorId: "model" },
        { id: "missing", modelConnectorId: null },
        { id: "disabled", modelConnectorId: "disabled-model" }
      ],
      modelConnectors: [
        { id: "model", enabled: true },
        { id: "disabled-model", enabled: false }
      ],
      participants: [
        { id: "p1", meetingId: "meeting", agentId: "ready" },
        { id: "p2", meetingId: "meeting", agentId: "missing" },
        { id: "p3", meetingId: "meeting", agentId: "disabled" }
      ]
    } as PlatformSnapshot;

    expect(runnableParticipantsForMeeting(snapshot, "meeting").map((item) => item.agentId)).toEqual(["ready"]);
  });

  it("keeps structured tool output compact until details are requested", () => {
    expect(toolOutputView('{"status":"ok","count":3}')).toEqual({
      summary: "工具回傳 2 個欄位",
      details: '{\n  "status": "ok",\n  "count": 3\n}'
    });
    expect(toolOutputView("No matching records")).toEqual({
      summary: "No matching records",
      details: "No matching records"
    });
    expect(toolOutputView(JSON.stringify("x".repeat(5_000))).summary).toHaveLength(120);
  });

  it("aggregates Tool Runs, transcript evidence, and Task evidence without duplicating linked tool output", () => {
    const snapshot = {
      mcpConnectors: [{
        id: "connector",
        name: "Docs",
        approvedTools: ["search"],
        toolRegistrations: [{
          toolName: "search",
          displayName: "目前已改名",
          kind: "mcp_tool",
          version: "2.0.0",
          owner: "Current Owner",
          goal: "目前的工具目標。"
        }]
      }],
      toolRuns: [{
        id: "run",
        jobId: "job",
        requestFingerprint: "fingerprint",
        meetingId: "meeting",
        agentId: "agent",
        connectorId: "connector",
        toolName: "search",
        toolSnapshot: {
          connectorName: "Docs",
          toolName: "search",
          displayName: "政策搜尋",
          kind: "mcp_tool",
          version: "1.0.0",
          owner: "Knowledge Team",
          goal: "搜尋已核准的政策。"
        },
        status: "succeeded",
        utteranceId: "tool-utterance",
        createdAt: "2026-07-19T03:00:00.000Z"
      }],
      utterances: [
        { id: "tool-utterance", meetingId: "meeting", speakerType: "tool", speakerName: "Docs.search", roleName: "MCP Tool", content: "{\"documents\":1}", kind: "verified", evidenceCount: 1, createdAt: "2026-07-19T03:00:00.000Z" },
        { id: "manual-evidence", meetingId: "meeting", speakerType: "agent", speakerName: "Reviewer", roleName: "安全審查", content: "政策版本已人工核對。", kind: "verified", evidenceCount: 1, createdAt: "2026-07-19T02:00:00.000Z" }
      ],
      tasks: [{
        id: "task",
        meetingId: "meeting",
        evidence: [{ id: "task-evidence", type: "url", label: "驗收紀錄", reference: "https://example.com/evidence", addedBy: "owner", createdAt: "2026-07-19T01:00:00.000Z" }]
      }]
    } as unknown as PlatformSnapshot;

    const items = meetingEvidenceItems(snapshot, "meeting");
    expect(items.map((item) => item.id)).toEqual(["tool-run:run", "utterance:manual-evidence", "task:task:task-evidence"]);
    expect(items[0]).toMatchObject({
      source: "tool_run",
      status: "verified",
      title: "政策搜尋",
      excerpt: '{"documents":1}',
      tool: {
        connectorName: "Docs",
        kind: "mcp_tool",
        version: "1.0.0",
        owner: "Knowledge Team",
        goal: "搜尋已核准的政策。"
      }
    });
    expect(items.filter((item) => item.id === "utterance:tool-utterance")).toEqual([]);
    expect(items[2]).toMatchObject({ source: "task", status: "linked", title: "驗收紀錄", reference: "https://example.com/evidence" });
  });

  it("detects queued sync state for polling", () => {
    const taskQueued = { sync: { status: "queued" } } as unknown as Task;
    const taskDone = { sync: { status: "synced" } } as unknown as Task;
    expect(taskSyncNeedsPolling(taskQueued)).toBe(true);
    expect(taskSyncNeedsPolling(taskDone)).toBe(false);
    expect(taskSyncStateLabel("queued")).toBe("排程中");
    expect(taskSyncStateLabel("synced")).toBe("已同步");
    expect(taskSyncStateLabel("failed")).toBe("失敗");
    expect(taskSyncStateLabel("not_synced")).toBe("未同步");
  });

  it("detects queued and running Task Agent execution for polling", () => {
    const idle = { execution: { status: "idle" } } as unknown as Task;
    const queued = { execution: { status: "queued" } } as unknown as Task;
    const running = { execution: { status: "running" } } as unknown as Task;
    const completed = { execution: { status: "completed" } } as unknown as Task;

    expect(taskExecutionNeedsPolling(idle)).toBe(false);
    expect(taskExecutionNeedsPolling(queued)).toBe(true);
    expect(taskExecutionNeedsPolling(running)).toBe(true);
    expect(taskExecutionNeedsPolling(completed)).toBe(false);
  });

  it("suspends polling only when no queued sync or active Agent execution exists", () => {
    const snapshot = {
      tasks: [
        { id: "task-a", sync: { status: "not_synced" }, execution: { status: "idle" } },
        { id: "task-b", sync: { status: "queued" }, execution: { status: "idle" } },
        { id: "task-c", sync: { status: "synced" }, execution: { status: "running" } }
      ]
    } as PlatformSnapshot;

    expect(snapshotNeedsPolling(snapshot)).toBe(true);
    expect(snapshotNeedsPolling({ ...snapshot, tasks: snapshot.tasks.slice(0, 1) } as PlatformSnapshot)).toBe(false);
    expect(snapshotNeedsPolling({ ...snapshot, tasks: snapshot.tasks.slice(2) } as PlatformSnapshot)).toBe(true);
  });

  it("orders transitions newest-first for read-only history views", () => {
    const task = {
      transitions: [
        { id: "old", type: "created", actor: "system", at: "2026-07-17T00:00:00.000Z" },
        { id: "new", type: "moved", actor: "owner", at: "2026-07-18T00:00:00.000Z" }
      ]
    } as Task;
    expect(orderedTaskTransitions(task).map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("filters topics by status and tags with Chinese status labels", () => {
    const snapshot = {
      threads: [
        { id: "t1", title: "架構討論", summary: "MCP 與模型邊界", status: "open", tagIds: ["tag-a"], categoryId: "cat-a", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "t2", title: "測試題目", summary: "待討論結案流程", status: "resolved", tagIds: ["tag-b"], categoryId: "cat-b", createdAt: "2026-07-01T00:10:00.000Z" }
      ],
      tags: [
        { id: "tag-a", name: "地端" },
        { id: "tag-b", name: "測試" }
      ],
      categories: [
        { id: "cat-a", groupId: "group", name: "平台" },
        { id: "cat-b", groupId: "group", name: "流程" }
      ]
    } as unknown as PlatformSnapshot;

    const source = {
      threads: snapshot.threads,
      tags: snapshot.tags,
      categories: snapshot.categories,
      groups: [{ id: "group", revision: 1, name: "產品群" }]
    };
    const filterOpen: ThreadDiscoveryFilter = { query: "", status: "open", tagIds: [] };
    const filterArchived: ThreadDiscoveryFilter = { query: "", status: "archived", tagIds: [] };
    const filterAllByTag: ThreadDiscoveryFilter = { query: "", status: "all", tagIds: ["tag-a"] };

    expect(filterThreadsByDiscovery(source, filterOpen)).toHaveLength(1);
    expect(filterThreadsByDiscovery(source, filterOpen)[0]?.id).toBe("t1");
    expect(filterThreadsByDiscovery(source, filterArchived)).toHaveLength(0);
    expect(filterThreadsByDiscovery(source, filterAllByTag)[0]?.id).toBe("t1");
    expect(filterThreadsByDiscovery(source, { query: "", status: "resolved", tagIds: ["tag-a"] })).toEqual([]);
    expect(filterThreadsByDiscovery(source, { query: "", status: "all", tagIds: [] }).map((thread) => thread.id)).toEqual(["t1", "t2"]);
    expect(threadStatusLabel("resolved")).toBe("已結案");
  });

  it("filters topics by search term across title/summary/category/tag", () => {
    const snapshot = {
      threads: [
        { id: "t1", title: "MCP 對接設計", summary: "權限與審批", status: "open", tagIds: ["tag-a"], categoryId: "cat-a", createdAt: "2026-07-01T00:00:00.000Z" },
        { id: "t2", title: "地端部署", summary: "本地運行", status: "open", tagIds: ["tag-b"], categoryId: "cat-b", createdAt: "2026-07-01T00:10:00.000Z" }
      ],
      tags: [
        { id: "tag-a", name: "規格" },
        { id: "tag-b", name: "外包" }
      ],
      categories: [
        { id: "cat-a", name: "討論", groupId: "group-a" },
        { id: "cat-b", name: "執行", groupId: "group-b" }
      ],
      groups: [
        { id: "group-a", revision: 1, name: "產品治理" },
        { id: "group-b", revision: 1, name: "平台營運" }
      ]
    } as unknown as PlatformSnapshot;

    expect(filterThreadsByDiscovery(snapshot, { query: "ｍｃｐ", status: "all", tagIds: [] })[0]?.id).toBe("t1");
    expect(filterThreadsByDiscovery(snapshot, { query: "外包", status: "all", tagIds: [] })[0]?.id).toBe("t2");
    expect(filterThreadsByDiscovery(snapshot, { query: "產品治理", status: "all", tagIds: [] })[0]?.id).toBe("t1");
    expect(filterThreadsByDiscovery(snapshot, { query: "平台營運", status: "all", tagIds: [] })[0]?.id).toBe("t2");
  });

  it("prevents finalize transition when thread has open meeting", () => {
    const snapshot = {
      threads: [{ id: "topic", status: "open", createdAt: "2026-07-01T00:00:00.000Z" }],
      meetings: [{ id: "meeting", threadId: "topic", state: "active", agenda: { revision: 0, items: [] } }, { id: "meeting-closed", threadId: "topic", state: "closed", agenda: { revision: 0, items: [] } }]
    } as unknown as PlatformSnapshot;

    const thread = snapshot.threads[0] as DiscussionThread;
    expect(canFinalizeThread(snapshot, thread, "resolved")).toBe(false);
    expect(canFinalizeThread(snapshot, thread, "archived")).toBe(false);
    expect(canFinalizeThread({ ...snapshot, meetings: [{ id: "meeting", threadId: "topic", state: "closed", agenda: { revision: 0, items: [] } }] } as unknown as PlatformSnapshot, thread, "resolved")).toBe(true);
  });

  it.each([
    ["open", [], true],
    ["open", ["closed"], true],
    ["open", ["closed", "draft"], false],
    ["open", ["active"], false],
    ["open", ["paused"], false],
    ["resolved", [], false],
    ["archived", [], false]
  ] as const)("derives Meeting creation eligibility for a %s Topic with %j sessions", (status, states, expected) => {
    const thread = { id: "topic", status } as DiscussionThread;
    const snapshot = {
      threads: [thread],
      meetings: states.map((state, index) => ({ id: `meeting-${index}`, threadId: thread.id, state, agenda: { revision: 0, items: [] } }))
    } as unknown as PlatformSnapshot;

    expect(canCreateMeetingForThread(snapshot, thread)).toBe(expected);
  });

  it("searches topic text and disables finalize when meetings are still open", () => {
    const snapshot = {
      threads: [{ id: "t1", status: "open", createdAt: "2026-07-01T00:00:00.000Z", tagIds: [], categoryId: "c1", title: "討論", summary: "" }],
      meetings: [
        { id: "m1", threadId: "t1", state: "active", title: "會議", goal: "", mode: "open", automation: "suggest", durationMinutes: 30, startedAt: null, agenda: { revision: 0, items: [] }, createdAt: "" },
        { id: "m2", threadId: "t2", state: "closed", title: "會議", goal: "", mode: "open", automation: "suggest", durationMinutes: 30, startedAt: null, agenda: { revision: 0, items: [] }, createdAt: "" }
      ],
      categories: [{ id: "c1", groupId: "g1", name: "分類" }],
      tags: [{ id: "tag", name: "標籤", color: "gray" }],
      groups: [{ id: "g1", name: "群組" }],
      agents: [], roles: [], skills: [], modelConnectors: [], mcpConnectors: [], taskAdapterConnectors: [],
      participants: [], utterances: [], chairSuggestions: [], decisions: [], tasks: []
    } as unknown as PlatformSnapshot;

    const filter: ThreadDiscoveryFilter = { query: "討論", status: "all", tagIds: [] };
    const [thread] = filterThreadsByDiscovery(snapshot, filter);
    expect(thread).toBeDefined();
    if (!thread) return;
    expect(thread.id).toBe("t1");
    expect(threadStatusLabel("archived")).toBe("已封存");
    expect(threadHasOpenMeeting(snapshot, thread.id)).toBe(true);
  });

  it("derives one meeting workspace from the selected discussion", () => {
    const snapshot = {
      threads: [{ id: "thread-a" }, { id: "thread-b" }],
      meetings: [{ id: "meeting-a", threadId: "thread-a", createdAt: "2026-07-16T00:00:00Z", agenda: { revision: 0, items: [] } }],
      utterances: [{ id: "message", meetingId: "meeting-a" }],
      decisions: [{ id: "decision", meetingId: "meeting-a" }],
      participants: [{ id: "participant", meetingId: "meeting-a", agentId: "agent" }],
      agents: [{ id: "agent", modelConnectorId: "model" }],
      modelConnectors: [{ id: "model", enabled: true }]
    } as unknown as PlatformSnapshot;

    const context = discussionContext(snapshot, "thread-a");
    expect(context.thread?.id).toBe("thread-a");
    expect(context.meeting?.id).toBe("meeting-a");
    expect(context.messages).toHaveLength(1);
    expect(context.decisions).toHaveLength(1);
    expect(context.runnableParticipants).toHaveLength(1);
  });

  it("selects a requested historical meeting only when it belongs to the selected topic", () => {
    const snapshot = {
      threads: [{ id: "thread-a" }, { id: "thread-b" }],
      meetings: [
        { id: "meeting-a-old", threadId: "thread-a", createdAt: "2026-07-14T00:00:00Z", agenda: { revision: 0, items: [] } },
        { id: "meeting-b", threadId: "thread-b", createdAt: "2026-07-16T00:00:00Z", agenda: { revision: 0, items: [] } },
        { id: "meeting-a-new", threadId: "thread-a", createdAt: "2026-07-17T00:00:00Z", agenda: { revision: 0, items: [] } }
      ],
      utterances: [
        { id: "old-message", meetingId: "meeting-a-old" },
        { id: "new-message", meetingId: "meeting-a-new" }
      ],
      decisions: [], participants: [], agents: [], modelConnectors: []
    } as unknown as PlatformSnapshot;

    const historical = discussionContext(snapshot, "thread-a", "meeting-a-old");
    expect(historical.meetings.map((meeting) => meeting.id)).toEqual(["meeting-a-new", "meeting-a-old"]);
    expect(historical.meeting?.id).toBe("meeting-a-old");
    expect(historical.messages.map((message) => message.id)).toEqual(["old-message"]);

    expect(discussionContext(snapshot, "thread-a", "meeting-b").meeting?.id).toBe("meeting-a-new");
    expect(discussionContext(snapshot, "thread-a", "missing").meeting?.id).toBe("meeting-a-new");
  });

  it("scopes every Meeting workspace collection to the selected historical session", () => {
    const snapshot = {
      threads: [{ id: "thread", status: "open", createdAt: "2026-07-01T00:00:00Z" }],
      meetings: [
        { id: "old", threadId: "thread", createdAt: "2026-07-01T00:00:00Z", agenda: { revision: 0, items: [] } },
        { id: "new", threadId: "thread", createdAt: "2026-07-02T00:00:00Z", agenda: { revision: 0, items: [] } }
      ],
      utterances: [{ id: "old-message", meetingId: "old" }, { id: "new-message", meetingId: "new" }],
      decisions: [{ id: "old-decision", meetingId: "old" }, { id: "new-decision", meetingId: "new" }],
      participants: [
        { id: "old-participant", meetingId: "old", agentId: "runnable" },
        { id: "new-participant", meetingId: "new", agentId: "disabled" }
      ],
      agents: [
        { id: "runnable", modelConnectorId: "enabled-model" },
        { id: "disabled", modelConnectorId: "disabled-model" }
      ],
      modelConnectors: [
        { id: "enabled-model", enabled: true },
        { id: "disabled-model", enabled: false }
      ]
    } as unknown as PlatformSnapshot;

    const context = discussionContext(snapshot, "thread", "old");
    expect(context.messages.map((item) => item.id)).toEqual(["old-message"]);
    expect(context.decisions.map((item) => item.id)).toEqual(["old-decision"]);
    expect(context.participants.map((item) => item.id)).toEqual(["old-participant"]);
    expect(context.runnableParticipants.map((item) => item.id)).toEqual(["old-participant"]);
  });
});
