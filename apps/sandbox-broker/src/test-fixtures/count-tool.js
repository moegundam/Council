import { appendFile } from "node:fs/promises";

await appendFile("counter.log", "run\n", "utf8");
await new Promise((resolve) => setTimeout(resolve, 75));
process.stdout.write("counted\n");
