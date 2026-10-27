import { expect, test } from "@playwright/test";

test("Settings creates one Skill through the required retry contract", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Skill", exact: true }).click();
  await page.getByRole("button", { name: "新增", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新增Skill" });
  await dialog.getByLabel("名稱").fill("E2E Retry-safe Skill");
  await dialog.getByLabel("版本").fill("1.0.0");
  await dialog.getByLabel("來源").fill("Disposable browser proof");
  await dialog.getByLabel("登記負責人").fill("Platform Owner");
  await dialog.getByLabel("Instructions").fill("Keep browser Skill creation bound to one request payload.");

  const requestPromise = page.waitForRequest((request) => (
    request.method() === "POST" && new URL(request.url()).pathname === "/api/skills"
  ));
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/skills"
  ));
  await dialog.getByRole("button", { name: "建立", exact: true }).click();

  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  expect(request.headers()["idempotency-key"]).toMatch(/\S+/);
  expect(response.status()).toBe(201);
  await expect(page.locator("article.skill-settings-row").filter({ hasText: "E2E Retry-safe Skill" })).toBeVisible();
});
