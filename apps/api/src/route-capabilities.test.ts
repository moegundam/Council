import { describe, expect, it } from "vitest";
import type { registerAdminRoutes } from "./routes/admin-routes.js";
import type { registerManagementRoutes } from "./routes/management-routes.js";
import type { registerMeetingRoutes } from "./routes/meeting-routes.js";
import type { registerTaxonomyRoutes } from "./routes/taxonomy-routes.js";

type TaxonomyOptions = Parameters<typeof registerTaxonomyRoutes>[1];
type AdminOptions = Parameters<typeof registerAdminRoutes>[1];
type ManagementOptions = Parameters<typeof registerManagementRoutes>[1];
type MeetingOptions = Parameters<typeof registerMeetingRoutes>[1];

function assertNarrowRoutePorts(
  taxonomy: TaxonomyOptions,
  admin: AdminOptions,
  management: ManagementOptions,
  meeting: MeetingOptions
): void {
  void taxonomy.store.createGroup;
  // @ts-expect-error Taxonomy routes cannot access the full platform snapshot.
  void taxonomy.store.getSnapshot;
  void admin.store.createAgent;
  // @ts-expect-error Admin routes cannot mutate Tasks.
  void admin.store.moveTask;
  void management.store.createPrompt;
  // @ts-expect-error Management routes cannot mutate Meeting state.
  void management.store.setMeetingState;
  void meeting.store.setMeetingState;
  // @ts-expect-error Meeting routes cannot rotate management Credentials.
  void meeting.store.rotateCredential;
}

describe("route capability ports", () => {
  it("keeps compile-time authority checks in the typecheck suite", () => {
    expect(typeof assertNarrowRoutePorts).toBe("function");
  });
});
