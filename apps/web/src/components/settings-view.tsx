"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Archive, ArrowLeft, Bot, Braces, CheckCircle2, ClipboardCheck, Cloud, FileText, History, KeyRound, LoaderCircle, Network, Pencil, Plus, RotateCcw, Server, ShieldCheck, ServerCog, Trash2, UserRoundCog, XCircle } from "lucide-react";
import {
  builtInRoleTemplates,
  defaultRoleBehavior,
  roleAllowsExternalTools,
  type DiscoveredMcpTool,
  type Credential,
  type McpConnector,
  type McpDiscoveryResponse,
  type McpConnectorUpdateResult,
  type ModelConnector,
  type Role,
  type RoleDataPolicy,
  type RoleLifecycleView,
  type RoleTemplateKey,
  type RoleToolPolicy,
  type PromptTemplate,
  type PromptVersion,
  type ToolRegistration,
  type ToolRegistrationKind
} from "@council/contracts";
import { CommittedMutationProjectionError, usePlatform } from "../app/providers";
import { ApiError, apiRequest, isRevisionConflictError, managementApi, type CredentialInput, type PromptInput } from "../lib/api";
import { getSettingsNavigation, promptLifecycleActions } from "../lib/management-ui";
import { managementMutationRetryDisposition } from "../lib/management-mutation-recovery";
import { ManagementMutationRetryOwnership, ManagementMutationRetrySignature } from "../lib/management-mutation-retry";
import { LatestRequestGate } from "../lib/latest-request";
import { roleUsageSummary, roleVersionDifferences, roleVersionSourceLabel } from "../lib/role-ui";
import { changedConnectorFields, credentialExpiryIso, modelCredentialSubmission, promptVersionForEdit, rebaseConnectorRevision, selectableModelCredentials } from "../lib/settings-form";
import { mergeRoleDraftAfterConflict, roleCreateRequestPayload } from "../lib/settings-role-ui";
import { projectionFreshnessLabel } from "../lib/platform-projection";
import { clampText, IdempotencyRetryRegistry, normalizeSkill, skillLifecycleState, toolRegistrationKindLabel, type IdempotencyRetryToken, type SkillRecord, type SkillSnapshotEntry, type SkillValidationResult } from "../lib/view-model";
import { ActionNotice, Modal, PageState, ProjectionFreshnessWarning } from "./ui";

export type SettingsTab = "roles" | "skills" | "prompts" | "models" | "credentials" | "mcp" | "task_adapters" | "harness";
type Tab = SettingsTab;
const tabs: Array<{ id: Tab; label: string; icon: typeof Bot }> = [
  { id: "roles", label: "角色", icon: UserRoundCog },
  { id: "skills", label: "Skill", icon: Braces },
  { id: "prompts", label: "Prompt", icon: FileText },
  { id: "models", label: "模型", icon: Cloud },
  { id: "credentials", label: "API 金鑰", icon: KeyRound },
  { id: "mcp", label: "MCP", icon: Network },
  { id: "task_adapters", label: "Task Adapter", icon: ServerCog },
  { id: "harness", label: "Harness", icon: ShieldCheck }
];

type RoleDraft = Pick<Role, "name" | "usageContext" | "responsibility" | "speakingGuidance" | "decisionScope" | "constraints" | "templateKey" | "toolPolicy" | "dataPolicy">;
type RoleLifecycleMode = "history" | "confirm_rollback" | "confirm_delete";
type RoleConflictTarget = {
  id: string;
  previousVersion: number;
};
type ConnectorConflictTarget = {
  kind: "model" | "mcp";
  id: string;
  previousRevision: number;
};

const emptyRoleDraft: RoleDraft = {
  name: "",
  usageContext: "",
  responsibility: "",
  speakingGuidance: defaultRoleBehavior.speakingGuidance,
  decisionScope: defaultRoleBehavior.decisionScope,
  constraints: defaultRoleBehavior.constraints,
  templateKey: null,
  toolPolicy: "none",
  dataPolicy: "meeting_only"
};

const roleToolLabels: Record<RoleToolPolicy, string> = {
  none: "不使用外部工具",
  agent_read_only_grants: "Agent 已授權唯讀工具"
};
const roleDataLabels: Record<RoleDataPolicy, string> = {
  meeting_only: "只限本場會議",
  agent_declared_scope: "Agent 宣告資料範圍"
};
const roleDraftFieldLabels: Record<keyof RoleDraft, string> = {
  name: "名稱",
  usageContext: "使用情境",
  responsibility: "責任",
  speakingGuidance: "發言準則",
  decisionScope: "決策範圍",
  constraints: "限制",
  templateKey: "角色範本",
  toolPolicy: "工具政策",
  dataPolicy: "資料政策"
};
const toolKinds = ["mcp_tool", "function_wrapper", "library_wrapper", "program_adapter", "api_wrapper"] as const satisfies readonly ToolRegistrationKind[];

function roleTemplateLabel(key: RoleTemplateKey | null): string {
  return builtInRoleTemplates.find((template) => template.key === key)?.name ?? "自訂";
}

function draftFromRole(role: Role): RoleDraft {
  const { name, usageContext, responsibility, speakingGuidance, decisionScope, constraints, templateKey, toolPolicy, dataPolicy } = role;
  return { name, usageContext, responsibility, speakingGuidance, decisionScope, constraints, templateKey, toolPolicy, dataPolicy };
}

const roleMeetingStateLabels = { draft: "尚未開始", active: "進行中", paused: "已暫停", closed: "已結束" } as const;

function formatRoleVersionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時間未知";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function RoleBehaviorDetails({ roleName, speakingGuidance, decisionScope, constraints }: {
  roleName: string;
  speakingGuidance: string;
  decisionScope: string;
  constraints: string;
}) {
  return <details className="role-behavior-details">
    <summary><span>角色行為邊界</span><small>{roleName} · 3 項</small></summary>
    <dl className="role-behavior-summary">
      <div><dt>發言準則</dt><dd>{speakingGuidance}</dd></div>
      <div><dt>決策範圍</dt><dd>{decisionScope}</dd></div>
      <div><dt>限制</dt><dd>{constraints}</dd></div>
    </dl>
  </details>;
}

