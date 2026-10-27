import { initializeSelfHost } from "./selfhost-config.js";

async function main(): Promise<void> {
  const result = await initializeSelfHost(process.cwd(), {
    uid: typeof process.getuid === "function" ? process.getuid() : 1000,
    gid: typeof process.getgid === "function" ? process.getgid() : 1000
  });
  if (result.created.length === 0) {
    process.stdout.write("Self-host configuration already exists; nothing was overwritten.\n");
  } else {
    process.stdout.write(`Created ${result.created.join(", ")}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Self-host initialization failed."}\n`);
  process.exitCode = 1;
});
