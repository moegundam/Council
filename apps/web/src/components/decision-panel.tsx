import type { Decision, PublicTask as Task } from "@council/contracts";
import { Check, ListChecks, Plus, X } from "lucide-react";
import { Empty } from "./ui";

type DecisionAction = "approve" | "reject";

interface DecisionPanelProps {
  goal: string;
  decisions: readonly Decision[];
  tasks: readonly Task[];
  busy: boolean;
  onCreateDecision: () => void;
  onDecisionAction: (decision: Decision, action: DecisionAction) => Promise<void>;
  onCreateTask: (decision: Decision) => void;
  onInspectTask: (task: Task) => void;
}

export function DecisionPanel({
  goal,
  decisions,
  tasks,
  busy,
  onCreateDecision,
  onDecisionAction,
  onCreateTask,
  onInspectTask
}: DecisionPanelProps) {
  return (
    <aside id="meeting-decisions" className="decision-panel" tabIndex={-1}>
      <header><div><span className="eyebrow">目前目標</span><strong>{goal}</strong></div><button className="icon-button" disabled={busy} onClick={onCreateDecision} aria-label="新增決議"><Plus size={15} /></button></header>
      <div className="decision-list">
        {decisions.length === 0 && <Empty>尚無決議</Empty>}
        {decisions.map((decision) => {
          const task = tasks.find((item) => item.decisionId === decision.id);
          return <article key={decision.id} className={`decision-item ${decision.status}`}>
            <span className="decision-status">{decision.status === "proposed" ? "待核准" : decision.status === "approved" ? "已核准" : "已拒絕"}</span>
            <h2>{decision.title}</h2><p>{decision.description}</p>
            {decision.status === "proposed" && <div className="inline-actions"><button className="primary-button small" disabled={busy} onClick={() => void onDecisionAction(decision, "approve")}><Check size={13} />核准</button><button className="secondary-button small" disabled={busy} onClick={() => void onDecisionAction(decision, "reject")}><X size={13} />拒絕</button></div>}
            {decision.status === "approved" && !task && <button className="secondary-button small" disabled={busy} onClick={() => onCreateTask(decision)}><Plus size={13} />建立任務</button>}
            {decision.status === "approved" && task && <button className="secondary-button small" type="button" onClick={() => onInspectTask(task)}><ListChecks size={13} />查看任務</button>}
          </article>;
        })}
      </div>
    </aside>
  );
}
