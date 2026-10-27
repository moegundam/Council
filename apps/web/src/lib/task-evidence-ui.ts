export interface TaskEvidenceRetryRequest {
  taskId: string;
  signature: string;
  idempotencyKey: string;
}

export class TaskEvidenceRetryOwnership {
  private readonly retriesByTaskId = new Map<string, Map<string, TaskEvidenceRetryRequest>>();

  acquire(taskId: string, signature: string, createKey: () => string): TaskEvidenceRetryRequest {
    let taskRetries = this.retriesByTaskId.get(taskId);
    const current = taskRetries?.get(signature);
    if (current) return current;

    const retry = { taskId, signature, idempotencyKey: createKey() };
    if (!taskRetries) {
      taskRetries = new Map();
      this.retriesByTaskId.set(taskId, taskRetries);
    }
    taskRetries.set(signature, retry);
    return retry;
  }

  clear(request: TaskEvidenceRetryRequest): void {
    const taskRetries = this.retriesByTaskId.get(request.taskId);
    if (taskRetries?.get(request.signature) !== request) return;
    taskRetries.delete(request.signature);
    if (taskRetries.size === 0) this.retriesByTaskId.delete(request.taskId);
  }
}
