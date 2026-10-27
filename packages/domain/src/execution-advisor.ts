import type {
  ExecutionRoute,
  GoalPlanTask,
  RuntimeCapability,
  RuntimePolicy
} from "@council/contracts";

export interface ExecutionAdvice {
  route: ExecutionRoute;
  policy: RuntimePolicy;
  capabilities: RuntimeCapability[];
  tools: string[];
  reason: string;
}

const routeCapabilities: Record<ExecutionRoute, readonly RuntimeCapability[]> = {
  native_text: ["text"],
  omp_coding: ["text", "file_read", "file_write", "process"],
  read_only_research: ["text", "file_read", "read_only_tool"],
  approved_action: ["text", "external_write"]
};

function routeForTask(task: GoalPlanTask, approvedCapabilities: ReadonlySet<RuntimeCapability>): ExecutionRoute {
  if (task.executionMode === "action") return "approved_action";
  if (task.executionMode === "advisor"
    && task.allowedTools.length > 0
    && approvedCapabilities.has("read_only_tool")) return "read_only_research";
  if (task.executionMode === "worker"
    && approvedCapabilities.has("file_read")
    && approvedCapabilities.has("file_write")
    && approvedCapabilities.has("process")) return "omp_coding";
  return "native_text";
}

export function adviseExecution(input: {
  task: GoalPlanTask;
  approvedCapabilities: readonly RuntimeCapability[];
  approvedTools: readonly string[];
}): ExecutionAdvice {
  const approvedCapabilities = new Set(input.approvedCapabilities);
  const route = routeForTask(input.task, approvedCapabilities);
  const approvedTools = new Set(input.approvedTools);
  const capabilities = routeCapabilities[route].filter((capability) => approvedCapabilities.has(capability));
  const tools = input.task.allowedTools.filter((tool) => approvedTools.has(tool));
  if (!capabilities.includes("text")) {
    throw new Error("ExecutionAdvisor cannot produce a route without the approved text capability.");
  }
  if (route === "approved_action") {
    return { route, policy: "text_only", capabilities, tools: [], reason: "The approved task uses a separately governed Action Adapter." };
  }
  if (route === "read_only_research") {
    return { route, policy: "read_only_tools", capabilities, tools, reason: "The approved task is limited to read-only research." };
  }
  if (route === "omp_coding") {
    return { route, policy: "isolated_exec", capabilities, tools, reason: "The approved task requires isolated repository editing." };
  }
  return { route, policy: "text_only", capabilities, tools: [], reason: "The approved task requires text generation only." };
}
