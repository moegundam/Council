export type GovernanceJsonValue = null | boolean | number | string | GovernanceJsonValue[] | {
  [key: string]: GovernanceJsonValue;
};

export type GovernancePoint =
  | "input"
  | "pre_model_call"
  | "post_model_call"
  | "pre_tool_call"
  | "post_tool_call"
  | "output";
export type GovernanceMode = "off" | "shadow" | "enforce";
export type GovernanceDecisionName = "allow" | "deny" | "warn" | "escalate" | "transform";

export interface GovernanceProviderMetadata {
  providerId: string;
  providerVersion: string;
  policyDigest: string;
}

export interface GovernanceEvaluationRequest {
  point: GovernancePoint;
  actionIdentity: string;
  snapshot: Record<string, GovernanceJsonValue>;
}

export interface GovernanceDecision {
  decision: GovernanceDecisionName;
  reason?: string;
  inputIdentity?: string;
  enforcedIdentity?: string;
  evidenceArtefact?: string;
  evidencePointerKeys?: string[];
  resultLabels?: string[];
}

export interface GovernanceProvider {
  readonly metadata: GovernanceProviderMetadata;
  evaluate(request: GovernanceEvaluationRequest): Promise<GovernanceDecision>;
}

export interface GovernanceControl {
  mode: GovernanceMode;
  provider: GovernanceProvider;
  timeoutMs?: number;
  initializationError?: Error;
}

export interface GovernanceGateResult extends GovernanceProviderMetadata {
  mode: Exclude<GovernanceMode, "off">;
  point: GovernancePoint;
  actionIdentity: string;
  decision: GovernanceDecisionName | "provider_error";
  effect: "allow" | "block";
  wouldBlock: boolean;
  reason?: string;
  inputIdentity?: string;
  enforcedIdentity?: string;
  evidenceArtefact?: string;
  evidencePointerKeys?: string[];
  resultLabels?: string[];
}

const supportedDecisions = new Set<GovernanceDecisionName>([
  "allow", "deny", "warn", "escalate", "transform"
]);
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/;
const supportedReasonCodes = new Set([
  "council.native-authorization-invariant-failed",
  "council.native-read-only-authorization-confirmed",
  "governance.provider-error"
]);
const providerIdPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const providerVersionPattern = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const unavailableMetadata: GovernanceProviderMetadata = {
  providerId: "invalid",
  providerVersion: "unknown",
  policyDigest: "unavailable"
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function boundedStrings(value: unknown, maximumItems = 32, maximumLength = 128): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = [...new Set(value
    .map((item) => boundedString(item, maximumLength))
    .filter((item): item is string => Boolean(item)))]
    .sort()
    .slice(0, maximumItems);
  return entries.length > 0 ? entries : undefined;
}

function digest(value: unknown): string | undefined {
  return typeof value === "string" && sha256DigestPattern.test(value) ? value : undefined;
}

function reasonCode(value: unknown): string | undefined {
  return typeof value === "string" && supportedReasonCodes.has(value) ? value : undefined;
}

function normalizeMetadata(value: unknown): GovernanceProviderMetadata {
  const input = record(value);
  const providerId = input?.providerId;
  const providerVersion = input?.providerVersion;
  const policyDigest = input?.policyDigest;
  if (typeof providerId !== "string" || !providerIdPattern.test(providerId)
    || typeof providerVersion !== "string" || !providerVersionPattern.test(providerVersion)
    || typeof policyDigest !== "string"
    || (!sha256DigestPattern.test(policyDigest)
      && policyDigest !== "native-business-authorization-v1"
      && policyDigest !== "unavailable")) {
    throw new Error("Governance provider returned invalid metadata.");
  }
  return { providerId, providerVersion, policyDigest };
}

function normalizeDecision(value: unknown): GovernanceDecision {
  const input = record(value);
  const decision = input?.decision;
  if (typeof decision !== "string" || !supportedDecisions.has(decision as GovernanceDecisionName)) {
    throw new Error("Governance provider returned an unsupported decision.");
  }
  const reason = reasonCode(input?.reason);
  const inputIdentity = digest(input?.inputIdentity);
  const enforcedIdentity = digest(input?.enforcedIdentity);
  const evidenceArtefact = digest(input?.evidenceArtefact);
  const evidencePointerKeys = boundedStrings(input?.evidencePointerKeys);
  const resultLabels = boundedStrings(input?.resultLabels);
  return {
    decision: decision as GovernanceDecisionName,
    ...(reason ? { reason } : {}),
    ...(inputIdentity ? { inputIdentity } : {}),
    ...(enforcedIdentity ? { enforcedIdentity } : {}),
    ...(evidenceArtefact ? { evidenceArtefact } : {}),
    ...(evidencePointerKeys ? { evidencePointerKeys } : {}),
    ...(resultLabels ? { resultLabels } : {})
  };
}

