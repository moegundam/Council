import { mcpToolArgumentsSchema } from "@council/contracts";
import type {
  McpConnector,
  ParticipantAssignment,
  ParticipantRoleBinding,
  PlatformSnapshot,
  SpeakerQueueItem,
  Utterance,
  ToolRegistrationSnapshot
} from "@council/contracts";
import { mcpConnectorExecutionFingerprint, mcpToolRequestFingerprint, type PlatformStore } from "@council/database";
import { authorizeRoleMcpAccess, type SecretVault } from "@council/domain";
import {
  evaluateGovernanceGate,
  governanceAuditDetail,
  GovernanceDeniedError,
  GovernanceUnavailableError,
  McpReadOnlyClient,
  type GovernanceControl,
  type GovernanceJsonValue
} from "@council/runtime";

export type McpToolCallStore = Pick<PlatformStore,
  | "commitMcpToolRun"
  | "getAgentRevision"
  | "getConnectorSecret"
  | "getSnapshot"
  | "recordAudit"
>;
type McpToolFailureStore = Pick<PlatformStore, "commitMcpToolRun" | "getSnapshot">;

export interface ProcessMcpToolCallInput extends ParticipantRoleBinding {
  store: McpToolCallStore;
  jobId: string;
  meetingId: string;
  agentId: string;
  requestFingerprint?: string;
  connectorId: string;
  toolName: string;
  toolSnapshot?: ToolRegistrationSnapshot;
  connectorFingerprint?: string;
  arguments: Record<string, unknown>;
  reservationRequired?: boolean;
  mcpLocalHostAllowlist?: readonly string[];
  secretVault?: SecretVault;
  governance?: GovernanceControl;
  onGovernanceObservationError?: (error: unknown) => void;
  call?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}

const redacted = "[REDACTED]";
const redactedInput = "[REDACTED_INPUT]";
const maxScalarLength = 20_000;
const sensitiveKeyParts = [
  "secret", "token", "password", "apikey", "authorization", "cookie", "credential", "privatekey", "session", "bearer"
] as const;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sensitiveKeyParts.some((part) => normalized.includes(part));
}

function collectArgumentValues(value: unknown, output = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || output.size >= 256 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    if (value.length >= 4) output.add(value.slice(0, maxScalarLength));
    return output;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const scalar = String(value);
    if (scalar.length >= 4) output.add(scalar);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectArgumentValues(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value).slice(0, 100)) collectArgumentValues(nested, output, depth + 1);
  }
  return output;
}

