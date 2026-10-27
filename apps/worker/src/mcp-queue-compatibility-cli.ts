import { Queue } from "bullmq";
import { countQueuedMcpJobs, type McpQueueArgumentEncoding } from "./mcp-queue-compatibility.js";
const requested = process.argv[2] as McpQueueArgumentEncoding | "any" | undefined;

if (requested !== "legacy_plaintext" && requested !== "vault_v1" && requested !== "any") {
  throw new Error("Usage: node mcp-queue-compatibility-cli.js legacy_plaintext|vault_v1|any");
}

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://redis:6379");
const queue = new Queue("council-background-jobs", {
  connection: {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
    ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
    ...(redisUrl.protocol === "rediss:" ? { tls: {} } : {})
  }
});

try {
  const matched = await countQueuedMcpJobs(queue, requested);
  process.stdout.write(`${JSON.stringify({ requested, matched })}\n`);
  process.exitCode = matched > 0 ? 0 : 10;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  await queue.close();
}
