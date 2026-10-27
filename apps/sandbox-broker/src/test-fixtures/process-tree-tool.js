import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const child = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
], { stdio: "ignore" });
await writeFile("descendant.pid", String(child.pid), "utf8");
process.stdout.write("tree-ready\n");
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1_000);
