import { expect, test } from "@playwright/test";
import {
  assertDisposableE2eConfiguration,
  assertLoopbackHttpUrl
} from "./disposable-target.js";

interface TaxonomyFixture {
  id: string;
}

const disposable = assertDisposableE2eConfiguration(process.env);

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, disposable.apiUrl);
  assertLoopbackHttpUrl(url.toString(), "E2E API request");
  if (url.origin !== disposable.apiUrl.origin) throw new Error("E2E API request escaped the configured disposable API origin.");
  const headers = new Headers(init.headers);
  headers.set("origin", disposable.webUrl.origin);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url.pathname} failed (${response.status}): ${body.slice(0, 600)}`);
  }
  return (body ? JSON.parse(body) : undefined) as T;
}

test("mobile keyboard topic selection closes taxonomy and restores disclosure focus", async ({ page }) => {
  const group = await apiJson<TaxonomyFixture>("/api/groups", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-mobile-focus-group-v1" },
    body: JSON.stringify({ name: "E2E 手機鍵盤群組" })
  });
  const category = await apiJson<TaxonomyFixture>("/api/categories", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-mobile-focus-category-v1" },
    body: JSON.stringify({ groupId: group.id, name: "E2E 焦點分類" })
  });
  const topicTitle = "E2E 鍵盤選擇話題";
  await apiJson<TaxonomyFixture>("/api/threads", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-mobile-focus-thread-v1" },
    body: JSON.stringify({
      categoryId: category.id,
      title: topicTitle,
      summary: "驗證手機分類面板的鍵盤焦點回復。",
      tagIds: []
    })
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const disclosure = page.locator("button.mobile-discussion-picker");
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");

  const topic = page.getByRole("button", { name: new RegExp(`^${topicTitle}，`) });
  await topic.focus();
  await expect(topic).toBeFocused();
  await topic.press("Enter");

  await expect(page.getByRole("heading", { level: 1, name: topicTitle })).toBeVisible();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(disclosure).toBeFocused();
});
