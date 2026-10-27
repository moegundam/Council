import type { AgendaItem, DiscussionThread, MeetingAgenda, ThreadStatus } from "@council/contracts";
import type { AgendaDraftItem } from "./agenda-ui";

export interface TopicDraftFields {
  categoryId: string;
  title: string;
  summary: string;
  status: ThreadStatus;
  tagIds: string[];
}

export interface TopicDraftBase {
  threadId: string;
  revision: number;
  fields: TopicDraftFields;
}

type TopicDraftField = keyof TopicDraftFields;

export type TopicConflictRecovery =
  | { kind: "rebased"; draft: TopicDraftFields }
  | { kind: "conflict"; fields: TopicDraftField[] };

export type AgendaConflictRecovery =
  | { kind: "rebased"; draft: AgendaDraftItem[] }
  | { kind: "conflict"; conflicts: string[] };

const topicDraftFields: TopicDraftField[] = ["categoryId", "title", "summary", "status", "tagIds"];

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function topicFieldMatches(field: TopicDraftField, left: TopicDraftFields[TopicDraftField], right: TopicDraftFields[TopicDraftField]): boolean {
  if (field === "tagIds") {
    return JSON.stringify(sortedUnique(left as string[])) === JSON.stringify(sortedUnique(right as string[]));
  }
  return left === right;
}

function cloneTopicFields(fields: TopicDraftFields): TopicDraftFields {
  return { ...fields, tagIds: [...fields.tagIds] };
}

export function topicDraftFieldsFromThread(thread: DiscussionThread): TopicDraftFields {
  return {
    categoryId: thread.categoryId,
    title: thread.title,
    summary: thread.summary ?? "",
    status: thread.status,
    tagIds: [...thread.tagIds]
  };
}

export function topicDraftBaseFromThread(thread: DiscussionThread): TopicDraftBase {
  return {
    threadId: thread.id,
    revision: thread.revision,
    fields: topicDraftFieldsFromThread(thread)
  };
}

export function topicDraftHasChanges(base: TopicDraftBase, draft: TopicDraftFields): boolean {
  return topicDraftFields.some((field) => !topicFieldMatches(field, base.fields[field], draft[field]));
}

export function topicConflictRecovery(
  base: TopicDraftBase,
  local: TopicDraftFields,
  latest: DiscussionThread
): TopicConflictRecovery {
  if (base.threadId !== latest.id) return { kind: "conflict", fields: [...topicDraftFields] };
  const authoritative = topicDraftFieldsFromThread(latest);
  const conflicts = topicDraftFields.filter((field) => {
    const localChanged = !topicFieldMatches(field, base.fields[field], local[field]);
    const authoritativeChanged = !topicFieldMatches(field, base.fields[field], authoritative[field]);
    return localChanged && authoritativeChanged && !topicFieldMatches(field, local[field], authoritative[field]);
  });
  if (conflicts.length > 0) return { kind: "conflict", fields: conflicts };

  const draft = cloneTopicFields(authoritative);
  for (const field of topicDraftFields) {
    if (!topicFieldMatches(field, base.fields[field], local[field])) {
      if (field === "tagIds") draft.tagIds = [...local.tagIds];
      else if (field === "status") draft.status = local.status;
      else draft[field] = local[field];
    }
  }
  return { kind: "rebased", draft };
}

function agendaDraftItem(item: Pick<AgendaItem, "id" | "title" | "description">): AgendaDraftItem {
  return { id: item.id, title: item.title, description: item.description };
}

function agendaDraftSignature(items: readonly AgendaDraftItem[]): string {
  return JSON.stringify(items.map((item) => ({ id: item.id ?? null, title: item.title, description: item.description })));
}

function agendaIds(items: readonly { id?: string }[]): Array<string | null> {
  return items.map((item) => item.id ?? null);
}

function sameIds(left: readonly { id?: string }[], right: readonly { id?: string }[]): boolean {
  return JSON.stringify(agendaIds(left)) === JSON.stringify(agendaIds(right));
}

function addConflict(conflicts: string[], conflict: string): void {
  if (!conflicts.includes(conflict)) conflicts.push(conflict);
}

