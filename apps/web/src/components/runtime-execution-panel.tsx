"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CirclePause,
  CirclePlay,
  CircleStop,
  Clock3,
  FileCheck2,
  LoaderCircle,
  Send,
  TerminalSquare
} from "lucide-react";
import type { RuntimeRun, RuntimeRunEvent } from "@council/contracts";
import { apiRequest } from "../lib/api";

const stateLabels: Record<RuntimeRun["state"], string> = {
  queued: "等待中",
  provisioning: "建立環境",
  ready: "已就緒",
  running: "執行中",
  awaiting_approval: "等待核准",
  paused: "已暫停",
  completed: "已完成",
  failed: "失敗",
  cancelled: "已取消",
  expired: "已逾時"
};

const terminalStates = new Set<RuntimeRun["state"]>(["completed", "failed", "cancelled", "expired"]);

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function elapsedLabel(run: RuntimeRun, now: number): string {
  const start = Date.parse(run.startedAt ?? run.queuedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  return hours > 0 ? `${hours} 小時 ${minutes} 分` : minutes > 0 ? `${minutes} 分 ${remaining} 秒` : `${remaining} 秒`;
}

function runTone(run: RuntimeRun): "active" | "complete" | "warning" | "danger" | "neutral" {
  if (run.state === "completed") return "complete";
  if (run.state === "failed" || run.state === "cancelled" || run.state === "expired") return "danger";
  if (run.state === "paused" || run.state === "awaiting_approval") return "warning";
  if (run.state === "provisioning" || run.state === "ready" || run.state === "running") return "active";
  return "neutral";
}

export function RuntimeExecutionPanel({
  runtimeRun,
  compact = false,
  onUpdated
}: {
  runtimeRun: RuntimeRun;
  compact?: boolean;
  onUpdated?(runtimeRun: RuntimeRun): void;
}) {
  const [run, setRun] = useState(runtimeRun);
  const [events, setEvents] = useState<RuntimeRunEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => setRun(runtimeRun), [runtimeRun]);
  useEffect(() => {
    if (terminalStates.has(run.state) || run.state === "paused") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run.state]);

  const refreshEvents = useCallback(async (current: RuntimeRun) => {
    const afterSequence = Math.max(0, current.eventCursor - 100);
    const response = await apiRequest<{ events: RuntimeRunEvent[] }>(
      `/api/v1/runtime-runs/${current.id}/events?afterSequence=${afterSequence}&limit=100`
    );
    setEvents(response.events);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void refreshEvents(run).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "無法載入 Runtime 事件。");
    });
    return () => { cancelled = true; };
  }, [refreshEvents, run.id, run.eventCursor]);

  const latestEvent = events.at(-1) ?? null;
  const latestTool = useMemo(
    () => [...events].reverse().find((event) => event.toolName)?.toolName ?? null,
    [events]
  );

  async function control(action: "pause" | "resume" | "cancel" | "steer", message?: string) {
    setBusy(action);
    setError("");
    try {
      const updated = await apiRequest<RuntimeRun>(`/api/v1/runtime-runs/${run.id}/${action}`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: run.revision, ...(message ? { message } : {}) })
      });
      setRun(updated);
      if (action === "steer") setGuidance("");
      onUpdated?.(updated);
      await refreshEvents(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Runtime 操作失敗。");
    } finally {
      setBusy(null);
    }
  }

  function submitGuidance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = guidance.trim();
    if (message) void control("steer", message);
  }

  const isOmp = run.runtimeProfile.harnessKind === "pi";
  return <section className={`runtime-execution-panel ${runTone(run)} ${compact ? "compact" : ""}`} aria-label="OMP Runtime 執行狀態">
    <header>
      <div className="runtime-engine-heading">
        <TerminalSquare size={17} aria-hidden="true" />
        <div><span>執行引擎</span><strong>{isOmp ? "OMP (Pi-compatible)" : run.runtimeProfile.harnessKind}</strong></div>
      </div>
      <span className={`status-pill ${runTone(run)}`}>{stateLabels[run.state]}</span>
    </header>
    <dl className="runtime-execution-facts">
      <div><dt>階段</dt><dd>{latestEvent?.phase ?? run.state}</dd></div>
      <div><dt>目前工具</dt><dd>{latestTool ?? "尚無工具事件"}</dd></div>
      <div><dt>經過時間</dt><dd>{elapsedLabel(run, now)}</dd></div>
      <div><dt>Checkpoint</dt><dd>{run.eventCursor}</dd></div>
      <div><dt>Evidence</dt><dd>{run.evidenceIds.length}</dd></div>
      <div><dt>版本</dt><dd>{run.runtimeVersion ?? "未回報"}</dd></div>
    </dl>
    {latestEvent && <p className="runtime-latest-event"><Clock3 size={14} aria-hidden="true" /><span><strong>{latestEvent.summary}</strong><small>{formatTime(latestEvent.occurredAt)}</small></span></p>}
    {run.errorCode && <p className="runtime-error" role="alert">{run.errorCode}</p>}
    {isOmp && <div className="runtime-controls" aria-label="OMP Runtime 控制">
      {(["provisioning", "ready", "running", "awaiting_approval"] as RuntimeRun["state"][]).includes(run.state) && <button className="icon-button" type="button" disabled={busy !== null} onClick={() => void control("pause")} aria-label="暫停 OMP" title="暫停 OMP"><CirclePause size={16} /></button>}
      {run.state === "paused" && <button className="icon-button" type="button" disabled={busy !== null} onClick={() => void control("resume")} aria-label="恢復 OMP" title="恢復 OMP"><CirclePlay size={16} /></button>}
      {!terminalStates.has(run.state) && <button className="icon-button danger" type="button" disabled={busy !== null} onClick={() => void control("cancel")} aria-label="取消 OMP" title="取消 OMP"><CircleStop size={16} /></button>}
      {busy && <LoaderCircle size={15} className="spin-icon" aria-label="Runtime 操作中" />}
      {run.evidenceIds.length > 0 && <span className="runtime-evidence-count"><FileCheck2 size={14} aria-hidden="true" />{run.evidenceIds.length} 份</span>}
    </div>}
    {isOmp && run.state === "running" && <form className="runtime-steer-form" onSubmit={submitGuidance}>
      <label><span className="sr-only">導引 OMP</span><input value={guidance} maxLength={4_000} onChange={(event) => setGuidance(event.currentTarget.value)} placeholder="補充限制或導引目前執行" disabled={busy !== null} /></label>
      <button className="icon-button" type="submit" disabled={busy !== null || !guidance.trim()} aria-label="送出 OMP 導引" title="送出 OMP 導引"><Send size={15} /></button>
    </form>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
