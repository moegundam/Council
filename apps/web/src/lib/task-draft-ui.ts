import type { PublicTask as Task, TaskExecutionProfile } from "@council/contracts";

export const staleTaskDraftMessage = "任務已更新，這份草稿仍保留。請先合併最新內容再重試。";
export const taskDraftConflictMessage = "本機草稿與最新任務修改了相同欄位，請確認後重新載入最新內容。";

export interface TaskDraftFields {
  title: string;
  description: string;
  assignee: string;
  assigneeAgentId: string;
  dueAt: string;
  acceptanceCriteria: string;
  executionProfile: TaskExecutionProfile;
  allowedTools: string;
  dataScope: string;
}

export interface TaskDraft extends TaskDraftFields {
  taskId: string;
  baseRevision: number;
  baseExecutionRevision: number;
  baseSnapshot: TaskDraftFields;
}

export interface TaskDraftPatch {
  expectedRevision: number;
  expectedExecutionRevision: number;
  title?: string;
  description?: string;
  assignee?: string | null;
  assigneeAgentId?: string | null;
  dueAt?: string | null;
  acceptanceCriteria?: string;
  executionProfile?: TaskExecutionProfile;
  allowedTools?: string[];
  dataScope?: string;
}

export type TaskDraftUpdateResult =
  | { ok: true; patch: TaskDraftPatch }
  | { ok: false; reason: "stale" | "invalid_due_at" | "unchanged"; message: string };

export type TaskDraftConflictField = keyof TaskDraftFields;

export type TaskDraftRebaseResult =
  | { ok: true; rebased: boolean; draft: TaskDraft }
  | {
    ok: false;
    reason: "conflict";
    conflictingFields: TaskDraftConflictField[];
    message: string;
  };

const taskDraftFieldNames = [
  "title",
  "description",
  "assignee",
  "assigneeAgentId",
  "dueAt",
  "acceptanceCriteria",
  "executionProfile",
  "allowedTools",
  "dataScope"
] as const satisfies readonly TaskDraftConflictField[];

const assignmentFieldNames = [
  "assignee",
  "assigneeAgentId",
  "executionProfile"
] as const satisfies readonly TaskDraftConflictField[];

