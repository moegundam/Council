import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  documentationArticles,
  documentationCategories,
  getDocumentationArticle,
  searchDocumentationArticles
} from "./documentation";

describe("documentation catalog", () => {
  it("covers every product area with complete illustrated guides", () => {
    expect(documentationCategories).toHaveLength(6);
    expect(documentationArticles.length).toBeGreaterThanOrEqual(16);
    expect(new Set(documentationArticles.map((article) => article.id)).size).toBe(documentationArticles.length);

    for (const category of documentationCategories) {
      expect(documentationArticles.some((article) => article.categoryId === category.id)).toBe(true);
    }
    for (const article of documentationArticles) {
      expect(article.title.trim()).not.toBe("");
      expect(article.summary.trim()).not.toBe("");
      expect(article.keywords.length).toBeGreaterThanOrEqual(3);
      expect(article.audience.length).toBeGreaterThan(0);
      expect(article.readMinutes).toBeGreaterThan(0);
      expect(article.action.href).toMatch(/^\//);
      expect(article.image.src).toMatch(/^\/docs\//);
      expect(article.image.alt.length).toBeGreaterThan(12);
      expect(article.image.caption.length).toBeGreaterThan(8);
      expect(article.sections.length).toBeGreaterThanOrEqual(2);
      expect(article.sections.some((section) => (section.steps?.length ?? 0) >= 2)).toBe(true);
    }
  });

  it("normalizes full-width aliases, case, and surrounding whitespace", () => {
    expect(searchDocumentationArticles("  ＡＰＩ Key  ").map((article) => article.id)).toContain("credentials-and-models");
    expect(searchDocumentationArticles(" mCp ").map((article) => article.id)).toContain("mcp-readonly-tools");
  });

  it("searches section text and steps instead of titles only", () => {
    expect(searchDocumentationArticles("唯一主席").map((article) => article.id)).toContain("agent-teams-and-presets");
    expect(searchDocumentationArticles("自動移到審查").map((article) => article.id)).toContain("task-agent-execution");
  });

  it("intersects category and query while preserving deterministic relevance", () => {
    const discussion = searchDocumentationArticles("主席", "discussions");
    expect(discussion.length).toBeGreaterThan(0);
    expect(discussion.every((article) => article.categoryId === "discussions")).toBe(true);
    expect(discussion[0]?.id).toBe("chair-assistance");
    expect(searchDocumentationArticles("主席", "resources")).toHaveLength(0);
  });

  it("returns the full catalog for an empty query and resolves stable deep links", () => {
    expect(searchDocumentationArticles(" ")).toEqual(documentationArticles);
    expect(getDocumentationArticle("meeting-from-preset")?.title).toContain("Team");
    expect(getDocumentationArticle("missing")).toBeNull();
  });

  it("references non-empty static product screenshots", () => {
    for (const src of new Set(documentationArticles.map((article) => article.image.src))) {
      const path = fileURLToPath(new URL(`../../public${src}`, import.meta.url));
      expect(statSync(path).size, src).toBeGreaterThan(10_000);
    }
  });
});
