import {
  createRuntimeProfileSnapshot,
  runtimeProfileRevisionSchema,
  runtimeProfileSnapshotSchema,
  type RuntimePolicy,
  type RuntimeProfile,
  type RuntimeProfileBinding,
  type RuntimeProfileRevision,
  type RuntimeProfileSnapshot
} from "@council/contracts";

const policyPrivilege: Record<RuntimePolicy, number> = {
  text_only: 0,
  read_only_tools: 1,
  isolated_exec: 2
};

export class RuntimeProfileAdmissionError extends Error {
  constructor(
    message: string,
    readonly reason: RuntimeProfileAdmissionReason = "invalid"
  ) {
    super(message);
    this.name = "RuntimeProfileAdmissionError";
  }
}

export type RuntimeProfileAdmissionReason =
  | "binding_missing"
  | "profile_unavailable"
  | "revision_unavailable"
  | "revision_disabled"
  | "model_mismatch"
  | "snapshot_mismatch"
  | "isolation_unattested"
  | "invalid";

export interface RuntimeProfileCatalog {
  runtimeProfiles?: readonly RuntimeProfile[] | undefined;
  runtimeProfileRevisions?: readonly RuntimeProfileRevision[] | undefined;
}

export interface RuntimeProfileAdmissionInput {
  binding: RuntimeProfileBinding | null | undefined;
  platform?: RuntimeProfileCatalog | undefined;
  revision?: RuntimeProfileRevision | undefined;
  agentModelConnectorId: string | null;
  queuedSnapshot?: RuntimeProfileSnapshot | null | undefined;
  executionIsolationAttested?: boolean | undefined;
}

function admissionError(
  reason: Exclude<RuntimeProfileAdmissionReason, "invalid">,
  message: string
): RuntimeProfileAdmissionError {
  return new RuntimeProfileAdmissionError(message, reason);
}

export function runtimePolicyCanTighten(parent: RuntimePolicy, child: RuntimePolicy): boolean {
  return policyPrivilege[child] <= policyPrivilege[parent];
}

export function resolveRuntimeProfileAdmission(input: RuntimeProfileAdmissionInput): RuntimeProfileSnapshot {
  if (!input.binding) {
    throw admissionError("binding_missing", "Runtime Profile binding is missing.");
  }

  let rawRevision: RuntimeProfileRevision | undefined = input.revision;
  if (input.platform) {
    const current = input.platform.runtimeProfiles?.find((profile) => profile.id === input.binding!.profileId);
    if (!current?.enabled) {
      throw admissionError("profile_unavailable", "Runtime Profile is unavailable or disabled.");
    }
    rawRevision = input.platform.runtimeProfileRevisions?.find((revision) => (
      revision.profileId === input.binding!.profileId && revision.revision === input.binding!.revision
    ));
  }

  const parsedRevision = runtimeProfileRevisionSchema.safeParse(rawRevision);
  if (!parsedRevision.success
    || parsedRevision.data.profileId !== input.binding.profileId
    || parsedRevision.data.revision !== input.binding.revision) {
    throw admissionError("revision_unavailable", "Runtime Profile binding is stale.");
  }
  const revision = parsedRevision.data;
  if (!revision.enabled) {
    throw admissionError("revision_disabled", "Runtime Profile is disabled.");
  }
  if (revision.modelConnectorId !== null && revision.modelConnectorId !== input.agentModelConnectorId) {
    throw admissionError("model_mismatch", "Runtime Profile model binding does not match the Agent model.");
  }
  if (revision.policy === "isolated_exec" && input.executionIsolationAttested !== true) {
    throw admissionError(
      "isolation_unattested",
      "Isolated execution requires a verified deployment isolation attestation."
    );
  }

  const expected = createRuntimeProfileSnapshot(revision);
  if (input.queuedSnapshot !== undefined) {
    const queued = runtimeProfileSnapshotSchema.safeParse(input.queuedSnapshot);
    if (!queued.success || JSON.stringify(queued.data) !== JSON.stringify(expected)) {
      throw admissionError("snapshot_mismatch", "Queued Runtime Profile snapshot is stale.");
    }
  }
  return expected;
}
