import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  NativeGovernanceProvider,
  type GovernanceControl,
  type GovernanceDecision,
  type GovernanceEvaluationRequest,
  type GovernanceJsonValue,
  type GovernanceMode,
  type GovernanceProvider,
  type GovernanceProviderMetadata
} from "./governance.js";

const microsoftAcsVersion = "0.3.1-beta.0";
const maximumPolicyArtifacts = 16;
const maximumPolicyArtifactBytes = 1_048_576;
const sha256DigestPattern = /^sha256:[a-f0-9]{64}$/;

const acsResultSchema = z.object({
  verdict: z.object({
    decision: z.enum(["allow", "deny", "warn", "escalate", "transform"]),
    reason: z.string().nullish(),
    evidence: z.object({
      artefact: z.string().optional(),
      verificationPointers: z.record(z.string(), z.string()).optional()
    }).optional(),
    result_labels: z.array(z.string()).optional()
  }).passthrough(),
  inputIdentity: z.string().optional(),
  enforcedIdentity: z.string().optional(),
  actionIdentity: z.string().optional()
}).passthrough();

export interface AcsEvaluateOnlyClient {
  evaluateInterventionPoint(
    point: string,
    snapshot: Record<string, GovernanceJsonValue>,
    mode: "evaluate_only"
  ): Promise<unknown>;
}

export interface PolicyArtifact {
  identity: string;
  content: Uint8Array;
}

interface LoadedPolicyArtifact extends PolicyArtifact {
  path: string;
}

export async function policyArtifactDigest(artifacts: readonly PolicyArtifact[]): Promise<string> {
  if (artifacts.length === 0 || artifacts.length > maximumPolicyArtifacts) {
    throw new Error(`Governance policy requires between 1 and ${maximumPolicyArtifacts} artifacts.`);
  }
  const identities = new Set<string>();
  const normalized = artifacts.map((artifact) => {
    const identity = artifact.identity.trim();
    if (!identity || identities.has(identity)) throw new Error("Governance policy artifact identity is duplicate or empty.");
    if (artifact.content.byteLength > maximumPolicyArtifactBytes) {
      throw new Error("Governance policy artifact exceeds the size limit.");
    }
    identities.add(identity);
    return { identity, content: artifact.content };
  }).sort((left, right) => left.identity.localeCompare(right.identity));

  const digest = createHash("sha256");
  for (const artifact of normalized) {
    const identity = Buffer.from(artifact.identity, "utf8");
    digest.update(String(identity.byteLength));
    digest.update(":");
    digest.update(identity);
    digest.update(":");
    digest.update(String(artifact.content.byteLength));
    digest.update(":");
    digest.update(artifact.content);
    digest.update("\n");
  }
  return `sha256:${digest.digest("hex")}`;
}

export class MicrosoftAcsGovernanceProvider implements GovernanceProvider {
  readonly metadata: GovernanceProviderMetadata;

  constructor(
    private readonly client: AcsEvaluateOnlyClient,
    options: { policyDigest: string }
  ) {
    if (!sha256DigestPattern.test(options.policyDigest)) {
      throw new Error("Microsoft ACS policy digest must be SHA-256.");
    }
    this.metadata = {
      providerId: "microsoft_acs",
      providerVersion: microsoftAcsVersion,
      policyDigest: options.policyDigest
    };
  }

  async evaluate(request: GovernanceEvaluationRequest): Promise<GovernanceDecision> {
    const parsed = acsResultSchema.safeParse(await this.client.evaluateInterventionPoint(
      request.point,
      request.snapshot,
      "evaluate_only"
    ));
    if (!parsed.success) throw new Error("Microsoft ACS returned an invalid verdict.");
    const evidencePointerKeys = parsed.data.verdict.evidence?.verificationPointers
      ? Object.keys(parsed.data.verdict.evidence.verificationPointers).sort()
      : undefined;
    const enforcedIdentity = parsed.data.enforcedIdentity ?? parsed.data.actionIdentity;
    return {
      decision: parsed.data.verdict.decision,
      ...(parsed.data.verdict.reason ? { reason: parsed.data.verdict.reason } : {}),
      ...(parsed.data.inputIdentity ? { inputIdentity: parsed.data.inputIdentity } : {}),
      ...(enforcedIdentity ? { enforcedIdentity } : {}),
      ...(parsed.data.verdict.evidence?.artefact
        ? { evidenceArtefact: parsed.data.verdict.evidence.artefact }
        : {}),
      ...(evidencePointerKeys && evidencePointerKeys.length > 0 ? { evidencePointerKeys } : {}),
      ...(parsed.data.verdict.result_labels ? { resultLabels: parsed.data.verdict.result_labels } : {})
    };
  }
}

class UnavailableMicrosoftAcsGovernanceProvider implements GovernanceProvider {
  readonly metadata: GovernanceProviderMetadata;

  constructor(expectedPolicyDigest: string | undefined) {
    this.metadata = {
      providerId: "microsoft_acs",
      providerVersion: microsoftAcsVersion,
      policyDigest: expectedPolicyDigest && sha256DigestPattern.test(expectedPolicyDigest)
        ? expectedPolicyDigest
        : "unavailable"
    };
  }

  async evaluate(): Promise<GovernanceDecision> {
    throw new Error("Microsoft ACS governance provider is unavailable.");
  }
}

function initializationError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Microsoft ACS governance initialization failed.");
}

async function readRegularPolicyArtifact(path: string, identity: string): Promise<LoadedPolicyArtifact> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > maximumPolicyArtifactBytes) {
    throw new Error("Governance policy artifact must be a bounded regular file.");
  }
  return { path, identity, content: await readFile(path) };
}

