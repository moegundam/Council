"use client";

import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Archive,
  Bot,
  CalendarCog,
  MessageSquarePlus,
  Pencil,
  Plus,
  Power,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Upload,
  Users
} from "lucide-react";
import type {
  Agent,
  AgentReadiness,
  AgentRevision,
  AgentTeam,
  MeetingPreset,
  RuntimeCapability,
  RuntimeHarnessKind,
  RuntimePolicy,
  RuntimeProfile,
  RuntimeProfileBinding,
  RuntimeProfileRevision,
  TaskExecutionProfile,
  TaskStatus
} from "@council/contracts";
import { CommittedMutationProjectionError, usePlatform } from "../app/providers";
import {
  ApiError,
  isRevisionConflictError,
  managementApi,
  type EffectiveAgentConfiguration,
  type MeetingPresetPreflight
} from "../lib/api";
import { LatestRequestGate } from "../lib/latest-request";
import { ompRuntimeUiEnabled } from "../lib/feature-flags";
import {
  agentEditableDraft,
  agentPromptBindingOptions,
  agentStatusTransition,
  approvedAgentToolOptions,
  canEditAgentManagementItem,
  mergeAgentDraftAfterConflict,
  parseAgentPromptBindingKey,
  serializeAgentPromptBinding,
  type AgentEditableDraft
} from "../lib/agent-form-ui";
import {
  filterAgentRoster,
  firstUnavailableTeamMemberId,
  readinessStatusUi,
  selectionAfterArchive
} from "../lib/management-ui";
import { agentRoleUsage, effectiveAgentTools } from "../lib/role-ui";
import {
  allowedRuntimeCapabilities,
  formatRuntimeCapabilitySummary,
  formatRuntimeTimeout,
  initialRuntimeBindingKey,
  normalizeRuntimeCapabilities,
  runtimeBindingOptions,
  runtimeHarnessLabel,
  runtimePolicyLabel
} from "../lib/runtime-profile-ui";
import {
  agentReadinessBlockingReason,
  idempotencyRetryToken,
  isSkillAssignable,
  loadPublishedAgentReadiness,
  normalizeSkill,
  toolRegistrationKindLabel,
  type SkillSnapshotEntry
} from "../lib/view-model";
import { buildMeetingWorkspaceHref, parseWorkspaceSourceContext } from "../lib/workspace-navigation";
import { agentSetupRows, effectiveModelConnectionIdentity, selectedSkillInstructionBudget, type AgentSetupAction } from "../lib/agent-setup-ui";
import { AgentCapabilitySummary } from "./agent-capability-summary";
import { AgentSetupPanel } from "./agent-setup-panel";
import type { SettingsTab } from "./settings-view";
import { ActionNotice, Modal, PageState } from "./ui";
import { SourceContextBar } from "./source-context-bar";
import { RuntimeProfileRegistry } from "./runtime-profile-registry";
import { ToolPackManagement } from "./tool-pack-management";

const SettingsView = dynamic(() => import("./settings-view").then((module) => module.SettingsView), {
  loading: () => <PageState loading error={null} />
});

function initials(value: string): string {
  return value
    .split(/[-\s]/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toLocaleUpperCase();
}

export function managementSaveError(cause: unknown, label: string, fallback: string): string {
  if (cause instanceof ApiError && cause.status === 409 && /revision is stale/i.test(cause.message)) {
    return `${label} 已由其他分頁更新，請重新載入後再編輯。`;
  }
  return cause instanceof Error ? cause.message : fallback;
}

export class AgentRevisionConflictRefreshError extends Error {
  constructor(
    readonly conflict: ApiError,
    readonly refreshCause: unknown
  ) {
    const detail = refreshCause instanceof Error ? refreshCause.message : "未知錯誤";
    super(`偵測到 Agent revision 衝突，且最新資料刷新失敗：${detail}`, { cause: refreshCause });
    this.name = "AgentRevisionConflictRefreshError";
  }
}

export async function runAgentRevisionMutation<T>(
  mutation: () => Promise<T>,
  refreshRequired: () => Promise<void>
): Promise<T> {
  try {
    return await mutation();
  } catch (cause) {
    if (!isRevisionConflictError(cause)) throw cause;
    try {
      await refreshRequired();
    } catch (refreshCause) {
      throw new AgentRevisionConflictRefreshError(cause, refreshCause);
    }
    throw cause;
  }
}

type ArchivableManagementItem = {
  id: string;
  status: "active" | "archived";
};

export function activeSelectionAfterArchive(
  currentId: string | null,
  archivedId: string,
  items: readonly ArchivableManagementItem[]
): string | null {
  const retainedId = selectionAfterArchive(currentId, archivedId);
  if (retainedId !== null) return retainedId;
  return items.find((item) => item.id !== archivedId && item.status === "active")?.id ?? null;
}

export function agentSelectionFromDeepLink(
  agentId: string | null,
  agents: readonly Pick<Agent, "id">[]
): string | null {
  return agentId && agents.some((agent) => agent.id === agentId) ? agentId : null;
}

export function initialAgentSelection(
  currentId: string | null,
  deepLinkedAgentId: string | null,
  agents: readonly Pick<Agent, "id">[]
): string | null {
  if (currentId) return currentId;
  return agentSelectionFromDeepLink(deepLinkedAgentId, agents) ?? agents[0]?.id ?? null;
}

const agentDraftFieldLabels: Record<keyof AgentEditableDraft, string> = {
  name: "名稱",
  description: "描述",
  modelConnectorId: "模型",
  goalSummary: "目標摘要",
  toolsSummary: "工具摘要",
  dataSummary: "資料摘要",
  skillIds: "Skill",
  toolGrants: "唯讀工具",
  toolPackGrants: "Tool Pack",
  runtimeProfileBinding: "執行設定",
  promptBinding: "Prompt 綁定"
};

const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "待辦",
  in_progress: "進行中",
  review: "審查",
  done: "完成"
};

const taskExecutionProfileLabels: Record<TaskExecutionProfile, string> = {
  manual: "人工處理",
  advisor: "Agent 顧問",
  worker: "Agent 產出"
};

const agentSections = [
  { id: "agents", label: "Agent 清單" },
  { id: "teams", label: "Teams" },
  { id: "presets", label: "Meeting Presets" },
  { id: "runtime", label: "執行設定" }
] as const;

type AgentSection = (typeof agentSections)[number]["id"];

type RuntimeProfileDraft = {
  name: string;
  harnessKind: RuntimeHarnessKind;
  modelConnectorId: string;
  sandboxProfileId: string;
  policy: RuntimePolicy;
  capabilities: RuntimeCapability[];
  timeoutSeconds: number;
  maxConcurrency: number;
  enabled: boolean;
};

const emptyRuntimeDraft: RuntimeProfileDraft = {
  name: "",
  harnessKind: "openai_compatible",
  modelConnectorId: "",
  sandboxProfileId: "",
  policy: "read_only_tools",
  capabilities: normalizeRuntimeCapabilities("read_only_tools", []),
  timeoutSeconds: 60,
  maxConcurrency: 1,
  enabled: true
};

function taskDueDateLabel(value: string | null): string {
  if (!value) return "無期限";
  const dueAt = new Date(value);
  if (Number.isNaN(dueAt.getTime())) return "期限格式異常";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).format(dueAt);
}

function parseBindingKey(value: string): RuntimeProfileBinding | null {
  if (!value) return null;
  const [profileId, revision] = value.split(":");
  const parsedRevision = Number(revision);
  return profileId && Number.isInteger(parsedRevision) && parsedRevision > 0
    ? { profileId, revision: parsedRevision }
    : null;
}

function runtimeDraftFromProfile(profile: RuntimeProfile): RuntimeProfileDraft {
  return {
    name: profile.name,
    harnessKind: profile.harnessKind,
    modelConnectorId: profile.modelConnectorId ?? "",
    sandboxProfileId: profile.sandboxProfileId ?? "",
    policy: profile.policy,
    capabilities: [...profile.capabilities],
    timeoutSeconds: Math.round(profile.timeoutMs / 1000),
    maxConcurrency: profile.maxConcurrency,
    enabled: profile.enabled
  };
}

function runtimePayloadFromDraft(draft: RuntimeProfileDraft) {
  return {
    name: draft.name.trim(),
    harnessKind: draft.harnessKind,
    modelConnectorId: draft.modelConnectorId || null,
    sandboxProfileId: draft.policy === "isolated_exec" ? draft.sandboxProfileId.trim() || null : null,
    policy: draft.policy,
    capabilities: normalizeRuntimeCapabilities(draft.policy, draft.capabilities),
    timeoutMs: draft.timeoutSeconds * 1000,
    maxConcurrency: draft.maxConcurrency,
    enabled: draft.enabled
  };
}

export function AgentsView() {
  return <Suspense fallback={<PageState loading error={null} />}><AgentsViewContent /></Suspense>;
}

