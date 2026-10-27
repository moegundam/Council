import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const manifestPath = "provenance/public-file-manifest.sha256";
const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "buffer" }
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr);
  process.exit(listed.status ?? 1);
}

const paths = listed.stdout
  .toString("utf8")
  .split("\0")
  .filter((path) => path && path !== manifestPath)
  .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

const lines = [];
for (const path of paths) {
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  lines.push(`${digest}  ${path}`);
}
await writeFile(manifestPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${lines.length} file digests to ${manifestPath}`);