export function SettingsView({ initialTab, embedded = false, onBack }: {
  initialTab?: SettingsTab;
  embedded?: boolean;
  onBack?: () => void;
} = {}) {
  const {
    platformProjectionStale,
    platformProjectionRefreshing,
    platformProjectionLastSuccessfulAt,
    snapshot,
    loading,
    error,
    mutate,
    commitMutation,
    refreshRequired
  } = usePlatform();
  const [tab, setTab] = useState<Tab>(initialTab ?? (embedded ? "models" : "roles"));
  const [createOpen, setCreateOpen] = useState(false);
  const [resourceDraftDirty, setResourceDraftDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const connectorHealthRequest = useRef(new LatestRequestGate());
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [roleDraft, setRoleDraft] = useState<RoleDraft>(emptyRoleDraft);
  const roleCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const skillCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const promptCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const credentialCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const credentialRotationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const modelCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const mcpCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const taskAdapterCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const managementMutationRetrySignatureRef = useRef(new ManagementMutationRetrySignature());
  const managementMutationRetryOwnershipRef = useRef(new ManagementMutationRetryOwnership());
  const [roleConflictTarget, setRoleConflictTarget] = useState<RoleConflictTarget | null>(null);
  const [selectedRoleTemplate, setSelectedRoleTemplate] = useState<RoleTemplateKey | "">("");
  const [lifecycleRole, setLifecycleRole] = useState<Role | null>(null);
  const [roleLifecycle, setRoleLifecycle] = useState<RoleLifecycleView | null>(null);
  const [roleLifecycleMode, setRoleLifecycleMode] = useState<RoleLifecycleMode>("history");
  const [selectedRoleVersion, setSelectedRoleVersion] = useState<number | null>(null);
  const [roleLifecycleLoading, setRoleLifecycleLoading] = useState(false);
  const [roleLifecycleError, setRoleLifecycleError] = useState("");
  const [roleDeleteConfirmation, setRoleDeleteConfirmation] = useState("");
  const roleLifecycleRequestId = useRef(0);
  const [editingModel, setEditingModel] = useState<ModelConnector | null>(null);
  const [editingMcp, setEditingMcp] = useState<McpConnector | null>(null);
  const [connectorConflictTarget, setConnectorConflictTarget] = useState<ConnectorConflictTarget | null>(null);
  const [editingTool, setEditingTool] = useState<{ connectorId: string; registration: ToolRegistration } | null>(null);
  const [toolRegistrationDirty, setToolRegistrationDirty] = useState(false);
  const [validationSkill, setValidationSkill] = useState<SkillRecord | null>(null);
  const [skillValidationDraftDirty, setSkillValidationDraftDirty] = useState(false);
  const [skillToRevoke, setSkillToRevoke] = useState<SkillRecord | null>(null);
  const [skillRevocationDraftDirty, setSkillRevocationDraftDirty] = useState(false);
  const [discoveredMcpTools, setDiscoveredMcpTools] = useState<Record<string, DiscoveredMcpTool[]>>({});
  const mcpDiscoveryRequest = useRef(new LatestRequestGate());
  const [editingCredential, setEditingCredential] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const promptEditorRequest = useRef(new LatestRequestGate());
  const promptLifecycleRequest = useRef(new LatestRequestGate());
  const [promptEditorBusy, setPromptEditorBusy] = useState<string | null>(null);
  const [promptVersions, setPromptVersions] = useState<Record<string, PromptVersion[]>>({});
  const [promptVersionBusy, setPromptVersionBusy] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState<PromptInput>({ name: "", kind: "agent", description: "", owner: "Platform Owner", content: "", variables: [] });
  const [promptPreviewId, setPromptPreviewId] = useState("");
  const [promptPreview, setPromptPreview] = useState<{ prompt: PromptTemplate; version: number; variables: string[] } | null>(null);
  const [promptPreviewValues, setPromptPreviewValues] = useState<Record<string, string>>({});
  const [promptPreviewOutput, setPromptPreviewOutput] = useState("");
  const [promptPreviewError, setPromptPreviewError] = useState("");
  const [promptPreviewPending, setPromptPreviewPending] = useState(false);
  const promptPreviewRequest = useRef(new LatestRequestGate());

  useEffect(() => {
    if (!notice || actionError) return;
    const timer = window.setTimeout(() => setNotice(""), 3_500);
    return () => window.clearTimeout(timer);
  }, [actionError, notice]);

  useEffect(() => {
    if (!promptPreviewId && snapshot?.prompts?.[0]) setPromptPreviewId(snapshot.prompts[0].id);
  }, [promptPreviewId, snapshot]);

  useEffect(() => {
    if (!validationSkill || !snapshot) return;
    const sourceSkill = snapshot.skills.find((skill) => skill.id === validationSkill.id);
    if (!sourceSkill) {
      setSkillValidationDraftDirty(false);
      setValidationSkill(null);
      return;
    }
    const current = normalizeSkill(sourceSkill as SkillSnapshotEntry);
    if (current.validation.checkedAt === validationSkill.validation.checkedAt
      && current.status === validationSkill.status) return;
    setValidationSkill(current);
  }, [snapshot, validationSkill]);

  useEffect(() => {
    if (!roleConflictTarget || !snapshot || !editingRole || editingRole.id !== roleConflictTarget.id) return;
    const latest = snapshot.roles.find((role) => role.id === roleConflictTarget.id);
    if (!latest || latest.version <= roleConflictTarget.previousVersion) return;

    const merged = mergeRoleDraftAfterConflict(draftFromRole(editingRole), roleDraft, draftFromRole(latest));
    setEditingRole(latest);
    setRoleDraft(merged.draft);
    setRoleConflictTarget(null);
    setActionError(merged.conflictingFields.length > 0
      ? `角色已載入最新 v${latest.version}。未衝突的草稿已合併；${merged.conflictingFields.map((field) => roleDraftFieldLabels[field]).join("、")} 同時被修改，已保留伺服器版本，請確認後再儲存。`
      : `角色已載入最新 v${latest.version}，未衝突的草稿已合併，請確認後再儲存。`);
  }, [editingRole, roleConflictTarget, roleDraft, snapshot]);

  useEffect(() => {
    if (!connectorConflictTarget || !snapshot) return;
    const latest = connectorConflictTarget.kind === "model"
      ? snapshot.modelConnectors.find((connector) => connector.id === connectorConflictTarget.id)
      : snapshot.mcpConnectors.find((connector) => connector.id === connectorConflictTarget.id);
    if (!latest || latest.revision <= connectorConflictTarget.previousRevision) return;

    if (connectorConflictTarget.kind === "model") {
      setEditingModel((current) => current && current.id === latest.id
        ? rebaseConnectorRevision(current, latest as ModelConnector)
        : current);
    } else {
      setEditingMcp((current) => current && current.id === latest.id
        ? rebaseConnectorRevision(current, latest as McpConnector)
        : current);
    }
    setConnectorConflictTarget(null);
    setActionError(`Connector 設定已由其他分頁更新。已載入最新 revision ${latest.revision}；目前草稿仍保留，再次儲存只會送出本機實際修改的欄位。`);
  }, [connectorConflictTarget, snapshot]);

  if (loading || error || !snapshot) return <PageState loading={loading} error={error} />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || roleConflictTarget || connectorConflictTarget) return;
    const data = new FormData(event.currentTarget);
    const editing = tab === "roles" ? editingRole : tab === "models" ? editingModel : tab === "mcp" ? editingMcp : null;
    let retryOwnership: { registry: IdempotencyRetryRegistry; token: IdempotencyRetryToken } | null = null;
    setPendingAction(editingRole ? `role:${editingRole.id}` : editingModel ? `model:${editingModel.id}` : editingMcp ? `mcp:${editingMcp.id}` : "create");
    setActionError("");
    try {
      let successMessage = editing ? "設定已更新。" : "設定已建立。";
      if (tab === "roles") {
        if (editingRole) {
          const body = JSON.stringify({
            name: roleDraft.name,
            usageContext: roleDraft.usageContext,
            responsibility: roleDraft.responsibility,
            speakingGuidance: roleDraft.speakingGuidance,
            decisionScope: roleDraft.decisionScope,
            constraints: roleDraft.constraints,
            toolPolicy: roleDraft.toolPolicy,
            dataPolicy: roleDraft.dataPolicy,
            expectedCurrentVersion: editingRole.version
          });
          const result = await mutate<Role>(`/api/roles/${editingRole.id}`, { method: "PATCH", body });
          successMessage = `角色已更新為 v${result.version}；既有會議維持原版本。`;
        } else {
          const requestPayload = roleCreateRequestPayload(roleDraft);
          const signature = await managementMutationRetrySignatureRef.current.forPayload("role.create", requestPayload);
          const retryToken = roleCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
          retryOwnership = { registry: roleCreationRetryRegistryRef.current, token: retryToken };
          const result = await mutate<Role>("/api/roles", {
            method: "POST",
            headers: { "Idempotency-Key": retryToken.idempotencyKey },
            body: JSON.stringify(requestPayload)
          });
          successMessage = `角色已建立為 v${result.version}。`;
        }
      }
      if (tab === "skills") {
        const requestPayload = {
          name: String(data.get("name")),
          version: String(data.get("version")),
          instructions: String(data.get("instructions")),
          source: String(data.get("source")),
          owner: String(data.get("owner"))
        };
        const signature = await managementMutationRetrySignatureRef.current.forPayload("skill.create", requestPayload);
        const retryToken = skillCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
        retryOwnership = { registry: skillCreationRetryRegistryRef.current, token: retryToken };
        await mutate("/api/skills", {
          method: "POST",
          headers: { "Idempotency-Key": retryToken.idempotencyKey },
          body: JSON.stringify(requestPayload)
        });
      }
      if (tab === "credentials") {
        const credentialInput: CredentialInput = {
          name: String(data.get("name")),
          provider: String(data.get("provider")),
          kind: String(data.get("kind")) as CredentialInput["kind"],
          location: String(data.get("location")) as CredentialInput["location"],
          ...(String(data.get("secret") ?? "") ? { secret: String(data.get("secret")) } : {}),
          expiresAt: credentialExpiryIso(data.get("expiresAt"))
        };
        if (editingCredential) {
          const credential = snapshot.credentials?.find((item) => item.id === editingCredential);
          if (!credential) throw new Error("找不到 Credential。");
          if (!credentialInput.secret) throw new Error("輪替 Credential 必須輸入新的密鑰。");
          const requestPayload = {
            credentialId: credential.id,
            expectedSecretRevision: credential.secretRevision,
            secret: credentialInput.secret
          };
          const signature = await managementMutationRetrySignatureRef.current.forPayload("credential.rotate", requestPayload);
          const retryToken = credentialRotationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
          retryOwnership = { registry: credentialRotationRetryRegistryRef.current, token: retryToken };
          await commitMutation(() => managementApi.rotateCredential(requestPayload.credentialId, requestPayload.secret, requestPayload.expectedSecretRevision, retryToken.idempotencyKey));
          successMessage = "Credential 已輪替；畫面只保留安全 metadata。";
        } else {
          const requestPayload = credentialInput;
          const signature = await managementMutationRetrySignatureRef.current.forPayload("credential.create", requestPayload);
          const retryToken = credentialCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
          retryOwnership = { registry: credentialCreationRetryRegistryRef.current, token: retryToken };
          await commitMutation(() => managementApi.createCredential(requestPayload, retryToken.idempotencyKey));
          successMessage = "Credential 已建立；密鑰不會回傳或顯示。";
        }
      }
      if (tab === "prompts") {
        const variables = String(data.get("variables") ?? "").split(",").map((item) => item.trim()).filter(Boolean);
        if (editingPrompt) {
          const prompt = snapshot.prompts?.find((item) => item.id === editingPrompt);
          if (!prompt) throw new Error("找不到 Prompt。");
          await commitMutation(() => managementApi.updatePrompt(prompt.id, prompt.currentVersion, {
            name: String(data.get("name")),
            kind: String(data.get("kind")) as PromptInput["kind"],
            description: String(data.get("description")),
            owner: String(data.get("owner")),
            content: String(data.get("content")),
            variables
          }));
          successMessage = `Prompt 已建立 v${prompt.currentVersion + 1} 草稿。`;
        } else {
          const requestPayload = {
            ...promptDraft,
            name: String(data.get("name")),
            kind: String(data.get("kind")) as PromptInput["kind"],
            description: String(data.get("description")),
            owner: String(data.get("owner")),
            content: String(data.get("content")),
            variables
          };
          const signature = await managementMutationRetrySignatureRef.current.forPayload("prompt.create", requestPayload);
          const retryToken = promptCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
          retryOwnership = { registry: promptCreationRetryRegistryRef.current, token: retryToken };
          await commitMutation(() => managementApi.createPrompt(requestPayload, retryToken.idempotencyKey));
          successMessage = "Prompt 已建立為草稿。";
        }
      }
      if (tab === "models") {
        const draft = {
          name: String(data.get("name")),
          location: String(data.get("location")) as ModelConnector["location"],
          baseUrl: String(data.get("baseUrl")),
          model: String(data.get("model")),
          enabled: data.get("enabled") === "on"
        };
        const credentialChange = modelCredentialSubmission(data.get("credentialId"), editingModel?.credentialId);
        if (editingModel) {
          const changes = {
            ...changedConnectorFields(editingModel, { ...editingModel, ...draft }, [
              "name",
              "location",
              "baseUrl",
              "model",
              "enabled"
            ]),
            ...credentialChange
          };
          if (Object.keys(changes).length === 0) {
            successMessage = "模型 Connector 沒有設定變更。";
          } else {
            const result = await mutate<ModelConnector & { assignedAgentCount: number }>(`/api/model-connectors/${editingModel.id}`, {
              method: "PATCH",
              body: JSON.stringify({ expectedRevision: editingModel.revision, ...changes })
            });
            successMessage = result.enabled
              ? "模型 Connector 已更新。"
              : `模型 Connector 已停用，${result.assignedAgentCount} 個 Agent 暫時不可執行。`;
          }
        } else {
          const requestPayload = {
            name: draft.name,
            location: draft.location,
            baseUrl: draft.baseUrl,
            model: draft.model,
            ...credentialChange
          };
          const signature = await managementMutationRetrySignatureRef.current.forPayload("model-connector.create", requestPayload);
          const retryToken = modelCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
          retryOwnership = { registry: modelCreationRetryRegistryRef.current, token: retryToken };
          await mutate("/api/model-connectors", {
            method: "POST",
            headers: { "Idempotency-Key": retryToken.idempotencyKey },
            body: JSON.stringify(requestPayload)
          });
        }
      }
      if (tab === "mcp") {
        const discovered = editingMcp ? discoveredMcpTools[editingMcp.id] : undefined;
        const selectedTools = discovered ? data.getAll("approvedTool").map(String) : undefined;
        const toolRegistrations = selectedTools?.map((toolName) => {
          const existing = editingMcp?.toolRegistrations.find((registration) => registration.toolName === toolName);
          const discoveredTool = discovered?.find((tool) => tool.name === toolName);
          return existing ?? {
            toolName,
            displayName: toolName,
            kind: "mcp_tool" as const,
            version: "unversioned",
            owner: "Platform Owner",
            goal: discoveredTool?.description?.trim().slice(0, 2_000) || `以唯讀方式執行 ${toolName}。`
          };
        });
        const draft = {
          name: String(data.get("name")),
          location: String(data.get("location")) as McpConnector["location"],
          baseUrl: String(data.get("baseUrl")),
          enabled: data.get("enabled") === "on"
        };
        const bearerToken = String(data.get("bearerToken") ?? "").trim() || undefined;
        if (editingMcp) {
          const changes = {
            ...changedConnectorFields(editingMcp, { ...editingMcp, ...draft }, [
              "name",
              "location",
              "baseUrl",
              "enabled"
            ]),
            ...(selectedTools ? changedConnectorFields(
              editingMcp,
              { ...editingMcp, approvedTools: selectedTools, toolRegistrations: toolRegistrations ?? [] },
              ["approvedTools", "toolRegistrations"]
            ) : {}),
            ...(bearerToken ? { bearerToken } : {})
          };
          if (Object.keys(changes).length === 0) {
            successMessage = "MCP Connector 沒有設定變更。";
          } else {
            const result = await mutate<McpConnectorUpdateResult>(`/api/mcp-connectors/${editingMcp.id}`, {
              method: "PATCH",
              body: JSON.stringify({ expectedRevision: editingMcp.revision, ...changes })
            });
            successMessage = result.revokedGrantCount > 0
              ? `MCP 已更新，並撤銷 ${result.revokedGrantCount} 個失效工具授權。`
              : "MCP 已更新。";
          }
        } else {
          const requestPayload = {
            name: draft.name,
            location: draft.location,
            baseUrl: draft.baseUrl,
            approvedTools: selectedTools ?? [],
            toolRegistrations: toolRegistrations ?? [],
            ...(bearerToken ? { bearerToken } : {})
          };
          const signature = await managementMutationRetrySignatureRef.current.forPayload("mcp-connector.create", requestPayload);
          const retryToken = mcpCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
          retryOwnership = { registry: mcpCreationRetryRegistryRef.current, token: retryToken };
          await mutate("/api/mcp-connectors", {
            method: "POST",
            headers: { "Idempotency-Key": retryToken.idempotencyKey },
            body: JSON.stringify(requestPayload)
          });
        }
      }
      if (tab === "task_adapters") {
        const requestPayload = {
          name: data.get("name"),
          location: data.get("location"),
          baseUrl: data.get("baseUrl"),
          bearerToken: data.get("bearerToken") || undefined
        };
        const signature = await managementMutationRetrySignatureRef.current.forPayload("task-adapter-connector.create", requestPayload);
        const retryToken = taskAdapterCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
        retryOwnership = { registry: taskAdapterCreationRetryRegistryRef.current, token: retryToken };
        await mutate("/api/task-adapter-connectors", {
          method: "POST",
          headers: { "Idempotency-Key": retryToken.idempotencyKey },
          body: JSON.stringify(requestPayload)
        });
      }
      if (retryOwnership) retryOwnership.registry.settle(retryOwnership.token);
      setResourceDraftDirty(false);
      setCreateOpen(false);
      setValidationSkill(null);
      setSkillToRevoke(null);
      setEditingRole(null);
      setRoleConflictTarget(null);
      setEditingModel(null);
      setEditingMcp(null);
      setConnectorConflictTarget(null);
      setEditingCredential(null);
      setEditingPrompt(null);
      setNotice(successMessage);
    } catch (cause) {
      if (tab === "roles" && cause instanceof CommittedMutationProjectionError) {
        const committedRole = cause.result as Role;
        if (retryOwnership) retryOwnership.registry.settle(retryOwnership.token);
        setResourceDraftDirty(false);
        setCreateOpen(false);
        setEditingRole(null);
        setRoleConflictTarget(null);
        setNotice(editingRole
          ? `角色已更新為 v${committedRole.version}，但清單刷新失敗；請重新整理以載入最新資料。`
          : `角色已建立為 v${committedRole.version}，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else if (cause instanceof CommittedMutationProjectionError) {
        if (retryOwnership) retryOwnership.registry.settle(retryOwnership.token);
        setResourceDraftDirty(false);
        setCreateOpen(false);
        setEditingModel(null);
        setEditingMcp(null);
        setEditingCredential(null);
        setEditingPrompt(null);
        setNotice("設定已儲存，但清單刷新失敗；請重新整理以載入最新資料。");
      } else if (tab === "roles" && isRevisionConflictError(cause) && editingRole) {
        setRoleConflictTarget({ id: editingRole.id, previousVersion: editingRole.version });
        setActionError("角色已由其他分頁更新。正在載入最新版本，目前草稿仍保留。");
        try {
          await refreshRequired();
        } catch {
          setActionError("角色最新版本載入失敗。目前草稿仍保留，請重新載入最新版本後再次儲存。");
        }
      } else if (tab === "prompts" && isRevisionConflictError(cause) && editingPrompt) {
        setActionError("Prompt 已由其他分頁更新。正在載入最新版本，目前草稿仍保留。");
        try {
          await refreshRequired();
          setActionError("Prompt 已載入最新版本，目前草稿仍保留；請確認後再次儲存。");
        } catch {
          setActionError("Prompt 最新版本載入失敗。目前草稿仍保留，請重新載入後再次儲存。");
        }
      } else if (isRevisionConflictError(cause) && (editingModel || editingMcp)) {
        setConnectorConflictTarget(editingModel
          ? { kind: "model", id: editingModel.id, previousRevision: editingModel.revision }
          : { kind: "mcp", id: editingMcp!.id, previousRevision: editingMcp!.revision });
        setActionError("Connector 設定已由其他分頁更新。正在載入最新 revision，目前草稿仍保留。");
        try {
          await refreshRequired();
        } catch {
          setActionError("Connector 最新 revision 載入失敗。目前草稿仍保留，請重新載入後再次儲存。");
        }
      } else {
        if (retryOwnership && managementMutationRetryDisposition(cause) !== "retain") {
          retryOwnership.registry.settle(retryOwnership.token);
        }
        setActionError(cause instanceof Error ? cause.message : "無法儲存設定。");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function retryRoleConflictRefresh() {
    if (!roleConflictTarget) return;
    setActionError("正在重新載入角色最新版本，目前草稿仍保留。");
    try {
      await refreshRequired();
    } catch {
      setActionError("角色最新版本載入失敗。目前草稿仍保留，請重新載入最新版本後再次儲存。");
    }
  }

  async function health(id: string) {
    const requestToken = connectorHealthRequest.current.begin();
    setPendingAction(`health:${id}`);
    setActionError("");
    try {
      const result = await mutate<{ healthy: boolean }>(`/api/model-connectors/${id}/health`, { method: "POST" });
      if (!connectorHealthRequest.current.isCurrent(requestToken)) return;
      if (result.healthy) setNotice("模型連線正常。");
      else setActionError("模型連線失敗。");
    } catch (cause) {
      if (!connectorHealthRequest.current.isCurrent(requestToken)) return;
      setActionError(cause instanceof Error ? cause.message : "連線檢查失敗。");
    } finally {
      if (connectorHealthRequest.current.isCurrent(requestToken)) setPendingAction(null);
    }
  }

  async function discover(id: string) {
    const requestToken = mcpDiscoveryRequest.current.begin();
    setPendingAction(`discover:${id}`);
    setActionError("");
    try {
      const result = await mutate<McpDiscoveryResponse>(`/api/mcp-connectors/${id}/discover`, { method: "POST" });
      if (!mcpDiscoveryRequest.current.isCurrent(requestToken)) return;
      setDiscoveredMcpTools((current) => ({ ...current, [id]: result.tools }));
      const readOnlyCount = result.tools.filter((tool) => tool.readOnly).length;
      setNotice(`找到 ${readOnlyCount} 個可核准的唯讀工具。`);
      setEditingMcp(result.connector);
      setResourceDraftDirty(false);
      setCreateOpen(true);
    } catch (cause) {
      if (mcpDiscoveryRequest.current.isCurrent(requestToken)) {
        setActionError(cause instanceof Error ? cause.message : "工具探索失敗。");
      }
    } finally {
      if (mcpDiscoveryRequest.current.isCurrent(requestToken)) setPendingAction(null);
    }
  }

  async function updateToolRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTool) return;
    const connector = snapshot?.mcpConnectors.find((item) => item.id === editingTool.connectorId);
    if (!connector) return;
    const data = new FormData(event.currentTarget);
    const nextRegistration: ToolRegistration = {
      toolName: editingTool.registration.toolName,
      displayName: String(data.get("displayName")),
      kind: String(data.get("kind")) as ToolRegistrationKind,
      version: String(data.get("version")),
      owner: String(data.get("owner")),
      goal: String(data.get("goal"))
    };
    setPendingAction(`tool:${connector.id}:${nextRegistration.toolName}`);
    setActionError("");
    try {
      await mutate(`/api/mcp-connectors/${connector.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedRevision: connector.revision,
          toolRegistrations: connector.toolRegistrations.map((registration) =>
            registration.toolName === nextRegistration.toolName ? nextRegistration : registration
          )
        })
      });
      setToolRegistrationDirty(false);
      setEditingTool(null);
      setNotice("工具資料已更新。");
    } catch (cause) {
      if (isRevisionConflictError(cause)) {
        try {
          await refreshRequired();
          setActionError("工具設定已由其他分頁更新。已重新載入最新 Connector；請確認後再儲存。");
        } catch {
          setActionError("工具設定已由其他分頁更新，但最新 Connector 載入失敗；請重新載入後再儲存。");
        }
      } else {
        setActionError(cause instanceof Error ? cause.message : "無法更新工具資料。");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function healthTaskAdapter(id: string) {
    const requestToken = connectorHealthRequest.current.begin();
    setPendingAction(`task-adapter-health:${id}`);
    setActionError("");
    try {
      const result = await mutate<{ healthy: boolean }>(`/api/task-adapter-connectors/${id}/health`, { method: "POST" });
      if (!connectorHealthRequest.current.isCurrent(requestToken)) return;
      if (result.healthy) {
        setNotice("Task Adapter 連線正常。");
      } else {
        setActionError("Task Adapter 無法連線。");
      }
    } catch (cause) {
      if (!connectorHealthRequest.current.isCurrent(requestToken)) return;
      setActionError(cause instanceof Error ? cause.message : "Task Adapter 連線檢查失敗。");
    } finally {
      if (connectorHealthRequest.current.isCurrent(requestToken)) setPendingAction(null);
    }
  }

  async function approveSkill(skill: SkillRecord) {
    if (platformProjectionStale) {
      setActionError("設定資料可能過期，請先重新整理後再核准 Skill。");
      return;
    }
    setPendingAction(`skill:${skill.id}`);
    setActionError("");
    try {
      await mutate(`/api/skills/${skill.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "approved", expectedCheckedAt: skill.validation.checkedAt })
      });
      setNotice("Skill 已核准，可指派給 Agent。");
    } catch (cause) {
      if (isRevisionConflictError(cause)) {
        try {
          await refreshRequired();
          setActionError("Skill 驗證已由其他分頁更新，請確認最新證據後再核准。");
        } catch (refreshCause) {
          setActionError(refreshCause instanceof Error ? refreshCause.message : "無法載入最新 Skill 驗證。");
        }
        return;
      }
      setActionError(cause instanceof Error ? cause.message : "無法核准 Skill。");
    } finally {
      setPendingAction(null);
    }
  }

  async function recordValidation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validationSkill) return;
    if (platformProjectionStale) {
      setActionError("設定資料可能過期，請先重新整理後再記錄 Skill 驗證。");
      return;
    }
    const data = new FormData(event.currentTarget);
    const result = String(data.get("result")) as SkillValidationResult;
    setPendingAction(`validation:${validationSkill.id}`);
    setActionError("");
    try {
      await mutate(`/api/skills/${validationSkill.id}/validation`, {
        method: "POST",
        body: JSON.stringify({
          result,
          summary: data.get("summary"),
          expectedCheckedAt: validationSkill.validation.checkedAt
        })
      });
      setSkillValidationDraftDirty(false);
      setValidationSkill(null);
      setNotice(result === "passed" ? "已記錄人工驗證證據，Skill 可進入核准。" : "已記錄人工驗證失敗，Skill 仍不可指派。");
    } catch (cause) {
      if (isRevisionConflictError(cause)) {
        try {
          await refreshRequired();
          setActionError("Skill 驗證已由其他分頁更新；已載入最新證據，目前表單內容仍保留，請確認後再送出。");
        } catch (refreshCause) {
          setActionError(refreshCause instanceof Error ? refreshCause.message : "無法載入最新 Skill 驗證。");
        }
        return;
      }
      setActionError(cause instanceof Error ? cause.message : "無法記錄 Skill 驗證。");
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!skillToRevoke) return;
    if (platformProjectionStale) {
      setActionError("設定資料可能過期，請先重新整理後再撤銷 Skill。");
      return;
    }
    const data = new FormData(event.currentTarget);
    const reason = String(data.get("reason") ?? "");
    const retry = managementMutationRetryOwnershipRef.current.acquire("skill.revoke",
      skillToRevoke.id,
      JSON.stringify({ reason }),
      () => crypto.randomUUID()
    );
    setPendingAction(`revoke:${skillToRevoke.id}`);
    setActionError("");
    try {
      const result = await mutate<{ skill: SkillRecord; revokedAssignmentCount: number }>(`/api/skills/${skillToRevoke.id}/revoke`, {
        method: "POST",
        headers: { "Idempotency-Key": retry.idempotencyKey },
        body: JSON.stringify({ reason })
      });
      managementMutationRetryOwnershipRef.current.clear(retry);
      setSkillRevocationDraftDirty(false);
      setSkillToRevoke(null);
      setNotice(`Skill 已撤銷，已移除 ${result.revokedAssignmentCount} 個 Agent 指派。`);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        managementMutationRetryOwnershipRef.current.clear(retry);
        const result = cause.result as { skill: SkillRecord; revokedAssignmentCount: number };
        setSkillRevocationDraftDirty(false);
        setSkillToRevoke(null);
        setNotice(`Skill 已撤銷並移除 ${result.revokedAssignmentCount} 個 Agent 指派，但清單刷新失敗；請重新整理確認。`);
      } else {
        if (managementMutationRetryDisposition(cause) === "clear") {
          managementMutationRetryOwnershipRef.current.clear(retry);
        }
        setActionError(cause instanceof Error ? cause.message : "無法撤銷 Skill。");
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function setCredentialStatus(credential: Credential, status: Credential["status"]) {
    if (platformProjectionStale) {
      setActionError("設定資料可能過期，請先重新整理後再變更 Credential 狀態。");
      return;
    }
    const retry = managementMutationRetryOwnershipRef.current.acquire("credential.status",
      credential.id,
      JSON.stringify({ status, expectedUpdatedAt: credential.updatedAt }),
      () => crypto.randomUUID()
    );
    setPendingAction(`credential-status:${credential.id}`);
    setActionError("");
    try {
      await commitMutation(() => managementApi.updateCredentialStatus(
        credential.id,
        status,
        credential.updatedAt,
        retry.idempotencyKey
      ));
      managementMutationRetryOwnershipRef.current.clear(retry);
      setNotice(`Credential 已${status === "active" ? "啟用" : status === "disabled" ? "停用" : "撤銷"}。`);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        managementMutationRetryOwnershipRef.current.clear(retry);
        setNotice(`Credential 已${status === "active" ? "啟用" : status === "disabled" ? "停用" : "撤銷"}，但清單刷新失敗；請重新整理確認。`);
      } else {
        if (managementMutationRetryDisposition(cause) === "refresh_then_confirm") {
          managementMutationRetryOwnershipRef.current.clear(retry);
          try {
            await refreshRequired();
            setActionError(`Credential 已由其他操作更新。已載入最新狀態，請再次確認是否要${status === "active" ? "啟用" : status === "disabled" ? "停用" : "撤銷"}。`);
          } catch {
            setActionError("Credential 已由其他操作更新，但最新設定載入失敗；目前畫面可能過期。");
          }
        } else {
          if (managementMutationRetryDisposition(cause) === "clear") {
            managementMutationRetryOwnershipRef.current.clear(retry);
          }
          setActionError(cause instanceof Error ? cause.message : "無法更新 Credential 狀態。");
        }
      }
    } finally {
      setPendingAction(null);
    }
  }

  async function loadPromptVersions(prompt: PromptTemplate) {
    setPromptVersionBusy(prompt.id);
    setActionError("");
    try {
      const versions = await managementApi.getPromptVersions(prompt.id);
      setPromptVersions((current) => ({ ...current, [prompt.id]: versions }));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "無法載入 Prompt 版本。");
    } finally {
      setPromptVersionBusy(null);
    }
  }

  async function openPromptPreview(prompt: PromptTemplate) {
    const requestToken = promptPreviewRequest.current.begin();
    setPromptPreviewPending(true);
    setPromptPreviewError("");
    setPromptPreviewOutput("");
    try {
      const versions = promptVersions[prompt.id] ?? await managementApi.getPromptVersions(prompt.id);
      if (!promptPreviewRequest.current.isCurrent(requestToken)) return;
      setPromptVersions((current) => ({ ...current, [prompt.id]: versions }));
      const versionNumber = prompt.publishedVersion ?? prompt.currentVersion;
      const version = versions.find((item) => item.version === versionNumber);
      if (!version) throw new Error("找不到可預覽的 Prompt 版本。");
      setPromptPreview({ prompt, version: version.version, variables: version.variables });
      setPromptPreviewValues(Object.fromEntries(version.variables.map((variable) => [variable, ""])));
    } catch (cause) {
      if (!promptPreviewRequest.current.isCurrent(requestToken)) return;
      const message = cause instanceof Error ? cause.message : "無法載入 Prompt 預覽。";
      setPromptPreviewError(message);
      setActionError(message);
    } finally {
      if (promptPreviewRequest.current.isCurrent(requestToken)) setPromptPreviewPending(false);
    }
  }

  function selectPromptPreviewVersion(versionNumber: number) {
    if (!promptPreview) return;
    const version = promptVersions[promptPreview.prompt.id]?.find((item) => item.version === versionNumber);
    if (!version) return;
    setPromptPreview({ ...promptPreview, version: version.version, variables: version.variables });
    setPromptPreviewValues(Object.fromEntries(version.variables.map((variable) => [variable, ""])));
    setPromptPreviewOutput("");
    setPromptPreviewError("");
  }

  async function runPromptPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!promptPreview) return;
    const requestToken = promptPreviewRequest.current.begin();
    setPromptPreviewPending(true);
    setPromptPreviewError("");
    try {
      const result = await managementApi.previewPrompt(promptPreview.prompt.id, promptPreview.version, promptPreviewValues);
      if (!promptPreviewRequest.current.isCurrent(requestToken)) return;
      setPromptPreviewOutput(result.content);
    } catch (cause) {
      if (promptPreviewRequest.current.isCurrent(requestToken)) {
        setPromptPreviewError(cause instanceof Error ? cause.message : "無法產生 Prompt 預覽。");
      }
    } finally {
      if (promptPreviewRequest.current.isCurrent(requestToken)) setPromptPreviewPending(false);
    }
  }

  async function promptLifecycle(prompt: PromptTemplate, action: "publish" | "rollback" | "archive", version?: number) {
    const requestToken = promptLifecycleRequest.current.begin();
    setPendingAction(`prompt:${action}:${prompt.id}`);
    setActionError("");
    try {
      if (action === "publish") await commitMutation(() => managementApi.publishPrompt(prompt.id, prompt.currentVersion, version ?? prompt.currentVersion));
      if (action === "rollback") await commitMutation(() => managementApi.rollbackPrompt(prompt.id, prompt.currentVersion, version ?? prompt.currentVersion));
      if (action === "archive") await commitMutation(() => managementApi.archivePrompt(prompt.id, prompt.currentVersion));
      if (!promptLifecycleRequest.current.isCurrent(requestToken)) return;
      setNotice(action === "publish" ? "Prompt 已發布。" : action === "rollback" ? "Prompt 已回復並建立新版本。" : "Prompt 已封存。");
    } catch (cause) {
      if (!promptLifecycleRequest.current.isCurrent(requestToken)) return;
      if (isRevisionConflictError(cause)) {
        setActionError("Prompt 已由其他分頁更新，正在載入最新版本。");
        try {
          await refreshRequired();
          if (!promptLifecycleRequest.current.isCurrent(requestToken)) return;
          setActionError("Prompt 已載入最新版本，請重新執行操作。");
        } catch {
          if (promptLifecycleRequest.current.isCurrent(requestToken)) {
            setActionError("Prompt 最新版本載入失敗，請重新整理後再執行操作。");
          }
        }
      } else {
        setActionError(cause instanceof Error ? cause.message : "無法更新 Prompt 生命週期。");
      }
    } finally {
      if (promptLifecycleRequest.current.isCurrent(requestToken)) setPendingAction(null);
    }
  }

  const canCreate = tab !== "harness" && !(tab === "task_adapters" && snapshot.taskAdapterConnectors.length > 0);
  const isEditing = Boolean(editingRole || editingModel || editingMcp || editingPrompt || editingCredential);
  const editableDiscoveredTools = editingMcp
    ? discoveredMcpTools[editingMcp.id]?.filter((tool) => tool.readOnly)
    : undefined;
  const editingCredentialRecord = editingCredential
    ? (snapshot.credentials ?? []).find((credential) => credential.id === editingCredential) ?? null
    : null;
  const editingModelCredentialId = editingModel?.credentialId ?? null;
  const inactiveModelCredential = editingModelCredentialId
    ? (snapshot.credentials ?? []).find((credential) => credential.id === editingModelCredentialId && credential.status !== "active") ?? null
    : null;
  const modelCredentialOptions = selectableModelCredentials(snapshot.credentials ?? []);
  const formPending = pendingAction === "create" || Boolean(editingRole && pendingAction === `role:${editingRole.id}`) || Boolean(editingModel && pendingAction === `model:${editingModel.id}`) || Boolean(editingMcp && pendingAction === `mcp:${editingMcp.id}`) || Boolean(editingPrompt && pendingAction === "create") || Boolean(editingCredential && pendingAction === "create");
  const toolRegistrationPending = Boolean(editingTool
    && pendingAction === `tool:${editingTool.connectorId}:${editingTool.registration.toolName}`);
  const skillRecords = (snapshot.skills as unknown as SkillSnapshotEntry[]).map(normalizeSkill);
  const roleLifecyclePending = Boolean(pendingAction?.startsWith("role-lifecycle:"));
  const currentRoleVersion = roleLifecycle?.versions.find((version) => version.version === roleLifecycle.role.version) ?? null;
  const comparedRoleVersion = roleLifecycle?.versions.find((version) => version.version === selectedRoleVersion) ?? null;
  const roleDifferences = currentRoleVersion && comparedRoleVersion
    ? roleVersionDifferences(comparedRoleVersion, currentRoleVersion)
    : [];
  const roleDeleteBlocker = roleLifecycle
    ? [
        roleLifecycle.unfinishedMeetingCount > 0 ? `${roleLifecycle.unfinishedMeetingCount} 場未結束會議仍使用此角色。` : null,
        roleLifecycle.activeTeamCount > 0 ? `${roleLifecycle.activeTeamCount} 個啟用中的 Agent Team 仍使用此角色。` : null
      ].filter((item): item is string => item !== null).join(" ") || null
    : null;
  const lifecycleMutationBlocked = pendingAction !== null || platformProjectionStale;
  const projectionStatus = projectionFreshnessLabel({
    stale: platformProjectionStale,
    refreshing: platformProjectionRefreshing,
    lastSuccessfulAt: platformProjectionLastSuccessfulAt
  });
  const lifecycleModalTitle = roleLifecycleMode === "confirm_delete"
    ? `刪除${lifecycleRole?.name ?? "角色"}`
    : roleLifecycleMode === "confirm_rollback"
      ? `回復${lifecycleRole?.name ?? "角色"}`
      : `${lifecycleRole?.name ?? "角色"}版本歷程`;

  function closeCreateModal(force = false) {
    if (!force && resourceDraftDirty && !window.confirm("設定草稿尚未儲存，確定捨棄？")) return;
    promptEditorRequest.current.cancel();
    setPromptEditorBusy(null);
    setResourceDraftDirty(false);
    setCreateOpen(false);
    setEditingRole(null);
    setRoleConflictTarget(null);
    setEditingModel(null);
    setEditingMcp(null);
    setConnectorConflictTarget(null);
    setEditingCredential(null);
    setEditingPrompt(null);
  }

  function openCreateModal() {
    promptEditorRequest.current.cancel();
    setPromptEditorBusy(null);
    setActionError("");
    setEditingRole(null);
    setRoleConflictTarget(null);
    setEditingModel(null);
    setEditingMcp(null);
    setConnectorConflictTarget(null);
    setEditingCredential(null);
    setEditingPrompt(null);
    setResourceDraftDirty(false);
    if (tab === "roles") {
      setRoleDraft(emptyRoleDraft);
      setSelectedRoleTemplate("");
    }
    if (tab === "prompts") {
      setPromptDraft({ name: "", kind: "agent", description: "", owner: "Platform Owner", content: "", variables: [] });
    }
    setCreateOpen(true);
  }

  function openRoleEditor(role: Role) {
    setActionError("");
    setEditingRole(role);
    setRoleConflictTarget(null);
    setRoleDraft(draftFromRole(role));
    setSelectedRoleTemplate(role.templateKey ?? "");
    setResourceDraftDirty(false);
    setCreateOpen(true);
  }

  async function openPromptEditor(prompt: PromptTemplate) {
    const requestToken = promptEditorRequest.current.begin();
    setActionError("");
    setPromptEditorBusy(prompt.id);
    try {
      const versions = await managementApi.getPromptVersions(prompt.id);
      if (!promptEditorRequest.current.isCurrent(requestToken)) return;
      const current = promptVersionForEdit(versions, prompt.currentVersion);
      setPromptVersions((existing) => ({ ...existing, [prompt.id]: versions }));
      setEditingPrompt(prompt.id);
      setPromptDraft({ name: prompt.name, kind: prompt.kind, description: prompt.description, owner: prompt.owner, content: current.content, variables: current.variables });
      setResourceDraftDirty(false);
      setCreateOpen(true);
    } catch (cause) {
      if (promptEditorRequest.current.isCurrent(requestToken)) {
        setEditingPrompt(null);
        const detail = cause instanceof Error ? cause.message : "未知錯誤";
        setActionError(`無法載入 Prompt 版本：${detail}`);
      }
    } finally {
      if (promptEditorRequest.current.isCurrent(requestToken)) setPromptEditorBusy(null);
    }
  }

  async function loadRoleLifecycle(role: Role) {
    const requestId = ++roleLifecycleRequestId.current;
    setRoleLifecycleLoading(true);
    setRoleLifecycleError("");
    try {
      const lifecycle = await apiRequest<RoleLifecycleView>(`/api/roles/${role.id}/lifecycle`);
      if (requestId !== roleLifecycleRequestId.current) return;
      setLifecycleRole(lifecycle.role);
      setRoleLifecycle(lifecycle);
      setSelectedRoleVersion(lifecycle.versions.find((version) => version.version < lifecycle.role.version)?.version ?? lifecycle.role.version);
      setRoleLifecycleMode("history");
      setRoleDeleteConfirmation("");
    } catch (cause) {
      if (requestId !== roleLifecycleRequestId.current) return;
      setRoleLifecycle(null);
      setRoleLifecycleError(cause instanceof Error ? cause.message : "無法載入角色歷程。");
    } finally {
      if (requestId === roleLifecycleRequestId.current) setRoleLifecycleLoading(false);
    }
  }

  function openRoleLifecycle(role: Role) {
    setActionError("");
    setLifecycleRole(role);
    setRoleLifecycle(null);
    setRoleLifecycleMode("history");
    setSelectedRoleVersion(null);
    setRoleDeleteConfirmation("");
    void loadRoleLifecycle(role);
  }

  function closeRoleLifecycle(force = false) {
    if (!force && pendingAction?.startsWith("role-lifecycle:")) return;
    roleLifecycleRequestId.current += 1;
    setLifecycleRole(null);
    setRoleLifecycle(null);
    setRoleLifecycleError("");
    setRoleLifecycleMode("history");
    setRoleDeleteConfirmation("");
  }

  async function rollbackRole() {
    if (!roleLifecycle || selectedRoleVersion === null || selectedRoleVersion === roleLifecycle.role.version) return;
    setPendingAction(`role-lifecycle:rollback:${roleLifecycle.role.id}`);
    setRoleLifecycleError("");
    try {
      const role = await mutate<Role>(`/api/roles/${roleLifecycle.role.id}/rollback`, {
        method: "POST",
        body: JSON.stringify({ version: selectedRoleVersion, expectedCurrentVersion: roleLifecycle.role.version })
      });
      closeRoleLifecycle(true);
      setNotice(`已用 v${selectedRoleVersion} 的內容建立 v${role.version}；既有會議維持原版本。`);
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        closeRoleLifecycle(true);
        setNotice("角色回復已完成，但清單刷新失敗；請重新整理以載入最新資料。");
        return;
      }
      setRoleLifecycleMode("history");
      setRoleLifecycleError(cause instanceof Error ? cause.message : "無法回復角色版本。");
    } finally {
      setPendingAction(null);
    }
  }

  async function deleteRole() {
    if (!roleLifecycle || roleDeleteConfirmation !== roleLifecycle.role.name || !roleLifecycle.canDelete) return;
    if (platformProjectionStale) {
      setRoleLifecycleMode("history");
      setRoleLifecycleError("設定資料可能過期，請先重新整理後再刪除角色。");
      return;
    }
    const retry = managementMutationRetryOwnershipRef.current.acquire("role.delete",
      roleLifecycle.role.id,
      JSON.stringify({ expectedCurrentVersion: roleLifecycle.role.version }),
      () => crypto.randomUUID()
    );
    setPendingAction(`role-lifecycle:delete:${roleLifecycle.role.id}`);
    setRoleLifecycleError("");
    try {
      const result = await mutate<{ id: string; historicalMeetingCount: number }>(`/api/roles/${roleLifecycle.role.id}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": retry.idempotencyKey },
        body: JSON.stringify({ expectedCurrentVersion: roleLifecycle.role.version })
      });
      managementMutationRetryOwnershipRef.current.clear(retry);
      closeRoleLifecycle(true);
      setNotice(result.historicalMeetingCount > 0
        ? `角色已刪除；${result.historicalMeetingCount} 場歷史會議仍保留原角色快照。`
        : "角色已刪除，版本歷程仍保留供稽核。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        managementMutationRetryOwnershipRef.current.clear(retry);
        closeRoleLifecycle(true);
        setNotice("角色刪除已完成，但清單刷新失敗；請重新整理以載入最新資料。");
        return;
      }
      const disposition = managementMutationRetryDisposition(cause);
      if (disposition !== "retain") {
        managementMutationRetryOwnershipRef.current.clear(retry);
      }
      setRoleLifecycleMode("history");
      if (disposition === "refresh_then_confirm") {
        try {
          await refreshRequired();
          await loadRoleLifecycle(roleLifecycle.role);
          setRoleLifecycleError("角色已由其他操作更新。已載入最新版本，請再次確認刪除條件。");
        } catch {
          setRoleLifecycleError("角色已由其他操作更新，但最新設定載入失敗；目前畫面可能過期。");
        }
      } else {
        setRoleLifecycleError(cause instanceof Error ? cause.message : "無法刪除角色。");
      }
    } finally {
      setPendingAction(null);
    }
  }

  function applyRoleTemplate() {
    const template = builtInRoleTemplates.find((item) => item.key === selectedRoleTemplate);
    if (!template) {
      setRoleDraft(emptyRoleDraft);
      setResourceDraftDirty(true);
      return;
    }
    const { key, ...definition } = template;
    setRoleDraft({ ...definition, templateKey: key });
    setResourceDraftDirty(true);
  }

  function requestCloseToolRegistration() {
    if (pendingAction?.startsWith("tool:")) return;
    if (toolRegistrationDirty && !window.confirm("工具資料尚未儲存，確定捨棄？")) return;
    setToolRegistrationDirty(false);
    setEditingTool(null);
    setActionError("");
  }

  function requestCloseSkillValidation(): boolean {
    if (pendingAction !== null) return false;
    if (skillValidationDraftDirty && !window.confirm("驗證證據草稿尚未儲存，確定捨棄？")) return false;
    setSkillValidationDraftDirty(false);
    setValidationSkill(null);
    setActionError("");
    return true;
  }

  function requestCloseSkillRevocation(): boolean {
    if (pendingAction !== null) return false;
    if (skillRevocationDraftDirty && !window.confirm("撤銷原因草稿尚未儲存，確定捨棄？")) return false;
    setSkillRevocationDraftDirty(false);
    setSkillToRevoke(null);
    setActionError("");
    return true;
  }

  function setRoleField<K extends keyof RoleDraft>(field: K, value: RoleDraft[K]) {
    setRoleDraft((current) => ({ ...current, [field]: value }));
  }

  function setRoleToolPolicy(toolPolicy: RoleToolPolicy) {
    setRoleDraft((current) => ({
      ...current,
      toolPolicy,
      dataPolicy: toolPolicy === "agent_read_only_grants" ? "agent_declared_scope" : current.dataPolicy
    }));
  }

  function setRoleDataPolicy(dataPolicy: RoleDataPolicy) {
    setRoleDraft((current) => ({
      ...current,
      dataPolicy,
      toolPolicy: dataPolicy === "meeting_only" ? "none" : current.toolPolicy
    }));
  }

  function selectTab(nextTab: Tab) {
    if (pendingAction !== null) return;
    if (validationSkill && !requestCloseSkillValidation()) return;
    if (skillToRevoke && !requestCloseSkillRevocation()) return;
    connectorHealthRequest.current.cancel();
    mcpDiscoveryRequest.current.cancel();
    promptEditorRequest.current.cancel();
    promptLifecycleRequest.current.cancel();
    promptPreviewRequest.current.cancel();
    setTab(nextTab);
    setNotice("");
    setActionError("");
    setResourceDraftDirty(false);
    setCreateOpen(false);
    setEditingRole(null);
    setRoleConflictTarget(null);
    setEditingModel(null);
    setEditingMcp(null);
    setConnectorConflictTarget(null);
    setEditingCredential(null);
    setEditingPrompt(null);
    setPromptEditorBusy(null);
    setPromptPreviewPending(false);
    setPromptPreview(null);
    setPromptPreviewOutput("");
    setPromptPreviewError("");
    setPendingAction((current) => current && (
      current.startsWith("discover:")
      || current.startsWith("health:")
      || current.startsWith("prompt:")
      || current.startsWith("task-adapter-health:")
    ) ? null : current);
    roleLifecycleRequestId.current += 1;
    setLifecycleRole(null);
    setRoleLifecycle(null);
    setRoleLifecycleError("");
    window.requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab}`)?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  }

  function requestEmbeddedBack() {
    if (!onBack || pendingAction !== null) return;
    const hasDirtyDraft = resourceDraftDirty || toolRegistrationDirty || skillValidationDraftDirty || skillRevocationDraftDirty;
    if (hasDirtyDraft && !window.confirm("設定草稿尚未儲存，確定返回 Agent？")) return;
    closeCreateModal(true);
    setToolRegistrationDirty(false);
    setEditingTool(null);
    setSkillValidationDraftDirty(false);
    setValidationSkill(null);
    setSkillRevocationDraftDirty(false);
    setSkillToRevoke(null);
    onBack();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? settingsNavigation.length - 1 : (index + (forward ? 1 : -1) + settingsNavigation.length) % settingsNavigation.length;
    const nextTab = settingsNavigation[nextIndex];
    if (!nextTab) return;
    selectTab(nextTab.id);
    document.getElementById(`settings-tab-${nextTab.id}`)?.focus();
  }

  const settingsNavigation = getSettingsNavigation().filter((item) => !embedded || ["skills", "prompts", "models", "credentials", "mcp"].includes(item.id));
  const settingsGroups = Array.from(new Map(settingsNavigation.map((item) => [item.groupId, item.groupLabel])).entries());
  const Container = embedded ? "section" : "main";
  return <Container className={`settings-page${embedded ? " settings-page-embedded" : ""}`}><header className="page-header"><div><span className="eyebrow">管理控制面</span><h1>{embedded ? "Agent 資源" : "設定"}</h1><p className="page-count">治理資源、連線憑證與執行整合</p></div><div className="settings-page-actions">{embedded && <button className="secondary-button" type="button" disabled={pendingAction !== null} onClick={requestEmbeddedBack}><ArrowLeft size={15} />返回 Agent</button>}{canCreate && <button className="primary-button" disabled={pendingAction !== null || platformProjectionStale} onClick={openCreateModal}><Plus size={15} />新增</button>}</div></header>
    <label className="settings-mobile-resource">設定資源<select value={tab} disabled={pendingAction !== null} onChange={(event) => selectTab(event.target.value as Tab)}>{settingsGroups.map(([groupId, groupLabel]) => <optgroup label={groupLabel} key={groupId}>{settingsNavigation.filter((item) => item.groupId === groupId).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</optgroup>)}</select></label>
    <div className="settings-workbench"><aside className="settings-resource-nav" aria-label="設定資源">{settingsGroups.map(([groupId, groupLabel]) => <section key={groupId}><h2>{groupLabel}</h2>{settingsNavigation.filter((item) => item.groupId === groupId).map((nav) => { const item = tabs.find((candidate) => candidate.id === nav.id)!; const Icon = item.icon; const index = settingsNavigation.findIndex((candidate) => candidate.id === nav.id); return <button id={`settings-tab-${item.id}`} type="button" disabled={pendingAction !== null} aria-current={tab === item.id ? "page" : undefined} aria-controls={tab === item.id ? `settings-panel-${item.id}` : undefined} className={tab === item.id ? "active" : ""} onKeyDown={(event) => handleTabKeyDown(event, index)} onClick={() => selectTab(item.id)} key={item.id}><Icon size={15} /><span>{item.label}</span></button>; })}</section>)}</aside>
    <div className="settings-resource-content">{platformProjectionStale && <ProjectionFreshnessWarning message={projectionStatus} refreshing={platformProjectionRefreshing} onRetry={() => void refreshRequired().catch(() => undefined)} retryLabel="重新整理設定資料" />}<ActionNotice message={actionError || notice} error={Boolean(actionError)} />
    <section className="settings-list" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
      {tab === "prompts" && (snapshot.prompts ?? []).length > 0 && <div className="settings-resource-toolbar"><label>預覽 Prompt<select value={promptPreviewId} onChange={(event) => setPromptPreviewId(event.target.value)}>{(snapshot.prompts ?? []).map((prompt) => <option value={prompt.id} key={prompt.id}>{prompt.name} · v{prompt.publishedVersion ?? prompt.currentVersion}</option>)}</select></label><button className="secondary-button small" type="button" disabled={promptPreviewPending || !promptPreviewId} onClick={() => { const prompt = (snapshot.prompts ?? []).find((item) => item.id === promptPreviewId); if (prompt) void openPromptPreview(prompt); }}>{promptPreviewPending ? "載入中" : "預覽"}</button></div>}
      {tab === "roles" && snapshot.roles.map((role) => {
        const usage = roleUsageSummary(snapshot, role.id);
        const effectiveToolPolicy: RoleToolPolicy = roleAllowsExternalTools(role) ? "agent_read_only_grants" : "none";
        return <article className="settings-row role-settings-row" key={role.id}><span className="row-icon blue"><UserRoundCog size={16} /></span><div className="role-settings-content"><div className="role-settings-title"><strong>{role.name} <small>v{role.version}</small></strong><span>{usage.agentNames.length} Agent · {usage.meetingCount} 會議</span></div><p className="role-usage-context"><b>適用於</b>{role.usageContext}</p><div className="role-policy-meta" aria-label={`${role.name} 的有效邊界`}><span>模板：{roleTemplateLabel(role.templateKey)}</span><span>工具：{roleToolLabels[effectiveToolPolicy]}</span><span>資料：{roleDataLabels[role.dataPolicy]}</span></div><p>{role.responsibility}</p><p className="role-effective-capability"><b>有效能力</b>{usage.runnableAgentCount} 可執行 Agent · {usage.skillCount} Skill · {usage.toolCount} 唯讀工具</p><details className="role-relationships"><summary>查看 Agent 與會議</summary>{usage.agentNames.length > 0 ? <><p>Agent：{usage.agentNames.join("、")}</p><ul>{usage.meetings.map((meeting) => <li key={meeting.id}><strong>{meeting.title}</strong><span>{roleMeetingStateLabels[meeting.state]} · {meeting.agentNames.join("、")}</span></li>)}</ul></> : <p>尚未用於會議；有效能力會在指派 Agent 後計算。</p>}</details><RoleBehaviorDetails roleName={role.name} speakingGuidance={role.speakingGuidance} decisionScope={role.decisionScope} constraints={role.constraints} /></div><div className="role-settings-actions"><button className="icon-button" disabled={pendingAction !== null} onClick={() => openRoleLifecycle(role)} aria-label={`查看${role.name}版本歷程`} title={`查看${role.name}版本歷程`}><History size={15} /></button><button className="icon-button" disabled={pendingAction !== null} onClick={() => openRoleEditor(role)} aria-label={`編輯${role.name}`} title={`編輯${role.name}`}><Pencil size={15} /></button></div></article>;
      })}
      {tab === "skills" && skillRecords.map((skill) => {
        const lifecycle = skillLifecycleState(skill);
        return <article className="settings-row skill-settings-row" key={skill.id}><span className={`row-icon ${lifecycle.tone === "failed" || lifecycle.tone === "revoked" ? "red" : lifecycle.tone === "approved" ? "green" : lifecycle.tone === "ready" ? "blue" : "amber"}`}><Braces size={16} /></span><div className="skill-row-content"><div className="settings-row-title"><strong>{skill.name} <small>v{skill.version}</small></strong><span className={`state-label skill-state ${lifecycle.tone}`}>{lifecycle.label}</span></div><div className="skill-meta"><span>來源：{skill.source}</span><span>登記負責人：{skill.owner}</span></div><p className="skill-instructions">{clampText(skill.instructions, 180)}</p><p className={`skill-validation ${skill.validation.result}`}><ClipboardCheck size={12} />人工驗證：{clampText(skill.validation.summary, 140)}</p>{skill.status === "revoked" && skill.revocationReason && <p className="skill-revocation"><XCircle size={12} />撤銷原因：{clampText(skill.revocationReason, 140)}</p>}</div><div className="skill-actions">{skill.status === "draft" && <button className="secondary-button small" disabled={lifecycleMutationBlocked} onClick={() => { setActionError(""); setSkillValidationDraftDirty(false); setValidationSkill(skill); }}><ClipboardCheck size={13} />{pendingAction === `validation:${skill.id}` ? "記錄中" : "記錄驗證"}</button>}{skill.status === "draft" && skill.validation.result === "passed" && <button className="secondary-button small" disabled={lifecycleMutationBlocked} onClick={() => void approveSkill(skill)}><CheckCircle2 size={13} />{pendingAction === `skill:${skill.id}` ? "核准中" : "核准"}</button>}{skill.status === "approved" && skill.validation.result === "passed" && <button className="secondary-button small revoke-button" disabled={lifecycleMutationBlocked} onClick={() => { setActionError(""); setSkillRevocationDraftDirty(false); setSkillToRevoke(skill); }}><XCircle size={13} />撤銷</button>}</div></article>;
      })}
      {tab === "skills" && skillRecords.length === 0 && <div className="empty-settings">尚未設定 Skill</div>}
      {tab === "prompts" && (snapshot.prompts ?? []).map((prompt) => {
        const versions = promptVersions[prompt.id] ?? [];
        const actions = promptLifecycleActions(prompt);
        return <article className="settings-row" key={prompt.id}><span className="row-icon blue"><FileText size={16} /></span><div><div className="settings-row-title"><strong>{prompt.name}</strong><span className={`state-label ${prompt.status === "published" ? "approved" : prompt.status === "archived" ? "disabled" : ""}`}>{prompt.status === "published" ? "已發布" : prompt.status === "archived" ? "已封存" : "草稿"}</span></div><p>{prompt.kind} · {prompt.owner} · 目前 v{prompt.currentVersion}{prompt.publishedVersion ? ` · 已發布 v${prompt.publishedVersion}` : ""}</p>{versions.length > 0 && <details><summary>查看 {versions.length} 個版本</summary><ul className="role-version-list">{versions.map((version) => <li key={`${prompt.id}:${version.version}`}><span><strong>v{version.version}</strong> · {version.source}{version.publishedAt ? " · 已發布" : ""}</span>{actions.canRollback && version.version < prompt.currentVersion && <button className="icon-button" type="button" disabled={pendingAction !== null} onClick={() => void promptLifecycle(prompt, "rollback", version.version)} aria-label={`以 v${version.version} 回復`} title={`以 v${version.version} 回復`}><RotateCcw size={14} /></button>}</li>)}</ul></details>}</div><div className="settings-row-actions"><button className="secondary-button small" type="button" disabled={promptVersionBusy === prompt.id || pendingAction !== null} onClick={() => void loadPromptVersions(prompt)}>{promptVersionBusy === prompt.id ? "載入中" : "版本"}</button>{actions.canPublish && <button className="secondary-button small" type="button" disabled={pendingAction !== null} onClick={() => void promptLifecycle(prompt, "publish")}>發布</button>}{actions.canEdit && <button className="icon-button" type="button" disabled={pendingAction !== null || promptEditorBusy !== null} onClick={() => void openPromptEditor(prompt)} aria-label={`編輯${prompt.name}`} title={`編輯${prompt.name}`}>{promptEditorBusy === prompt.id ? <LoaderCircle className="spin-icon" size={15} /> : <Pencil size={15} />}</button>}{actions.canArchive && <button className="icon-button" type="button" disabled={pendingAction !== null} onClick={() => void promptLifecycle(prompt, "archive")} aria-label={`封存${prompt.name}`} title={`封存${prompt.name}`}><Archive size={15} /></button>}</div></article>;
      })}
      {tab === "prompts" && (snapshot.prompts ?? []).length === 0 && <div className="empty-settings">尚未建立 Prompt</div>}
      {tab === "credentials" && (snapshot.credentials ?? []).map((credential) => <article className="settings-row" key={credential.id}><span className={`row-icon ${credential.status === "active" ? "green" : credential.status === "revoked" ? "red" : "muted"}`}><KeyRound size={16} /></span><div><div className="settings-row-title"><strong>{credential.name}</strong><span className={`state-label ${credential.status === "active" ? "approved" : credential.status === "revoked" ? "disabled" : ""}`}>{credential.status === "active" ? "已啟用" : credential.status === "revoked" ? "已撤銷" : "已停用"}</span></div><p>{credential.provider} · {credential.kind} · {credential.location === "local" ? "地端" : "雲端"} · {credential.maskedHint ?? "未顯示提示"}</p><p>{credential.hasSecret ? `Secret revision ${credential.secretRevision}` : "尚未設定密鑰"}{credential.expiresAt ? ` · 到期 ${credential.expiresAt}` : ""}</p></div><div className="settings-row-actions"><button className="secondary-button small" type="button" disabled={lifecycleMutationBlocked || credential.status === "revoked"} onClick={() => { setResourceDraftDirty(false); setEditingCredential(credential.id); setCreateOpen(true); }}>輪替</button>{credential.status !== "revoked" && <button className="secondary-button small" type="button" disabled={lifecycleMutationBlocked} onClick={() => void setCredentialStatus(credential, credential.status === "active" ? "disabled" : "active")}>{credential.status === "active" ? "停用" : "啟用"}</button>}{credential.status !== "revoked" && <button className="icon-button" type="button" disabled={lifecycleMutationBlocked} onClick={() => void setCredentialStatus(credential, "revoked")} aria-label={`撤銷${credential.name}`} title={`撤銷${credential.name}`}><XCircle size={15} /></button>}</div></article>)}
      {tab === "credentials" && (snapshot.credentials ?? []).length === 0 && <div className="empty-settings">尚未登記 API 金鑰</div>}
      {tab === "models" && snapshot.modelConnectors.map((connector) => {
        const credential = connector.credentialId ? (snapshot.credentials ?? []).find((item) => item.id === connector.credentialId) : null;
        return <article className="settings-row" key={connector.id}><span className={`row-icon ${connector.enabled ? connector.location === "local" ? "blue" : "amber" : "muted"}`}>{connector.location === "local" ? <Server size={16} /> : <Cloud size={16} />}</span><div><div className="settings-row-title"><strong>{connector.name}</strong><span className={`state-label ${connector.enabled ? "approved" : "disabled"}`}>{connector.enabled ? "已啟用" : "已停用"}</span></div><p>{connector.model} · {connector.baseUrl}</p><p>{credential ? `${credential.name} · ${credential.status === "active" && credential.hasSecret ? `Secret revision ${credential.secretRevision}` : "尚未可用"}` : connector.location === "local" ? "地端免 Credential" : "未綁定 Credential"}</p></div><div className="settings-row-actions"><button className="secondary-button small" disabled={pendingAction !== null || !connector.enabled} onClick={() => void health(connector.id)}>{pendingAction === `health:${connector.id}` ? "檢查中" : "檢查"}</button><button className="icon-button" disabled={pendingAction !== null} onClick={() => { setActionError(""); setResourceDraftDirty(false); setEditingModel(connector); setCreateOpen(true); }} aria-label={`編輯${connector.name}`} title={`編輯${connector.name}`}><Pencil size={15} /></button></div></article>;
      })}
      {tab === "models" && snapshot.modelConnectors.length === 0 && <div className="empty-settings">尚未設定模型</div>}
      {tab === "mcp" && snapshot.mcpConnectors.map((connector) => <article className="settings-row mcp-settings-row" key={connector.id}><span className={`row-icon ${connector.enabled ? connector.location === "local" ? "blue" : "amber" : "muted"}`}>{connector.location === "local" ? <Server size={16} /> : <Cloud size={16} />}</span><div className="mcp-settings-content"><div className="settings-row-title"><strong>{connector.name}</strong><span className={`state-label ${connector.enabled ? "approved" : "disabled"}`}>{connector.enabled ? "已啟用" : "已停用"}</span></div><p>{connector.location === "local" ? "地端" : "雲端"} · {connector.baseUrl}</p>{connector.toolRegistrations.length > 0 ? <ul className="tool-catalog-list" aria-label={`${connector.name} Tool Catalog`}>{connector.toolRegistrations.map((registration) => <li className="tool-catalog-row" key={registration.toolName}><div><strong>{registration.displayName}</strong><span>{toolRegistrationKindLabel(registration.kind)} · {registration.version} · {registration.owner}</span><p>{registration.goal}</p></div><button className="icon-button tool-catalog-edit" disabled={pendingAction !== null} onClick={() => { setActionError(""); setToolRegistrationDirty(false); setEditingTool({ connectorId: connector.id, registration }); }} aria-label={`編輯${registration.displayName}`} title={`編輯${registration.displayName}`}><Pencil size={14} /></button></li>)}</ul> : <p>{connector.enabled ? "尚無已核准工具" : "Connector 已停用"}</p>}</div><div className="settings-row-actions"><button className="secondary-button small" disabled={pendingAction !== null || !connector.enabled} onClick={() => void discover(connector.id)}>{pendingAction === `discover:${connector.id}` ? "探索中" : "探索"}</button><button className="icon-button" disabled={pendingAction !== null} onClick={() => { setActionError(""); setResourceDraftDirty(false); setEditingMcp(connector); setCreateOpen(true); }} aria-label={`編輯${connector.name}`} title={`編輯${connector.name}`}><Pencil size={15} /></button></div></article>)}
      {tab === "mcp" && snapshot.mcpConnectors.length === 0 && <div className="empty-settings">尚未設定 MCP</div>}
      {tab === "task_adapters" && snapshot.taskAdapterConnectors.map((connector) => <article className="settings-row" key={connector.id}><span className={`row-icon ${connector.location === "local" ? "blue" : "amber"}`}>{connector.location === "local" ? <Server size={16} /> : <Cloud size={16} />}</span><div><strong>{connector.name}</strong><p>{connector.baseUrl}</p></div><button className="secondary-button small" disabled={pendingAction !== null} onClick={() => void healthTaskAdapter(connector.id)}>{pendingAction === `task-adapter-health:${connector.id}` ? "檢查中" : "檢查"}</button></article>)}
      {tab === "task_adapters" && snapshot.taskAdapterConnectors.length === 0 && <div className="empty-settings">尚未設定 Task Adapter</div>}
      {tab === "harness" && <article className="settings-row"><span className="row-icon amber"><ShieldCheck size={16} /></span><div><strong>Harness Adapter</strong><p>Feature flag：關閉 · 白名單 Pipeline：0</p></div><span className="state-label">未啟用</span></article>}
    </section></div></div>
    <Modal title={editingRole ? `編輯${editingRole.name}` : editingModel ? `編輯${editingModel.name}` : editingMcp ? `編輯${editingMcp.name}` : editingPrompt ? `編輯${snapshot.prompts?.find((item) => item.id === editingPrompt)?.name ?? "Prompt"}` : editingCredential ? "輪替 Credential" : `新增${tabs.find((item) => item.id === tab)?.label ?? "項目"}`} open={createOpen} onClose={() => { if (!pendingAction) closeCreateModal(); }} closeDisabled={formPending} busy={formPending}><form key={editingRole?.id ?? editingModel?.id ?? editingMcp?.id ?? editingPrompt ?? editingCredential ?? `new:${tab}`} className="form-stack" onSubmit={submit} onChangeCapture={() => setResourceDraftDirty(true)} aria-busy={formPending} inert={formPending ? true : undefined}>
      {actionError && <div className="form-error" role="alert">{actionError}{tab === "roles" && roleConflictTarget && <button type="button" className="inline-retry" disabled={pendingAction !== null} onClick={() => void retryRoleConflictRefresh()}>重新載入最新版本</button>}</div>}
      {tab !== "roles" && !editingCredential && (tab === "skills" || tab === "prompts" || tab === "credentials" || tab === "models" || tab === "mcp" || tab === "task_adapters") && <label>名稱<input name="name" defaultValue={editingModel?.name ?? editingMcp?.name ?? (tab === "prompts" ? promptDraft.name : "")} required /></label>}
      {tab === "roles" && <>
        {!editingRole && <div className="role-template-picker"><label>起始模板<select value={selectedRoleTemplate} onChange={(event) => setSelectedRoleTemplate(event.target.value as RoleTemplateKey | "")}><option value="">自訂空白</option>{builtInRoleTemplates.map((template) => <option value={template.key} key={template.key}>{template.name}</option>)}</select></label><button type="button" className="secondary-button small" onClick={applyRoleTemplate}>套用</button></div>}
        {editingRole && <p className="role-version-note">目前 v{editingRole.version} · {roleTemplateLabel(editingRole.templateKey)}</p>}
        <label>名稱<input name="name" value={roleDraft.name} onChange={(event) => setRoleField("name", event.target.value)} required /></label>
        <label>適用情境<textarea name="usageContext" rows={2} value={roleDraft.usageContext} onChange={(event) => setRoleField("usageContext", event.target.value)} required /></label>
        <div className="form-grid"><label>工具政策<select name="toolPolicy" value={roleDraft.toolPolicy} onChange={(event) => setRoleToolPolicy(event.target.value as RoleToolPolicy)}><option value="none">不使用外部工具</option><option value="agent_read_only_grants">Agent 已授權唯讀工具</option></select></label><label>資料政策<select name="dataPolicy" value={roleDraft.dataPolicy} onChange={(event) => setRoleDataPolicy(event.target.value as RoleDataPolicy)}><option value="meeting_only">只限本場會議</option><option value="agent_declared_scope">Agent 宣告資料範圍</option></select></label></div>
        <label>職責<textarea name="responsibility" rows={3} value={roleDraft.responsibility} onChange={(event) => setRoleField("responsibility", event.target.value)} required /></label><label>發言準則<textarea name="speakingGuidance" rows={3} value={roleDraft.speakingGuidance} onChange={(event) => setRoleField("speakingGuidance", event.target.value)} required /></label><label>決策範圍<textarea name="decisionScope" rows={2} value={roleDraft.decisionScope} onChange={(event) => setRoleField("decisionScope", event.target.value)} required /></label><label>限制條件<textarea name="constraints" rows={3} value={roleDraft.constraints} onChange={(event) => setRoleField("constraints", event.target.value)} required /></label>
      </>}
      {tab === "skills" && <><div className="form-grid"><label>版本<input name="version" defaultValue="1.0.0" pattern="\d+\.\d+\.\d+" required /></label><label>來源<input name="source" placeholder="例如：內部 Runbook" required /></label></div><label>登記負責人<input name="owner" required /></label><label>Instructions<textarea name="instructions" rows={6} required /></label></>}
      {tab === "credentials" && <>{editingCredentialRecord ? <p className="modal-copy">{editingCredentialRecord.name} · {editingCredentialRecord.provider} · Secret revision {editingCredentialRecord.secretRevision}</p> : <><div className="form-grid"><label>Provider<input name="provider" placeholder="OpenAI / Ollama / Internal" required /></label><label>類型<select name="kind" defaultValue="api_key"><option value="api_key">API Key</option><option value="bearer_token">Bearer Token</option></select></label></div><label>位置<select name="location" defaultValue="cloud"><option value="cloud">雲端</option><option value="local">地端</option></select></label></>}<label>{editingCredential ? "新的密鑰" : "密鑰（可稍後設定）"}<input name="secret" type="password" autoComplete="new-password" required={Boolean(editingCredential)} /></label>{!editingCredential && <label>到期日<input name="expiresAt" type="datetime-local" /></label>}<p className="modal-copy">密鑰只會送往受控 API，頁面不會顯示原文、密文或回傳值。</p></>}
      {tab === "prompts" && <><div className="form-grid"><label>類型<select name="kind" defaultValue={promptDraft.kind}><option value="agent">Agent</option><option value="role">Role</option><option value="meeting">Meeting</option><option value="task">Task</option><option value="output">Output</option></select></label><label>負責人<input name="owner" defaultValue={promptDraft.owner} required /></label></div><label>說明<textarea name="description" rows={2} defaultValue={promptDraft.description} required /></label><label>Variables<input name="variables" defaultValue={promptDraft.variables.join(", ")} placeholder="AGENT_NAME, MEETING_GOAL" /></label><label>Prompt 內容<textarea name="content" rows={9} defaultValue={promptDraft.content} required /></label>{editingPrompt && <p className="modal-copy">儲存會建立下一個草稿版本；已發布版本與既有會議快照不會被改寫。</p>}</>}
      {tab === "models" && <><div className="form-grid"><label>位置<select name="location" defaultValue={editingModel?.location ?? "local"}><option value="local">地端</option><option value="cloud">雲端</option></select></label><label>模型<input name="model" defaultValue={editingModel?.model} required /></label></div><label>Base URL<input name="baseUrl" type="url" defaultValue={editingModel?.baseUrl} placeholder="https://…/v1" required /></label><label>Credential<select name="credentialId" defaultValue={editingModel?.credentialId ?? ""}><option value="">不使用 Credential</option>{inactiveModelCredential && <option value={inactiveModelCredential.id} disabled>{inactiveModelCredential.name} · {inactiveModelCredential.provider} · 目前綁定，{inactiveModelCredential.status === "revoked" ? "已撤銷" : "已停用"}</option>}{modelCredentialOptions.map((credential) => <option value={credential.id} key={credential.id}>{credential.name} · {credential.provider}{credential.hasSecret ? "" : " · 尚未設定密鑰"}</option>)}</select></label>{editingModel && <label className="toggle-row"><input name="enabled" type="checkbox" role="switch" defaultChecked={editingModel.enabled} /><span><strong>啟用 Connector</strong></span></label>}</>}
      {tab === "mcp" && <><div className="form-grid"><label>位置<select name="location" defaultValue={editingMcp?.location ?? "cloud"}><option value="cloud">雲端</option><option value="local">地端</option></select></label><label>MCP URL<input name="baseUrl" type="url" defaultValue={editingMcp?.baseUrl} placeholder="https://…/mcp" required /></label></div>{editableDiscoveredTools && <fieldset><legend>探索到的唯讀工具</legend><div className="check-grid">{editableDiscoveredTools.map((tool) => <label className="check-row skill-check-row" key={tool.name}><input type="checkbox" name="approvedTool" value={tool.name} defaultChecked={editingMcp?.approvedTools.includes(tool.name)} /><span><strong>{tool.name}</strong><small>{tool.description || "唯讀 MCP Tool"}</small></span></label>)}{editableDiscoveredTools.length === 0 && <span>沒有可核准的唯讀工具</span>}</div></fieldset>}<label>{editingMcp ? "Bearer Token（留白則保留）" : "Bearer Token"}<input name="bearerToken" type="password" autoComplete="new-password" /></label>{editingMcp && <label className="toggle-row"><input name="enabled" type="checkbox" role="switch" defaultChecked={editingMcp.enabled} /><span><strong>啟用 Connector</strong></span></label>}</>}
      {tab === "task_adapters" && <><div className="form-grid"><label>位置<select name="location"><option value="local">地端</option><option value="cloud">雲端</option></select></label><label>Base URL<input name="baseUrl" type="url" placeholder="http://service:4200" required /></label></div><label>Bearer Token<input name="bearerToken" type="password" autoComplete="new-password" /></label></>}
      <div className="form-actions"><button type="button" className="secondary-button" disabled={pendingAction !== null} onClick={() => closeCreateModal()}>取消</button><button className="primary-button" disabled={pendingAction !== null || roleConflictTarget !== null || connectorConflictTarget !== null}>{formPending ? <LoaderCircle className="spin-icon" size={14} /> : <CheckCircle2 size={14} />}{formPending ? isEditing ? "儲存中" : "建立中" : isEditing ? "儲存" : "建立"}</button></div>
    </form></Modal>
    <Modal title={promptPreview ? `預覽 ${promptPreview.prompt.name}` : "預覽 Prompt"} open={Boolean(promptPreview)} onClose={() => { if (!promptPreviewPending) { setPromptPreview(null); setPromptPreviewOutput(""); setPromptPreviewError(""); } }} closeDisabled={promptPreviewPending} busy={promptPreviewPending}>
      {promptPreview && <form className="form-stack" onSubmit={runPromptPreview} aria-busy={promptPreviewPending} inert={promptPreviewPending ? true : undefined}>
        <label>版本<select value={promptPreview.version} onChange={(event) => selectPromptPreviewVersion(Number(event.target.value))}>{(promptVersions[promptPreview.prompt.id] ?? []).map((version) => <option value={version.version} key={version.version}>v{version.version}{version.publishedAt ? " · 已發布" : " · 草稿"}</option>)}</select></label>
        {promptPreview.variables.map((variable) => <label key={variable}>{variable}<input value={promptPreviewValues[variable] ?? ""} onChange={(event) => setPromptPreviewValues((current) => ({ ...current, [variable]: event.target.value }))} /></label>)}
        {promptPreview.variables.length === 0 && <p className="modal-copy">此版本沒有變數。</p>}
        {promptPreviewError && <div className="form-error" role="alert">{promptPreviewError}</div>}
        {promptPreviewOutput && <pre className="prompt-preview-output" aria-label="Prompt 預覽結果">{promptPreviewOutput}</pre>}
        <div className="form-actions"><button type="button" className="secondary-button" disabled={promptPreviewPending} onClick={() => { setPromptPreview(null); setPromptPreviewOutput(""); setPromptPreviewError(""); }}>關閉</button><button className="primary-button" disabled={promptPreviewPending}>{promptPreviewPending ? <LoaderCircle className="spin-icon" size={14} /> : <FileText size={14} />}{promptPreviewPending ? "產生中" : "產生預覽"}</button></div>
      </form>}
    </Modal>
    <Modal title={lifecycleModalTitle} open={Boolean(lifecycleRole)} onClose={() => closeRoleLifecycle()} closeDisabled={roleLifecyclePending} busy={roleLifecyclePending} describedBy={!roleLifecycleLoading && roleLifecycle ? "role-lifecycle-description" : undefined} focusKey={`${roleLifecycleMode}:${roleLifecycleLoading ? "loading" : roleLifecycle ? "ready" : "error"}`} restoreFocusId="settings-panel-roles">
      {roleLifecycleLoading && <div className="role-lifecycle-state" role="status"><LoaderCircle className="spin-icon" size={16} />載入版本歷程</div>}
      {!roleLifecycleLoading && roleLifecycleError && !roleLifecycle && <div className="role-lifecycle-panel"><div className="form-error" role="alert">{roleLifecycleError}</div><div className="form-actions"><button className="secondary-button" onClick={() => closeRoleLifecycle()}>取消</button><button className="primary-button" onClick={() => { if (lifecycleRole) void loadRoleLifecycle(lifecycleRole); }}>重新載入</button></div></div>}
      {!roleLifecycleLoading && roleLifecycle && roleLifecycleMode === "history" && <div className="role-lifecycle-panel">
        <p className="modal-copy" id="role-lifecycle-description">目前使用 v{roleLifecycle.role.version}；回復會建立新版本，不會改寫既有會議。</p>
        {roleLifecycleError && <div className="form-error" role="alert">{roleLifecycleError}<button className="inline-retry" onClick={() => void loadRoleLifecycle(roleLifecycle.role)}>重新載入</button></div>}
        {roleLifecycle.missingVersions.length > 0 && <p className="form-warning">舊資料缺少 v{roleLifecycle.missingVersions.join("、v")} 的完整定義；平台不會從 audit 猜測內容。</p>}
        <ol className="role-version-list" aria-label={`${roleLifecycle.role.name}完整版本歷程`}>{roleLifecycle.versions.map((version) => <li key={version.version}><div><strong>v{version.version}</strong>{version.version === roleLifecycle.role.version && <span className="state-label approved">目前使用</span>}<span>{roleVersionSourceLabel(version.source)}{version.restoredFromVersion ? `自 v${version.restoredFromVersion}` : ""}</span></div><time dateTime={version.recordedAt}>{formatRoleVersionTime(version.recordedAt)}</time></li>)}</ol>
        {roleLifecycle.versions.some((version) => version.version < roleLifecycle.role.version) ? <>
          <label className="role-version-select">比較版本<select value={selectedRoleVersion ?? ""} onChange={(event) => setSelectedRoleVersion(Number(event.target.value))}>{roleLifecycle.versions.filter((version) => version.version < roleLifecycle.role.version).map((version) => <option value={version.version} key={version.version}>v{version.version} · {roleVersionSourceLabel(version.source)}</option>)}</select></label>
          <section className="role-version-comparison" aria-label="角色版本差異"><h3>v{selectedRoleVersion} 與目前 v{roleLifecycle.role.version}</h3>{roleDifferences.length > 0 ? <dl>{roleDifferences.map((difference) => <div key={difference.field}><dt>{difference.label}</dt><dd><span><b>v{selectedRoleVersion}</b>{difference.selected}</span><span><b>目前</b>{difference.current}</span></dd></div>)}</dl> : <p>兩個版本的可執行內容相同。</p>}</section>
        </> : <p className="role-lifecycle-empty">目前只有初始版本。</p>}
        <div className="role-delete-zone"><div><strong>刪除角色</strong><p>{roleLifecycle.canDelete ? `角色會從可用清單移除；${roleLifecycle.historicalMeetingCount} 場歷史會議與版本證據會保留。` : roleDeleteBlocker}</p></div><button className="secondary-button danger-command" disabled={!roleLifecycle.canDelete || lifecycleMutationBlocked} onClick={() => { setRoleLifecycleError(""); setRoleLifecycleMode("confirm_delete"); }} aria-label={roleLifecycle.canDelete ? `刪除${roleLifecycle.role.name}` : `無法刪除${roleLifecycle.role.name}：${roleDeleteBlocker}`}><Trash2 size={14} />刪除</button></div>
        <div className="form-actions role-lifecycle-actions"><button className="secondary-button" disabled={roleLifecyclePending} onClick={() => closeRoleLifecycle()}>取消</button><button className="primary-button" disabled={!comparedRoleVersion || comparedRoleVersion.version === roleLifecycle.role.version || lifecycleMutationBlocked} onClick={() => setRoleLifecycleMode("confirm_rollback")}><RotateCcw size={14} />{comparedRoleVersion && comparedRoleVersion.version !== roleLifecycle.role.version ? `以 v${comparedRoleVersion.version} 內容建立 v${roleLifecycle.role.version + 1}` : "沒有可回復版本"}</button></div>
      </div>}
      {!roleLifecycleLoading && roleLifecycle && roleLifecycleMode === "confirm_rollback" && comparedRoleVersion && <div className="role-lifecycle-panel" id="role-lifecycle-description"><p className="modal-copy">目前 v{roleLifecycle.role.version} 會保留。確認後以 v{comparedRoleVersion.version} 的內容建立 v{roleLifecycle.role.version + 1}，既有會議不變。</p><div className="form-actions"><button className="secondary-button" disabled={roleLifecyclePending} onClick={() => setRoleLifecycleMode("history")}>返回</button><button className="primary-button" disabled={lifecycleMutationBlocked} onClick={() => void rollbackRole()}>{roleLifecyclePending ? <LoaderCircle className="spin-icon" size={14} /> : <RotateCcw size={14} />}{roleLifecyclePending ? "回復中" : `確認建立 v${roleLifecycle.role.version + 1}`}</button></div></div>}
      {!roleLifecycleLoading && roleLifecycle && roleLifecycleMode === "confirm_delete" && <form className="form-stack" id="role-lifecycle-description" onSubmit={(event) => { event.preventDefault(); void deleteRole(); }}><p className="modal-copy">這會將角色從可用清單移除，但保留角色身分、完整版本歷程與 {roleLifecycle.historicalMeetingCount} 場歷史會議快照。</p><label>輸入完整角色名稱「{roleLifecycle.role.name}」確認<input value={roleDeleteConfirmation} onChange={(event) => setRoleDeleteConfirmation(event.target.value)} autoComplete="off" required /></label><div className="form-actions"><button type="button" className="secondary-button" disabled={roleLifecyclePending} onClick={() => { setRoleDeleteConfirmation(""); setRoleLifecycleMode("history"); }}>返回</button><button className="primary-button danger-button" disabled={lifecycleMutationBlocked || roleDeleteConfirmation !== roleLifecycle.role.name}>{roleLifecyclePending ? <LoaderCircle className="spin-icon" size={14} /> : <Trash2 size={14} />}{roleLifecyclePending ? "刪除中" : "確認刪除"}</button></div></form>}
    </Modal>
    <Modal title={`編輯${editingTool?.registration.displayName ?? "工具"}`} open={Boolean(editingTool)} onClose={requestCloseToolRegistration} closeDisabled={toolRegistrationPending} busy={toolRegistrationPending}><form className="form-stack" onSubmit={updateToolRegistration} onChangeCapture={() => setToolRegistrationDirty(true)} aria-busy={toolRegistrationPending} inert={toolRegistrationPending ? true : undefined}>
      {actionError && <div className="form-error" role="alert">{actionError}</div>}
      <label>Server Tool Name<input value={editingTool?.registration.toolName ?? ""} readOnly /></label>
      <label>顯示名稱<input name="displayName" defaultValue={editingTool?.registration.displayName} required /></label>
      <div className="form-grid"><label>來源類型<select name="kind" defaultValue={editingTool?.registration.kind}>{toolKinds.map((kind) => <option value={kind} key={kind}>{toolRegistrationKindLabel(kind)}</option>)}</select></label><label>版本<input name="version" defaultValue={editingTool?.registration.version} required /></label></div>
      <label>負責人<input name="owner" defaultValue={editingTool?.registration.owner} required /></label>
      <label>目標<textarea name="goal" rows={4} defaultValue={editingTool?.registration.goal} required /></label>
      <div className="form-actions"><button type="button" className="secondary-button" disabled={pendingAction !== null} onClick={requestCloseToolRegistration}>取消</button><button className="primary-button" disabled={pendingAction !== null}>{toolRegistrationPending ? "儲存中" : "儲存"}</button></div>
    </form></Modal>
    <Modal title={`記錄${validationSkill?.name ?? "Skill"}驗證`} open={Boolean(validationSkill)} onClose={requestCloseSkillValidation} closeDisabled={pendingAction !== null} busy={pendingAction !== null}><form className="form-stack" onSubmit={recordValidation} onChangeCapture={() => setSkillValidationDraftDirty(true)} aria-busy={pendingAction !== null} inert={pendingAction !== null ? true : undefined}>{actionError && <div className="form-error" role="alert">{actionError}</div>}<p className="modal-copy">這是人工證據記錄，不會自動掃描內容，也不會抓取 Skill 來源。請只記錄已完成的檢視結果。</p><fieldset className="validation-choice"><legend>驗證結果</legend><label><input type="radio" name="result" value="passed" defaultChecked />通過</label><label><input type="radio" name="result" value="failed" />失敗</label></fieldset><label>證據摘要<textarea name="summary" rows={5} placeholder="記錄檢視者、範圍與結論" required /></label><div className="form-actions"><button type="button" className="secondary-button" disabled={pendingAction !== null} onClick={requestCloseSkillValidation}>取消</button><button className="primary-button" disabled={pendingAction !== null}>{pendingAction === `validation:${validationSkill?.id}` ? <LoaderCircle className="spin-icon" size={14} /> : <ClipboardCheck size={14} />}{pendingAction === `validation:${validationSkill?.id}` ? "記錄中" : "記錄驗證"}</button></div></form></Modal>
    <Modal title={`撤銷${skillToRevoke?.name ?? "Skill"}`} open={Boolean(skillToRevoke)} onClose={requestCloseSkillRevocation} closeDisabled={pendingAction !== null} busy={pendingAction !== null}><form className="form-stack" onSubmit={revokeSkill} onChangeCapture={() => setSkillRevocationDraftDirty(true)} aria-busy={pendingAction !== null} inert={pendingAction !== null ? true : undefined}>{actionError && <div className="form-error" role="alert">{actionError}</div>}<p className="modal-copy">撤銷後 Skill 不能再指派給 Agent；現有指派會由後端移除。</p><label>撤銷原因<textarea name="reason" rows={4} placeholder="請填寫撤銷原因" required /></label><div className="form-actions"><button type="button" className="secondary-button" disabled={pendingAction !== null} onClick={requestCloseSkillRevocation}>取消</button><button className="primary-button" disabled={lifecycleMutationBlocked}>{pendingAction === `revoke:${skillToRevoke?.id}` ? <LoaderCircle className="spin-icon" size={14} /> : <XCircle size={14} />}{pendingAction === `revoke:${skillToRevoke?.id}` ? "撤銷中" : "確認撤銷"}</button></div></form></Modal>
  </Container>;
}
