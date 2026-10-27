import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const store = join(root, "node_modules", ".pnpm");
const packages = new Map();

async function collectPackageJson(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scopeOrPackage = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      await collectPackageJson(scopeOrPackage);
      continue;
    }
    const file = join(scopeOrPackage, "package.json");
    try {
      const raw = await readFile(file, "utf8");
      const metadata = JSON.parse(raw);
      if (!metadata.name || !metadata.version) continue;
      const key = `${metadata.name}@${metadata.version}`;
      packages.set(key, {
        SPDXID: `SPDXRef-Package-${createHash("sha256").update(key).digest("hex").slice(0, 20)}`,
        name: metadata.name,
        versionInfo: metadata.version,
        downloadLocation: `https://registry.npmjs.org/${encodeURIComponent(metadata.name)}/-/${metadata.name.split("/").at(-1)}-${metadata.version}.tgz`,
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: typeof metadata.license === "string" ? metadata.license : "NOASSERTION",
        copyrightText: "NOASSERTION",
        externalRefs: [{
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/${encodeURIComponent(metadata.name)}@${metadata.version}`
        }]
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

for (const entry of await readdir(store, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const modules = join(store, entry.name, "node_modules");
  try { await collectPackageJson(modules); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "council-source-dependencies",
  documentNamespace: `https://council.example.invalid/spdx/${createHash("sha256").update([...packages.keys()].sort().join("\n")).digest("hex")}`,
  creationInfo: { creators: ["Tool: council-generate-source-sbom"], created: new Date(0).toISOString().replace(".000Z", "Z") },
  packages: [...packages.values()].sort((a, b) => `${a.name}@${a.versionInfo}`.localeCompare(`${b.name}@${b.versionInfo}`))
};
const output = join(root, "sbom", "source-dependencies.spdx.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`Wrote ${document.packages.length} packages to ${output}\n`);
