import {
  createApiContractCapabilities,
  type ApiContractMethod
} from "@council/contracts/openapi-contracts";
import type { RegisteredApiRoute } from "./openapi.js";

export type ApiAuthorityCaller = "public" | "owner_session" | "agent_runtime";
export type ApiAuthorityEffect =
  | "observe"
  | "authenticate"
  | "configure"
  | "govern"
  | "operate"
  | "enqueue";

export interface ApiAuthorityEntry {
  method: ApiContractMethod;
  path: string;
  operationId: string;
  caller: ApiAuthorityCaller;
  effect: ApiAuthorityEffect;
  agentHttpAccessible: boolean;
}

interface AuthorityClassification {
  caller: ApiAuthorityCaller;
  effect: ApiAuthorityEffect;
  operationIds: readonly string[];
}

const typedClassifications: readonly AuthorityClassification[] = [
  {
    caller: "public",
    effect: "observe",
    operationIds: ["getHealthLive", "getHealthReady"]
  },
  {
    caller: "owner_session",
    effect: "observe",
    operationIds: [
      "getBootstrap",
      "getPlatformView",
      "getAgentReadiness",
      "getPublishedAgentReadinessBatch",
      "getAgentEffectiveConfiguration",
      "listAgentRevisions",
      "getRoleLifecycle",
      "getMeetingView",
      "getMeetingRecord",
      "listMeetingUtterances",
      "streamMeetingEvents",
      "getTask",
      "listToolPacks",
      "listToolPackRevisions",
      "listRuntimeProfiles",
      "listRuntimeProfileRevisions",
      "getMeetingPresetPreflight",
      "listCredentials",
      "listPrompts",
      "listPromptVersions",
      "listActionAdapters",
      "listGoalRuns",
      "getGoalRun",
      "streamGoalRunEvents",
      "getGoalRunCanvas",
      "getRuntimeRun",
      "getTaskRuntimeRun",
      "listRuntimeRunEvents"
    ]
  },
  {
    caller: "owner_session",
    effect: "configure",
    operationIds: [
      "createGroup",
      "updateGroup",
      "createCategory",
      "updateCategory",
      "createTag",
      "updateTag",
      "createThread",
      "updateThread",
      "createAgent",
      "updateAgent",
      "setAgentModel",
      "createSkill",
      "createRole",
      "updateRole",
      "createToolPack",
      "updateToolPack",
      "createAgentTeam",
      "updateAgentTeam",
      "createMeetingPreset",
      "updateMeetingPreset",
      "createPrompt",
      "updatePrompt"
    ]
  },
  {
    caller: "owner_session",
    effect: "govern",
    operationIds: [
      "publishAgent",
      "rollbackAgent",
      "setAgentStatus",
      "setSkillStatus",
      "validateSkill",
      "revokeSkill",
      "rollbackRole",
      "deleteRole",
      "approveDecision",
      "rejectDecision",
      "setTaskApproval",
      "createModelConnector",
      "updateModelConnector",
      "createMcpConnector",
      "updateMcpConnector",
      "createTaskAdapterConnector",
      "authorizeTool",
      "validateToolPack",
      "approveToolPack",
      "revokeToolPack",
      "createRuntimeProfile",
      "updateRuntimeProfile",
      "createCredential",
      "updateCredential",
      "rotateCredential",
      "setCredentialStatus",
      "publishPrompt",
      "rollbackPrompt",
      "archivePrompt",
      "createActionAdapter",
      "reviseGoalRunPlan",
      "approveGoalRun"
    ]
  },
  {
    caller: "owner_session",
    effect: "operate",
    operationIds: [
      "createMeeting",
      "setMeetingAgenda",
      "advanceMeetingAgenda",
      "startMeeting",
      "pauseMeeting",
      "resumeMeeting",
      "closeMeeting",
      "createMeetingUtterance",
      "setMeetingAutomation",
      "setMeetingMode",
      "switchMeetingParticipantRole",
      "applyChairSuggestedRole",
      "dismissChairSuggestion",
      "createDecision",
      "createTask",
      "updateTask",
      "addTaskEvidence",
      "moveTask",
      "checkModelConnectorHealth",
      "discoverMcpTools",
      "checkTaskAdapterConnectorHealth",
      "previewPrompt",
      "pauseGoalRun",
      "resumeGoalRun",
      "cancelGoalRun",
      "addGoalRunMessage",
      "steerRuntimeRun",
      "pauseRuntimeRun",
      "resumeRuntimeRun",
      "cancelRuntimeRun"
    ]
  },
  {
    caller: "owner_session",
    effect: "enqueue",
    operationIds: [
      "retryMeetingSummary",
      "runMeetingAgent",
      "runMeetingTool",
      "runTaskAgent",
      "syncTask",
      "startHarnessExecution",
      "createGoalRun"
    ]
  }
];

