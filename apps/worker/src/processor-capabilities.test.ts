import { describe, expect, it } from "vitest";
import type { AgentTurnFailureStore, ProcessAgentTurnInput } from "./process-agent-turn.js";
import type { ChairAutomationStore, ProcessChairAutomationInput } from "./process-chair-automation.js";
import type { McpToolCallStore, ProcessMcpToolCallInput } from "./process-mcp-tool-call.js";
import type { MeetingSummaryStore } from "./process-meeting-summary.js";
import type { ProcessTaskAgentRunInput, TaskAgentRunFailureStore } from "./process-task-agent-run.js";
import type { ProcessTaskSyncInput, TaskSyncFailureStore } from "./process-task-sync.js";

function assertNarrowProcessorPorts(
  meeting: ProcessAgentTurnInput["store"],
  task: ProcessTaskAgentRunInput["store"],
  chair: ProcessChairAutomationInput["store"],
  mcp: ProcessMcpToolCallInput["store"],
  summary: MeetingSummaryStore,
  sync: ProcessTaskSyncInput["store"],
  agentFailure: AgentTurnFailureStore,
  chairFailure: ChairAutomationStore,
  mcpFailure: McpToolCallStore,
  taskFailure: TaskAgentRunFailureStore,
  syncFailure: TaskSyncFailureStore
): void {
  void meeting.commitAgentTurn;
  // @ts-expect-error Meeting turn execution cannot manage taxonomy.
  void meeting.createGroup;
  void task.completeTaskAgentRun;
  // @ts-expect-error Task execution cannot mutate Agent definitions.
  void task.updateAgent;
  void chair.applyChairAutomation;
  // @ts-expect-error Chair automation cannot manage Credentials.
  void chair.rotateCredential;
  void mcp.commitMcpToolRun;
  // @ts-expect-error MCP execution cannot mutate taxonomy.
  void mcp.createCategory;
  void summary.commitMeetingSummary;
  // @ts-expect-error Meeting summary cannot update Agents.
  void summary.updateAgent;
  void sync.completeTaskSync;
  // @ts-expect-error Task sync cannot mutate Meeting mode.
  void sync.setMeetingMode;
  void agentFailure.commitAgentTurnFailure;
  // @ts-expect-error Agent failure recording cannot rotate secrets.
  void agentFailure.rotateCredential;
  void chairFailure.releaseChairSuggestion;
  // @ts-expect-error Chair failure recording cannot create Tasks.
  void chairFailure.createTask;
  void mcpFailure.commitMcpToolRun;
  // @ts-expect-error MCP failure recording cannot update Roles.
  void mcpFailure.updateRole;
  void taskFailure.failTaskAgentRun;
  // @ts-expect-error Task Agent failure recording cannot update Agents.
  void taskFailure.updateAgent;
  void syncFailure.failTaskSync;
  // @ts-expect-error Task sync failure recording cannot update Meetings.
  void syncFailure.setMeetingState;
}

describe("processor capability ports", () => {
  it("keeps compile-time authority checks in the typecheck suite", () => {
    expect(typeof assertNarrowProcessorPorts).toBe("function");
  });
});
