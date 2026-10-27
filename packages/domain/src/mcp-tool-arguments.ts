import { mcpToolArgumentsSchema } from "@council/contracts";
import type { SecretVault } from "#secret-vault";

interface McpToolArgumentEnvelope {
  version: 1;
  jobId: string;
  arguments: Record<string, unknown>;
}

function parseEnvelope(value: string): McpToolArgumentEnvelope {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Encrypted MCP argument envelope is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1
    || typeof record.jobId !== "string"
    || !record.jobId.trim()
    || record.jobId.length > 500
    || Object.keys(record).length !== 3
    || !Object.hasOwn(record, "arguments")) {
    throw new Error("Encrypted MCP argument envelope is invalid.");
  }
  return {
    version: 1,
    jobId: record.jobId,
    arguments: mcpToolArgumentsSchema.parse(record.arguments)
  };
}

export function encryptMcpToolArguments(
  vault: SecretVault,
  jobId: string,
  argumentsValue: Record<string, unknown>
): string {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId || normalizedJobId.length > 500) throw new Error("MCP argument job binding is invalid.");
  const envelope: McpToolArgumentEnvelope = {
    version: 1,
    jobId: normalizedJobId,
    arguments: mcpToolArgumentsSchema.parse(argumentsValue)
  };
  return vault.encrypt(JSON.stringify(envelope));
}

export function decryptMcpToolArguments(
  vault: SecretVault,
  jobId: string,
  ciphertext: string
): Record<string, unknown> {
  const envelope = parseEnvelope(vault.decrypt(ciphertext));
  if (envelope.jobId !== jobId) throw new Error("Encrypted MCP argument job binding does not match.");
  return envelope.arguments;
}