function redactString(value: string, argumentValues: ReadonlySet<string>): string {
  const truncated = value.length > maxScalarLength;
  let sanitized = value.slice(0, maxScalarLength)
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi, redacted)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, redacted)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, redacted)
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, redacted)
    .replace(/\bgh[opusr]_[A-Za-z0-9]{8,}\b/g, redacted)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, redacted)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${redacted}@`)
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)\b(\s*[:=]\s*)[^\s,;\]}]+/gi, `$1$2${redacted}`);
  for (const argumentValue of [...argumentValues].sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(argumentValue).join(redactedInput);
  }
  return truncated ? `${sanitized}\n[TRUNCATED_TEXT]` : sanitized;
}

function sanitizeToolResult(
  value: unknown,
  argumentValues: ReadonlySet<string>,
  depth = 0,
  seen = new WeakSet<object>()
): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return redactString(value, argumentValues);
  if (typeof value === "number" || typeof value === "bigint") {
    return argumentValues.has(String(value)) ? redactedInput : typeof value === "bigint" ? String(value) : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => sanitizeToolResult(item, argumentValues, depth + 1, seen));
    if (value.length > 100) items.push("[TRUNCATED_ITEMS]");
    return items;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, argumentValues) };
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [index, [key, nested]] of entries.slice(0, 100).entries()) {
    const redactedKey = redactString(key, argumentValues).slice(0, 200) || "[EMPTY_KEY]";
    const outputKey = Object.hasOwn(output, redactedKey) ? `${redactedKey}_${index}` : redactedKey;
    output[outputKey] = isSensitiveKey(key) ? redacted : sanitizeToolResult(nested, argumentValues, depth + 1, seen);
  }
  if (entries.length > 100) output.__truncated__ = `[${entries.length - 100} more fields]`;
  return output;
}

function displayResult(value: unknown, argumentsValue: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(sanitizeToolResult(value, collectArgumentValues(argumentsValue)), null, 2);
    return (serialized ?? "[Tool returned no serializable result.]").slice(0, 18_000);
  } catch {
    return "[Tool returned a non-serializable result.]";
  }
}

function toolSnapshot(
  connector: Pick<McpConnector, "name" | "toolRegistrations"> | undefined,
  toolName: string,
  provided?: ToolRegistrationSnapshot
): ToolRegistrationSnapshot {
  if (provided?.toolName === toolName) return structuredClone(provided);
  const registration = connector?.toolRegistrations.find((item) => item.toolName === toolName);
  return {
    connectorName: connector?.name ?? "Unknown connector",
    toolName,
    displayName: registration?.displayName ?? toolName,
    kind: registration?.kind ?? "mcp_tool",
    version: registration?.version ?? "unversioned",
    owner: registration?.owner ?? "Platform Owner",
    goal: registration?.goal ?? `以唯讀方式執行 ${toolName}。`
  };
}

export class StaleMcpToolRunError extends Error {}
export class McpToolOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpToolOutcomeUnknownError";
  }
}

interface McpToolRequestFingerprints {
  current: string;
  accepted: ReadonlySet<string>;
}

function mcpToolRequestFingerprints(
  input: ProcessMcpToolCallInput,
  argumentsValue: Record<string, unknown>
): McpToolRequestFingerprints {
  const fingerprintInput = { ...input, arguments: argumentsValue };
  const legacy = mcpToolRequestFingerprint(fingerprintInput);
  const current = input.secretVault
    ? mcpToolRequestFingerprint(fingerprintInput, input.secretVault)
    : legacy;
  return { current, accepted: new Set([current, legacy]) };
}

function persistedMcpToolCallUtterance(
  snapshot: Pick<PlatformSnapshot, "toolRuns" | "utterances">,
  input: ProcessMcpToolCallInput,
  acceptedFingerprints: ReadonlySet<string>
): Utterance | null {
  const existingRun = snapshot.toolRuns.find((item) => item.jobId === input.jobId);
  if (!existingRun) return null;
  if (existingRun.meetingId !== input.meetingId
    || !acceptedFingerprints.has(existingRun.requestFingerprint)
    || existingRun.agentId !== input.agentId
    || existingRun.connectorId !== input.connectorId
    || existingRun.toolName !== input.toolName
    || existingRun.status !== "succeeded") {
    throw new Error("MCP Tool Run job ID was already used by a different meeting action.");
  }
  const existingUtterance = snapshot.utterances.find((item) => item.id === existingRun.utteranceId);
  if (!existingUtterance) throw new Error("Persisted MCP Tool Run evidence is missing.");
  return existingUtterance;
}

export async function findPersistedMcpToolCall(
  input: ProcessMcpToolCallInput
): Promise<Utterance | null> {
  const argumentsValue = mcpToolArgumentsSchema.parse(input.arguments);
  const fingerprints = mcpToolRequestFingerprints(input, argumentsValue);
  return persistedMcpToolCallUtterance(await input.store.getSnapshot(), input, fingerprints.accepted);
}

function participantMatchesRoleBinding(
  participant: ParticipantAssignment | undefined,
  input: ParticipantRoleBinding
): participant is ParticipantAssignment {
  return Boolean(participant
    && participant.id === input.participantId
    && participant.roleRevision === input.roleRevision
    && participant.roleId === input.roleId
    && participant.roleSnapshot.roleId === input.roleId
    && participant.roleSnapshot.version === input.roleVersion);
}

async function evaluateMcpGovernance(
  input: ProcessMcpToolCallInput,
  requestFingerprint: string,
  argumentsValue: Record<string, unknown>,
  context: {
    meetingId: string;
    meetingState: string;
    agentId: string;
    agentRevision: number;
    connectorId: string;
    connectorLocation: string;
    participantId: string;
    roleId: string;
    roleVersion: number;
    roleRevision: number;
    roleToolPolicy: string;
    roleDataPolicy: string;
    toolName: string;
    toolVersion: string;
  }
): Promise<void> {
  if (!input.governance) return;
  const governanceArguments = structuredClone(argumentsValue) as Record<string, GovernanceJsonValue>;
  const result = await evaluateGovernanceGate(input.governance, {
    point: "pre_tool_call",
    actionIdentity: requestFingerprint,
    snapshot: {
      tool_call: {
        name: "council_mcp_readonly",
        args: governanceArguments
      },
      council: {
        action_type: "mcp_tool_call",
        native_authorized: true,
        access: "read_only",
        meeting_id: context.meetingId,
        meeting_state: context.meetingState,
        agent_id: context.agentId,
        agent_revision: context.agentRevision,
        participant_id: context.participantId,
        role_id: context.roleId,
        role_version: context.roleVersion,
        role_revision: context.roleRevision,
        role_tool_policy: context.roleToolPolicy,
        role_data_policy: context.roleDataPolicy,
        connector_id: context.connectorId,
        connector_location: context.connectorLocation,
        connector_enabled: true,
        catalog_registered: true,
        agent_granted: true,
        tool_name: context.toolName,
        tool_version: context.toolVersion
      }
    }
  });
  if (!result) return;
  try {
    await input.store.recordAudit("governance.mcp.pre_tool_call.evaluated", "meeting", context.meetingId, {
      jobId: input.jobId,
      agentId: context.agentId,
      connectorId: context.connectorId,
      toolName: context.toolName,
      ...governanceAuditDetail(result)
    });
  } catch (error) {
    input.onGovernanceObservationError?.(error);
    if (result.mode === "enforce") {
      throw new GovernanceUnavailableError(
        "Governance decision evidence could not be persisted before MCP execution.",
        { cause: error }
      );
    }
  }
  if (result.effect !== "block") return;
  if (result.decision === "provider_error") {
    throw new GovernanceUnavailableError("Governance provider was unavailable before MCP execution.");
  }
  throw new GovernanceDeniedError(result);
}

export async function processMcpToolCall(input: ProcessMcpToolCallInput) {
  const argumentsValue = mcpToolArgumentsSchema.parse(input.arguments);
  const fingerprints = mcpToolRequestFingerprints(input, argumentsValue);
  if (input.requestFingerprint && !fingerprints.accepted.has(input.requestFingerprint)) {
    throw new StaleMcpToolRunError("MCP queue fingerprint does not match its decrypted arguments.");
  }
  const snapshot = await input.store.getSnapshot();
  const existingUtterance = persistedMcpToolCallUtterance(snapshot, input, fingerprints.accepted);
  if (existingUtterance) return existingUtterance;
  const reservedAction = snapshot.speakerQueue.find((item) => item.jobId === input.jobId);
  const reservationFingerprint = reservedAction?.requestFingerprint;
  const durableExecutionBinding = reservedAction?.mcpExecutionBinding;
  if (input.reservationRequired && (!reservedAction
    || reservedAction.kind !== "mcp_tool_call"
    || reservedAction.meetingId !== input.meetingId
    || reservedAction.agentId !== input.agentId
    || reservedAction.participantId !== input.participantId
    || reservedAction.roleRevision !== input.roleRevision
    || reservedAction.roleId !== input.roleId
    || reservedAction.roleVersion !== input.roleVersion
    || reservedAction.toolName !== input.toolName
    || !reservationFingerprint
    || !fingerprints.accepted.has(reservationFingerprint)
    || (input.requestFingerprint !== undefined && input.requestFingerprint !== reservationFingerprint)
    || !durableExecutionBinding
    || durableExecutionBinding.connectorId !== input.connectorId
    || durableExecutionBinding.connectorFingerprint !== input.connectorFingerprint
    || JSON.stringify(durableExecutionBinding.toolSnapshot) !== JSON.stringify(input.toolSnapshot))) {
    throw new StaleMcpToolRunError("MCP request no longer matches its durable reservation.");
  }
  const requestFingerprint = input.reservationRequired
    ? reservationFingerprint!
    : fingerprints.current;
  const meeting = snapshot.meetings.find((item) => item.id === input.meetingId);
  const agent = snapshot.agents.find((item) => item.id === input.agentId);
  const assignment = snapshot.participants.find((item) => item.id === input.participantId);
  const role = assignment?.roleSnapshot;
  const connector = snapshot.mcpConnectors.find((item) => item.id === input.connectorId && item.enabled);
  if (!meeting || meeting.state !== "active") throw new Error("Meeting is not active.");
  if (!agent
    || !participantMatchesRoleBinding(assignment, input)
    || assignment.meetingId !== meeting.id
    || assignment.agentId !== agent.id
    || agent.lifecycleStatus === "disabled"
    || assignment.agentRevision === undefined
    || !role) {
    throw new StaleMcpToolRunError("MCP Tool Run Role binding is stale.");
  }
  let agentRevision: Awaited<ReturnType<McpToolCallStore["getAgentRevision"]>>;
  try {
    agentRevision = await input.store.getAgentRevision(agent.id, assignment.agentRevision);
  } catch {
    throw new StaleMcpToolRunError("MCP Tool Run Agent revision is unavailable.");
  }
  if (!agentRevision.publishedAt) throw new StaleMcpToolRunError("MCP Tool Run Agent revision is not published.");
  const roleAuthorization = authorizeRoleMcpAccess(role);
  if (!roleAuthorization.allowed) throw new Error(`Role policy denied MCP: ${roleAuthorization.reason ?? "not permitted"}`);
  if (!connector) throw new Error("MCP connector is unavailable.");
  const registration = connector.toolRegistrations.find((item) => item.toolName === input.toolName);
  if (!connector.approvedTools.includes(input.toolName)
    || !registration
    || (input.toolSnapshot && JSON.stringify({ connectorName: connector.name, ...registration }) !== JSON.stringify(input.toolSnapshot))
    || !agentRevision.toolGrants.some((grant) => grant.connectorId === connector.id && grant.toolName === input.toolName)) {
    throw new Error("MCP tool is not in the Tool Catalog, Agent grant, and connector allowlist.");
  }

  const ciphertext = await input.store.getConnectorSecret(connector.id);
  if (input.reservationRequired && (!input.toolSnapshot || !input.connectorFingerprint)) {
    throw new StaleMcpToolRunError("MCP queued execution binding is missing.");
  }
  const queuedToolSnapshot = input.toolSnapshot ?? { connectorName: connector.name, ...registration };
  const queuedConnectorFingerprint = input.connectorFingerprint ?? mcpConnectorExecutionFingerprint(connector, ciphertext);
  if (mcpConnectorExecutionFingerprint(connector, ciphertext) !== queuedConnectorFingerprint) {
    throw new StaleMcpToolRunError("MCP connector binding changed after this job was queued.");
  }
  if (connector.hasSecret && (!ciphertext || !input.secretVault)) {
    throw new Error("MCP connector secret cannot be loaded.");
  }
  const bearerToken = ciphertext && input.secretVault ? input.secretVault.decrypt(ciphertext) : undefined;
  await evaluateMcpGovernance(input, requestFingerprint, argumentsValue, {
    meetingId: meeting.id,
    meetingState: meeting.state,
    agentId: agent.id,
    agentRevision: agentRevision.revision,
    connectorId: connector.id,
    connectorLocation: connector.location,
    participantId: input.participantId,
    roleId: input.roleId,
    roleVersion: input.roleVersion,
    roleRevision: input.roleRevision,
    roleToolPolicy: role.toolPolicy,
    roleDataPolicy: role.dataPolicy,
    toolName: input.toolName,
    toolVersion: registration.version
  });
  const executionSnapshot = await input.store.getSnapshot();
  const executionMeeting = executionSnapshot.meetings.find((item) => item.id === meeting.id);
  const executionAgent = executionSnapshot.agents.find((item) => item.id === agent.id);
  const executionAssignment = executionSnapshot.participants.find((item) => item.id === input.participantId);
  const executionConnector = executionSnapshot.mcpConnectors.find((item) => item.id === connector.id && item.enabled);
  const executionRegistration = executionConnector?.toolRegistrations.find((item) => item.toolName === input.toolName);
  const executionCiphertext = executionConnector ? await input.store.getConnectorSecret(executionConnector.id) : null;
  if (!executionMeeting
    || executionMeeting.state !== "active"
    || !executionAgent
    || executionAgent.lifecycleStatus === "disabled"
    || !participantMatchesRoleBinding(executionAssignment, input)
    || executionAssignment.meetingId !== meeting.id
    || executionAssignment.agentId !== agent.id
    || executionAssignment.agentRevision !== agentRevision.revision
    || !authorizeRoleMcpAccess(executionAssignment.roleSnapshot).allowed
    || !executionConnector
    || executionConnector.baseUrl !== connector.baseUrl
    || !executionConnector.approvedTools.includes(input.toolName)
    || !executionRegistration
    || JSON.stringify({ connectorName: executionConnector.name, ...executionRegistration }) !== JSON.stringify(queuedToolSnapshot)
    || mcpConnectorExecutionFingerprint(executionConnector, executionCiphertext) !== queuedConnectorFingerprint
    || !agentRevision.toolGrants.some((grant) => grant.connectorId === connector.id && grant.toolName === input.toolName)) {
    throw new StaleMcpToolRunError("MCP Tool Run authorization became stale before outbound execution.");
  }
  const call = input.call ?? ((toolName: string, args: Record<string, unknown>) => new McpReadOnlyClient({
    connectorId: connector.id,
    baseUrl: connector.baseUrl,
    approvedTools: connector.approvedTools,
    trustedReadOnlyTools: [executionRegistration.toolName],
    ...(bearerToken ? { bearerToken } : {}),
    allowPrivate: connector.location === "local",
    ...(connector.location === "local"
      ? { allowedHosts: input.mcpLocalHostAllowlist ?? [] }
      : {})
  }).call(toolName, args));
  let result: unknown;
  try {
    result = await call(input.toolName, argumentsValue);
  } catch (error) {
    throw new McpToolOutcomeUnknownError("MCP outbound execution did not return a confirmed result; automatic replay is forbidden.", { cause: error });
  }
  let committed: Awaited<ReturnType<McpToolCallStore["commitMcpToolRun"]>>;
  try {
    committed = await input.store.commitMcpToolRun({
      jobId: input.jobId,
      requestFingerprint,
      meetingId: meeting.id,
      agentId: agent.id,
      participantId: input.participantId,
      roleRevision: input.roleRevision,
      roleId: input.roleId,
      roleVersion: input.roleVersion,
      connectorId: connector.id,
      toolName: input.toolName,
      toolSnapshot: queuedToolSnapshot,
      status: "succeeded",
      content: displayResult(result, argumentsValue),
      connectorFingerprint: queuedConnectorFingerprint,
      ...(input.reservationRequired === undefined ? {} : { reservationRequired: input.reservationRequired })
    });
  } catch (error) {
    try {
      const persisted = persistedMcpToolCallUtterance(await input.store.getSnapshot(), input, fingerprints.accepted);
      if (persisted) return persisted;
    } catch {
      // The outcome remains unknown until durable reconciliation can read the Store.
    }
    throw new McpToolOutcomeUnknownError("MCP returned a result but durable evidence could not be confirmed; automatic replay is forbidden.", { cause: error });
  }
  if (committed.status === "stale") {
    throw new McpToolOutcomeUnknownError("MCP returned a result after its durable reservation became stale; automatic replay is forbidden.");
  }
  return committed.utterance;
}

export interface RecordMcpToolFailureInput extends ParticipantRoleBinding {
  store: McpToolCallStore;
  jobId: string;
  meetingId: string;
  agentId: string;
  connectorId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  toolSnapshot?: ToolRegistrationSnapshot;
  connectorFingerprint?: string;
  reservationRequired?: boolean;
  secretVault?: SecretVault;
  message: string;
}

export async function recordMcpToolFailure(input: RecordMcpToolFailureInput): Promise<boolean> {
  const snapshot = await input.store.getSnapshot();
  const meeting = snapshot.meetings.find((item) => item.id === input.meetingId);
  if (!meeting) return false;
  const argumentsValue = input.arguments === undefined
    ? undefined
    : mcpToolArgumentsSchema.parse(input.arguments);
  const fingerprints = argumentsValue === undefined
    ? undefined
    : mcpToolRequestFingerprints(input as ProcessMcpToolCallInput, argumentsValue);
  const reservedAction = snapshot.speakerQueue.find((item) => item.jobId === input.jobId);
  const reservationFingerprint = reservedAction?.requestFingerprint;
  if (input.reservationRequired && (!reservedAction
    || reservedAction.kind !== "mcp_tool_call"
    || reservedAction.meetingId !== input.meetingId
    || reservedAction.agentId !== input.agentId
    || reservedAction.participantId !== input.participantId
    || reservedAction.roleRevision !== input.roleRevision
    || reservedAction.roleId !== input.roleId
    || reservedAction.roleVersion !== input.roleVersion
    || reservedAction.toolName !== input.toolName
    || !reservationFingerprint
    || (fingerprints && !fingerprints.accepted.has(reservationFingerprint)))) {
    return false;
  }
  if (!reservationFingerprint && !fingerprints) return false;
  const requestFingerprint = input.reservationRequired
    ? reservationFingerprint!
    : fingerprints!.current;
  const connector = snapshot.mcpConnectors.find((item) => item.id === input.connectorId);
  const committed = await input.store.commitMcpToolRun({
    jobId: input.jobId,
    requestFingerprint,
    meetingId: input.meetingId,
    agentId: input.agentId,
    participantId: input.participantId,
    roleRevision: input.roleRevision,
    roleId: input.roleId,
    roleVersion: input.roleVersion,
    connectorId: input.connectorId,
    toolName: input.toolName,
    toolSnapshot: toolSnapshot(connector, input.toolName, input.toolSnapshot),
    status: "failed",
    content: redactString(input.message, collectArgumentValues(argumentsValue ?? {})).slice(0, 1_000),
    ...(input.connectorFingerprint === undefined ? {} : { connectorFingerprint: input.connectorFingerprint }),
    ...(input.reservationRequired === undefined ? {} : { reservationRequired: input.reservationRequired })
  });
  return committed.status !== "stale";
}

export interface RecordReservedMcpToolFailureInput {
  store: McpToolFailureStore;
  jobId: string;
  message: string;
}

export interface RecordReservedMcpToolFailureResult {
  recorded: boolean;
  queueItem: SpeakerQueueItem | null;
  existingRunStatus: "succeeded" | "failed" | null;
}

export async function recordReservedMcpToolFailure(
  input: RecordReservedMcpToolFailureInput
): Promise<RecordReservedMcpToolFailureResult> {
  const snapshot = await input.store.getSnapshot();
  const existingRun = snapshot.toolRuns.find((item) => item.jobId === input.jobId);
  if (existingRun) {
    return { recorded: true, queueItem: null, existingRunStatus: existingRun.status };
  }
  const queueItem = snapshot.speakerQueue.find((item) => item.jobId === input.jobId) ?? null;
  const binding = queueItem?.mcpExecutionBinding;
  if (!queueItem
    || queueItem.kind !== "mcp_tool_call"
    || !queueItem.requestFingerprint
    || !queueItem.toolName
    || !binding) {
    return { recorded: false, queueItem, existingRunStatus: null };
  }
  const committed = await input.store.commitMcpToolRun({
    jobId: queueItem.jobId,
    requestFingerprint: queueItem.requestFingerprint,
    meetingId: queueItem.meetingId,
    agentId: queueItem.agentId,
    participantId: queueItem.participantId,
    roleRevision: queueItem.roleRevision,
    roleId: queueItem.roleId,
    roleVersion: queueItem.roleVersion,
    connectorId: binding.connectorId,
    toolName: queueItem.toolName,
    toolSnapshot: binding.toolSnapshot,
    connectorFingerprint: binding.connectorFingerprint,
    status: "failed",
    content: redactString(input.message, new Set()).slice(0, 1_000),
    reservationRequired: true
  });
  return { recorded: committed.status !== "stale", queueItem, existingRunStatus: committed.status === "stale" ? null : committed.run.status };
}
