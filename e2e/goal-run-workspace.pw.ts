import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  assertDisposableE2eConfiguration,
  assertLoopbackHttpUrl
} from "./disposable-target.js";

interface AgentFixture {
  id: string;
  name: string;
  draftRevision: number;
  publishedRevision: number | null;
}

interface PlatformFixture {
  categories: Array<{ id: string; name: string }>;
  agents: AgentFixture[];
  prompts?: Array<{ id: string; currentVersion: number; publishedVersion: number | null }>;
}

interface GoalRunFixture {
  id: string;
  title: string;
  meetingId: string;
  state: string;
  revision: number;
  activePlanRevision: number;
}

const disposable = assertDisposableE2eConfiguration(process.env);
let ownerCookie = "";

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = new URL(path, disposable.apiUrl);
  assertLoopbackHttpUrl(url.toString(), "Goal Run E2E API request");
  if (url.origin !== disposable.apiUrl.origin) throw new Error("Goal Run E2E API request escaped the disposable API origin.");
  const headers = new Headers(init.headers);
  headers.set("origin", disposable.webUrl.origin);
  if (ownerCookie) headers.set("cookie", ownerCookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const body = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url.pathname} failed (${response.status}): ${body.slice(0, 600)}`);
  return (body ? JSON.parse(body) : undefined) as T;
}

async function ensureGoalAgentsReady(): Promise<PlatformFixture> {
  const snapshot = await apiJson<PlatformFixture>("/api/bootstrap");
  const createdAgent = snapshot.agents.length >= 4 ? null : await apiJson<AgentFixture>("/api/agents", {
    method: "POST",
    headers: { "Idempotency-Key": "goal-e2e-fourth-agent" },
    body: JSON.stringify({
      name: "Goal-E2E-Reviewer-B",
      description: "Disposable second independent Reviewer.",
      modelConnectorId: null,
      goalSummary: "Review Goal evidence independently.",
      toolsSummary: "No tools.",
      dataSummary: "Formal Meeting evidence only.",
      skillIds: [],
      toolGrants: [],
      toolPackGrants: [],
      runtimeProfileBinding: null,
      promptBinding: null
    })
  });
  const candidates = [...snapshot.agents, ...(createdAgent ? [createdAgent] : [])].slice(0, 4);
  if (candidates.length !== 4) throw new Error("Goal Run E2E requires four independent Agent identities.");

  const connectorA = await apiJson<{ id: string }>("/api/model-connectors", {
    method: "POST",
    headers: { "Idempotency-Key": "goal-e2e-model-connector-a" },
    body: JSON.stringify({
      name: "Goal E2E local model A",
      location: "local",
      baseUrl: "http://10.255.255.1:11434/v1",
      model: "goal-e2e-never-invoked-a"
    })
  });
  const connectorB = await apiJson<{ id: string }>("/api/model-connectors", {
    method: "POST",
    headers: { "Idempotency-Key": "goal-e2e-model-connector-b" },
    body: JSON.stringify({
      name: "Goal E2E local model B",
      location: "local",
      baseUrl: "http://10.255.255.2:11434/v1",
      model: "goal-e2e-never-invoked-b"
    })
  });
  const prompt = await apiJson<{ id: string; currentVersion: number; publishedVersion: number | null }>("/api/prompts", {
    method: "POST",
    headers: { "Idempotency-Key": "goal-e2e-prompt" },
    body: JSON.stringify({
      name: "Goal E2E meeting prompt",
      kind: "agent",
      description: "Disposable Goal Run browser fixture.",
      owner: "Playwright",
      content: "你是 {{AGENT_NAME}}，請針對 {{MEETING_GOAL}} 提供可驗證意見。",
      variables: ["AGENT_NAME", "MEETING_GOAL"]
    })
  });
  const currentPrompt = (await apiJson<PlatformFixture>("/api/bootstrap")).prompts?.find((candidate) => candidate.id === prompt.id);
  if (currentPrompt?.publishedVersion !== prompt.currentVersion) {
    await apiJson(`/api/prompts/${prompt.id}/publish`, {
      method: "POST",
      body: JSON.stringify({ expectedCurrentVersion: prompt.currentVersion, version: prompt.currentVersion })
    });
  }
  const runtimeProfile = await apiJson<{ id: string; revision: number }>("/api/runtime-profiles", {
    method: "POST",
    headers: { "Idempotency-Key": "goal-e2e-runtime-profile" },
    body: JSON.stringify({
      name: "Goal E2E text runtime",
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

  for (const [index, agent] of candidates.entries()) {
    const draft = await apiJson<AgentFixture>(`/api/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        expectedDraftRevision: agent.draftRevision,
        modelConnectorId: index % 2 === 0 ? connectorA.id : connectorB.id,
        promptBinding: { promptId: prompt.id, version: prompt.currentVersion },
        runtimeProfileBinding: { profileId: runtimeProfile.id, revision: runtimeProfile.revision }
      })
    });
    if (draft.publishedRevision !== draft.draftRevision) {
      await apiJson(`/api/agents/${agent.id}/publish`, {
        method: "POST",
        body: JSON.stringify({ expectedDraftRevision: draft.draftRevision })
      });
    }
  }
  return apiJson<PlatformFixture>("/api/bootstrap");
}

