import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoleBehaviorDetails } from "../components/settings-view";
import { TaskDetailTabs, TaskStatusTabs, tabIndexForNavigationKey } from "../components/tasks-view";

describe("tab accessibility contracts", () => {
  it("moves focus targets with wrapping arrow, Home, and End navigation", () => {
    expect(tabIndexForNavigationKey("ArrowRight", 3, 4)).toBe(0);
    expect(tabIndexForNavigationKey("ArrowLeft", 0, 4)).toBe(3);
    expect(tabIndexForNavigationKey("Home", 2, 4)).toBe(0);
    expect(tabIndexForNavigationKey("End", 1, 4)).toBe(3);
    expect(tabIndexForNavigationKey("Enter", 1, 4)).toBeNull();
    expect(tabIndexForNavigationKey("ArrowRight", 0, 0)).toBeNull();
  });

  it("renders task status tabs with roving focus and panel relationships", () => {
    const markup = renderToStaticMarkup(createElement(TaskStatusTabs, {
      selectedStatus: "in_progress",
      counts: { todo: 2, in_progress: 1, review: 0, done: 4 },
      onSelect: vi.fn()
    }));

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-orientation="horizontal"');
    expect(markup).toMatch(/id="task-status-tab-in_progress"[^>]*tabindex="0"/);
    expect(markup).toMatch(/id="task-status-tab-todo"[^>]*tabindex="-1"/);
    expect(markup).toContain('aria-controls="task-status-panel-review"');
  });

  it("renders task detail tabs with complete roving-focus relationships", () => {
    const markup = renderToStaticMarkup(createElement(TaskDetailTabs, {
      activeTab: "evidence",
      onSelect: vi.fn()
    }));

    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/id="task-detail-tab-evidence"[^>]*tabindex="0"/);
    expect(markup).toMatch(/id="task-detail-tab-content"[^>]*tabindex="-1"/);
    expect(markup).toContain('aria-controls="task-detail-panel-history"');
  });

  it("keeps every tab control connected to a focusable tabpanel", () => {
    const source = readFileSync(new URL("../components/tasks-view.tsx", import.meta.url), "utf8");

    expect(source).toContain('id={`task-status-panel-${status}`}');
    expect(source).toContain('aria-labelledby={`task-status-tab-${status}`}');
    for (const tab of ["content", "evidence", "history"]) {
      expect(source).toContain(`id="task-detail-panel-${tab}"`);
      expect(source).toContain(`aria-labelledby="task-detail-tab-${tab}"`);
    }
  });

  it("excludes hidden tab panels from the Modal keyboard focus boundary", () => {
    const source = readFileSync(new URL("../components/ui.tsx", import.meta.url), "utf8");

    expect(source).toContain(".filter(isModalFocusableVisible)");
    expect(source).toContain('variant?: "dialog" | "drawer"');
  });
});

describe("Role behavior readability", () => {
  it("keeps complete behavior fields inside one compact native disclosure", () => {
    const speakingGuidance = "先確認議題與證據，再提出可執行且完整的發言建議。";
    const decisionScope = "可以提出候選決議，但不可代替 Owner 核准最終決策。";
    const constraints = "不得存取未授權資料，也不得呼叫寫入型工具或外部程式。";
    const markup = renderToStaticMarkup(createElement(RoleBehaviorDetails, {
      roleName: "平台架構師",
      speakingGuidance,
      decisionScope,
      constraints
    }));

    expect(markup).toContain("<details");
    expect(markup).toContain("角色行為邊界");
    expect(markup).toContain(speakingGuidance);
    expect(markup).toContain(decisionScope);
    expect(markup).toContain(constraints);
  });

  it("does not visually clamp expanded behavior and keeps the mobile disclosure target at 44px", () => {
    const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const behaviorRule = styles.match(/\.role-behavior-summary dd \{([^}]*)\}/)?.[1] ?? "";

    expect(behaviorRule).not.toContain("line-clamp");
    expect(behaviorRule).toContain("white-space: pre-wrap");
    expect(styles).toContain(".role-behavior-details summary { min-height: 44px; }");
  });
});

