import {
  type AgentRevision,
  type PlatformSnapshot,
  type RuntimeProfileBinding,
  type RuntimeProfileSnapshot
} from "@council/contracts";
import { resolveRuntimeProfileAdmission } from "@council/domain";
import type { AgentHarnessProfile } from "@council/runtime";

export class StaleRuntimeProfileBindingError extends Error {
  constructor() {
    super("The queued Runtime Profile no longer matches the published Agent binding.");
    this.name = "StaleRuntimeProfileBindingError";
  }
}

function sameBinding(left: RuntimeProfileBinding, right: RuntimeProfileBinding): boolean {
  return left.profileId === right.profileId && left.revision === right.revision;
}

export function runtimeProfileAllowsHarness(
  runtimeProfile: RuntimeProfileSnapshot,
  harnessProfile: AgentHarnessProfile
): boolean {
  const capabilities = new Set(harnessProfile.capabilities);
  if (harnessProfile.kind !== runtimeProfile.harnessKind
    || harnessProfile.version.trim().length === 0
    || !capabilities.has("text")
    || capabilities.size !== harnessProfile.capabilities.length) {
    return false;
  }
  const approved = new Set(runtimeProfile.capabilities);
  return harnessProfile.capabilities.every((capability) => approved.has(capability));
}

export function resolveQueuedRuntimeProfile(input: {
  platform: PlatformSnapshot;
  agentRevision: AgentRevision;
  queuedBinding: RuntimeProfileBinding | undefined;
  queuedSnapshot: RuntimeProfileSnapshot | undefined;
  executionIsolationAttested?: boolean;
}): RuntimeProfileSnapshot {
  const publishedBinding = input.agentRevision.runtimeProfileBinding;
  if (!publishedBinding
    || !input.queuedBinding
    || !input.queuedSnapshot
    || !sameBinding(publishedBinding, input.queuedBinding)) {
    throw new StaleRuntimeProfileBindingError();
  }

  try {
    return resolveRuntimeProfileAdmission({
      binding: publishedBinding,
      platform: input.platform,
      agentModelConnectorId: input.agentRevision.modelConnectorId,
      queuedSnapshot: input.queuedSnapshot,
      executionIsolationAttested: input.executionIsolationAttested
    });
  } catch {
    throw new StaleRuntimeProfileBindingError();
  }
}
