import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canApproveGoal, goalPhaseLabel, goalStateTone, planTasksHaveCycle } from "./goal-workspace";
import type { GoalRun } from "@council/contracts";

const source = readFileSync(new URL("./goal-workspace.tsx", import.meta.url), "utf8");
const run: GoalRun = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "完成正式驗收",
  goal: "完成正式驗收，包含可追溯的會議與任務。",
  threadId: "10000000-0000-4000-8000-000000000002",
  meetingId: "10000000-0000-4000-8000-000000000003",
  state: "awaiting_approval",
  revision: 3,
  activePlanRevision: 1,
  executionContractId: null,
  limits: { discussionRounds: 3, maxTasks: 12, maxConcurrentTasks: 2, maxAttemptsPerTask: 3, maxReplans: 2, maxDurationMinutes: 120, maxModelCalls: 60, maxActionCalls: 30 },
  usage: { discussionRounds: 3, taskAttempts: 0, replans: 0, modelCalls: 6, actionCalls: 0 },
  deadlineAt: "2026-08-27T12:00:00.000Z",
  pausedFromState: null,
  terminalReason: null,
  createdBy: "10000000-0000-4000-8000-000000000004",
  createdAt: "2026-08-27T10:00:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z"
};

describe("GoalWorkspace contracts", () => {
  it("keeps the fixed discussion to decision to task phases compact", () => {
    expect(goalPhaseLabel({ ...run, state: "planning" })).toBe("討論");
    expect(goalPhaseLabel({ ...run, state: "executing" })).toBe("任務");
    expect(goalPhaseLabel({ ...run, state: "draft", executionContractId: "10000000-0000-4000-8000-000000000005" })).toBe("決議");
  });

  it("only exposes approval for an active unapproved plan", () => {
    const plan = { id: "10000000-0000-4000-8000-000000000006", goalRunId: run.id, revision: 1, status: "draft" as const, digest: "a".repeat(64), tasks: [{ id: "10000000-0000-4000-8000-000000000007", decisionId: "10000000-0000-4000-8000-000000000008", title: "驗收", description: "", acceptanceCriteria: "完成", dependencyIds: [], assigneeAgentId: null, executionMode: "manual" as const, allowedTools: [], dataScope: "none", action: null }], createdAt: run.createdAt };
    expect(canApproveGoal({ goalRun: run, plans: [plan], executionContract: null, taskBindings: [], events: [], reviewerVerdicts: [], actionRuns: [], runtimeRuns: [] })).toBe(true);
    expect(canApproveGoal({ goalRun: { ...run, state: "planning" }, plans: [plan], executionContract: null, taskBindings: [], events: [], reviewerVerdicts: [], actionRuns: [], runtimeRuns: [] })).toBe(false);
  });

  it("uses semantic state tones and API endpoints rather than a synthetic graph", () => {
    expect(goalStateTone("completed")).toBe("complete");
    expect(goalStateTone("paused")).toBe("warning");
    expect(source).toContain('"/api/v1/goal-runs"');
    expect(source).toContain("/canvas?lens=${requestedLens}");
    expect(source).toContain("/approve");
    expect(source).toContain("討論 → 決議 → 任務");
    expect(source).toContain("buildMeetingWorkspaceHref({");
    expect(source).toContain("fromGoalId: run.id");
    expect(source).toContain("resolveCommittedMutation(() => commitMutation(");
    expect(source).toContain("目標已建立，但目標清單刷新失敗");
  });

  it("keeps Goal as a reloadable control surface with one canonical formal Meeting", () => {
    expect(source).toContain("parseGoalWorkspaceRoute(searchParams)");
    expect(source).toContain("const [tab, setTab] = useState<GoalWorkspaceTab>(routeState.view)");
    expect(source).toContain("const [lens, setLens] = useState<GoalCanvasLens>(routeState.lens)");
    expect(source).toContain("window.history.pushState(");
    expect(source).toContain('window.addEventListener("popstate", syncHistoryRoute)');
    expect(source).toContain("router.push(buildGoalWorkspaceHref(");
    expect(source).toContain('{ id: "overview", label: "概覽"');
    expect(source).toContain('{ id: "activity", label: "目標事件"');
    expect(source).toContain('{ id: "canvas", label: "執行畫布"');
    expect(source).not.toContain("<DiscussionsView");
    expect(source).toContain("進入正式會議");
  });

  it("collapses secondary controls until requested and gives Canvas the full work area", () => {
    expect(source).toContain("const [composerOpen, setComposerOpen] = useState(false)");
    expect(source).toContain("新增目標");
    expect(source).toContain('setSidebarCollapsed(tab === "canvas")');
    expect(source).toContain("detailScrollByRouteRef");
  });

  it("rejects cyclic plan dependencies before creating a revision", () => {
    const left = { id: "10000000-0000-4000-8000-000000000010", decisionId: "10000000-0000-4000-8000-000000000011", title: "左側任務", description: "", acceptanceCriteria: "完成", dependencyIds: ["10000000-0000-4000-8000-000000000012"], assigneeAgentId: null, executionMode: "manual" as const, allowedTools: [], dataScope: "none", action: null };
    const right = { ...left, id: "10000000-0000-4000-8000-000000000012", decisionId: "10000000-0000-4000-8000-000000000013", title: "右側任務", dependencyIds: [left.id] };
    expect(planTasksHaveCycle([left, right])).toBe(true);
    expect(planTasksHaveCycle([{ ...left, dependencyIds: [] }, right])).toBe(false);
  });

  it("supports live Goal events and touch-friendly plan ordering", () => {
    expect(source).toContain("new EventSource(`/api/v1/goal-runs/${selectedId}/events`)");
    expect(source).toContain("source.addEventListener(\"goal.event\"");
    expect(source).toContain("moveTask(task.id, -1)");
    expect(source).toContain("toggleDependency(task.id, candidate.id");
  });

  it("only applies the latest Goal detail and Canvas response", () => {
    expect(source).toContain("const detailRequestGateRef = useRef(new LatestRequestGate())");
    expect(source).toContain("const requestToken = detailRequestGateRef.current.begin()");
    expect(source).toContain("if (!detailRequestGateRef.current.isCurrent(requestToken)) return");
    expect(source).toContain("detailRequestGateRef.current.cancel()");
    expect(source).not.toContain("void refreshDetail(selectedId, nextLens)");
  });
});
