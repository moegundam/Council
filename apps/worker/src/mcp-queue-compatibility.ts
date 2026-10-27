import { parseQueuedCouncilJob } from "./job-contract.js";
import type { JobType } from "bullmq";

export type McpQueueArgumentEncoding = "legacy_plaintext" | "vault_v1";

export interface QueuedJobRecord {
  name: string;
  data: unknown;
}

export interface McpQueueJobsReader {
  getJobs(
    types: JobType[],
    start: number,
    end: number,
    asc: boolean
  ): Promise<QueuedJobRecord[]>;
}

export const activeMcpQueueJobTypes: JobType[] = [
  "active",
  "delayed",
  "paused",
  "prioritized",
  "waiting",
  "waiting-children"
];

export function classifyQueuedMcpJob(job: QueuedJobRecord): McpQueueArgumentEncoding | null {
  if (job.name !== "mcp-tool-call") return null;
  const envelope = parseQueuedCouncilJob("mcp-tool-call", job.data);
  if (envelope.name !== "mcp-tool-call") throw new Error("MCP BullMQ job contract did not narrow to an MCP payload.");
  return "argumentEncoding" in envelope.data && envelope.data.argumentEncoding === "vault_v1"
    ? "vault_v1"
    : "legacy_plaintext";
}

export function queuedMcpJobMatches(
  job: QueuedJobRecord,
  requested: McpQueueArgumentEncoding | "any"
): boolean {
  const encoding = classifyQueuedMcpJob(job);
  return encoding !== null && (requested === "any" || encoding === requested);
}

export async function countQueuedMcpJobs(
  queue: McpQueueJobsReader,
  requested: McpQueueArgumentEncoding | "any",
  pageSize = 100
): Promise<number> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("MCP queue inspection page size must be positive.");

  let matched = 0;
  for (const jobType of activeMcpQueueJobTypes) {
    let start = 0;
    for (;;) {
      // BullMQ applies ranges independently to each requested status, so each
      // status must be paged separately to avoid skipping jobs.
      const jobs = await queue.getJobs([jobType], start, start + pageSize - 1, true);
      for (const job of jobs) {
        if (queuedMcpJobMatches(job, requested)) matched += 1;
      }
      if (jobs.length < pageSize) break;
      start += pageSize;
    }
  }
  return matched;
}
