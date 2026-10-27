export interface TaskAgentRunRetryRequest {
  taskId: string;
  executionRevision: number;
  idempotencyKey: string;
}

export class TaskAgentRunRetryOwnership {
  private readonly retryByTaskRevision = new Map<string, TaskAgentRunRetryRequest>();

  acquire(
    taskId: string,
    executionRevision: number,
    createKey: () => string
  ): TaskAgentRunRetryRequest {
    const slot = this.slotKey(taskId, executionRevision);
    const current = this.retryByTaskRevision.get(slot);
    if (current) return current;

    const retry = { taskId, executionRevision, idempotencyKey: createKey() };
    this.retryByTaskRevision.set(slot, retry);
    return retry;
  }

  clear(request: TaskAgentRunRetryRequest): void {
    const slot = this.slotKey(request.taskId, request.executionRevision);
    if (this.retryByTaskRevision.get(slot) === request) this.retryByTaskRevision.delete(slot);
  }

  private slotKey(taskId: string, executionRevision: number): string {
    return JSON.stringify([taskId, executionRevision]);
  }
}
