import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  assertDisposableE2eConfiguration,
  assertLoopbackHttpUrl
} from "./disposable-target.js";

interface AgentFixture {
  id: string;
  name: string;
  draftRevision: number;
}

interface RoleFixture {
  id: string;
  name: string;
}

interface PlatformFixture {
  groups: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; groupId: string; name: string }>;
  threads: Array<{ id: string; categoryId: string; title: string }>;
  agents: AgentFixture[];
  roles: RoleFixture[];
  meetings: Array<{ id: string; threadId: string; title: string }>;
  participants: Array<{ meetingId: string; agentId: string; roleId: string; isChair: boolean }>;
  decisions: Array<{ id: string; meetingId: string; title: string; status: string }>;
  tasks: Array<{ id: string; decisionId: string; title: string; status: string }>;
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

async function publishRunnableAgents(): Promise<{ agents: AgentFixture[]; roles: RoleFixture[] }> {
  const initial = await apiJson<PlatformFixture>("/api/bootstrap");
  const mcpConnector = await apiJson<{ id: string }>("/api/mcp-connectors", {
    method: "POST",
    headers: { "Idempotency-Key": "disposable-e2e-mcp-connector" },
    body: JSON.stringify({
      name: "Disposable E2E read-only MCP",
      location: "cloud",
      baseUrl: "https://1.1.1.1/mcp",
      approvedTools: ["search"]
    })
  });
  const connector = await apiJson<{ id: string }>("/api/model-connectors", {
    method: "POST",
    headers: { "Idempotency-Key": "disposable-e2e-model-connector" },
    body: JSON.stringify({
      name: "Disposable E2E model fixture",
      location: "local",
      baseUrl: "http://10.255.255.1:11434/v1",
      model: "fixture-never-invoked"
    })
  });
  const prompt = await apiJson<{ id: string; currentVersion: number }>("/api/prompts", {
    method: "POST",
    headers: { "Idempotency-Key": "e2e-key" },
    body: JSON.stringify({
      name: "Disposable E2E meeting prompt",
      kind: "agent",
      description: "Disposable prompt used only to satisfy Agent readiness during browser E2E.",
      owner: "Playwright",
      content: "你是 {{AGENT_NAME}}，請針對 {{MEETING_GOAL}} 提供意見。",
      variables: ["AGENT_NAME", "MEETING_GOAL"]
    })
  });
  await apiJson(`/api/prompts/${prompt.id}/publish`, {
    method: "POST",
    body: JSON.stringify({ expectedCurrentVersion: prompt.currentVersion, version: prompt.currentVersion })
  });
  const runtimeProfile = await apiJson<{ id: string; revision: number }>("/api/runtime-profiles", {
    method: "POST",
    headers: { "Idempotency-Key": "disposable-e2e-runtime-profile" },
    body: JSON.stringify({
      name: "Disposable E2E text runtime",
      harnessKind: "openai_compatible",
      modelConnectorId: null,
      sandboxProfileId: null,
      policy: "text_only",
      capabilities: ["text", "abort"],
      timeoutMs: 60_000,
      maxConcurrency: 1,
      enabled: true
    })
  });

  for (const agent of initial.agents) {
    const draft = await apiJson<AgentFixture>(`/api/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedDraftRevision: agent.draftRevision,
        modelConnectorId: connector.id,
        promptBinding: { promptId: prompt.id, version: prompt.currentVersion },
        runtimeProfileBinding: { profileId: runtimeProfile.id, revision: runtimeProfile.revision },
        ...(agent.name === "Architect-R"
          ? { toolGrants: [{ connectorId: mcpConnector.id, toolName: "search" }] }
          : {})
      })
    });
    if (!draft.draftRevision) throw new Error(`Agent ${agent.name} did not produce a publishable draft.`);
    await apiJson<AgentFixture>(`/api/agents/${agent.id}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
    });
  }

  return { agents: initial.agents, roles: initial.roles };
}

async function dragWithPointer(page: Page, source: Locator, target: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Drag source or target is not rendered.");

  const start = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const end = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + Math.min(120, targetBox.height / 2) };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 8, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.up();
}

