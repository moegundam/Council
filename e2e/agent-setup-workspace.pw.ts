import { expect, test, type Page } from "@playwright/test";
import { assertDisposableE2eConfiguration, assertLoopbackHttpUrl } from "./disposable-target.js";

const disposable = assertDisposableE2eConfiguration(process.env);
interface AgentFixture { id: string; name: string; draftRevision: number }

async function apiJson<T>(path: string, data?: object, method = "POST"): Promise<T> {
  const url = new URL(path, disposable.apiUrl);
  assertLoopbackHttpUrl(url.toString(), "Agent setup fixture");
  if (url.origin !== disposable.apiUrl.origin) throw new Error("Fixture escaped disposable API.");
  const response = await fetch(url, {
    method: data ? method : "GET",
    headers: { origin: disposable.webUrl.origin, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    ...(data ? { body: JSON.stringify(data) } : {})
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${url.pathname}: ${response.status} ${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

async function fixture() {
  const initial = await apiJson<{
    agents: AgentFixture[]; meetings: Array<{ id: string; threadId: string }>
  }>("/api/bootstrap");
  const suffix = crypto.randomUUID().slice(0, 8);
  const connector = await apiJson<{ id: string; name: string }>("/api/model-connectors", {
    name: `Setup model ${suffix}`, location: "local", baseUrl: "http://10.255.255.1:11434/v1", model: "never-invoked"
  });
  const prompt = await apiJson<{ id: string }>("/api/prompts", {
    name: `Setup prompt ${suffix}`, kind: "agent", owner: "Playwright", description: "Disposable setup flow.",
    content: "Produce bounded text evidence.", variables: []
  });
  await apiJson(`/api/prompts/${prompt.id}/publish`, { expectedCurrentVersion: 1, version: 1 });
  const runtime = await apiJson<{ id: string; revision: number }>("/api/runtime-profiles", {
    name: `Setup runtime ${suffix}`, harnessKind: "openai_compatible", modelConnectorId: null,
    sandboxProfileId: null, policy: "text_only", capabilities: ["text", "abort"], timeoutMs: 60_000,
    maxConcurrency: 1, enabled: true
  });
  const agents: AgentFixture[] = [];
  for (const agent of initial.agents.slice(0, 2)) {
    const draft = await apiJson<AgentFixture>(`/api/agents/${agent.id}`, {
      expectedDraftRevision: agent.draftRevision, modelConnectorId: connector.id,
      promptBinding: { promptId: prompt.id, version: 1 },
      runtimeProfileBinding: { profileId: runtime.id, revision: runtime.revision },
      skillIds: [], toolGrants: [], toolPackGrants: []
    }, "PATCH");
    agents.push(await apiJson<AgentFixture>(`/api/agents/${agent.id}/publish`, { expectedDraftRevision: draft.draftRevision }));
  }
  return { agents, connector, meeting: initial.meetings[0]!, suffix };
}

async function guardBrowser(page: Page) {
  const errors: string[] = [];
  await page.route("**/*", async (route) => {
    const url = assertLoopbackHttpUrl(route.request().url(), "Browser request");
    if (url.origin !== disposable.webUrl.origin) {
      errors.push("Browser escaped disposable gateway.");
      await route.abort();
      return;
    }
    await route.continue();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return errors;
}

async function expectFits(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    controls: Array.from(document.querySelectorAll<HTMLElement>(
      ".agent-setup-row, .agent-setup-row button, .settings-page-embedded .page-header, .agent-header"
    )).filter((element) => element.getBoundingClientRect().width > 0 && element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent?.slice(0, 160))
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.controls).toEqual([]);
}

test("Agent setup repairs resources without leaving the Agent or its source meeting", async ({ page }, testInfo) => {
  const { agents, connector, meeting, suffix } = await fixture();
  const agent = agents[0]!;
  const errors = await guardBrowser(page);
  await page.goto(`/agents?agentId=${agent.id}&fromMeetingId=${meeting.id}&fromThreadId=${meeting.threadId}`);
  await expect(page).toHaveTitle("Council");
  await expect(page.locator(".agent-header h1")).toHaveText(agent.name);
  const setup = page.locator(".agent-setup-panel");
  await expect(setup.getByRole("group", { name: /^Skill：/ })).toContainText("未綁定 Skill。");
  await expect(setup.locator(".agent-setup-status.blocked")).toHaveCount(0);
  await expect(setup).toContainText("會議 Skill 指令 0 / 20000 字元");

  await setup.getByRole("button", { name: /管理 Prompt$/ }).click();
  const resources = page.locator(".settings-page-embedded");
  await expect(resources.getByRole("heading", { name: "Agent 資源", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/agents\?/);
  await expect(page.locator(".agent-row.active")).toBeDisabled();
  await expect(page.locator(".agent-section-tabs button:not([disabled])")).toHaveCount(0);
  await expect(resources.locator(".settings-resource-nav button")).toHaveCount(5);
  await expect(page.locator("main main")).toHaveCount(0);
  await resources.locator("#settings-tab-models").click();
  await resources.getByRole("button", { name: "新增", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名稱", { exact: true }).fill(`UI setup ${suffix}`);
  page.once("dialog", (confirmation) => confirmation.dismiss());
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("名稱", { exact: true })).toHaveValue(`UI setup ${suffix}`);
  await dialog.getByLabel("模型", { exact: true }).fill("ui-never-invoked");
  await dialog.getByLabel("Base URL", { exact: true }).fill("http://10.255.255.1:11434/v1");
  const createdResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/model-connectors" && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "建立", exact: true }).click();
  expect((await createdResponse).status()).toBe(201);
  await expect(dialog).toBeHidden();
  await resources.getByRole("button", { name: "返回 Agent", exact: true }).click();
  await expect(page.locator(".agent-header h1")).toHaveText(agent.name);
  await expect(page.locator(".agent-badges")).toContainText(connector.name);

  await page.getByRole("button", { name: "編輯 Agent", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "編輯 Agent", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole("combobox", { name: "模型", exact: true }).selectOption({ label: `UI setup ${suffix}` });
  await editor.getByRole("button", { name: "儲存", exact: true }).click();
  await expect(editor).toBeHidden();
  await page.getByRole("button", { name: "發布草稿", exact: true }).click();
  await expect(page.locator(".agent-badges")).toContainText(`UI setup ${suffix}`);

  let healthy = false;
  await page.route("**/api/model-connectors/*/health", (route) => route.fulfill({ json: { healthy } }));
  await setup.getByRole("button", { name: /連線測試$/ }).click();
  await expect(setup.getByRole("status")).toHaveText("模型連線未通過。");
  healthy = true;
  await setup.getByRole("button", { name: /連線測試$/ }).click();
  await expect(setup.getByRole("status")).toHaveText("模型連線正常。");
  await expectFits(page);
  await page.screenshot({ path: testInfo.outputPath("agent-setup-desktop.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectFits(page);
  await setup.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("agent-setup-mobile.png"), fullPage: false });
  await setup.getByRole("button", { name: /管理 Skill$/ }).click();
  await expect(resources.getByRole("heading", { name: "Agent 資源", exact: true })).toBeVisible();
  await expectFits(page);
  await page.screenshot({ path: testInfo.outputPath("agent-resource-mobile.png"), fullPage: false });
  await page.setViewportSize({ width: 320, height: 720 });
  await expectFits(page);
  await resources.getByRole("button", { name: "返回 Agent", exact: true }).click();
  const returnLink = page.locator(".agent-head-actions").getByRole("link", { name: "返回會議", exact: true });
  await returnLink.click();
  await expect(page).toHaveURL(new RegExp(`meetingId=${meeting.id}`));
  await expect(page).toHaveURL(new RegExp(`threadId=${meeting.threadId}`));
  expect(errors).toEqual([]);
});

test("connection results remain bound to the displayed Agent revision and discard a late response", async ({ page }) => {
  const { agents, connector, suffix } = await fixture();
  const agent = agents[0]!;
  const draftConnector = await apiJson<{ id: string }>("/api/model-connectors", {
    name: `Unpublished model ${suffix}`, location: "local", baseUrl: "http://10.255.255.1:11434/v1", model: "unpublished"
  });
  await apiJson(`/api/agents/${agent.id}`, { expectedDraftRevision: agent.draftRevision, modelConnectorId: draftConnector.id }, "PATCH");
  const errors = await guardBrowser(page);
  let releaseResponse: (() => void) | undefined;
  let requestedConnector: string | undefined;
  await page.route("**/api/model-connectors/*/health", async (route) => {
    requestedConnector = new URL(route.request().url()).pathname.split("/")[3];
    await new Promise<void>((resolve) => { releaseResponse = resolve; });
    await route.fulfill({ json: { healthy: true } });
  });
  await page.goto(`/agents?agentId=${agent.id}`);
  await expect(page.locator(".agent-badges")).toContainText(connector.name);
  await page.getByRole("button", { name: /連線測試$/ }).click();
  await expect.poll(() => requestedConnector).toBe(connector.id);
  await page.locator(".agent-row").filter({ hasText: agents[1]!.name }).click();
  await expect(page.locator(".agent-header h1")).toHaveText(agents[1]!.name);
  const healthResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/health") && response.request().method() === "POST");
  const refreshedProjection = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/views/agents");
  releaseResponse!();
  await healthResponse;
  await refreshedProjection;
  await expect(page.getByRole("button", { name: /連線測試$/ })).toBeEnabled();
  await expect(page.locator(".agent-setup-connection")).toHaveCount(0);
  expect(errors).toEqual([]);
});