async function assertNoHorizontalPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

test("Goal control center keeps one canonical Meeting and preserves navigation context", async ({ page }) => {
  const browserErrors: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    try {
      const requestUrl = assertLoopbackHttpUrl(url, "Goal Run browser request");
      if (requestUrl.origin !== disposable.webUrl.origin) throw new Error("Browser request escaped the disposable gateway origin.");
      await route.continue();
    } catch (error) {
      browserErrors.push(`${url}: ${error instanceof Error ? error.message : "blocked"}`);
      await route.abort("blockedbyclient");
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  const login = await page.request.post(new URL("/api/v1/auth/login", disposable.webUrl).toString(), {
    data: { email: "owner@disposable.test", password: "disposable-owner-password" }
  });
  expect(login.ok()).toBe(true);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "council_session");
  if (!session) throw new Error("Disposable Owner login did not issue a session cookie.");
  ownerCookie = `council_session=${session.value}`;

  const snapshot = await ensureGoalAgentsReady();
  const category = snapshot.categories[0];
  if (!category) throw new Error("Disposable seed has no Goal Run category.");
  const title = `E2E 自治目標 ${Date.now()}`;
  const objective = "透過正式多代理會議形成可核准計畫，並在同一工作區追蹤執行狀態。";

  await test.step("create a Goal and its formal Meeting from the compact composer", async () => {
    await page.goto("/goals");
    await expect(page).toHaveTitle("Council");
    if (!await page.getByRole("heading", { name: "從目標開始" }).isVisible()) {
      await page.getByRole("button", { name: "新增目標" }).click();
    }
    await expect(page.getByRole("heading", { name: "從目標開始" })).toBeVisible();
    await page.getByRole("textbox", { name: "目標", exact: true }).fill(objective);
    await page.getByLabel("名稱", { exact: true }).fill(title);
    await page.getByLabel("討論分類").selectOption(category.id);
    await page.getByRole("button", { name: "建立目標與正式會議" }).click();
    await expect(page).toHaveURL(/\/goals\?goalId=[^&]+&view=overview/);
    await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "討論 → 決議 → 任務" })).toBeVisible();
    await expect(page.getByRole("link", { name: "進入正式會議" })).toBeVisible();
    await expect(page.getByRole("group", { name: "會議模式" })).toHaveCount(0);
    await page.reload();
    await expect(page).toHaveURL(/\/goals\?goalId=[^&]+&view=overview/);
    await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
  });

  const list = await apiJson<{ goalRuns: GoalRunFixture[] }>("/api/v1/goal-runs");
  const run = list.goalRuns.find((candidate) => candidate.title === title);
  if (!run) throw new Error("Created Goal Run was not returned by the real API.");
  const decision = await apiJson<{ id: string; title: string; description: string }>("/api/decisions", {
    method: "POST",
    headers: { "Idempotency-Key": `goal-e2e-decision-${run.id}` },
    body: JSON.stringify({
      meetingId: run.meetingId,
      title: "採用可追溯的 Goal Execution Contract",
      description: "會議決議、任務與證據必須保留相同 lineage。"
    })
  });
  const taskId = randomUUID();
  await apiJson(`/api/v1/goal-runs/${run.id}/plan`, {
    method: "PUT",
    body: JSON.stringify({
      expectedPlanRevision: 0,
      tasks: [{
        id: taskId,
        decisionId: decision.id,
        title: decision.title,
        description: decision.description,
        acceptanceCriteria: "Execution Contract、Task binding 與畫布節點都可追溯。",
        dependencyIds: [],
        assigneeAgentId: null,
        executionMode: "manual",
        allowedTools: [],
        dataScope: "正式會議逐字稿與已核准決議。",
        action: null
      }]
    })
  });

  await test.step("approve the immutable Plan and send an attributable Owner instruction", async () => {
    await page.reload();
    await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
    await expect(page.getByText("等待核准", { exact: true }).first()).toBeVisible();
    const approvalResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/v1/goal-runs/${run.id}/approve`
    ));
    await page.getByRole("button", { name: "核准執行" }).click();
    const approvalResponse = await approvalResponsePromise;
    const approvalBody = await approvalResponse.text();
    expect(approvalResponse.ok(), `Goal approval failed (${approvalResponse.status()}): ${approvalBody.slice(0, 600)}`).toBe(true);
    await expect(page.getByText("執行中", { exact: true }).first()).toBeVisible();
    await page.getByPlaceholder("補充限制、資料或執行指令").fill("Owner：保持正式會議紀錄與證據鏈。")
    await page.getByRole("button", { name: "送出 Owner 指令" }).click();
    await expect(page.getByText("Owner 指令已寫入正式會議與活動紀錄，於下次規劃生效。", { exact: true })).toBeVisible();
    const meeting = await apiJson<{ utterances: Array<{ speakerName: string; roleName: string | null; content: string }> }>(`/api/v1/meetings/${run.meetingId}/view`);
    expect(meeting.utterances).toEqual(expect.arrayContaining([
      expect.objectContaining({ speakerName: "Owner", roleName: "決策者", content: "Owner：保持正式會議紀錄與證據鏈。" })
    ]));
  });

  await test.step("inspect Activity and the three Canvas lenses", async () => {
    await page.getByRole("tab", { name: "目標事件" }).click();
    await expect(page).toHaveURL(new RegExp(`/goals\\?goalId=${run.id}&view=activity`));
    await expect(page.getByRole("heading", { name: "執行活動" })).toBeVisible();
    await expect(page.getByText("已核准執行契約")).toBeVisible();
    await page.getByRole("tab", { name: "執行畫布" }).click();
    await expect(page).toHaveURL(new RegExp(`/goals\\?goalId=${run.id}&view=canvas&lens=progress`));
    await expect(page.getByRole("heading", { name: "執行狀態" })).toBeVisible();
    for (const lens of ["進度", "協作", "資源"]) {
      await page.getByRole("tab", { name: lens }).click();
      await expect(page.locator(".react-flow")).toBeVisible();
    }
  });

  await test.step("pause and resume without losing Meeting or Goal state", async () => {
    await page.getByRole("button", { name: "暫停目標" }).click();
    await expect(page.getByText("已暫停", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "繼續目標" }).click();
    await expect(page.getByText("執行中", { exact: true }).first()).toBeVisible();
    await page.getByRole("tab", { name: "概覽" }).click();
    await page.getByRole("link", { name: "進入正式會議" }).click();
    await expect(page).toHaveURL(new RegExp(`meetingId=${run.meetingId}.*fromGoalId=${run.id}.*view=meeting`));
    await expect(page.getByText("此正式會議由 Goal Run 召集", { exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "會議模式" })).toBeVisible();
    await expect(page.getByLabel("主席協助模式")).toBeVisible();
    await expect(page.getByRole("log", { name: "會議逐字稿" })).toBeVisible();
    await page.getByRole("tab", { name: "活動" }).click();
    await expect(page).toHaveURL(new RegExp(`meetingId=${run.meetingId}.*fromGoalId=${run.id}.*view=activity`));
    await expect(page.getByRole("tab", { name: "活動" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "會議動態" })).toBeVisible();
    await page.getByRole("tab", { name: "畫布" }).click();
    await expect(page).toHaveURL(new RegExp(`meetingId=${run.meetingId}.*fromGoalId=${run.id}.*view=canvas&lens=progress`));
    await expect(page.getByRole("tab", { name: "畫布" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "進度關聯圖" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("tab", { name: "活動" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "會議動態" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("tab", { name: "會議" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("log", { name: "會議逐字稿" })).toBeVisible();
    await page.getByRole("link", { name: "回到目標" }).click();
    await expect(page).toHaveURL(new RegExp(`/goals\\?goalId=${run.id}&view=overview`));
    await expect(page.getByRole("heading", { name: "討論 → 決議 → 任務" })).toBeVisible();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: title, exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "執行畫布" }).click();
  await page.getByRole("tab", { name: "進度" }).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  const fullScreenButton = page.getByRole("button", { name: "全螢幕畫布" });
  await fullScreenButton.click();
  await expect(page.getByRole("dialog", { name: "Goal 全螢幕畫布" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(fullScreenButton).toBeFocused();
  await page.getByRole("tab", { name: "協作" }).click();
  const agentNode = page.locator(".goal-flow-node").filter({ hasText: "Agent" }).first();
  await expect(agentNode).toBeVisible();
  const agentName = (await agentNode.locator("strong").innerText()).trim();
  await agentNode.click();
  const agentLink = page.getByRole("link", { name: "查看 Agent" });
  await expect(agentLink).toHaveAttribute("href", new RegExp(`/agents\\?agentId=.*fromMeetingId=${run.meetingId}.*fromGoalId=${run.id}`));
  await assertNoHorizontalPageOverflow(page);
  await agentLink.click();
  await expect(page).toHaveURL(new RegExp(`/agents\\?agentId=.*fromMeetingId=${run.meetingId}.*fromGoalId=${run.id}`));
  await expect(page.getByText("目前從正式會議進入 Agent 管理", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "回到來源會議" })).toBeVisible();
  await expect(page.getByRole("link", { name: "回到目標" })).toBeVisible();
  await expect(page.getByRole("heading", { name: agentName, exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
});
