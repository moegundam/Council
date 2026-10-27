"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, FileCheck2, FileText, ListChecks, ListTodo, Quote, RefreshCw, StickyNote, Users } from "lucide-react";
import type { Meeting, MeetingRecord, MeetingRecordSourceReference, Utterance } from "@council/contracts";
import { ApiError, apiRequest } from "../lib/api";
import { meetingRecordPreview } from "./meeting-record-ui";

type RecordTab = "summary" | "transcript" | "evidence";

interface TranscriptPage {
  items: Utterance[];
  nextCursor: string | null;
}

const sourceLabels: Record<MeetingRecordSourceReference["kind"], string> = {
  utterance: "發言",
  agenda: "議程",
  decision: "決議",
  task: "任務",
  tool_run: "工具",
  chair_suggestion: "主席介入",
  goal: "目標"
};

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Taipei"
  }).format(new Date(value));
}

function Sources({ items }: { items: MeetingRecordSourceReference[] }) {
  return <span className="record-sources" aria-label="紀錄來源">
    {items.map((item) => <span key={`${item.kind}:${item.id}`} title={item.id}>{sourceLabels[item.kind]}</span>)}
  </span>;
}

export function MeetingRecordView({ meeting, topicSummary = "" }: { meeting: Meeting; topicSummary?: string }) {
  const [tab, setTab] = useState<RecordTab>("summary");
  const [record, setRecord] = useState<MeetingRecord | null>(null);
  const [recordState, setRecordState] = useState<"loading" | "ready" | "not_ready" | "error">("loading");
  const [recordError, setRecordError] = useState("");
  const [recordReload, setRecordReload] = useState(0);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [transcriptCursor, setTranscriptCursor] = useState<string | null>(null);
  const [transcriptLoaded, setTranscriptLoaded] = useState(false);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState("");

  useEffect(() => {
    setTab("summary");
    setRecord(null);
    setRecordState("loading");
    setRecordError("");
    setUtterances([]);
    setTranscriptCursor(null);
    setTranscriptLoaded(false);
    setTranscriptError("");
  }, [meeting.id]);

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: number | undefined;
    setRecordState("loading");
    setRecordError("");
    void apiRequest<MeetingRecord>(`/api/v1/meetings/${meeting.id}/record`, { signal: controller.signal })
      .then((next) => {
        setRecord(next);
        setRecordState("ready");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.code === "MEETING_RECORD_NOT_READY") {
          setRecordState("not_ready");
          if (meeting.summaryState === "pending" || meeting.summaryState === "queued") {
            retryTimer = window.setTimeout(() => setRecordReload((current) => current + 1), 2_000);
          }
          return;
        }
        setRecordState("error");
        setRecordError(cause instanceof Error ? cause.message : "無法讀取會議紀錄。");
      });
    return () => {
      controller.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [meeting.id, meeting.summaryState, recordReload]);

  const loadTranscript = useCallback(async (cursor: string | null) => {
    if (transcriptLoading) return;
    setTranscriptLoading(true);
    setTranscriptError("");
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const page = await apiRequest<TranscriptPage>(`/api/v1/meetings/${meeting.id}/utterances?${query}`);
      setUtterances((current) => cursor
        ? [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]
        : page.items);
      setTranscriptCursor(page.nextCursor);
      setTranscriptLoaded(true);
    } catch (cause) {
      setTranscriptError(cause instanceof Error ? cause.message : "無法讀取逐字稿。");
    } finally {
      setTranscriptLoading(false);
    }
  }, [meeting.id, transcriptLoading]);

  useEffect(() => {
    if (tab === "transcript" && !transcriptLoaded && !transcriptLoading) void loadTranscript(null);
  }, [loadTranscript, tab, transcriptLoaded, transcriptLoading]);

  const preview = record ? meetingRecordPreview(record) : null;
  const normalizedTopicSummary = topicSummary.trim();

  return <section className="meeting-record-view" aria-label="已封存會議">
    <div className="record-tabs" role="tablist" aria-label="封存內容">
      <button type="button" role="tab" aria-selected={tab === "summary"} className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}><FileText size={15} />摘要</button>
      <button type="button" role="tab" aria-selected={tab === "transcript"} className={tab === "transcript" ? "active" : ""} onClick={() => setTab("transcript")}><Quote size={15} />逐字稿</button>
      <button type="button" role="tab" aria-selected={tab === "evidence"} className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}><FileCheck2 size={15} />證據</button>
    </div>

    {tab === "summary" && <div role="tabpanel" className="record-panel">
      {recordState === "loading" && <div className="record-state" role="status"><RefreshCw className="spin-icon" size={16} />正在整理會議紀錄</div>}
      {recordState === "not_ready" && <div className="record-state" role="status"><span>{meeting.summaryState === "failed" ? "紀錄產生失敗，可使用上方的重試摘要。" : "會議已封存，紀錄仍在產生中。"}</span><button type="button" className="secondary-button small" onClick={() => setRecordReload((current) => current + 1)}><RefreshCw size={14} />重新檢查</button></div>}
      {recordState === "error" && <div className="record-state error" role="alert"><span>{recordError}</span><button type="button" className="secondary-button small" onClick={() => setRecordReload((current) => current + 1)}><RefreshCw size={14} />重試</button></div>}
      {record && preview && <div aria-label="封存摘要">
        <header className="record-summary">
          <div><span className={`record-outcome ${record.content.outcome.status}`}>{record.content.outcome.status === "completed" ? "已收斂" : record.content.outcome.status === "partial" ? "部分收斂" : "未形成結論"}</span><span>Rev {record.revision} · {formatDateTime(record.closedAt)}</span></div>
          <h2>{record.content.outcome.summary}</h2>
          <p><strong>會議目標</strong><span>{record.content.meeting.goal}</span></p>
          {normalizedTopicSummary && <p className="record-topic-note"><StickyNote size={14} aria-hidden="true" /><span><strong>話題備註</strong>{normalizedTopicSummary}</span></p>}
        </header>

        <dl className="record-preview-facts" aria-label="封存內容統計">
          <div><dt>共識</dt><dd>{preview.counts.consensus}</dd></div>
          <div><dt>決議</dt><dd>{preview.counts.decisions}</dd></div>
          <div><dt>任務</dt><dd>{preview.counts.tasks}</dd></div>
          <div><dt>證據</dt><dd>{preview.counts.evidence}</dd></div>
        </dl>

        <div className="record-preview-grid">
          <section aria-labelledby="record-preview-points">
            <h3 id="record-preview-points"><ListChecks size={15} />快速重點</h3>
            {preview.points.length ? <ul>{preview.points.map((item, index) => <li key={index}>{item.text}<Sources items={item.sourceReferences} /></li>)}</ul> : <p className="record-empty">本場沒有額外摘要重點。</p>}
          </section>
          <section aria-labelledby="record-preview-notes">
            <h3 id="record-preview-notes"><StickyNote size={15} />備註與未決</h3>
            {preview.notes.length ? <ul>{preview.notes.map((item, index) => <li key={index}>{item.text}<Sources items={item.sourceReferences} /></li>)}</ul> : <p className="record-empty">沒有保留備註或待確認事項。</p>}
          </section>
        </div>

        <details className="record-full-details">
          <summary><span><FileText size={15} />完整紀錄</span><small>共識、異議、決議、任務與會議角色</small><ChevronDown size={15} aria-hidden="true" /></summary>
          <div className="record-full-content">
            <div className="record-section-grid">
              <section><h3><Quote size={15} />共識</h3>{record.content.consensus.length ? <ul>{record.content.consensus.map((item, index) => <li key={index}>{item.text}<Sources items={item.sourceReferences} /></li>)}</ul> : <p className="record-empty">沒有已核准共識。</p>}</section>
              <section><h3><Quote size={15} />異議與未決</h3>{record.content.dissent.length + record.content.openItems.length ? <ul>{[...record.content.dissent, ...record.content.openItems].map((item, index) => <li key={index}>{item.text}<Sources items={item.sourceReferences} /></li>)}</ul> : <p className="record-empty">沒有保留中的異議或待確認事項。</p>}</section>
            </div>

            <section className="record-table-section"><h3><FileCheck2 size={15} />決議</h3>{record.content.decisions.length ? <div className="record-rows">{record.content.decisions.map((decision) => <div key={decision.decisionId}><span className={`record-row-status ${decision.status}`}>{decision.status === "approved" ? "核准" : decision.status === "rejected" ? "拒絕" : "提案"}</span><span><strong>{decision.title}</strong><small>{decision.description}</small></span><Sources items={decision.sourceReferences} /></div>)}</div> : <p className="record-empty">本場沒有決議。</p>}</section>
            <section className="record-table-section"><h3><ListTodo size={15} />任務</h3>{record.content.tasks.length ? <div className="record-rows">{record.content.tasks.map((task) => <div key={task.taskId}><span className={`record-row-status ${task.status}`}>{task.status}</span><span><strong>{task.title}</strong><small>{task.assigneeAgentId ? `Agent ${task.assigneeAgentId.slice(0, 8)}` : "尚未指派 Agent"}</small></span><Sources items={task.sourceReferences} /></div>)}</div> : <p className="record-empty">本場沒有衍生任務。</p>}</section>
            <section className="record-table-section"><h3><Users size={15} />與會角色</h3><div className="record-participants">{record.content.participants.map((participant) => <span key={participant.participantId}>{participant.isChair ? "主席 · " : ""}Agent Rev {participant.agentRevision ?? "-"} / Role Rev {participant.roleRevision}</span>)}</div></section>
          </div>
        </details>
      </div>}
    </div>}

    {tab === "transcript" && <div role="tabpanel" className="record-transcript">
      {utterances.map((utterance) => <article key={utterance.id}>
        <header><strong>{utterance.speakerName}</strong><span>{utterance.roleName ?? "系統"}{utterance.agentRevision ? ` · Agent Rev ${utterance.agentRevision}` : ""}{utterance.roleRevision ? ` · Role Rev ${utterance.roleRevision}` : ""}</span><time dateTime={utterance.createdAt}>{formatDateTime(utterance.createdAt)}</time></header>
        <p>{utterance.content}</p>
      </article>)}
      {transcriptLoaded && utterances.length === 0 && <p className="record-empty">本場沒有逐字稿。</p>}
      {transcriptError && <div className="record-state error" role="alert">{transcriptError}</div>}
      {(transcriptLoading || transcriptCursor) && <button type="button" className="secondary-button record-load-more" disabled={transcriptLoading} onClick={() => void loadTranscript(transcriptCursor)}>{transcriptLoading ? <RefreshCw className="spin-icon" size={14} /> : <ChevronDown size={14} />}{transcriptLoading ? "載入中" : "載入更多"}</button>}
    </div>}

    {tab === "evidence" && <div role="tabpanel" className="record-evidence">
      {recordState !== "ready" && <div className="record-state" role="status">紀錄完成後會顯示正式證據索引。</div>}
      {record?.content.evidenceReferences.length ? <div className="record-rows">{record.content.evidenceReferences.map((evidence) => <div key={evidence.evidenceId}><FileCheck2 size={15} /><span><strong>{evidence.label}</strong><small>{evidence.reference}</small></span><Sources items={evidence.sourceReferences} /></div>)}</div> : recordState === "ready" && <p className="record-empty">本場沒有連結證據。</p>}
    </div>}
  </section>;
}
