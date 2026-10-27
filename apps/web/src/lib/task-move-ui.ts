export interface TaskMoveSelectionRequest {
  readonly ownershipId: number;
}

type TaskMoveSelectionOwner =
  | { kind: "move"; ownershipId: number }
  | { kind: "user"; ownershipId: number }
  | null;

export class TaskMoveSelectionOwnership {
  private nextOwnershipId = 0;
  private selectionOwner: TaskMoveSelectionOwner = null;

  beginMove(): TaskMoveSelectionRequest {
    const request = { ownershipId: ++this.nextOwnershipId };
    this.selectionOwner = { kind: "move", ownershipId: request.ownershipId };
    return request;
  }

  claimUserSelection(): void {
    this.selectionOwner = { kind: "user", ownershipId: ++this.nextOwnershipId };
  }

  ownsSelection(request: TaskMoveSelectionRequest): boolean {
    return this.selectionOwner?.kind === "move"
      && this.selectionOwner.ownershipId === request.ownershipId;
  }

  finishMove(request: TaskMoveSelectionRequest): void {
    if (this.ownsSelection(request)) this.selectionOwner = null;
  }
}
