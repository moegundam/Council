import { mcpToolArgumentsSchema } from "@council/contracts";
import type { McpToolArgumentPayload, SpeakerQueueItem, Utterance } from "@council/contracts";
import { mcpToolRequestFingerprint, type PlatformStore } from "@council/database";
import { decryptMcpToolArguments, type SecretVault } from "@council/domain";
import {
  findPersistedMcpToolCall,
  McpToolOutcomeUnknownError,
  StaleMcpToolRunError,
  type ProcessMcpToolCallInput
} from "./process-mcp-tool-call.js";

type McpExecutionLifecycleStore = ProcessMcpToolCallInput["store"]
  & Pick<PlatformStore, "getSpeakerQueue" | "markSpeakerTurnRunning">;

export type PrepareMcpToolCallExecutionInput = Omit<ProcessMcpToolCallInput, "store"> & {
  store: McpExecutionLifecycleStore;
  deliveryAttempt?: number;
};

export interface PreparedMcpToolCallExecution {
  utterance: Utterance | null;
  queueItem: SpeakerQueueItem | null;
  inProgress: boolean;
  replayed: boolean;
}

function runningReservationMatches(
  item: SpeakerQueueItem,
  input: PrepareMcpToolCallExecutionInput
): boolean {
  const argumentsValue = mcpToolArgumentsSchema.parse(input.arguments);
  const fingerprintInput = { ...input, arguments: argumentsValue };
  const legacyFingerprint = mcpToolRequestFingerprint(fingerprintInput);
  const currentFingerprint = input.secretVault
    ? mcpToolRequestFingerprint(fingerprintInput, input.secretVault)
    : legacyFingerprint;
  const acceptedFingerprints = new Set([legacyFingerprint, currentFingerprint]);
  return item.status === "running"
    && item.kind === "mcp_tool_call"
    && item.jobId === input.jobId
    && item.meetingId === input.meetingId
    && item.agentId === input.agentId
    && item.participantId === input.participantId
    && item.roleRevision === input.roleRevision
    && item.roleId === input.roleId
    && item.roleVersion === input.roleVersion
    && item.toolName === input.toolName
    && item.requestFingerprint !== null
    && acceptedFingerprints.has(item.requestFingerprint)
    && (input.requestFingerprint === undefined || input.requestFingerprint === item.requestFingerprint)
    && item.mcpExecutionBinding?.connectorId === input.connectorId
    && item.mcpExecutionBinding.connectorFingerprint === input.connectorFingerprint
    && input.toolSnapshot !== undefined
    && JSON.stringify(item.mcpExecutionBinding.toolSnapshot) === JSON.stringify(input.toolSnapshot);
}

export function legacyMcpArgumentReaderEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MCP_LEGACY_ARGUMENT_READER_ENABLED ?? "true";
  if (value !== "true" && value !== "false") {
    throw new Error("MCP_LEGACY_ARGUMENT_READER_ENABLED must be true or false.");
  }
  return value === "true";
}

export function resolveMcpToolCallArguments(
  data: McpToolArgumentPayload,
  jobId: string,
  secretVault?: SecretVault,
  allowLegacyPlaintext = true
): Record<string, unknown> {
  if (data.argumentEncoding === "vault_v1") {
    if (!secretVault) throw new Error("Encrypted MCP tool arguments require the application Secret Vault.");
    return decryptMcpToolArguments(secretVault, jobId, data.argumentsCiphertext);
  }
  if (!allowLegacyPlaintext) throw new Error("Legacy plaintext MCP tool arguments are disabled.");
  return mcpToolArgumentsSchema.parse(data.arguments);
}

export async function prepareMcpToolCallExecution(
  input: PrepareMcpToolCallExecutionInput
): Promise<PreparedMcpToolCallExecution> {
  const persisted = await findPersistedMcpToolCall(input);
  if (persisted) return { utterance: persisted, queueItem: null, inProgress: false, replayed: true };

  const queueItem = await input.store.markSpeakerTurnRunning(input.jobId);
  if (queueItem) return { utterance: null, queueItem, inProgress: false, replayed: false };

  const committedDuringAdmission = await findPersistedMcpToolCall(input);
  if (committedDuringAdmission) {
    return { utterance: committedDuringAdmission, queueItem: null, inProgress: false, replayed: true };
  }
  const runningReservation = (await input.store.getSpeakerQueue())
    .find((item) => runningReservationMatches(item, input));
  if (runningReservation) {
    if ((input.deliveryAttempt ?? 1) > 1) {
      throw new McpToolOutcomeUnknownError(
        "MCP outcome is unknown after stalled redelivery; automatic replay is forbidden."
      );
    }
    return { utterance: null, queueItem: null, inProgress: true, replayed: false };
  }

  const committedAfterClaimCheck = await findPersistedMcpToolCall(input);
  if (committedAfterClaimCheck) {
    return { utterance: committedAfterClaimCheck, queueItem: null, inProgress: false, replayed: true };
  }
  throw new StaleMcpToolRunError("MCP action reservation is stale or expired.");
}
