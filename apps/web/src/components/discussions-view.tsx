"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type UIEvent } from "react";
import {
  ArrowDown,
  ArrowRight,
  CalendarClock,
  Check,
  CirclePause,
  CirclePlay,
  CircleStop,
  Clock3,
  FolderCog,
  FileCheck2,
  History,
  Info,
  MessageSquarePlus,
  MessagesSquare,
  Network,
  LoaderCircle,
  Play,
  RefreshCw,
  Send,
  UserRoundCheck,
  UserRoundCog,
  Vote,
  Wrench,
  Pencil,
  X
} from "lucide-react";
import { roleAllowsExternalTools, type AgentReadiness, type ChairAutomationLevel, type ChairSuggestionRecord, type Decision, type Meeting, type MeetingAgenda, type MeetingMode, type ParticipantAssignment, type PublicPlatformSnapshot as PlatformSnapshot, type TaskExecutionProfile, type ThreadStatus } from "@council/contracts";
import { permittedAgentIdsForMeeting, remainingMeetingMinutes } from "@council/domain/meeting-scheduling";
import { resolveCommittedMutation, usePlatform } from "../app/providers";
import { useMeetingEvents } from "../hooks/use-meeting-events";
import { ApiError, isConflictError, isRevisionConflictError, managementApi, type MeetingPresetPreflight } from "../lib/api";
import { LatestRequestGate } from "../lib/latest-request";
import { meetingActionRequestIsCurrent } from "../lib/meeting-action-ui";
import { projectionFreshnessLabel } from "../lib/platform-projection";
import { initialMeetingRoleSelection, meetingPrefillForAgent, meetingRoleSelectionIsValid, preferredMeetingChairAgentId, reconcileMeetingRoleSelection } from "../lib/role-ui";
import {
  activeChairSuggestion,
  canCreateMeetingForThread,
  canFinalizeThread,
  categoryBreadcrumb,
  chairSuggestionHistory,
  discussionContext,
  filterThreadsByDiscovery,
  IdempotencyRetryRegistry,
  isAgentRunnable,
  isNearScrollEnd,
  loadPublishedAgentReadiness,
  meetingActionOutcome,
  meetingActionQueueWasReleased,
  meetingAgentAvailability,
  meetingEvidenceItems,
  meetingModeStateLabel,
  meetingParticipantPreflight,
  meetingPresetBlockingReason,
  normalizeMeetingParticipantSelection,
  persistedAgentRunOutcome,
  persistedToolRunOutcome,
  preferredThreadId,
  taxonomyForThread,
  threadHasOpenMeeting,
  threadStatusLabel,
  toolRegistrationKindLabel,
  toolOutputView,
  type ClientMeetingEvent,
  type ThreadDiscoveryFilter,
  type ThreadStatusFilter
} from "../lib/view-model";
import { DecisionPanel } from "./decision-panel";
import { DiscussionSidebar } from "./discussion-sidebar";
import { MeetingMessage } from "./meeting-message";
import { MeetingActivity } from "./meeting-activity";
import { MeetingCanvasLoader } from "./meeting-canvas-loader";
import { MeetingRecordView } from "./meeting-record-view";
import { AgendaDraftEditor, MeetingAgendaBand, MeetingAgendaModalContent } from "./meeting-agenda";
import { MeetingSpeakerQueue } from "./meeting-speaker-queue";
import { ParticipantRoleSwitchModal } from "./participant-role-switch-modal";
import { TaxonomyManagerModal } from "./taxonomy-manager-modal";
import { TopicContextHeader } from "./topic-context-header";
import { Empty, Modal, PageState, ProjectionFreshnessWarning } from "./ui";
import { agendaDraftFromAgenda, agendaDraftRevisionMatches, canSubmitAgendaDraft, type AgendaDraftItem } from "../lib/agenda-ui";
import { eligibleMeetingSpeakers, meetingSpeakerQueue } from "../lib/speaker-queue-ui";
import { chairAutomationLabel, chairAutomationOptions, chairAutomationSuggestionStatusLabel, chairUsesCloudModel, canChangeChairAutomation, canRequestChairIntervention, shouldShowChairSuggestion } from "../lib/chair-automation-ui";
import { applyAgentTeam, applyMeetingPreset } from "../lib/management-ui";
import { MeetingMessageDraftOwnership, MeetingMessageRetryOwnership, updateMeetingMessageDraft } from "../lib/meeting-message-drafts";
import {
  agendaConflictRecovery,
  agendaDraftHasChanges,
  topicConflictRecovery,
  topicDraftBaseFromThread,
  topicDraftHasChanges,
  type TopicDraftBase,
  type TopicDraftFields
} from "../lib/discussion-conflict-recovery";
import { meetingActivity, meetingCanvasProjection, type CanvasLens, type MeetingExperienceTab } from "../lib/meeting-experience";
import { buildMeetingWorkspaceHref, buildTaskWorkspaceHref, parseMeetingWorkspaceRoute } from "../lib/workspace-navigation";
import { AgentContextInspector } from "./agent-context-inspector";
import { SourceContextBar } from "./source-context-bar";
import { TaskContextInspector } from "./task-context-inspector";

const modeLabels: Record<MeetingMode, string> = { chaired: "主席主持", open: "自由討論", fixed: "固定流程" };
const meetingStateLabels: Record<Meeting["state"], string> = { draft: "尚未開始", active: "進行中", paused: "已暫停", closed: "已結束" };
const productTimeZone = "Asia/Taipei";
const chairReasonLabels: Record<ChairSuggestionRecord["reason"], string> = { repetition: "重複發言", off_topic: "偏離議題", time_remaining: "時間不足" };
const chairResolutionLabels: Record<NonNullable<ChairSuggestionRecord["resolution"]>, string> = {
  completed: "已完成",
  dismissed: "已略過",
  superseded: "已由新建議取代",
  manual_override: "已手動調整",
  meeting_closed: "會議已結束"
};
const chairTransitionLabels: Record<ChairSuggestionRecord["transitions"][number]["type"], string> = {
  created: "提出建議",
  mode_accepted: "核准模式",
  role_accepted: "核准角色",
  agent_requested: "請主席介入",
  request_released: "介入未完成，可重試",
  completed: "主席完成介入",
  dismissed: "保留目前方向",
  superseded: "由新建議取代",
  manual_override: "手動調整模式",
  meeting_closed: "會議結束",
  close_reverted: "結束操作已復原"
};
const lastThreadStorageKey = "council:last-thread";
const evidenceSourceLabels = { tool_run: "Tool Run", utterance: "會議發言", task: "任務證據" } as const;
const evidenceStatusLabels = { verified: "已驗證", failed: "失敗", linked: "已連結" } as const;
const defaultMeetingAgenda: AgendaDraftItem[] = [{ title: "確認目標與範圍", description: "" }];
const taskExecutionOptions: Array<{ value: TaskExecutionProfile; label: string }> = [
  { value: "manual", label: "人工處理" },
  { value: "advisor", label: "Agent 顧問" },
  { value: "worker", label: "Agent 產出" }
];

interface ThreadCreateDraft {
  categoryId: string;
  title: string;
  summary: string;
  tagIds: string[];
}

interface DecisionCreateDraft {
  title: string;
  description: string;
}

interface TaskCreateDraft {
  title: string;
  description: string;
  assignee: string;
  assigneeAgentId: string;
  dueAt: string;
  acceptanceCriteria: string;
}

export interface MeetingCreatorDraft {
  title: string;
  goal: string;
  agendaItems: AgendaDraftItem[];
  automation: ChairAutomationLevel;
  mode: MeetingMode;
  durationMinutes: number;
  teamId: string;
  presetId: string;
  participantIds: string[];
  chairAgentId: string | null;
  roleIdByAgent: Record<string, string>;
  warningsConfirmed: boolean;
}

export interface ControlledMeetingTeamSelection {
  teamId: string;
  participantIds: string[];
  chairAgentId: string | null;
  roleIdByAgent: Record<string, string>;
}

export type MeetingTeamSelectionAttempt =
  | { accepted: true; selection: ControlledMeetingTeamSelection }
  | { accepted: false; selection: ControlledMeetingTeamSelection; cause: unknown };

export function attemptMeetingTeamSelection(
  previous: ControlledMeetingTeamSelection,
  requestedTeamId: string,
  apply: (teamId: string) => Omit<ControlledMeetingTeamSelection, "teamId">
): MeetingTeamSelectionAttempt {
  try {
    return {
      accepted: true,
      selection: { teamId: requestedTeamId, ...apply(requestedTeamId) }
    };
  } catch (cause) {
    return { accepted: false, selection: previous, cause };
  }
}

const emptyThreadCreateDraft: ThreadCreateDraft = { categoryId: "", title: "", summary: "", tagIds: [] };
const emptyDecisionCreateDraft: DecisionCreateDraft = { title: "", description: "" };
const emptyTaskCreateDraft: TaskCreateDraft = {
  title: "",
  description: "",
  assignee: "",
  assigneeAgentId: "",
  dueAt: "",
  acceptanceCriteria: ""
};

function threadDraftHasChanges(baseCategoryId: string, draft: ThreadCreateDraft): boolean {
  return draft.categoryId !== baseCategoryId || draft.title.trim() !== "" || draft.summary.trim() !== "" || draft.tagIds.length > 0;
}

function decisionDraftHasChanges(draft: DecisionCreateDraft): boolean {
  return draft.title.trim() !== "" || draft.description.trim() !== "";
}

function taskCreateDraftHasChanges(
  decision: Pick<Decision, "title" | "description"> | null,
  draft: TaskCreateDraft,
  executionProfile: TaskExecutionProfile
): boolean {
  if (!decision) return false;
  return draft.title !== decision.title
    || draft.description !== decision.description
    || draft.assignee !== ""
    || draft.assigneeAgentId !== ""
    || draft.dueAt !== ""
    || draft.acceptanceCriteria !== ""
    || executionProfile !== "manual";
}

export function toolArgumentsDraftHasChanges(value: string): boolean {
  return value !== "{}";
}

export function shouldRestoreMobileTaxonomyFocus(
  panelOpen: boolean,
  _clickDetail: number,
  targetIsTopic: boolean
): boolean {
  return panelOpen && targetIsTopic;
}

export function meetingCreatorDraftHasChanges(base: MeetingCreatorDraft, draft: MeetingCreatorDraft): boolean {
  const agendaChanged = base.agendaItems.length !== draft.agendaItems.length
    || base.agendaItems.some((item, index) => {
      const next = draft.agendaItems[index];
      return !next || item.title !== next.title || item.description !== next.description;
    });
  const participantsChanged = base.participantIds.length !== draft.participantIds.length
    || base.participantIds.some((agentId, index) => agentId !== draft.participantIds[index]);
  const roleIds = new Set([...Object.keys(base.roleIdByAgent), ...Object.keys(draft.roleIdByAgent)]);
  const rolesChanged = [...roleIds].some((agentId) => base.roleIdByAgent[agentId] !== draft.roleIdByAgent[agentId]);
  return base.title !== draft.title
    || base.goal !== draft.goal
    || agendaChanged
    || base.automation !== draft.automation
    || base.mode !== draft.mode
    || base.durationMinutes !== draft.durationMinutes
    || base.teamId !== draft.teamId
    || base.presetId !== draft.presetId
    || participantsChanged
    || base.chairAgentId !== draft.chairAgentId
    || rolesChanged
    || base.warningsConfirmed !== draft.warningsConfirmed;
}

function createInitialMeetingCreatorDraft(
  title: string,
  goal: string,
  participantIds: readonly string[] = [],
  chairAgentId: string | null = null,
  roleIdByAgent: Readonly<Record<string, string>> = {}
): MeetingCreatorDraft {
  return {
    title,
    goal,
    agendaItems: defaultMeetingAgenda.map((item) => ({ ...item })),
    automation: "suggest",
    mode: "chaired",
    durationMinutes: 30,
    teamId: "",
    presetId: "",
    participantIds: [...participantIds],
    chairAgentId,
    roleIdByAgent: { ...roleIdByAgent },
    warningsConfirmed: false
  };
}

interface PendingMeetingAction {
  meetingId: string;
  jobId: string | null;
  kind: "agent" | "tool";
  label: string;
  agentId?: string;
}

export interface MeetingAgentRunRetryRequest {
  meetingId: string;
  signature: string;
  idempotencyKey: string;
}

export class MeetingAgentRunRetryOwnership {
  private readonly retriesByMeetingId = new Map<string, Map<string, MeetingAgentRunRetryRequest>>();

  acquire(meetingId: string, signature: string, createKey: () => string): MeetingAgentRunRetryRequest {
    let meetingRetries = this.retriesByMeetingId.get(meetingId);
    const current = meetingRetries?.get(signature);
    if (current) return current;
    const retry = { meetingId, signature, idempotencyKey: createKey() };
    if (!meetingRetries) {
      meetingRetries = new Map();
      this.retriesByMeetingId.set(meetingId, meetingRetries);
    }
    meetingRetries.set(signature, retry);
    return retry;
  }

  clear(request: MeetingAgentRunRetryRequest): void {
    const meetingRetries = this.retriesByMeetingId.get(request.meetingId);
    if (meetingRetries?.get(request.signature) !== request) return;
    meetingRetries.delete(request.signature);
    if (meetingRetries.size === 0) this.retriesByMeetingId.delete(request.meetingId);
  }
}

function initials(value: string): string {
  return value.split(/[-\s]/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase();
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function chairHistoryTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: productTimeZone }).format(new Date(value));
}

function meetingSessionLabel(meeting: Meeting, isLatest: boolean): string {
  const created = new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: productTimeZone }).format(new Date(meeting.createdAt));
  return `${isLatest ? "最新 · " : ""}${meeting.title} · ${meetingStateLabels[meeting.state]} · ${created}`;
}

function cloneMeetingAgenda(agenda: MeetingAgenda): MeetingAgenda {
  return { revision: agenda.revision, items: agenda.items.map((item) => ({ ...item })) };
}

export function DiscussionsView({ embeddedMeetingId }: { embeddedMeetingId?: string } = {}) {
  return <Suspense fallback={<PageState loading error={null} />}><DiscussionsViewContent embeddedMeetingId={embeddedMeetingId} /></Suspense>;
}