function AgentsViewContent() {
  const { snapshot, loading, error, mutate, commitMutation, refresh, refreshRequired } = usePlatform();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkedAgentId = searchParams.get("agentId");
  const sourceContext = parseWorkspaceSourceContext(searchParams);
  const [section, setSection] = useState<AgentSection>("agents");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [selectedRuntimeProfileId, setSelectedRuntimeProfileId] = useState<string | null>(null);
  const [runtimeRegistry, setRuntimeRegistry] = useState<"profiles" | "tool_packs">("profiles");
  const [setupSettingsTab, setSetupSettingsTab] = useState<SettingsTab | null>(null);
  const [connectionState, setConnectionState] = useState<"idle" | "pending" | "healthy" | "unhealthy" | "error">("idle");
  const modelHealthRequestRef = useRef(new LatestRequestGate());
  const modelHealthTargetRef = useRef<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [createAgentDirty, setCreateAgentDirty] = useState(false);
  const [editAgentDirty, setEditAgentDirty] = useState(false);
  const [editingAgentDraftRevision, setEditingAgentDraftRevision] = useState<number | null>(null);
  const [agentEditBaseDraft, setAgentEditBaseDraft] = useState<AgentEditableDraft | null>(null);
  const [agentEditDraft, setAgentEditDraft] = useState<AgentEditableDraft | null>(null);
  const [editSelectedSkillIds, setEditSelectedSkillIds] = useState<string[]>([]);
  const [agentEditConflictTarget, setAgentEditConflictTarget] = useState<{
    agentId: string;
    previousRevision: number;
    baseDraft: AgentEditableDraft;
    localDraft: AgentEditableDraft;
  } | null>(null);
  const [runtimeEditorOpen, setRuntimeEditorOpen] = useState(false);
  const [runtimeHistoryOpen, setRuntimeHistoryOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  const [readinessFilter, setReadinessFilter] = useState<"all" | AgentReadiness["status"]>("all");
  const [revisions, setRevisions] = useState<AgentRevision[]>([]);
  const [effectiveConfig, setEffectiveConfig] = useState<EffectiveAgentConfiguration | null>(null);
  const [effectiveConfigState, setEffectiveConfigState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [effectiveConfigAgentId, setEffectiveConfigAgentId] = useState<string | null>(null);
  const [agentDetailsReloadKey, setAgentDetailsReloadKey] = useState(0);
  const [rosterReadinessByAgentId, setRosterReadinessByAgentId] = useState<Record<string, AgentReadiness>>({});
  const [rosterReadinessState, setRosterReadinessState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [teamOpen, setTeamOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [teamMembers, setTeamMembers] = useState<Record<string, { roleId: string; isChair: boolean }>>({});
  const [editingTeam, setEditingTeam] = useState<AgentTeam | null>(null);
  const [teamDraftDirty, setTeamDraftDirty] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<MeetingPreset | null>(null);
  const [presetName, setPresetName] = useState("");
  const [presetDescription, setPresetDescription] = useState("");
  const [presetTeamId, setPresetTeamId] = useState("");
  const [presetMode, setPresetMode] = useState<MeetingPreset["mode"]>("chaired");
  const [presetAutomation, setPresetAutomation] = useState<MeetingPreset["automation"]>("suggest");
  const [presetDuration, setPresetDuration] = useState(30);
  const [presetAgenda, setPresetAgenda] = useState<Array<{ title: string; description: string }>>([{ title: "", description: "" }]);
  const [presetDraftDirty, setPresetDraftDirty] = useState(false);
  const [presetPreflight, setPresetPreflight] = useState<MeetingPresetPreflight | null>(null);
  const [presetPreflightState, setPresetPreflightState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [editingRuntimeProfile, setEditingRuntimeProfile] = useState<RuntimeProfile | null>(null);
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeProfileDraft>(emptyRuntimeDraft);
  const [runtimeHistoryProfile, setRuntimeHistoryProfile] = useState<RuntimeProfile | null>(null);
  const [runtimeHistory, setRuntimeHistory] = useState<RuntimeProfileRevision[]>([]);
  const [runtimeHistoryLoading, setRuntimeHistoryLoading] = useState(false);
  const runtimeHistoryRequestGateRef = useRef(new LatestRequestGate());
  const agentCreationRetryRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const runtimeProfileCreationRetryRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const agentTeamCreationRetryRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const meetingPresetCreationRetryRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const appliedAgentDeepLinkRef = useRef<string | null>(null);
  const [createRuntimeBindingKey, setCreateRuntimeBindingKey] = useState("");
  const [editRuntimeBindingKey, setEditRuntimeBindingKey] = useState("");

  useEffect(() => {
    if (!notice || actionError) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [actionError, notice]);

  useEffect(() => {
    if (!deepLinkedAgentId) {
      appliedAgentDeepLinkRef.current = null;
      return;
    }
    if (!snapshot || appliedAgentDeepLinkRef.current === deepLinkedAgentId) return;
    const linkedAgentId = agentSelectionFromDeepLink(deepLinkedAgentId, snapshot.agents);
    if (!linkedAgentId) return;
    appliedAgentDeepLinkRef.current = linkedAgentId;
    setSection("agents");
    setSelectedId(linkedAgentId);
    setNotice("");
    setActionError("");
  }, [deepLinkedAgentId, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const nextSelectedId = initialAgentSelection(selectedId, deepLinkedAgentId, snapshot.agents);
    if (nextSelectedId !== selectedId) setSelectedId(nextSelectedId);
  }, [agentDetailsReloadKey, deepLinkedAgentId, selectedId, snapshot]);

  const connectionConnector = snapshot?.modelConnectors.find((connector) => connector.id === effectiveConfig?.model?.id);
  const connectionCredential = snapshot?.credentials?.find((credential) => credential.id === connectionConnector?.credentialId);
  const modelConnectionIdentity = effectiveConfig?.agent.id === selectedId && effectiveConfig?.model
    ? effectiveModelConnectionIdentity({
        agentId: effectiveConfig.agent.id,
        source: effectiveConfig.source,
        connectorId: effectiveConfig.model.id,
        connectorRevision: connectionConnector?.revision,
        credentialRevision: connectionCredential?.secretRevision,
        credentialState: connectionCredential ? JSON.stringify([connectionCredential.id, connectionCredential.status, connectionCredential.hasSecret, connectionCredential.expiresAt]) : undefined
      })
    : null;
  useEffect(() => {
    modelHealthTargetRef.current = modelConnectionIdentity;
    modelHealthRequestRef.current.cancel();
    setConnectionState("idle");
  }, [modelConnectionIdentity]);

  useEffect(() => {
    const firstActiveTeam = snapshot?.agentTeams?.find((team) => team.status === "active");
    if (!selectedTeamId && firstActiveTeam) setSelectedTeamId(firstActiveTeam.id);
  }, [selectedTeamId, snapshot]);

  useEffect(() => {
    const firstActivePreset = snapshot?.meetingPresets?.find((preset) => preset.status === "active");
    if (!selectedPresetId && firstActivePreset) setSelectedPresetId(firstActivePreset.id);
  }, [selectedPresetId, snapshot]);

  useEffect(() => {
    if (!selectedRuntimeProfileId && snapshot?.runtimeProfiles?.[0]) setSelectedRuntimeProfileId(snapshot.runtimeProfiles[0].id);
  }, [selectedRuntimeProfileId, snapshot]);

  useEffect(() => {
    if (!snapshot || !selectedId) return;
    let cancelled = false;
    setEffectiveConfig((current) => current?.agent.id === selectedId ? current : null);
    setEffectiveConfigAgentId(selectedId);
    setEffectiveConfigState("loading");
    setRevisions([]);
    void managementApi.getAgentRevisions(selectedId)
      .then((nextRevisions) => {
        if (!cancelled) setRevisions(nextRevisions);
      })
      .catch(() => {
        if (!cancelled) setRevisions([]);
      });
    void managementApi.getEffectiveAgentConfiguration(selectedId)
      .then((nextEffectiveConfig) => {
        if (cancelled) return;
        setEffectiveConfig(nextEffectiveConfig);
        setEffectiveConfigState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setEffectiveConfig(null);
        setEffectiveConfigState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [agentDetailsReloadKey, selectedId, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    setRosterReadinessByAgentId({});
    setRosterReadinessState("loading");
    void loadPublishedAgentReadiness(
      snapshot.agents.map((agent) => agent.id),
      async (agentIds) => (await managementApi.getAgentReadinessBatch(agentIds)).results
    )
      .then((nextReadinessByAgentId) => {
        if (cancelled) return;
        setRosterReadinessByAgentId(nextReadinessByAgentId);
        setRosterReadinessState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setRosterReadinessByAgentId({});
        setRosterReadinessState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !selectedPresetId || section !== "presets") return;
    let cancelled = false;
    setPresetPreflight(null);
    setPresetPreflightState("loading");
    void managementApi.getMeetingPresetPreflight(selectedPresetId)
      .then((nextPreflight) => {
        if (cancelled) return;
        setPresetPreflight(nextPreflight);
        setPresetPreflightState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPresetPreflight(null);
        setPresetPreflightState("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [section, selectedPresetId, snapshot]);

  useEffect(() => {
    if (!snapshot || !agentEditConflictTarget) return;
    const latestAgent = snapshot.agents.find((candidate) => candidate.id === agentEditConflictTarget.agentId);
    if (!latestAgent) {
      setAgentEditConflictTarget(null);
      setActionError("Agent 已不存在，目前草稿仍保留；請關閉編輯視窗後重新選擇。");
      return;
    }
    const latestRevision = latestAgent.draftRevision ?? latestAgent.publishedRevision ?? 1;
    if (latestRevision <= agentEditConflictTarget.previousRevision) return;
    const latestDraft = agentEditableDraft(latestAgent);
    const merged = mergeAgentDraftAfterConflict(
      agentEditConflictTarget.baseDraft,
      agentEditConflictTarget.localDraft,
      latestDraft
    );
    setAgentEditBaseDraft(latestDraft);
    setAgentEditDraft(merged.draft);
    setEditSelectedSkillIds(merged.draft.skillIds);
    setEditRuntimeBindingKey(initialRuntimeBindingKey("edit", merged.draft.runtimeProfileBinding, ""));
    setEditingAgentDraftRevision(latestRevision);
    setAgentEditConflictTarget(null);
    setActionError(merged.conflictingFields.length > 0
      ? `已載入最新 Agent Rev ${latestRevision}。未衝突的草稿已合併；${merged.conflictingFields.map((field) => agentDraftFieldLabels[field]).join("、")} 同時被修改，已保留伺服器版本，請確認後再儲存。`
      : `已載入最新 Agent Rev ${latestRevision}，未衝突的草稿已合併，請確認後再儲存。`);
  }, [agentEditConflictTarget, snapshot]);

  if (loading || error || !snapshot) return <PageState loading={loading} error={error} />;
  const currentSnapshot = snapshot;

  const agent = currentSnapshot.agents.find((item) => item.id === selectedId) ?? currentSnapshot.agents[0];
  const teams = currentSnapshot.agentTeams ?? [];
  const presets = currentSnapshot.meetingPresets ?? [];
  const runtimeProfiles = currentSnapshot.runtimeProfiles ?? [];
  const runtimeRevisions = currentSnapshot.runtimeProfileRevisions ?? [];
  const toolPacks = currentSnapshot.toolPacks ?? [];
  const toolPackRevisions = currentSnapshot.toolPackRevisions ?? [];
  const appliedReadinessFilter = rosterReadinessState === "ready" ? readinessFilter : "all";
  const roster = filterAgentRoster(currentSnapshot, rosterReadinessByAgentId, query, appliedReadinessFilter);
  const allRoster = filterAgentRoster(currentSnapshot, rosterReadinessByAgentId, "", "all");
  const readinessByAgentId = new Map(allRoster.flatMap((item) => (
    item.readiness ? [[item.agent.id, item.readiness] as const] : []
  )));
  const unavailableReadinessLabel = rosterReadinessState === "loading" ? "檢查中" : "無法取得";
  const skillRecords = (currentSnapshot.skills as unknown as SkillSnapshotEntry[]).map(normalizeSkill);
  const enabledModelConnectors = currentSnapshot.modelConnectors.filter((connector) => connector.enabled);
  const assignedModelConnector = agent
    ? currentSnapshot.modelConnectors.find((connector) => connector.id === agent.modelConnectorId)
    : undefined;
  const selectableModelConnectors = assignedModelConnector && !assignedModelConnector.enabled
    ? [assignedModelConnector, ...enabledModelConnectors]
    : enabledModelConnectors;
  const selectedEffectiveConfig = agent && effectiveConfig?.agent.id === agent.id ? effectiveConfig : null;
  const selectedEffectiveConfigState = !agent
    || effectiveConfigAgentId !== agent.id
    || effectiveConfigState === "loading"
    ? "loading"
    : effectiveConfigState === "unavailable"
      ? "unavailable"
      : selectedEffectiveConfig
        ? "ready"
        : "unavailable";
  const readiness = selectedEffectiveConfigState === "ready" ? selectedEffectiveConfig?.readiness ?? null : null;
  const readinessLabel = selectedEffectiveConfigState === "loading"
    ? "載入中"
    : selectedEffectiveConfigState === "unavailable"
      ? "無法取得"
      : readiness?.status === "ready"
        ? "Ready"
        : readiness?.status === "blocked"
          ? "Blocked"
          : "Warning";
  const readinessClass = selectedEffectiveConfigState === "unavailable"
    ? "unavailable"
    : readiness?.status === "ready"
      ? "approved"
      : readiness?.status === "blocked"
        ? "disabled"
        : "";
  const effectiveModelLabel = selectedEffectiveConfigState === "loading"
    ? "模型載入中"
    : selectedEffectiveConfigState === "unavailable"
      ? "模型無法取得"
      : selectedEffectiveConfig?.model
        ? `${selectedEffectiveConfig.model.name} · ${selectedEffectiveConfig.model.model}${selectedEffectiveConfig.model.enabled ? "" : " · 已停用"}`
        : "模型未設定";
  const roleUsage = agent ? agentRoleUsage(currentSnapshot, agent.id) : [];
  const assignedTasks = agent ? currentSnapshot.tasks.filter((task) => task.assigneeAgentId === agent.id) : [];
  const incompleteTasks = assignedTasks
    .filter((task) => task.status !== "done")
    .sort((left, right) => (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") || left.createdAt.localeCompare(right.createdAt));
  const completedTaskCount = assignedTasks.length - incompleteTasks.length;
  const availableSkills = skillRecords.filter(isSkillAssignable);
  const unavailableAssignmentCount = agent
    ? agent.skillIds.filter((skillId) => !skillRecords.some((skill) => skill.id === skillId && isSkillAssignable(skill))).length
    : 0;
  const assignedTools = agent ? effectiveAgentTools(currentSnapshot, agent.id) : [];
  const unavailableToolGrantCount = agent ? agent.toolGrants.length - assignedTools.length : 0;
  const assignedToolPackEntries = agent ? agent.toolPackGrants.flatMap((grant) => {
    const current = toolPacks.find((pack) => pack.id === grant.packId);
    const revision = toolPackRevisions.find((item) => item.packId === grant.packId && item.revision === grant.revision);
    const tool = revision?.tools.find((item) => item.name === grant.toolName);
    if (!revision || !tool) return [];
    return [{
      current,
      revision,
      tool,
      available: Boolean(
        current
        && current.status === "approved"
        && current.revision === grant.revision
        && current.manifestDigest === grant.manifestDigest
      )
    }];
  }) : [];
  const unavailableToolPackGrantCount = assignedToolPackEntries.filter((entry) => !entry.available).length
    + Math.max(0, (agent?.toolPackGrants.length ?? 0) - assignedToolPackEntries.length);
  const selectedTeam = teams.find((item) => item.id === selectedTeamId)
    ?? teams.find((item) => item.status === "active")
    ?? null;
  const selectedPreset = presets.find((item) => item.id === selectedPresetId)
    ?? presets.find((item) => item.status === "active")
    ?? null;
  const presetPreflightUi = presetPreflightState === "loading"
    ? { label: "檢查中", className: "unavailable" }
    : presetPreflightState === "unavailable" || !presetPreflight
      ? { label: "無法取得", className: "unavailable" }
      : readinessStatusUi(presetPreflight.status);
  const selectedRuntimeProfile = runtimeProfiles.find((item) => item.id === selectedRuntimeProfileId) ?? runtimeProfiles[0] ?? null;
  const runtimeDraftBase = editingRuntimeProfile
    ? runtimeDraftFromProfile(editingRuntimeProfile)
    : emptyRuntimeDraft;
  const runtimeDraftDirty = JSON.stringify(runtimePayloadFromDraft(runtimeDraft))
    !== JSON.stringify(runtimePayloadFromDraft(runtimeDraftBase));
  const currentAgentEditDraft = agentEditDraft ?? (agent ? agentEditableDraft(agent) : null);
  const runtimeOptions = runtimeBindingOptions(currentSnapshot, currentAgentEditDraft?.runtimeProfileBinding ?? null);
  const promptOptions = agentPromptBindingOptions(currentSnapshot.prompts ?? [], currentAgentEditDraft?.promptBinding);
  const createPromptOptions = agentPromptBindingOptions(currentSnapshot.prompts ?? [], null);
  const defaultRuntimeBindingKey = runtimeOptions.find((option) =>
    option.current?.enabled && option.current.revision === option.revision?.revision
  )?.key ?? runtimeOptions[0]?.key ?? "";
  const approvedToolOptions = approvedAgentToolOptions(currentSnapshot.mcpConnectors);
  const effectiveSkillIds = selectedEffectiveConfig?.source.kind === "published"
    ? revisions.find((revision) => revision.revision === selectedEffectiveConfig.source.revision)?.skillIds ?? null
    : selectedEffectiveConfig?.source.kind === "draft"
      ? agent?.skillIds ?? null
      : null;
  const meetingSkillInstructionBudget = effectiveSkillIds ? selectedSkillInstructionBudget(effectiveSkillIds, currentSnapshot.skills) : null;
  const meetingSkillBudgetLabel = selectedEffectiveConfig?.source.kind === "published"
    ? "已發布會議 Skill 指令"
    : selectedEffectiveConfig?.source.kind === "draft"
      ? "草稿會議 Skill 指令"
      : "會議 Skill 指令";
  const agentEditInstructionBudget = selectedSkillInstructionBudget(editSelectedSkillIds, currentSnapshot.skills);
  const setupRows = agentSetupRows(selectedEffectiveConfigState === "loading" ? "loading" : readiness);
  const effectiveModelConnectionTarget = selectedEffectiveConfig?.model && modelConnectionIdentity && selectedEffectiveConfigState === "ready"
    ? {
        connectorId: selectedEffectiveConfig.model.id,
        identity: modelConnectionIdentity
      }
    : null;
  const primaryMeetingHref = sourceContext.meetingId
    ? buildMeetingWorkspaceHref({ meetingId: sourceContext.meetingId, threadId: sourceContext.threadId, fromGoalId: sourceContext.goalId })
    : `/?newMeeting=1&agentId=${encodeURIComponent(agent?.id ?? "")}`;

  function openSetupSettings(tab: SettingsTab) {
    setSetupSettingsTab(tab);
    setActionError("");
  }

  async function testModelConnection() {
    if (!effectiveModelConnectionTarget || connectionState === "pending") return;
    const requestToken = modelHealthRequestRef.current.begin();
    const connectionTarget = effectiveModelConnectionTarget;
    setConnectionState("pending");
    try {
      const result = await mutate<{ healthy: boolean }>(`/api/model-connectors/${connectionTarget.connectorId}/health`, { method: "POST" });
      if (!modelHealthRequestRef.current.isCurrent(requestToken) || modelHealthTargetRef.current !== connectionTarget.identity) return;
      setConnectionState(result.healthy ? "healthy" : "unhealthy");
    } catch {
      if (!modelHealthRequestRef.current.isCurrent(requestToken) || modelHealthTargetRef.current !== connectionTarget.identity) return;
      setConnectionState("error");
    }
  }

  function handleSetupAction(action: AgentSetupAction) {
    if (action === "test_connection") {
      void testModelConnection();
      return;
    }
    if (action === "manage_models") return openSetupSettings("models");
    if (action === "manage_credentials") return openSetupSettings("credentials");
    if (action === "manage_prompts") return openSetupSettings("prompts");
    if (action === "manage_skills") return openSetupSettings("skills");
    if (action === "manage_mcp") return openSetupSettings("mcp");
    openEditAgentModal();
  }

  const roleUsageDetails = roleUsage.length > 0 ? (
    <ul className="agent-role-usage">
      {roleUsage.map((usage) => (
        <li key={`${usage.meetingId}:${usage.roleId}`}>
          <strong>{usage.meetingTitle}</strong>
          <span>{usage.roleName} v{usage.roleVersion}{usage.isChair ? " · 主席" : " · 參與者"}</span>
          <p>{usage.usageContext}</p>
        </li>
      ))}
    </ul>
  ) : (
    <p className="agent-skill-empty">尚未指派至會議</p>
  );

  const taskRelationshipDetails = (
    <>
      <p className="agent-skill-empty">指派任務</p>
      {incompleteTasks.length > 0 ? (
        <ul className="agent-role-usage">
          {incompleteTasks.map((task) => (
            <li key={task.id}>
              <Link href={`/tasks?taskId=${encodeURIComponent(task.id)}`}>
                <strong>{task.title}</strong>
              </Link>
              <span>{taskStatusLabels[task.status]} · {taskExecutionProfileLabels[task.executionProfile]} · {taskDueDateLabel(task.dueAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="agent-skill-empty">尚無未完成指派任務</p>
      )}
      {completedTaskCount > 0 && <p className="agent-skill-empty">已完成 {completedTaskCount} 項</p>}
      <p className="agent-skill-empty">會議角色</p>
      {roleUsageDetails}
    </>
  );

  function openCreateAgentModal() {
    setActionError("");
    setCreateRuntimeBindingKey(initialRuntimeBindingKey("create", null, defaultRuntimeBindingKey));
    setCreateAgentDirty(false);
    setCreateOpen(true);
  }

  function requestCloseCreateAgentModal() {
    if (pending) return;
    if (createAgentDirty && !window.confirm("Agent 草稿尚未儲存，確定捨棄？")) return;
    setCreateAgentDirty(false);
    setCreateOpen(false);
    setActionError("");
  }

  function openEditAgentModal() {
    if (!agent) return;
    const draft = agentEditableDraft(agent);
    setActionError("");
    setAgentEditConflictTarget(null);
    setAgentEditBaseDraft(draft);
    setAgentEditDraft(draft);
    setEditSelectedSkillIds(draft.skillIds);
    setEditRuntimeBindingKey(initialRuntimeBindingKey("edit", draft.runtimeProfileBinding, defaultRuntimeBindingKey));
    setEditingAgentDraftRevision(agent.draftRevision ?? 1);
    setEditAgentDirty(false);
    setEditOpen(true);
  }

  function closeEditAgentModal() {
    setEditOpen(false);
    setEditingAgentDraftRevision(null);
    setAgentEditBaseDraft(null);
    setAgentEditDraft(null);
    setEditSelectedSkillIds([]);
    setAgentEditConflictTarget(null);
    setEditAgentDirty(false);
  }

  function requestCloseEditAgentModal() {
    if (pending) return;
    if (editAgentDirty && !window.confirm("Agent 變更尚未儲存，確定捨棄？")) return;
    closeEditAgentModal();
  }

  function reloadAgentDetails() {
    setActionError("");
    setAgentDetailsReloadKey((current) => current + 1);
  }

  async function publishAgent() {
    if (!agent || agent.draftRevision === undefined) return;
    if (agent.draftRevision === agent.publishedRevision) {
      setNotice("目前沒有待發布的 Agent 草稿。");
      return;
    }
    setPending(true);
    setActionError("");
    try {
      await runAgentRevisionMutation(
        () => commitMutation(() => managementApi.publishAgent(agent.id, agent.draftRevision!)),
        refreshRequired
      );
      setNotice(`Agent ${agent.name} 已發布 Rev ${agent.draftRevision}。`);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setNotice(`Agent ${agent.name} 已發布，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else if (isRevisionConflictError(cause)) {
        setActionError(`Agent ${agent.name} 已由其他分頁更新；已載入最新資料，請確認後重試。`);
      } else {
        setActionError(`Agent ${agent.name}：${cause instanceof Error ? cause.message : "尚未通過發布檢查。"}`);
      }
    } finally {
      setPending(false);
    }
  }

  async function toggleAgentStatus() {
    if (!agent) return;
    const nextStatus = agentStatusTransition(agent);
    if (!nextStatus) {
      setActionError(`Agent ${agent.name}：首次發布前不能停用。`);
      return;
    }
    const expectedRevision = agent.revision ?? agent.draftRevision ?? agent.publishedRevision ?? 1;
    setPending(true);
    setActionError("");
    try {
      await runAgentRevisionMutation(
        () => commitMutation(() => managementApi.updateAgentStatus(agent.id, nextStatus, expectedRevision)),
        refreshRequired
      );
      setNotice(nextStatus === "disabled"
        ? `Agent ${agent.name} 已停用。`
        : nextStatus === "draft"
          ? `Agent ${agent.name} 已恢復為草稿。`
          : `Agent ${agent.name} 已重新啟用。`);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setNotice(`Agent ${agent.name} 狀態已更新，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else if (isRevisionConflictError(cause)) {
        setActionError(`Agent ${agent.name} 已由其他分頁更新；已載入最新資料，請確認後重試。`);
      } else {
        setActionError(`Agent ${agent.name}：${cause instanceof Error ? cause.message : "無法更新狀態。"}`);
      }
    } finally {
      setPending(false);
    }
  }

  async function rollbackAgent() {
    if (!agent || !agent.publishedRevision || !agent.draftRevision) return;
    const publishedRevision = agent.publishedRevision;
    if (agent.draftRevision !== publishedRevision) {
      setActionError("目前有未發布草稿；請先發布草稿，再回復較早版本。");
      return;
    }
    const candidates = revisions
      .filter((revision) => revision.revision < publishedRevision)
      .sort((left, right) => right.revision - left.revision);
    const target = candidates[0];
    if (!target) return;
    setPending(true);
    setActionError("");
    try {
      await runAgentRevisionMutation(
        () => commitMutation(() => managementApi.rollbackAgent(agent.id, publishedRevision, agent.draftRevision!, target.revision)),
        refreshRequired
      );
      setNotice(`Agent ${agent.name} 已用 Rev ${target.revision} 建立回復草稿，請檢查後發布。`);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setNotice(`Agent ${agent.name} 已建立回復草稿，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else if (isRevisionConflictError(cause)) {
        setActionError(`Agent ${agent.name} 已由其他分頁更新；已載入最新資料，請確認後重試。`);
      } else {
        setActionError(`Agent ${agent.name}：${cause instanceof Error ? cause.message : "無法回復版本。"}`);
      }
    } finally {
      setPending(false);
    }
  }

  function closeTeamEditor() {
    setTeamOpen(false);
    setTeamName("");
    setTeamDescription("");
    setTeamMembers({});
    setEditingTeam(null);
    setTeamDraftDirty(false);
    setActionError("");
  }

  function requestCloseTeamEditor() {
    if (pending) return;
    if (teamDraftDirty && !window.confirm("Agent Team 草稿尚未儲存，確定捨棄？")) return;
    closeTeamEditor();
  }

  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingTeam && !canEditAgentManagementItem(editingTeam.status)) {
      setActionError("已封存 Agent Team 不可編輯。");
      return;
    }
    const members = Object.entries(teamMembers)
      .filter(([, member]) => member.roleId)
      .map(([agentId, member]) => ({ agentId, ...member }));
    if (members.length === 0 || members.filter((member) => member.isChair).length !== 1) {
      setActionError("Team 必須至少有一位成員，且只能有一位主席。");
      return;
    }
    setPending(true);
    setActionError("");
    try {
      let readinessForAdmission = rosterReadinessByAgentId;
      if (rosterReadinessState !== "ready") {
        let nextReadinessByAgentId: Record<string, AgentReadiness>;
        try {
          nextReadinessByAgentId = await loadPublishedAgentReadiness(
            currentSnapshot.agents.map((candidate) => candidate.id),
            async (agentIds) => (await managementApi.getAgentReadinessBatch(agentIds)).results
          );
        } catch {
          setRosterReadinessState("unavailable");
          setActionError("無法確認已發布 Agent readiness，請重試。");
          return;
        }
        readinessForAdmission = nextReadinessByAgentId;
        setRosterReadinessByAgentId(nextReadinessByAgentId);
        setRosterReadinessState("ready");
      }
      const unavailableMemberId = firstUnavailableTeamMemberId(
        members.map((member) => member.agentId),
        readinessForAdmission
      );
      if (unavailableMemberId) {
        const unavailableAgent = currentSnapshot.agents.find((candidate) => candidate.id === unavailableMemberId);
        const unavailableReadiness = readinessForAdmission[unavailableMemberId];
        const reason = unavailableReadiness
          ? agentReadinessBlockingReason(unavailableReadiness)
          : "找不到已發布 readiness。";
        setActionError(`${unavailableAgent?.name ?? "所選 Agent"}：${reason ?? "Agent readiness 未通過。"}`);
        return;
      }
      if (editingTeam) {
        await commitMutation(() => managementApi.updateAgentTeam(editingTeam.id, {
          expectedRevision: editingTeam.revision,
          name: teamName,
          description: teamDescription,
          members
        }));
      } else {
        const requestPayload = { name: teamName, description: teamDescription, members };
        const retryToken = idempotencyRetryToken(
          agentTeamCreationRetryRef.current,
          JSON.stringify(requestPayload),
          () => crypto.randomUUID()
        );
        agentTeamCreationRetryRef.current = retryToken;
        const created = await commitMutation(() => (
          managementApi.createAgentTeam(requestPayload, retryToken.idempotencyKey)
        ));
        agentTeamCreationRetryRef.current = null;
        setSelectedTeamId(created.id);
      }
      closeTeamEditor();
      setNotice(editingTeam ? "Agent Team 已更新。" : "Agent Team 已建立，可在建立會議時套用。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        const committedTeam = cause.result as AgentTeam;
        if (!editingTeam) {
          agentTeamCreationRetryRef.current = null;
          setSelectedTeamId(committedTeam.id);
        }
        closeTeamEditor();
        setNotice(`Agent Team 已${editingTeam ? "更新" : "建立"}，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else {
        if (!editingTeam && cause instanceof ApiError && cause.status < 500) {
          agentTeamCreationRetryRef.current = null;
        }
        setActionError(managementSaveError(cause, "Agent Team", "無法建立 Agent Team。"));
      }
    } finally {
      setPending(false);
    }
  }

  async function archiveTeam(team: AgentTeam) {
    setPending(true);
    setActionError("");
    try {
      await commitMutation(() => managementApi.updateAgentTeam(team.id, { expectedRevision: team.revision, status: "archived" }));
      setSelectedTeamId((current) => activeSelectionAfterArchive(current, team.id, teams));
      setNotice("Agent Team 已封存；既有會議快照不受影響。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setNotice("Agent Team 已封存，但清單刷新失敗；請重新整理以載入最新資料。");
      } else {
        setActionError(managementSaveError(cause, "Agent Team", "無法封存 Agent Team。"));
      }
    } finally {
      setPending(false);
    }
  }

  function resetPresetDraft() {
    setEditingPreset(null);
    setPresetName("");
    setPresetDescription("");
    setPresetTeamId("");
    setPresetMode("chaired");
    setPresetAutomation("suggest");
    setPresetDuration(30);
    setPresetAgenda([{ title: "", description: "" }]);
    setPresetDraftDirty(false);
  }

  function editPreset(preset: MeetingPreset) {
    if (!canEditAgentManagementItem(preset.status)) return;
    setEditingPreset(preset);
    setPresetName(preset.name);
    setPresetDescription(preset.description);
    setPresetTeamId(preset.teamId ?? "");
    setPresetMode(preset.mode);
    setPresetAutomation(preset.automation);
    setPresetDuration(preset.durationMinutes);
    setPresetAgenda(preset.agendaItems.map((item) => ({ ...item })));
    setPresetDraftDirty(false);
    setPresetOpen(true);
  }

  function requestClosePresetEditor() {
    if (pending) return;
    if (presetDraftDirty && !window.confirm("Meeting Preset 草稿尚未儲存，確定捨棄？")) return;
    setPresetOpen(false);
    resetPresetDraft();
    setActionError("");
  }

  function updatePresetAgenda(index: number, field: "title" | "description", value: string) {
    setPresetAgenda((current) =>
      current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item)
    );
  }

  async function savePreset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editingPreset && !canEditAgentManagementItem(editingPreset.status)) {
      setActionError("已封存 Meeting Preset 不可編輯。");
      return;
    }
    const agendaItems = presetAgenda.filter((item) => item.title.trim());
    if (agendaItems.length < 1 || agendaItems.length > 12) {
      setActionError("Meeting Preset 必須有 1–12 個不重複的議程項目。");
      return;
    }
    const agendaTitles = agendaItems.map((item) => item.title.normalize("NFKC").trim().toLocaleLowerCase());
    if (new Set(agendaTitles).size !== agendaTitles.length) {
      setActionError("Meeting Preset 的議程標題不可重複。");
      return;
    }
    setPending(true);
    setActionError("");
    try {
      const input = {
        name: presetName,
        description: presetDescription,
        teamId: presetTeamId || null,
        mode: presetMode,
        automation: presetAutomation,
        durationMinutes: presetDuration,
        agendaItems
      };
      if (editingPreset) {
        await commitMutation(() => managementApi.updateMeetingPreset(editingPreset.id, {
          expectedRevision: editingPreset.revision,
          ...input
        }));
      } else {
        const retryToken = idempotencyRetryToken(
          meetingPresetCreationRetryRef.current,
          JSON.stringify(input),
          () => crypto.randomUUID()
        );
        meetingPresetCreationRetryRef.current = retryToken;
        const created = await commitMutation(() => (
          managementApi.createMeetingPreset(input, retryToken.idempotencyKey)
        ));
        meetingPresetCreationRetryRef.current = null;
        setSelectedPresetId(created.id);
      }
      setPresetOpen(false);
      setNotice(editingPreset ? "Meeting Preset 已更新。" : "Meeting Preset 已建立，可在建立會議時套用。");
      resetPresetDraft();
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        const committedPreset = cause.result as MeetingPreset;
        if (!editingPreset) {
          meetingPresetCreationRetryRef.current = null;
          setSelectedPresetId(committedPreset.id);
        }
        setPresetOpen(false);
        setNotice(`Meeting Preset 已${editingPreset ? "更新" : "建立"}，但清單刷新失敗；請重新整理以載入最新資料。`);
        resetPresetDraft();
      } else {
        if (!editingPreset && cause instanceof ApiError && cause.status < 500) {
          meetingPresetCreationRetryRef.current = null;
        }
        setActionError(managementSaveError(cause, "Meeting Preset", "無法儲存 Meeting Preset。"));
      }
    } finally {
      setPending(false);
    }
  }

  async function archivePreset(preset: MeetingPreset) {
    setPending(true);
    setActionError("");
    try {
      await commitMutation(() => managementApi.updateMeetingPreset(preset.id, { expectedRevision: preset.revision, status: "archived" }));
      setSelectedPresetId((current) => activeSelectionAfterArchive(current, preset.id, presets));
      setNotice("Meeting Preset 已封存。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setNotice("Meeting Preset 已封存，但清單刷新失敗；請重新整理以載入最新資料。");
      } else {
        setActionError(managementSaveError(cause, "Meeting Preset", "無法封存 Meeting Preset。"));
      }
    } finally {
      setPending(false);
    }
  }

  async function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const selectedPromptBindingKey = String(data.get("promptBinding") ?? "");
    const selectedPromptBinding = parseAgentPromptBindingKey(selectedPromptBindingKey);
    if (selectedPromptBinding === undefined
      || (selectedPromptBinding !== null && !createPromptOptions.some((option) => option.key === selectedPromptBindingKey))) {
      setActionError("Prompt 綁定格式無效，請重新選擇。");
      return;
    }
    const requestPayload = {
      name: String(data.get("name") ?? ""),
      description: String(data.get("description") ?? ""),
      modelConnectorId: String(data.get("modelConnectorId") ?? "") || null,
      goalSummary: String(data.get("goalSummary") ?? ""),
      toolsSummary: String(data.get("toolsSummary") ?? ""),
      dataSummary: String(data.get("dataSummary") ?? ""),
      runtimeProfileBinding: parseBindingKey(createRuntimeBindingKey),
      promptBinding: selectedPromptBinding,
      skillIds: [],
      toolGrants: [],
      toolPackGrants: []
    };
    const signature = JSON.stringify(requestPayload);
    const retryToken = idempotencyRetryToken(
      agentCreationRetryRef.current,
      signature,
      () => crypto.randomUUID()
    );
    agentCreationRetryRef.current = retryToken;
    setPending(true);
    setActionError("");
    try {
      const created = await mutate<Agent>("/api/agents", {
        method: "POST",
        headers: { "Idempotency-Key": retryToken.idempotencyKey },
        body: JSON.stringify(requestPayload)
      });
      agentCreationRetryRef.current = null;
      selectAgent(created.id);
      setCreateAgentDirty(false);
      setCreateOpen(false);
      setNotice("Agent 已建立。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        agentCreationRetryRef.current = null;
        const created = cause.result as Agent;
        selectAgent(created.id);
        setCreateAgentDirty(false);
        setCreateOpen(false);
        setNotice("Agent 已建立，但清單刷新失敗；請重新整理以載入最新資料。");
      } else {
        if (cause instanceof ApiError && cause.status < 500) agentCreationRetryRef.current = null;
        setActionError(cause instanceof Error ? cause.message : "無法建立 Agent。");
      }
    } finally {
      setPending(false);
    }
  }

  async function updateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent || editingAgentDraftRevision === null) return;
    const data = new FormData(event.currentTarget);
    const selectedPromptBindingKey = String(data.get("promptBinding") ?? "");
    const selectedPromptBinding = parseAgentPromptBindingKey(selectedPromptBindingKey);
    if (selectedPromptBinding === undefined
      || (selectedPromptBinding !== null && !promptOptions.some((option) => option.key === selectedPromptBindingKey))) {
      setActionError("Prompt 綁定格式無效，請重新選擇。");
      return;
    }
    const skillIds = skillRecords
      .filter((skill) => isSkillAssignable(skill) && data.get(`skill:${skill.id}`) === "on")
      .map((skill) => skill.id);
    const toolGrants = approvedToolOptions
      .filter(({ connector, registration }) => data.get(`tool:${connector.id}:${registration.toolName}`) === "on")
      .map(({ connector, registration }) => ({ connectorId: connector.id, toolName: registration.toolName }));
    const toolPackGrants = toolPacks
      .filter((pack) => pack.status === "approved")
      .flatMap((pack) => pack.tools
        .filter((tool) => data.get(`toolpack:${pack.id}:${tool.name}`) === "on")
        .map((tool) => ({
          packId: pack.id,
          revision: pack.revision,
          manifestDigest: pack.manifestDigest,
          toolName: tool.name
        }))
      );
    const submittedDraft: AgentEditableDraft = {
      name: String(data.get("name") ?? ""),
      description: String(data.get("description") ?? ""),
      modelConnectorId: String(data.get("modelConnectorId") ?? "") || null,
      goalSummary: String(data.get("goalSummary") ?? ""),
      toolsSummary: String(data.get("toolsSummary") ?? ""),
      dataSummary: String(data.get("dataSummary") ?? ""),
      runtimeProfileBinding: parseBindingKey(editRuntimeBindingKey),
      promptBinding: selectedPromptBinding,
      skillIds,
      toolGrants,
      toolPackGrants
    };
    setPending(true);
    setActionError("");
    try {
      await mutate(`/api/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedDraftRevision: editingAgentDraftRevision,
          ...submittedDraft
        })
      });
      closeEditAgentModal();
      setNotice(
        unavailableAssignmentCount + unavailableToolGrantCount + unavailableToolPackGrantCount > 0
          ? `Agent 設定已儲存，並移除 ${unavailableAssignmentCount + unavailableToolGrantCount + unavailableToolPackGrantCount} 個不可用指派。`
          : "Agent 設定已儲存。"
      );
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        closeEditAgentModal();
        setNotice("Agent 設定已儲存，但清單刷新失敗；請重新整理以載入最新資料。");
      } else if (isRevisionConflictError(cause)) {
        const baseDraft = agentEditBaseDraft ?? agentEditableDraft(agent);
        setAgentEditDraft(submittedDraft);
        setAgentEditConflictTarget({
          agentId: agent.id,
          previousRevision: editingAgentDraftRevision,
          baseDraft,
          localDraft: submittedDraft
        });
        setActionError("Agent 已由其他分頁更新。正在載入最新 revision，目前草稿仍保留。");
        try {
          await refreshRequired();
        } catch (refreshCause) {
          setActionError(
            `Agent 已由其他分頁更新，目前草稿仍保留，但無法載入最新 revision：${
              refreshCause instanceof Error ? refreshCause.message : "請稍後重試。"
            }`
          );
        }
      } else {
        setActionError(cause instanceof Error ? cause.message : "無法儲存 Agent 設定。");
      }
    } finally {
      setPending(false);
    }
  }

  async function retryAgentEditConflictRefresh() {
    if (!agentEditConflictTarget) return;
    setPending(true);
    setActionError("正在重新載入最新 Agent revision，目前草稿仍保留。");
    try {
      await refreshRequired();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "無法載入最新 Agent revision。");
    } finally {
      setPending(false);
    }
  }

  function openRuntimeEditor(profile?: RuntimeProfile) {
    setEditingRuntimeProfile(profile ?? null);
    setRuntimeDraft(profile ? runtimeDraftFromProfile(profile) : emptyRuntimeDraft);
    setActionError("");
    setRuntimeEditorOpen(true);
  }

  function requestCloseRuntimeEditor() {
    if (pending) return;
    if (runtimeDraftDirty && !window.confirm("Runtime Profile 草稿尚未儲存，確定捨棄？")) return;
    setRuntimeEditorOpen(false);
    setEditingRuntimeProfile(null);
    setRuntimeDraft(emptyRuntimeDraft);
    setActionError("");
  }

  async function saveRuntimeProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = runtimePayloadFromDraft(runtimeDraft);
    if (!payload.name) {
      setActionError("Runtime Profile 名稱不能為空。");
      return;
    }
    if (payload.harnessKind === "pi" && (!ompRuntimeUiEnabled || !payload.modelConnectorId)) {
      setActionError(!ompRuntimeUiEnabled ? "OMP Runtime 尚未通過部署驗證。" : "OMP Runtime 必須綁定模型。");
      return;
    }
    if (editingRuntimeProfile?.enabled && !payload.enabled) {
      const affectedAgents = currentSnapshot.agents.filter((item) => item.runtimeProfileBinding?.profileId === editingRuntimeProfile.id).length;
      if (!window.confirm(`將停用 ${editingRuntimeProfile.name}，目前有 ${affectedAgents} 個 Agent 綁定此 Profile。是否繼續？`)) return;
    }
    setPending(true);
    setActionError("");
    try {
      if (editingRuntimeProfile) {
        await commitMutation(() => managementApi.updateRuntimeProfile(editingRuntimeProfile.id, {
          expectedRevision: editingRuntimeProfile.revision,
          ...payload
        }));
        setNotice("Runtime Profile 已更新，並建立新 revision。");
      } else {
        const signature = JSON.stringify(payload);
        const retryToken = idempotencyRetryToken(
          runtimeProfileCreationRetryRef.current,
          signature,
          () => crypto.randomUUID()
        );
        runtimeProfileCreationRetryRef.current = retryToken;
        const created = await commitMutation(() => (
          managementApi.createRuntimeProfile(payload, retryToken.idempotencyKey)
        ));
        runtimeProfileCreationRetryRef.current = null;
        setSelectedRuntimeProfileId(created.id);
        setNotice("Runtime Profile 已建立。");
      }
      setRuntimeEditorOpen(false);
      setEditingRuntimeProfile(null);
      setRuntimeDraft(emptyRuntimeDraft);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        const committedProfile = cause.result as RuntimeProfile;
        if (!editingRuntimeProfile) {
          runtimeProfileCreationRetryRef.current = null;
          setSelectedRuntimeProfileId(committedProfile.id);
        }
        setRuntimeEditorOpen(false);
        setEditingRuntimeProfile(null);
        setRuntimeDraft(emptyRuntimeDraft);
        setNotice(`Runtime Profile 已${editingRuntimeProfile ? "更新" : "建立"}，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else if (editingRuntimeProfile && cause instanceof ApiError && cause.status === 409) {
        setActionError("stale_snapshot：Runtime Profile 已被更新，請重新載入後再儲存。");
      } else {
        if (!editingRuntimeProfile && cause instanceof ApiError && cause.status < 500) {
          runtimeProfileCreationRetryRef.current = null;
        }
        setActionError(cause instanceof Error ? cause.message : "無法儲存 Runtime Profile。");
      }
    } finally {
      setPending(false);
    }
  }

  async function openRuntimeHistory(profile: RuntimeProfile) {
    const requestToken = runtimeHistoryRequestGateRef.current.begin();
    setRuntimeHistoryLoading(true);
    setActionError("");
    try {
      const nextHistory = await managementApi.getRuntimeProfileRevisions(profile.id);
      if (!runtimeHistoryRequestGateRef.current.isCurrent(requestToken)) return;
      setRuntimeHistoryProfile(profile);
      setRuntimeHistory(nextHistory.sort((left, right) => right.revision - left.revision));
      setRuntimeHistoryOpen(true);
    } catch (cause) {
      if (!runtimeHistoryRequestGateRef.current.isCurrent(requestToken)) return;
      setActionError(cause instanceof Error ? cause.message : "無法讀取 Runtime Profile 版本。");
    } finally {
      if (runtimeHistoryRequestGateRef.current.isCurrent(requestToken)) setRuntimeHistoryLoading(false);
    }
  }

  function selectRuntimeProfile(profileId: string) {
    runtimeHistoryRequestGateRef.current.cancel();
    setRuntimeHistoryLoading(false);
    setRuntimeHistoryOpen(false);
    setSelectedRuntimeProfileId(profileId);
  }

  function closeRuntimeHistoryGate() {
    runtimeHistoryRequestGateRef.current.cancel();
    setRuntimeHistoryLoading(false);
    setRuntimeHistoryOpen(false);
  }

  function selectAgent(agentId: string) {
    setSelectedId(agentId);
    setNotice("");
    setActionError("");
    const params = new URLSearchParams(searchParams.toString());
    params.set("agentId", agentId);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const teamPresetCount = (teamId: string) => presets.filter((preset) => preset.teamId === teamId && preset.status === "active").length;

  const renderAgentSection = () => (
    <div className="agent-layout">
      <aside className="agent-sidebar">
        <div className="side-heading">
          <span>Agents</span>
          <button
            className="icon-button"
            disabled={pending || setupSettingsTab !== null}
            onClick={openCreateAgentModal}
            aria-label="新增 Agent"
            title="新增 Agent"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="agent-roster-tools">
          <label className="search-field">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋 Agent"
              aria-label="搜尋 Agent"
            />
          </label>
          <select
            className="roster-filter"
            value={appliedReadinessFilter}
            onChange={(event) => setReadinessFilter(event.target.value as typeof readinessFilter)}
            aria-label="依 readiness 篩選"
            disabled={rosterReadinessState !== "ready"}
            title={rosterReadinessState === "ready" ? "依已發布 readiness 篩選" : `Readiness ${unavailableReadinessLabel}`}
          >
            <option value="all">全部狀態</option>
            <option value="ready">Ready</option>
            <option value="warning">Warning</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
        <div className="agent-roster-actions">
          <button
            className="secondary-button small"
            type="button"
            disabled={pending || setupSettingsTab !== null}
            onClick={() => {
              setSection("teams");
              setEditingTeam(null);
              setTeamName("");
              setTeamDescription("");
              setTeamMembers({});
              setTeamDraftDirty(false);
              setTeamOpen(true);
            }}
          >
            <Users size={13} />Agent Team
          </button>
          <button
            className="secondary-button small"
            type="button"
            disabled={pending || setupSettingsTab !== null}
            onClick={() => {
              setSection("presets");
              resetPresetDraft();
              setPresetOpen(true);
            }}
          >
            <CalendarCog size={13} />會議範本
          </button>
        </div>
        <div className="agent-roster-list">
          {roster.map(({ agent: item, readiness: itemReadiness }) => {
            const presence = itemReadiness?.status === "ready"
              ? "online"
              : itemReadiness?.status === "blocked"
                ? "offline"
                : "attention";
            const itemReadinessLabel = itemReadiness?.status ?? unavailableReadinessLabel;
            return (
              <button
                type="button"
                className={`agent-row ${item.id === agent?.id ? "active" : ""}`}
                key={item.id}
                disabled={setupSettingsTab !== null}
                onClick={() => selectAgent(item.id)}
              >
                <span className="agent-avatar">{initials(item.name)}</span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </span>
                <i className={`presence ${presence}`} title={`Readiness ${itemReadinessLabel}`} />
              </button>
            );
          })}
        </div>
      </aside>
      <section className="agent-detail">
        {setupSettingsTab && agent ? (
          <SettingsView
            embedded
            initialTab={setupSettingsTab}
            onBack={() => {
              modelHealthRequestRef.current.cancel();
              setSetupSettingsTab(null);
              setConnectionState("idle");
            }}
          />
        ) : agent && (
          <>
            <header className="agent-header">
              <span className="agent-hero-avatar">{initials(agent.name)}</span>
              <div>
                <h1>{agent.name}</h1>
                <p>{agent.description}</p>
                <div className="agent-badges">
                  <span><Bot size={12} />Agent</span>
                  <span><Server size={12} />{effectiveModelLabel}</span>
                  <span className={`state-label ${readinessClass}`}>
                    <ShieldCheck size={12} />
                    {readinessLabel}
                  </span>
                </div>
              </div>
              <div className="agent-head-actions">
                <Link className="secondary-button" href={primaryMeetingHref}>
                  <MessageSquarePlus size={14} />{sourceContext.meetingId ? "返回會議" : "開啟會議"}
                </Link>
                <button className="icon-button" disabled={pending} onClick={openEditAgentModal} aria-label="編輯 Agent" title="編輯 Agent">
                  <Pencil size={15} />
                </button>
              </div>
            </header>
            <ActionNotice message={actionError || notice} error={Boolean(actionError)} />
            <div className="agent-detail-body">
              <section>
                <div className="section-title">
                  <h2>Agent 管理</h2>
                  <span>
                    {agent.lifecycleStatus === "disabled"
                      ? "已停用"
                      : `Rev ${agent.publishedRevision ?? "尚未發布"}${agent.draftRevision && agent.draftRevision !== agent.publishedRevision ? ` · 草稿 Rev ${agent.draftRevision}` : ""}`}
                  </span>
                </div>
                <div className="advanced-strip">
                  <span role="status" aria-live="polite">
                    {selectedEffectiveConfigState === "loading"
                      ? "正在載入 Readiness"
                      : selectedEffectiveConfigState === "unavailable"
                        ? "Readiness 無法取得"
                        : readiness?.checks.filter((check) => check.status === "blocked").length
                      ? <><AlertTriangle size={14} />有阻塞檢查</>
                      : readiness?.status === "ready"
                        ? "可加入會議"
                        : "需要檢查"}
                  </span>
                  <div className="agent-head-actions">
                    <button
                      className="secondary-button small"
                      type="button"
                      disabled={pending || !agent.draftRevision || agent.draftRevision === agent.publishedRevision || agent.lifecycleStatus === "disabled"}
                      onClick={() => void publishAgent()}
                    >
                      <Upload size={13} />發布草稿
                    </button>
                    <button
                      className="secondary-button small"
                      type="button"
                      disabled={pending || !agent.publishedRevision || !agent.draftRevision || agent.draftRevision !== agent.publishedRevision || revisions.length < 2}
                      onClick={() => void rollbackAgent()}
                    >
                      <RotateCcw size={13} />回復
                    </button>
                    <button className="secondary-button small" type="button" disabled={pending || !agentStatusTransition(agent)} onClick={() => void toggleAgentStatus()}>
                      <Power size={13} />{agent.lifecycleStatus === "disabled" ? "啟用" : "停用"}
                    </button>
                  </div>
                </div>
                <AgentSetupPanel
                  rows={setupRows}
                  instructionBudget={meetingSkillInstructionBudget}
                  instructionBudgetLabel={meetingSkillBudgetLabel}
                  connectionState={connectionState}
                  onAction={handleSetupAction}
                />
              </section>
              <section>
                <div className="section-title">
                  <h2>目標／工具／資料</h2>
                </div>
                <AgentCapabilitySummary
                  configuration={selectedEffectiveConfig}
                  state={selectedEffectiveConfigState}
                  relationshipContent={taskRelationshipDetails}
                  onRetry={reloadAgentDetails}
                />
              </section>
            </div>
          </>
        )}
      </section>
    </div>
  );

  const renderTeamsSection = () => (
    <div className="agent-layout">
      <aside className="agent-sidebar">
        <div className="side-heading">
          <span>Teams</span>
          <button
            className="icon-button"
            disabled={pending}
            onClick={() => {
              setEditingTeam(null);
              setTeamName("");
              setTeamDescription("");
              setTeamMembers({});
              setActionError("");
              setTeamDraftDirty(false);
              setTeamOpen(true);
            }}
            aria-label="新增 Team"
            title="新增 Team"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="agent-roster-list">
          {teams.map((team) => (
            <button
              type="button"
              className={`agent-row ${team.id === selectedTeam?.id ? "active" : ""}`}
              key={team.id}
              onClick={() => setSelectedTeamId(team.id)}
            >
              <span className="agent-avatar">{team.members.length}</span>
              <span>
                <strong>{team.name}</strong>
                <small>{team.status === "active" ? "可套用" : "已封存"}</small>
              </span>
              <i className={`presence ${team.status === "active" ? "online" : "offline"}`} />
            </button>
          ))}
        </div>
      </aside>
      <section className="agent-detail">
        <div className="agent-detail-body">
          <ActionNotice message={actionError || notice} error={Boolean(actionError)} />
          {selectedTeam ? (
            <>
              <div className="section-title">
                <h2>{selectedTeam.name}</h2>
                <span>{selectedTeam.status === "active" ? "active" : "archived"}</span>
              </div>
              <div className="advanced-strip">
                <span>{selectedTeam.members.length} 位成員 · {teamPresetCount(selectedTeam.id)} 個 Preset 使用</span>
                <div className="agent-head-actions">
                  <button
                    className="secondary-button small"
                    type="button"
                    disabled={pending || !canEditAgentManagementItem(selectedTeam.status)}
                    title={canEditAgentManagementItem(selectedTeam.status) ? "編輯 Team" : "已封存 Team 不可編輯"}
                    onClick={() => {
                      if (!canEditAgentManagementItem(selectedTeam.status)) return;
                      setEditingTeam(selectedTeam);
                      setTeamName(selectedTeam.name);
                      setTeamDescription(selectedTeam.description);
                      setTeamMembers(Object.fromEntries(selectedTeam.members.map((member) => [
                        member.agentId,
                        { roleId: member.roleId, isChair: member.isChair }
                      ])));
                      setTeamDraftDirty(false);
                      setTeamOpen(true);
                    }}
                  >
                    <Pencil size={13} />編輯
                  </button>
                  <button
                    className="secondary-button small"
                    type="button"
                    disabled={pending || selectedTeam.status !== "active"}
                    onClick={() => void archiveTeam(selectedTeam)}
                  >
                    <Archive size={13} />封存
                  </button>
                </div>
              </div>
              <div className="settings-list">
                {selectedTeam.members.map((member) => {
                  const teamAgent = currentSnapshot.agents.find((item) => item.id === member.agentId);
                  const teamRole = currentSnapshot.roles.find((item) => item.id === member.roleId);
                  const memberReadiness = readinessByAgentId.get(member.agentId);
                  const memberReadinessLabel = memberReadiness?.status ?? unavailableReadinessLabel;
                  return (
                    <div className="settings-row" key={member.agentId}>
                      <span className="row-icon blue"><Users size={15} /></span>
                      <div>
                        <strong>{teamAgent?.name ?? "未知 Agent"}</strong>
                        <p>{teamRole?.name ?? "未知角色"}{member.isChair ? " · 主席" : ""} · {memberReadinessLabel}</p>
                      </div>
                      <span className={`state-label ${memberReadiness?.status === "ready" ? "approved" : memberReadiness?.status === "blocked" ? "disabled" : ""}`}>
                        {memberReadinessLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="runtime-detail-footnotes">{selectedTeam.description}</p>
            </>
          ) : (
            <div className="empty-settings">尚無 Agent Team</div>
          )}
        </div>
      </section>
    </div>
  );

  const renderPresetsSection = () => (
    <div className="agent-layout">
      <aside className="agent-sidebar">
        <div className="side-heading">
          <span>Meeting Presets</span>
          <button
            className="icon-button"
            disabled={pending}
            onClick={() => {
              resetPresetDraft();
              setActionError("");
              setPresetOpen(true);
            }}
            aria-label="新增 Meeting Preset"
            title="新增 Meeting Preset"
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="agent-roster-list">
          {presets.map((preset) => (
            <button
              type="button"
              className={`agent-row ${preset.id === selectedPreset?.id ? "active" : ""}`}
              key={preset.id}
              onClick={() => setSelectedPresetId(preset.id)}
            >
              <span className="agent-avatar">{preset.agendaItems.length}</span>
              <span>
                <strong>{preset.name}</strong>
                <small>{preset.durationMinutes} 分鐘 · {preset.status === "active" ? "可套用" : "已封存"}</small>
              </span>
              <i className={`presence ${preset.status === "active" ? "online" : "offline"}`} />
            </button>
          ))}
        </div>
      </aside>
      <section className="agent-detail">
        <div className="agent-detail-body">
          <ActionNotice message={actionError || notice} error={Boolean(actionError)} />
          {selectedPreset ? (
            <>
              <div className="section-title">
                <h2>{selectedPreset.name}</h2>
                <span>{selectedPreset.status === "active" ? "active" : "archived"}</span>
              </div>
              <div className="advanced-strip">
                <span>{selectedPreset.durationMinutes} 分鐘 · {selectedPreset.agendaItems.length} 項議程 · {selectedPreset.mode}</span>
                <div className="agent-head-actions">
                  <button
                    className="secondary-button small"
                    type="button"
                    disabled={pending || !canEditAgentManagementItem(selectedPreset.status)}
                    title={canEditAgentManagementItem(selectedPreset.status) ? "編輯 Meeting Preset" : "已封存 Meeting Preset 不可編輯"}
                    onClick={() => editPreset(selectedPreset)}
                  >
                    <Pencil size={13} />編輯
                  </button>
                  <button
                    className="secondary-button small"
                    type="button"
                    disabled={pending || selectedPreset.status !== "active"}
                    onClick={() => void archivePreset(selectedPreset)}
                  >
                    <Archive size={13} />封存
                  </button>
                </div>
              </div>
              <div className="settings-list">
                <div className="settings-row">
                  <span className="row-icon blue"><CalendarCog size={15} /></span>
                  <div>
                    <strong>{selectedPreset.teamId ? teams.find((team) => team.id === selectedPreset.teamId)?.name ?? "Team 不存在" : "不指定 Team"}</strong>
                    <p>模式：{selectedPreset.mode} · 主席自動化：{selectedPreset.automation}</p>
                  </div>
                  <span className={`state-label ${presetPreflightUi.className}`}>{presetPreflightUi.label}</span>
                </div>
                {selectedPreset.agendaItems.map((item) => (
                  <div className="settings-row" key={item.title}>
                    <span className="row-icon muted">{item.title.slice(0, 1)}</span>
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.description || "無補充說明"}</p>
                    </div>
                    <span className="state-label">{selectedPreset.durationMinutes}m</span>
                  </div>
                ))}
              </div>
              {presetPreflight && (
                <p className="runtime-detail-footnotes">
                  {presetPreflight.team ? `${presetPreflight.team.name} · ` : ""}{presetPreflight.agents.filter((item) => readinessStatusUi(item.readiness.status).runnable).length} 位可用 Agent
                </p>
              )}
            </>
          ) : (
            <div className="empty-settings">尚無 Meeting Preset</div>
          )}
        </div>
      </section>
    </div>
  );

  const renderRuntimeSection = () => (
    <div className="agent-detail-body agent-runtime-body">
      <ActionNotice message={actionError || notice} error={Boolean(actionError)} />
      <div className="runtime-registry-switch">
        <div className="segmented" role="tablist" aria-label="執行設定類型">
          <button type="button" role="tab" aria-selected={runtimeRegistry === "profiles"} className={runtimeRegistry === "profiles" ? "active" : ""} onClick={() => setRuntimeRegistry("profiles")}>Runtime Profiles</button>
          <button type="button" role="tab" aria-selected={runtimeRegistry === "tool_packs"} className={runtimeRegistry === "tool_packs" ? "active" : ""} onClick={() => {
            closeRuntimeHistoryGate();
            setRuntimeRegistry("tool_packs");
          }}>Tool Packs</button>
        </div>
      </div>
      {runtimeRegistry === "profiles" ? (
        <RuntimeProfileRegistry
          profiles={runtimeProfiles}
          revisions={runtimeRevisions}
          agents={currentSnapshot.agents.map((item) => ({
            id: item.id,
            runtimeProfileBinding: item.runtimeProfileBinding
          }))}
          selectedProfileId={selectedRuntimeProfile?.id ?? null}
          readAgentReadiness={(agentId) => readinessByAgentId.get(agentId) ?? null}
          pending={pending || runtimeHistoryLoading}
          onSelect={selectRuntimeProfile}
          onCreate={() => openRuntimeEditor()}
          onEdit={(profile) => openRuntimeEditor(profile)}
          onHistory={(profile) => void openRuntimeHistory(profile)}
        />
      ) : (
        <ToolPackManagement
          packs={toolPacks}
          revisions={toolPackRevisions}
          agents={currentSnapshot.agents.map((item) => ({
            id: item.id,
            toolPackGrants: item.toolPackGrants
          }))}
          readAgentReadiness={(agentId) => readinessByAgentId.get(agentId) ?? null}
          commitMutation={commitMutation}
          onMessage={(message, isError) => {
            setActionError(isError ? message : "");
            setNotice(isError ? "" : message);
          }}
        />
      )}
    </div>
  );

  return (
    <main className="agent-surface">
      <SourceContextBar source={sourceContext} label="目前從正式會議進入 Agent 管理" />
      <div className="agent-section-tabs" role="tablist" aria-label="Agent 次級導覽">
      {agentSections.map((item) => (
          <button
            key={item.id}
            type="button"
            className={section === item.id ? "active" : ""}
            aria-selected={section === item.id}
            disabled={setupSettingsTab !== null}
            onClick={() => {
              if (section === "runtime") {
                closeRuntimeHistoryGate();
              }
              setSection(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {section === "agents" && renderAgentSection()}
      {section === "teams" && renderTeamsSection()}
      {section === "presets" && renderPresetsSection()}
      {section === "runtime" && renderRuntimeSection()}

      <Modal title="新增 Agent" open={createOpen} onClose={requestCloseCreateAgentModal} closeDisabled={pending} busy={pending}>
        <form className="form-stack" onSubmit={submitAgent} aria-busy={pending} inert={pending ? true : undefined} onChangeCapture={() => setCreateAgentDirty(true)}>
          {actionError && <div className="form-error" role="alert">{actionError}</div>}
          <label>名稱<input name="name" required /></label>
          <label>描述<input name="description" /></label>
          <label>
            模型
            <select name="modelConnectorId">
              <option value="">未設定</option>
              {enabledModelConnectors.map((connector) => (
                <option value={connector.id} key={connector.id}>{connector.name}</option>
              ))}
            </select>
          </label>
          <label>
            執行設定
            <select value={createRuntimeBindingKey} onChange={(event) => setCreateRuntimeBindingKey(event.target.value)}>
              <option value="">稍後綁定</option>
              {runtimeOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt 綁定
            <select name="promptBinding" defaultValue="">
              <option value="">稍後綁定</option>
              {createPromptOptions.map((option) => (
                <option value={option.key} key={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>目標摘要<textarea name="goalSummary" rows={2} required /></label>
          <label>工具摘要<textarea name="toolsSummary" rows={2} required /></label>
          <label>資料摘要<textarea name="dataSummary" rows={2} required /></label>
          <div className="form-actions">
            <button type="button" className="secondary-button" disabled={pending} onClick={requestCloseCreateAgentModal}>取消</button>
            <button className="primary-button" disabled={pending}>{pending ? "建立中" : "建立"}</button>
          </div>
        </form>
      </Modal>

      {agent && (
        <Modal title="編輯 Agent" open={editOpen} onClose={requestCloseEditAgentModal} closeDisabled={pending} busy={pending}>
          <form key={`${agent.id}:${editingAgentDraftRevision ?? "none"}`} className="form-stack" onSubmit={updateAgent} aria-busy={pending} inert={pending ? true : undefined} onChangeCapture={(event) => {
            setEditAgentDirty(true);
            const target = event.target;
            if (!(target instanceof HTMLInputElement) || !target.name.startsWith("skill:")) return;
            setEditSelectedSkillIds(Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[name^="skill:"]:checked')).map((input) => input.name.slice("skill:".length)));
          }}>
            <label>名稱<input name="name" defaultValue={currentAgentEditDraft?.name ?? agent.name} required /></label>
            <label>描述<input name="description" defaultValue={currentAgentEditDraft?.description ?? agent.description} /></label>
            <label>
              模型
              <select name="modelConnectorId" defaultValue={currentAgentEditDraft?.modelConnectorId ?? ""}>
                <option value="">未設定</option>
                {selectableModelConnectors.map((connector) => (
                  <option value={connector.id} key={connector.id} disabled={!connector.enabled}>
                    {connector.name}{connector.enabled ? "" : " · 已停用"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              執行設定
              <select value={editRuntimeBindingKey} onChange={(event) => setEditRuntimeBindingKey(event.target.value)}>
                <option value="">稍後綁定</option>
                {runtimeOptions.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>
              Prompt 綁定
              <select name="promptBinding" defaultValue={serializeAgentPromptBinding(currentAgentEditDraft?.promptBinding)}>
                <option value="">解除 Prompt 綁定</option>
                {promptOptions.map((option) => (
                  <option value={option.key} key={option.key}>{option.label}</option>
                ))}
              </select>
            </label>
            <label>目標摘要<textarea name="goalSummary" rows={2} defaultValue={currentAgentEditDraft?.goalSummary ?? agent.goalSummary} required /></label>
            <label>工具摘要<textarea name="toolsSummary" rows={2} defaultValue={currentAgentEditDraft?.toolsSummary ?? agent.toolsSummary} required /></label>
            <label>資料摘要<textarea name="dataSummary" rows={2} defaultValue={currentAgentEditDraft?.dataSummary ?? agent.dataSummary} required /></label>
            {unavailableAssignmentCount + unavailableToolGrantCount + unavailableToolPackGrantCount > 0 && (
              <div className="form-warning" role="status">
                有 {unavailableAssignmentCount + unavailableToolGrantCount + unavailableToolPackGrantCount} 個既有指派已不可用，儲存時會移除。
              </div>
            )}
            <fieldset>
              <legend>已核准 Skill</legend>
              <div className="check-grid">
                {availableSkills.map((skill) => (
                  <label className="check-row skill-check-row" key={skill.id}>
                    <input type="checkbox" name={`skill:${skill.id}`} defaultChecked={(currentAgentEditDraft?.skillIds ?? agent.skillIds).includes(skill.id)} />
                    <span>
                      <strong>{skill.name} v{skill.version}</strong>
                      <small>來源：{skill.source} · 登記負責人：{skill.owner}</small>
                    </span>
                  </label>
                ))}
                {availableSkills.length === 0 && <span>尚無已核准且驗證通過的 Skill</span>}
              </div>
              <p className={agentEditInstructionBudget.withinLimit ? "agent-skill-budget" : "agent-skill-budget over-budget"}>會議 Skill 指令 {agentEditInstructionBudget.instructionCharacters} / {agentEditInstructionBudget.limit} 字元</p>
            </fieldset>
            <fieldset>
              <legend>已核准 Tool Pack</legend>
              <div className="check-grid">
                {toolPacks
                  .filter((pack) => pack.status === "approved")
                  .flatMap((pack) => pack.tools.map((tool) => (
                    <label className="check-row skill-check-row" key={`${pack.id}:${tool.name}`}>
                      <input
                        type="checkbox"
                        name={`toolpack:${pack.id}:${tool.name}`}
                        defaultChecked={(currentAgentEditDraft?.toolPackGrants ?? agent.toolPackGrants).some((grant) =>
                          grant.packId === pack.id
                          && grant.revision === pack.revision
                          && grant.manifestDigest === pack.manifestDigest
                          && grant.toolName === tool.name
                        )}
                      />
                      <span>
                        <strong>{pack.name} / {tool.name}</strong>
                        <small>v{pack.version} · Rev {pack.revision} · {tool.goal}</small>
                      </span>
                    </label>
                  )))}
                {toolPacks.every((pack) => pack.status !== "approved") && <span>尚無已核准 Tool Pack</span>}
              </div>
            </fieldset>
            <fieldset>
              <legend>唯讀工具</legend>
              <div className="check-grid">
                {approvedToolOptions.map(({ connector, registration }) => (
                      <label className="check-row skill-check-row" key={`${connector.id}:${registration.toolName}`}>
                        <input
                          type="checkbox"
                          name={`tool:${connector.id}:${registration.toolName}`}
                          defaultChecked={(currentAgentEditDraft?.toolGrants ?? agent.toolGrants).some((grant) =>
                            grant.connectorId === connector.id && grant.toolName === registration.toolName
                          )}
                        />
                        <span>
                          <strong>{registration.displayName}</strong>
                          <small>{connector.name} · {toolRegistrationKindLabel(registration.kind)} · {registration.goal}</small>
                        </span>
                      </label>
                    ))}
                {approvedToolOptions.length === 0 && (
                  <span>尚無已核准工具</span>
                )}
              </div>
            </fieldset>
            {actionError && <div className="form-error" role="alert">{actionError}</div>}
            <div className="form-actions">
              <button type="button" className="secondary-button" disabled={pending} onClick={requestCloseEditAgentModal}>取消</button>
              {agentEditConflictTarget && (
                <button type="button" className="secondary-button" disabled={pending} onClick={() => void retryAgentEditConflictRefresh()}>
                  重新載入最新版
                </button>
              )}
              <button className="primary-button" disabled={pending || agentEditConflictTarget !== null}>
                {pending ? "處理中" : agentEditConflictTarget ? "等待最新版" : "儲存"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      <Modal title={editingTeam ? `編輯 ${editingTeam.name}` : "Agent Team 管理"} open={teamOpen} onClose={requestCloseTeamEditor} closeDisabled={pending} busy={pending}>
        <form className="form-stack" onSubmit={createTeam} aria-busy={pending} inert={pending ? true : undefined} onChangeCapture={() => setTeamDraftDirty(true)}>
          {actionError && <div className="form-error" role="alert">{actionError}</div>}
          <label>Team 名稱<input value={teamName} onChange={(event) => setTeamName(event.target.value)} required /></label>
          <label>用途說明<textarea value={teamDescription} onChange={(event) => setTeamDescription(event.target.value)} rows={2} required /></label>
          <fieldset>
            <legend>成員、角色與主席</legend>
            <div className="check-grid">
              {currentSnapshot.agents.map((candidate) => {
                const member = teamMembers[candidate.id] ?? { roleId: "", isChair: false };
                return (
                  <div className="team-member-editor" key={candidate.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(member.roleId)}
                        onChange={(event) => setTeamMembers((current) => ({
                          ...current,
                          [candidate.id]: { ...member, roleId: event.target.checked ? currentSnapshot.roles[0]?.id ?? "" : "" }
                        }))}
                      />
                      {candidate.name}
                    </label>
                    <select
                      aria-label={`${candidate.name} 的角色`}
                      value={member.roleId}
                      onChange={(event) => setTeamMembers((current) => ({
                        ...current,
                        [candidate.id]: { ...member, roleId: event.target.value }
                      }))}
                      disabled={!member.roleId}
                    >
                      <option value="">選擇角色</option>
                      {currentSnapshot.roles.map((role) => (
                        <option value={role.id} key={role.id}>{role.name} · v{role.version}</option>
                      ))}
                    </select>
                    <label>
                      <input
                        type="radio"
                        name="chairAgent"
                        checked={member.isChair}
                        onChange={() => setTeamMembers((current) =>
                          Object.fromEntries(
                            Object.entries(current).map(([id, value]) => [id, { ...value, isChair: id === candidate.id }])
                          )
                        )}
                        disabled={!member.roleId}
                      />
                      主席
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>
          <div className="form-actions">
            <button type="button" className="secondary-button" disabled={pending} onClick={requestCloseTeamEditor}>取消</button>
            <button className="primary-button" disabled={pending}>{pending ? "儲存中" : editingTeam ? "儲存 Team" : "建立 Team"}</button>
          </div>
        </form>
      </Modal>

      <Modal title={editingPreset ? `編輯 ${editingPreset.name}` : "Meeting Preset 管理"} open={presetOpen} onClose={requestClosePresetEditor} closeDisabled={pending} busy={pending}>
        <form className="form-stack" onSubmit={savePreset} aria-busy={pending} inert={pending ? true : undefined} onChangeCapture={() => setPresetDraftDirty(true)}>
          {actionError && <div className="form-error" role="alert">{actionError}</div>}
          <label>Preset 名稱<input value={presetName} onChange={(event) => setPresetName(event.target.value)} required /></label>
          <label>用途說明<textarea value={presetDescription} onChange={(event) => setPresetDescription(event.target.value)} rows={2} required /></label>
          <div className="form-grid">
            <label>
              Agent Team
              <select value={presetTeamId} onChange={(event) => setPresetTeamId(event.target.value)}>
                <option value="">不指定 Team</option>
                {teams.filter((team) => team.status === "active").map((team) => (
                  <option value={team.id} key={team.id}>{team.name}</option>
                ))}
              </select>
            </label>
            <label>
              時長（分鐘）
              <input type="number" min={5} max={240} step={5} value={presetDuration} onChange={(event) => setPresetDuration(Number(event.target.value))} required />
            </label>
            <label>
              會議模式
              <select value={presetMode} onChange={(event) => setPresetMode(event.target.value as MeetingPreset["mode"])}>
                <option value="chaired">主席</option>
                <option value="open">開放</option>
                <option value="fixed">固定順序</option>
              </select>
            </label>
            <label>
              主席自動化
              <select value={presetAutomation} onChange={(event) => setPresetAutomation(event.target.value as MeetingPreset["automation"])}>
                <option value="manual">手動</option>
                <option value="suggest">建議</option>
                <option value="auto">自動</option>
              </select>
            </label>
          </div>
          <fieldset>
            <legend>議程（{presetAgenda.length}/12）</legend>
            {presetAgenda.map((item, index) => (
              <div className="form-grid" key={index}>
                <label>標題<input value={item.title} onChange={(event) => updatePresetAgenda(index, "title", event.target.value)} required /></label>
                <label>說明<input value={item.description} onChange={(event) => updatePresetAgenda(index, "description", event.target.value)} /></label>
                {presetAgenda.length > 1 && (
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => { setPresetDraftDirty(true); setPresetAgenda((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}
                    aria-label={`移除議程 ${index + 1}`}
                    title={`移除議程 ${index + 1}`}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            {presetAgenda.length < 12 && (
              <button className="secondary-button small" type="button" onClick={() => { setPresetDraftDirty(true); setPresetAgenda((current) => [...current, { title: "", description: "" }]); }}>
                <Plus size={13} />新增議程
              </button>
            )}
          </fieldset>
          <div className="form-actions">
            <button type="button" className="secondary-button" disabled={pending} onClick={requestClosePresetEditor}>取消</button>
            <button className="primary-button" disabled={pending}>{pending ? "儲存中" : editingPreset ? "儲存 Preset" : "建立 Preset"}</button>
          </div>
        </form>
      </Modal>

      <Modal title={editingRuntimeProfile ? `編輯 ${editingRuntimeProfile.name}` : "新增 Runtime Profile"} open={runtimeEditorOpen} onClose={requestCloseRuntimeEditor} closeDisabled={pending} busy={pending}>
        <form className="form-stack" onSubmit={saveRuntimeProfile} aria-busy={pending} inert={pending ? true : undefined}>
          {actionError && <div className="form-error" role="alert">{actionError}</div>}
          <label>名稱<input value={runtimeDraft.name} onChange={(event) => setRuntimeDraft((current) => ({ ...current, name: event.target.value }))} required /></label>
          <div className="form-grid">
            <label>
              Harness
              <select
                value={runtimeDraft.harnessKind}
                onChange={(event) => {
                  const harnessKind = event.target.value as RuntimeHarnessKind;
                  setRuntimeDraft((current) => harnessKind === "pi"
                    ? {
                        ...current,
                        harnessKind,
                        policy: "isolated_exec",
                        capabilities: ["text", "abort", "resume", "file_read", "file_write", "process"],
                        timeoutSeconds: Math.max(1800, current.timeoutSeconds),
                        maxConcurrency: Math.min(2, current.maxConcurrency)
                      }
                    : {
                        ...current,
                        harnessKind,
                        policy: current.policy === "isolated_exec" ? "read_only_tools" : current.policy,
                        capabilities: normalizeRuntimeCapabilities(
                          current.policy === "isolated_exec" ? "read_only_tools" : current.policy,
                          current.capabilities
                        ),
                        timeoutSeconds: Math.min(900, current.timeoutSeconds)
                      });
                }}
              >
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="codex">Codex</option>
                <option value="pi" disabled={!ompRuntimeUiEnabled}>OMP (Pi-compatible){ompRuntimeUiEnabled ? "" : " · unavailable"}</option>
              </select>
            </label>
            <label>
              Policy
              <select
                value={runtimeDraft.policy}
                onChange={(event) => {
                  const policy = event.target.value as RuntimePolicy;
                  setRuntimeDraft((current) => ({
                    ...current,
                    policy,
                    capabilities: normalizeRuntimeCapabilities(policy, current.capabilities)
                  }));
                }}
              >
                <option value="text_only">text_only</option>
                <option value="read_only_tools">read_only_tools</option>
                <option value="isolated_exec" disabled={!ompRuntimeUiEnabled || runtimeDraft.harnessKind !== "pi"}>isolated_exec · rootless</option>
              </select>
            </label>
            <label>
              模型限制
              <select required={runtimeDraft.harnessKind === "pi"} value={runtimeDraft.modelConnectorId} onChange={(event) => setRuntimeDraft((current) => ({ ...current, modelConnectorId: event.target.value }))}>
                <option value="">沿用 Agent Model Connector</option>
                {currentSnapshot.modelConnectors.map((connector) => (
                  <option key={connector.id} value={connector.id}>{connector.name}{connector.enabled ? "" : " · 已停用"}</option>
                ))}
              </select>
            </label>
            <label>
              Timeout（秒）
              <input
                type="number"
                min={runtimeDraft.harnessKind === "pi" ? 1800 : 1}
                max={runtimeDraft.harnessKind === "pi" ? 43200 : 900}
                value={runtimeDraft.timeoutSeconds}
                onChange={(event) => setRuntimeDraft((current) => ({ ...current, timeoutSeconds: Number(event.target.value) || 1 }))}
                required
              />
            </label>
            <label>
              並行上限
              <input
                type="number"
                min={1}
                max={runtimeDraft.harnessKind === "pi" ? 2 : 10}
                value={runtimeDraft.maxConcurrency}
                onChange={(event) => setRuntimeDraft((current) => ({ ...current, maxConcurrency: Number(event.target.value) || 1 }))}
                required
              />
            </label>
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={runtimeDraft.enabled}
                onChange={(event) => setRuntimeDraft((current) => ({ ...current, enabled: event.target.checked }))}
              />
              enabled
            </label>
          </div>
          <fieldset>
            <legend>能力</legend>
            <div className="check-grid">
              {allowedRuntimeCapabilities(runtimeDraft.policy).map((capability) => {
                const checked = runtimeDraft.capabilities.includes(capability);
                return (
                  <label className="check-row skill-check-row" key={capability}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => setRuntimeDraft((current) => ({
                        ...current,
                        capabilities: event.target.checked
                          ? normalizeRuntimeCapabilities(current.policy, [...current.capabilities, capability])
                          : normalizeRuntimeCapabilities(current.policy, current.capabilities.filter((item) => item !== capability))
                      }))}
                    />
                    <span>
                      <strong>{formatRuntimeCapabilitySummary([capability])}</strong>
                      <small>{runtimeDraft.policy}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="form-warning" role="status">
            {runtimeHarnessLabel(runtimeDraft.harnessKind)} · {runtimePolicyLabel(runtimeDraft.policy)} · {formatRuntimeTimeout(runtimeDraft.timeoutSeconds * 1000)}
          </div>
          <div className="form-actions">
            <button type="button" className="secondary-button" disabled={pending} onClick={requestCloseRuntimeEditor}>取消</button>
            <button className="primary-button" disabled={pending}>{pending ? "儲存中" : editingRuntimeProfile ? "儲存 Profile" : "建立 Profile"}</button>
          </div>
        </form>
      </Modal>

      <Modal title={runtimeHistoryProfile ? `${runtimeHistoryProfile.name} 版本` : "Runtime Profile 版本"} open={runtimeHistoryOpen} onClose={() => { if (!pending) closeRuntimeHistoryGate(); }}>
        <div className="role-lifecycle-panel">
          <ul className="role-version-list">
            {runtimeHistory.map((revision) => (
              <li key={`${revision.profileId}:${revision.revision}`}>
                <div>
                  <strong>Rev {revision.revision}</strong>
                  <span>{runtimeHarnessLabel(revision.harnessKind)}</span>
                  <span>{runtimePolicyLabel(revision.policy)}</span>
                  <span>{revision.enabled ? "enabled" : "disabled"}</span>
                </div>
                <time dateTime={revision.recordedAt}>{new Date(revision.recordedAt).toLocaleString("zh-TW")}</time>
              </li>
            ))}
          </ul>
        </div>
      </Modal>
    </main>
  );
}
