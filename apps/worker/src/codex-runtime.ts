import { mkdir } from "node:fs/promises";
import { CodexCliAgentHarness } from "@council/runtime";

const CODEX_WORK_DIRECTORY = "/tmp/council-codex/work";
const CODEX_HOME_DIRECTORY = "/tmp/council-codex/home";

export async function createCodexRuntimeHarness(
  environment: NodeJS.ProcessEnv
): Promise<CodexCliAgentHarness | null> {
  if (environment.CODEX_CLI_HARNESS_ENABLED !== "true") return null;

  await Promise.all([
    mkdir(CODEX_WORK_DIRECTORY, { recursive: true, mode: 0o700 }),
    mkdir(CODEX_HOME_DIRECTORY, { recursive: true, mode: 0o700 })
  ]);
  return new CodexCliAgentHarness({
    enabled: true,
    workingDirectory: CODEX_WORK_DIRECTORY,
    environment: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: CODEX_HOME_DIRECTORY,
      CODEX_HOME: CODEX_HOME_DIRECTORY,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1"
    }
  });
}
