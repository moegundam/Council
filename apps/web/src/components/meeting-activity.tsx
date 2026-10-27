import { AlertCircle, CheckCircle2, Circle, Clock3, Link2, PauseCircle } from "lucide-react";
import type { ActivityItem } from "../lib/meeting-experience";

const statusIcons = {
  alert: AlertCircle,
  check: CheckCircle2,
  circle: Circle,
  clock: Clock3,
  link: Link2,
  pause: PauseCircle
};

export function MeetingActivity({ items }: { items: readonly ActivityItem[] }) {
  return <section className="meeting-activity" aria-labelledby="meeting-activity-title">
    <header><div><span className="eyebrow">Activity</span><h2 id="meeting-activity-title">會議動態</h2></div><span>{items.length} 筆</span></header>
    <ol className="activity-list">
      {items.map((item) => {
        const Icon = statusIcons[item.status.icon];
        return <li key={item.id} className={`activity-item ${item.status.tone}`}>
          <Icon size={17} aria-hidden="true" />
          <div><div className="activity-item-heading"><strong>{item.title}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-TW", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}</time></div><p>{item.detail}</p><span>{item.status.label}</span></div>
        </li>;
      })}
    </ol>
  </section>;
}
