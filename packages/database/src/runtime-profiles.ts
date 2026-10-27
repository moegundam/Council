import {
  createRuntimeProfileRevision,
  runtimeProfileSnapshotSchema,
  type RuntimeProfile,
  type RuntimeProfileBinding,
  type RuntimeProfileRevision,
  type RuntimeProfileSnapshot
} from "@council/contracts";
import { resolveRuntimeProfileAdmission } from "@council/domain";

export const defaultRuntimeProfileId = "76000000-0000-4000-8000-000000000001";
export const defaultRuntimeProfileBinding: RuntimeProfileBinding = {
  profileId: defaultRuntimeProfileId,
  revision: 1
};

const defaultRuntimeProfileName = "Default text runtime";
const defaultRuntimeProfileCapabilities = ["text", "abort"] as const;

export function createDefaultRuntimeProfile(recordedAt: string): RuntimeProfile {
  return {
    id: defaultRuntimeProfileId,
    name: defaultRuntimeProfileName,
    harnessKind: "openai_compatible",
    modelConnectorId: null,
    sandboxProfileId: null,
    policy: "text_only",
    capabilities: [...defaultRuntimeProfileCapabilities],
    timeoutMs: 90_000,
    maxConcurrency: 2,
    enabled: true,
    revision: 1,
    createdAt: recordedAt,
    updatedAt: recordedAt
  };
}

export function createDefaultRuntimeProfileRevision(recordedAt: string): RuntimeProfileRevision {
  return createRuntimeProfileRevision(createDefaultRuntimeProfile(recordedAt), "legacy_backfilled", recordedAt);
}

export function sameRuntimeProfileBinding(
  left: RuntimeProfileBinding | null | undefined,
  right: RuntimeProfileBinding | null | undefined
): boolean {
  return (left?.profileId ?? null) === (right?.profileId ?? null)
    && (left?.revision ?? null) === (right?.revision ?? null);
}

export function sameRuntimeProfileSnapshot(
  left: RuntimeProfileSnapshot | null | undefined,
  right: RuntimeProfileSnapshot | null | undefined
): boolean {
  const parsedLeft = runtimeProfileSnapshotSchema.safeParse(left);
  const parsedRight = runtimeProfileSnapshotSchema.safeParse(right);
  if (!parsedLeft.success || !parsedRight.success) return false;
  return JSON.stringify(parsedLeft.data) === JSON.stringify(parsedRight.data);
}

export function resolveRuntimeProfileSnapshotForBinding(input: {
  binding: RuntimeProfileBinding | null | undefined;
  runtimeProfiles: RuntimeProfile[] | undefined;
  runtimeProfileRevisions: RuntimeProfileRevision[] | undefined;
  agentModelConnectorId: string | null;
  executionIsolationAttested?: boolean;
}): RuntimeProfileSnapshot | null {
  try {
    return resolveRuntimeProfileAdmission({
      binding: input.binding,
      platform: {
        runtimeProfiles: input.runtimeProfiles,
        runtimeProfileRevisions: input.runtimeProfileRevisions
      },
      agentModelConnectorId: input.agentModelConnectorId,
      executionIsolationAttested: input.executionIsolationAttested
    });
  } catch {
    return null;
  }
}
