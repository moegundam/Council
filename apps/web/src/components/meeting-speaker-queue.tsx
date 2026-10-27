"use client";

import { CircleDot, LoaderCircle, PlayCircle } from "lucide-react";
import type { PublicSpeakerQueueItem as SpeakerQueueItem } from "@council/contracts";
import { speakerQueueStatusLabel, type EligibleSpeaker } from "../lib/speaker-queue-ui";

export function MeetingSpeakerQueue({
  items,
  eligibleSpeakers,
  agentNameById
}: {
  items: readonly SpeakerQueueItem[];
  eligibleSpeakers: readonly EligibleSpeaker[];
  agentNameById: ReadonlyMap<string, string>;
}) {
  const liveSummary = items.length > 0
    ? `${agentNameById.get(items[0]!.agentId) ?? "Agent"} ${speakerQueueStatusLabel(items[0]!.status, items[0]!.kind)}`
    : "Agent 執行佇列目前閒置";
  return <section className="speaker-queue" aria-label="Agent 執行佇列">
    <span className="sr-only" aria-live="polite">{liveSummary}</span>
    <div className="speaker-queue-heading">
      <div><span className="speaker-queue-label">Agent 執行</span><strong>{items.length > 0 ? `${items.length} 個工作` : "目前閒置"}</strong></div>
      {items.length > 0 && <span className="speaker-queue-state">已保存</span>}
    </div>
    {items.length > 0
      ? <ul className="speaker-queue-list">{items.map((item) => <li key={item.id} className={item.status}>
        {item.status === "running" ? <LoaderCircle className="spin-icon" size={14} aria-hidden="true" /> : <CircleDot size={14} aria-hidden="true" />}
        <span><strong>{agentNameById.get(item.agentId) ?? "Agent"} · {item.label}</strong><small>{speakerQueueStatusLabel(item.status, item.kind)} · {item.roleName} v{item.roleVersion}</small></span>
      </li>)}</ul>
      : eligibleSpeakers.length > 0
        ? <div className="speaker-queue-idle"><PlayCircle size={14} aria-hidden="true" /><span><strong>可發言</strong>{eligibleSpeakers.map((speaker) => `${speaker.agentName} · ${speaker.roleName}`).join("、")}</span></div>
        : <div className="speaker-queue-idle muted"><CircleDot size={14} aria-hidden="true" /><span>目前沒有可執行的 Agent</span></div>}
  </section>;
}
