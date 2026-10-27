import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MeetingAgentRunRetryOwnership,
  attemptMeetingTeamSelection,
  meetingCreatorDraftHasChanges,
  shouldRestoreMobileTaxonomyFocus,
  toolArgumentsDraftHasChanges,
  type ControlledMeetingTeamSelection,
  type MeetingCreatorDraft
} from "./discussions-view";

const source = readFileSync(new URL("./discussions-view.tsx", import.meta.url), "utf8");
const loaderSource = readFileSync(new URL("./meeting-canvas-loader.tsx", import.meta.url), "utf8");

function sourceSection(start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end));
}

describe("DiscussionsView meeting shortcut ownership", () => {
  it("keeps Meeting, Topic, view, and lens in the shareable URL", () => {
    expect(source).toContain("parseMeetingWorkspaceRoute(searchParams)");
    expect(source).toContain("router.push(buildMeetingWorkspaceHref(");
    expect(source).not.toContain('url.searchParams.delete("meetingId")');
    expect(source).toContain(">會議</button>");
    expect(source).toContain(">活動</button>");
    expect(source).toContain(">畫布</button>");
  });

  it("updates Meeting tabs immediately and restores them from browser history", () => {
    const selectExperience = sourceSection(
      "  function selectMeetingExperience(",
      "  function selectCanvasLens("
    );
    const selectLens = sourceSection(
      "  function selectCanvasLens(",
      "  function focusFlowTarget("
    );

    expect(source).toContain('window.addEventListener("popstate", syncHistoryRoute)');
    expect(selectExperience).toContain("window.history.pushState(");
    expect(selectExperience).toContain("setMeetingExperienceTab(nextView);");
    expect(selectLens).toContain("window.history.pushState(");
    expect(selectLens).toContain('setMeetingExperienceTab("canvas");');
    expect(selectLens).toContain("setCanvasLens(nextLens);");
  });

  it("loads Meeting Canvas only after Canvas is selected", () => {
    expect(source).not.toContain('from "./meeting-canvas"');
    expect(source).toContain('from "./meeting-canvas-loader"');
    expect(loaderSource).toContain('import dynamic from "next/dynamic";');
    expect(loaderSource).toContain('import("./meeting-canvas")');
    expect(loaderSource).toContain("ssr: false");
  });

  it("provides a stable accessible Canvas loading viewport", () => {
    expect(loaderSource).toContain('role="status"');
    expect(loaderSource).toContain('aria-label="正在載入會議畫布"');
    expect(loaderSource).toContain('className="canvas-viewport canvas-viewport-loading"');
    expect(source).toContain("<MeetingCanvasLoader");
  });

  it("keeps the Meeting and Canvas panels mutually exclusive during loading", () => {
    const canvasPanel = sourceSection(
      '{!embeddedMeetingId && meetingExperienceTab === "canvas"',
      '{embeddedMeetingId && <span id="meeting-view-tab"'
    );
    const meetingPanel = sourceSection(
      '{(embeddedMeetingId || meetingExperienceTab === "meeting")',
      "<MeetingSpeakerQueue"
    );

    expect(canvasPanel).toContain("<MeetingCanvasLoader");
    expect(canvasPanel).not.toContain("meetingExperienceTab === \"meeting\"");
    expect(meetingPanel).toContain("meetingExperienceTab === \"meeting\"");
    expect(meetingPanel).not.toContain("meetingExperienceTab === \"canvas\"");
  });

  it("invalidates a pending Agent shortcut when the user selects another Thread", () => {
    const shortcutEffect = sourceSection(
      'if (url.searchParams.get("newMeeting") !== "1") return;',
      "  const discoveryFilter:"
    );
    const selectThread = sourceSection("  function selectThread(", "  function selectMeetingSession(");

    expect(source).toContain('import { LatestRequestGate } from "../lib/latest-request";');
    expect(source).toContain("const meetingShortcutRequestGateRef = useRef(new LatestRequestGate());");
    expect(shortcutEffect).toContain("const shortcutRequestToken = meetingShortcutRequestGateRef.current.begin();");
    expect(shortcutEffect).toContain("if (!meetingShortcutRequestGateRef.current.isCurrent(shortcutRequestToken)) return;");
    expect(selectThread).toContain("meetingShortcutRequestGateRef.current.cancel();");
  });

  it("invalidates a pending Agent shortcut when the user selects a Meeting session", () => {
    const selectMeetingSession = sourceSection(
      "  function selectMeetingSession(",
      "  function focusFlowTarget("
    );
    const sessionSelector = sourceSection(
      '<select id="meeting-session-select"',
      "</select>"
    );

    expect(selectMeetingSession).toContain("meetingShortcutRequestGateRef.current.cancel();");
    expect(selectMeetingSession).toContain('setMeetingExperienceTab("meeting");');
    expect(selectMeetingSession).toContain("setMeetingId(nextMeetingId);");
    expect(sessionSelector).toContain("selectMeetingSession(event.currentTarget.value)");
    expect(sessionSelector).toContain('<optgroup label="目前場次">');
    expect(sessionSelector).toContain('<optgroup label="封存場次">');
  });

  it("opens closed sessions in the bounded archive view", () => {
    const meetingPanel = sourceSection(
      '{(embeddedMeetingId || meetingExperienceTab === "meeting")',
      "      <TaxonomyManagerModal"
    );

    expect(source).toContain('import { MeetingRecordView } from "./meeting-record-view";');
    expect(meetingPanel).toContain('meeting.state === "closed" ? <MeetingRecordView meeting={meeting} topicSummary={thread.summary} />');
    expect(source).toContain('focusMeeting(meeting?.id ?? null, meeting?.state !== "closed");');
    expect(source).toContain('useMeetingEvents(meeting?.state === "closed" ? undefined : meeting?.id');
    expect(source).toContain('meeting.state === "closed" ? <div className="meeting-controls archived-meeting-controls"');
    expect(source).toContain('meeting.state !== "closed" && <MeetingAgendaBand');
  });

  it("inspects Meeting tasks and Agents without leaving the formal Meeting", () => {
    expect(source).toContain('import { TaskContextInspector } from "./task-context-inspector";');
    expect(source).toContain('import { AgentContextInspector } from "./agent-context-inspector";');
    expect(source).toContain("setInspectedTaskId(firstMeetingTask.id)");
    expect(source).toContain("setInspectedAgentId(agent.id)");
  });
});

