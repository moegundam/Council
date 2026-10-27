import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MeetingActivity } from "./meeting-activity";

describe("meeting-local experience accessibility", () => {
  it("renders a labelled chronological activity list with status text", () => {
    const markup = renderToStaticMarkup(<MeetingActivity items={[{
      id: "decision-1", createdAt: "2026-07-11T09:00:00.000Z", title: "核准方向", detail: "第一階段", status: { label: "已核准", tone: "positive", icon: "check" }
    }]} />);

    expect(markup).toContain('aria-labelledby="meeting-activity-title"');
    expect(markup).toContain("已核准");
    expect(markup).toContain("<ol");
  });

  it("keeps the canvas search, semantic summary, read-only notice, and return action in the implementation", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./meeting-canvas.tsx", import.meta.url), "utf8"));

    expect(source).toContain('aria-label="搜尋畫布節點"');
    expect(source).toContain('aria-label="畫布語意摘要"');
    expect(source).toContain("篩選節點類型");
    expect(source).toContain("此畫布僅供檢視");
    expect(source).toContain("onReturnToMeeting()");
  });

  it("restores the Meeting tab from the route while keeping the accessible tab structure", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./discussions-view.tsx", import.meta.url), "utf8"));

    expect(source).toContain("useState<MeetingExperienceTab>(routeState.view)");
    expect(source).toContain("useState<CanvasLens>(routeState.lens)");
    expect(source).toContain('role="tablist" aria-label="會議檢視"');
    expect(source).toContain('role="tabpanel" aria-labelledby="meeting-view-tab"');
  });
});
