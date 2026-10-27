"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowUpRight,
  BookOpenText,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Info,
  Search,
  TriangleAlert,
  Users,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  documentationArticles,
  documentationCategories,
  getDocumentationArticle,
  searchDocumentationArticles,
  type DocumentationArticle,
  type DocumentationCategoryId
} from "../lib/documentation";

type CategorySelection = "all" | DocumentationCategoryId;

function articleHash(id: string) {
  return `#${encodeURIComponent(id)}`;
}

export function DocumentationCenter() {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<CategorySelection>("all");
  const [selectedId, setSelectedId] = useState(documentationArticles[0]!.id);

  const results = useMemo(
    () => searchDocumentationArticles(query, categoryId === "all" ? undefined : categoryId),
    [categoryId, query]
  );
  const selectedArticle = getDocumentationArticle(selectedId);
  const visibleArticle = selectedArticle && results.some((article) => article.id === selectedArticle.id)
    ? selectedArticle
    : results[0] ?? null;

  useEffect(() => {
    const syncFromHash = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const article = getDocumentationArticle(id);
      if (!article) return;
      setQuery("");
      setCategoryId("all");
      setSelectedId(article.id);
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  function selectArticle(article: DocumentationArticle) {
    setSelectedId(article.id);
    const hash = articleHash(article.id);
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
  }

  function selectRelated(article: DocumentationArticle) {
    setCategoryId("all");
    setQuery("");
    selectArticle(article);
    document.querySelector<HTMLElement>(".documentation-content")?.focus();
  }

  function clearFilters() {
    setQuery("");
    setCategoryId("all");
    const first = documentationArticles[0]!;
    setSelectedId(first.id);
    window.history.replaceState(null, "", articleHash(first.id));
    searchRef.current?.focus();
  }

  const activeCategory = visibleArticle
    ? documentationCategories.find((category) => category.id === visibleArticle.categoryId)
    : null;

  return (
    <main className="documentation-page">
      <header className="documentation-header">
        <div>
          <span className="eyebrow">產品說明</span>
          <h1>文件中心</h1>
          <p>{documentationArticles.length} 篇指南 · {documentationCategories.length} 個分類 · 圖片來自正式環境</p>
        </div>
        <label className="documentation-search">
          <span>搜尋文件</span>
          <div>
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜尋功能、畫面文字或關鍵字"
              autoComplete="off"
            />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="清除搜尋" title="清除搜尋"><X size={15} /></button> : null}
          </div>
        </label>
      </header>

      <div className="documentation-mobile-controls">
        <label htmlFor="docs-category-select">分類</label>
        <select
          id="docs-category-select"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value as CategorySelection)}
        >
          <option value="all">全部分類</option>
          {documentationCategories.map((category) => <option key={category.id} value={category.id}>{category.label}</option>)}
        </select>
        <label htmlFor="docs-article-select">文章</label>
        <select
          id="docs-article-select"
          value={visibleArticle?.id ?? ""}
          disabled={!results.length}
          onChange={(event) => {
            const article = getDocumentationArticle(event.target.value);
            if (article) selectArticle(article);
          }}
        >
          {results.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}
        </select>
      </div>

      <div className="documentation-layout">
        <nav className="documentation-category-nav" aria-label="文件分類">
          <div className="documentation-nav-heading">分類</div>
          <button type="button" className={categoryId === "all" ? "active" : ""} aria-current={categoryId === "all" ? "page" : undefined} onClick={() => setCategoryId("all")}>
            <span>全部指南</span><small>{searchDocumentationArticles(query).length}</small>
          </button>
          {documentationCategories.map((category) => {
            const active = categoryId === category.id;
            return (
              <button key={category.id} type="button" className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => setCategoryId(category.id)}>
                <span>{category.label}<small>{category.description}</small></span>
                <b>{searchDocumentationArticles(query, category.id).length}</b>
              </button>
            );
          })}
        </nav>

        <aside className="documentation-article-nav" aria-label="指南文章">
          <div className="documentation-nav-heading">
            <span>指南</span>
            <span role="status" aria-live="polite">{results.length} 篇</span>
          </div>
          {results.length ? results.map((article) => {
            const active = article.id === visibleArticle?.id;
            return (
              <button key={article.id} type="button" className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => selectArticle(article)}>
                <span>{article.title}</span>
                <small>{article.summary}</small>
              </button>
            );
          }) : (
            <div className="documentation-empty">
              <Search size={20} aria-hidden="true" />
              <strong>找不到符合的指南</strong>
              <span>換一個關鍵字，或清除分類與搜尋條件。</span>
              <button type="button" className="secondary-button" onClick={clearFilters}>清除條件</button>
            </div>
          )}
        </aside>

        <section className="documentation-content" tabIndex={-1} aria-label="文件內容">
          {visibleArticle ? (
            <DocumentationArticleView
              article={visibleArticle}
              categoryLabel={activeCategory?.label ?? "文件"}
              onSelectRelated={selectRelated}
            />
          ) : (
            <div className="documentation-content-empty">
              <BookOpenText size={24} />
              <span>清除條件後選擇一篇指南。</span>
              <button type="button" className="secondary-button" onClick={clearFilters}>清除條件</button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function DocumentationArticleView({
  article,
  categoryLabel,
  onSelectRelated
}: {
  article: DocumentationArticle;
  categoryLabel: string;
  onSelectRelated(article: DocumentationArticle): void;
}) {
  const related = article.relatedArticleIds
    .map(getDocumentationArticle)
    .filter((item): item is DocumentationArticle => Boolean(item));

  return (
    <article id={article.id} className="documentation-article">
      <div className="documentation-breadcrumb"><BookOpenText size={14} aria-hidden="true" /><span>文件中心</span><b>/</b><span>{categoryLabel}</span></div>
      <header className="documentation-article-header">
        <div>
          <h1>{article.title}</h1>
          <p>{article.summary}</p>
        </div>
        <Link href={article.action.href} className="primary-button documentation-action">{article.action.label}<ArrowUpRight size={14} /></Link>
      </header>
      <div className="documentation-meta">
        <span><Users size={14} aria-hidden="true" />{article.audience.join("、")}</span>
        <span><Clock3 size={14} aria-hidden="true" />約 {article.readMinutes} 分鐘</span>
        <span><CheckCircle2 size={14} aria-hidden="true" />現行 Phase 1</span>
      </div>

      <figure className="documentation-figure">
        <a href={article.image.src} target="_blank" rel="noreferrer" title="開啟原始圖片">
          <Image
            src={article.image.src}
            width={article.image.width}
            height={article.image.height}
            alt={article.image.alt}
            sizes="(max-width: 680px) 100vw, (max-width: 1100px) 60vw, 760px"
            loading="eager"
            unoptimized
          />
          <span><ExternalLink size={14} aria-hidden="true" />開啟原圖</span>
        </a>
        <figcaption>{article.image.caption}</figcaption>
      </figure>

      <div className="documentation-sections">
        {article.sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {section.steps ? <ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}
            {section.bullets ? <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul> : null}
          </section>
        ))}
      </div>

      {article.callout ? (
        <aside className={`documentation-callout ${article.callout.tone}`}>
          {article.callout.tone === "warning" ? <TriangleAlert size={17} aria-hidden="true" /> : <Info size={17} aria-hidden="true" />}
          <div><strong>{article.callout.title}</strong><p>{article.callout.body}</p></div>
        </aside>
      ) : null}

      {related.length ? (
        <nav className="documentation-related" aria-label="相關指南">
          <h2>相關指南</h2>
          <div>{related.map((item) => <button key={item.id} type="button" onClick={() => onSelectRelated(item)}>{item.title}<ArrowUpRight size={13} /></button>)}</div>
        </nav>
      ) : null}
    </article>
  );
}
