import type { DiscussionThread, Meeting } from "@council/contracts";
import { compactTags, threadStatusLabel, type ThreadTaxonomy } from "../lib/view-model";

interface TopicContextHeaderProps {
  thread: DiscussionThread;
  meeting: Meeting | undefined;
  taxonomy: ThreadTaxonomy | null;
}

export function TopicContextHeader({ thread, meeting, taxonomy }: TopicContextHeaderProps) {
  const tagSummary = taxonomy ? compactTags(taxonomy.tags, 3) : null;
  return <div className="meeting-title-block">
    <div className="meeting-taxonomy">
      <span className="eyebrow">{threadStatusLabel(thread.status)}</span>
      {taxonomy && <>
        <span className="taxonomy-path">{taxonomy.breadcrumb}</span>
        {tagSummary?.visible.map((tag) => <span key={tag.id} className={`taxonomy-tag ${tag.color}`}>{tag.name}</span>)}
        {tagSummary && tagSummary.hidden.length > 0 && <details className="taxonomy-more">
          <summary aria-label={`${tagSummary.hidden.length} 個其他標籤`}>+{tagSummary.hidden.length}</summary>
          <div className="taxonomy-more-list">{tagSummary.hidden.map((tag) => <span key={tag.id} className={`taxonomy-tag ${tag.color}`}>{tag.name}</span>)}</div>
        </details>}
      </>}
    </div>
    <h1>{thread.title}</h1>
    <p>{thread.summary || meeting?.goal || "—"}</p>
  </div>;
}
