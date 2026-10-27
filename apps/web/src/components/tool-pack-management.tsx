"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type {
  AgentReadiness,
  CreateToolPackInput,
  ToolPack,
  ToolPackDeclaredTool,
  ToolPackRevision
} from "@council/contracts";
import { CommittedMutationProjectionError } from "../app/providers";
import { ApiError, managementApi } from "../lib/api";
import { managementMutationRetryDisposition } from "../lib/management-mutation-recovery";
import { ManagementMutationRetrySignature } from "../lib/management-mutation-retry";
import { maskToolPackDigest, toolPackSourceName, toolPackUsageSummary } from "../lib/tool-pack-ui";
import { IdempotencyRetryRegistry, type IdempotencyRetryToken } from "../lib/view-model";
import { Modal } from "./ui";
import { ToolPackRegistry } from "./tool-pack-registry";

const STANDARD_TOOL_PACK_ENTRYPOINT = "/opt/council/tool-pack/bin/entrypoint";

export interface ToolPackDraft {
  name: string;
  version: string;
  description: string;
  owner: string;
  sourceReference: string;
  imageDigest: string;
  tools: ToolPackDeclaredTool[];
}

export function createEmptyToolPackTool(): ToolPackDeclaredTool {
  return {
    name: "",
    kind: "command",
    goal: "",
    access: "read_only",
    argv: { executable: STANDARD_TOOL_PACK_ENTRYPOINT, fixedArguments: [] },
    env: { allowedNames: [] },
    stdin: { mode: "none" }
  };
}

export function createToolPackDraft(pack?: ToolPack): ToolPackDraft {
  return pack ? {
    name: pack.name,
    version: pack.version,
    description: pack.description,
    owner: pack.owner,
    sourceReference: "",
    imageDigest: "",
    tools: structuredClone(pack.tools)
  } : {
    name: "",
    version: "1.0.0",
    description: "",
    owner: "Platform Owner",
    sourceReference: "",
    imageDigest: "",
    tools: [createEmptyToolPackTool()]
  };
}

export function toolPackInputFromDraft(draft: ToolPackDraft, existing?: ToolPack): CreateToolPackInput {
  const sourceReference = draft.sourceReference.trim() || existing?.sourceReference || "";
  const imageDigest = draft.imageDigest.trim() || existing?.imageDigest || "";
  return {
    name: draft.name.trim(),
    version: draft.version.trim(),
    description: draft.description.trim(),
    owner: draft.owner.trim(),
    sourceReference,
    imageDigest,
    tools: draft.tools.map((tool) => {
      const name = tool.name.trim();
      return {
        ...tool,
        name,
        goal: tool.goal.trim(),
        argv: tool.argv.executable === STANDARD_TOOL_PACK_ENTRYPOINT
          ? { executable: STANDARD_TOOL_PACK_ENTRYPOINT, fixedArguments: [name] }
          : { ...tool.argv, fixedArguments: [...tool.argv.fixedArguments] },
        env: { allowedNames: [...tool.env.allowedNames] },
        stdin: { ...tool.stdin }
      };
    })
  };
}

