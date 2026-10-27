import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CommittedMutationProjectionError } from "../app/providers";
import { ApiError } from "../lib/api";
import {
  activeSelectionAfterArchive,
  agentSelectionFromDeepLink,
  initialAgentSelection,
  AgentRevisionConflictRefreshError,
  managementSaveError,
  runAgentRevisionMutation
} from "./agents-view";

describe("Agent management mutation feedback", () => {
  it("accepts only an existing Agent deep link", () => {
    const agents = [{ id: "agent-1" }, { id: "agent-2" }];
    expect(agentSelectionFromDeepLink("agent-2", agents)).toBe("agent-2");
    expect(agentSelectionFromDeepLink("missing", agents)).toBeNull();
    expect(agentSelectionFromDeepLink(null, agents)).toBeNull();
    expect(initialAgentSelection(null, "agent-2", agents)).toBe("agent-2");
    expect(initialAgentSelection(null, "missing", agents)).toBe("agent-1");
    expect(initialAgentSelection("agent-1", "agent-2", agents)).toBe("agent-1");
  });

  it("keeps setup actions in the Agent detail area and returns to the source meeting", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("<AgentSetupPanel");
    expect(source).toContain("<SettingsView");
    expect(source).toContain("embedded");
    expect(source).toContain("buildMeetingWorkspaceHref({ meetingId: sourceContext.meetingId");
    expect(source).toContain('sourceContext.meetingId ? "返回會議" : "開啟會議"');
    expect(source).toContain("/api/model-connectors/${connectionTarget.connectorId}/health");
    expect(source).toContain("modelHealthTargetRef.current !== connectionTarget.identity");
  });

  it("refreshes an actual revision conflict before allowing the Agent mutation to settle", async () => {
    const conflict = new ApiError(409, "Agent revision is stale.", "REVISION_CONFLICT");
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let settled = false;

    const operation = runAgentRevisionMutation(
      async () => { throw conflict; },
      async () => {
        refreshCalls += 1;
        await refreshGate;
      }
    ).finally(() => {
      settled = true;
    });
    const rejection = expect(operation).rejects.toBe(conflict);

    await Promise.resolve();
    await Promise.resolve();
    expect(refreshCalls).toBe(1);
    expect(settled).toBe(false);

    releaseRefresh();
    await rejection;
    expect(settled).toBe(true);
  });

  it("preserves committed projection failures and reports conflict refresh failures separately", async () => {
    const committedFailure = new CommittedMutationProjectionError(
      { revision: 4 },
      new Error("projection refresh failed")
    );
    let refreshCalls = 0;

    await expect(runAgentRevisionMutation(
      async () => { throw committedFailure; },
      async () => { refreshCalls += 1; }
    )).rejects.toBe(committedFailure);
    expect(refreshCalls).toBe(0);

    const conflict = new ApiError(409, "Agent revision is stale.", "REVISION_CONFLICT");
    const refreshFailure = new Error("Agent projection endpoint unavailable");
    let reported: unknown;
    try {
      await runAgentRevisionMutation(
        async () => { throw conflict; },
        async () => { throw refreshFailure; }
      );
    } catch (cause) {
      reported = cause;
    }

    expect(reported).toBeInstanceOf(AgentRevisionConflictRefreshError);
    expect(reported).toMatchObject({ conflict, refreshCause: refreshFailure });
    expect((reported as Error).message).toContain("Agent projection endpoint unavailable");
  });

  it("does not refresh unrelated conflict responses", async () => {
    const conflict = new ApiError(409, "Agent name already exists.", "AGENT_NAME_CONFLICT");
    let refreshCalls = 0;

    await expect(runAgentRevisionMutation(
      async () => { throw conflict; },
      async () => { refreshCalls += 1; }
    )).rejects.toBe(conflict);
    expect(refreshCalls).toBe(0);
  });

  it("routes publish, lifecycle status, and rollback through revision conflict recovery", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const handlerStarts = ["publishAgent", "toggleAgentStatus", "rollbackAgent"];

    handlerStarts.forEach((handler, index) => {
      const start = source.indexOf(`  async function ${handler}(`);
      const nextHandler = handlerStarts[index + 1];
      const end = nextHandler ? source.indexOf(`  async function ${nextHandler}(`) : source.indexOf("  async function createTeam(");
      expect(source.slice(start, end), handler).toContain("await runAgentRevisionMutation(");
    });
  });

  it("explains stale Team and Preset revisions without masking other conflicts", () => {
    expect(managementSaveError(
      new ApiError(409, "Agent Team revision is stale."),
      "Agent Team",
      "無法儲存 Agent Team。"
    )).toBe("Agent Team 已由其他分頁更新，請重新載入後再編輯。");

    expect(managementSaveError(
      new ApiError(409, "Agent Team name already exists."),
      "Agent Team",
      "無法儲存 Agent Team。"
    )).toBe("Agent Team name already exists.");
  });

  it("uses the same approved Tool options for rendering and submission", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("const approvedToolOptions = approvedAgentToolOptions(");
    expect(source).toContain("const toolGrants = approvedToolOptions");
    expect(source).toContain("{approvedToolOptions.map(");
    expect(source).toContain("{approvedToolOptions.length === 0");
  });

  it("does not replace an unpublished Agent draft with a rollback draft", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("agent.draftRevision !== agent.publishedRevision");
    expect(source).toContain("commitMutation(() => managementApi.rollbackAgent(agent.id, publishedRevision, agent.draftRevision!, target.revision))");
  });

  it("retries Agent detail requests and keeps mutation feedback attributable after selection changes", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const detailsEffect = source.slice(
      source.indexOf("void managementApi.getAgentRevisions(selectedId)"),
      source.indexOf("  useEffect(() => {", source.indexOf("void managementApi.getAgentRevisions(selectedId)") + 1)
    );

    expect(detailsEffect).toContain("[agentDetailsReloadKey, selectedId, snapshot]");
    expect(source).toContain("`Agent ${agent.name} 已發布 Rev ${agent.draftRevision}。`");
    expect(source).toContain("`Agent ${agent.name} 已用 Rev ${target.revision} 建立回復草稿，請檢查後發布。`");
    expect(source).toContain("`Agent ${agent.name} 已停用。`");
  });

  it("uses current selection state when Team and Preset archive requests complete", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    expect(source).toContain(
      "setSelectedTeamId((current) => activeSelectionAfterArchive(current, team.id, teams));"
    );
    expect(source).toContain(
      "setSelectedPresetId((current) => activeSelectionAfterArchive(current, preset.id, presets));"
    );
  });

  it("selects the first remaining active item after archive without hiding archived history", () => {
    const items = [
      { id: "team-1", status: "active" as const },
      { id: "team-history", status: "archived" as const },
      { id: "team-2", status: "active" as const }
    ];

    expect(activeSelectionAfterArchive("team-1", "team-1", items)).toBe("team-2");
    expect(activeSelectionAfterArchive("team-2", "team-1", items)).toBe("team-2");
    expect(activeSelectionAfterArchive("team-1", "team-1", items.slice(0, 2))).toBeNull();

    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    expect(source).toContain("{teams.map((team) => (");
    expect(source).toContain("{presets.map((preset) => (");
  });

  it("locks every Agent, Team, and Preset form while its captured save is pending", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    for (const handler of ["submitAgent", "updateAgent", "createTeam", "savePreset"]) {
      const openingTag = source.match(new RegExp(`<form[^>]*onSubmit=\\{${handler}\\}[^>]*>`))?.[0];
      expect(openingTag, `${handler} form`).toContain("aria-busy={pending}");
      expect(openingTag, `${handler} form`).toContain("inert={pending ? true : undefined}");
    }
  });

  it("reuses one Agent creation key until the committed result is confirmed", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const submitSource = source.slice(
      source.indexOf("  async function submitAgent("),
      source.indexOf("  async function updateAgent(")
    );

    expect(source).toContain("idempotencyRetryToken");
    expect(source).toContain("const agentCreationRetryRef = useRef<");
    expect(submitSource).toContain("const requestPayload = {");
    expect(submitSource).toContain("const retryToken = idempotencyRetryToken(");
    expect(submitSource).toContain("agentCreationRetryRef.current = retryToken;");
    expect(submitSource).toContain('"Idempotency-Key": retryToken.idempotencyKey');
    expect(submitSource).toContain("agentCreationRetryRef.current = null;");
    expect(submitSource).toContain("cause instanceof ApiError && cause.status < 500");
  });

  it("reuses one Runtime Profile creation key for an ambiguous exact-payload retry", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const saveSource = source.slice(
      source.indexOf("  async function saveRuntimeProfile("),
      source.indexOf("  async function openRuntimeHistory(")
    );

    expect(source).toContain("const runtimeProfileCreationRetryRef = useRef<");
    expect(saveSource).toContain("const signature = JSON.stringify(payload);");
    expect(saveSource).toContain("const retryToken = idempotencyRetryToken(");
    expect(saveSource).toContain("runtimeProfileCreationRetryRef.current = retryToken;");
    expect(saveSource).toContain("managementApi.createRuntimeProfile(payload, retryToken.idempotencyKey)");
    expect(saveSource).toContain("runtimeProfileCreationRetryRef.current = null;");
    expect(saveSource).toContain("cause instanceof ApiError && cause.status < 500");
    expect(source).toContain("runtimeProfileCreationRetryRef.current = null;");
  });

  it("keeps Team and Preset create ownership across ambiguous close and exact-payload retry", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const teamSource = source.slice(
      source.indexOf("  async function createTeam("),
      source.indexOf("  async function archiveTeam(")
    );
    const presetSource = source.slice(
      source.indexOf("  async function savePreset("),
      source.indexOf("  async function archivePreset(")
    );
    const closeTeamSource = source.slice(
      source.indexOf("  function closeTeamEditor("),
      source.indexOf("  async function createTeam(")
    );
    const closePresetSource = source.slice(
      source.indexOf("  function resetPresetDraft("),
      source.indexOf("  async function savePreset(")
    );

    expect(source).toContain("const agentTeamCreationRetryRef = useRef<");
    expect(source).toContain("const meetingPresetCreationRetryRef = useRef<");
    expect(teamSource).toContain("idempotencyRetryToken(");
    expect(teamSource).toContain("managementApi.createAgentTeam(requestPayload, retryToken.idempotencyKey)");
    expect(teamSource).toContain("agentTeamCreationRetryRef.current = null;");
    expect(teamSource).toContain("cause instanceof ApiError && cause.status < 500");
    expect(presetSource).toContain("idempotencyRetryToken(");
    expect(presetSource).toContain("managementApi.createMeetingPreset(input, retryToken.idempotencyKey)");
    expect(presetSource).toContain("meetingPresetCreationRetryRef.current = null;");
    expect(presetSource).toContain("cause instanceof ApiError && cause.status < 500");
    expect(closeTeamSource).not.toContain("agentTeamCreationRetryRef.current = null;");
    expect(closePresetSource).not.toContain("meetingPresetCreationRetryRef.current = null;");
  });

  it("does not discard an uncertain Runtime Profile create key on editor close or reopen", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const lifecycleSource = source.slice(
      source.indexOf("  function openRuntimeEditor("),
      source.indexOf("  async function saveRuntimeProfile(")
    );

    expect(lifecycleSource).not.toContain("runtimeProfileCreationRetryRef.current = null;");
  });

  it("refreshes unavailable Team readiness once and admits against that exact result", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const createTeamSource = source.slice(
      source.indexOf("  async function createTeam("),
      source.indexOf("  async function archiveTeam(")
    );
    const refreshStart = createTeamSource.indexOf('if (rosterReadinessState !== "ready")');
    const admissionStart = createTeamSource.indexOf("firstUnavailableTeamMemberId(");
    const refreshSource = createTeamSource.slice(refreshStart, admissionStart);

    expect(refreshStart).toBeGreaterThan(-1);
    expect(admissionStart).toBeGreaterThan(refreshStart);
    expect(refreshSource).toContain("await loadPublishedAgentReadiness(");
    expect(refreshSource).toContain("managementApi.getAgentReadinessBatch(agentIds)");
    expect(refreshSource).toContain("readinessForAdmission = nextReadinessByAgentId;");
    expect(refreshSource).toContain("setRosterReadinessByAgentId(nextReadinessByAgentId);");
    expect(refreshSource).toContain('setRosterReadinessState("ready");');
    expect(refreshSource).not.toContain("setTeamName(");
    expect(refreshSource).not.toContain("setTeamDescription(");
    expect(refreshSource).not.toContain("setTeamMembers(");
  });

  it("does not open stale Runtime Profile history after the selection changes", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const historySource = source.slice(
      source.indexOf("  async function openRuntimeHistory("),
      source.indexOf("  const teamPresetCount")
    );

    expect(source).toContain('import { LatestRequestGate } from "../lib/latest-request";');
    expect(source).toContain("const runtimeHistoryRequestGateRef = useRef(new LatestRequestGate());");
    expect(source).toContain("runtimeHistoryRequestGateRef.current.cancel();");
    expect(historySource).toContain("const requestToken = runtimeHistoryRequestGateRef.current.begin();");
    expect(historySource).toContain("if (!runtimeHistoryRequestGateRef.current.isCurrent(requestToken)) return;");
    expect(source).toContain("function closeRuntimeHistoryGate()");
    expect(source).toContain('if (section === "runtime")');
    expect(source).toContain("closeRuntimeHistoryGate();");
    expect(source).toContain("setSection(item.id);");
    expect(source).toContain('setRuntimeRegistry("tool_packs");');
  });

  it("passes the currently displayed Agent revision when toggling Agent lifecycle status", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const toggleSource = source.slice(
      source.indexOf("  async function toggleAgentStatus("),
      source.indexOf("  async function rollbackAgent(")
    );

    expect(toggleSource).toContain("const nextStatus = agentStatusTransition(agent);");
    expect(toggleSource).toContain("if (!nextStatus)");
    expect(toggleSource).toContain("const expectedRevision = agent.revision ?? agent.draftRevision ?? agent.publishedRevision ?? 1;");
    expect(toggleSource).toContain("() => commitMutation(() => managementApi.updateAgentStatus(agent.id, nextStatus, expectedRevision))");
    expect(toggleSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(toggleSource).toContain("狀態已更新，但清單刷新失敗");
    expect(source).toContain("disabled={pending || !agentStatusTransition(agent)}");
  });

  it("three-way merges an Agent edit conflict before another save", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");
    const updateSource = source.slice(
      source.indexOf("  async function updateAgent("),
      source.indexOf("  function openRuntimeEditor(")
    );

    expect(source).toContain("isRevisionConflictError");
    expect(source).toContain("const [agentEditConflictTarget, setAgentEditConflictTarget]");
    expect(source).toContain("mergeAgentDraftAfterConflict(");
    expect(updateSource).toContain("setAgentEditConflictTarget({");
    expect(updateSource).toContain("baseDraft,");
    expect(updateSource).toContain("localDraft: submittedDraft");
    expect(updateSource).toContain("await refreshRequired();");
    expect(updateSource).toContain("cause instanceof CommittedMutationProjectionError");
    expect(updateSource).toContain("closeEditAgentModal();");
    expect(updateSource).toContain("Agent 設定已儲存，但清單刷新失敗");
    expect(source).toContain("setAgentEditDraft(merged.draft);");
    expect(source).toContain("setEditingAgentDraftRevision(latestRevision);");
    expect(source).toContain("目前草稿仍保留");
    expect(source).toContain("已保留伺服器版本");
    expect(source).toContain("function retryAgentEditConflictRefresh()");
    expect(source).toContain("重新載入最新版");
    expect(source).toContain('<form key={`${agent.id}:${editingAgentDraftRevision ?? "none"}`} className="form-stack" onSubmit={updateAgent}');
    expect(source).not.toContain("closeEditAgentModal();\n        await refresh();");
  });

  it("guards a dirty Runtime Profile draft on every close path", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("function requestCloseRuntimeEditor()");
    expect(source).toContain("if (runtimeDraftDirty && !window.confirm(");
    expect(source).toContain("onClose={requestCloseRuntimeEditor}");
    expect(source).toContain("onClick={requestCloseRuntimeEditor}");
  });

  it("guards Agent, Team, and Preset drafts through one close path per editor", () => {
    const source = readFileSync(new URL("./agents-view.tsx", import.meta.url), "utf8");

    expect(source).toContain("function requestCloseCreateAgentModal()");
    expect(source).toContain("function requestCloseEditAgentModal()");
    expect(source).toContain("function requestCloseTeamEditor()");
    expect(source).toContain("function requestClosePresetEditor()");
    expect(source).toContain("if (createAgentDirty && !window.confirm(");
    expect(source).toContain("if (editAgentDirty && !window.confirm(");
    expect(source).toContain("if (teamDraftDirty && !window.confirm(");
    expect(source).toContain("if (presetDraftDirty && !window.confirm(");
    expect(source).toContain("onClose={requestCloseCreateAgentModal}");
    expect(source).toContain("onClose={requestCloseEditAgentModal}");
    expect(source).toContain("onClose={requestCloseTeamEditor}");
    expect(source).toContain("onClose={requestClosePresetEditor}");
    expect(source).toContain("onClick={requestCloseCreateAgentModal}");
    expect(source).toContain("onClick={requestCloseEditAgentModal}");
    expect(source).toContain("onClick={requestCloseTeamEditor}");
    expect(source).toContain("onClick={requestClosePresetEditor}");
  });
});