function DiscussionsViewContent({ embeddedMeetingId }: { embeddedMeetingId: string | undefined }) {
  const {
    snapshot,
    loading,
    error,
    platformProjectionStale,
    platformProjectionRefreshing,
    platformProjectionLastSuccessfulAt,
    mutate,
    refresh,
    refreshRequired,
    refreshMeeting,
    focusMeeting
  } = usePlatform();
  const router = useRouter();
  const searchParams = useSearchParams();
  const routeState = parseMeetingWorkspaceRoute(searchParams);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [threadModal, setThreadModal] = useState(false);
  const [taxonomyModal, setTaxonomyModal] = useState(false);
  const [meetingModal, setMeetingModal] = useState(false);
  const [agendaModal, setAgendaModal] = useState(false);
  const [decisionModal, setDecisionModal] = useState(false);
  const [editThreadModal, setEditThreadModal] = useState(false);
  const [closeModal, setCloseModal] = useState(false);
  const [chairHistoryModal, setChairHistoryModal] = useState(false);
  const [evidenceModal, setEvidenceModal] = useState(false);
  const [roleSwitchParticipantId, setRoleSwitchParticipantId] = useState<string | null>(null);
  const [taskDecision, setTaskDecision] = useState<Decision | null>(null);
  const [taskExecutionProfile, setTaskExecutionProfile] = useState<TaskExecutionProfile>("manual");
  const [threadDraft, setThreadDraft] = useState<ThreadCreateDraft>(emptyThreadCreateDraft);
  const [threadDraftBaseCategoryId, setThreadDraftBaseCategoryId] = useState("");
  const [decisionDraft, setDecisionDraft] = useState<DecisionCreateDraft>(emptyDecisionCreateDraft);
  const [taskDraft, setTaskDraft] = useState<TaskCreateDraft>(emptyTaskCreateDraft);
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [discoveryStatus, setDiscoveryStatus] = useState<ThreadStatusFilter>("all");
  const [discoveryTagId, setDiscoveryTagId] = useState("");
  const [mobileTaxonomyOpen, setMobileTaxonomyOpen] = useState(false);
  const [toolAgentId, setToolAgentId] = useState<string | null>(null);
  const [selectedToolIndex, setSelectedToolIndex] = useState(0);
  const [toolArgumentsDraft, setToolArgumentsDraft] = useState("{}");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [meetingExperienceTab, setMeetingExperienceTab] = useState<MeetingExperienceTab>(routeState.view);
  const [canvasLens, setCanvasLens] = useState<CanvasLens>(routeState.lens);
  const [inspectedTaskId, setInspectedTaskId] = useState<string | null>(null);
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState<"success" | "warning" | "error">("success");
  const [modalError, setModalError] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingGoal, setMeetingGoal] = useState("");
  const [meetingParticipantIds, setMeetingParticipantIds] = useState<string[]>([]);
  const [meetingChairAgentId, setMeetingChairAgentId] = useState<string | null>(null);
  const [meetingRoleIdByAgent, setMeetingRoleIdByAgent] = useState<Record<string, string>>({});
  const [meetingAgendaDraft, setMeetingAgendaDraft] = useState<AgendaDraftItem[]>(defaultMeetingAgenda);
  const [meetingAutomation, setMeetingAutomation] = useState<ChairAutomationLevel>("suggest");
  const [meetingMode, setMeetingMode] = useState<MeetingMode>("chaired");
  const [meetingDurationMinutes, setMeetingDurationMinutes] = useState(30);
  const [meetingTeamId, setMeetingTeamId] = useState("");
  const [meetingPresetId, setMeetingPresetId] = useState("");
  const [meetingWarningsConfirmed, setMeetingWarningsConfirmed] = useState(false);
  const [meetingCreatorDraftBase, setMeetingCreatorDraftBase] = useState<MeetingCreatorDraft | null>(null);
  const [meetingAgentReadinessById, setMeetingAgentReadinessById] = useState<Record<string, AgentReadiness>>({});
  const [meetingAgentReadinessLoading, setMeetingAgentReadinessLoading] = useState(false);
  const [meetingAgentReadinessError, setMeetingAgentReadinessError] = useState("");
  const [meetingPresetPreflight, setMeetingPresetPreflight] = useState<MeetingPresetPreflight | null>(null);
  const [meetingPresetPreflightLoading, setMeetingPresetPreflightLoading] = useState(false);
  const [agendaDraft, setAgendaDraft] = useState<AgendaDraftItem[]>([]);
  const [agendaDraftRevision, setAgendaDraftRevision] = useState<number | null>(null);
  const [agendaDraftBase, setAgendaDraftBase] = useState<MeetingAgenda | null>(null);
  const [agendaConflict, setAgendaConflict] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [roleSwitchBusy, setRoleSwitchBusy] = useState(false);
  const [roleSwitchError, setRoleSwitchError] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingMeetingAction | null>(null);
  const [editThreadCategoryId, setEditThreadCategoryId] = useState("");
  const [editThreadTitle, setEditThreadTitle] = useState("");
  const [editThreadSummary, setEditThreadSummary] = useState("");
  const [editThreadStatus, setEditThreadStatus] = useState<ThreadStatus>("open");
  const [editThreadTagIds, setEditThreadTagIds] = useState<string[]>([]);
  const [editThreadRevision, setEditThreadRevision] = useState<number | null>(null);
  const [editThreadBase, setEditThreadBase] = useState<TopicDraftBase | null>(null);
  const [editThreadConflict, setEditThreadConflict] = useState(false);
  const [showLatestButton, setShowLatestButton] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const mobileTaxonomyDisclosureRef = useRef<HTMLButtonElement>(null);
  const restoreMobileTaxonomyFocusRef = useRef(false);
  const previousMeetingIdRef = useRef<string | null>(null);
  const previousMessageCountRef = useRef(0);
  const stickToLatestRef = useRef(true);
  const pendingActionRef = useRef<PendingMeetingAction | null>(null);
  const bufferedEventsRef = useRef(new Map<string, ClientMeetingEvent>());
  const observedPendingToolJobsRef = useRef(new Set<string>());
  const observedPendingAgentJobsRef = useRef(new Set<string>());
  const releasedPendingJobsRef = useRef(new Set<string>());
  const currentMeetingIdRef = useRef<string | null>(null);
  const workspaceRevisionRef = useRef(0);
  const meetingAgentReadinessRequestId = useRef(0);
  const meetingPresetPreflightRequestId = useRef(0);
  const meetingCreationRequestGateRef = useRef(new LatestRequestGate());
  const activeMeetingCreationRequestTokenRef = useRef<number | null>(null);
  const meetingCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const messageDraftOwnershipRef = useRef(new MeetingMessageDraftOwnership());
  const messageRetryOwnershipRef = useRef(new MeetingMessageRetryOwnership());
  const agentRunRetryOwnershipRef = useRef(new MeetingAgentRunRetryOwnership());
  const decisionRetryOwnershipRef = useRef(new MeetingAgentRunRetryOwnership());
  const threadRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const taskRetryOwnershipRef = useRef(new MeetingAgentRunRetryOwnership());
  const toolRetryOwnershipRef = useRef(new MeetingAgentRunRetryOwnership());
  const meetingShortcutConsumedRef = useRef(false);
  const embeddedProjectionRefreshRequestedRef = useRef<string | null>(null);
  const meetingShortcutRequestGateRef = useRef(new LatestRequestGate());
  const meetingSelectionNoticeRef = useRef<{
    meetingId: string;
    message: string;
    tone: "success" | "warning";
  } | null>(null);

  const updatePendingAction = useCallback((value: PendingMeetingAction | null) => {
    pendingActionRef.current = value;
    setPendingAction(value);
  }, []);

  function captureMeetingRequest(meetingId: string): () => boolean {
    const requestContext = {
      meetingId,
      workspaceRevision: workspaceRevisionRef.current
    };
    return () => meetingActionRequestIsCurrent(requestContext, {
      meetingId: currentMeetingIdRef.current,
      workspaceRevision: workspaceRevisionRef.current
    });
  }

  const refreshPublishedMeetingReadiness = useCallback(async (
    agentIds: readonly string[],
    replace: boolean
  ): Promise<Record<string, AgentReadiness> | null> => {
    const requestId = ++meetingAgentReadinessRequestId.current;
    setMeetingAgentReadinessError("");
    setMeetingAgentReadinessLoading(true);
    if (replace) setMeetingAgentReadinessById({});
    try {
      const readinessByAgentId = await loadPublishedAgentReadiness(agentIds, async (batchAgentIds) => (
        (await managementApi.getAgentReadinessBatch(batchAgentIds)).results
      ));
      if (requestId !== meetingAgentReadinessRequestId.current) return null;
      setMeetingAgentReadinessById((current) => replace
        ? readinessByAgentId
        : { ...current, ...readinessByAgentId });
      return readinessByAgentId;
    } catch (cause) {
      if (requestId !== meetingAgentReadinessRequestId.current) return null;
      setMeetingAgentReadinessError(errorMessage(cause, "無法確認已發布 Agent readiness。"));
      return null;
    } finally {
      if (requestId === meetingAgentReadinessRequestId.current) setMeetingAgentReadinessLoading(false);
    }
  }, []);

  useEffect(() => {
    if (embeddedMeetingId) {
      const embeddedMeeting = snapshot?.meetings.find((candidate) => candidate.id === embeddedMeetingId);
      const embeddedThread = embeddedMeeting
        ? snapshot?.threads.find((candidate) => candidate.id === embeddedMeeting.threadId)
        : undefined;
      if (!embeddedMeeting || !embeddedThread) {
        if (snapshot && embeddedProjectionRefreshRequestedRef.current !== embeddedMeetingId) {
          embeddedProjectionRefreshRequestedRef.current = embeddedMeetingId;
          void refreshRequired().catch(() => undefined);
        }
        return;
      }
      embeddedProjectionRefreshRequestedRef.current = null;
      if (threadId !== embeddedMeeting.threadId) setThreadId(embeddedMeeting.threadId);
      if (meetingId !== embeddedMeeting.id) setMeetingId(embeddedMeeting.id);
      return;
    }
    if (!snapshot?.threads.length) return;
    if (routeState.meetingId) {
      const requestedMeeting = snapshot.meetings.find((candidate) => candidate.id === routeState.meetingId);
      if (requestedMeeting) {
        if (threadId !== requestedMeeting.threadId) setThreadId(requestedMeeting.threadId);
        if (meetingId !== requestedMeeting.id) setMeetingId(requestedMeeting.id);
        try { window.localStorage.setItem(lastThreadStorageKey, requestedMeeting.threadId); } catch { /* URL state remains authoritative. */ }
        return;
      }
      setNotice("找不到指定的會議，已顯示可用場次。");
      setNoticeTone("warning");
    }
    if (routeState.threadId && snapshot.threads.some((candidate) => candidate.id === routeState.threadId)) {
      if (threadId !== routeState.threadId) setThreadId(routeState.threadId);
      if (meetingId && !snapshot.meetings.some((candidate) => candidate.id === meetingId && candidate.threadId === routeState.threadId)) setMeetingId(null);
      try { window.localStorage.setItem(lastThreadStorageKey, routeState.threadId); } catch { /* URL state remains authoritative. */ }
      return;
    }
    if (threadId) return;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(lastThreadStorageKey); } catch { /* Use the newest active thread when storage is unavailable. */ }
    const selected = snapshot.threads.some((item) => item.id === stored) ? stored : preferredThreadId(snapshot.threads);
    if (selected) setThreadId(selected);
  }, [embeddedMeetingId, meetingId, refreshRequired, routeState.meetingId, routeState.threadId, snapshot, threadId]);

  useEffect(() => {
    if (embeddedMeetingId) return;
    setMeetingExperienceTab(routeState.view);
    setCanvasLens(routeState.lens);
  }, [embeddedMeetingId, routeState.lens, routeState.view]);
  useEffect(() => {
    if (embeddedMeetingId) return;
    const syncHistoryRoute = () => {
      const historyRoute = parseMeetingWorkspaceRoute(new URLSearchParams(window.location.search));
      setMeetingExperienceTab(historyRoute.view);
      setCanvasLens(historyRoute.lens);
    };
    window.addEventListener("popstate", syncHistoryRoute);
    return () => window.removeEventListener("popstate", syncHistoryRoute);
  }, [embeddedMeetingId]);

  useEffect(() => {
    if (!snapshot || meetingShortcutConsumedRef.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("newMeeting") !== "1") return;
    meetingShortcutConsumedRef.current = true;
    const clearShortcut = () => {
      url.searchParams.delete("newMeeting");
      url.searchParams.delete("agentId");
      const search = url.searchParams.toString();
      window.history.replaceState(window.history.state, "", `${url.pathname}${search ? `?${search}` : ""}${url.hash}`);
    };
    const requestedAgentId = url.searchParams.get("agentId");
    clearShortcut();
    if (!requestedAgentId) {
      setNotice("無法帶入 Agent：捷徑未指定 Agent。");
      setNoticeTone("warning");
      return;
    }
    void (async () => {
      const shortcutRequestToken = meetingShortcutRequestGateRef.current.begin();
      const readinessByAgentId = await refreshPublishedMeetingReadiness(
        snapshot.agents.map((agent) => agent.id),
        true
      );
      if (!meetingShortcutRequestGateRef.current.isCurrent(shortcutRequestToken)) return;
      if (!readinessByAgentId) {
        setNotice("無法確認已發布 Agent readiness，請稍後重試。");
        setNoticeTone("warning");
        return;
      }
      const availability = meetingAgentAvailability(snapshot, readinessByAgentId);
      const availableAgentIds = availability.filter((item) => item.available).map((item) => item.agent.id);
      const requestedAvailability = availability.find((item) => item.agent.id === requestedAgentId);
      const defaultChairId = preferredMeetingChairAgentId(snapshot, availableAgentIds);
      const targetThread = snapshot.threads.find((candidate) => candidate.id === threadId && canCreateMeetingForThread(snapshot, candidate))
        ?? snapshot.threads.find((candidate) => canCreateMeetingForThread(snapshot, candidate));
      const prefill = meetingPrefillForAgent(availableAgentIds, defaultChairId, requestedAgentId, snapshot.roles);
      if (!prefill) {
        setNotice(requestedAvailability?.blockingReason
          ? `${requestedAvailability.agent.name} 暫不可用：${requestedAvailability.blockingReason}`
          : "無法帶入 Agent：請確認已發布版本可用，且平台已有可用 Role。");
        setNoticeTone("warning");
        return;
      }
      if (!targetThread) {
        setNotice("目前沒有可建立新會議的 open 話題；請先結束進行中的會議或建立新話題。");
        setNoticeTone("warning");
        return;
      }
      try { window.localStorage.setItem(lastThreadStorageKey, targetThread.id); } catch { /* The shortcut still works without storage. */ }
      const shortcutDraft = createInitialMeetingCreatorDraft(
        targetThread.title,
        targetThread.summary ?? "",
        prefill.participantIds,
        prefill.chairAgentId,
        prefill.roleIdByAgent
      );
      setThreadId(targetThread.id);
      setMeetingId(null);
      setMeetingTitle(shortcutDraft.title);
      setMeetingGoal(shortcutDraft.goal);
      setMeetingParticipantIds([...shortcutDraft.participantIds]);
      setMeetingChairAgentId(shortcutDraft.chairAgentId);
      setMeetingRoleIdByAgent({ ...shortcutDraft.roleIdByAgent });
      setMeetingAgendaDraft(shortcutDraft.agendaItems.map((item) => ({ ...item })));
      setMeetingAutomation(shortcutDraft.automation);
      setMeetingMode(shortcutDraft.mode);
      setMeetingDurationMinutes(shortcutDraft.durationMinutes);
      setMeetingTeamId(shortcutDraft.teamId);
      setMeetingPresetId(shortcutDraft.presetId);
      setMeetingWarningsConfirmed(shortcutDraft.warningsConfirmed);
      setMeetingCreatorDraftBase(shortcutDraft);
      setModalError("");
      setMeetingModal(true);
      setNotice(`已帶入 ${requestedAvailability?.agent.name ?? "指定 Agent"}，可在送出前調整角色與主席。`);
      setNoticeTone("success");
    })();
  }, [refreshPublishedMeetingReadiness, snapshot, threadId]);

  const discoveryFilter: ThreadDiscoveryFilter = useMemo(() => ({
    query: discoveryQuery,
    status: discoveryStatus,
    tagIds: discoveryTagId ? [discoveryTagId] : []
  }), [discoveryQuery, discoveryStatus, discoveryTagId]);

  const embeddedMeeting = embeddedMeetingId
    ? snapshot?.meetings.find((candidate) => candidate.id === embeddedMeetingId)
    : undefined;
  const embeddedThread = embeddedMeeting
    ? snapshot?.threads.find((candidate) => candidate.id === embeddedMeeting.threadId)
    : undefined;
  const embeddedContextReady = !embeddedMeetingId || Boolean(embeddedMeeting && embeddedThread);
  const context = useMemo(() => snapshot && embeddedContextReady
    ? discussionContext(snapshot, embeddedMeeting?.threadId ?? threadId, embeddedMeeting?.id ?? meetingId)
    : null, [embeddedContextReady, embeddedMeeting?.id, embeddedMeeting?.threadId, meetingId, snapshot, threadId]);
  const thread = context?.thread;
  const taxonomy = thread && snapshot ? taxonomyForThread(snapshot, thread.id) : null;
  const meetings = context?.meetings ?? [];
  const meeting = context?.meeting;
  const meetingSessionPicker = meeting && !embeddedMeetingId ? <label className="meeting-session-picker" htmlFor="meeting-session-select">
    <CalendarClock size={14} aria-hidden="true" />
    <span>場次</span>
    <select id="meeting-session-select" aria-label="切換會議場次" value={meeting.id} onChange={(event) => selectMeetingSession(event.currentTarget.value)}>
      {meetings.some((session) => session.state !== "closed") && <optgroup label="目前場次">{meetings.filter((session) => session.state !== "closed").map((session) => <option key={session.id} value={session.id}>{meetingSessionLabel(session, meetings[0]?.id === session.id)}</option>)}</optgroup>}
      {meetings.some((session) => session.state === "closed") && <optgroup label="封存場次">{meetings.filter((session) => session.state === "closed").map((session) => <option key={session.id} value={session.id}>{meetingSessionLabel(session, meetings[0]?.id === session.id)}</option>)}</optgroup>}
    </select>
  </label> : null;
  const message = meeting ? messageDrafts[meeting.id] ?? "" : "";
  const messages = context?.messages ?? [];
  const decisions = context?.decisions ?? [];
  const participants = context?.participants ?? [];
  const meetingTasks = snapshot && meeting ? snapshot.tasks.filter((task) => task.meetingId === meeting.id) : [];
  const firstMeetingTask = meetingTasks.at(0);
  const inspectedTask = inspectedTaskId && snapshot ? snapshot.tasks.find((task) => task.id === inspectedTaskId) ?? null : null;
  const inspectedTaskAssignee = inspectedTask?.assigneeAgentId && snapshot
    ? snapshot.agents.find((agent) => agent.id === inspectedTask.assigneeAgentId)?.name ?? "未知 Agent"
    : inspectedTask?.assignee ?? "未指派";
  const inspectedAgent = inspectedAgentId && snapshot ? snapshot.agents.find((agent) => agent.id === inspectedAgentId) ?? null : null;
  const inspectedParticipant = inspectedAgentId ? participants.find((participant) => participant.agentId === inspectedAgentId) ?? null : null;
  const inspectorSource = {
    ...(routeState.fromGoalId ? { goalId: routeState.fromGoalId } : {}),
    ...(meeting ? { meetingId: meeting.id } : {}),
    ...(thread ? { threadId: thread.id } : {})
  };
  const chairSuggestion = snapshot && meeting ? activeChairSuggestion(snapshot, meeting.id) : null;
  const chairHistory = snapshot && meeting ? chairSuggestionHistory(snapshot, meeting.id) : [];
  const evidenceItems = snapshot && meeting ? meetingEvidenceItems(snapshot, meeting.id) : [];
  const experienceData = meeting ? { meeting, participants, messages, decisions, tasks: meetingTasks, evidence: evidenceItems } : null;
  const activityItems = useMemo(() => experienceData ? meetingActivity(experienceData) : [], [experienceData]);
  const canvasProjection = useMemo(() => experienceData ? meetingCanvasProjection(experienceData, canvasLens) : null, [canvasLens, experienceData]);
  const filteredThreads = useMemo(
    () => snapshot ? filterThreadsByDiscovery(snapshot, discoveryFilter) : [],
    [discoveryFilter, snapshot]
  );
  const threadHasOngoingMeeting = thread && snapshot ? threadHasOpenMeeting(snapshot, thread.id) : false;
  const canSetResolvedOrArchived = !threadHasOngoingMeeting;
  const canCreateMeeting = Boolean(thread && snapshot && canCreateMeetingForThread(snapshot, thread));
  const editThreadDraft: TopicDraftFields = {
    categoryId: editThreadCategoryId,
    title: editThreadTitle,
    summary: editThreadSummary,
    status: editThreadStatus,
    tagIds: editThreadTagIds
  };
  const editThreadDirty = Boolean(editThreadBase && topicDraftHasChanges(editThreadBase, editThreadDraft));
  const threadDraftDirty = threadDraftHasChanges(threadDraftBaseCategoryId, threadDraft);
  const decisionDraftDirty = decisionDraftHasChanges(decisionDraft);
  const taskCreateDraftDirty = taskCreateDraftHasChanges(taskDecision, taskDraft, taskExecutionProfile);
  const toolArgumentsDraftDirty = toolArgumentsDraftHasChanges(toolArgumentsDraft);
  const meetingCreatorDraft: MeetingCreatorDraft = {
    title: meetingTitle,
    goal: meetingGoal,
    agendaItems: meetingAgendaDraft,
    automation: meetingAutomation,
    mode: meetingMode,
    durationMinutes: meetingDurationMinutes,
    teamId: meetingTeamId,
    presetId: meetingPresetId,
    participantIds: meetingParticipantIds,
    chairAgentId: meetingChairAgentId,
    roleIdByAgent: meetingRoleIdByAgent,
    warningsConfirmed: meetingWarningsConfirmed
  };
  const meetingCreatorDraftDirty = Boolean(
    meetingCreatorDraftBase && meetingCreatorDraftHasChanges(meetingCreatorDraftBase, meetingCreatorDraft)
  );
  const agendaDraftDirty = Boolean(agendaDraftBase && agendaDraftHasChanges(agendaDraftBase, agendaDraft));
  const agendaDraftStale = Boolean(agendaModal && meeting && agendaDraftRevision !== null && !agendaDraftRevisionMatches(agendaDraftRevision, meeting.agenda));
  const agendaNeedsRecovery = agendaConflict || agendaDraftStale;
  currentMeetingIdRef.current = meeting?.id ?? null;
  const permittedAgentIds = useMemo(
    () => snapshot && meeting ? permittedAgentIdsForMeeting(snapshot, meeting.id) : [],
    [meeting, snapshot]
  );
  const chairAgentId = participants.find((participant) => participant.isChair)?.agentId ?? null;
  const primaryAgentId = meeting?.mode === "fixed"
    ? permittedAgentIds[0] ?? null
    : meeting?.mode === "chaired" && permittedAgentIds.length === 1 && permittedAgentIds[0] === chairAgentId
      ? chairAgentId
      : null;

  useEffect(() => {
    if (!editThreadModal || !thread || !editThreadBase) return;
    if (thread.id !== editThreadBase.threadId || thread.revision !== editThreadBase.revision) {
      setEditThreadConflict(true);
    }
  }, [editThreadBase, editThreadModal, thread?.id, thread?.revision]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({ top: transcript.scrollHeight, behavior });
    stickToLatestRef.current = true;
    setShowLatestButton(false);
  }, []);

  const handleMeetingEvent = useCallback((event: ClientMeetingEvent) => {
    if (event.type === "chair.automation.failed") {
      setNotice(event.data.classification === "queue_unavailable"
        ? "主席自動處理未排入佇列，建議已保留。"
        : "主席自動發言未完成，建議已保留，會議仍可繼續。");
      setNoticeTone("warning");
      return;
    }
    const jobId = typeof event.data.jobId === "string" ? event.data.jobId : null;
    const pending = pendingActionRef.current;
    if (!jobId || !pending || pending.meetingId !== event.meetingId) return;
    if (!pending.jobId) {
      bufferedEventsRef.current.set(jobId, event);
      return;
    }
    if (meetingActionQueueWasReleased({ meetingId: pending.meetingId, jobId: pending.jobId }, event)) {
      releasedPendingJobsRef.current.add(jobId);
      return;
    }
    const outcome = meetingActionOutcome({ meetingId: pending.meetingId, jobId: pending.jobId }, event);
    if (!outcome) return;
    observedPendingToolJobsRef.current.delete(pending.jobId);
    observedPendingAgentJobsRef.current.delete(pending.jobId);
    releasedPendingJobsRef.current.delete(pending.jobId);
    updatePendingAction(null);
    setNotice(outcome === "failure"
      ? `${pending.label}失敗，會議已暫停。`
      : outcome === "cancelled"
        ? `${pending.label}因會議狀態已改變而取消，${pending.kind === "tool" ? "未執行工具" : "未呼叫模型"}。`
        : `${pending.label}已完成。`);
    setNoticeTone(outcome === "failure" ? "error" : outcome === "cancelled" ? "warning" : "success");
  }, [updatePendingAction]);

  useEffect(() => {
    if (!notice || noticeTone === "error" || pendingAction) return;
    const timer = window.setTimeout(() => setNotice(""), 3_500);
    return () => window.clearTimeout(timer);
  }, [notice, noticeTone, pendingAction]);

  useEffect(() => {
    if (!pendingAction?.jobId) return;
    const timer = window.setInterval(() => { void refreshMeeting(pendingAction.meetingId); }, 2_000);
    return () => window.clearInterval(timer);
  }, [pendingAction?.jobId, pendingAction?.meetingId, refreshMeeting]);

  useEffect(() => {
    if (!snapshot || pendingAction?.kind !== "tool" || !pendingAction.jobId) return;
    const queueContainsJob = snapshot.speakerQueue.some((item) =>
      item.meetingId === pendingAction.meetingId && item.jobId === pendingAction.jobId
    );
    if (queueContainsJob) {
      observedPendingToolJobsRef.current.add(pendingAction.jobId);
      return;
    }
    const outcome = persistedToolRunOutcome(
      snapshot,
      pendingAction.meetingId,
      pendingAction.jobId,
      observedPendingToolJobsRef.current.has(pendingAction.jobId)
        || releasedPendingJobsRef.current.has(pendingAction.jobId)
    );
    if (!outcome) return;
    observedPendingToolJobsRef.current.delete(pendingAction.jobId);
    releasedPendingJobsRef.current.delete(pendingAction.jobId);
    updatePendingAction(null);
    setNotice(outcome === "failure"
      ? `${pendingAction.label}失敗，會議已暫停。`
      : outcome === "cancelled"
        ? `${pendingAction.label}已取消；工作不再位於發言佇列。`
        : `${pendingAction.label}已完成。`);
    setNoticeTone(outcome === "failure" ? "error" : outcome === "cancelled" ? "warning" : "success");
  }, [pendingAction, snapshot, updatePendingAction]);

  useEffect(() => {
    if (!snapshot || pendingAction?.kind !== "agent" || !pendingAction.jobId) return;
    const queueContainsJob = snapshot.speakerQueue.some((item) =>
      item.meetingId === pendingAction.meetingId && item.jobId === pendingAction.jobId
    );
    if (queueContainsJob) {
      observedPendingAgentJobsRef.current.add(pendingAction.jobId);
      return;
    }
    const outcome = persistedAgentRunOutcome(
      snapshot,
      pendingAction.meetingId,
      pendingAction.jobId,
      observedPendingAgentJobsRef.current.has(pendingAction.jobId)
        || releasedPendingJobsRef.current.has(pendingAction.jobId)
    );
    if (!outcome) return;
    observedPendingAgentJobsRef.current.delete(pendingAction.jobId);
    releasedPendingJobsRef.current.delete(pendingAction.jobId);
    updatePendingAction(null);
    setNotice(outcome === "failure"
      ? `${pendingAction.label}失敗，會議已暫停。`
      : outcome === "cancelled"
        ? `${pendingAction.label}已結束；工作不再位於發言佇列。`
        : `${pendingAction.label}已完成。`);
    setNoticeTone(outcome === "failure" ? "error" : outcome === "cancelled" ? "warning" : "success");
  }, [pendingAction, snapshot, updatePendingAction]);

  useEffect(() => {
    if (meeting?.state !== "active") return;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [meeting?.id, meeting?.state]);

  useEffect(() => {
    const selectionNotice = meeting?.id === meetingSelectionNoticeRef.current?.meetingId
      ? meetingSelectionNoticeRef.current
      : null;
    if (meeting?.id) meetingSelectionNoticeRef.current = null;
    workspaceRevisionRef.current += 1;
    updatePendingAction(null);
    bufferedEventsRef.current.clear();
    observedPendingToolJobsRef.current.clear();
    observedPendingAgentJobsRef.current.clear();
    releasedPendingJobsRef.current.clear();
    setNotice(selectionNotice?.message ?? "");
    setNoticeTone(selectionNotice?.tone ?? "success");
    setChairHistoryModal(false);
    setEvidenceModal(false);
    setInspectedTaskId(null);
    setInspectedAgentId(null);
    setRoleSwitchParticipantId(null);
    setRoleSwitchError("");
    setRoleSwitchBusy(false);
    if (activeMeetingCreationRequestTokenRef.current === null) setBusy(false);
    setToolAgentId(null);
    setSelectedToolIndex(0);
    setDecisionDraft(emptyDecisionCreateDraft);
    setDecisionModal(false);
    setTaskDraft(emptyTaskCreateDraft);
    setTaskDecision(null);
    setTaskExecutionProfile("manual");
    setCloseModal(false);
    setAgendaModal(false);
    setAgendaDraft([]);
    setAgendaDraftRevision(null);
    setAgendaDraftBase(null);
    setAgendaConflict(false);
    setMeetingAgendaDraft(defaultMeetingAgenda.map((item) => ({ ...item })));
    setShowLatestButton(false);
    stickToLatestRef.current = true;
  }, [meeting?.id, updatePendingAction]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!meeting?.id || !transcript) return;
    const meetingChanged = previousMeetingIdRef.current !== meeting.id;
    const messageAdded = messages.length > previousMessageCountRef.current;
    if (meetingChanged || messageAdded) {
      if (meetingChanged || stickToLatestRef.current || pendingAction !== null) {
        transcript.scrollTop = transcript.scrollHeight;
        stickToLatestRef.current = true;
        setShowLatestButton(false);
      } else {
        setShowLatestButton(true);
      }
    }
    previousMeetingIdRef.current = meeting.id;
    previousMessageCountRef.current = messages.length;
  }, [meeting?.id, messages.length, pendingAction]);

  const refreshActiveMeeting = useCallback(async () => {
    if (meeting?.id) await refreshMeeting(meeting.id);
  }, [meeting?.id, refreshMeeting]);

  useEffect(() => {
    focusMeeting(meeting?.id ?? null, meeting?.state !== "closed");
    return () => focusMeeting(null);
  }, [focusMeeting, meeting?.id, meeting?.state]);

  useMeetingEvents(meeting?.state === "closed" ? undefined : meeting?.id, refreshActiveMeeting, handleMeetingEvent);

  useEffect(() => {
    const selectedMeetingId = meeting?.id ?? null;
    if (meetingId !== selectedMeetingId) setMeetingId(selectedMeetingId);
  }, [meeting?.id, meetingId]);

  useEffect(() => {
    if (embeddedMeetingId || !snapshot || !thread) return;
    const requestedMeetingExists = Boolean(routeState.meetingId && snapshot.meetings.some((candidate) => candidate.id === routeState.meetingId));
    const requestedThreadExists = Boolean(routeState.threadId && snapshot.threads.some((candidate) => candidate.id === routeState.threadId));
    if (requestedMeetingExists && routeState.meetingId !== meeting?.id) return;
    if (!routeState.meetingId && requestedThreadExists && routeState.threadId !== thread.id) return;
    const fromGoalId = routeState.meetingId && routeState.meetingId !== meeting?.id ? null : routeState.fromGoalId;
    const href = buildMeetingWorkspaceHref({
      meetingId: meeting?.id,
      threadId: thread.id,
      fromGoalId,
      view: meetingExperienceTab,
      lens: canvasLens
    });
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (href !== currentHref) router.replace(href, { scroll: false });
  }, [canvasLens, embeddedMeetingId, meeting?.id, meetingExperienceTab, routeState.fromGoalId, routeState.meetingId, routeState.threadId, router, snapshot, thread]);

  if (loading || error || !snapshot) return <PageState loading={loading} error={error} />;
  const projectionStatus = projectionFreshnessLabel({
    stale: platformProjectionStale,
    refreshing: platformProjectionRefreshing,
    lastSuccessfulAt: platformProjectionLastSuccessfulAt
  });
  const availableAgents = snapshot.agents.filter((agent) => agent.lifecycleStatus !== "disabled"
    && Boolean(agent.publishedRevision ?? (agent.lifecycleStatus === undefined ? 1 : null))
    && (agent.lifecycleStatus === "draft" || isAgentRunnable(snapshot, agent.id)));
  const meetingAvailability = meetingAgentAvailability(snapshot, meetingAgentReadinessById);
  const availableMeetingAgents = meetingAvailability.filter((item) => item.available).map((item) => item.agent);
  const unavailableMeetingAgentIds = meetingAvailability
    .filter((item) => item.readiness?.status === "blocked")
    .map((item) => item.agent.id);
  const meetingAvailabilityBlockingReason = unavailableMeetingAgentIds.length > 0
    ? meetingParticipantPreflight(snapshot, unavailableMeetingAgentIds, meetingAgentReadinessById).reason
    : null;
  const participantPreflight = meetingParticipantPreflight(snapshot, meetingParticipantIds, meetingAgentReadinessById);
  const meetingWarningItems = meetingAvailability.filter((item) => meetingParticipantIds.includes(item.agent.id)
    && item.readiness?.status === "warning");
  const activePresetPreflight = meetingPresetId ? meetingPresetPreflight : null;
  const presetWarningAgentNames = activePresetPreflight?.agents
    .filter((item) => item.readiness.status === "warning")
    .map((item) => snapshot.agents.find((agent) => agent.id === item.agentId)?.name ?? "Agent") ?? [];
  const meetingHasWarnings = meetingWarningItems.length > 0 || activePresetPreflight?.status === "warning";
  const meetingPreflightBlocked = participantPreflight.status === "blocked" || activePresetPreflight?.status === "blocked";
  const meetingReadinessChecking = meetingAgentReadinessLoading
    || participantPreflight.status === "checking"
    || meetingPresetPreflightLoading;
  const meetingBlockingReason = participantPreflight.reason
    ?? (activePresetPreflight ? meetingPresetBlockingReason(activePresetPreflight, snapshot.agents) : null);
  const availableRoles = snapshot.roles;
  const primaryAgent = snapshot.agents.find((agent) => agent.id === primaryAgentId);
  const remainingMinutes = meeting ? remainingMeetingMinutes(meeting, clockNow) : null;
  const modeState = meeting ? meetingModeStateLabel(meeting.mode, primaryAgent?.name, primaryAgent?.id === chairAgentId) : "";
  const meetingSelectionValid = meetingRoleSelectionIsValid(meetingParticipantIds, meetingChairAgentId, meetingRoleIdByAgent);
  const pendingAgentId = pendingAction?.kind === "agent" ? pendingAction.agentId ?? null : null;
  const meetingQueue = meeting ? meetingSpeakerQueue(snapshot, meeting.id) : [];
  const queuedParticipantIds = new Set(meetingQueue.map((item) => item.participantId));
  const meetingActionActive = meetingQueue.length > 0 || pendingAction !== null;
  const eligibleSpeakers = meeting
    ? eligibleMeetingSpeakers(meeting, participants, snapshot.agents, permittedAgentIds, queuedParticipantIds)
    : [];
  const agentNameById = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const roleSwitchParticipant: ParticipantAssignment | null = roleSwitchParticipantId
    ? participants.find((participant) => participant.id === roleSwitchParticipantId) ?? null
    : null;
  const toolAgent = snapshot.agents.find((agent) => agent.id === toolAgentId);
  const toolAssignment = toolAgent ? participants.find((participant) => participant.agentId === toolAgent.id) : undefined;
  const roleAllowsTools = toolAssignment?.roleSnapshot.toolPolicy === "agent_read_only_grants"
    && toolAssignment.roleSnapshot.dataPolicy === "agent_declared_scope";
  const toolOptions = roleAllowsTools ? toolAgent?.toolGrants.flatMap((grant) => {
    const connector = snapshot.mcpConnectors.find((item) => item.id === grant.connectorId && item.enabled && item.approvedTools.includes(grant.toolName));
    const registration = connector?.toolRegistrations.find((item) => item.toolName === grant.toolName);
    return connector && registration ? [{ ...grant, connectorName: connector.name, ...registration }] : [];
  }) ?? [] : [];
  const selectedTool = toolOptions[selectedToolIndex] ?? toolOptions[0];
  const chairAutomation = meeting?.automation ?? "suggest";
  const chairAutomationRequestPending = pendingAction !== null || chairSuggestion?.status === "pending";
  const liveCloudChairSelected = chairUsesCloudModel({
    automation: chairAutomation,
    chairAgentId,
    agents: snapshot.agents,
    connectors: snapshot.modelConnectors
  });
  const createCloudChairSelected = chairUsesCloudModel({
    automation: meetingAutomation,
    chairAgentId: meetingChairAgentId,
    agents: snapshot.agents,
    connectors: snapshot.modelConnectors
  });

  function handleTranscriptScroll(event: UIEvent<HTMLDivElement>) {
    const nearLatest = isNearScrollEnd(event.currentTarget);
    stickToLatestRef.current = nearLatest;
    setShowLatestButton(!nearLatest);
  }

  function selectThread(nextThreadId: string | null) {
    const restoreMobileTaxonomyFocus = restoreMobileTaxonomyFocusRef.current;
    restoreMobileTaxonomyFocusRef.current = false;
    meetingShortcutRequestGateRef.current.cancel();
    setMeetingId(null);
    setMeetingExperienceTab("meeting");
    setCanvasLens("progress");
    setMobileTaxonomyOpen(false);
    if (restoreMobileTaxonomyFocus) {
      window.requestAnimationFrame(() => mobileTaxonomyDisclosureRef.current?.focus());
    }
    if (!nextThreadId) {
      setThreadId(null);
      router.push(buildMeetingWorkspaceHref({ view: "meeting" }), { scroll: false });
      return;
    }
    try { window.localStorage.setItem(lastThreadStorageKey, nextThreadId); } catch { /* Selection still works without storage. */ }
    setThreadId(nextThreadId);
    router.push(buildMeetingWorkspaceHref({ threadId: nextThreadId, view: "meeting" }), { scroll: false });
  }

  function selectMeetingSession(nextMeetingId: string) {
    meetingShortcutRequestGateRef.current.cancel();
    setMeetingExperienceTab("meeting");
    setCanvasLens("progress");
    setMeetingId(nextMeetingId);
    const nextMeeting = snapshot?.meetings.find((candidate) => candidate.id === nextMeetingId);
    router.push(buildMeetingWorkspaceHref({ meetingId: nextMeetingId, threadId: nextMeeting?.threadId, view: "meeting" }), { scroll: false });
  }

  function selectMeetingExperience(nextView: MeetingExperienceTab) {
    if (nextView === meetingExperienceTab) return;
    window.history.pushState(
      window.history.state,
      "",
      buildMeetingWorkspaceHref({ meetingId: meeting?.id, threadId: thread?.id, fromGoalId: routeState.fromGoalId, view: nextView, lens: canvasLens })
    );
    setMeetingExperienceTab(nextView);
  }

  function selectCanvasLens(nextLens: CanvasLens) {
    if (nextLens === canvasLens) return;
    window.history.pushState(
      window.history.state,
      "",
      buildMeetingWorkspaceHref({ meetingId: meeting?.id, threadId: thread?.id, fromGoalId: routeState.fromGoalId, view: "canvas", lens: nextLens })
    );
    setMeetingExperienceTab("canvas");
    setCanvasLens(nextLens);
  }

  function focusFlowTarget(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus({ preventScroll: true });
  }

  function openModal(open: (value: boolean) => void) {
    setModalError("");
    open(true);
  }

  function openThreadCreator() {
    const baseCategoryId = snapshot?.categories[0]?.id ?? "";
    setThreadDraftBaseCategoryId(baseCategoryId);
    setThreadDraft({
      ...emptyThreadCreateDraft,
      categoryId: baseCategoryId
    });
    openModal(setThreadModal);
  }

  function closeThreadCreator() {
    if (busy) return;
    setThreadDraftBaseCategoryId("");
    setThreadDraft(emptyThreadCreateDraft);
    setModalError("");
    setThreadModal(false);
  }

  function requestCloseThreadCreator() {
    if (busy) return;
    if (threadDraftDirty && !window.confirm("關閉會捨棄尚未儲存的話題草稿，確定繼續？")) return;
    closeThreadCreator();
  }

  function toggleThreadDraftTag(tagId: string, checked: boolean) {
    setThreadDraft((current) => ({
      ...current,
      tagIds: checked
        ? [...new Set([...current.tagIds, tagId])]
        : current.tagIds.filter((item) => item !== tagId)
    }));
  }

  function openDecisionCreator() {
    setDecisionDraft(emptyDecisionCreateDraft);
    openModal(setDecisionModal);
  }

  function closeDecisionCreator() {
    setDecisionDraft(emptyDecisionCreateDraft);
    setDecisionModal(false);
  }

  function requestCloseDecisionCreator() {
    if (busy) return;
    if (decisionDraftDirty && !window.confirm("關閉會捨棄尚未儲存的決議草稿，確定繼續？")) return;
    closeDecisionCreator();
  }

  function openTaxonomyManager() {
    setTaxonomyModal(true);
  }

  function openThreadEditor() {
    if (!thread || !snapshot) return;
    setEditThreadCategoryId(thread.categoryId);
    setEditThreadTitle(thread.title);
    setEditThreadSummary(thread.summary ?? "");
    setEditThreadTagIds([...thread.tagIds]);
    setEditThreadStatus(thread.status);
    setEditThreadRevision(thread.revision);
    setEditThreadBase(topicDraftBaseFromThread(thread));
    setEditThreadConflict(false);
    setEditThreadModal(true);
    setModalError("");
  }

  function requestCloseThreadEditor() {
    if (busy) return;
    if (editThreadDirty && !window.confirm("關閉會捨棄尚未儲存的話題變更，確定繼續？")) return;
    setEditThreadModal(false);
    setEditThreadBase(null);
    setEditThreadConflict(false);
    setModalError("");
  }

  function reloadLatestThreadContent() {
    if (!thread) return;
    if (editThreadDirty && !window.confirm("重新載入會捨棄這份本機草稿，確定繼續？")) return;
    setEditThreadCategoryId(thread.categoryId);
    setEditThreadTitle(thread.title);
    setEditThreadSummary(thread.summary ?? "");
    setEditThreadTagIds([...thread.tagIds]);
    setEditThreadStatus(thread.status);
    setEditThreadRevision(thread.revision);
    setEditThreadBase(topicDraftBaseFromThread(thread));
    setEditThreadConflict(false);
    setModalError("");
  }

  function mergeLatestThreadContent() {
    if (!thread || !editThreadBase) return;
    if (editThreadConflict && thread.revision === editThreadBase.revision) {
      setModalError("尚未載入最新話題內容，請先重新整理後再試。");
      return;
    }
    const recovery = topicConflictRecovery(editThreadBase, editThreadDraft, thread);
    if (recovery.kind === "conflict") {
      setModalError(`本機草稿與最新話題修改了相同欄位：${recovery.fields.join("、")}。請調整草稿或重新載入最新內容。`);
      return;
    }
    setEditThreadCategoryId(recovery.draft.categoryId);
    setEditThreadTitle(recovery.draft.title);
    setEditThreadSummary(recovery.draft.summary);
    setEditThreadTagIds([...recovery.draft.tagIds]);
    setEditThreadStatus(recovery.draft.status);
    setEditThreadRevision(thread.revision);
    setEditThreadBase(topicDraftBaseFromThread(thread));
    setEditThreadConflict(false);
    setModalError("");
  }

  async function openMeetingCreator() {
    if (!thread || !snapshot || thread.status !== "open") return;
    const initialDraft = createInitialMeetingCreatorDraft(thread.title, thread.summary ?? "");
    setMeetingTitle(initialDraft.title);
    setMeetingGoal(initialDraft.goal);
    setMeetingParticipantIds([...initialDraft.participantIds]);
    setMeetingChairAgentId(initialDraft.chairAgentId);
    setMeetingRoleIdByAgent({ ...initialDraft.roleIdByAgent });
    setMeetingAgendaDraft(initialDraft.agendaItems.map((item) => ({ ...item })));
    setMeetingAutomation(initialDraft.automation);
    setMeetingMode(initialDraft.mode);
    setMeetingDurationMinutes(initialDraft.durationMinutes);
    setMeetingTeamId(initialDraft.teamId);
    setMeetingPresetId(initialDraft.presetId);
    setMeetingWarningsConfirmed(initialDraft.warningsConfirmed);
    setMeetingCreatorDraftBase(initialDraft);
    cancelMeetingPresetPreflight();
    openModal(setMeetingModal);
    const readinessByAgentId = await refreshPublishedMeetingReadiness(
      snapshot.agents.map((agent) => agent.id),
      true
    );
    if (!readinessByAgentId) return;
    const sourceVerifiedAgents = meetingAgentAvailability(snapshot, readinessByAgentId)
      .filter((item) => item.available)
      .map((item) => item.agent);
    const defaultChairId = preferredMeetingChairAgentId(snapshot, sourceVerifiedAgents.map((agent) => agent.id));
    const participantIds = sourceVerifiedAgents
      .filter((agent, index) => index < 3 || agent.id === defaultChairId)
      .map((agent) => agent.id);
    const selection = normalizeMeetingParticipantSelection(participantIds, defaultChairId ?? null);
    const roleIdByAgent = initialMeetingRoleSelection(selection.participantIds, snapshot.roles, selection.chairAgentId);
    setMeetingParticipantIds(selection.participantIds);
    setMeetingChairAgentId(selection.chairAgentId);
    setMeetingRoleIdByAgent(roleIdByAgent);
    setMeetingCreatorDraftBase((current) => current ? {
      ...current,
      participantIds: [...selection.participantIds],
      chairAgentId: selection.chairAgentId,
      roleIdByAgent: { ...roleIdByAgent }
    } : null);
  }

  function cancelMeetingPresetPreflight() {
    meetingPresetPreflightRequestId.current += 1;
    setMeetingPresetPreflight(null);
    setMeetingPresetPreflightLoading(false);
  }

  function cancelMeetingPresetForManualEdit() {
    if (!meetingPresetPreflightLoading) return;
    setMeetingPresetId("");
    cancelMeetingPresetPreflight();
  }

  function closeMeetingCreator() {
    if (busy) return;
    cancelMeetingPresetPreflight();
    setMeetingCreatorDraftBase(null);
    setModalError("");
    setMeetingModal(false);
  }

  function requestCloseMeetingCreator() {
    if (busy) return;
    if (meetingCreatorDraftDirty && !window.confirm("關閉會捨棄尚未儲存的會議草稿，確定繼續？")) return;
    closeMeetingCreator();
  }

  function selectMeetingTeam(
    teamId: string,
    preservePreset = false,
    readinessByAgentId = meetingAgentReadinessById
  ): boolean {
    if (!preservePreset) setMeetingPresetId("");
    if (!preservePreset) cancelMeetingPresetPreflight();
    if (!teamId || !snapshot) {
      setMeetingTeamId(teamId);
      return true;
    }
    const teamSelectionAttempt = attemptMeetingTeamSelection(
      {
        teamId: meetingTeamId,
        participantIds: meetingParticipantIds,
        chairAgentId: meetingChairAgentId,
        roleIdByAgent: meetingRoleIdByAgent
      },
      teamId,
      (requestedTeamId) => {
        const applied = applyAgentTeam(snapshot, requestedTeamId);
        const preflight = meetingParticipantPreflight(snapshot, applied.participantIds, readinessByAgentId);
        if (preflight.status === "checking") throw new Error("Agent Team readiness 尚未完成。");
        if (preflight.status === "blocked") throw new Error(preflight.reason ?? "Agent Team 有不可用 Agent。");
        return applied;
      }
    );
    setMeetingTeamId(teamSelectionAttempt.selection.teamId);
    setMeetingParticipantIds(teamSelectionAttempt.selection.participantIds);
    setMeetingRoleIdByAgent(teamSelectionAttempt.selection.roleIdByAgent);
    setMeetingChairAgentId(teamSelectionAttempt.selection.chairAgentId);
    if (!teamSelectionAttempt.accepted) {
      setModalError(errorMessage(teamSelectionAttempt.cause, "無法套用 Agent Team。"));
      return false;
    }
    setMeetingWarningsConfirmed(false);
    setModalError("");
    return true;
  }

  async function selectMeetingPreset(presetId: string) {
    const requestId = ++meetingPresetPreflightRequestId.current;
    const previousPresetId = meetingPresetId;
    const previousPresetPreflight = meetingPresetPreflight;
    setMeetingPresetId(presetId);
    setMeetingPresetPreflight(null);
    if (!presetId || !snapshot) {
      setMeetingPresetPreflightLoading(false);
      return;
    }
    setMeetingPresetPreflightLoading(true);
    try {
      const applied = applyMeetingPreset(snapshot, presetId);
      const preflight = await managementApi.getMeetingPresetPreflight(presetId);
      if (requestId !== meetingPresetPreflightRequestId.current) return;
      setMeetingPresetPreflight(preflight);
      const nextReadinessByAgentId = {
        ...meetingAgentReadinessById,
        ...Object.fromEntries(preflight.agents.map((item) => [item.agentId, item.readiness]))
      };
      setMeetingAgentReadinessById(nextReadinessByAgentId);
      if (preflight.status === "blocked") {
        throw new Error(meetingPresetBlockingReason(preflight, snapshot.agents) ?? "會議範本 preflight 未通過。");
      }
      if (!selectMeetingTeam(applied.teamId ?? "", true, nextReadinessByAgentId)) {
        setMeetingPresetId(previousPresetId);
        setMeetingPresetPreflight(previousPresetPreflight);
        return;
      }
      setMeetingMode(applied.mode);
      setMeetingAutomation(applied.automation);
      setMeetingDurationMinutes(applied.durationMinutes);
      setMeetingAgendaDraft(applied.agendaItems.map((item) => ({ ...item })));
      setMeetingWarningsConfirmed(false);
      setModalError("");
    } catch (cause) {
      if (requestId !== meetingPresetPreflightRequestId.current) return;
      setMeetingPresetId(previousPresetId);
      setMeetingPresetPreflight(previousPresetPreflight);
      setModalError(errorMessage(cause, "無法套用會議範本。"));
    } finally {
      if (requestId === meetingPresetPreflightRequestId.current) setMeetingPresetPreflightLoading(false);
    }
  }

  function openAgendaModal() {
    if (!meeting) return;
    setAgendaDraft(agendaDraftFromAgenda(meeting.agenda));
    setAgendaDraftRevision(meeting.agenda.revision);
    setAgendaDraftBase(cloneMeetingAgenda(meeting.agenda));
    setAgendaConflict(false);
    setModalError("");
    setAgendaModal(true);
  }

  function closeAgendaModal() {
    if (busy) return;
    if (agendaDraftDirty && !window.confirm("關閉會捨棄尚未儲存的議程變更，確定繼續？")) return;
    setAgendaModal(false);
    setAgendaDraftRevision(null);
    setAgendaDraftBase(null);
    setAgendaConflict(false);
    setModalError("");
  }

  function reloadLatestAgendaContent() {
    if (!meeting) return;
    if (agendaDraftDirty && !window.confirm("重新載入會捨棄這份本機議程草稿，確定繼續？")) return;
    setAgendaDraft(agendaDraftFromAgenda(meeting.agenda));
    setAgendaDraftRevision(meeting.agenda.revision);
    setAgendaDraftBase(cloneMeetingAgenda(meeting.agenda));
    setAgendaConflict(false);
    setModalError("");
  }

  function mergeLatestAgendaContent() {
    if (!meeting || !agendaDraftBase) return;
    if (agendaConflict && meeting.agenda.revision === agendaDraftBase.revision) {
      setModalError("尚未載入最新議程內容，請先重新整理後再試。");
      return;
    }
    const recovery = agendaConflictRecovery(agendaDraftBase, agendaDraft, meeting.agenda);
    if (recovery.kind === "conflict") {
      setAgendaConflict(true);
      setModalError(`本機草稿與最新議程內容衝突：${recovery.conflicts.join("、")}。請調整草稿或重新載入最新內容。`);
      return;
    }
    setAgendaDraft(recovery.draft);
    setAgendaDraftRevision(meeting.agenda.revision);
    setAgendaDraftBase(cloneMeetingAgenda(meeting.agenda));
    setAgendaConflict(false);
    setModalError("");
  }

  function setMeetingParticipantSelected(agentId: string, selected: boolean) {
    setMeetingTeamId("");
    setMeetingPresetId("");
    cancelMeetingPresetPreflight();
    setMeetingWarningsConfirmed(false);
    const participantIds = selected
      ? [...meetingParticipantIds, agentId]
      : meetingParticipantIds.filter((id) => id !== agentId);
    const selection = normalizeMeetingParticipantSelection(participantIds, meetingChairAgentId);
    setMeetingParticipantIds(selection.participantIds);
    setMeetingChairAgentId(selection.chairAgentId);
    setMeetingRoleIdByAgent((current) => reconcileMeetingRoleSelection(
      selection.participantIds,
      selection.chairAgentId,
      current,
      availableRoles
    ));
  }

  function updateDiscoveryQuery(value: string) {
    setDiscoveryQuery(value);
  }

  function updateDiscoveryStatus(value: ThreadStatusFilter) {
    setDiscoveryStatus(value);
  }

  function updateDiscoveryTagId(tagId: string) {
    setDiscoveryTagId(tagId);
  }

  function toggleEditThreadTag(tagId: string, selected: boolean) {
    setEditThreadTagIds((current) => selected ? [...new Set([...current, tagId])] : current.filter((item) => item !== tagId));
  }

  async function submitThreadUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || !snapshot || editThreadRevision === null) return;
    if (editThreadConflict) {
      setModalError("話題已更新，請先合併或重新載入最新內容。");
      return;
    }
    const nextStatus = editThreadStatus;

    if ((nextStatus === "resolved" || nextStatus === "archived") && !canFinalizeThread(snapshot, thread, nextStatus)) {
      setModalError("目前有未關閉會議，請先結束會議後再改為已結案或已封存。");
      return;
    }

    setModalError("");
    setBusy(true);
    try {
      await mutate(`/api/threads/${thread.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: editThreadRevision,
          categoryId: editThreadCategoryId,
          title: editThreadTitle,
          summary: editThreadSummary,
          tagIds: editThreadTagIds,
          status: nextStatus
        })
      });
      setEditThreadModal(false);
      setEditThreadBase(null);
      setEditThreadConflict(false);
    } catch (cause) {
      if (isRevisionConflictError(cause)) {
        setEditThreadConflict(true);
        setModalError("話題已由其他操作更新，本機草稿仍保留。請合併或重新載入最新內容。");
        await refresh();
      } else {
        setModalError(errorMessage(cause, "無法更新話題。"));
        if (isConflictError(cause)) await refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestPayload = {
      categoryId: threadDraft.categoryId,
      title: threadDraft.title.trim(),
      summary: threadDraft.summary,
      tagIds: threadDraft.tagIds
    };
    const retry = threadRetryRegistryRef.current.acquire(
      JSON.stringify(requestPayload),
      () => crypto.randomUUID()
    );
    setModalError("");
    setBusy(true);
    try {
      const createdOutcome = await resolveCommittedMutation(() =>
        mutate<{ id: string }>("/api/threads", {
          method: "POST",
          headers: { "idempotency-key": retry.idempotencyKey },
          body: JSON.stringify(requestPayload)
        })
      );
      const created = createdOutcome.result;
      threadRetryRegistryRef.current.settle(retry);
      selectThread(created.id);
      setThreadDraft(emptyThreadCreateDraft);
      setThreadModal(false);
      if (!createdOutcome.projectionFresh) {
        setNotice("話題已建立，但最新列表刷新失敗；請重新整理以載入最新資料。");
        setNoticeTone("warning");
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) {
        threadRetryRegistryRef.current.settle(retry);
      }
      setModalError(errorMessage(cause, "無法建立討論。"));
    } finally {
      setBusy(false);
    }
  }

  async function submitMeeting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || !snapshot) return;
    const data = new FormData(event.currentTarget);
    const participantIds = [...new Set(meetingParticipantIds)];
    const selected = snapshot.agents.filter((agent) => participantIds.includes(agent.id));
    const participants = selected.map((agent) => ({
      agentId: agent.id,
      roleId: meetingRoleIdByAgent[agent.id] ?? "",
      isChair: meetingChairAgentId === agent.id
    }));
    if (participants.length === 0 || participants.length !== participantIds.length) {
      setModalError("至少選擇一位可用的已發布 Agent。");
      return;
    }
    if (!meetingSelectionValid || !participants.some((participant) => participant.isChair)) {
      setModalError("請為每位參與者選擇角色，並指定一位主席 Agent。");
      return;
    }
    if (!canSubmitAgendaDraft(meetingAgendaDraft)) {
      setModalError("議程需要一至十二個不重複的有效標題。");
      return;
    }
    if (meetingReadinessChecking) {
      setModalError("Agent readiness preflight 尚未完成。");
      return;
    }
    if (meetingPreflightBlocked) {
      setModalError(meetingBlockingReason ?? "Agent readiness preflight 未通過。");
      return;
    }
    if (meetingHasWarnings && !meetingWarningsConfirmed) {
      setModalError("請確認 warning Agent 仍可參加本場會議。");
      return;
    }
    const creationRequestToken = meetingCreationRequestGateRef.current.begin();
    activeMeetingCreationRequestTokenRef.current = creationRequestToken;
    let retry: { signature: string; idempotencyKey: string } | null = null;
    setModalError("");
    setBusy(true);
    try {
      const [readinessByAgentId, refreshedPresetPreflight] = await Promise.all([
        refreshPublishedMeetingReadiness(participantIds, false),
        meetingPresetId ? managementApi.getMeetingPresetPreflight(meetingPresetId) : Promise.resolve(null)
      ]);
      if (!readinessByAgentId) throw new Error("無法確認已發布 Agent readiness，請稍後重試。");
      const refreshedParticipantPreflight = meetingParticipantPreflight(snapshot, participantIds, readinessByAgentId);
      if (refreshedPresetPreflight) setMeetingPresetPreflight(refreshedPresetPreflight);
      if (refreshedParticipantPreflight.status === "blocked") {
        throw new Error(refreshedParticipantPreflight.reason ?? "Agent readiness preflight 未通過。");
      }
      if (refreshedParticipantPreflight.status === "checking") {
        throw new Error("Agent readiness preflight 尚未完成。");
      }
      if (refreshedPresetPreflight?.status === "blocked") {
        throw new Error(meetingPresetBlockingReason(refreshedPresetPreflight, snapshot.agents) ?? "會議範本 preflight 未通過。");
      }
      const refreshedHasWarnings = refreshedParticipantPreflight.status === "warning"
        || refreshedPresetPreflight?.status === "warning";
      if (refreshedHasWarnings && !meetingWarningsConfirmed) {
        throw new Error("請確認 warning Agent 仍可參加本場會議。");
      }
      const requestPayload = {
        threadId: thread.id,
        title: data.get("title"),
        goal: data.get("goal"),
        mode: meetingMode,
        automation: meetingAutomation,
        durationMinutes: meetingDurationMinutes,
        ...(meetingTeamId ? { sourceTeamId: meetingTeamId } : {}),
        ...(meetingPresetId ? { sourcePresetId: meetingPresetId } : {}),
        participants,
        agendaItems: meetingAgendaDraft.map(({ title, description }) => ({ title, description }))
      };
      const requestRetry = meetingCreationRetryRegistryRef.current.acquire(
        JSON.stringify(requestPayload),
        () => crypto.randomUUID()
      );
      retry = requestRetry;
      const createdOutcome = await resolveCommittedMutation(() =>
        mutate<Meeting>("/api/meetings", {
          method: "POST",
          headers: { "idempotency-key": requestRetry.idempotencyKey },
          body: JSON.stringify(requestPayload)
        })
      );
      const created = createdOutcome.result;
      meetingCreationRetryRegistryRef.current.settle(requestRetry);
      let selectionNotice: NonNullable<typeof meetingSelectionNoticeRef.current>;
      try {
        const startOutcome = await resolveCommittedMutation(() =>
          mutate(`/api/meetings/${created.id}/start`, { method: "POST" })
        );
        selectionNotice = startOutcome.projectionFresh
          ? { meetingId: created.id, message: "會議已開始。", tone: "success" }
          : {
              meetingId: created.id,
              message: "會議已開始，但最新列表刷新失敗；請重新整理以載入最新資料。",
              tone: "warning"
            };
      } catch (cause) {
        selectionNotice = {
          meetingId: created.id,
          message: errorMessage(cause, "會議已建立但尚未開始，請按開始會議。"),
          tone: "warning"
        };
      }
      meetingSelectionNoticeRef.current = selectionNotice;
      setMeetingId(created.id);
      setMeetingCreatorDraftBase(null);
      setMeetingModal(false);
      setNotice(selectionNotice.message);
      setNoticeTone(selectionNotice.tone);
    } catch (cause) {
      if (retry && cause instanceof ApiError && cause.status < 500) {
        meetingCreationRetryRegistryRef.current.settle(retry);
      }
      setModalError(errorMessage(cause, "無法建立會議。"));
    } finally {
      if (meetingCreationRequestGateRef.current.isCurrent(creationRequestToken)) {
        activeMeetingCreationRequestTokenRef.current = null;
        setBusy(false);
      }
    }
  }

  async function saveAgenda() {
    if (!meeting || meeting.state === "closed" || !canSubmitAgendaDraft(agendaDraft)) {
      if (!canSubmitAgendaDraft(agendaDraft)) setModalError("議程需要一至十二個不重複的有效標題。");
      return;
    }
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    const expectedRevision = agendaDraftRevision;
    if (!agendaDraftRevisionMatches(expectedRevision, meeting.agenda)) {
      setAgendaConflict(true);
      setModalError("議程已由其他操作更新，本機草稿仍保留。請合併或重新載入最新內容。");
      return;
    }
    setModalError("");
    setBusy(true);
    try {
      const updated = await mutate<Meeting>(`/api/meetings/${meeting.id}/agenda`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision,
          items: agendaDraft.map(({ id, title, description }) => ({ ...(id ? { id } : {}), title, description }))
        })
      });
      if (!requestIsCurrent()) return;
      setAgendaDraft(agendaDraftFromAgenda(updated.agenda));
      setAgendaDraftRevision(updated.agenda.revision);
      setAgendaDraftBase(cloneMeetingAgenda(updated.agenda));
      setAgendaConflict(false);
      setNotice("議程已儲存。");
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      if (isRevisionConflictError(cause)) {
        setAgendaConflict(true);
        setModalError("議程已由其他操作更新，本機草稿仍保留。請合併或重新載入最新內容。");
        await refreshMeeting(meeting.id);
      } else {
        setModalError(errorMessage(cause, "無法儲存議程。"));
        if (isConflictError(cause)) await refreshMeeting(meeting.id);
      }
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function advanceAgenda(action: "activate" | "complete" | "skip", itemId?: string) {
    if (!meeting || meeting.state !== "active" || (action !== "activate" && !itemId)) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setModalError("");
    setBusy(true);
    try {
      const updated = await mutate<Meeting>(`/api/meetings/${meeting.id}/agenda/advance`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: meeting.agenda.revision, action, ...(itemId ? { itemId } : {}) })
      });
      if (!requestIsCurrent()) return;
      setAgendaDraft(agendaDraftFromAgenda(updated.agenda));
      setAgendaDraftRevision(updated.agenda.revision);
      setAgendaDraftBase(cloneMeetingAgenda(updated.agenda));
      setAgendaConflict(false);
      setNotice(action === "skip" ? "目前議程已略過。" : action === "complete" ? "議程已完成並進入下一項。" : "議程已開始。");
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      const message = errorMessage(cause, "無法推進議程。");
      setModalError(message);
      setNotice(message);
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!meeting) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    const requestPayload = {
      meetingId: meeting.id,
      title: decisionDraft.title.trim(),
      description: decisionDraft.description.trim()
    };
    const retry = decisionRetryOwnershipRef.current.acquire(
      meeting.id,
      JSON.stringify(requestPayload),
      () => crypto.randomUUID()
    );
    setModalError("");
    setBusy(true);
    try {
      await mutate("/api/decisions", {
        method: "POST",
        headers: { "idempotency-key": retry.idempotencyKey },
        body: JSON.stringify(requestPayload)
      });
      decisionRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      closeDecisionCreator();
      setNotice("決議已提出，等待核准。");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) decisionRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      setModalError(errorMessage(cause, "無法提出決議。"));
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    if (!meeting || !message.trim()) return;
    const draft = message.trim();
    const meetingId = meeting.id;
    const retry = messageRetryOwnershipRef.current.acquire(
      meetingId,
      JSON.stringify({ content: draft }),
      () => crypto.randomUUID()
    );
    const draftRequest = messageDraftOwnershipRef.current.beginSend(meetingId);
    const requestIsCurrent = captureMeetingRequest(meetingId);
    setMessageDrafts((current) => updateMeetingMessageDraft(current, meetingId, ""));
    setBusy(true);
    setNotice("");
    setNoticeTone("success");
    try {
      const sentOutcome = await resolveCommittedMutation(() =>
        mutate(`/api/meetings/${meetingId}/utterances`, {
          method: "POST",
          headers: { "idempotency-key": retry.idempotencyKey },
          body: JSON.stringify({ content: draft })
        })
      );
      messageRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      if (!sentOutcome.projectionFresh) {
        setNotice("發言已送出，但最新列表刷新失敗；請重新整理以載入最新內容。");
        setNoticeTone("warning");
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) messageRetryOwnershipRef.current.clear(retry);
      setMessageDrafts((current) => messageDraftOwnershipRef.current.restoreAfterFailure(current, draftRequest, draft));
      if (!requestIsCurrent() || !messageDraftOwnershipRef.current.owns(draftRequest)) return;
      setNotice(cause instanceof Error ? cause.message : "發言失敗。");
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent() && messageDraftOwnershipRef.current.owns(draftRequest)) setBusy(false);
    }
  }

  async function changeMode(mode: MeetingMode) {
    if (!meeting || meeting.state === "closed" || meeting.mode === mode) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setBusy(true);
    try {
      await mutate(`/api/meetings/${meeting.id}/mode`, { method: "POST", body: JSON.stringify({ mode, reason: "擁有者手動切換" }) });
      if (!requestIsCurrent()) return;
      setNotice(`已切換為${modeLabels[mode]}。`);
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法切換會議模式。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function changeAutomation(automation: ChairAutomationLevel) {
    if (!meeting) return;
    const requestPending = pendingAction !== null || chairSuggestion?.status === "pending";
    if (busy || !canChangeChairAutomation({ meetingState: meeting.state, from: meeting.automation, to: automation, requestPending, queueActive: meetingQueue.length > 0 })) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setBusy(true);
    try {
      await mutate(`/api/meetings/${meeting.id}/automation`, {
        method: "PATCH",
        body: JSON.stringify({
          automation,
          expectedAutomation: meeting.automation,
          expectedAutomationRevision: meeting.automationRevision ?? 0
        })
      });
      if (!requestIsCurrent()) return;
      setNotice(`主席協助已切換為${chairAutomationLabel[automation]}。`);
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法切換主席協助。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function approveChairSuggestionMode() {
    if (!meeting || !chairSuggestion || meeting.mode === chairSuggestion.suggestedMode) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    const suggestion = chairSuggestion;
    setBusy(true);
    try {
      await mutate(`/api/meetings/${meeting.id}/mode`, {
        method: "POST",
        body: JSON.stringify({
          mode: suggestion.suggestedMode,
          reason: `擁有者核准主席建議：${meeting.mode} -> ${suggestion.suggestedMode}；${suggestion.explanation}`,
          chairSuggestionId: suggestion.id
        })
      });
      if (!requestIsCurrent()) return;
      setNotice(`已核准切換為${modeLabels[suggestion.suggestedMode]}。`);
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法核准主席建議。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function requestSuggestedChairIntervention() {
    if (!chairSuggestion?.suggestedAgentId) return;
    await runAgent(chairSuggestion.suggestedAgentId, chairSuggestion.id);
  }

  async function approveChairSuggestedRole() {
    if (!meeting
      || !chairSuggestion?.suggestedParticipantId
      || !chairSuggestion.suggestedRoleId
      || chairSuggestion.suggestedParticipantRoleRevision === undefined
      || chairSuggestion.status !== "open") return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    const suggestion = chairSuggestion;
    setBusy(true);
    try {
      await mutate(`/api/meetings/${meeting.id}/chair-suggestions/${suggestion.id}/role`, {
        method: "POST",
        body: JSON.stringify({ expectedRoleRevision: suggestion.suggestedParticipantRoleRevision })
      });
      if (!requestIsCurrent()) return;
      setNotice(`${suggestion.suggestedParticipantAgentName ?? "Agent"} 已切換為 ${suggestion.suggestedRoleName ?? "建議角色"}。`);
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法套用主席角色建議，請重新整理後再試。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function dismissChairSuggestion() {
    if (!meeting || !chairSuggestion || chairSuggestion.status !== "open") return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setBusy(true);
    try {
      await mutate(`/api/meetings/${meeting.id}/chair-suggestions/${chairSuggestion.id}/dismiss`, { method: "POST" });
      if (!requestIsCurrent()) return;
      setNotice("已保留目前會議方向。");
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法處理主席建議。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function switchParticipantRole(input: { roleId: string; reason: string }) {
    if (!meeting || !roleSwitchParticipant) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    const agentName = snapshot?.agents.find((agent) => agent.id === roleSwitchParticipant.agentId)?.name ?? "Agent";
    if (meetingQueue.some((item) => item.participantId === roleSwitchParticipant.id) || pendingAction?.agentId === roleSwitchParticipant.agentId) {
      setRoleSwitchError("此 Agent 已有發言工作，完成後才能切換角色。");
      return;
    }
    setRoleSwitchBusy(true);
    setRoleSwitchError("");
    try {
      await mutate(`/api/meetings/${meeting.id}/participants/${roleSwitchParticipant.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({
          roleId: input.roleId,
          expectedRoleRevision: roleSwitchParticipant.roleRevision,
          reason: input.reason || "擁有者手動切換角色"
        })
      });
      if (!requestIsCurrent()) return;
      setRoleSwitchParticipantId(null);
      setNotice(`${agentName} 已切換角色。`);
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setRoleSwitchError(errorMessage(cause, "無法切換角色，請重新整理後再試。"));
    } finally {
      if (requestIsCurrent()) setRoleSwitchBusy(false);
    }
  }

  async function runAgent(agentId: string, chairSuggestionId?: string): Promise<boolean> {
    if (!meeting || meeting.state !== "active") return false;
    const participant = participants.find((item) => item.agentId === agentId);
    if (meetingQueue.length > 0 || pendingAction) {
      setNotice("已有 Agent 工作執行中，請等待目前工作完成。");
      setNoticeTone("warning");
      return false;
    }
    const meetingId = meeting.id;
    const requestPayload = { agentId, ...(chairSuggestionId ? { chairSuggestionId } : {}) };
    const retry = agentRunRetryOwnershipRef.current.acquire(
      meetingId,
      JSON.stringify(requestPayload),
      () => crypto.randomUUID()
    );
    const requestIsCurrent = captureMeetingRequest(meetingId);
    const agentName = snapshot?.agents.find((agent) => agent.id === agentId)?.name ?? "Agent";
    const provisional: PendingMeetingAction = {
      meetingId,
      jobId: null,
      kind: "agent",
      label: `${agentName} 發言`,
      agentId
    };
    setNotice("");
    setNoticeTone("success");
    updatePendingAction(provisional);
    try {
      const queuedOutcome = await resolveCommittedMutation(() => mutate<{ jobId: string }>(`/api/meetings/${meetingId}/run`, {
        method: "POST",
        headers: { "idempotency-key": retry.idempotencyKey },
        body: JSON.stringify(requestPayload)
      }));
      const queued = queuedOutcome.result;
      agentRunRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return false;
      updatePendingAction({ ...provisional, jobId: queued.jobId });
      setNotice(`${agentName} 正在準備發言…`);
      const buffered = bufferedEventsRef.current.get(queued.jobId);
      if (buffered) {
        bufferedEventsRef.current.delete(queued.jobId);
        handleMeetingEvent(buffered);
      }
      if (!queuedOutcome.projectionFresh) {
        setNotice(`${agentName} 已排入發言，但最新會議畫面刷新失敗；請先重試同步或重新整理。`);
        setNoticeTone("warning");
      }
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) agentRunRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return false;
      updatePendingAction(null);
      setNotice(errorMessage(cause, "無法排入 Agent 發言。"));
      setNoticeTone("error");
      return false;
    }
  }

  async function meetingAction(action: "start" | "pause" | "resume" | "close") {
    if (!meeting) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setBusy(true);
    try {
      await mutate(`/api/meetings/${meeting.id}/${action}`, { method: "POST" });
      if (!requestIsCurrent()) return;
      setNotice(action === "pause" ? "會議已暫停。" : action === "resume" ? "會議已繼續。" : action === "close" ? "會議已結束。" : "會議已開始。");
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法變更會議狀態。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function decisionAction(decision: Decision, action: "approve" | "reject") {
    const requestIsCurrent = captureMeetingRequest(decision.meetingId);
    setBusy(true);
    try {
      await mutate(`/api/decisions/${decision.id}/${action}`, { method: "POST" });
      if (!requestIsCurrent()) return;
      setNotice(action === "approve" ? "決議已核准。" : "決議已拒絕。");
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法更新決議。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  function openTaskCreator(decision: Decision) {
    setTaskDecision(decision);
    setTaskExecutionProfile("manual");
    setTaskDraft({ ...emptyTaskCreateDraft, title: decision.title, description: decision.description });
    setModalError("");
  }

  function closeTaskCreator() {
    setTaskDecision(null);
    setTaskExecutionProfile("manual");
    setTaskDraft(emptyTaskCreateDraft);
    setModalError("");
  }

  function requestCloseTaskCreator() {
    if (busy) return;
    if (taskCreateDraftDirty && !window.confirm("關閉會捨棄尚未儲存的任務草稿，確定繼續？")) return;
    closeTaskCreator();
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !taskDecision) return;
    const requestIsCurrent = captureMeetingRequest(taskDecision.meetingId);
    const title = taskDraft.title.trim();
    const description = taskDraft.description.trim();
    const assignee = taskDraft.assignee.trim();
    const assigneeAgentId = taskDraft.assigneeAgentId;
    const dueAtValue = taskDraft.dueAt.trim();
    const acceptanceCriteria = taskDraft.acceptanceCriteria.trim();
    const agentRequired = taskExecutionProfile !== "manual";

    if (agentRequired && !assigneeAgentId) {
      setModalError("請選擇負責此任務的 Agent。");
      return;
    }
    if (agentRequired && !snapshot.agents.some((agent) => agent.id === assigneeAgentId && isAgentRunnable(snapshot, agent.id))) {
      setModalError("指定 Agent 的模型目前不可用，請重新選擇。");
      return;
    }
    if (taskExecutionProfile === "worker" && !acceptanceCriteria) {
      setModalError("Agent 產出需要明確的驗收條件。");
      return;
    }

    let dueAt: string | null = null;
    if (dueAtValue) {
      const parsedDueAt = new Date(dueAtValue);
      if (Number.isNaN(parsedDueAt.getTime())) {
        setModalError("到期日格式不正確。");
        return;
      }
      dueAt = parsedDueAt.toISOString();
    }

    const requestPayload = {
      decisionId: taskDecision.id,
      title,
      description,
      assignee: taskExecutionProfile === "manual" ? assignee || null : null,
      assigneeAgentId: agentRequired ? assigneeAgentId : null,
      executionProfile: taskExecutionProfile,
      dueAt,
      acceptanceCriteria: taskExecutionProfile === "worker" ? acceptanceCriteria : ""
    };
    const retry = taskRetryOwnershipRef.current.acquire(
      taskDecision.meetingId,
      JSON.stringify(requestPayload),
      () => crypto.randomUUID()
    );
    setBusy(true);
    setModalError("");
    try {
      await mutate("/api/tasks", {
        method: "POST",
        headers: { "idempotency-key": retry.idempotencyKey },
        body: JSON.stringify(requestPayload)
      });
      taskRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      closeTaskCreator();
      setNotice("任務已建立。");
      setNoticeTone("success");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) taskRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      setModalError(errorMessage(cause, "無法建立任務。"));
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  function closeToolRunner() {
    setToolAgentId(null);
    setToolArgumentsDraft("{}");
    setModalError("");
  }

  function requestCloseToolRunner() {
    if (pendingAction) return;
    if (toolArgumentsDraftDirty && !window.confirm("關閉會捨棄尚未執行的工具參數草稿，確定繼續？")) return;
    closeToolRunner();
  }

  async function runTool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!meeting || !toolAgent) return;
    if (meetingQueue.length > 0 || pendingAction) {
      setModalError("已有 Agent 工作執行中，請等待目前工作完成。");
      return;
    }
    const data = new FormData(event.currentTarget);
    const tool = toolOptions[Number(data.get("toolIndex"))];
    if (!tool) {
      setModalError("找不到可用工具。");
      return;
    }
    let argumentsValue: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(data.get("arguments") ?? "{}")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具參數必須是 JSON object。");
      argumentsValue = parsed as Record<string, unknown>;
    } catch (cause) {
      setModalError(errorMessage(cause, "工具參數不是有效 JSON。"));
      return;
    }
    const meetingId = meeting.id;
    const requestIsCurrent = captureMeetingRequest(meetingId);
    const provisional: PendingMeetingAction = {
      meetingId,
      jobId: null,
      kind: "tool",
      label: `${tool.displayName} 工具`,
      agentId: toolAgent.id
    };
    updatePendingAction(provisional);
    setModalError("");
    const requestPayload = { agentId: toolAgent.id, connectorId: tool.connectorId, toolName: tool.toolName, arguments: argumentsValue };
    const retry = toolRetryOwnershipRef.current.acquire(
      meetingId,
      JSON.stringify(requestPayload),
      () => crypto.randomUUID()
    );
    try {
      const queuedOutcome = await resolveCommittedMutation(() => mutate<{ jobId: string; replayed?: boolean; status?: "succeeded" | "failed" }>(`/api/meetings/${meetingId}/tools/run`, {
        method: "POST",
        headers: { "idempotency-key": retry.idempotencyKey },
        body: JSON.stringify(requestPayload)
      }));
      const queued = queuedOutcome.result;
      toolRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      if (queued.replayed) {
        updatePendingAction(null);
        closeToolRunner();
        setNotice(queued.status === "failed" ? `${tool.displayName}先前執行失敗，會議已暫停。` : `${tool.displayName}已完成。`);
        setNoticeTone(queued.status === "failed" ? "error" : "success");
        return;
      }
      updatePendingAction({ ...provisional, jobId: queued.jobId });
      closeToolRunner();
      setNotice(`${tool.displayName} 正在執行。`);
      setNoticeTone("success");
      if (!queuedOutcome.projectionFresh) {
        setNotice(`${tool.displayName} 已接受執行，但最新會議畫面刷新失敗；請先重試同步或重新整理。`);
        setNoticeTone("warning");
      }
      const buffered = bufferedEventsRef.current.get(queued.jobId);
      if (buffered) {
        bufferedEventsRef.current.delete(queued.jobId);
        handleMeetingEvent(buffered);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) toolRetryOwnershipRef.current.clear(retry);
      if (!requestIsCurrent()) return;
      updatePendingAction(null);
      setModalError(errorMessage(cause, "無法執行工具。"));
    }
  }

  async function closeMeeting() {
    if (!meeting) return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setModalError("");
    setBusy(true);
    try {
      const closed = await mutate<Meeting>(`/api/meetings/${meeting.id}/close`, { method: "POST" });
      if (!requestIsCurrent()) return;
      setCloseModal(false);
      setNotice(closed.summaryState === "failed"
        ? "會議已結束；摘要尚未排入，可在場次列重試。"
        : "會議已結束，可以在同一討論開始新會議。");
      setNoticeTone(closed.summaryState === "failed" ? "warning" : "success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setModalError(errorMessage(cause, "無法結束會議。"));
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  async function retryMeetingSummary() {
    if (!meeting || meeting.state !== "closed") return;
    const requestIsCurrent = captureMeetingRequest(meeting.id);
    setBusy(true);
    try {
      const retried = await mutate<Meeting>(`/api/meetings/${meeting.id}/summary/retry`, { method: "POST" });
      if (!requestIsCurrent()) return;
      setNotice(retried.summaryState === "completed" ? "會議摘要已完成。" : "會議摘要已重新排入。");
      setNoticeTone("success");
    } catch (cause) {
      if (!requestIsCurrent()) return;
      setNotice(errorMessage(cause, "無法重試會議摘要。"));
      setNoticeTone("error");
    } finally {
      if (requestIsCurrent()) setBusy(false);
    }
  }

  const Root = embeddedMeetingId ? "div" : "main";
  return (
    <Root className={`discussion-layout ${embeddedMeetingId ? "embedded-meeting" : ""}`}>
      {!embeddedMeetingId && <button
        type="button"
        className="mobile-discussion-picker"
        ref={mobileTaxonomyDisclosureRef}
        aria-expanded={mobileTaxonomyOpen}
        aria-controls="discussion-taxonomy-panel"
        onClick={() => setMobileTaxonomyOpen((open) => !open)}
      >
        <FolderCog size={16} aria-hidden="true" />
        <span>{taxonomy ? `${taxonomy.groupName} / ${taxonomy.categoryName}` : "群組、分類與話題"}</span>
        <strong>{mobileTaxonomyOpen ? "收合" : "切換話題"}</strong>
      </button>}
      {!embeddedMeetingId && <div
        id="discussion-taxonomy-panel"
        className={`discussion-sidebar-shell ${mobileTaxonomyOpen ? "open" : ""}`}
        onClickCapture={(event) => {
          const targetIsTopic = event.target instanceof Element
            && Boolean(event.target.closest("button.thread-row"));
          restoreMobileTaxonomyFocusRef.current = shouldRestoreMobileTaxonomyFocus(
            mobileTaxonomyOpen,
            event.detail,
            targetIsTopic
          );
        }}
      >
        <DiscussionSidebar
          groups={snapshot.groups}
          categories={snapshot.categories}
          threads={filteredThreads}
          meetings={snapshot.meetings}
          totalThreadCount={snapshot.threads.length}
          tags={snapshot.tags}
          discoveryQuery={discoveryQuery}
          discoveryTagId={discoveryTagId}
          discoveryStatus={discoveryStatus}
          onDiscoveryQueryChange={updateDiscoveryQuery}
          onDiscoveryTagChange={updateDiscoveryTagId}
          onDiscoveryStatusChange={updateDiscoveryStatus}
          selectedThreadId={thread?.id ?? null}
          onCreateThread={openThreadCreator}
          onManageTaxonomy={openTaxonomyManager}
          onSelectThread={selectThread}
        />
      </div>}

      <section className="meeting-surface">
        {platformProjectionStale && <ProjectionFreshnessWarning message={projectionStatus} refreshing={platformProjectionRefreshing} onRetry={() => void refreshRequired().catch(() => undefined)} retryLabel="重新整理討論資料" />}
        {!embeddedMeetingId && routeState.fromGoalId && <SourceContextBar source={{ goalId: routeState.fromGoalId }} label="此正式會議由 Goal Run 召集" />}
        {embeddedMeetingId && !embeddedContextReady ? <Empty>正式會議資料同步中。</Empty> : !thread ? <Empty><div className="empty-state-content"><strong>尚無話題</strong><button className="primary-button" onClick={() => snapshot.categories.length > 0 ? openThreadCreator() : openTaxonomyManager()}>{snapshot.categories.length > 0 ? <MessageSquarePlus size={15} /> : <FolderCog size={15} />}{snapshot.categories.length > 0 ? "新增話題" : "整理分類"}</button></div></Empty> : <>
          <header className="meeting-header">
            <TopicContextHeader thread={thread} meeting={meeting} taxonomy={taxonomy} />
            <div className="meeting-actions">
              {!embeddedMeetingId && canCreateMeeting && <button className="primary-button" disabled={busy} onClick={() => void openMeetingCreator()}><MessageSquarePlus size={15} />{meeting ? "開始新會議" : "建立會議"}</button>}
              {!embeddedMeetingId && <button className="icon-button" disabled={busy} onClick={openThreadEditor} aria-label="編輯話題" title="編輯話題"><Pencil size={16} /></button>}
              {meeting?.state === "draft" && <button className="primary-button" disabled={busy} onClick={() => void meetingAction("start")}><CirclePlay size={15} />開始會議</button>}
              {meeting?.state === "active" && primaryAgent && <button className="primary-button" disabled={busy || meetingActionActive} aria-busy={pendingAgentId === primaryAgent.id || undefined} onClick={() => void runAgent(primaryAgent.id)}>{pendingAgentId === primaryAgent.id ? <LoaderCircle className="spin-icon" size={15} /> : <Play size={15} />}{pendingAgentId === primaryAgent.id ? `${primaryAgent.name} 發言中` : meeting.mode === "chaired" ? `${primaryAgent.name} 主持` : `${primaryAgent.name} 發言`}</button>}
              {meeting && <div className="meeting-record-actions">{chairHistory.length > 0 && <button className="icon-button" onClick={() => setChairHistoryModal(true)} aria-label="主席處理紀錄" title="主席處理紀錄"><History size={17} /></button>}<button className="icon-button evidence-button" onClick={() => setEvidenceModal(true)} aria-label={`會議證據，共 ${evidenceItems.length} 筆`} title="會議證據"><FileCheck2 size={17} /><span aria-hidden="true">{evidenceItems.length}</span></button></div>}
              {meeting?.state === "active" && <button className="icon-button" disabled={busy || pendingAction !== null} onClick={() => void meetingAction("pause")} aria-label="暫停會議" title="暫停會議"><CirclePause size={17} /></button>}
              {meeting?.state === "paused" && <button className="icon-button" disabled={busy} onClick={() => void meetingAction("resume")} aria-label="繼續會議" title="繼續會議"><CirclePlay size={17} /></button>}
              {(meeting?.state === "active" || meeting?.state === "paused") && <button className="icon-button" disabled={busy || pendingAction !== null} onClick={() => openModal(setCloseModal)} aria-label="結束會議" title="結束會議"><CircleStop size={17} /></button>}
            </div>
          </header>

          {meeting && <>
            {meeting.state === "closed" ? <div className="meeting-controls archived-meeting-controls">
              {meetingSessionPicker}
              <span className="status-chip closed"><Clock3 size={13} />已封存</span>
              {meeting.summaryState === "completed" && <span className="meeting-mode-state">摘要、決議與任務已整理</span>}
              {(meeting.summaryState === "pending" || meeting.summaryState === "queued") && <span className="status-chip summary-pending"><RefreshCw className="spin-icon" size={13} />摘要處理中</span>}
              {meeting.summaryState === "failed" && <><span className="status-chip summary-failed">摘要待重試</span><button type="button" className="summary-retry-button" disabled={busy} onClick={() => void retryMeetingSummary()} title="重新排入會議摘要"><RefreshCw size={14} />重試摘要</button></>}
            </div> : <div className="meeting-controls">
              {meetingSessionPicker}
              <div className="segmented" role="group" aria-label="會議模式">{(Object.keys(modeLabels) as MeetingMode[]).map((mode) => <button key={mode} type="button" aria-pressed={meeting.mode === mode} aria-label={`切換為${modeLabels[mode]}`} disabled={busy || pendingAction !== null} className={meeting.mode === mode ? "active" : ""} onClick={() => void changeMode(mode)}>{modeLabels[mode]}</button>)}</div>
              <label className="meeting-automation-picker" htmlFor="meeting-automation-select"><span>主席協助</span><select id="meeting-automation-select" aria-label="主席協助模式" value={chairAutomation} disabled={busy} onChange={(event) => void changeAutomation(event.currentTarget.value as ChairAutomationLevel)}>{chairAutomationOptions.map((option) => <option key={option.value} value={option.value} disabled={!canChangeChairAutomation({ meetingState: meeting.state, from: chairAutomation, to: option.value, requestPending: chairAutomationRequestPending, queueActive: meetingQueue.length > 0 }) && option.value !== chairAutomation}>{option.label}</option>)}</select></label>
              {liveCloudChairSelected && <span className="meeting-cloud-warning" role="note">自動主席會將本場內容送至雲端模型</span>}
              <span className="meeting-mode-state">{modeState}</span>
              <span className={`status-chip ${meeting.state}`}><Clock3 size={13} />{meeting.state === "active" ? `進行中 · 剩 ${remainingMinutes} 分` : meeting.state === "paused" ? `已暫停 · 剩 ${remainingMinutes} 分` : "尚未開始"}</span>
              {(meeting.summaryState === "pending" || meeting.summaryState === "queued") && <span className="status-chip summary-pending"><RefreshCw className="spin-icon" size={13} />摘要處理中</span>}
              {meeting.summaryState === "failed" && <><span className="status-chip summary-failed">摘要待重試</span><button type="button" className="summary-retry-button" disabled={busy} onClick={() => void retryMeetingSummary()} title="重新排入會議摘要"><RefreshCw size={14} />重試摘要</button></>}
            </div>}

            {meeting.state !== "closed" && <MeetingAgendaBand meeting={meeting} busy={busy} onOpen={openAgendaModal} onAdvance={(command) => void advanceAgenda(command.action, "itemId" in command ? command.itemId : undefined)} />}

            {!embeddedMeetingId && <div className="meeting-experience-tabs" role="tablist" aria-label="會議檢視">
              <button id="meeting-view-tab" type="button" role="tab" aria-selected={meetingExperienceTab === "meeting"} aria-controls="meeting-view-panel" className={meetingExperienceTab === "meeting" ? "active" : ""} onClick={() => selectMeetingExperience("meeting")}><MessagesSquare size={15} aria-hidden="true" />會議</button>
              <button id="activity-view-tab" type="button" role="tab" aria-selected={meetingExperienceTab === "activity"} aria-controls="activity-view-panel" className={meetingExperienceTab === "activity" ? "active" : ""} onClick={() => selectMeetingExperience("activity")}><History size={15} aria-hidden="true" />活動</button>
              <button id="canvas-view-tab" type="button" role="tab" aria-selected={meetingExperienceTab === "canvas"} aria-controls="canvas-view-panel" className={meetingExperienceTab === "canvas" ? "active" : ""} onClick={() => selectMeetingExperience("canvas")}><Network size={15} aria-hidden="true" />畫布</button>
            </div>}

            {!embeddedMeetingId && meetingExperienceTab === "activity" && <div id="activity-view-panel" role="tabpanel" aria-labelledby="activity-view-tab"><MeetingActivity items={activityItems} /></div>}
            {!embeddedMeetingId && meetingExperienceTab === "canvas" && canvasProjection && <div id="canvas-view-panel" role="tabpanel" aria-labelledby="canvas-view-tab">
              <div className="canvas-lens-selector" role="group" aria-label="畫布視角">{(["progress", "collaboration", "resources"] as CanvasLens[]).map((lens) => <button key={lens} type="button" className={canvasLens === lens ? "active" : ""} aria-pressed={canvasLens === lens} onClick={() => selectCanvasLens(lens)}>{lens === "progress" ? "進度" : lens === "collaboration" ? "協作" : "資源"}</button>)}</div>
              <MeetingCanvasLoader lens={canvasLens} projection={canvasProjection} onReturnToMeeting={() => selectMeetingExperience("meeting")} />
            </div>}

            {embeddedMeetingId && <span id="meeting-view-tab" className="sr-only">正式會議</span>}
            {(embeddedMeetingId || meetingExperienceTab === "meeting") && <div id="meeting-view-panel" role="tabpanel" aria-labelledby="meeting-view-tab">
            {meeting.state === "closed" ? <MeetingRecordView meeting={meeting} topicSummary={thread.summary} /> : <>
            <MeetingSpeakerQueue items={meetingQueue} eligibleSpeakers={eligibleSpeakers} agentNameById={agentNameById} />

            <div className="participant-strip">
              {participants.map((participant) => {
                const agent = snapshot.agents.find((item) => item.id === participant.agentId)!;
                const role = participant.roleSnapshot;
                const runnable = isAgentRunnable(snapshot, agent.id);
                const permitted = permittedAgentIds.includes(agent.id);
                const waitingForAnother = meeting.mode !== "open" && !permitted;
                const grants = roleAllowsExternalTools(role)
                  ? agent.toolGrants.filter((grant) => snapshot.mcpConnectors.some((connector) => connector.id === grant.connectorId && connector.enabled && connector.approvedTools.includes(grant.toolName) && connector.toolRegistrations.some((registration) => registration.toolName === grant.toolName)))
                  : [];
                const hasQueuedWork = queuedParticipantIds.has(participant.id);
                const agentDisabled = meeting.state !== "active" || !runnable || !permitted || meetingActionActive;
                const roleSwitchDisabled = meeting.state === "closed" || roleSwitchBusy || hasQueuedWork || pendingAction?.agentId === agent.id;
                const waitReason = meeting.mode === "fixed" ? "固定順序尚未輪到此 Agent" : participant.isChair ? "目前由受邀角色發言" : "等待主席邀請";
                const agentTitle = hasQueuedWork ? "此 Agent 已有工作" : meetingActionActive ? "已有 Agent 工作執行中" : !runnable ? "尚未設定可用模型" : waitingForAnother ? waitReason : pendingAgentId === agent.id ? `${agent.name} 正在發言` : participant.isChair && meeting.mode === "chaired" ? `請 ${agent.name} 主持` : `安排 ${agent.name} 發言`;
                const participantCommand = pendingAgentId === agent.id
                  ? <LoaderCircle className="spin-icon" size={13} />
                  : meeting.mode === "fixed"
                    ? permitted ? "下一位" : ""
                    : meeting.mode === "chaired"
                      ? permitted ? participant.isChair ? "主持" : "可回應" : ""
                      : "發言";
                const participantLabel = `${agentTitle}。角色 ${role.name} v${role.version}。${role.responsibility}`;
                const participantContent = <><span className="participant-avatar">{initials(agent.name)}</span><span><strong>{agent.name}</strong><small>{pendingAgentId === agent.id ? "發言中" : `${role.name} · v${role.version}${participant.isChair ? " · 主席" : ""}`}</small></span><span className="participant-command">{participantCommand}</span></>;
                return <div className="participant-actions" key={participant.id}>
                  {meeting.mode === "fixed"
                    ? <div className={`participant participant-static ${participant.isChair ? "chair" : ""} ${!runnable ? "unavailable" : ""} ${permitted ? "next" : ""}`} title={participantLabel} aria-label={participantLabel}>{participantContent}</div>
                    : <button className={`participant ${participant.isChair ? "chair" : ""} ${!runnable ? "unavailable" : ""}`} disabled={agentDisabled} aria-busy={pendingAgentId === agent.id || undefined} onClick={() => void runAgent(agent.id)} title={participantLabel} aria-label={participantLabel}>{participantContent}</button>}
                  <button className="participant-inspect" type="button" onClick={() => setInspectedAgentId(agent.id)} aria-label={`查看 ${agent.name} 的目標、工具與資料`} title="查看 Agent 摘要"><Info size={14} /></button>
                  <button className="participant-role" disabled={roleSwitchDisabled} onClick={() => { setRoleSwitchError(""); setRoleSwitchParticipantId(participant.id); }} aria-label={`切換 ${agent.name} 的角色`} title="切換角色"><UserRoundCog size={15} /></button>
                  {grants.length > 0 && <button className="participant-tool" disabled={meeting.state !== "active" || meetingActionActive} onClick={() => { setModalError(""); setSelectedToolIndex(0); setToolArgumentsDraft("{}"); setToolAgentId(agent.id); }} aria-label={`${agent.name} 的工具`} title={`${agent.name} 的工具`}><Wrench size={14} /><span>{grants.length}</span></button>}
                </div>;
              })}
              <span className="human-participant"><UserRoundCheck size={15} />Owner · 決策者</span>
            </div>

            <div className="fixed-flow-compact">
              <button type="button" className="flow-step done" onClick={() => focusFlowTarget("meeting-transcript")}><MessagesSquare size={14} />討論 <b>{messages.length}</b></button><ArrowRight size={14} aria-hidden="true" />
              <button type="button" className={`flow-step ${decisions.length ? "active" : ""}`} onClick={() => focusFlowTarget("meeting-decisions")}><Vote size={14} />決議 <b>{decisions.length}</b></button><ArrowRight size={14} aria-hidden="true" />
              {firstMeetingTask
                ? <button id="meeting-task-step" type="button" className="flow-step active" onClick={() => setInspectedTaskId(firstMeetingTask.id)}><Check size={14} />任務 <b>{meetingTasks.length}</b></button>
                : <Link id="meeting-task-step" className="flow-step" href={buildTaskWorkspaceHref({ source: inspectorSource })}><Check size={14} />任務 <b>0</b></Link>}
            </div>

            {chairSuggestion && shouldShowChairSuggestion(chairAutomation) && <div className="chair-review" aria-label="主席建議">
              <span className="chair-review-copy" aria-live="polite"><strong>主席建議</strong>{chairSuggestion.explanation}{chairSuggestion.suggestedParticipantId && chairSuggestion.suggestedRoleId && <small>{chairSuggestion.suggestedParticipantAgentName ?? "Agent"} 可切換為 {chairSuggestion.suggestedRoleName ?? "建議角色"} v{chairSuggestion.suggestedRoleVersion}</small>}</span>
              <div className="chair-review-actions">
                {chairAutomation === "auto"
                  ? <span className="status-chip chair-auto-status" role="status" aria-live="polite">{chairSuggestion.status === "pending" ? <LoaderCircle className="spin-icon" size={13} /> : <RefreshCw size={13} />}{chairAutomationSuggestionStatusLabel(chairSuggestion.status)}</span>
                  : chairSuggestion.status === "pending"
                  ? <button className="secondary-button small" disabled aria-busy="true"><LoaderCircle className="spin-icon" size={13} />{chairSuggestion.suggestedAgentName ?? "主席"} 介入中</button>
                  : meeting.mode !== chairSuggestion.suggestedMode
                  ? <button className="secondary-button small" disabled={busy || pendingAction !== null} onClick={() => void approveChairSuggestionMode()}>核准切換</button>
                  : chairSuggestion.suggestedAgentId && <button className="secondary-button small" disabled={!canRequestChairIntervention({ meetingState: meeting.state, busy, actionPending: pendingAction !== null })} onClick={() => void requestSuggestedChairIntervention()}>請 {chairSuggestion.suggestedAgentName ?? "主席"} 介入</button>}
                {chairSuggestion.status === "open" && chairSuggestion.suggestedParticipantId && chairSuggestion.suggestedRoleId && <button className="secondary-button small" disabled={busy || pendingAction !== null} onClick={() => void approveChairSuggestedRole()}><UserRoundCog size={14} />切為 {chairSuggestion.suggestedRoleName ?? "建議角色"}</button>}
                {chairSuggestion.status === "open" && <button className="secondary-button small" disabled={busy || pendingAction !== null} onClick={() => void dismissChairSuggestion()}>略過建議</button>}
              </div>
            </div>}
            {notice && <div className={`meeting-notice ${pendingAction ? "pending" : noticeTone}`} role={noticeTone === "error" ? "alert" : "status"}><span>{notice}</span><button aria-label="關閉提示" onClick={() => { setNotice(""); setNoticeTone("success"); }}><X size={13} /></button></div>}

            <div className="meeting-body">
              <section id="meeting-transcript" className="transcript" tabIndex={-1}>
                <div ref={transcriptRef} className="transcript-scroll" role="log" aria-label="會議逐字稿" aria-live="polite" aria-relevant="additions text" onScroll={handleTranscriptScroll}>
                  {messages.map((item) => <MeetingMessage key={item.id} item={item} />)}
                </div>
                {showLatestButton && <button type="button" className="jump-to-latest" onClick={() => scrollToLatest()}><ArrowDown size={14} />回到最新</button>}
                <form className="composer" onSubmit={sendMessage}><label className="sr-only" htmlFor="meeting-message">會議發言</label><input id="meeting-message" value={message} onChange={(event) => setMessageDrafts((current) => updateMeetingMessageDraft(current, meeting.id, event.target.value))} placeholder="發言，或點名某個角色…" maxLength={20000} disabled={meeting.state !== "active"} /><button className="send-button" disabled={busy || meeting.state !== "active" || !message.trim()} aria-label="送出發言"><Send size={16} /></button></form>
              </section>

              <DecisionPanel
                goal={meeting.goal}
                decisions={decisions}
                tasks={snapshot.tasks}
                busy={busy}
                onCreateDecision={openDecisionCreator}
                onDecisionAction={decisionAction}
                onCreateTask={openTaskCreator}
                onInspectTask={(task) => setInspectedTaskId(task.id)}
              />
            </div>
            </>}
            </div>}
          </>}
        </>}
      </section>

      <TaskContextInspector task={inspectedTask} assigneeName={inspectedTaskAssignee} source={inspectorSource} onClose={() => setInspectedTaskId(null)} />
      <AgentContextInspector
        agent={inspectedAgent}
        roleName={inspectedParticipant?.roleSnapshot.name ?? "未指派本場角色"}
        roleResponsibility={inspectedParticipant?.roleSnapshot.responsibility ?? ""}
        source={inspectorSource}
        onClose={() => setInspectedAgentId(null)}
      />

      <TaxonomyManagerModal open={taxonomyModal} onClose={() => setTaxonomyModal(false)} />

      <Modal title="新增討論話題" open={threadModal} onClose={requestCloseThreadCreator} closeDisabled={busy} busy={busy}><form className="form-stack" onSubmit={submitThread} aria-busy={busy} inert={busy ? true : undefined}>
        {modalError && <div className="form-error" role="alert">{modalError}</div>}
        {snapshot.categories.length === 0 && <div className="form-error">請先建立至少一個分類。</div>}
        <label>群組 / 分類<select name="categoryId" value={threadDraft.categoryId} onChange={(event) => setThreadDraft((current) => ({ ...current, categoryId: event.target.value }))} required>{snapshot.groups.map((group) => <optgroup key={group.id} label={group.name}>{snapshot.categories.filter((category) => category.groupId === group.id).map((category) => <option key={category.id} value={category.id}>{categoryBreadcrumb(snapshot, category.id) ?? category.name}</option>)}</optgroup>)}</select></label>
        <label>話題名稱<input name="title" value={threadDraft.title} onChange={(event) => setThreadDraft((current) => ({ ...current, title: event.target.value }))} required maxLength={160} /></label><label>摘要<textarea name="summary" value={threadDraft.summary} onChange={(event) => setThreadDraft((current) => ({ ...current, summary: event.target.value }))} rows={3} /></label>
        <fieldset><legend>標籤</legend><div className="check-grid">{snapshot.tags.map((tag) => <label key={tag.id} className="check-row"><input type="checkbox" name="tagIds" value={tag.id} checked={threadDraft.tagIds.includes(tag.id)} onChange={(event) => toggleThreadDraftTag(tag.id, event.target.checked)} /><span className={`tag-dot ${tag.color}`} aria-hidden="true" />{tag.name}</label>)}</div></fieldset>
        <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={requestCloseThreadCreator}>取消</button><button className="primary-button" disabled={busy || snapshot.categories.length === 0}>{busy ? "建立中" : "建立話題"}</button></div>
      </form></Modal>

      <Modal title="編輯討論話題" open={editThreadModal} onClose={requestCloseThreadEditor} closeDisabled={busy} busy={busy}><form className="form-stack" onSubmit={submitThreadUpdate} aria-busy={busy} inert={busy ? true : undefined}>
        {modalError && <div className="form-error" role="alert">{modalError}</div>}
        <label>群組 / 分類<select name="categoryId" value={editThreadCategoryId} onChange={(event) => setEditThreadCategoryId(event.target.value)} required>
          {snapshot.groups.map((group) => <optgroup key={group.id} label={group.name}>{snapshot.categories.filter((category) => category.groupId === group.id).map((category) => <option key={category.id} value={category.id}>{categoryBreadcrumb(snapshot, category.id) ?? category.name}</option>)}</optgroup>)}
        </select></label>
        <label>話題名稱<input name="title" value={editThreadTitle} onChange={(event) => setEditThreadTitle(event.target.value)} required maxLength={160} /></label>
        <label>摘要<textarea name="summary" value={editThreadSummary} onChange={(event) => setEditThreadSummary(event.target.value)} rows={3} /></label>
        <label>狀態<select name="status" value={editThreadStatus} onChange={(event) => setEditThreadStatus(event.target.value as ThreadStatus)}>
          <option value="open">{threadStatusLabel("open")}</option>
          <option value="resolved" disabled={threadHasOngoingMeeting && editThreadStatus !== "resolved"}>{threadStatusLabel("resolved")}</option>
          <option value="archived" disabled={threadHasOngoingMeeting && editThreadStatus !== "archived"}>{threadStatusLabel("archived")}</option>
        </select></label>
        {!canSetResolvedOrArchived && <p className="thread-close-warning">有未關閉會議，無法將話題改為已結案/已封存，請先結束會議。</p>}
        <fieldset><legend>標籤</legend><div className="check-grid">{snapshot.tags.map((tag) => <label key={tag.id} className="check-row"><input type="checkbox" name="tagIds" value={tag.id} checked={editThreadTagIds.includes(tag.id)} onChange={(event) => toggleEditThreadTag(tag.id, event.target.checked)} /><span className={`tag-dot ${tag.color}`} aria-hidden="true" />{tag.name}</label>)}</div></fieldset>
        <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={requestCloseThreadEditor}>取消</button>{editThreadConflict && <><button type="button" className="secondary-button" disabled={busy} onClick={reloadLatestThreadContent}>重新載入最新內容</button><button type="button" className="secondary-button" disabled={busy} onClick={mergeLatestThreadContent}>合併最新內容</button></>}<button className="primary-button" disabled={busy || editThreadConflict}>{busy ? "更新中" : "更新話題"}</button></div>
      </form></Modal>

      <Modal title="建立會議" open={meetingModal} onClose={requestCloseMeetingCreator} closeDisabled={busy} busy={busy}><form className="form-stack" onSubmit={submitMeeting} aria-busy={busy} inert={busy ? true : undefined}>
        {modalError && <div className="form-error" role="alert">{modalError}</div>}
        {!modalError && meetingAgentReadinessError && <div className="form-error" role="alert">{meetingAgentReadinessError}</div>}
        <div className="meeting-options-grid">
          <label>會議範本<select value={meetingPresetId} disabled={meetingAgentReadinessLoading || meetingPresetPreflightLoading} onChange={(event) => void selectMeetingPreset(event.currentTarget.value)}><option value="">不套用</option>{(snapshot.meetingPresets ?? []).filter((preset) => preset.status === "active").map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
          <label>Agent Team<select value={meetingTeamId} disabled={meetingAgentReadinessLoading} onChange={(event) => selectMeetingTeam(event.currentTarget.value)}><option value="">手動選擇</option>{(snapshot.agentTeams ?? []).filter((team) => team.status === "active").map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        </div>
        <label>名稱<input name="title" value={meetingTitle} onChange={(event) => setMeetingTitle(event.currentTarget.value)} required maxLength={160} /></label><label>目標<textarea name="goal" value={meetingGoal} onChange={(event) => setMeetingGoal(event.currentTarget.value)} required rows={3} maxLength={1000} /></label>
        <AgendaDraftEditor items={meetingAgendaDraft} onChange={(items) => { cancelMeetingPresetForManualEdit(); setMeetingAgendaDraft(items); }} />
        <div className="meeting-options-grid"><label>模式<select value={meetingMode} onChange={(event) => { cancelMeetingPresetForManualEdit(); setMeetingMode(event.currentTarget.value as MeetingMode); }}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>主席協助<select value={meetingAutomation} onChange={(event) => { cancelMeetingPresetForManualEdit(); setMeetingAutomation(event.currentTarget.value as ChairAutomationLevel); }}>{chairAutomationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>分鐘<input type="number" min="5" max="240" value={meetingDurationMinutes} onChange={(event) => { cancelMeetingPresetForManualEdit(); setMeetingDurationMinutes(Number(event.currentTarget.value)); }} /></label></div>
        {createCloudChairSelected && <p className="meeting-cloud-warning meeting-cloud-warning-form" role="note">自動主席會將本場內容送至雲端模型</p>}
        <fieldset><legend>參與者與角色</legend>{availableMeetingAgents.map((agent) => {
          const roleId = meetingRoleIdByAgent[agent.id] ?? "";
          const selected = meetingParticipantIds.includes(agent.id);
          return <div className="participant-config" key={agent.id}>
            <label className="participant-select"><input type="checkbox" name={`agent:${agent.id}`} checked={selected} onChange={(event) => setMeetingParticipantSelected(agent.id, event.target.checked)} aria-label={`選擇 ${agent.name} 參加會議`} /></label>
            <strong>{agent.name}</strong>
            <select name={`role:${agent.id}`} value={roleId} disabled={!selected} onChange={(event) => { setMeetingTeamId(""); setMeetingPresetId(""); cancelMeetingPresetPreflight(); setMeetingWarningsConfirmed(false); setMeetingRoleIdByAgent((current) => ({ ...current, [agent.id]: event.target.value })); }} aria-label={`${agent.name} 的會議角色`}><option value="" disabled>選擇角色</option>{snapshot.roles.map((role) => <option value={role.id} key={role.id}>{role.name} · v{role.version}</option>)}</select>
            <label className="participant-chair"><input type="radio" name="chair" value={agent.id} checked={meetingChairAgentId === agent.id} disabled={!selected} onChange={() => { setMeetingTeamId(""); setMeetingPresetId(""); cancelMeetingPresetPreflight(); setMeetingWarningsConfirmed(false); setMeetingChairAgentId(agent.id); }} aria-label={`指定 ${agent.name} 為主席`} />主席</label>
          </div>;
        })}{meetingAgentReadinessLoading && <div className="modal-copy">正在檢查已發布 Agent readiness。</div>}{!meetingAgentReadinessLoading && availableMeetingAgents.length === 0 && <div className="form-error">目前沒有 ready 或 warning 的已發布 Agent。</div>}{snapshot.roles.length === 0 && <div className="form-error">請先在設定建立至少一個角色。</div>}</fieldset>
        {!meetingAgentReadinessLoading && meetingAvailabilityBlockingReason && <div className="modal-copy" role="status">暫不可用 · {meetingAvailabilityBlockingReason}</div>}
        <div className="modal-copy" role="status">Preflight · {meetingParticipantIds.length} Agents · {meetingReadinessChecking ? "檢查中" : meetingPreflightBlocked ? `blocked · ${meetingBlockingReason ?? "Agent readiness 未通過。"}` : meetingHasWarnings ? "warning" : "全部 ready"}</div>
        {meetingHasWarnings && <label className="check-row"><input type="checkbox" checked={meetingWarningsConfirmed} onChange={(event) => setMeetingWarningsConfirmed(event.currentTarget.checked)} />確認 {[...new Set([...meetingWarningItems.map((item) => item.agent.name), ...presetWarningAgentNames])].join("、") || "此範本"} 以 warning 狀態參加</label>}
        <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={requestCloseMeetingCreator}>取消</button><button className="primary-button" disabled={busy || meetingReadinessChecking || meetingPreflightBlocked || !meetingSelectionValid || !canSubmitAgendaDraft(meetingAgendaDraft) || (meetingHasWarnings && !meetingWarningsConfirmed)}>{busy ? "建立中" : "開始會議"}</button></div>
      </form></Modal>

      {meeting && <Modal title="會議議程" open={agendaModal} onClose={closeAgendaModal} closeDisabled={busy} busy={busy}>
        <MeetingAgendaModalContent meeting={meeting} items={agendaDraft} busy={busy} recoveryRequired={agendaNeedsRecovery} error={agendaNeedsRecovery ? modalError || "議程已由其他操作更新，本機草稿仍保留。" : modalError} onChange={setAgendaDraft} onSave={() => void saveAgenda()} onSkip={(itemId) => { if (agendaDraftDirty) { setModalError("請先儲存或捨棄議程草稿，再推進議程。"); return; } void advanceAgenda("skip", itemId); }} />
        {agendaNeedsRecovery && <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={reloadLatestAgendaContent}>重新載入最新內容</button><button type="button" className="secondary-button" disabled={busy} onClick={mergeLatestAgendaContent}>合併最新內容</button></div>}
      </Modal>}

      <ParticipantRoleSwitchModal
        open={Boolean(roleSwitchParticipantId)}
        participant={roleSwitchParticipant}
        agentName={roleSwitchParticipant ? snapshot.agents.find((agent) => agent.id === roleSwitchParticipant.agentId)?.name ?? "Agent" : "Agent"}
        roles={snapshot.roles}
        busy={roleSwitchBusy}
        error={roleSwitchError}
        onClose={() => { if (!roleSwitchBusy) setRoleSwitchParticipantId(null); }}
        onSubmit={(input) => void switchParticipantRole(input)}
      />

      <Modal title="提出決議" open={decisionModal} onClose={requestCloseDecisionCreator} closeDisabled={busy} busy={busy}><form className="form-stack" onSubmit={submitDecision} aria-busy={busy} inert={busy ? true : undefined}>{modalError && <div className="form-error" role="alert">{modalError}</div>}<label>標題<input name="title" value={decisionDraft.title} onChange={(event) => setDecisionDraft((current) => ({ ...current, title: event.target.value }))} required /></label><label>內容<textarea name="description" value={decisionDraft.description} onChange={(event) => setDecisionDraft((current) => ({ ...current, description: event.target.value }))} rows={5} required /></label><div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={requestCloseDecisionCreator}>取消</button><button className="primary-button" disabled={busy}>{busy ? "提出中" : "提出"}</button></div></form></Modal>

      {taskDecision && <Modal title="從決議建立任務" open onClose={requestCloseTaskCreator} closeDisabled={busy} busy={busy} focusKey={taskDecision.id}><form key={taskDecision.id} className="form-stack" onSubmit={createTask} aria-busy={busy} inert={busy ? true : undefined}>
        {modalError && <div className="form-error" role="alert">{modalError}</div>}
        <label>任務名稱<input name="title" value={taskDraft.title} onChange={(event) => setTaskDraft((current) => ({ ...current, title: event.target.value }))} required maxLength={160} /></label>
        <label>工作說明<textarea name="description" value={taskDraft.description} onChange={(event) => setTaskDraft((current) => ({ ...current, description: event.target.value }))} rows={3} maxLength={4000} /></label>
        <fieldset className="validation-choice"><legend>執行方式</legend>{taskExecutionOptions.map((option) => <label key={option.value}><input type="radio" name="executionProfile" value={option.value} checked={taskExecutionProfile === option.value} onChange={() => { setTaskExecutionProfile(option.value); setModalError(""); }} disabled={busy} />{option.label}</label>)}</fieldset>
        <label hidden={taskExecutionProfile !== "manual"}>負責人 <span className="optional-label">選填</span><input name="assignee" value={taskDraft.assignee} onChange={(event) => setTaskDraft((current) => ({ ...current, assignee: event.target.value }))} maxLength={100} placeholder="姓名或團隊" disabled={taskExecutionProfile !== "manual"} /></label>
        <label hidden={taskExecutionProfile === "manual"}>負責 Agent<select name="assigneeAgentId" required={taskExecutionProfile !== "manual"} value={taskDraft.assigneeAgentId} onChange={(event) => setTaskDraft((current) => ({ ...current, assigneeAgentId: event.target.value }))} disabled={taskExecutionProfile === "manual"}><option value="" disabled>選擇 Agent</option>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
        {taskExecutionProfile !== "manual" && availableAgents.length === 0 && <div className="form-error" role="alert">目前沒有已設定可用模型的 Agent。</div>}
        <label>到期日 <span className="optional-label">選填</span><input name="dueAt" type="datetime-local" value={taskDraft.dueAt} onChange={(event) => setTaskDraft((current) => ({ ...current, dueAt: event.target.value }))} /></label>
        <label hidden={taskExecutionProfile !== "worker"}>驗收條件<textarea name="acceptanceCriteria" value={taskDraft.acceptanceCriteria} onChange={(event) => setTaskDraft((current) => ({ ...current, acceptanceCriteria: event.target.value }))} rows={3} required={taskExecutionProfile === "worker"} disabled={taskExecutionProfile !== "worker"} maxLength={4000} placeholder="描述可交付、可檢查的完成條件" /></label>
        <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={requestCloseTaskCreator}>取消</button><button className="primary-button" disabled={busy || (taskExecutionProfile !== "manual" && availableAgents.length === 0)}><Check size={14} />{busy ? "建立中" : "建立任務"}</button></div>
      </form></Modal>}

      <Modal title={toolAgent ? `${toolAgent.name} 的工具` : "執行工具"} open={toolAgent !== undefined} onClose={requestCloseToolRunner} closeDisabled={meetingActionActive} busy={meetingActionActive}><form className="form-stack" onSubmit={runTool} aria-busy={meetingActionActive} inert={meetingActionActive ? true : undefined}>
        {modalError && <div className="form-error" role="alert">{modalError}</div>}
        <label>工具<select name="toolIndex" value={selectedToolIndex} onChange={(event) => setSelectedToolIndex(Number(event.target.value))}>{toolOptions.map((tool, index) => <option value={index} key={`${tool.connectorId}:${tool.toolName}`}>{tool.connectorName} · {tool.displayName}</option>)}</select></label>
        {selectedTool && <dl className="tool-run-summary"><div><dt>來源</dt><dd>{toolRegistrationKindLabel(selectedTool.kind)} · {selectedTool.version}</dd></div><div><dt>目標</dt><dd>{selectedTool.goal}</dd></div></dl>}
        <label>JSON 參數<textarea name="arguments" rows={5} value={toolArgumentsDraft} onChange={(event) => setToolArgumentsDraft(event.currentTarget.value)} maxLength={20000} spellCheck={false} /></label>
        <div className="form-actions"><button type="button" className="secondary-button" disabled={pendingAction !== null} onClick={requestCloseToolRunner}>取消</button><button className="primary-button" disabled={toolOptions.length === 0 || meetingActionActive}><Wrench size={14} />{meetingActionActive ? "執行中" : "執行"}</button></div>
      </form></Modal>

      <Modal title="會議證據" open={evidenceModal} onClose={() => setEvidenceModal(false)}><div className="evidence-modal-body">
        {evidenceItems.length === 0 ? <div className="evidence-empty">本場會議尚無證據。</div> : <ul className="meeting-evidence-list">{evidenceItems.map((item) => {
          const output = item.source === "tool_run" && item.status === "verified" ? toolOutputView(item.excerpt) : null;
          const referenceIsUrl = item.reference?.startsWith("https://") || item.reference?.startsWith("http://");
          return <li className={`meeting-evidence-row ${item.status}`} key={item.id}><div className="evidence-row-heading"><div><span className={`evidence-state ${item.status}`}>{evidenceStatusLabels[item.status]}</span><strong>{item.title}</strong></div><time dateTime={item.createdAt}>{chairHistoryTime(item.createdAt)}</time></div><span className="evidence-source">{evidenceSourceLabels[item.source]} · {item.subtitle}</span>{item.tool && <dl className="evidence-tool-meta"><div><dt>來源</dt><dd>{item.tool.connectorName} · {toolRegistrationKindLabel(item.tool.kind)} · {item.tool.version}</dd></div><div><dt>負責人</dt><dd>{item.tool.owner}</dd></div><div><dt>目標</dt><dd>{item.tool.goal}</dd></div></dl>}{output ? <details className="evidence-output"><summary>{output.summary}</summary><pre>{output.details}</pre></details> : <p>{item.excerpt}</p>}{referenceIsUrl && <a href={item.reference} target="_blank" rel="noreferrer">開啟證據</a>}</li>;
        })}</ul>}
      </div></Modal>

      <Modal title="主席處理紀錄" open={chairHistoryModal} onClose={() => setChairHistoryModal(false)}><ol className="chair-history-list">
        {chairHistory.map((item) => <li key={item.id}>
          <div className="chair-history-heading"><strong>{chairReasonLabels[item.reason]}</strong><time dateTime={item.resolvedAt ?? item.createdAt}>{chairHistoryTime(item.resolvedAt ?? item.createdAt)}</time></div>
          <p>{item.explanation}</p>
          <div className="chair-history-result">{item.resolution ? chairResolutionLabels[item.resolution] : "待處理"} · {item.resolvedBy === "owner" ? "擁有者" : "系統"}</div>
          <ul className="chair-transition-list">{item.transitions.map((transition) => <li key={transition.id}><span>{chairTransitionLabels[transition.type]}</span><time dateTime={transition.at}>{chairHistoryTime(transition.at)}</time></li>)}</ul>
        </li>)}
      </ol></Modal>

      <Modal title="結束會議" open={closeModal} onClose={() => { if (!busy) setCloseModal(false); }}><div className="form-stack">
        {modalError && <div className="form-error" role="alert">{modalError}</div>}
        <p className="modal-copy">結束後保留逐字稿與決議，並可在同一討論開始下一場會議。</p>
        <div className="form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setCloseModal(false)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void closeMeeting()}><CircleStop size={14} />{busy ? "結束中" : "結束會議"}</button></div>
      </div></Modal>
    </Root>
  );
}
