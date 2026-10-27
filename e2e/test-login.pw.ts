import { expect, test } from "@playwright/test";

test("disposable login offers one-click access without sending credentials", async ({ context, page }) => {
  let testLoginBody: string | null | undefined;
  let authenticated = false;
  await page.route("**/api/v1/views/discussions", async (route) => {
    if (authenticated) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Authentication required." } })
    });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/test-login") {
      testLoginBody = request.postData();
    }
  });

  await page.goto("/login");
  await expect(page.getByLabel("電子郵件")).toBeVisible();
  await expect(page.getByLabel("密碼")).toBeVisible();
  authenticated = true;
  await page.getByRole("button", { name: "測試直接登入" }).click();

  await expect(page).toHaveURL(/\/$/);
  expect(testLoginBody).toBeNull();
  await expect.poll(async () => (
    (await context.cookies()).some((cookie) => cookie.name === "council_session" && cookie.httpOnly)
  )).toBe(true);
});
