import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Meeting } from "@council/contracts";
import { MeetingAgendaModalContent } from "./meeting-agenda.js";

const meeting: Meeting = {
  id: "70000000-0000-4000-8000-000000000001",
  threadId: "40000000-0000-4000-8000-000000000001",
  title: "Conflict recovery",
  goal: "Retain the local Agenda draft.",
  mode: "chaired",
  durationMinutes: 30,
  state: "active",
  automation: "suggest",
  automationRevision: 0,
  startedAt: "2026-08-10T00:00:00.000Z",
  closedAt: null,
  agenda: {
    revision: 2,
    items: [{
      id: "81000000-0000-4000-8000-000000000001",
      title: "Local title",
      description: "Local description",
      position: 0,
      status: "pending",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:01:00.000Z",
      startedAt: null,
      resolvedAt: null
    }]
  },
  summaryState: "not_requested",
  summaryJobId: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  sourceTeamId: null,
  sourcePresetId: null
};

describe("MeetingAgendaModalContent", () => {
  it("keeps conflict fields editable while locking save and structural actions", () => {
    const markup = renderToStaticMarkup(<MeetingAgendaModalContent
      meeting={meeting}
      items={meeting.agenda.items}
      busy={false}
      recoveryRequired
      error="Resolve the conflicting title."
      onChange={vi.fn()}
      onSave={vi.fn()}
      onSkip={vi.fn()}
    />);

    expect(markup).toContain('value="Local title"');
    expect(markup).toContain('>儲存議程</button>');
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup).not.toMatch(/value="Local title"[^>]*disabled=""/);
  });
});