describe("Discussion navigation contracts", () => {
  it("keeps the mobile taxonomy behind one explicit disclosure and closes it after selection", () => {
    const source = readFileSync(new URL("../components/discussions-view.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

    expect(source).toContain('aria-controls="discussion-taxonomy-panel"');
    expect(source).toContain("aria-expanded={mobileTaxonomyOpen}");
    expect(source).toContain("setMobileTaxonomyOpen(false)");
    expect(styles).toContain(".discussion-sidebar-shell { display: none; }");
    expect(styles).toContain(".discussion-sidebar-shell.open { display: block; }");
  });

  it("makes every fixed Phase 1 flow step a real navigation target", () => {
    const discussionSource = readFileSync(new URL("../components/discussions-view.tsx", import.meta.url), "utf8");
    const decisionSource = readFileSync(new URL("../components/decision-panel.tsx", import.meta.url), "utf8");

    expect(discussionSource).toContain('focusFlowTarget("meeting-transcript")');
    expect(discussionSource).toContain('focusFlowTarget("meeting-decisions")');
    expect(discussionSource).toContain('id="meeting-transcript"');
    expect(discussionSource).toContain("setInspectedTaskId(firstMeetingTask.id)");
    expect(discussionSource).toContain("<TaskContextInspector");
    expect(decisionSource).toContain('id="meeting-decisions"');
  });

  it("locks the complete Meeting creation form while its async preflight is submitting", () => {
    const source = readFileSync(new URL("../components/discussions-view.tsx", import.meta.url), "utf8");

    expect(source).toContain('aria-busy={busy}');
    expect(source).toContain('inert={busy ? true : undefined}');
  });

  it("submits the Topic revision captured when the full editor opened", () => {
    const source = readFileSync(new URL("../components/discussions-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("setEditThreadRevision(thread.revision)");
    expect(source).toContain("expectedRevision: editThreadRevision");
  });
});

describe("Task draft and compact navigation safeguards", () => {
  it("submits independent content, execution, and board revisions", () => {
    const taskDraftSource = readFileSync(new URL("./task-draft-ui.ts", import.meta.url), "utf8");
    const taskViewSource = readFileSync(new URL("../components/tasks-view.tsx", import.meta.url), "utf8");

    expect(taskDraftSource).toContain("expectedRevision: draft.baseRevision");
    expect(taskDraftSource).toContain("expectedExecutionRevision: draft.baseExecutionRevision");
    expect(taskViewSource).toContain("expectedBoardRevision: task.boardRevision");
  });

  it("requires explicit confirmation before every Task detail close path can discard a dirty draft", () => {
    const source = readFileSync(new URL("../components/tasks-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("onClose={requestCloseDetail}");
    expect(source).toContain("const taskDetailDirty = draftDirty || evidenceDraftDirty;");
    expect(source).toContain("if (taskDetailDirty) {");
    expect(source).toContain("setDiscardRequested(true)");
    expect(source).toContain("繼續編輯");
    expect(source).toContain("捨棄變更");
  });

  it("keeps Task evidence input controlled across background refreshes and clears it only after success", () => {
    const source = readFileSync(new URL("../components/tasks-view.tsx", import.meta.url), "utf8");
    const submitEvidence = source.slice(
      source.indexOf("  async function submitEvidence("),
      source.indexOf("  async function syncTask(")
    );

    expect(source).toContain("const [evidenceDraft, setEvidenceDraft] = useState<TaskEvidenceDraft>(emptyTaskEvidenceDraft);");
    expect(source).toContain('value={evidenceDraft.label}');
    expect(source).toContain('value={evidenceDraft.reference}');
    expect(submitEvidence).toContain("setEvidenceDraft(emptyTaskEvidenceDraft);");
    expect(submitEvidence).not.toContain("form.reset()");
  });

  it("keeps navigation targets stable and removes only the non-interactive avatar below 360px", () => {
    const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

    expect(styles).toContain("flex: 0 0 31px");
    expect(styles).toContain("@media (max-width: 359px)");
    expect(styles).toContain(".owner-avatar { display: none; }");
  });
});
