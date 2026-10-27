import { expect, test } from "@playwright/test";
import {
  assertDisposableE2eConfiguration,
  assertLoopbackHttpUrl
} from "./disposable-target.js";

const disposable = assertDisposableE2eConfiguration(process.env);

test("Agent detail exposes one compact capability summary on desktop and mobile", async ({ context, page }) => {
  const browserNetworkViolations: string[] = [];
  const browserErrors: string[] = [];
  let readinessBatchRequests = 0;

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    try {
      const requestUrl = assertLoopbackHttpUrl(url, "Browser request");
      if (requestUrl.origin !== disposable.webUrl.origin) {
        throw new Error("Browser request escaped the configured disposable gateway origin.");
      }
      if (requestUrl.pathname === "/api/agents/readiness:batch") readinessBatchRequests += 1;
      await route.continue();
    } catch (error) {
      browserNetworkViolations.push(`${url}: ${error instanceof Error ? error.message : "blocked"}`);
      await route.abort("blockedbyclient");
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  await page.goto("/agents");
  await expect(page).toHaveTitle("Council");

  const summary = page.locator(".agent-capability-summary");
  const rows = summary.locator(".agent-capability-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".summary-label")).toHaveText(["目標", "工具", "資料"]);
  await expect(summary).not.toContainText("有效組態");
  await expect.poll(() => readinessBatchRequests).toBeGreaterThan(0);

  for (const row of await rows.all()) {
    await row.locator("summary").click();
    await expect(row).toHaveAttribute("open", "");
  }
  await expect(rows.nth(0)).toContainText(/已發布 Rev \d+|草稿 Rev \d+|已發布 Rev \d+ 無法取得/);
  await expect(rows.nth(1)).toContainText(/Skills \d+\/\d+.*MCP \d+\/\d+.*Tool Packs \d+\/\d+/);
  await expect(rows.nth(2)).toContainText(/Credential|資料政策/);

  async function expectNoHorizontalOverflow() {
    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      summaryItems: Array.from(document.querySelectorAll<HTMLElement>(
        ".agent-capability-row summary, .agent-capability-row .summary-main, .agent-badges span"
      )).map((element) => ({
        text: element.textContent?.trim().slice(0, 120) ?? "",
        overflow: element.scrollWidth - element.clientWidth
      })).filter((item) => item.overflow > 1)
    }));
    expect(overflow.document, "page must not scroll horizontally").toBeLessThanOrEqual(1);
    expect(overflow.summaryItems, "capability summary text must fit its container").toEqual([]);
  }

  await expectNoHorizontalOverflow();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows).toHaveCount(3);
  await expectNoHorizontalOverflow();

  await page.setViewportSize({ width: 320, height: 720 });
  await expectNoHorizontalOverflow();
  const navigationGeometry = await page.locator(".brand, .primary-nav a, .documentation-link").evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, width: bounds.width, visible: bounds.width > 0 && bounds.height > 0 };
    })
  );
  expect(navigationGeometry).toHaveLength(7);
  expect(navigationGeometry.every((item) => item.visible && item.left >= 0 && item.right <= 320 && item.width >= 44)).toBe(true);
  const navigationByPosition = navigationGeometry.toSorted((left, right) => left.left - right.left);
  expect(navigationByPosition.slice(1).every((item, index) => navigationByPosition[index]!.right <= item.left + 0.5)).toBe(true);
  await expect(page.locator(".owner-avatar")).toBeHidden();

  expect(browserNetworkViolations, "all browser requests must remain on literal loopback").toEqual([]);
  expect(browserErrors, "Agent capability summary must not hide browser runtime errors").toEqual([]);
  expect(context.serviceWorkers(), "service workers must stay disabled for deterministic E2E").toEqual([]);
});
