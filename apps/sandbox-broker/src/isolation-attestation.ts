import { readFile } from "node:fs/promises";
import { z } from "zod";

const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

const attestationSchema = z.object({
  schemaVersion: z.literal(1),
  brokerImageDigest: sha256DigestSchema,
  evidenceDigest: sha256DigestSchema,
  verifiedAt: timestampSchema,
  expiresAt: timestampSchema,
  controls: z.object({
    rootless: z.literal(true),
    noNewPrivileges: z.literal(true),
    readOnlyRootfs: z.literal(true),
    denyAllEgress: z.literal(true),
    hostSocketAbsent: z.literal(true),
    hostNetworkAbsent: z.literal(true),
    resourceLimitsEnforced: z.literal(true)
  }).strict()
}).strict();

export class IsolationAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IsolationAttestationError";
  }
}

export async function readExecutionIsolationAttestation(
  path: string,
  expectedImageDigest: string,
  now = new Date()
): Promise<{ brokerImageDigest: string; evidenceDigest: string; expiresAt: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new IsolationAttestationError("Execution isolation attestation file is unreadable or invalid.");
  }
  const parsed = attestationSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IsolationAttestationError("Execution isolation attestation is invalid.");
  }
  const attestation = parsed.data;
  if (attestation.brokerImageDigest !== expectedImageDigest) {
    throw new IsolationAttestationError("Execution isolation attestation image does not match the broker image.");
  }
  const verifiedAt = Date.parse(attestation.verifiedAt);
  const expiresAt = Date.parse(attestation.expiresAt);
  if (verifiedAt > now.getTime()) {
    throw new IsolationAttestationError("Execution isolation attestation verification time is in the future.");
  }
  if (expiresAt <= now.getTime()) {
    throw new IsolationAttestationError("Execution isolation attestation has expired.");
  }
  if (expiresAt <= verifiedAt || expiresAt - verifiedAt > 24 * 60 * 60 * 1_000) {
    throw new IsolationAttestationError("Execution isolation attestation lifetime must not exceed 24 hours.");
  }
  return {
    brokerImageDigest: attestation.brokerImageDigest,
    evidenceDigest: attestation.evidenceDigest,
    expiresAt: attestation.expiresAt
  };
}
