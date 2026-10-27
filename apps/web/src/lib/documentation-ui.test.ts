import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("documentation center UI contract", () => {
  const shell = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
  const provider = readFileSync(new URL("../app/providers.tsx", import.meta.url), "utf8");
  const view = readFileSync(new URL("../components/documentation-center.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const dockerfile = readFileSync(new URL("../../../../deploy/Dockerfile", import.meta.url), "utf8");

  it("keeps four primary destinations and exposes documentation as a utility", () => {
    const navEntries = [...shell.matchAll(/\{ href: "\/(?:tasks|agents|settings)?", label:/g)];
    expect(navEntries).toHaveLength(4);
    expect(shell).toContain('href="/docs"');
    expect(shell.indexOf('href="/docs"')).toBeGreaterThan(shell.indexOf("</nav>"));
  });

  it("uses searchable, deep-linkable, semantic documentation navigation", () => {
    expect(view).toContain('type="search"');
    expect(view).toContain('role="status"');
    expect(view).toContain('aria-current={active ? "page" : undefined}');
    expect(view).toContain('window.addEventListener("hashchange"');
    expect(view).toMatch(/syncFromHash[\s\S]*setQuery\(""\)[\s\S]*setSelectedId\(article\.id\)/);
    expect(view).toContain('htmlFor="docs-category-select"');
    expect(view).toContain('htmlFor="docs-article-select"');
    expect(view).toContain('className="documentation-content-empty"');
    expect(view).toMatch(/documentation-content-empty[\s\S]*onClick=\{clearFilters\}/);
    expect(provider).toContain('pathname.startsWith("/docs")');
  });

  it("renders useful figures, ordered steps, and responsive reading surfaces", () => {
    expect(view).toContain("<figure");
    expect(view).toContain("<ol");
    expect(view).toContain("article.image.alt");
    expect(view).toContain("unoptimized");
    expect(dockerfile).toContain("/workspace/apps/web/public ./apps/web/public");
    expect(styles).toContain(".documentation-layout");
    expect(styles).toContain("grid-template-columns: 190px 280px minmax(0, 1fr)");
    expect(styles).toMatch(/@media \(max-width: 680px\)[\s\S]*\.documentation-layout \{ display: block;/);
  });
});
