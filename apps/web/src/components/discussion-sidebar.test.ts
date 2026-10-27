import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { DiscussionSidebar } from "./discussion-sidebar";

describe("DiscussionSidebar", () => {
  it("renders the complete taxonomy path, current Topic, and Meeting Session count", () => {
    const props = {
      groups: [{ id: "group-1", name: "產品研發" }],
      categories: [{ id: "category-1", groupId: "group-1", name: "平台架構" }],
      threads: [{
        id: "thread-1",
        revision: 1,
        categoryId: "category-1",
        title: "多 Agent 平台架構評審",
        summary: "",
        status: "open",
        tagIds: ["tag-1"],
        createdAt: "2026-07-20T00:00:00Z"
      }],
      meetings: [
        { id: "meeting-1", threadId: "thread-1", agenda: { revision: 0, items: [] } },
        { id: "meeting-2", threadId: "thread-1", agenda: { revision: 0, items: [] } }
      ],
      totalThreadCount: 1,
      tags: [{ id: "tag-1", name: "高優先", color: "red" }],
      discoveryQuery: "",
      discoveryTagId: "",
      discoveryStatus: "all",
      selectedThreadId: "thread-1",
      onDiscoveryQueryChange: vi.fn(),
      onDiscoveryTagChange: vi.fn(),
      onDiscoveryStatusChange: vi.fn(),
      onCreateThread: vi.fn(),
      onManageTaxonomy: vi.fn(),
      onSelectThread: vi.fn()
    } as unknown as ComponentProps<typeof DiscussionSidebar>;

    const markup = renderToStaticMarkup(createElement(DiscussionSidebar, props));

    expect(markup).toContain("<h2 id=\"discussion-taxonomy-heading\">群組與話題</h2>");
    expect(markup).toContain("aria-labelledby=\"discussion-taxonomy-heading\"");
    expect(markup).toContain("aria-expanded=\"true\"");
    expect(markup).toContain("群組</small><strong");
    expect(markup).toContain("分類</small><strong");
    expect(markup).toContain("aria-current=\"page\"");
    expect(markup).toContain("2 場次");
    expect(markup).toContain("高優先");
  });

  it("presents archived Topics as clickable archive files", () => {
    const onSelectThread = vi.fn();
    const props = {
      groups: [{ id: "group-1", name: "產品研發" }],
      categories: [{ id: "category-1", groupId: "group-1", name: "平台架構" }],
      threads: [{
        id: "thread-1",
        revision: 1,
        categoryId: "category-1",
        title: "已封存架構評審",
        summary: "保留正式結論供快速查閱。",
        status: "archived",
        tagIds: [],
        createdAt: "2026-07-20T00:00:00Z"
      }],
      meetings: [{ id: "meeting-1", threadId: "thread-1", agenda: { revision: 0, items: [] } }],
      totalThreadCount: 1,
      tags: [],
      discoveryQuery: "",
      discoveryTagId: "",
      discoveryStatus: "archived",
      selectedThreadId: null,
      onDiscoveryQueryChange: vi.fn(),
      onDiscoveryTagChange: vi.fn(),
      onDiscoveryStatusChange: vi.fn(),
      onCreateThread: vi.fn(),
      onManageTaxonomy: vi.fn(),
      onSelectThread
    } as unknown as ComponentProps<typeof DiscussionSidebar>;

    const markup = renderToStaticMarkup(createElement(DiscussionSidebar, props));

    expect(markup).toContain("封存檔案 · 1 場次");
    expect(markup).toContain("開啟封存檔案：已封存架構評審");
    expect(markup).toContain("lucide-archive");
  });
});
