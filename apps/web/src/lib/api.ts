import type {
  Agent,
  AgentLifecycleStatus,
  AgentReadinessBatchResponse,
  AgentRevision,
  AgentTeam,
  ApproveToolPackInput,
  CreateToolPackInput,
  CreateRuntimeProfileInput,
  Credential,
  EffectiveAgentConfigurationResponse,
  MeetingPreset,
  MeetingPresetPreflightResponse,
  PromptTemplate,
  PromptVersion,
  RuntimeProfile,
  RuntimeProfileRevision,
  RevokeToolPackInput,
  ToolPack,
  ToolPackRevision,
  UpdateToolPackInput,
  ValidateToolPackInput
} from "@council/contracts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "REQUEST_FAILED"
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isRevisionConflictError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 409 && cause.code === "REVISION_CONFLICT";
}

export function isConflictError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 409;
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      response.status,
      payload?.error?.message ?? `Request failed (${response.status}).`,
      payload?.error?.code ?? "REQUEST_FAILED"
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type CredentialInput = Pick<Credential, "name" | "provider" | "kind" | "location"> & {
  secret?: string;
  expiresAt?: string | null;
};

export type PromptInput = Pick<PromptTemplate, "name" | "kind" | "description" | "owner"> & {
  content: string;
  variables: string[];
};

export type EffectiveAgentConfiguration = EffectiveAgentConfigurationResponse;
export type MeetingPresetPreflight = MeetingPresetPreflightResponse;

function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}