async function readPolicyArtifactPath(path: string): Promise<LoadedPolicyArtifact[]> {
  if (!isAbsolute(path)) throw new Error("Governance policy artifact paths must be absolute.");
  const canonicalPath = await realpath(path);
  const metadata = await lstat(canonicalPath);
  if (metadata.isFile()) {
    return [await readRegularPolicyArtifact(canonicalPath, basename(canonicalPath))];
  }
  if (!metadata.isDirectory()) throw new Error("Governance policy artifact path must be a regular file or directory.");

  const artifacts: LoadedPolicyArtifact[] = [];
  const rootIdentity = basename(canonicalPath);
  async function visit(directoryPath: string, depth: number): Promise<void> {
    if (depth > 8) throw new Error("Governance policy artifact directory is too deeply nested.");
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
      if (entry.isSymbolicLink()) {
        throw new Error("Governance policy artifact directories must not contain symbolic links.");
      }
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error("Governance policy artifact directory contains an unsupported entry.");
      const relativeIdentity = relative(canonicalPath, entryPath).split(sep).join("/");
      artifacts.push(await readRegularPolicyArtifact(entryPath, `${rootIdentity}/${relativeIdentity}`));
      if (artifacts.length > maximumPolicyArtifacts) {
        throw new Error(`Governance policy may contain at most ${maximumPolicyArtifacts} artifacts.`);
      }
    }
  }
  await visit(canonicalPath, 0);
  if (artifacts.length === 0) throw new Error("Governance policy artifact directory is empty.");
  return artifacts;
}

export async function policyArtifactDigestFromPaths(paths: readonly string[]): Promise<string> {
  if (paths.length === 0 || paths.length > maximumPolicyArtifacts) {
    throw new Error(`Governance policy requires between 1 and ${maximumPolicyArtifacts} artifact paths.`);
  }
  const artifacts: LoadedPolicyArtifact[] = [];
  for (const path of paths) {
    artifacts.push(...await readPolicyArtifactPath(path));
    if (artifacts.length > maximumPolicyArtifacts) {
      throw new Error(`Governance policy may contain at most ${maximumPolicyArtifacts} artifacts.`);
    }
  }
  return policyArtifactDigest(artifacts);
}

function governanceMode(value: string | undefined): GovernanceMode {
  const mode = value ?? "off";
  if (mode !== "off" && mode !== "shadow" && mode !== "enforce") {
    throw new Error("GOVERNANCE_MODE must be off, shadow, or enforce.");
  }
  return mode;
}

function governanceTimeoutMs(value: string | undefined): number {
  const timeoutMs = Number(value ?? "2000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5_000) {
    throw new Error("GOVERNANCE_TIMEOUT_MS must be an integer between 50 and 5000.");
  }
  return timeoutMs;
}

function policyArtifactPaths(env: NodeJS.ProcessEnv): string[] {
  const extras = (env.GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (extras.length === 0) throw new Error("Microsoft ACS requires GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS.");
  if (extras.length >= maximumPolicyArtifacts) {
    throw new Error(`Microsoft ACS supports at most ${maximumPolicyArtifacts - 1} policy artifact paths plus its manifest.`);
  }
  return extras;
}

export async function createGovernanceControlFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<GovernanceControl> {
  const provider = env.GOVERNANCE_PROVIDER ?? "native";
  const mode = governanceMode(env.GOVERNANCE_MODE);
  const timeoutMs = governanceTimeoutMs(env.GOVERNANCE_TIMEOUT_MS);
  if (provider === "native") {
    if (mode !== "off") throw new Error("Native governance may only be used with GOVERNANCE_MODE=off.");
    return { mode, timeoutMs, provider: new NativeGovernanceProvider() };
  }
  if (provider !== "microsoft_acs") {
    throw new Error("GOVERNANCE_PROVIDER must be native or microsoft_acs.");
  }
  if (mode === "off") throw new Error("Microsoft ACS requires GOVERNANCE_MODE=shadow or enforce.");
  const expectedDigest = env.GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST;
  try {
    const manifestPath = env.GOVERNANCE_ACS_MANIFEST_PATH;
    if (!manifestPath) throw new Error("Microsoft ACS requires GOVERNANCE_ACS_MANIFEST_PATH.");
    const manifestArtifacts = await readPolicyArtifactPath(manifestPath);
    if (manifestArtifacts.length !== 1 || manifestArtifacts[0]!.path !== await realpath(manifestPath)) {
      throw new Error("Microsoft ACS manifest path must identify one regular file.");
    }
    const artifacts = [...manifestArtifacts];
    for (const path of policyArtifactPaths(env)) {
      const loaded = await readPolicyArtifactPath(path);
      if (artifacts.length + loaded.length > maximumPolicyArtifacts) {
        throw new Error(`Governance policy may contain at most ${maximumPolicyArtifacts} artifacts including its manifest.`);
      }
      artifacts.push(...loaded);
    }
    const digest = await policyArtifactDigest(artifacts);
    if (mode === "enforce" && !expectedDigest) {
      throw new Error("Microsoft ACS enforce mode requires GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST.");
    }
    if (expectedDigest && (!sha256DigestPattern.test(expectedDigest) || expectedDigest !== digest)) {
      throw new Error("Microsoft ACS policy artifact digest does not match the expected digest.");
    }

    const acs = await import("agent-control-specification");
    const control = acs.AgentControl.fromPath(manifestArtifacts[0]!.path);
    return {
      mode,
      timeoutMs,
      provider: new MicrosoftAcsGovernanceProvider(control as unknown as AcsEvaluateOnlyClient, {
        policyDigest: digest
      })
    };
  } catch (error) {
    if (mode !== "shadow") throw error;
    return {
      mode,
      timeoutMs,
      provider: new UnavailableMicrosoftAcsGovernanceProvider(expectedDigest),
      initializationError: initializationError(error)
    };
  }
}
