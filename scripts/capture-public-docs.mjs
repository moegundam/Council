import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const baseURL = process.env.COUNCIL_SCREENSHOT_BASE_URL ?? "http://127.0.0.1:3000";
const output = join(process.cwd(), "apps", "web", "public", "docs");
const captures = [
  ["platform-overview.png", "/"],
  ["discussion-taxonomy.jpg", "/"],
  ["topic-search.jpg", "/"],
  ["meeting-preset.jpg", "/"],
  ["meeting-agenda.jpg", "/"],
  ["chair-assistance.png", "/"],
  ["agent-management.png", "/agents"],
  ["role-management.jpg", "/settings"],
  ["settings-registry.png", "/settings"],
  ["skill-governance.png", "/settings"],
  ["mcp-tools.jpg", "/settings"],
  ["task-adapter.jpg", "/tasks"],
  ["task-agent.png", "/tasks"],
  ["task-history.jpg", "/tasks"]
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
for (const [filename, route] of captures) {
  await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: join(output, filename), fullPage: false, animations: "disabled" });
  process.stdout.write(`Captured ${filename} from ${route}\n`);
}
await browser.close();