export const managementApi = {
  getToolPacks() {
    return apiRequest<{ toolPacks: ToolPack[] }>("/api/tool-packs");
  },
  createToolPack(input: CreateToolPackInput, idempotencyKey: string) {
    return apiRequest<ToolPack>("/api/tool-packs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    });
  },
  updateToolPack(id: string, input: UpdateToolPackInput) {
    return apiRequest<ToolPack>(`/api/tool-packs/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  getToolPackRevisions(id: string) {
    return apiRequest<ToolPackRevision[]>(`/api/tool-packs/${id}/revisions`);
  },
  validateToolPack(id: string, input: ValidateToolPackInput) {
    return apiRequest<ToolPack>(`/api/tool-packs/${id}/validate`, jsonBody(input));
  },
  approveToolPack(id: string, input: ApproveToolPackInput) {
    return apiRequest<ToolPack>(`/api/tool-packs/${id}/approve`, jsonBody(input));
  },
  revokeToolPack(id: string, input: RevokeToolPackInput) {
    return apiRequest<ToolPack>(`/api/tool-packs/${id}/revoke`, jsonBody(input));
  },
  getRuntimeProfiles() {
    return apiRequest<{ runtimeProfiles: RuntimeProfile[] }>("/api/runtime-profiles");
  },
  createRuntimeProfile(input: CreateRuntimeProfileInput, idempotencyKey: string) {
    return apiRequest<RuntimeProfile>("/api/runtime-profiles", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    });
  },
  updateRuntimeProfile(id: string, input: { expectedRevision: number } & Partial<CreateRuntimeProfileInput>) {
    return apiRequest<RuntimeProfile>(`/api/runtime-profiles/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  getRuntimeProfileRevisions(id: string) {
    return apiRequest<RuntimeProfileRevision[]>(`/api/runtime-profiles/${id}/revisions`);
  },
  createCredential(input: CredentialInput, idempotencyKey: string) {
    return apiRequest<Credential>("/api/credentials", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    });
  },
  updateCredential(
    id: string,
    expectedUpdatedAt: string,
    input: Partial<Pick<Credential, "name" | "provider" | "kind" | "location" | "expiresAt">>
  ) {
    return apiRequest<Credential>(`/api/credentials/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedUpdatedAt, ...input })
    });
  },
  rotateCredential(id: string, secret: string, expectedSecretRevision: number, idempotencyKey: string) {
    return apiRequest<Credential>(`/api/credentials/${id}/rotate`, {
      ...jsonBody({ credentialId: id, secret, expectedSecretRevision }),
      headers: { "Idempotency-Key": idempotencyKey }
    });
  },
  updateCredentialStatus(
    id: string,
    status: Credential["status"],
    expectedUpdatedAt: string,
    idempotencyKey: string
  ) {
    return apiRequest<Credential>(`/api/credentials/${id}/status`, {
      method: "PATCH",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ status, expectedUpdatedAt })
    });
  },
  createPrompt(input: PromptInput, idempotencyKey: string) {
    return apiRequest<PromptTemplate>("/api/prompts", {
      ...jsonBody(input),
      headers: { "Idempotency-Key": idempotencyKey }
    });
  },
  updatePrompt(id: string, expectedCurrentVersion: number, input: Partial<PromptInput>) {
    return apiRequest<PromptTemplate>(`/api/prompts/${id}`, { method: "PATCH", body: JSON.stringify({ expectedCurrentVersion, ...input }) });
  },
  getPromptVersions(id: string) {
    return apiRequest<PromptVersion[]>(`/api/prompts/${id}/versions`);
  },
  publishPrompt(id: string, expectedCurrentVersion: number, version: number) {
    return apiRequest<PromptTemplate>(`/api/prompts/${id}/publish`, jsonBody({ expectedCurrentVersion, version }));
  },
  rollbackPrompt(id: string, expectedCurrentVersion: number, version: number) {
    return apiRequest<PromptTemplate>(`/api/prompts/${id}/rollback`, jsonBody({ expectedCurrentVersion, version }));
  },
  archivePrompt(id: string, expectedCurrentVersion: number) {
    return apiRequest<PromptTemplate>(`/api/prompts/${id}/archive`, jsonBody({ expectedCurrentVersion }));
  },
  previewPrompt(id: string, version: number, variables: Record<string, string>) {
    return apiRequest<{ content: string; version: number }>(`/api/prompts/${id}/preview`, jsonBody({ version, variables }));
  },
  getAgentReadinessBatch(agentIds: readonly string[]) {
    return apiRequest<AgentReadinessBatchResponse>("/api/agents/readiness:batch", jsonBody({ agentIds }));
  },
  getAgentRevisions(id: string) {
    return apiRequest<AgentRevision[]>(`/api/agents/${id}/revisions`);
  },
  publishAgent(id: string, expectedDraftRevision: number) {
    return apiRequest<Agent>(`/api/agents/${id}/publish`, jsonBody({ expectedDraftRevision }));
  },
  rollbackAgent(id: string, expectedPublishedRevision: number, expectedDraftRevision: number, revision: number) {
    return apiRequest<Agent>(`/api/agents/${id}/rollback`, jsonBody({ expectedPublishedRevision, expectedDraftRevision, revision }));
  },
  updateAgentStatus(id: string, status: AgentLifecycleStatus, expectedRevision: number) {
    return apiRequest<Agent>(`/api/agents/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, expectedRevision }) });
  },
  getEffectiveAgentConfiguration(id: string) {
    return apiRequest<EffectiveAgentConfiguration>(`/api/agents/${id}/effective-configuration`);
  },
  createAgentTeam(input: Pick<AgentTeam, "name" | "description" | "members">, idempotencyKey: string) {
    return apiRequest<AgentTeam>("/api/agent-teams", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    });
  },
  updateAgentTeam(id: string, input: { expectedRevision: number } & Partial<Pick<AgentTeam, "name" | "description" | "members" | "status">>) {
    return apiRequest<AgentTeam>(`/api/agent-teams/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  createMeetingPreset(input: Omit<MeetingPreset, "id" | "revision" | "status" | "createdAt" | "updatedAt">, idempotencyKey: string) {
    return apiRequest<MeetingPreset>("/api/meeting-presets", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    });
  },
  updateMeetingPreset(id: string, input: { expectedRevision: number } & Partial<Omit<MeetingPreset, "id" | "revision" | "createdAt" | "updatedAt">>) {
    return apiRequest<MeetingPreset>(`/api/meeting-presets/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  },
  getMeetingPresetPreflight(id: string) {
    return apiRequest<MeetingPresetPreflight>(`/api/meeting-presets/${id}/preflight`);
  }
};