describe("DiscussionsView Agent-run retry ownership", () => {
  it("reuses Meeting A's original key after an ambiguous A -> B -> A retry", () => {
    const ownership = new MeetingAgentRunRetryOwnership();
    const createdKeys: string[] = [];
    const createKey = (key: string) => () => {
      createdKeys.push(key);
      return key;
    };

    const meetingA = ownership.acquire("meeting-a", '{"agentId":"agent-1"}', createKey("key-a"));
    const meetingB = ownership.acquire("meeting-b", '{"agentId":"agent-1"}', createKey("key-b"));
    const meetingARetry = ownership.acquire("meeting-a", '{"agentId":"agent-1"}', createKey("replacement-key"));

    expect(meetingARetry).toBe(meetingA);
    expect(meetingARetry.idempotencyKey).toBe("key-a");
    expect(meetingB.idempotencyKey).toBe("key-b");
    expect(createdKeys).toEqual(["key-a", "key-b"]);
  });

  it("does not evict another Agent's unresolved key in the same Meeting", () => {
    const ownership = new MeetingAgentRunRetryOwnership();
    const firstAgent = ownership.acquire("meeting-a", '{"agentId":"agent-1"}', () => "key-agent-1");

    ownership.acquire("meeting-a", '{"agentId":"agent-2"}', () => "key-agent-2");

    expect(ownership.acquire("meeting-a", '{"agentId":"agent-1"}', () => "replacement-key"))
      .toBe(firstAgent);
  });

  it("keeps unresolved ownership out of Meeting selection cleanup", () => {
    const selectionEffect = sourceSection(
      "    const selectionNotice = meeting?.id === meetingSelectionNoticeRef.current?.meetingId",
      "  useLayoutEffect(() => {"
    );
    const runAgent = sourceSection(
      "  async function runAgent(",
      "  async function meetingAction("
    );

    expect(source).toContain("const agentRunRetryOwnershipRef = useRef(new MeetingAgentRunRetryOwnership());");
    expect(selectionEffect).not.toContain("agentRunRetryOwnershipRef");
    expect(runAgent).toContain("agentRunRetryOwnershipRef.current.acquire(");
    expect(runAgent).toContain("agentRunRetryOwnershipRef.current.clear(retry)");
    expect(runAgent).toContain("if (cause instanceof ApiError && cause.status < 500) agentRunRetryOwnershipRef.current.clear(retry);");
  });

  it("keeps unresolved Decision, Task, and Tool keys across Meeting switches", () => {
    const selectionEffect = sourceSection(
      "    const selectionNotice = meeting?.id === meetingSelectionNoticeRef.current?.meetingId",
      "  useLayoutEffect(() => {"
    );
    const submitDecision = sourceSection(
      "  async function submitDecision(",
      "  async function sendMessage("
    );
    const submitTask = sourceSection(
      "  async function createTask(",
      "  async function runTool("
    );
    const runTool = sourceSection(
      "  async function runTool(",
      "  async function closeMeeting("
    );

    for (const name of ["decision", "task", "tool"]) {
      expect(source).toContain(`const ${name}RetryOwnershipRef = useRef(new MeetingAgentRunRetryOwnership());`);
      expect(selectionEffect).not.toContain(`${name}RetryOwnershipRef`);
    }
    expect(submitDecision).toContain("decisionRetryOwnershipRef.current.acquire(");
    expect(submitDecision).toContain("decisionRetryOwnershipRef.current.clear(retry)");
    expect(submitTask).toContain("taskRetryOwnershipRef.current.acquire(");
    expect(submitTask).toContain("taskRetryOwnershipRef.current.clear(retry)");
    expect(runTool).toContain("toolRetryOwnershipRef.current.acquire(");
    expect(runTool).toContain("toolRetryOwnershipRef.current.clear(retry)");
  });

  it("keeps Agent queue lock when projection refresh fails after queue admission", () => {
    const runAgent = sourceSection(
      "  async function runAgent(",
      "  async function meetingAction("
    );

    expect(runAgent).toContain("const queuedOutcome = await resolveCommittedMutation(() =>");
    expect(runAgent).toContain("const queued = queuedOutcome.result;");
    expect(runAgent).toContain("if (!queuedOutcome.projectionFresh) {");
    expect(runAgent).toContain("已排入發言，但最新會議畫面刷新失敗；請先重試同步或重新整理。");
    expect(runAgent).toContain("setNoticeTone(\"warning\");");
    expect(runAgent).toContain("updatePendingAction({ ...provisional, jobId: queued.jobId });");
    expect(runAgent).toContain("if (!requestIsCurrent()) return false;");
    expect(runAgent).toContain("catch (cause) {");
    expect(runAgent).toContain("updatePendingAction(null);");
  });

  it("keeps Tool lock and terminal replay semantics when queue admission refresh fails", () => {
    const runTool = sourceSection(
      "  async function runTool(event: FormEvent<HTMLFormElement>) {",
      "  async function closeMeeting("
    );

    expect(runTool).toContain("const queuedOutcome = await resolveCommittedMutation(() =>");
    expect(runTool).toContain("const queued = queuedOutcome.result;");
    expect(runTool).toContain("if (queued.replayed) {");
    expect(runTool).toContain("setNotice(queued.status === \"failed\" ? `${tool.displayName}先前執行失敗，會議已暫停。` : `${tool.displayName}已完成。`);");
    expect(runTool).toContain("if (!queuedOutcome.projectionFresh) {");
    expect(runTool).toContain("已接受執行，但最新會議畫面刷新失敗；請先重試同步或重新整理。");
    expect(runTool).toContain("updatePendingAction({ ...provisional, jobId: queued.jobId });");
    expect(runTool).toContain("catch (cause) {");
    expect(runTool).toContain("updatePendingAction(null);");
  });
});

