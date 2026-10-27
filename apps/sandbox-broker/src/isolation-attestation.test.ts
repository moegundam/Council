import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExecutionIsolationAttestation } from "./isolation-attestation.js";

const directories: string[] = [];
const imageDigest = `sha256:${"a".repeat(64)}`;

async function writeAttestation(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sandbox-attestation-"));
  directories.push(directory);
  const path = join(directory, "attestation.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    brokerImageDigest: imageDigest,
    evidenceDigest: `sha256:${"b".repeat(64)}`,
    verifiedAt: "2026-08-03T00:00:00.000Z",
    expiresAt: "2026-08-03T01:00:00.000Z",
    controls: {
      rootless: true,
      noNewPrivileges: true,
      readOnlyRootfs: true,
      denyAllEgress: true,
      hostSocketAbsent: true,
      hostNetworkAbsent: true,
      resourceLimitsEnforced: true
    },
    ...overrides
  }));
  return path;
}

describe("readExecutionIsolationAttestation", () => {
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("accepts a short-lived attestation for the exact broker image", async () => {
    await expect(readExecutionIsolationAttestation(
      await writeAttestation(),
      imageDigest,
      new Date("2026-08-03T00:30:00.000Z")
    )).resolves.toEqual({
      brokerImageDigest: imageDigest,
      evidenceDigest: `sha256:${"b".repeat(64)}`,
      expiresAt: "2026-08-03T01:00:00.000Z"
    });
  });

  it("rejects expired, mismatched, incomplete, or excessively long attestations", async () => {
    await expect(readExecutionIsolationAttestation(
      await writeAttestation(),
      imageDigest,
      new Date("2026-08-03T01:00:00.000Z")
    )).rejects.toThrow(/expired/i);
    await expect(readExecutionIsolationAttestation(
      await writeAttestation(),
      `sha256:${"c".repeat(64)}`,
      new Date("2026-08-03T00:30:00.000Z")
    )).rejects.toThrow(/image/i);
    await expect(readExecutionIsolationAttestation(
      await writeAttestation({ controls: { rootless: true } }),
      imageDigest,
      new Date("2026-08-03T00:30:00.000Z")
    )).rejects.toThrow(/invalid/i);
    await expect(readExecutionIsolationAttestation(
      await writeAttestation({ expiresAt: "2026-08-05T00:00:00.000Z" }),
      imageDigest,
      new Date("2026-08-03T00:30:00.000Z")
    )).rejects.toThrow(/24 hours/i);
  });
});
