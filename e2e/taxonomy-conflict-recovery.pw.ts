import { expect, test } from "@playwright/test";
import {
  assertDisposableE2eConfiguration,
  assertLoopbackHttpUrl
} from "./disposable-target.js";

interface GroupFixture {
  id: string;
  revision: number;
  name: string;
}

interface PlatformFixture {
  groups: GroupFixture[];
  categories: CategoryFixture[];
}

interface CategoryFixture {
  id: string;
  revision: number;
  groupId: string;
  name: string;
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

test("a stale taxonomy editor keeps its draft and can save again against the refreshed revision", async ({ page }) => {
  const originalName = "E2E revision 衝突群組";
  const remoteName = "E2E 另一分頁更新";
  const retainedDraft = "E2E 保留後再次送出";
  const group = await apiJson<GroupFixture>("/api/groups", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-taxonomy-conflict-group-v1" },
    body: JSON.stringify({ name: originalName })
  });

  await page.goto("/");
  await page.getByRole("button", { name: "管理群組、分類與標籤" }).click();
  const dialog = page.getByRole("dialog", { name: "整理討論分類" });
  await dialog.getByRole("button", { name: `編輯群組「${originalName}」` }).click();
  await dialog.getByLabel("群組名稱").fill(retainedDraft);

  const remote = await apiJson<GroupFixture>(`/api/groups/${group.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: group.revision, name: remoteName })
  });
  expect(remote.revision).toBe(group.revision + 1);

  await dialog.getByRole("button", { name: "更新群組" }).click();
  await expect(dialog.getByRole("alert")).toContainText("草稿已保留");
  await expect(dialog.getByLabel("群組名稱")).toHaveValue(retainedDraft);
  await expect(dialog.getByText(remoteName, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("最新版本已載入");

  await dialog.getByRole("button", { name: "更新群組" }).click();
  await expect(dialog.getByRole("status")).toContainText(`群組「${retainedDraft}」已更新`);

  const finalSnapshot = await apiJson<PlatformFixture>("/api/bootstrap");
  expect(finalSnapshot.groups.find((item) => item.id === group.id)).toMatchObject({
    revision: remote.revision + 1,
    name: retainedDraft
  });
});

test("taxonomy conflict recovery merges a remote Category group with the retained local name", async ({ page }) => {
  const firstGroup = await apiJson<GroupFixture>("/api/groups", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-taxonomy-merge-group-1" },
    body: JSON.stringify({ name: "E2E 原始分類群組" })
  });
  const secondGroup = await apiJson<GroupFixture>("/api/groups", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-taxonomy-merge-group-2" },
    body: JSON.stringify({ name: "E2E 遠端分類群組" })
  });
  const originalName = "E2E 三方合併分類";
  const retainedName = "E2E 本機分類名稱";
  const category = await apiJson<CategoryFixture>("/api/categories", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-taxonomy-merge-category" },
    body: JSON.stringify({ groupId: firstGroup.id, name: originalName })
  });

  await page.goto("/");
  await page.getByRole("button", { name: "管理群組、分類與標籤" }).click();
  const dialog = page.getByRole("dialog", { name: "整理討論分類" });
  await dialog.getByRole("button", { name: "分類", exact: true }).click();
  await dialog.getByRole("button", { name: `編輯分類「${originalName}」` }).click();
  await dialog.getByLabel("分類名稱").fill(retainedName);

  const remote = await apiJson<CategoryFixture>(`/api/categories/${category.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      expectedRevision: category.revision,
      groupId: secondGroup.id,
      name: originalName
    })
  });

  await dialog.getByRole("button", { name: "更新分類" }).click();
  await expect(dialog.getByRole("alert")).toContainText("未修改欄位已套用最新版本");
  await expect(dialog.getByLabel("分類名稱")).toHaveValue(retainedName);
  await expect(dialog.getByLabel("所屬群組")).toHaveValue(secondGroup.id);

  await dialog.getByRole("button", { name: "更新分類" }).click();
  await expect(dialog.getByRole("status")).toContainText(`分類「${retainedName}」已更新`);

  const finalSnapshot = await apiJson<PlatformFixture>("/api/bootstrap");
  expect(finalSnapshot.categories.find((item) => item.id === category.id)).toMatchObject({
    revision: remote.revision + 1,
    groupId: secondGroup.id,
    name: retainedName
  });
});

test("taxonomy conflict recovery retains the draft while a required refresh is retried", async ({ page }) => {
  let rejectProjectionRefresh = false;
  await page.route("**/api/v1/views/discussions", async (route) => {
    if (!rejectProjectionRefresh) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "E2E_PROJECTION_UNAVAILABLE", message: "Disposable projection failure." } })
    });
  });

  const originalName = "E2E refresh retry 群組";
  const remoteName = "E2E refresh retry 遠端值";
  const retainedDraft = "E2E refresh retry 本機草稿";
  const group = await apiJson<GroupFixture>("/api/groups", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-taxonomy-refresh-retry" },
    body: JSON.stringify({ name: originalName })
  });

  await page.goto("/");
  await page.getByRole("button", { name: "管理群組、分類與標籤" }).click();
  const dialog = page.getByRole("dialog", { name: "整理討論分類" });
  await dialog.getByRole("button", { name: `編輯群組「${originalName}」` }).click();
  await dialog.getByLabel("群組名稱").fill(retainedDraft);
  await apiJson<GroupFixture>(`/api/groups/${group.id}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: group.revision, name: remoteName })
  });

  rejectProjectionRefresh = true;
  await dialog.getByRole("button", { name: "更新群組" }).click();
  await expect(dialog.getByRole("alert")).toContainText("最新列表也無法刷新");
  await expect(dialog.getByLabel("群組名稱")).toHaveValue(retainedDraft);
  await expect(dialog.getByRole("button", { name: "更新群組" })).toBeDisabled();

  rejectProjectionRefresh = false;
  await dialog.getByRole("button", { name: "重新載入最新版" }).click();
  await expect(dialog.getByRole("alert")).toContainText("最新版本已載入");
  await expect(dialog.getByText(remoteName, { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("群組名稱")).toHaveValue(retainedDraft);
});
