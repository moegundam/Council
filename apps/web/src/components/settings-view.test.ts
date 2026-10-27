import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./settings-view.tsx", import.meta.url), "utf8");

function functionSource(name: string, nextName: string): string {
  return source.slice(source.indexOf(`  ${name}`), source.indexOf(`  ${nextName}`));
}

describe("Settings async request ownership", () => {
  it("keeps full-page defaults while embedded resource management guards dirty and pending exits", () => {
    expect(source).toContain("export type SettingsTab");
    expect(source).toContain("export function SettingsView({ initialTab, embedded = false, onBack }");
    expect(source).toContain('useState<Tab>(initialTab ?? (embedded ? "models" : "roles"))');
    expect(source).toContain("function requestEmbeddedBack()");
    expect(source).toContain("if (!onBack || pendingAction !== null) return;");
    expect(source).toContain("設定草稿尚未儲存，確定返回 Agent？");
    expect(source).toContain("closeCreateModal(true);");
    expect(source).toContain("setEditingTool(null);");
    expect(source).toContain("onBack();");
  });

  it("retains exact Role payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const successFlow = submit.slice(0, submit.indexOf("} catch (cause)"));
    const roleMutation = submit.slice(submit.indexOf('if (tab === "roles")'), submit.indexOf('if (tab === "skills")'));

    expect(source).toContain("const roleCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(roleMutation).toContain("const requestPayload = roleCreateRequestPayload(roleDraft);");
    expect(roleMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("role.create", requestPayload)');
    expect(roleMutation).toContain("roleCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(roleMutation).toContain("retryOwnership = { registry: roleCreationRetryRegistryRef.current, token: retryToken };");
    expect(roleMutation).toContain('headers: { "Idempotency-Key": retryToken.idempotencyKey }');
    expect(roleMutation).toContain("body: JSON.stringify(requestPayload)");
    expect(source).not.toContain("roleCreationRetryRef");
    expect(roleMutation).not.toContain("await refresh()");
    expect(successFlow).not.toContain("await refreshRequired()");
    expect(successFlow).toContain("await commitMutation(() => managementApi.createCredential(requestPayload, retryToken.idempotencyKey));");
    expect(successFlow).toContain("await commitMutation(() => managementApi.createPrompt(");
  });

  it("treats a committed Role mutation as success and closes the duplicate-capable form", () => {
    const submit = functionSource("async function submit(", "async function health(");

    expect(source).toContain("CommittedMutationProjectionError");
    expect(submit).toContain("cause instanceof CommittedMutationProjectionError");
    expect(submit).toContain("const committedRole = cause.result as Role;");
    expect(submit).toContain("if (retryOwnership) retryOwnership.registry.settle(retryOwnership.token);");
    expect(submit).toContain("setCreateOpen(false);");
    expect(submit).toContain("setEditingRole(null);");
    expect(submit).toContain("清單刷新失敗；請重新整理以載入最新資料");
  });

  it("retains exact Skill payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const skillMutation = submit.slice(submit.indexOf('if (tab === "skills")'), submit.indexOf('if (tab === "credentials")'));
    expect(source).toContain("const skillCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(skillMutation).toContain("const requestPayload = {");
    expect(skillMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("skill.create", requestPayload)');
    expect(skillMutation).toContain("skillCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(skillMutation).toContain("retryOwnership = { registry: skillCreationRetryRegistryRef.current, token: retryToken };");
    expect(skillMutation).toContain('headers: { "Idempotency-Key": retryToken.idempotencyKey }');
    expect(skillMutation).toContain("body: JSON.stringify(requestPayload)");
    expect(source).not.toContain("skillCreationRetryRef");
  });

  it("retains exact Credential payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const credentialMutation = submit.slice(submit.indexOf('if (tab === "credentials")'), submit.indexOf('if (tab === "prompts")'));

    expect(source).toContain("const credentialCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(source).toContain("const managementMutationRetrySignatureRef = useRef(new ManagementMutationRetrySignature());");
    expect(credentialMutation).toContain("const requestPayload = credentialInput;");
    expect(credentialMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("credential.create", requestPayload)');
    expect(credentialMutation).toContain("credentialCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(credentialMutation).toContain("retryOwnership = { registry: credentialCreationRetryRegistryRef.current, token: retryToken };");
    expect(credentialMutation).toContain("managementApi.createCredential(requestPayload, retryToken.idempotencyKey)");
    expect(source).not.toContain("credentialCreationRetryRef");
  });

  it("retains exact Prompt payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const promptMutation = submit.slice(submit.indexOf('if (tab === "prompts")'), submit.indexOf('if (tab === "models")'));
    expect(source).toContain("const promptCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(promptMutation).toContain("const requestPayload = {");
    expect(promptMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("prompt.create", requestPayload)');
    expect(promptMutation).toContain("promptCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(promptMutation).toContain("retryOwnership = { registry: promptCreationRetryRegistryRef.current, token: retryToken };");
    expect(promptMutation).toContain("managementApi.createPrompt(requestPayload, retryToken.idempotencyKey)");
    expect(source).not.toContain("promptCreationRetryRef");
  });

  it("refreshes stale Prompt metadata while preserving the open editor draft", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const conflictBranch = submit.slice(
      submit.indexOf('tab === "prompts" && isRevisionConflictError(cause) && editingPrompt'),
      submit.indexOf('isRevisionConflictError(cause) && (editingModel || editingMcp)')
    );

    expect(conflictBranch).toContain("await refreshRequired();");
    expect(conflictBranch).toContain("目前草稿仍保留");
    expect(conflictBranch).not.toContain("setEditingPrompt(null)");
    expect(conflictBranch).not.toContain("setCreateOpen(false)");
  });

  it("retains exact MCP Connector payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const mcpMutation = submit.slice(submit.indexOf('if (tab === "mcp")'), submit.indexOf('if (tab === "task_adapters")'));

    expect(source).toContain("const mcpCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(mcpMutation).toContain("const requestPayload = {");
    expect(mcpMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("mcp-connector.create", requestPayload)');
    expect(mcpMutation).toContain("mcpCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(mcpMutation).toContain("retryOwnership = { registry: mcpCreationRetryRegistryRef.current, token: retryToken };");
    expect(mcpMutation).toContain('headers: { "Idempotency-Key": retryToken.idempotencyKey }');
    expect(mcpMutation).toContain("body: JSON.stringify(requestPayload)");
    expect(source).not.toContain("mcpCreationRetryRef");
  });

  it("retains exact Model Connector payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const modelMutation = submit.slice(submit.indexOf('if (tab === "models")'), submit.indexOf('if (tab === "mcp")'));

    expect(source).toContain("const modelCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(modelMutation).toContain("const requestPayload = {");
    expect(modelMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("model-connector.create", requestPayload)');
    expect(modelMutation).toContain("modelCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(modelMutation).toContain("retryOwnership = { registry: modelCreationRetryRegistryRef.current, token: retryToken };");
    expect(modelMutation).toContain('headers: { "Idempotency-Key": retryToken.idempotencyKey }');
    expect(modelMutation).toContain("body: JSON.stringify(requestPayload)");
    expect(source).not.toContain("modelCreationRetryRef");
  });

  it("retains exact Task Adapter payload ownership across lost acknowledgements and independent drafts", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const taskAdapterMutation = submit.slice(submit.indexOf('if (tab === "task_adapters")'), submit.indexOf("setResourceDraftDirty(false)"));

    expect(source).toContain("const taskAdapterCreationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(taskAdapterMutation).toContain("const requestPayload = {");
    expect(taskAdapterMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("task-adapter-connector.create", requestPayload)');
    expect(taskAdapterMutation).toContain("taskAdapterCreationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(taskAdapterMutation).toContain("retryOwnership = { registry: taskAdapterCreationRetryRegistryRef.current, token: retryToken };");
    expect(taskAdapterMutation).toContain('headers: { "Idempotency-Key": retryToken.idempotencyKey }');
    expect(taskAdapterMutation).toContain("body: JSON.stringify(requestPayload)");
    expect(source).not.toContain("taskAdapterCreationRetryRef");
  });

  it("settles retry ownership only after success, committed projection, or a deterministic client failure", () => {
    const submit = functionSource("async function submit(", "async function health(");

    expect(submit).toContain("retryOwnership.registry.settle(retryOwnership.token);");
    expect(submit).toContain("cause instanceof CommittedMutationProjectionError");
    expect(submit).toContain('managementMutationRetryDisposition(cause) !== "retain"');
  });

  it("does not discard unresolved ownership on form edits, modal close/reopen, or tab switches", () => {
    const closeCreateModal = functionSource("function closeCreateModal(", "function openCreateModal(");
    const openCreateModal = functionSource("function openCreateModal(", "function openRoleEditor(");
    const selectTab = functionSource("function selectTab(", "function handleTabKeyDown(");
    const resourceForm = source.slice(
      source.indexOf('<Modal title={editingRole ?'),
      source.indexOf('<Modal title={promptPreview ?')
    );
    const lifecycleSource = [closeCreateModal, openCreateModal, selectTab, resourceForm].join("\n");

    expect(lifecycleSource).not.toMatch(/(?:roleCreation|skillCreation|promptCreation|credentialCreation|credentialRotation|modelCreation|mcpCreation|taskAdapterCreation)Retry(?:Registry)?Ref/);
  });

  it("three-way merges a Role draft after conflict and waits for another save", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const retry = functionSource("async function retryRoleConflictRefresh(", "async function health(");
    const conflictEffectStart = source.indexOf("    if (!roleConflictTarget || !snapshot || !editingRole");
    const conflictEffect = source.slice(conflictEffectStart, source.indexOf("  }, [editingRole, roleConflictTarget, roleDraft, snapshot]);", conflictEffectStart));

    expect(source).toContain("const [roleConflictTarget, setRoleConflictTarget]");
    expect(source).toContain("mergeRoleDraftAfterConflict");
    expect(conflictEffect).toContain("setEditingRole");
    expect(conflictEffect).toContain("mergeRoleDraftAfterConflict(draftFromRole(editingRole), roleDraft, draftFromRole(latest))");
    expect(conflictEffect).toContain("setRoleDraft(merged.draft)");
    expect(conflictEffect).toContain("已保留伺服器版本");
    expect(conflictEffect).toContain("setRoleConflictTarget(null)");
    expect(conflictEffect).toContain("再儲存");
    expect(submit).toContain("isRevisionConflictError(cause) && editingRole");
    expect(submit).toContain("previousVersion: editingRole.version");
    expect(submit).toContain("await refreshRequired();");
    expect(submit).not.toContain("return submit(");
    expect(retry).toContain("await refreshRequired();");
    expect(source).toContain("roleConflictTarget && <button");
    expect(source).toContain("重新載入最新版本");
  });

  it("treats committed Role lifecycle mutations as success without leaving a retryable modal", () => {
    const rollback = functionSource("async function rollbackRole(", "async function deleteRole(");
    const deletion = functionSource("async function deleteRole(", "function applyRoleTemplate(");

    for (const lifecycleHandler of [rollback, deletion]) {
      const committedRecoveryStart = lifecycleHandler.indexOf("cause instanceof CommittedMutationProjectionError");
      const committedRecovery = lifecycleHandler.slice(committedRecoveryStart, lifecycleHandler.indexOf("setRoleLifecycleMode", committedRecoveryStart));

      expect(committedRecoveryStart).toBeGreaterThanOrEqual(0);
      expect(committedRecovery).toContain("closeRoleLifecycle(true);");
      expect(committedRecovery).toContain("setNotice(");
      expect(committedRecovery).toContain("清單刷新失敗");
      expect(committedRecovery).toContain("請重新整理");
      expect(committedRecovery).toContain("return;");
      expect(committedRecovery).not.toContain("loadRoleLifecycle(");
      expect(lifecycleHandler).toContain("finally {");
      expect(lifecycleHandler).toContain("setPendingAction(null);");
    }
  });

  it("reuses exact caller keys for Role deletion, Skill revocation, and Credential status", () => {
    const deletion = functionSource("async function deleteRole(", "function applyRoleTemplate(");
    const revocation = functionSource("async function revokeSkill(", "async function setCredentialStatus(");
    const credentialStatus = functionSource("async function setCredentialStatus(", "async function loadPromptVersions(");

    expect(source).toContain("const managementMutationRetryOwnershipRef = useRef(new ManagementMutationRetryOwnership());");
    expect(deletion).toContain('managementMutationRetryOwnershipRef.current.acquire("role.delete"');
    expect(deletion).toContain('"Idempotency-Key": retry.idempotencyKey');
    expect(revocation).toContain('managementMutationRetryOwnershipRef.current.acquire("skill.revoke"');
    expect(revocation).toContain('"Idempotency-Key": retry.idempotencyKey');
    expect(credentialStatus).toContain('managementMutationRetryOwnershipRef.current.acquire("credential.status"');
    expect(credentialStatus).toContain("managementApi.updateCredentialStatus(");
    expect(credentialStatus).toContain("retry.idempotencyKey");

    for (const handler of [deletion, revocation, credentialStatus]) {
      expect(handler).toContain("managementMutationRetryOwnershipRef.current.clear(retry);");
      expect(handler).toContain("cause instanceof CommittedMutationProjectionError");
      expect(handler).toContain("managementMutationRetryDisposition(cause)");
    }
  });

  it("sends Connector revisions and rebases a preserved draft after a conflict", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const toolUpdate = functionSource("async function updateToolRegistration(", "async function healthTaskAdapter(");

    expect(submit).toContain("expectedRevision: editingModel.revision");
    expect(submit).toContain("expectedRevision: editingMcp.revision");
    expect(toolUpdate).toContain("expectedRevision: connector.revision");
    expect(source).toContain("isRevisionConflictError");
    expect(submit).toContain("await refreshRequired()");
    expect(submit).toContain("已由其他分頁更新");
    expect(source).toContain("rebaseConnectorRevision");
    expect(source).toContain("setConnectorConflictTarget");
    expect(source).toContain("目前草稿仍保留");
    expect(source).not.toContain("請關閉後重新開啟再套用");
    expect(toolUpdate).toContain("await refreshRequired()");
    expect(submit).not.toContain("return submit(");
    expect(toolUpdate).not.toContain("return updateToolRegistration(");
  });

  it("sends the current Credential timestamp when changing lifecycle status", () => {
    const statusUpdate = functionSource("async function setCredentialStatus(", "async function loadPromptVersions(");

    expect(statusUpdate).toContain("credential.updatedAt");
    expect(statusUpdate).toContain("updateCredentialStatus");
    expect(statusUpdate).toContain('managementMutationRetryDisposition(cause) === "refresh_then_confirm"');
    expect(statusUpdate).toContain("await refreshRequired();");
    expect(statusUpdate.match(/managementApi\.updateCredentialStatus\(/g)).toHaveLength(1);
    expect(statusUpdate).not.toContain("return setCredentialStatus(");
  });

  it("keeps stale Settings data visible but blocks lifecycle mutations until refresh succeeds", () => {
    expect(source).toContain("platformProjectionStale");
    expect(source).toContain("platformProjectionRefreshing");
    expect(source).toContain("projectionFreshnessLabel");
    expect(source).toContain("ProjectionFreshnessWarning");
    expect(source).toContain("重新整理設定資料");
    expect(source).toContain("const lifecycleMutationBlocked = pendingAction !== null || platformProjectionStale;");
  });

  it("retains independent Credential rotation intents without retaining plaintext", () => {
    const submit = functionSource("async function submit(", "async function health(");
    const credentialMutation = submit.slice(
      submit.indexOf('if (tab === "credentials")'),
      submit.indexOf('if (tab === "prompts")')
    );
    const credentialRows = source.slice(
      source.indexOf('{tab === "credentials" && (snapshot.credentials'),
      source.indexOf('{tab === "models" && snapshot.modelConnectors')
    );

    expect(source).toContain("const credentialRotationRetryRegistryRef = useRef(new IdempotencyRetryRegistry());");
    expect(credentialMutation).toContain("const requestPayload = {");
    expect(credentialMutation).toContain("credentialId: credential.id,");
    expect(credentialMutation).toContain("expectedSecretRevision: credential.secretRevision,");
    expect(credentialMutation).toContain("secret: credentialInput.secret");
    expect(credentialMutation).toContain('await managementMutationRetrySignatureRef.current.forPayload("credential.rotate", requestPayload)');
    expect(credentialMutation).toContain("credentialRotationRetryRegistryRef.current.acquire(signature, () => crypto.randomUUID())");
    expect(credentialMutation).toContain("retryOwnership = { registry: credentialRotationRetryRegistryRef.current, token: retryToken };");
    expect(credentialMutation).toContain("managementApi.rotateCredential(requestPayload.credentialId, requestPayload.secret, requestPayload.expectedSecretRevision, retryToken.idempotencyKey)");
    expect(credentialRows).not.toContain("credentialRotationRetryRegistryRef");
    expect(source).not.toContain("credentialRotationRetryRef");
  });

  it("binds Skill validation to the current evidence token and refreshes stale forms", () => {
    const validation = functionSource("async function recordValidation(", "async function revokeSkill(");

    expect(validation).toContain("expectedCheckedAt: validationSkill.validation.checkedAt");
    expect(validation).toContain("isRevisionConflictError(cause)");
    expect(validation).toContain("await refreshRequired();");
    expect(validation).toContain("目前表單內容仍保留");
  });

  it("rejects stale MCP discovery results before opening an editor", () => {
    const discover = functionSource("async function discover(", "async function updateToolRegistration(");

    expect(source).toContain("const mcpDiscoveryRequest = useRef(new LatestRequestGate());");
    expect(discover).toContain("const requestToken = mcpDiscoveryRequest.current.begin();");
    expect(discover).toContain("if (!mcpDiscoveryRequest.current.isCurrent(requestToken)) return;");
    expect(discover.indexOf("isCurrent(requestToken)")).toBeLessThan(discover.indexOf("setEditingMcp("));
    expect(source).toContain("type McpDiscoveryResponse");
    expect(discover).toContain("mutate<McpDiscoveryResponse>");
    expect(discover).toContain("setEditingMcp(result.connector);");
    expect(discover).not.toContain("snapshot?.mcpConnectors.find");
  });

  it("cancels resource-specific requests when the selected settings resource changes", () => {
    const selectTab = functionSource("function selectTab(", "function handleTabKeyDown(");

    expect(selectTab).toContain("connectorHealthRequest.current.cancel();");
    expect(selectTab).toContain("mcpDiscoveryRequest.current.cancel();");
    expect(selectTab).toContain("promptEditorRequest.current.cancel();");
    expect(selectTab).toContain("promptPreviewRequest.current.cancel();");
    expect(selectTab).toContain("setPromptPreview(null);");
  });

  it("prevents resource switching while a Settings mutation is pending", () => {
    const selectTab = functionSource("function selectTab(", "function handleTabKeyDown(");

    expect(selectTab).toContain("if (pendingAction !== null) return;");
    expect(selectTab.indexOf("if (pendingAction !== null) return;")).toBeLessThan(
      selectTab.indexOf("connectorHealthRequest.current.cancel();")
    );
    expect(source).toContain('<select value={tab} disabled={pendingAction !== null} onChange={(event) => selectTab(event.target.value as Tab)}>');
    expect(source).toContain('type="button" disabled={pendingAction !== null} aria-current={tab === item.id ? "page" : undefined}');
  });

  it("does not attribute stale connector health results to another settings resource", () => {
    const modelHealth = functionSource("async function health(", "async function discover(");
    const adapterHealth = functionSource("async function healthTaskAdapter(", "async function approveSkill(");

    expect(source).toContain("const connectorHealthRequest = useRef(new LatestRequestGate());");
    for (const request of [modelHealth, adapterHealth]) {
      expect(request).toContain("const requestToken = connectorHealthRequest.current.begin();");
      expect(request).toContain("if (!connectorHealthRequest.current.isCurrent(requestToken)) return;");
    }
  });

  it("does not open a blank Prompt editor when version loading fails", () => {
    const editor = functionSource("async function openPromptEditor(", "async function loadRoleLifecycle(");

    expect(editor).not.toContain(".catch(() => []");
    expect(editor).toContain("catch (cause)");
    expect(editor).toContain("無法載入 Prompt 版本");
    expect(editor.indexOf("isCurrent(requestToken)")).toBeLessThan(editor.indexOf("setCreateOpen(true)"));
  });

  it("always loads fresh Prompt versions and requires the exact current version for editing", () => {
    const editor = functionSource("async function openPromptEditor(", "async function loadRoleLifecycle(");

    expect(editor).toContain("const versions = await managementApi.getPromptVersions(prompt.id);");
    expect(editor).not.toContain("promptVersions[prompt.id]");
    expect(editor).toContain("promptVersionForEdit(versions, prompt.currentVersion)");
    expect(editor).not.toContain("?? versions[0]");
    expect(editor.indexOf("promptVersionForEdit(")).toBeLessThan(editor.indexOf("setPromptDraft("));
  });

  it("offers Prompt rollback only for versions older than the current version", () => {
    const promptRows = source.slice(
      source.indexOf('{tab === "prompts" && (snapshot.prompts ?? []).map'),
      source.indexOf('{tab === "prompts" && (snapshot.prompts ?? []).length === 0')
    );

    expect(promptRows).toContain("actions.canRollback && version.version < prompt.currentVersion");
  });

  it("rejects stale Prompt preview responses", () => {
    const preview = functionSource("async function openPromptPreview(", "function selectPromptPreviewVersion(");

    expect(source).toContain("const promptPreviewRequest = useRef(new LatestRequestGate());");
    expect(preview).toContain("const requestToken = promptPreviewRequest.current.begin();");
    expect(preview).toContain("if (!promptPreviewRequest.current.isCurrent(requestToken)) return;");
    expect(preview.indexOf("isCurrent(requestToken)")).toBeLessThan(preview.indexOf("setPromptPreview({"));
  });

  it("locks resource and Prompt preview forms while their submitted snapshot is pending", () => {
    const resourceForm = source.slice(
      source.indexOf('<Modal title={editingRole ?'),
      source.indexOf('<Modal title={promptPreview ?')
    );
    const previewForm = source.slice(
      source.indexOf('<Modal title={promptPreview ?'),
      source.indexOf('<Modal title={lifecycleModalTitle}')
    );

    expect(resourceForm).toContain("closeDisabled={formPending}");
    expect(resourceForm).toContain("busy={formPending}");
    expect(resourceForm).toContain("aria-busy={formPending}");
    expect(resourceForm).toContain("inert={formPending ? true : undefined}");
    expect(previewForm).toContain("aria-busy={promptPreviewPending}");
    expect(previewForm).toContain("inert={promptPreviewPending ? true : undefined}");
  });

  it("guards Settings drafts and locks Tool Registration after submit", () => {
    const resourceForm = source.slice(
      source.indexOf('<Modal title={editingRole ?'),
      source.indexOf('<Modal title={promptPreview ?')
    );
    const toolForm = source.slice(
      source.indexOf('<Modal title={`編輯${editingTool?'),
      source.indexOf('<Modal title={`記錄${validationSkill?')
    );

    expect(source).toContain("function closeCreateModal(force = false)");
    expect(source).toContain("if (!force && resourceDraftDirty && !window.confirm(");
    expect(resourceForm).toContain("onClose={() => { if (!pendingAction) closeCreateModal(); }}");
    expect(resourceForm).toContain("onClick={() => closeCreateModal()}");
    expect(source).toContain("function requestCloseToolRegistration()");
    expect(source).toContain("if (toolRegistrationDirty && !window.confirm(");
    expect(toolForm).toContain("onClose={requestCloseToolRegistration}");
    expect(toolForm).toContain("closeDisabled={toolRegistrationPending}");
    expect(toolForm).toContain("busy={toolRegistrationPending}");
    expect(toolForm).toContain("aria-busy={toolRegistrationPending}");
    expect(toolForm).toContain("inert={toolRegistrationPending ? true : undefined}");
    expect(toolForm).toContain("onClick={requestCloseToolRegistration}");
  });

  it("guards Skill validation and revocation drafts through every modal close path", () => {
    const validationClose = functionSource("function requestCloseSkillValidation()", "function requestCloseSkillRevocation()");
    const revocationClose = functionSource("function requestCloseSkillRevocation()", "function setRoleField<");
    const validationModal = source.slice(
      source.indexOf('<Modal title={`記錄${validationSkill?'),
      source.indexOf('<Modal title={`撤銷${skillToRevoke?')
    );
    const revocationModal = source.slice(source.indexOf('<Modal title={`撤銷${skillToRevoke?'));
    const closeCases = [
      { close: validationClose, modal: validationModal, closeHandler: "requestCloseSkillValidation", dirtySetter: "setSkillValidationDraftDirty" },
      { close: revocationClose, modal: revocationModal, closeHandler: "requestCloseSkillRevocation", dirtySetter: "setSkillRevocationDraftDirty" }
    ];

    for (const { close, modal, closeHandler, dirtySetter } of closeCases) {
      expect(close).toContain("if (pendingAction !== null) return false;");
      expect(close).toContain("window.confirm(");
      expect(close).toContain(`${dirtySetter}(false);`);
      expect(modal).toContain(`onClose={${closeHandler}}`);
      expect(modal).toContain("closeDisabled={pendingAction !== null}");
      expect(modal).toContain("busy={pendingAction !== null}");
      expect(modal).toContain(`onChangeCapture={() => ${dirtySetter}(true)}`);
      expect(modal).toContain(`onClick={${closeHandler}}`);
    }

    const validationSubmit = functionSource("async function recordValidation(", "async function revokeSkill(");
    const revocationSubmit = functionSource("async function revokeSkill(", "async function setCredentialStatus(");
    expect(validationSubmit).toContain("setSkillValidationDraftDirty(false);");
    expect(revocationSubmit).toContain("setSkillRevocationDraftDirty(false);");
  });

  it("ignores stale Prompt lifecycle responses after settings tab changes", () => {
    const promptLifecycle = functionSource("async function promptLifecycle(", "  const canCreate = tab !== \"harness\"");
    const select = functionSource("function selectTab(", "function handleTabKeyDown(");

    expect(promptLifecycle).toContain("const requestToken = promptLifecycleRequest.current.begin();");
    expect(promptLifecycle.indexOf("await refresh();")).toBeLessThan(
      promptLifecycle.indexOf("if (!promptLifecycleRequest.current.isCurrent(requestToken)) return;")
    );
    expect(promptLifecycle).toContain("setNotice(action === \"publish\" ?");
    expect(promptLifecycle).toContain("isRevisionConflictError(cause)");
    expect(promptLifecycle).toContain("await refreshRequired();");
    expect(promptLifecycle).toContain("請重新執行操作");
    expect(select).toContain("promptLifecycleRequest.current.cancel();");
    expect(select).toContain("setNotice(\"\");");
  });
});
