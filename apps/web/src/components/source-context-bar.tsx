import Link from "next/link";
import { ArrowLeft, MessageSquareText, Sparkles } from "lucide-react";
import type { WorkspaceSourceContext } from "../lib/workspace-navigation";
import { buildGoalWorkspaceHref, buildMeetingWorkspaceHref } from "../lib/workspace-navigation";

export function SourceContextBar({
  source,
  label
}: {
  source: WorkspaceSourceContext;
  label: string;
}) {
  if (!source.goalId && !source.meetingId) return null;
  return <nav className="source-context-bar" aria-label="返回來源">
    <span>{label}</span>
    <div>
      {source.meetingId && <Link href={buildMeetingWorkspaceHref({
        meetingId: source.meetingId,
        threadId: source.threadId,
        fromGoalId: source.goalId,
        view: "meeting"
      })}><ArrowLeft size={14} aria-hidden="true" /><MessageSquareText size={14} aria-hidden="true" />回到來源會議</Link>}
      {source.goalId && <Link href={buildGoalWorkspaceHref({ goalId: source.goalId, view: "overview" })}>
        <ArrowLeft size={14} aria-hidden="true" /><Sparkles size={14} aria-hidden="true" />回到目標
      </Link>}
    </div>
  </nav>;
}
