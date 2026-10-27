import { writeFileSync } from "node:fs";

process.stdout.write("sleeping\n");
const interval = setInterval(() => {
  process.stdout.write("tick\n");
}, 25);

process.on("SIGTERM", () => {
  process.stdout.write("sigterm\n");
  setTimeout(() => undefined, 10_000);
});
writeFileSync("sleep.ready", "ready", "utf8");