export function ToolPackManagement({
  packs,
  revisions,
  agents,
  readAgentReadiness,
  commitMutation,
  onMessage
}: {
  packs: ToolPack[];
  revisions: ToolPackRevision[];
  agents: Array<{ id: string; toolPackGrants: Array<{ packId: string }> }>;
  readAgentReadiness(agentId: string): AgentReadiness | null;
  commitMutation<T>(commit: () => Promise<T>): Promise<T>;
  onMessage(message: string, error?: boolean): void;
}) {
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPack, setEditingPack] = useState<ToolPack | null>(null);
  const [draft, setDraft] = useState<ToolPackDraft>(() => createToolPackDraft());
  const [editorDirty, setEditorDirty] = useState(false);
  const toolPackCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());
  const managementMutationRetrySignatureRef = useRef(new ManagementMutationRetrySignature());
  const [validationPack, setValidationPack] = useState<ToolPack | null>(null);
  const [validationResult, setValidationResult] = useState<"passed" | "failed">("passed");
  const [validationSummary, setValidationSummary] = useState("");
  const [revokePack, setRevokePack] = useState<ToolPack | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  useEffect(() => {
    if (selectedPackId && packs.some((pack) => pack.id === selectedPackId)) return;
    setSelectedPackId(packs[0]?.id ?? null);
  }, [packs, selectedPackId]);

  function reportError(cause: unknown, fallback: string): void {
    const message = cause instanceof ApiError && cause.status === 409
      ? `stale_snapshot：${cause.message}`
      : cause instanceof Error ? cause.message : fallback;
    onMessage(message, true);
  }

  function openEditor(pack?: ToolPack): void {
    setEditingPack(pack ?? null);
    setDraft(createToolPackDraft(pack));
    setEditorDirty(false);
    setEditorOpen(true);
  }

  function closeEditor(): void {
    if (pending) return;
    if (editorDirty && !window.confirm("Tool Pack 草稿尚未儲存，確定捨棄？")) return;
    setEditorDirty(false);
    setEditorOpen(false);
    setEditingPack(null);
  }

  function updateDraft(update: (current: ToolPackDraft) => ToolPackDraft): void {
    setEditorDirty(true);
    setDraft(update);
  }

  async function saveToolPack(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const input = toolPackInputFromDraft(draft, editingPack ?? undefined);
    let createRetry: IdempotencyRetryToken | null = null;
    setPending(true);
    try {
      let saved: ToolPack;
      if (editingPack) {
        saved = await commitMutation(() => managementApi.updateToolPack(editingPack.id, {
          expectedRevision: editingPack.revision,
          ...input
        }));
      } else {
        const signature = await managementMutationRetrySignatureRef.current.forPayload("tool-pack.create", input);
        const retryToken = toolPackCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID());
        createRetry = retryToken;
        saved = await commitMutation(() => (
          managementApi.createToolPack(input, retryToken.idempotencyKey)
        ));
        toolPackCreationRetryRegistryRef.current.settle(retryToken);
      }
      setSelectedPackId(saved.id);
      setEditorDirty(false);
      setEditorOpen(false);
      setEditingPack(null);
      onMessage(editingPack ? "Tool Pack 已更新，驗證已重設。" : "Tool Pack 已登記，等待驗證。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        if (createRetry) toolPackCreationRetryRegistryRef.current.settle(createRetry);
        const saved = cause.result as ToolPack;
        setSelectedPackId(saved.id);
        setEditorDirty(false);
        setEditorOpen(false);
        setEditingPack(null);
        onMessage(`Tool Pack 已${editingPack ? "更新" : "登記"}，但清單刷新失敗；請重新整理以載入最新資料。`);
      } else {
        if (createRetry && managementMutationRetryDisposition(cause) === "clear") {
          toolPackCreationRetryRegistryRef.current.settle(createRetry);
        }
        reportError(cause, "無法儲存 Tool Pack。");
      }
    } finally {
      setPending(false);
    }
  }

  async function recordValidation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!validationPack) return;
    setPending(true);
    try {
      await commitMutation(() => managementApi.validateToolPack(validationPack.id, {
        expectedRevision: validationPack.revision,
        manifestDigest: validationPack.manifestDigest,
        result: validationResult,
        summary: validationSummary.trim()
      }));
      setValidationPack(null);
      setValidationSummary("");
      onMessage(validationResult === "passed" ? "Tool Pack 驗證已記錄。" : "Tool Pack 驗證失敗已記錄。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setValidationPack(null);
        setValidationSummary("");
        onMessage("Tool Pack 驗證已記錄，但清單刷新失敗；請重新整理以載入最新資料。");
      } else {
        reportError(cause, "無法記錄 Tool Pack 驗證。");
      }
    } finally {
      setPending(false);
    }
  }

  async function approve(pack: ToolPack): Promise<void> {
    if (!window.confirm(`核准 ${pack.name} v${pack.version} Rev ${pack.revision}？`)) return;
    setPending(true);
    try {
      await commitMutation(() => managementApi.approveToolPack(pack.id, {
        expectedRevision: pack.revision,
        manifestDigest: pack.manifestDigest
      }));
      onMessage("Tool Pack 已核准，可綁定 Agent 草稿。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        onMessage("Tool Pack 已核准，但清單刷新失敗；請重新整理以載入最新資料。");
      } else {
        reportError(cause, "無法核准 Tool Pack。");
      }
    } finally {
      setPending(false);
    }
  }

  async function revoke(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!revokePack) return;
    setPending(true);
    try {
      await commitMutation(() => managementApi.revokeToolPack(revokePack.id, {
        expectedRevision: revokePack.revision,
        reason: revokeReason.trim()
      }));
      setRevokePack(null);
      setRevokeReason("");
      onMessage("Tool Pack 已撤銷，既有 Agent 綁定已阻擋。");
    } catch (cause) {
      if (cause instanceof CommittedMutationProjectionError) {
        setRevokePack(null);
        setRevokeReason("");
        onMessage("Tool Pack 已撤銷，但清單刷新失敗；請重新整理以載入最新資料。");
      } else {
        reportError(cause, "無法撤銷 Tool Pack。");
      }
    } finally {
      setPending(false);
    }
  }

  function updateTool(index: number, update: Partial<Pick<ToolPackDeclaredTool, "name" | "kind" | "goal">> & { stdinMode?: "none" | "json" | "text" }): void {
    const { stdinMode, ...fields } = update;
    updateDraft((current) => ({
      ...current,
      tools: current.tools.map((tool, toolIndex) => {
        if (toolIndex !== index) return tool;
        const nextStdin = stdinMode === undefined
          ? tool.stdin
          : stdinMode === "none" ? { mode: "none" as const } : { mode: stdinMode, maxBytes: 65_536 };
        return { ...tool, ...fields, stdin: nextStdin };
      })
    }));
  }

  return (
    <>
      <ToolPackRegistry
        packs={packs}
        revisions={revisions}
        selectedPackId={selectedPackId}
        readUsage={(packId) => toolPackUsageSummary(agents.map((agent) => ({
          id: agent.id,
          blocked: readAgentReadiness(agent.id)?.status === "blocked",
          grants: agent.toolPackGrants
        })), packId)}
        pending={pending}
        onSelect={setSelectedPackId}
        onCreate={() => openEditor()}
        onEdit={openEditor}
        onValidate={(pack) => {
          setValidationPack(pack);
          setValidationResult("passed");
          setValidationSummary("");
        }}
        onApprove={(pack) => void approve(pack)}
        onRevoke={(pack) => {
          setRevokePack(pack);
          setRevokeReason("");
        }}
      />

      <Modal title={editingPack ? `編輯 ${editingPack.name}` : "登記 Tool Pack"} open={editorOpen} onClose={closeEditor} closeDisabled={pending} busy={pending}>
        <form className="form-stack" onSubmit={(event) => void saveToolPack(event)}>
          <div className="form-grid">
            <label>名稱<input value={draft.name} onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))} required /></label>
            <label>Semantic version<input value={draft.version} onChange={(event) => updateDraft((current) => ({ ...current, version: event.target.value }))} placeholder="1.0.0" required /></label>
          </div>
          <label>用途<textarea rows={2} value={draft.description} onChange={(event) => updateDraft((current) => ({ ...current, description: event.target.value }))} /></label>
          <label>擁有者<input value={draft.owner} onChange={(event) => updateDraft((current) => ({ ...current, owner: event.target.value }))} required /></label>
          {editingPack && (
            <div className="form-warning" role="status">
              現有來源 {toolPackSourceName(editingPack.sourceReference)} · Image {maskToolPackDigest(editingPack.imageDigest)}；留白即保留。
            </div>
          )}
          <label>
            Digest-pinned source
            <input type="password" autoComplete="new-password" value={draft.sourceReference} onChange={(event) => updateDraft((current) => ({ ...current, sourceReference: event.target.value }))} placeholder={editingPack ? "留白保留目前來源" : "registry.example.com/team/pack@sha256:..."} required={!editingPack} />
          </label>
          <label>
            Image digest
            <input type="password" autoComplete="new-password" value={draft.imageDigest} onChange={(event) => updateDraft((current) => ({ ...current, imageDigest: event.target.value }))} placeholder={editingPack ? "留白保留目前 digest" : "sha256:..."} required={!editingPack} />
          </label>
          <fieldset>
            <legend>唯讀工具</legend>
            <div className="tool-pack-editor-list">
              {draft.tools.map((tool, index) => (
                <div className="tool-pack-editor-row" key={index}>
                  <div className="form-grid">
                    <label>工具名稱<input value={tool.name} onChange={(event) => updateTool(index, { name: event.target.value })} required /></label>
                    <label>類型<select value={tool.kind} onChange={(event) => updateTool(index, { kind: event.target.value as ToolPackDeclaredTool["kind"] })}><option value="command">命令工具</option><option value="function">函式</option><option value="library">函式庫</option></select></label>
                  </div>
                  <label>目標<textarea rows={2} value={tool.goal} onChange={(event) => updateTool(index, { goal: event.target.value })} required /></label>
                  <div className="tool-pack-editor-actions">
                    <label>輸入<select value={tool.stdin.mode} onChange={(event) => updateTool(index, { stdinMode: event.target.value as "none" | "json" | "text" })}><option value="none">不接受輸入</option><option value="json">JSON</option><option value="text">文字</option></select></label>
                    <button className="icon-button" type="button" title="移除工具" aria-label={`移除工具 ${index + 1}`} disabled={draft.tools.length === 1} onClick={() => updateDraft((current) => ({ ...current, tools: current.tools.filter((_, toolIndex) => toolIndex !== index) }))}><Trash2 size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
            <button className="secondary-button small" type="button" onClick={() => updateDraft((current) => ({ ...current, tools: [...current.tools, createEmptyToolPackTool()] }))}><Plus size={13} />新增工具</button>
          </fieldset>
          <div className="form-actions"><button className="secondary-button" type="button" disabled={pending} onClick={closeEditor}>取消</button><button className="primary-button" disabled={pending}>{pending ? "儲存中" : editingPack ? "儲存並重設驗證" : "登記"}</button></div>
        </form>
      </Modal>

      <Modal title={validationPack ? `記錄 ${validationPack.name} 驗證` : "記錄驗證"} open={Boolean(validationPack)} onClose={() => { if (!pending) setValidationPack(null); }}>
        <form className="form-stack" onSubmit={(event) => void recordValidation(event)}>
          <label>結果<select value={validationResult} onChange={(event) => setValidationResult(event.target.value as "passed" | "failed")}><option value="passed">通過</option><option value="failed">失敗</option></select></label>
          <label>驗證摘要<textarea rows={4} value={validationSummary} onChange={(event) => setValidationSummary(event.target.value)} required /></label>
          <div className="form-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => setValidationPack(null)}>取消</button><button className="primary-button" disabled={pending}>{pending ? "記錄中" : "記錄"}</button></div>
        </form>
      </Modal>

      <Modal title={revokePack ? `撤銷 ${revokePack.name}` : "撤銷 Tool Pack"} open={Boolean(revokePack)} onClose={() => { if (!pending) setRevokePack(null); }}>
        <form className="form-stack" onSubmit={(event) => void revoke(event)}>
          <div className="form-warning" role="status">撤銷是終止狀態，既有 Agent grant 會立即 blocked。</div>
          <label>撤銷原因<textarea rows={4} value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} required /></label>
          <div className="form-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => setRevokePack(null)}>取消</button><button className="primary-button danger-button" disabled={pending}>{pending ? "撤銷中" : "確認撤銷"}</button></div>
        </form>
      </Modal>
    </>
  );
}
