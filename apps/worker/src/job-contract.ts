import {
  parseCouncilJobEnvelope,
  type CouncilJobData,
  type CouncilJobEnvelope,
  type CouncilJobName
} from "@council/contracts";

function looksLikeVersionedEnvelope(value: unknown): boolean {
  return Boolean(value
    && typeof value === "object"
    && ("contractVersion" in value || "name" in value || "data" in value));
}

export function parseQueuedCouncilJob(
  bullmqName: CouncilJobName,
  payload: CouncilJobEnvelope | CouncilJobData | unknown
): CouncilJobEnvelope {
  const envelope = parseCouncilJobEnvelope(looksLikeVersionedEnvelope(payload)
    ? payload
    : { contractVersion: 1, name: bullmqName, data: payload });
  if (envelope.name !== bullmqName) {
    throw new Error(`BullMQ job name ${bullmqName} does not match embedded contract ${envelope.name}.`);
  }
  return envelope;
}
