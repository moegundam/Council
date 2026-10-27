import {
  CircleCheck,
  CircleEllipsis,
  CircleX,
  LoaderCircle,
  Play,
  RotateCcw,
  ShieldCheck
} from "lucide-react";
import type { PublicTask as Task, RuntimeRun } from "@council/contracts";
import type { TaskExecutionCommand, TaskExecutionUi } from "../lib/task-execution-ui";
import { RuntimeExecutionPanel } from "./runtime-execution-panel";

interface TaskExecutionBandProps {
  task: Task;
  executionUi: TaskExecutionUi;
  commandDisabledReason: string | null;
  disabled: boolean;
  commandBusy: boolean;
  runtimeRun?: RuntimeRun | null;
  onRuntimeUpdated?(runtimeRun: RuntimeRun): void;
  onCommand(command: Exclude<TaskExecutionCommand, null>): void;
}

function executionDetail(task: Task, executionUi: TaskExecutionUi): string {
  if (executionUi.active) return "執行設定已鎖定，完成後會自動更新。";
  if (executionUi.tone === "completed") return "結果已保存至證據，尚未經 Owner 驗證。";
  if (executionUi.tone === "failed") return "執行未完成，請檢查模型連線後重試。";
  if (task.executionProfile === "manual") return "由人員處理，不會呼叫 Agent。";
  return "依核准的 Runtime Profile 執行；工具、資料與外部寫入仍受 Execution Contract 限制。";
}

export function TaskExecutionBand({
  task,
  executionUi,
  commandDisabledReason,
  disabled,
  commandBusy,
  runtimeRun,
  onRuntimeUpdated,
  onCommand
}: TaskExecutionBandProps) {
  const ExecutionIcon = executionUi.tone === "completed"
    ? CircleCheck
    : executionUi.tone === "failed"
      ? CircleX
      : executionUi.tone === "queued" || executionUi.tone === "running"
        ? LoaderCircle
        : CircleEllipsis;
  const command = executionUi.command;
  const readinessDisabledReason = executionUi.readiness?.commandDisabledReason ?? null;
  const supplementalReason = commandDisabledReason && commandDisabledReason !== readinessDisabledReason
    ? commandDisabledReason
    : null;
  const detail = supplementalReason ?? (readinessDisabledReason ? null : executionDetail(task, executionUi));

  return <div className="task-execution-stack"><div
    className={`task-execution-band ${executionUi.tone}`}
    role={executionUi.tone === "failed" ? "alert" : "status"}
    aria-live={executionUi.tone === "failed" ? "assertive" : "polite"}
    aria-busy={executionUi.active || undefined}
  >
    <ExecutionIcon size={17} className={executionUi.active ? "spin-icon" : undefined} />
    <div className="task-execution-copy">
      <span>Agent 執行</span>
      <strong>{executionUi.statusLabel}</strong>
      {executionUi.readiness && <small>{executionUi.readiness.summary}</small>}
      {detail && <small>{detail}</small>}
    </div>
    {command && <button
      type="button"
      className="primary-button task-execution-action"
      disabled={disabled || Boolean(commandDisabledReason)}
      onClick={() => onCommand(command)}
    >
      {commandBusy
        ? <LoaderCircle size={14} className="spin-icon" />
        : command === "approve"
          ? <ShieldCheck size={14} />
          : command === "retry" || command === "rerun"
            ? <RotateCcw size={14} />
            : <Play size={14} />}
      {commandBusy ? command === "approve" ? "核准中" : "排程中" : executionUi.commandLabel}
    </button>}
  </div>{runtimeRun && <RuntimeExecutionPanel runtimeRun={runtimeRun} compact {...(onRuntimeUpdated ? { onUpdated: onRuntimeUpdated } : {})} />}</div>;
}
