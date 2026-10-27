import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ToolPackRegistryError,
  createToolPackRegistry,
  createToolPackManifestDigest
} from "./tool-pack-registry.js";

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function buildManifest(reference: string, executableDigest: string) {
  const scriptPath = fileURLToPath(new URL("./test-fixtures/echo-tool.js", import.meta.url));
  const pack = {
    id: "node-tools",
    version: "1.0.0",
    reference,
    executablePath: process.execPath,
    executableDigest,
    tools: {
      echo_env: {
        baseArgs: [scriptPath],
        allowedArgvSets: [["emit"]],
        envAllowlist: ["BROKER_TEST_SECRET"],
        allowStdin: false
      }
    }
  };
  return { ...pack, digest: createToolPackManifestDigest(pack) };
}

describe("createToolPackRegistry", () => {
  it("accepts a digest-pinned manifest with a matching executable identity", async () => {
    const executableDigest = await sha256File(process.execPath);
    const manifest = await buildManifest(`node-tools@sha256:${"a".repeat(64)}`, executableDigest);

    const registry = await createToolPackRegistry([manifest]);
    const resolved = registry.getTool("node-tools", "echo_env");

    expect(resolved.manifest.id).toBe("node-tools");
    expect(resolved.manifest.digest).toBe(manifest.digest);
  });

  it("rejects mutable references and digest mismatches", async () => {
    const executableDigest = await sha256File(process.execPath);
    const mutable = await buildManifest("node-tools:latest", executableDigest);
    await expect(createToolPackRegistry([mutable])).rejects.toThrow(/digest-pinned/i);

    const mismatched = await buildManifest(`node-tools@sha256:${"b".repeat(64)}`, "0".repeat(64));
    await expect(createToolPackRegistry([mismatched])).rejects.toThrow(ToolPackRegistryError);
  });

  it("rejects duplicate packs and loader-affecting environment keys", async () => {
    const executableDigest = await sha256File(process.execPath);
    const manifest = await buildManifest(`node-tools@sha256:${"c".repeat(64)}`, executableDigest);
    await expect(createToolPackRegistry([manifest, manifest])).rejects.toThrow(/duplicate/i);

    const unsafeBase = {
      ...manifest,
      tools: {
        echo_env: {
          ...manifest.tools.echo_env,
          envAllowlist: ["LD_PRELOAD"]
        }
      }
    };
    const { digest: _digest, ...unsigned } = unsafeBase;
    const unsafe = { ...unsafeBase, digest: createToolPackManifestDigest(unsigned) };
    await expect(createToolPackRegistry([unsafe])).rejects.toThrow(/environment/i);
  });
});