test("Group to Category to Thread meeting reaches a dragged Task", async ({ context, page }) => {
  const browserNetworkViolations: string[] = [];
  const browserErrors: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    try {
      const requestUrl = assertLoopbackHttpUrl(url, "Browser request");
      if (requestUrl.origin !== disposable.webUrl.origin) {
        throw new Error("Browser request escaped the configured disposable gateway origin.");
      }
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

  const { agents, roles } = await test.step("prepare disposable in-memory Agent fixtures", publishRunnableAgents);
  const architect = agents.find((agent) => agent.name === "Architect-R") ?? agents[0];
  const chair = agents.find((agent) => agent.name === "Chair-Local") ?? agents[1];
  const sentinel = agents.find((agent) => agent.name === "Sentinel-G") ?? agents[2];
  if (!architect || !chair || !sentinel || roles.length < 3) throw new Error("Seed Agent/Role fixtures are incomplete.");

  const groupName = "E2E 可拋棄群組";
  const categoryName = "E2E 流程驗收";
  const topicTitle = "E2E 多代理會議 Golden Path";
  const meetingTitle = "E2E Agent Role 安排會議";
  const decisionTitle = "採用可拋棄式瀏覽器驗收";
  const taskTitle = "完成 Playwright golden path";

  await test.step("create Group and Category through the taxonomy UI", async () => {
    await page.goto("/");
    await expect(page).toHaveTitle("Council");
    await expect(page.getByRole("heading", { name: "群組與話題" })).toBeVisible();
    await page.getByRole("button", { name: "管理群組、分類與標籤" }).click();

    const taxonomyDialog = page.getByRole("dialog", { name: "整理討論分類" });
    await expect(taxonomyDialog).toBeVisible();
    await taxonomyDialog.getByLabel("群組名稱").fill(groupName);
    await taxonomyDialog.getByRole("button", { name: "新增群組" }).click();
    await expect(taxonomyDialog.getByRole("status")).toContainText(groupName);
    await taxonomyDialog.getByLabel("分類名稱").fill(categoryName);
    await taxonomyDialog.getByRole("button", { name: "新增分類" }).click();
    await expect(taxonomyDialog.getByRole("status")).toContainText(categoryName);
    await taxonomyDialog.getByRole("button", { name: "關閉" }).click();
    await expect(taxonomyDialog).toBeHidden();
  });

  await test.step("create and select the Thread", async () => {
    await page.getByRole("button", { name: "新增討論話題" }).click();
    const threadDialog = page.getByRole("dialog", { name: "新增討論話題" });
    await threadDialog.getByLabel("群組 / 分類").selectOption({ label: `${groupName} / ${categoryName}` });
    await threadDialog.getByLabel("話題名稱").fill(topicTitle);
    await threadDialog.getByLabel("摘要").fill("驗證討論、決議與任務的最長可執行 UI 路徑。");
    await threadDialog.getByRole("checkbox", { name: "高優先" }).check();
    await threadDialog.getByRole("button", { name: "建立話題" }).click();
    const topicHeading = page.getByRole("heading", { level: 1, name: topicTitle });
    await expect(topicHeading).toBeVisible();
    await expect(topicHeading.locator("..").getByText(`${groupName} / ${categoryName}`, { exact: true })).toBeVisible();
  });

  await test.step("schedule Agents and Roles, then start the Meeting", async () => {
    await page.getByRole("button", { name: "建立會議" }).click();
    const meetingDialog = page.getByRole("dialog", { name: "建立會議" });
    await meetingDialog.getByLabel("名稱").fill(meetingTitle);
    await meetingDialog.getByLabel(`選擇 ${sentinel.name} 參加會議`).uncheck();
    await meetingDialog.getByLabel(`選擇 ${sentinel.name} 參加會議`).check();
    await meetingDialog.getByLabel(`${architect.name} 的會議角色`).selectOption(roles[0]!.id);
    await meetingDialog.getByLabel(`${chair.name} 的會議角色`).selectOption(roles[1]!.id);
    await meetingDialog.getByLabel(`${sentinel.name} 的會議角色`).selectOption(roles[2]!.id);
    await meetingDialog.getByLabel(`指定 ${chair.name} 為主席`).check();
    const warningConfirmation = meetingDialog.getByRole("checkbox", { name: /以 warning 狀態參加/ });
    await expect(warningConfirmation, "fully ready disposable Agents must not require a warning override").toHaveCount(0);
    await meetingDialog.getByRole("button", { name: "開始會議" }).click();
    await expect(meetingDialog).toBeHidden();
    await expect(page.getByRole("status")).toContainText("會議已開始");
    await expect(page.getByLabel(new RegExp(`${chair.name}.*主席`))).toBeVisible();
  });

  await test.step("protect a dirty Tool argument draft across close attempts", async () => {
    await page.getByRole("button", { name: `${architect.name} 的工具` }).click();
    const toolDialog = page.getByRole("dialog", { name: `${architect.name} 的工具` });
    const argumentsInput = toolDialog.getByLabel("JSON 參數");
    const dirtyArguments = '{"query":"保留這份草稿"}';
    await expect(toolDialog).toBeVisible();
    await argumentsInput.fill(dirtyArguments);

    let confirmationMessage = "";
    const dismissed = new Promise<void>((resolve, reject) => {
      page.once("dialog", (dialog) => {
        confirmationMessage = dialog.message();
        void dialog.dismiss().then(() => resolve(), reject);
      });
    });
    await page.keyboard.press("Escape");
    await dismissed;
    expect(confirmationMessage).toContain("尚未執行的工具參數草稿");
    await expect(toolDialog).toBeVisible();
    await expect(argumentsInput).toHaveValue(dirtyArguments);

    const accepted = new Promise<void>((resolve, reject) => {
      page.once("dialog", (dialog) => {
        confirmationMessage = dialog.message();
        void dialog.accept().then(() => resolve(), reject);
      });
    });
    await toolDialog.getByRole("button", { name: "取消" }).click();
    await accepted;
    expect(confirmationMessage).toContain("尚未執行的工具參數草稿");
    await expect(toolDialog).toBeHidden();
  });

  await test.step("discuss, approve a Decision, and create its Task", async () => {
    const message = "Owner：本次只驗證固定的討論、決議、任務流程。";
    await page.getByLabel("會議發言").fill(message);
    await page.getByRole("button", { name: "送出發言" }).click();
    await expect(page.getByText(message, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "新增決議" }).click();
    const decisionDialog = page.getByRole("dialog", { name: "提出決議" });
    await decisionDialog.getByLabel("標題").fill(decisionTitle);
    await decisionDialog.getByLabel("內容").fill("瀏覽器驗收只在具備 disposable marker 的 loopback 環境執行。");
    await decisionDialog.getByRole("button", { name: "提出", exact: true }).click();

    const decisionCard = page.locator(".decision-item").filter({ hasText: decisionTitle });
    await expect(decisionCard).toBeVisible();
    await decisionCard.getByRole("button", { name: "核准" }).click();
    await expect(decisionCard).toContainText("已核准");
    await decisionCard.getByRole("button", { name: "建立任務" }).click();

    const taskDialog = page.getByRole("dialog", { name: "從決議建立任務" });
    await taskDialog.getByLabel("任務名稱").fill(taskTitle);
    const humanAssignee = taskDialog.getByLabel(/負責人/);
    await humanAssignee.fill("E2E Owner");
    await expect(humanAssignee).toHaveValue("E2E Owner");
    await taskDialog.getByLabel("Agent 產出").check();
    const acceptanceCriteria = taskDialog.getByLabel("驗收條件");
    await acceptanceCriteria.fill("切換執行方式後仍需保留的驗收條件");
    await expect(acceptanceCriteria).toHaveValue("切換執行方式後仍需保留的驗收條件");
    await taskDialog.getByLabel("Agent 顧問").check();
    await taskDialog.getByLabel("Agent 產出").check();
    await expect(acceptanceCriteria).toHaveValue("切換執行方式後仍需保留的驗收條件");
    await taskDialog.getByLabel("人工處理").check();
    await expect(humanAssignee).toHaveValue("E2E Owner");
    await taskDialog.getByRole("button", { name: "建立任務" }).click();
    await expect(taskDialog).toBeHidden();
    await expect(decisionCard.getByRole("button", { name: "查看任務" })).toBeVisible();
    await decisionCard.getByRole("button", { name: "查看任務" }).click();
    const taskInspector = page.getByRole("dialog", { name: `${taskTitle} · 任務摘要` });
    await expect(taskInspector).toBeVisible();
    await expect(page).toHaveURL(/meetingId=/);
    await taskInspector.getByRole("link", { name: "到任務看板管理" }).click();
  });

  await test.step("drag the Task from Todo to In Progress", async () => {
    await expect(page).toHaveURL(/\/tasks\?taskId=/);
    await expect(page.getByRole("heading", { level: 1, name: "任務" })).toBeVisible();
    const detailDialog = page.getByRole("dialog", { name: `${taskTitle} 工作詳情` });
    await expect(detailDialog).toBeVisible();
    await detailDialog.getByLabel("工作說明").fill("尚未儲存的 E2E 草稿");

    await page.keyboard.press("Escape");
    let discardDialog = page.getByRole("dialog", { name: "捨棄未儲存變更？" });
    await expect(discardDialog).toBeVisible();
    await discardDialog.getByRole("button", { name: "繼續編輯" }).click();
    await expect(page.getByRole("dialog", { name: `${taskTitle} 工作詳情` }).getByLabel("工作說明"))
      .toHaveValue("尚未儲存的 E2E 草稿");

    await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
    discardDialog = page.getByRole("dialog", { name: "捨棄未儲存變更？" });
    await expect(discardDialog).toBeVisible();
    await discardDialog.getByRole("button", { name: "繼續編輯" }).click();
    await expect(page.getByRole("dialog", { name: `${taskTitle} 工作詳情` }).getByLabel("工作說明"))
      .toHaveValue("尚未儲存的 E2E 草稿");

    await page.getByRole("dialog", { name: `${taskTitle} 工作詳情` }).getByRole("button", { name: "關閉" }).click();
    discardDialog = page.getByRole("dialog", { name: "捨棄未儲存變更？" });
    await expect(discardDialog).toBeVisible();
    await discardDialog.getByRole("button", { name: "捨棄變更" }).click();
    await expect(discardDialog).toBeHidden();

    const dragHandle = page.getByRole("button", { name: `拖拉 ${taskTitle}` });
    const inProgressColumn = page.locator("#task-status-panel-in_progress");
    await expect(dragHandle).toBeVisible();
    await dragWithPointer(page, dragHandle, inProgressColumn);
    await expect(page.getByRole("status").filter({ hasText: "已移至進行中" })).toBeVisible();
    await expect(inProgressColumn.getByRole("heading", { name: taskTitle })).toBeVisible();
  });

  const finalSnapshot = await apiJson<PlatformFixture>("/api/bootstrap");
  const group = finalSnapshot.groups.find((item) => item.name === groupName);
  const category = finalSnapshot.categories.find((item) => item.name === categoryName && item.groupId === group?.id);
  const thread = finalSnapshot.threads.find((item) => item.title === topicTitle && item.categoryId === category?.id);
  const meeting = finalSnapshot.meetings.find((item) => item.title === meetingTitle && item.threadId === thread?.id);
  const decision = finalSnapshot.decisions.find((item) => item.title === decisionTitle && item.meetingId === meeting?.id);
  const task = finalSnapshot.tasks.find((item) => item.title === taskTitle && item.decisionId === decision?.id);
  expect(group, "Group must persist in the disposable Store").toBeTruthy();
  expect(category, "Category must persist under the created Group").toBeTruthy();
  expect(thread, "Thread must persist under the created Category").toBeTruthy();
  expect(meeting, "Meeting must persist under the selected Thread").toBeTruthy();
  expect(finalSnapshot.participants.filter((item) => item.meetingId === meeting?.id)).toHaveLength(3);
  expect(finalSnapshot.participants.find((item) => item.meetingId === meeting?.id && item.isChair)?.agentId).toBe(chair.id);
  expect(decision?.status).toBe("approved");
  expect(task?.status).toBe("in_progress");
  expect(browserNetworkViolations, "all browser requests must remain on literal loopback").toEqual([]);
  expect(browserErrors, "the golden path must not hide browser runtime errors").toEqual([]);
  expect(context.serviceWorkers(), "service workers must stay disabled for deterministic E2E").toEqual([]);
});