describe("DiscussionsView Meeting creator request ownership", () => {
  it("restores the prior controlled Team selection after application or readiness rejects it", () => {
    const previous: ControlledMeetingTeamSelection = {
      teamId: "",
      participantIds: ["manual-agent-a", "manual-agent-b"],
      chairAgentId: "manual-agent-b",
      roleIdByAgent: {
        "manual-agent-a": "manual-role-a",
        "manual-agent-b": "manual-role-b"
      }
    };

    for (const cause of [new Error("Agent Team application failed"), new Error("Agent Team readiness blocked")]) {
      const result = attemptMeetingTeamSelection(previous, "rejected-team", () => { throw cause; });

      expect(result).toEqual({ accepted: false, selection: previous, cause });
    }
  });

  it("commits only the transactional Agent Team selection used by Meeting submission", () => {
    const selectMeetingTeam = sourceSection(
      "  function selectMeetingTeam(",
      "  async function selectMeetingPreset("
    );
    const submitMeeting = sourceSection(
      "  async function submitMeeting(",
      "  async function saveAgenda("
    );

    expect(selectMeetingTeam).toContain("const teamSelectionAttempt = attemptMeetingTeamSelection(");
    expect(selectMeetingTeam).toContain("teamId: meetingTeamId,");
    expect(selectMeetingTeam).toContain("participantIds: meetingParticipantIds,");
    expect(selectMeetingTeam).toContain("chairAgentId: meetingChairAgentId,");
    expect(selectMeetingTeam).toContain("roleIdByAgent: meetingRoleIdByAgent");
    expect(selectMeetingTeam).toContain("setMeetingTeamId(teamSelectionAttempt.selection.teamId);");
    expect(selectMeetingTeam).toContain("setMeetingParticipantIds(teamSelectionAttempt.selection.participantIds);");
    expect(selectMeetingTeam).toContain("setMeetingRoleIdByAgent(teamSelectionAttempt.selection.roleIdByAgent);");
    expect(selectMeetingTeam).toContain("setMeetingChairAgentId(teamSelectionAttempt.selection.chairAgentId);");
    expect(submitMeeting).toContain("...(meetingTeamId ? { sourceTeamId: meetingTeamId } : {}),");
  });

  it("applies a Meeting Preset Team only after its readiness preflight resolves", () => {
    const selectMeetingPreset = sourceSection(
      "  async function selectMeetingPreset(",
      "  function openAgendaModal("
    );
    const preflightCall = selectMeetingPreset.indexOf("await managementApi.getMeetingPresetPreflight(presetId)");
    const teamSelection = selectMeetingPreset.indexOf("selectMeetingTeam(applied.teamId ?? \"\", true, nextReadinessByAgentId)");
    const modeCommit = selectMeetingPreset.indexOf("setMeetingMode(applied.mode);");

    expect(preflightCall).toBeGreaterThan(-1);
    expect(teamSelection).toBeGreaterThan(preflightCall);
    expect(modeCommit).toBeGreaterThan(teamSelection);
    expect(selectMeetingPreset).toContain("...Object.fromEntries(preflight.agents.map((item) => [item.agentId, item.readiness]))");
    expect(selectMeetingPreset).toContain("setMeetingPresetId(previousPresetId);");
    expect(selectMeetingPreset).toContain("setMeetingPresetPreflight(previousPresetPreflight);");
  });

  it("invalidates a pending Meeting Preset before a manual draft override can be overwritten", () => {
    const cancelManualOverride = sourceSection(
      "  function cancelMeetingPresetForManualEdit(",
      "  function closeMeetingCreator("
    );
    const meetingModal = source.slice(
      source.indexOf('<Modal title="建立會議"'),
      source.indexOf('{meeting && <Modal title="會議議程"')
    );

    expect(cancelManualOverride).toContain("if (!meetingPresetPreflightLoading) return;");
    expect(cancelManualOverride).toContain('setMeetingPresetId("");');
    expect(cancelManualOverride).toContain("cancelMeetingPresetPreflight();");
    expect(meetingModal).toContain("cancelMeetingPresetForManualEdit(); setMeetingAgendaDraft(items);");
    expect(meetingModal).toContain("cancelMeetingPresetForManualEdit(); setMeetingMode(event.currentTarget.value as MeetingMode);");
    expect(meetingModal).toContain("cancelMeetingPresetForManualEdit(); setMeetingAutomation(event.currentTarget.value as ChairAutomationLevel);");
    expect(meetingModal).toContain("cancelMeetingPresetForManualEdit(); setMeetingDurationMinutes(Number(event.currentTarget.value));");
  });

  it("detects every Meeting creator draft value that would be discarded", () => {
    const base: MeetingCreatorDraft = {
      title: "Topic",
      goal: "Goal",
      agendaItems: [{ title: "Agenda", description: "" }],
      automation: "suggest",
      mode: "chaired",
      durationMinutes: 30,
      teamId: "",
      presetId: "",
      participantIds: ["agent-a"],
      chairAgentId: "agent-a",
      roleIdByAgent: { "agent-a": "role-a" },
      warningsConfirmed: false
    };
    const unchanged: MeetingCreatorDraft = {
      ...base,
      agendaItems: base.agendaItems.map((item) => ({ ...item })),
      participantIds: [...base.participantIds],
      roleIdByAgent: { ...base.roleIdByAgent }
    };
    const changedDrafts: MeetingCreatorDraft[] = [
      { ...unchanged, title: "Changed topic" },
      { ...unchanged, goal: "Changed goal" },
      { ...unchanged, agendaItems: [{ title: "Changed agenda", description: "" }] },
      { ...unchanged, automation: "auto" },
      { ...unchanged, mode: "open" },
      { ...unchanged, durationMinutes: 45 },
      { ...unchanged, teamId: "team-a" },
      { ...unchanged, presetId: "preset-a" },
      { ...unchanged, participantIds: ["agent-a", "agent-b"] },
      { ...unchanged, chairAgentId: "agent-b" },
      { ...unchanged, roleIdByAgent: { "agent-a": "role-b" } },
      { ...unchanged, warningsConfirmed: true }
    ];

    expect(meetingCreatorDraftHasChanges(base, unchanged)).toBe(false);
    for (const draft of changedDrafts) {
      expect(meetingCreatorDraftHasChanges(base, draft)).toBe(true);
    }
  });

  it("keeps the creator busy while automatic start is still pending", () => {
    const selectionEffect = sourceSection(
      "    const selectionNotice = meeting?.id === meetingSelectionNoticeRef.current?.meetingId",
      "  useLayoutEffect(() => {"
    );
    const submitMeeting = sourceSection(
      "  async function submitMeeting(",
      "  async function saveAgenda("
    );
    const meetingModal = sourceSection(
      '<Modal title="建立會議"',
      "      {meeting && <Modal title=\"會議議程\""
    );

    expect(source).toContain("const meetingCreationRequestGateRef = useRef(new LatestRequestGate());");
    expect(source).toContain("const activeMeetingCreationRequestTokenRef = useRef<number | null>(null);");
    expect(selectionEffect).toContain("if (activeMeetingCreationRequestTokenRef.current === null) setBusy(false);");
    expect(submitMeeting).toContain("const creationRequestToken = meetingCreationRequestGateRef.current.begin();");
    expect(submitMeeting).toContain("activeMeetingCreationRequestTokenRef.current = creationRequestToken;");
    expect(submitMeeting).toContain("const startOutcome = await resolveCommittedMutation(() =>");
    expect(submitMeeting).toContain("mutate(`/api/meetings/${created.id}/start`, { method: \"POST\" })");
    expect(submitMeeting).toContain("if (meetingCreationRequestGateRef.current.isCurrent(creationRequestToken)) {");
    expect(submitMeeting).toContain("activeMeetingCreationRequestTokenRef.current = null;");
    expect(meetingModal).toContain("closeDisabled={busy}");
    expect(meetingModal).toContain("busy={busy}");
  });

  it("retains ambiguous Meeting creation identities across close, reopen, and another draft", () => {
    const creatorLifecycle = sourceSection(
      "  async function openMeetingCreator(",
      "  function selectMeetingTeam("
    );
    const submitMeeting = sourceSection(
      "  async function submitMeeting(",
      "  async function saveAgenda("
    );

    expect(source).toContain("const meetingCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(creatorLifecycle).not.toContain("meetingCreationRetryRegistryRef.current.clear");
    expect(submitMeeting).toContain("const requestRetry = meetingCreationRetryRegistryRef.current.acquire(");
    expect(submitMeeting).toContain("retry = requestRetry;");
    expect(submitMeeting).toContain('headers: { "idempotency-key": requestRetry.idempotencyKey }');
    expect(submitMeeting).toContain("meetingCreationRetryRegistryRef.current.settle(requestRetry);");
    expect(submitMeeting).toContain("if (retry && cause instanceof ApiError && cause.status < 500)");
    expect(submitMeeting).toContain("meetingCreationRetryRegistryRef.current.settle(retry);");
  });

  it("retains ambiguous Topic creation identities across close, reopen, and another draft", () => {
    const creatorLifecycle = sourceSection(
      "  function openThreadCreator()",
      "  function toggleThreadDraftTag("
    );
    const submitThread = sourceSection(
      "  async function submitThread(",
      "  async function submitMeeting("
    );

    expect(source).toContain("const threadRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(creatorLifecycle).not.toContain("threadRetryRegistryRef.current.clear");
    expect(submitThread).toContain("threadRetryRegistryRef.current.acquire(");
    expect(submitThread).toContain("const createdOutcome = await resolveCommittedMutation(");
    expect(submitThread).toContain("threadRetryRegistryRef.current.settle(retry);");
    expect(submitThread).toContain("if (cause instanceof ApiError && cause.status < 500)");
  });

  it("keeps a committed Meeting message cleared when only projection refresh fails", () => {
    const sendMessage = sourceSection(
      "  async function sendMessage(",
      "  async function changeMode("
    );

    expect(sendMessage).toContain("const sentOutcome = await resolveCommittedMutation(() =>");
    expect(sendMessage).toContain("messageRetryOwnershipRef.current.clear(retry);");
    expect(sendMessage).toContain("if (!sentOutcome.projectionFresh) {");
    expect(sendMessage).toContain("發言已送出，但最新列表刷新失敗；請重新整理以載入最新內容。");
    expect(sendMessage.indexOf("messageRetryOwnershipRef.current.clear(retry);"))
      .toBeLessThan(sendMessage.indexOf("if (!sentOutcome.projectionFresh) {"));
    const failureBranch = sendMessage.slice(sendMessage.indexOf("} catch (cause)"));
    expect(failureBranch).toContain("restoreAfterFailure");
  });

  it("continues from a committed Meeting result when only projection refresh fails", () => {
    const submitMeeting = sourceSection(
      "  async function submitMeeting(",
      "  async function saveAgenda("
    );

    expect(source).toContain("resolveCommittedMutation");
    expect(submitMeeting).toContain("const createdOutcome = await resolveCommittedMutation(");
    expect(submitMeeting).toContain("const created = createdOutcome.result;");
    expect(submitMeeting).toContain("const startOutcome = await resolveCommittedMutation(");
    expect(submitMeeting).toContain("startOutcome.projectionFresh");
    expect(submitMeeting).toContain("會議已開始，但最新列表刷新失敗；請重新整理以載入最新資料。");
  });

  it("guards X, backdrop, Escape, and Cancel through one Meeting creator close path", () => {
    const closeMeetingCreator = sourceSection(
      "  function closeMeetingCreator(",
      "  function selectMeetingTeam("
    );
    const openMeetingCreator = sourceSection(
      "  async function openMeetingCreator(",
      "  function cancelMeetingPresetPreflight("
    );
    const shortcutEffect = sourceSection(
      'if (url.searchParams.get("newMeeting") !== "1") return;',
      "  const discoveryFilter:"
    );
    const meetingModal = sourceSection(
      '<Modal title="建立會議"',
      "      {meeting && <Modal title=\"會議議程\""
    );

    expect(source).toContain("const [meetingTitle, setMeetingTitle] = useState(\"\");");
    expect(source).toContain("const [meetingGoal, setMeetingGoal] = useState(\"\");");
    expect(source).toContain("const meetingCreatorDraftDirty = Boolean(");
    expect(openMeetingCreator).toContain("setMeetingCreatorDraftBase(initialDraft);");
    expect(shortcutEffect).toContain("setMeetingCreatorDraftBase(shortcutDraft);");
    expect(closeMeetingCreator).toContain("function requestCloseMeetingCreator()");
    expect(closeMeetingCreator).toContain("if (meetingCreatorDraftDirty && !window.confirm(");
    expect(closeMeetingCreator).toContain("closeMeetingCreator();");
    expect(closeMeetingCreator).toContain("cancelMeetingPresetPreflight();");
    expect(closeMeetingCreator).toContain("setModalError(\"\");");
    expect(closeMeetingCreator).toContain("setMeetingModal(false);");
    expect(meetingModal).toContain("onClose={requestCloseMeetingCreator}");
    expect(meetingModal).toContain("onClick={requestCloseMeetingCreator}");
    expect(meetingModal).toContain('value={meetingTitle} onChange={(event) => setMeetingTitle(event.currentTarget.value)}');
    expect(meetingModal).toContain('value={meetingGoal} onChange={(event) => setMeetingGoal(event.currentTarget.value)}');
    expect(meetingModal).toContain('name="title" value={meetingTitle} onChange={(event) => setMeetingTitle(event.currentTarget.value)} required maxLength={160}');
    expect(meetingModal).toContain('name="goal" value={meetingGoal} onChange={(event) => setMeetingGoal(event.currentTarget.value)} required rows={3} maxLength={1000}');
  });

  it("releases preset preflight loading when manual participant selection cancels the request", () => {
    const cancelPresetPreflight = sourceSection(
      "  function cancelMeetingPresetPreflight(",
      "  function closeMeetingCreator("
    );
    const setMeetingParticipantSelected = sourceSection(
      "  function setMeetingParticipantSelected(",
      "  function updateDiscoveryQuery("
    );

    expect(cancelPresetPreflight).toContain("meetingPresetPreflightRequestId.current += 1;");
    expect(cancelPresetPreflight).toContain("setMeetingPresetPreflight(null);");
    expect(cancelPresetPreflight).toContain("setMeetingPresetPreflightLoading(false);");
    expect(setMeetingParticipantSelected).toContain("cancelMeetingPresetPreflight();");
  });
});

describe("DiscussionsView Topic editor request lifecycle", () => {
  it("locks the editor and every close path while its PATCH request is pending", () => {
    const editor = sourceSection(
      '<Modal title="編輯討論話題"',
      '      <Modal title="建立會議"'
    );

    expect(editor).toContain("closeDisabled={busy}");
    expect(editor).toContain("busy={busy}");
    expect(editor).toContain("aria-busy={busy}");
    expect(editor).toContain("inert={busy ? true : undefined}");
  });

  it("locks the Tool Run modal while the submitted tool snapshot is pending", () => {
    const toolRun = sourceSection(
      '<Modal title={toolAgent ?',
      '      <Modal title="會議證據"'
    );

    expect(toolRun).toContain("closeDisabled={meetingActionActive}");
    expect(toolRun).toContain("busy={meetingActionActive}");
    expect(toolRun).toContain("aria-busy={meetingActionActive}");
    expect(toolRun).toContain("inert={meetingActionActive ? true : undefined}");
  });
});

describe("DiscussionsView Tool Run draft ownership", () => {
  it("treats changed JSON argument text as a dirty draft", () => {
    expect(toolArgumentsDraftHasChanges("{}")).toBe(false);
    expect(toolArgumentsDraftHasChanges('{"query":"owner"}')).toBe(true);
    expect(toolArgumentsDraftHasChanges("{\n  \"query\": \"owner\"\n}")).toBe(true);
  });

  it("guards X, backdrop, Escape, and Cancel without clearing a continued draft", () => {
    const closeToolRunner = sourceSection(
      "  function closeToolRunner(",
      "  async function runTool("
    );
    const toolRunModal = sourceSection(
      "      <Modal title={toolAgent ?",
      '      <Modal title="會議證據"'
    );
    const discardGuard = closeToolRunner.indexOf("if (toolArgumentsDraftDirty && !window.confirm(");
    const confirmedClose = closeToolRunner.indexOf("closeToolRunner();");

    expect(source).toContain('const [toolArgumentsDraft, setToolArgumentsDraft] = useState("{}");');
    expect(source).toContain("const toolArgumentsDraftDirty = toolArgumentsDraftHasChanges(toolArgumentsDraft);");
    expect(closeToolRunner).toContain("function requestCloseToolRunner()");
    expect(discardGuard).toBeGreaterThan(-1);
    expect(confirmedClose).toBeGreaterThan(discardGuard);
    expect(toolRunModal).toContain("onClose={requestCloseToolRunner}");
    expect(toolRunModal).toContain("onClick={requestCloseToolRunner}");
    expect(toolRunModal).toContain('name="arguments" rows={5} value={toolArgumentsDraft}');
    expect(toolRunModal).toContain("onChange={(event) => setToolArgumentsDraft(event.currentTarget.value)}");
    expect(toolRunModal).not.toContain('defaultValue="{}"');
  });
});

describe("DiscussionsView mobile taxonomy focus", () => {
  it("restores focus for keyboard and pointer Topic selection from the open mobile panel", () => {
    expect(shouldRestoreMobileTaxonomyFocus(true, 0, true)).toBe(true);
    expect(shouldRestoreMobileTaxonomyFocus(true, 1, true)).toBe(true);
    expect(shouldRestoreMobileTaxonomyFocus(false, 0, true)).toBe(false);
    expect(shouldRestoreMobileTaxonomyFocus(true, 0, false)).toBe(false);
  });

  it("returns focus to the taxonomy disclosure after Topic selection closes the panel", () => {
    const selectThread = sourceSection(
      "  function selectThread(",
      "  function selectMeetingSession("
    );
    const mobileTaxonomy = sourceSection(
      '        className="mobile-discussion-picker"',
      '      <section className="meeting-surface">'
    );

    expect(source).toContain("const mobileTaxonomyDisclosureRef = useRef<HTMLButtonElement>(null);");
    expect(source).toContain("const restoreMobileTaxonomyFocusRef = useRef(false);");
    expect(mobileTaxonomy).toContain("ref={mobileTaxonomyDisclosureRef}");
    expect(mobileTaxonomy).toContain("onClickCapture={(event) => {");
    expect(mobileTaxonomy).toContain("restoreMobileTaxonomyFocusRef.current = shouldRestoreMobileTaxonomyFocus(");
    expect(selectThread).toContain("const restoreMobileTaxonomyFocus = restoreMobileTaxonomyFocusRef.current;");
    expect(selectThread).toContain("restoreMobileTaxonomyFocusRef.current = false;");
    expect(selectThread).toContain("setMobileTaxonomyOpen(false);");
    expect(selectThread).toContain("window.requestAnimationFrame(() => mobileTaxonomyDisclosureRef.current?.focus());");
  });
});

describe("DiscussionsView message send ownership", () => {
  it("restores a failed draft only through the latest per-Meeting send owner", () => {
    const sendMessage = sourceSection(
      "  async function sendMessage(",
      "  async function changeMode("
    );

    expect(source).toContain("const messageDraftOwnershipRef = useRef(new MeetingMessageDraftOwnership());");
    expect(sendMessage).toContain("const draftRequest = messageDraftOwnershipRef.current.beginSend(meetingId);");
    expect(sendMessage).toContain("messageDraftOwnershipRef.current.restoreAfterFailure(current, draftRequest, draft)");
  });

  it("keeps ambiguous retry keys scoped to their Meeting", () => {
    const sendMessage = sourceSection(
      "  async function sendMessage(",
      "  async function changeMode("
    );

    expect(source).toContain("const messageRetryOwnershipRef = useRef(new MeetingMessageRetryOwnership());");
    expect(source).not.toContain("messageRetryRef.current = null;");
    expect(sendMessage).toContain("messageRetryOwnershipRef.current.acquire(");
    expect(sendMessage).toContain("meetingId,");
    expect(sendMessage).toContain("messageRetryOwnershipRef.current.clear(retry)");
  });
});

describe("DiscussionsView durable MCP cancellation reconciliation", () => {
  it("settles only a previously observed tool queue job when its durable state disappears", () => {
    const pollingEffect = sourceSection(
      "    if (!pendingAction?.jobId) return;",
      '    if (!snapshot || pendingAction?.kind !== "tool"'
    );
    const toolReconciliationEffect = sourceSection(
      '    if (!snapshot || pendingAction?.kind !== "tool"',
      '    if (!snapshot || pendingAction?.kind !== "agent"'
    );

    expect(source).toContain("const observedPendingToolJobsRef = useRef(new Set<string>());");
    expect(toolReconciliationEffect).toContain("observedPendingToolJobsRef.current.add(pendingAction.jobId);");
    expect(toolReconciliationEffect).toContain("observedPendingToolJobsRef.current.has(pendingAction.jobId)");
    expect(toolReconciliationEffect).toContain("observedPendingToolJobsRef.current.delete(pendingAction.jobId);");
    expect(toolReconciliationEffect).toContain('outcome === "cancelled"');
    expect(toolReconciliationEffect).toContain("updatePendingAction(null);");
    expect(pollingEffect).toContain("return () => window.clearInterval(timer);");
    expect(source).toContain("const meetingActionActive = meetingQueue.length > 0 || pendingAction !== null;");
  });

  it("uses an exact released queue event as reconciliation evidence before terminal SSE arrives", () => {
    const eventHandler = sourceSection(
      "  const handleMeetingEvent = useCallback(",
      "  useEffect(() => {\n    if (!notice"
    );
    const toolReconciliationEffect = sourceSection(
      '    if (!snapshot || pendingAction?.kind !== "tool"',
      '    if (!snapshot || pendingAction?.kind !== "agent"'
    );
    const agentReconciliationEffect = sourceSection(
      '    if (!snapshot || pendingAction?.kind !== "agent"',
      '    if (meeting?.state !== "active") return;'
    );
    const meetingSelectionReset = sourceSection(
      "    workspaceRevisionRef.current += 1;",
      "  }, [meeting?.id, updatePendingAction]);"
    );

    expect(source).toContain("const releasedPendingJobsRef = useRef(new Set<string>());");
    expect(eventHandler).toContain("meetingActionQueueWasReleased(");
    expect(eventHandler).toContain("releasedPendingJobsRef.current.add(jobId);");
    expect(toolReconciliationEffect).toContain("releasedPendingJobsRef.current.has(pendingAction.jobId)");
    expect(agentReconciliationEffect).toContain("releasedPendingJobsRef.current.has(pendingAction.jobId)");
    expect(toolReconciliationEffect).toContain("releasedPendingJobsRef.current.delete(pendingAction.jobId);");
    expect(agentReconciliationEffect).toContain("releasedPendingJobsRef.current.delete(pendingAction.jobId);");
    expect(meetingSelectionReset).toContain("releasedPendingJobsRef.current.clear();");
  });
});

describe("DiscussionsView non-Meeting drafts", () => {
  it("keeps Topic, Decision, and Task creator inputs in controlled state", () => {
    const submitThread = sourceSection(
      "  async function submitThread(",
      "  async function submitMeeting("
    );
    const submitDecision = sourceSection(
      "  async function submitDecision(",
      "  async function sendMessage("
    );
    const createTask = sourceSection(
      "  async function createTask(",
      "  async function runTool("
    );

    expect(source).toContain("const [threadDraft, setThreadDraft] = useState<ThreadCreateDraft>(emptyThreadCreateDraft);");
    expect(source).toContain("const [decisionDraft, setDecisionDraft] = useState<DecisionCreateDraft>(emptyDecisionCreateDraft);");
    expect(source).toContain("const [taskDraft, setTaskDraft] = useState<TaskCreateDraft>(emptyTaskCreateDraft);");
    expect(submitThread).not.toContain("new FormData(");
    expect(submitDecision).not.toContain("new FormData(");
    expect(createTask).not.toContain("new FormData(");
    expect(source).toContain('value={threadDraft.title}');
    expect(source).toContain('value={decisionDraft.title}');
    expect(source).toContain('value={taskDraft.title}');
    expect(source).not.toContain('option.value === "manual" ? { assigneeAgentId: "" } : { assignee: "" }');
  });

  it("routes Topic and Decision creator closes through dirty-draft guards", () => {
    const closeThreadSource = source.slice(
      source.indexOf("  function closeThreadCreator("),
      source.indexOf("  function toggleThreadDraftTag(")
    );
    const closeDecisionSource = source.slice(
      source.indexOf("  function closeDecisionCreator("),
      source.indexOf("  function openTaxonomyManager(")
    );
    const threadModal = source.slice(
      source.indexOf('      <Modal title="新增討論話題"'),
      source.indexOf('      <Modal title="編輯討論話題"')
    );
    const decisionModal = source.slice(
      source.indexOf('      <Modal title="提出決議"'),
      source.indexOf('      <Modal title="從決議建立任務"')
    );

    expect(closeThreadSource).toContain("function requestCloseThreadCreator()");
    expect(closeThreadSource).toContain("if (threadDraftDirty && !window.confirm(");
    expect(closeThreadSource).toContain("closeThreadCreator();");
    expect(closeDecisionSource).toContain("function requestCloseDecisionCreator()");
    expect(closeDecisionSource).toContain("if (decisionDraftDirty && !window.confirm(");
    expect(closeDecisionSource).toContain("closeDecisionCreator();");
    expect(threadModal).toContain("onClose={requestCloseThreadCreator}");
    expect(threadModal).toContain("onClick={requestCloseThreadCreator}");
    expect(decisionModal).toContain("onClose={requestCloseDecisionCreator}");
    expect(decisionModal).toContain("onClick={requestCloseDecisionCreator}");
  });

  it("keeps the Topic creator Category baseline stable across taxonomy refreshes", () => {
    const closeThreadSource = source.slice(
      source.indexOf("  function openThreadCreator("),
      source.indexOf("  function toggleThreadDraftTag(")
    );

    expect(source).toContain("const [threadDraftBaseCategoryId, setThreadDraftBaseCategoryId]");
    expect(source).toContain("const threadDraftDirty = threadDraftHasChanges(threadDraftBaseCategoryId, threadDraft);");
    expect(source).not.toContain('threadDraftHasChanges(snapshot?.categories[0]?.id ?? "", threadDraft)');
    expect(closeThreadSource).toContain("const baseCategoryId = snapshot?.categories[0]?.id ?? \"\";");
    expect(closeThreadSource).toContain("setThreadDraftBaseCategoryId(baseCategoryId);");
    expect(closeThreadSource).toContain('setThreadDraftBaseCategoryId("");');
  });

  it("routes Task creator closes through a dirty-draft guard", () => {
    const taskCloseSource = source.slice(
      source.indexOf("  function closeTaskCreator("),
      source.indexOf("  async function createTask(")
    );
    const taskModal = source.slice(
      source.indexOf('      {taskDecision && <Modal title="從決議建立任務"'),
      source.indexOf('      <Modal title={toolAgent ?')
    );

    expect(source).toContain("const taskCreateDraftDirty = taskCreateDraftHasChanges(");
    expect(taskCloseSource).toContain("function requestCloseTaskCreator()");
    expect(taskCloseSource).toContain("if (taskCreateDraftDirty && !window.confirm(");
    expect(taskCloseSource).toContain("closeTaskCreator();");
    expect(taskModal).toContain("onClose={requestCloseTaskCreator}");
    expect(taskModal).toContain("onClick={requestCloseTaskCreator}");
  });
});

describe("DiscussionsView projection freshness recovery", () => {
  it("shows a retained-projection warning and an explicit retry action", () => {
    const componentSource = sourceSection(
      "export function DiscussionsView(",
      "  function closeThreadCreator("
    );
    const renderedSource = source.slice(source.indexOf("  return ("));

    expect(source).toContain('import { projectionFreshnessLabel } from "../lib/platform-projection";');
    expect(source).toContain('import { Empty, Modal, PageState, ProjectionFreshnessWarning } from "./ui";');
    expect(componentSource).toContain("platformProjectionStale");
    expect(componentSource).toContain("platformProjectionRefreshing");
    expect(componentSource).toContain("platformProjectionLastSuccessfulAt");
    expect(componentSource).toContain("refreshRequired");
    expect(componentSource).toContain("projectionFreshnessLabel({");
    expect(renderedSource).toContain("<ProjectionFreshnessWarning");
    expect(renderedSource).toContain("onRetry={() => void refreshRequired().catch(() => undefined)}");
  });
});

describe("DiscussionsView embedded Meeting projection", () => {
  it("refreshes a missing embedded Meeting and never falls back to another Topic", () => {
    expect(source).toContain("embeddedProjectionRefreshRequestedRef");
    expect(source).toContain("void refreshRequired().catch(() => undefined)");
    expect(source).toContain("snapshot && embeddedContextReady");
    expect(source).toContain("正式會議資料同步中。");
  });
});