const schemaGapEntries: readonly Omit<ApiAuthorityEntry, "agentHttpAccessible">[] = [
  {
    method: "POST",
    path: "/api/auth/login",
    operationId: "loginOwner",
    caller: "public",
    effect: "authenticate"
  },
  {
    method: "POST",
    path: "/api/auth/test-login",
    operationId: "testLoginOwner",
    caller: "public",
    effect: "authenticate"
  },
  {
    method: "POST",
    path: "/api/auth/tailnet-login",
    operationId: "tailnetLoginOwner",
    caller: "public",
    effect: "authenticate"
  },
  {
    method: "POST",
    path: "/api/auth/logout",
    operationId: "logoutOwner",
    caller: "owner_session",
    effect: "authenticate"
  },
  {
    method: "GET",
    path: "/api/openapi.json",
    operationId: "getOpenApiDocument",
    caller: "owner_session",
    effect: "observe"
  }
];

function routeKey(route: Pick<RegisteredApiRoute, "method" | "path">): string {
  return `${route.method} ${route.path.replaceAll("::", ":")}`;
}

function withAgentAccess(entry: Omit<ApiAuthorityEntry, "agentHttpAccessible">): ApiAuthorityEntry {
  return { ...entry, agentHttpAccessible: entry.caller === "agent_runtime" };
}

export function createApiAuthorityMap(): ApiAuthorityEntry[] {
  const classificationByOperationId = new Map<string, Pick<ApiAuthorityEntry, "caller" | "effect">>();
  for (const classification of typedClassifications) {
    for (const operationId of classification.operationIds) {
      if (classificationByOperationId.has(operationId)) {
        throw new Error(`API AuthorityMap operation ${operationId} is classified more than once.`);
      }
      classificationByOperationId.set(operationId, {
        caller: classification.caller,
        effect: classification.effect
      });
    }
  }

  const capabilities = createApiContractCapabilities();
  const typedOperationIds = new Set(capabilities.map(({ operationId }) => operationId));
  for (const operationId of classificationByOperationId.keys()) {
    if (!typedOperationIds.has(operationId)) {
      throw new Error(`API AuthorityMap operation ${operationId} has no typed API capability.`);
    }
  }

  const entries = capabilities.map((capability): ApiAuthorityEntry => {
    const classification = classificationByOperationId.get(capability.operationId);
    if (!classification) {
      throw new Error(`Typed API operation ${capability.operationId} is missing an AuthorityMap classification.`);
    }
    if ((capability.security === "public") !== (classification.caller === "public")) {
      throw new Error(`Typed API operation ${capability.operationId} has conflicting contract and AuthorityMap security.`);
    }
    return withAgentAccess({
      method: capability.method,
      path: capability.path,
      operationId: capability.operationId,
      ...classification
    });
  });
  entries.push(...schemaGapEntries.map(withAgentAccess));

  const keys = new Set<string>();
  const operationIds = new Set<string>();
  for (const entry of entries) {
    const key = routeKey(entry);
    if (keys.has(key)) throw new Error(`API AuthorityMap route ${key} is classified more than once.`);
    if (operationIds.has(entry.operationId)) {
      throw new Error(`API AuthorityMap operationId ${entry.operationId} is not unique.`);
    }
    keys.add(key);
    operationIds.add(entry.operationId);
  }
  return entries.sort((left, right) => routeKey(left).localeCompare(routeKey(right)));
}

export function assertApiAuthorityCoverage(registeredRoutes: readonly RegisteredApiRoute[]): void {
  const authorityMap = createApiAuthorityMap();
  const authorityByKey = new Map(authorityMap.map((entry) => [routeKey(entry), entry]));
  const registeredByKey = new Map(registeredRoutes.map((route) => [routeKey(route), route]));
  const unclassified = [...registeredByKey.keys()].filter((key) => !authorityByKey.has(key));
  if (unclassified.length > 0) {
    throw new Error(`API AuthorityMap has an unclassified registered route: ${unclassified.join(", ")}.`);
  }
  const stale = [...authorityByKey.keys()].filter((key) => !registeredByKey.has(key));
  if (stale.length > 0) {
    throw new Error(`API AuthorityMap authority route is not registered: ${stale.join(", ")}.`);
  }
}
