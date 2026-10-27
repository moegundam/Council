"use client";

import type { Category, DiscussionGroup, DiscussionThread, Meeting, Tag } from "@council/contracts";
import { Archive, ChevronDown, ChevronRight, Folder, FolderCog, Layers3, ListFilter, MessageSquareText, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ThreadStatusFilter } from "../lib/view-model";
import { compactTags, discussionTaxonomyTree, threadStatusLabel, toggleCollapsedTaxonomyNode } from "../lib/view-model";

interface DiscussionSidebarProps {
  groups: readonly DiscussionGroup[];
  categories: readonly Category[];
  threads: readonly DiscussionThread[];
  meetings: readonly Meeting[];
  totalThreadCount: number;
  tags: readonly Tag[];
  discoveryQuery: string;
  discoveryTagId: string;
  discoveryStatus: ThreadStatusFilter;
  selectedThreadId: string | null;
  onDiscoveryQueryChange: (value: string) => void;
  onDiscoveryTagChange: (tagId: string) => void;
  onDiscoveryStatusChange: (value: ThreadStatusFilter) => void;
  onCreateThread: () => void;
  onManageTaxonomy: () => void;
  onSelectThread: (threadId: string) => void;
}

export function DiscussionSidebar({
  groups,
  categories,
  threads,
  meetings,
  totalThreadCount,
  tags,
  discoveryQuery,
  discoveryTagId,
  discoveryStatus,
  selectedThreadId,
  onDiscoveryQueryChange,
  onDiscoveryTagChange,
  onDiscoveryStatusChange,
  onCreateThread,
  onManageTaxonomy,
  onSelectThread
}: DiscussionSidebarProps) {
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(() => new Set());
  const [filteredCollapsedNodes, setFilteredCollapsedNodes] = useState<Set<string>>(() => new Set());
  const statusOptions: Array<{ value: ThreadStatusFilter; label: string }> = [
    { value: "all", label: "全部狀態" },
    { value: "open", label: threadStatusLabel("open") },
    { value: "resolved", label: threadStatusLabel("resolved") },
    { value: "archived", label: threadStatusLabel("archived") }
  ];
  const activeFilterCount = Number(Boolean(discoveryQuery.trim())) + Number(Boolean(discoveryTagId)) + Number(discoveryStatus !== "all");
  const hasActiveFilters = activeFilterCount > 0;
  const taxonomyTree = useMemo(
    () => discussionTaxonomyTree(groups, categories, threads, { hideEmptyBranches: hasActiveFilters }),
    [categories, groups, hasActiveFilters, threads]
  );
  const selectedThreadHidden = hasActiveFilters && selectedThreadId !== null && !threads.some((thread) => thread.id === selectedThreadId);
  const meetingCountByThreadId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const meeting of meetings) counts.set(meeting.threadId, (counts.get(meeting.threadId) ?? 0) + 1);
    return counts;
  }, [meetings]);
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  const emptyAction = groups.length === 0
    ? { label: "新增群組", action: onManageTaxonomy }
    : categories.length === 0
      ? { label: "新增分類", action: onManageTaxonomy }
      : totalThreadCount === 0
        ? { label: "新增話題", action: onCreateThread }
        : null;

  useEffect(() => {
    setFilteredCollapsedNodes(new Set());
  }, [discoveryQuery, discoveryStatus, discoveryTagId]);

  function clearFilters() {
    onDiscoveryQueryChange("");
    onDiscoveryTagChange("");
    onDiscoveryStatusChange("all");
  }

  function toggleNode(nodeId: string) {
    const setDisclosureState = hasActiveFilters ? setFilteredCollapsedNodes : setCollapsedNodes;
    setDisclosureState((current) => toggleCollapsedTaxonomyNode(current, nodeId));
  }

  return (
    <aside className="discussion-sidebar">
      <div className="discussion-side-heading">
        <div className="discussion-side-title">
          <span className="eyebrow">討論空間</span>
          <h2 id="discussion-taxonomy-heading">群組與話題</h2>
          <small>{groups.length} 群組 · {totalThreadCount} 話題</small>
        </div>
        <div className="side-actions">
          <details className="thread-filter-menu">
            <summary className={`icon-button ${hasActiveFilters ? "active" : ""}`} aria-label="搜尋及篩選話題" title="搜尋及篩選話題">
              <ListFilter size={15} />
              {activeFilterCount > 0 && <span className="thread-filter-count" aria-hidden="true">{activeFilterCount}</span>}
            </summary>
            <div className="thread-filter-panel">
              <div className="thread-filter-heading">
                <strong>尋找話題</strong>
                {hasActiveFilters && <button type="button" className="thread-filter-clear" onClick={clearFilters}><X size={13} />清除</button>}
              </div>
              <label className="thread-filter-block" htmlFor="thread-discovery-search">搜尋
                <span className="filter-input-wrap"><Search size={13} /><input id="thread-discovery-search" type="search" value={discoveryQuery} onChange={(event) => onDiscoveryQueryChange(event.target.value)} placeholder="標題、摘要、群組、分類、標籤" /></span>
              </label>
              <div className="thread-filter-row">
                <label className="thread-filter-block">標籤
                  <select value={discoveryTagId} onChange={(event) => onDiscoveryTagChange(event.target.value)}>
                    <option value="">全部標籤</option>
                    {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                  </select>
                </label>
                <label className="thread-filter-block">狀態
                  <select value={discoveryStatus} onChange={(event) => onDiscoveryStatusChange(event.target.value as ThreadStatusFilter)}>
                    {statusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              </div>
              <small className="thread-filter-result" aria-live="polite">顯示 {threads.length} / {totalThreadCount} 個話題</small>
            </div>
          </details>
          <button className="taxonomy-manage-button" onClick={onManageTaxonomy} aria-label="管理群組、分類與標籤" title="管理群組、分類與標籤"><FolderCog size={15} /><span>整理分類</span></button>
          <button className="icon-button" disabled={categories.length === 0} onClick={onCreateThread} aria-label="新增討論話題" title={categories.length === 0 ? "請先建立分類" : "新增討論話題"}><Plus size={15} /></button>
        </div>
      </div>

      {emptyAction && <button type="button" className="taxonomy-empty-action" onClick={emptyAction.action}><Plus size={14} />{emptyAction.label}</button>}
      {hasActiveFilters && threads.length === 0 && <div className="thread-filter-empty" role="status"><span>沒有符合條件的話題</span><button type="button" onClick={clearFilters}>清除篩選</button></div>}
      {selectedThreadHidden && threads.length > 0 && <div className="thread-filter-selection-note" role="status"><span>目前話題不符合篩選</span><button type="button" onClick={clearFilters}>清除</button></div>}

      <nav className="discussion-tree" aria-labelledby="discussion-taxonomy-heading">
        {taxonomyTree.map(({ group, categories: categoryBranches, threadCount }) => {
          const groupNodeId = `group:${group.id}`;
          const groupPanelId = `discussion-group-${group.id}`;
          const groupCollapsed = (hasActiveFilters ? filteredCollapsedNodes : collapsedNodes).has(groupNodeId);
          const groupContainsCurrent = categoryBranches.some((branch) => branch.threads.some((thread) => thread.id === selectedThreadId));
          return <section key={group.id} className={`thread-group ${groupContainsCurrent ? "contains-current" : ""}`}>
            <button type="button" className="taxonomy-node taxonomy-group-node" aria-expanded={!groupCollapsed} aria-controls={groupPanelId} onClick={() => toggleNode(groupNodeId)}>
              {groupCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <Folder size={15} aria-hidden="true" />
              <span className="taxonomy-node-copy"><small>群組</small><strong title={group.name}>{group.name}</strong></span>
              <span className="taxonomy-node-count">{threadCount} 話題</span>
            </button>
            <div id={groupPanelId} className="taxonomy-group-children" hidden={groupCollapsed}>
              {categoryBranches.length === 0 && <p className="taxonomy-empty-label">尚無分類</p>}
              {categoryBranches.map(({ category, threads: categoryThreads }) => {
                const categoryNodeId = `category:${category.id}`;
                const categoryPanelId = `discussion-category-${category.id}`;
                const categoryCollapsed = (hasActiveFilters ? filteredCollapsedNodes : collapsedNodes).has(categoryNodeId);
                const categoryContainsCurrent = categoryThreads.some((thread) => thread.id === selectedThreadId);
                return <div key={category.id} className={`thread-category ${categoryContainsCurrent ? "contains-current" : ""}`}>
                  <button type="button" className="taxonomy-node taxonomy-category-node" aria-expanded={!categoryCollapsed} aria-controls={categoryPanelId} onClick={() => toggleNode(categoryNodeId)}>
                    {categoryCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    <Layers3 size={14} aria-hidden="true" />
                    <span className="taxonomy-node-copy"><small>分類</small><strong title={category.name}>{category.name}</strong></span>
                    <span className="taxonomy-node-count">{categoryThreads.length}</span>
                  </button>
                  <div id={categoryPanelId} className="taxonomy-topic-list" role="group" aria-label={`${category.name}下的話題`} hidden={categoryCollapsed}>
                    {categoryThreads.length === 0 && <p className="taxonomy-empty-label">尚無話題</p>}
                    {categoryThreads.map((item) => {
                      const itemTags = item.tagIds.flatMap((id) => {
                        const tag = tagById.get(id);
                        return tag ? [tag] : [];
                      });
                      const { visible, hidden } = compactTags(itemTags, 2);
                      const visibleNames = visible.map((tag) => tag.name).join(" · ");
                      const archived = item.status === "archived";
                      const status = archived ? "封存檔案" : threadStatusLabel(item.status);
                      const meetingCount = meetingCountByThreadId.get(item.id) ?? 0;
                      const sessionSummary = meetingCount === 0 ? "尚無場次" : `${meetingCount} 場次`;
                      const tagSummary = `${status} · ${sessionSummary}${visibleNames ? ` · ${visibleNames}` : ""}${hidden.length ? ` · +${hidden.length}` : ""}`;
                      const allTagNames = itemTags.map((tag) => tag.name).join(" · ");
                      const accessibleLabel = archived
                        ? `開啟封存檔案：${item.title}，${tagSummary}`
                        : `${item.title}，${tagSummary}`;
                      return <button key={item.id} type="button" aria-current={item.id === selectedThreadId ? "page" : undefined} aria-label={accessibleLabel} title={item.summary || undefined} className={`thread-row ${archived ? "archived-file" : ""} ${item.id === selectedThreadId ? "active" : ""}`} onClick={() => onSelectThread(item.id)}>
                        <span className="thread-row-main"><span className={`thread-status-dot ${item.status}`} aria-hidden="true" />{archived ? <Archive size={14} aria-hidden="true" /> : <MessageSquareText size={14} aria-hidden="true" />}<span className="thread-title">{item.title}</span></span>
                        <small className="thread-tags" title={allTagNames || undefined}>{tagSummary}</small>
                      </button>;
                    })}
                  </div>
                </div>;
              })}
            </div>
          </section>;
        })}
      </nav>
    </aside>
  );
}
