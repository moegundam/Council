import { createHash } from "node:crypto";
import type { AgentRevision } from "@council/contracts";

export type AgentRevisionDigestInput = Pick<
  AgentRevision,
  | "agentId"
  | "revision"
  | "name"
  | "description"
  | "modelConnectorId"
  | "goalSummary"
  | "toolsSummary"
  | "dataSummary"
  | "skillIds"
  | "toolGrants"
  | "toolPackGrants"
  | "runtimeProfileBinding"
  | "promptBinding"
>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function digestPayload(revision: AgentRevisionDigestInput): AgentRevisionDigestInput {
  return {
    agentId: revision.agentId,
    revision: revision.revision,
    name: revision.name,
    description: revision.description,
    modelConnectorId: revision.modelConnectorId,
    goalSummary: revision.goalSummary,
    toolsSummary: revision.toolsSummary,
    dataSummary: revision.dataSummary,
    skillIds: revision.skillIds,
    toolGrants: revision.toolGrants,
    toolPackGrants: revision.toolPackGrants,
    runtimeProfileBinding: revision.runtimeProfileBinding,
    promptBinding: revision.promptBinding
  };
}

export function createAgentRevisionContentDigest(revision: AgentRevisionDigestInput): string {
  return digest(canonicalize(digestPayload(revision)));
}

function legacyV2Digests(revision: AgentRevisionDigestInput): Set<string> {
  const toolGrantVariants = [
    revision.toolGrants.map((grant) => ({ connectorId: grant.connectorId, toolName: grant.toolName })),
    revision.toolGrants.map((grant) => ({ toolName: grant.toolName, connectorId: grant.connectorId }))
  ];
  const toolPackGrantVariants = [
    revision.toolPackGrants.map((grant) => ({
      packId: grant.packId,
      revision: grant.revision,
      manifestDigest: grant.manifestDigest,
      toolName: grant.toolName
    })),
    revision.toolPackGrants.map((grant) => ({
      packId: grant.packId,
      revision: grant.revision,
      toolName: grant.toolName,
      manifestDigest: grant.manifestDigest
    }))
  ];
  const runtimeProfileBindingVariants = revision.runtimeProfileBinding
    ? [
        { profileId: revision.runtimeProfileBinding.profileId, revision: revision.runtimeProfileBinding.revision },
        { revision: revision.runtimeProfileBinding.revision, profileId: revision.runtimeProfileBinding.profileId }
      ]
    : [null];
  const promptBindingVariants = revision.promptBinding
    ? [
        { promptId: revision.promptBinding.promptId, version: revision.promptBinding.version },
        { version: revision.promptBinding.version, promptId: revision.promptBinding.promptId }
      ]
    : [null];
  const candidates = new Set<string>();
  for (const toolGrants of toolGrantVariants) {
    for (const toolPackGrants of toolPackGrantVariants) {
      for (const runtimeProfileBinding of runtimeProfileBindingVariants) {
        for (const promptBinding of promptBindingVariants) {
          candidates.add(digest({
            ...digestPayload(revision),
            toolGrants,
            toolPackGrants,
            runtimeProfileBinding,
            promptBinding
          }));
        }
      }
    }
  }
  return candidates;
}

export function agentRevisionContentDigestIsValid(revision: AgentRevision): boolean {
  if (revision.contentDigestVersion === 1) return true;
  if (revision.contentDigestVersion === 2) return legacyV2Digests(revision).has(revision.contentDigest);
  return revision.contentDigest === createAgentRevisionContentDigest(revision);
}