function toLocalInputValue(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toIsoString(value: string): string | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizedAllowedTools(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function taskDraftFields(task: Task): TaskDraftFields {
  return {
    title: task.title,
    description: task.description,
    assignee: task.assigneeAgentId ? "" : task.assignee ?? "",
    assigneeAgentId: task.assigneeAgentId ?? "",
    dueAt: toLocalInputValue(task.dueAt),
    acceptanceCriteria: task.acceptanceCriteria,
    executionProfile: task.executionProfile,
    allowedTools: task.allowedTools.join(", "),
    dataScope: task.dataScope
  };
}

function sameTaskDraftField(
  field: TaskDraftConflictField,
  left: TaskDraftFields,
  right: TaskDraftFields
): boolean {
  if (field === "allowedTools") {
    return JSON.stringify(normalizedAllowedTools(left.allowedTools))
      === JSON.stringify(normalizedAllowedTools(right.allowedTools));
  }
  return left[field] === right[field];
}

function sameTaskDraftFields(left: TaskDraftFields, right: TaskDraftFields): boolean {
  return taskDraftFieldNames.every((field) => sameTaskDraftField(field, left, right));
}

function taskDraftChangedFields(base: TaskDraftFields, next: TaskDraftFields): TaskDraftConflictField[] {
  return taskDraftFieldNames.filter((field) => !sameTaskDraftField(field, base, next));
}

function draftFieldsFromDraft(draft: TaskDraft): TaskDraftFields {
  return Object.fromEntries(taskDraftFieldNames.map((field) => [field, draft[field]])) as unknown as TaskDraftFields;
}

export function createTaskDraft(task: Task): TaskDraft {
  const fields = taskDraftFields(task);
  return {
    ...fields,
    taskId: task.id,
    baseRevision: task.revision,
    baseExecutionRevision: task.execution.revision,
    baseSnapshot: { ...fields }
  };
}

export function taskDraftHasChanges(draft: TaskDraft): boolean {
  return !sameTaskDraftFields(draft.baseSnapshot, draftFieldsFromDraft(draft));
}

export function taskDraftIsStale(draft: TaskDraft | null, currentTask: Task | null): boolean {
  if (!draft || !currentTask) return false;
  return draft.taskId !== currentTask.id
    || draft.baseRevision !== currentTask.revision
    || draft.baseExecutionRevision !== currentTask.execution.revision
    || !sameTaskDraftFields(draft.baseSnapshot, taskDraftFields(currentTask));
}

export function rebaseTaskDraft(draft: TaskDraft, currentTask: Task): TaskDraftRebaseResult {
  const currentFields = taskDraftFields(currentTask);
  const localFields = draftFieldsFromDraft(draft);
  const localChanged = taskDraftChangedFields(draft.baseSnapshot, localFields);
  const remoteChanged = taskDraftChangedFields(draft.baseSnapshot, currentFields);
  const localChangedSet = new Set(localChanged);
  const remoteChangedSet = new Set(remoteChanged);
  const conflictingFields = new Set<TaskDraftConflictField>();

  const localAssignmentChanged = assignmentFieldNames.some((field) => localChangedSet.has(field));
  const remoteAssignmentChanged = assignmentFieldNames.some((field) => remoteChangedSet.has(field));
  if (localAssignmentChanged && remoteAssignmentChanged) {
    const assignmentsMatch = assignmentFieldNames.every((field) => sameTaskDraftField(field, localFields, currentFields));
    if (!assignmentsMatch) {
      assignmentFieldNames.forEach((field) => {
        if (localChangedSet.has(field) || remoteChangedSet.has(field)) conflictingFields.add(field);
      });
    }
  }

  for (const field of taskDraftFieldNames) {
    if (assignmentFieldNames.includes(field as (typeof assignmentFieldNames)[number])) continue;
    if (localChangedSet.has(field)
      && remoteChangedSet.has(field)
      && !sameTaskDraftField(field, localFields, currentFields)) {
      conflictingFields.add(field);
    }
  }

  if (conflictingFields.size > 0) {
    return {
      ok: false,
      reason: "conflict",
      conflictingFields: taskDraftFieldNames.filter((field) => conflictingFields.has(field)),
      message: taskDraftConflictMessage
    };
  }

  const mergedFields: TaskDraftFields = { ...currentFields };
  for (const field of taskDraftFieldNames) {
    if (!localChangedSet.has(field)) continue;
    (mergedFields as Record<TaskDraftConflictField, TaskDraftFields[TaskDraftConflictField]>)[field] = localFields[field];
  }

  return {
    ok: true,
    rebased: taskDraftIsStale(draft, currentTask),
    draft: {
      ...mergedFields,
      taskId: currentTask.id,
      baseRevision: currentTask.revision,
      baseExecutionRevision: currentTask.execution.revision,
      baseSnapshot: { ...currentFields }
    }
  };
}

export function canSubmitTaskSync(
  task: Pick<Task, "execution" | "sync">,
  hasSelectedAdapter: boolean,
  draftDirty: boolean
): boolean {
  return hasSelectedAdapter
    && !draftDirty
    && task.sync.status !== "queued"
    && task.execution.status !== "queued"
    && task.execution.status !== "running";
}

export function prepareTaskDraftUpdate(draft: TaskDraft, currentTask: Task): TaskDraftUpdateResult {
  if (draft.taskId !== currentTask.id
    || draft.baseRevision !== currentTask.revision
    || draft.baseExecutionRevision !== currentTask.execution.revision
    || !sameTaskDraftFields(draft.baseSnapshot, taskDraftFields(currentTask))) {
    return { ok: false, reason: "stale", message: staleTaskDraftMessage };
  }

  const base = draft.baseSnapshot;
  const title = draft.title.trim();
  const humanAssignee = draft.assignee.trim();
  const assigneeAgentId = draft.assigneeAgentId || null;
  const patch: TaskDraftPatch = {
    expectedRevision: draft.baseRevision,
    expectedExecutionRevision: draft.baseExecutionRevision
  };

  if (title !== base.title) patch.title = title;
  if (draft.description !== base.description) patch.description = draft.description;
  if (assigneeAgentId !== (base.assigneeAgentId || null)) patch.assigneeAgentId = assigneeAgentId;
  if (!assigneeAgentId) {
    const baseHumanAssignee = base.assigneeAgentId ? "" : base.assignee;
    if (humanAssignee !== baseHumanAssignee) patch.assignee = humanAssignee || null;
  }
  if (draft.dueAt !== base.dueAt) {
    if (!draft.dueAt.trim()) patch.dueAt = null;
    else {
      const dueAt = toIsoString(draft.dueAt);
      if (!dueAt) return { ok: false, reason: "invalid_due_at", message: "到期日格式不正確。" };
      patch.dueAt = dueAt;
    }
  }
  if (draft.acceptanceCriteria !== base.acceptanceCriteria) patch.acceptanceCriteria = draft.acceptanceCriteria;
  if (draft.executionProfile !== base.executionProfile) patch.executionProfile = draft.executionProfile;
  if (draft.dataScope !== base.dataScope) patch.dataScope = draft.dataScope;

  const allowedTools = normalizedAllowedTools(draft.allowedTools);
  const baseAllowedTools = normalizedAllowedTools(base.allowedTools);
  if (JSON.stringify(allowedTools) !== JSON.stringify(baseAllowedTools)) patch.allowedTools = allowedTools;

  if (Object.keys(patch).length === 2) {
    return { ok: false, reason: "unchanged", message: "請至少修改一項欄位。" };
  }

  return { ok: true, patch };
}
