import { expect, test } from "@playwright/test";

test("Settings creates metadata-only Credential through one secret-free retry key", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "API 金鑰", exact: true }).click();
  await page.getByRole("button", { name: "新增", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "新增API 金鑰" });
  await dialog.getByLabel("名稱").fill("E2E Deferred Cloud Credential");
  await dialog.getByLabel("Provider").fill("cloud-provider");
  await dialog.getByLabel("位置").selectOption("cloud");

  const requestPromise = page.waitForRequest((request) => (
    request.method() === "POST" && new URL(request.url()).pathname === "/api/credentials"
  ));
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/credentials"
  ));
  await dialog.getByRole("button", { name: "建立", exact: true }).click();

  const [request, response] = await Promise.all([requestPromise, responsePromise]);
  expect(request.headers()["idempotency-key"]).toMatch(/\S+/);
  expect(request.postDataJSON()).not.toHaveProperty("secret");
  expect(response.status()).toBe(201);
  const responseBody = await response.json();
  expect(responseBody).toMatchObject({ hasSecret: false, secretRevision: 0 });
  expect(JSON.stringify(responseBody)).not.toContain("ciphertext");
  expect(JSON.stringify(responseBody)).not.toContain("idempotencyProof");
  await expect(
    page.locator("article.settings-row").filter({ hasText: "E2E Deferred Cloud Credential" })
  ).toContainText("尚未設定密鑰");
});

test("Settings reuses each exact Credential key after an uncertain A to B to A retry", async ({ page }) => {
  const attempts: Array<{ name: string; key: string }> = [];
  await page.route("**/api/credentials", async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.continue();
      return;
    }
    const payload = request.postDataJSON() as { name: string };
    attempts.push({
      name: payload.name,
      key: request.headers()["idempotency-key"] ?? ""
    });
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DISPOSABLE_ACKNOWLEDGEMENT_UNKNOWN",
          message: "Disposable acknowledgement is intentionally unknown."
        }
      })
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "API 金鑰", exact: true }).click();

  async function submitUncertainCredential(name: string, secret: string): Promise<void> {
    await page.getByRole("button", { name: "新增", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新增API 金鑰" });
    await dialog.getByLabel("名稱").fill(name);
    await dialog.getByLabel("Provider").fill("retry-provider");
    await dialog.getByLabel("密鑰（可稍後設定）").fill(secret);
    await dialog.getByRole("button", { name: "建立", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Disposable acknowledgement is intentionally unknown.");
    page.once("dialog", (confirmation) => confirmation.accept());
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  await submitUncertainCredential("E2E Retry Intent A", "disposable-secret-a");
  await submitUncertainCredential("E2E Retry Intent B", "disposable-secret-b");
  await submitUncertainCredential("E2E Retry Intent A", "disposable-secret-a");

  expect(attempts).toHaveLength(3);
  expect(attempts[0]?.key).toMatch(/\S+/);
  expect(attempts[1]?.key).toMatch(/\S+/);
  expect(attempts[2]?.key).toBe(attempts[0]?.key);
  expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
});