export function agendaDraftHasChanges(base: MeetingAgenda, local: readonly AgendaDraftItem[]): boolean {
  return agendaDraftSignature(base.items.map(agendaDraftItem)) !== agendaDraftSignature(local);
}

export function agendaConflictRecovery(
  base: MeetingAgenda,
  local: readonly AgendaDraftItem[],
  latest: MeetingAgenda
): AgendaConflictRecovery {
  const conflicts: string[] = [];
  const baseById = new Map(base.items.map((item) => [item.id, item]));
  const localById = new Map(local.flatMap((item) => item.id ? [[item.id, item] as const] : []));
  const latestById = new Map(latest.items.map((item) => [item.id, item]));
  const localIds = local.flatMap((item) => item.id ? [item.id] : []);

  if (new Set(localIds).size !== localIds.length || localIds.some((id) => !baseById.has(id))) {
    addConflict(conflicts, "agenda:structure");
  }

  for (const baseItem of base.items) {
    const localItem = localById.get(baseItem.id);
    const latestItem = latestById.get(baseItem.id);
    const localRemoved = !localItem;
    const latestRemoved = !latestItem;
    const localTitleChanged = Boolean(localItem && localItem.title !== baseItem.title);
    const localDescriptionChanged = Boolean(localItem && localItem.description !== baseItem.description);
    const latestTitleChanged = Boolean(latestItem && latestItem.title !== baseItem.title);
    const latestDescriptionChanged = Boolean(latestItem && latestItem.description !== baseItem.description);
    const latestStatusChanged = Boolean(latestItem && latestItem.status !== baseItem.status);
    const localContentChanged = localTitleChanged || localDescriptionChanged;

    if ((localRemoved || localContentChanged) && baseItem.status !== "pending") {
      addConflict(conflicts, `${baseItem.id}:status`);
    }
    if ((localRemoved || localContentChanged) && latestItem && latestStatusChanged && latestItem.status !== "pending") {
      addConflict(conflicts, `${baseItem.id}:status`);
    }
    if (localRemoved && latestItem && (latestTitleChanged || latestDescriptionChanged || latestStatusChanged)) {
      addConflict(conflicts, `${baseItem.id}:item`);
    }
    if (latestRemoved && localContentChanged) {
      addConflict(conflicts, `${baseItem.id}:item`);
    }
    if (localItem && latestItem) {
      if (localTitleChanged && latestTitleChanged && localItem.title !== latestItem.title) {
        addConflict(conflicts, `${baseItem.id}:title`);
      }
      if (localDescriptionChanged && latestDescriptionChanged && localItem.description !== latestItem.description) {
        addConflict(conflicts, `${baseItem.id}:description`);
      }
    }
  }

  const localStructureChanged = !sameIds(base.items, local);
  const latestStructureChanged = !sameIds(base.items, latest.items);
  if (localStructureChanged && latestStructureChanged) addConflict(conflicts, "agenda:structure");
  if (conflicts.length > 0) return { kind: "conflict", conflicts };

  const structuralSource: readonly AgendaDraftItem[] = localStructureChanged
    ? local
    : latest.items.map(agendaDraftItem);
  const draft = structuralSource.flatMap((sourceItem): AgendaDraftItem[] => {
    if (!sourceItem.id) return [{ title: sourceItem.title, description: sourceItem.description }];
    const baseItem = baseById.get(sourceItem.id);
    const localItem = localById.get(sourceItem.id);
    const latestItem = latestById.get(sourceItem.id);
    if (!baseItem) return latestItem ? [agendaDraftItem(latestItem)] : [];
    if (!latestItem || !localItem) return [];
    return [{
      id: sourceItem.id,
      title: localItem.title !== baseItem.title ? localItem.title : latestItem.title,
      description: localItem.description !== baseItem.description ? localItem.description : latestItem.description
    }];
  });

  const lockedItems = latest.items.filter((item) => item.status !== "pending");
  const lockedPrefixMatches = lockedItems.every((item, index) => {
    const candidate = draft[index];
    return candidate?.id === item.id
      && candidate.title === item.title
      && candidate.description === item.description;
  });
  if (!lockedPrefixMatches) return { kind: "conflict", conflicts: ["agenda:structure"] };

  return { kind: "rebased", draft };
}