export class NativeGovernanceProvider implements GovernanceProvider {
  readonly metadata: GovernanceProviderMetadata = {
    providerId: "native",
    providerVersion: "1",
    policyDigest: "native-business-authorization-v1"
  };

  async evaluate(request: GovernanceEvaluationRequest): Promise<GovernanceDecision> {
    return {
      decision: "allow",
      reason: "native.business-authorization-complete",
      inputIdentity: request.actionIdentity,
      enforcedIdentity: request.actionIdentity
    };
  }
}

export async function evaluateGovernanceGate(
  control: GovernanceControl,
  request: GovernanceEvaluationRequest
): Promise<GovernanceGateResult | null> {
  if (control.mode === "off") return null;
  let metadata = unavailableMetadata;
  let decision: GovernanceDecision;
  try {
    metadata = normalizeMetadata(control.provider.metadata);
    const timeoutMs = control.timeoutMs ?? 2_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5_000) {
      throw new Error("Governance timeout is outside the supported range.");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      decision = normalizeDecision(await Promise.race([
        control.provider.evaluate(request),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Governance provider timed out.")), timeoutMs);
        })
      ]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch {
    const effect = control.mode === "enforce" ? "block" : "allow";
    return {
      ...metadata,
      mode: control.mode,
      point: request.point,
      actionIdentity: request.actionIdentity,
      decision: "provider_error",
      effect,
      wouldBlock: true,
      reason: "governance.provider-error"
    };
  }

  const wouldBlock = decision.decision === "deny"
    || decision.decision === "escalate"
    || decision.decision === "transform";
  return {
    ...metadata,
    mode: control.mode,
    point: request.point,
    actionIdentity: request.actionIdentity,
    decision: decision.decision,
    effect: control.mode === "enforce" && wouldBlock ? "block" : "allow",
    wouldBlock,
    ...(decision.reason ? { reason: decision.reason } : {}),
    ...(decision.inputIdentity ? { inputIdentity: decision.inputIdentity } : {}),
    ...(decision.enforcedIdentity ? { enforcedIdentity: decision.enforcedIdentity } : {}),
    ...(decision.evidenceArtefact ? { evidenceArtefact: decision.evidenceArtefact } : {}),
    ...(decision.evidencePointerKeys ? { evidencePointerKeys: decision.evidencePointerKeys } : {}),
    ...(decision.resultLabels ? { resultLabels: decision.resultLabels } : {})
  };
}

export function governanceAuditDetail(result: GovernanceGateResult): Record<string, unknown> {
  const safeReasonCode = reasonCode(result.reason);
  const safeInputIdentity = digest(result.inputIdentity);
  const safeEnforcedIdentity = digest(result.enforcedIdentity);
  const safeEvidenceArtefact = digest(result.evidenceArtefact);
  return {
    providerId: result.providerId,
    providerVersion: result.providerVersion,
    policyDigest: result.policyDigest,
    mode: result.mode,
    point: result.point,
    actionIdentity: result.actionIdentity,
    decision: result.decision,
    effect: result.effect,
    wouldBlock: result.wouldBlock,
    ...(safeReasonCode ? { reasonCode: safeReasonCode } : {}),
    ...(safeInputIdentity ? { inputIdentity: safeInputIdentity } : {}),
    ...(safeEnforcedIdentity ? { enforcedIdentity: safeEnforcedIdentity } : {}),
    ...(safeEvidenceArtefact ? { evidenceArtefact: safeEvidenceArtefact } : {}),
    ...(result.evidencePointerKeys ? { evidencePointerCount: result.evidencePointerKeys.length } : {}),
    ...(result.resultLabels ? { resultLabelCount: result.resultLabels.length } : {})
  };
}

export class GovernanceDeniedError extends Error {
  readonly code = "EACCES";

  constructor(readonly result: GovernanceGateResult) {
    super(`Governance policy blocked ${result.point} with ${result.decision}.`);
    this.name = "GovernanceDeniedError";
  }
}

export class GovernanceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GovernanceUnavailableError";
  }
}
