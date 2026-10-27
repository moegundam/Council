import { expect, test } from "@playwright/test";

test("Runtime Profile creation uses one caller-owned retry key", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "執行設定", exact: true }).click();

  const registry = page.locator("section.agent-runtime-section");
  await registry.getByRole("button", { name: "新增", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新增 Runtime Profile" });
  await dialog.getByLabel("名稱").fill("E2E Retry-safe Runtime Profile");

  const requestPromise = page.waitForRequest((request) => (
    request.method() === "POST" && new URL(request.url()).pathname === "/api/runtime-profiles"
  ));
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/runtime-profiles"
  ));
  await dialog.getByRole("button", { name: "建立 Profile", exact: true }).click();

  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  expect(request.headers()["idempotency-key"]).toMatch(/\S+/);
  expect(response.status()).toBe(201);
  await expect(
    registry.locator("button.runtime-profile-row").filter({ hasText: "E2E Retry-safe Runtime Profile" })
  ).toBeVisible();
});
