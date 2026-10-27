import type {
  MeetingViewSnapshot,
  PlatformSnapshot,
  PlatformViewName
} from "@council/contracts";

export const platformSnapshotCollectionNames = [
  "groups",
  "categories",
  "tags",
  "threads",
  "agents",
  "roles",
  "skills",
  "modelConnectors",
  "mcpConnectors",
  "taskAdapterConnectors",
  "meetings",
  "participants",
  "speakerQueue",
  "utterances",
  "toolRuns",
  "chairSuggestions",
  "decisions",
  "tasks",
  "credentials",
  "prompts",
  "agentTeams",
  "meetingPresets",
  "runtimeProfiles",
  "runtimeProfileRevisions",
  "toolPacks",
  "toolPackRevisions"
] as const satisfies readonly (keyof PlatformSnapshot)[];

export type PlatformSnapshotCollectionName = (typeof platformSnapshotCollectionNames)[number];

const viewCollections: Record<PlatformViewName, readonly PlatformSnapshotCollectionName[]> = {
  tasks: ["agents", "taskAdapterConnectors", "meetings", "decisions", "tasks"],
  settings: [
    "agents", "roles", "skills", "modelConnectors", "mcpConnectors", "taskAdapterConnectors",
    "meetings", "participants", "credentials", "prompts", "runtimeProfiles", "runtimeProfileRevisions",
    "toolPacks", "toolPackRevisions"
  ],
  agents: [
    "agents", "roles", "skills", "modelConnectors", "mcpConnectors", "meetings", "participants",
    "credentials", "prompts", "agentTeams", "meetingPresets", "runtimeProfiles", "runtimeProfileRevisions",
    "toolPacks", "toolPackRevisions"
  ],
  discussions: [
    "groups", "categories", "tags", "threads", "agents", "roles", "skills", "modelConnectors",
    "mcpConnectors", "meetings", "credentials", "prompts", "agentTeams", "meetingPresets",
    "runtimeProfiles", "runtimeProfileRevisions", "toolPacks", "toolPackRevisions"
  ]
};

export const meetingViewCollectionNames = [
  "meetings",
  "participants",
  "speakerQueue",
  "utterances",
  "toolRuns",
  "chairSuggestions",
  "decisions",
  "tasks"
] as const satisfies readonly PlatformSnapshotCollectionName[];

export function platformViewCollectionNames(view: PlatformViewName): readonly PlatformSnapshotCollectionName[] {
  return viewCollections[view];
}

export function platformSnapshotSourceCollectionNames(
  outputCollections: readonly PlatformSnapshotCollectionName[]
): readonly PlatformSnapshotCollectionName[] {
  const sources = new Set(outputCollections);
  if (sources.has("agents")) sources.add("mcpConnectors");
  if (sources.has("participants")) {
    sources.add("meetings");
    sources.add("roles");
  }
  return platformSnapshotCollectionNames.filter((name) => sources.has(name));
}

export function platformViewSourceCollectionNames(view: PlatformViewName): readonly PlatformSnapshotCollectionName[] {
  const outputCollections = platformViewCollectionNames(view);
  return platformSnapshotSourceCollectionNames([...outputCollections, "roles"]);
}

export function emptyPlatformSnapshot(): PlatformSnapshot {
  return Object.fromEntries(platformSnapshotCollectionNames.map((name) => [name, []])) as unknown as PlatformSnapshot;
}

function activeRoles(snapshot: PlatformSnapshot): PlatformSnapshot["roles"] {
  return snapshot.roles.filter((role) => !role.deletedAt);
}

export function projectPlatformView(snapshot: PlatformSnapshot, view: PlatformViewName): PlatformSnapshot {
  const included = new Set(platformViewCollectionNames(view));
  const projected = emptyPlatformSnapshot() as unknown as Record<PlatformSnapshotCollectionName, unknown[]>;
  const source = snapshot as unknown as Record<PlatformSnapshotCollectionName, unknown[]>;
  for (const name of platformSnapshotCollectionNames) {
    if (included.has(name)) projected[name] = source[name] ?? [];
  }
  projected.roles = activeRoles(snapshot);
  return projected as unknown as PlatformSnapshot;
}

export function projectMeetingView(snapshot: PlatformSnapshot, meetingId: string): MeetingViewSnapshot | null {
  const meeting = snapshot.meetings.find((candidate) => candidate.id === meetingId);
  if (!meeting) return null;
  const forMeeting = <T extends { meetingId: string }>(items: readonly T[]): T[] =>
    items.filter((item) => item.meetingId === meetingId);

  return {
    meeting,
    participants: forMeeting(snapshot.participants),
    speakerQueue: forMeeting(snapshot.speakerQueue),
    utterances: forMeeting(snapshot.utterances),
    toolRuns: forMeeting(snapshot.toolRuns),
    chairSuggestions: forMeeting(snapshot.chairSuggestions),
    decisions: forMeeting(snapshot.decisions),
    tasks: forMeeting(snapshot.tasks)
  };
}
