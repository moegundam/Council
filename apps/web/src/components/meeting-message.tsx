import type { Utterance } from "@council/contracts";
import { toolOutputView } from "../lib/view-model";

function initials(value: string): string {
  return value.split(/[-\s]/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase();
}

export function MeetingMessage({ item }: { item: Utterance }) {
  const toolOutput = item.speakerType === "tool" ? toolOutputView(item.content) : null;
  return <article className={`message message-${item.kind}`}>
    <div className="participant-avatar">{initials(item.speakerName)}</div>
    <div>
      <header><strong>{item.speakerName}</strong><span>{item.roleName ?? item.speakerType}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })}</time></header>
      {toolOutput
        ? <div className="tool-output-summary"><strong>{toolOutput.summary}</strong><span>詳細結果已收錄於會議證據</span></div>
        : <p>{item.content}</p>}
      {item.evidenceCount > 0 && <span className="evidence-chip">{item.evidenceCount} 份{item.speakerType === "tool" ? " Tool Run" : "驗證"}證據</span>}
    </div>
  </article>;
}
