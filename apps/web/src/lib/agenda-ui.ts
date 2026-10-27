import type { AgendaItem, Meeting, MeetingAgenda } from "@council/contracts";

export interface AgendaDraftItem {
  id?: string;
  title: string;
  description: string;
}

export interface AgendaProgress {
  resolved: number;
  total: number;
  current: AgendaItem | null;
  pending: number;
}

export type AgendaPrimaryCommand = { action: "activate" } | { action: "complete"; itemId: string };

export function agendaDraftFromAgenda(agenda: MeetingAgenda): AgendaDraftItem[] {
  return agenda.items.map(({ id, title, description }) => ({ id, title, description }));
}

export function agendaDraftRevisionMatches(baseRevision: number | null, agenda: Pick<MeetingAgenda, "revision">): boolean {
  return baseRevision !== null && baseRevision === agenda.revision;
}

export function canSubmitAgendaDraft(items: readonly AgendaDraftItem[]): boolean {
  if (items.length < 1 || items.length > 12) return false;
  const titles = items.map((item) => item.title.normalize("NFKC").trim().toLocaleLowerCase());
  return items.every((item) => item.title.normalize("NFKC").trim().length > 0)
    && new Set(titles).size === titles.length;
}

export function updateAgendaDraftItem(
  items: readonly AgendaDraftItem[],
  id: string,
  patch: Partial<Pick<AgendaDraftItem, "title" | "description">>
): AgendaDraftItem[] {
  return items.map((item) => item.id === id ? { ...item, ...patch } : { ...item });
}

export function moveAgendaDraftItem(items: readonly AgendaDraftItem[], index: number, delta: -1 | 1): AgendaDraftItem[] {
  const target = index + delta;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items.map((item) => ({ ...item }));
  const next = items.map((item) => ({ ...item }));
  const [moved] = next.splice(index, 1);
  if (!moved) return next;
  next.splice(target, 0, moved);
  return next;
}

export function agendaProgress(agenda: MeetingAgenda): AgendaProgress {
  const resolved = agenda.items.filter((item) => item.status === "completed" || item.status === "skipped").length;
  return {
    resolved,
    total: agenda.items.length,
    current: agenda.items.find((item) => item.status === "current") ?? null,
    pending: agenda.items.filter((item) => item.status === "pending").length
  };
}

export function canEditAgendaItem(meeting: Pick<Meeting, "state">, item: Pick<AgendaItem, "status">): boolean {
  if (meeting.state === "closed") return false;
  return meeting.state === "draft" || item.status === "pending";
}

export function canRemoveAgendaItem(meeting: Pick<Meeting, "state">, item: Pick<AgendaItem, "status">): boolean {
  return canEditAgendaItem(meeting, item);
}

export function agendaPrimaryCommand(meeting: Pick<Meeting, "state"> & { agenda: MeetingAgenda }): AgendaPrimaryCommand | null {
  if (meeting.state !== "active") return null;
  const progress = agendaProgress(meeting.agenda);
  if (progress.current) return { action: "complete", itemId: progress.current.id };
  return progress.pending > 0 ? { action: "activate" } : null;
}
