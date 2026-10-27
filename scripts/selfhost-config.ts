import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SelfHostInitializationOptions {
  uid: number;
  gid: number;
}

function environmentFile({ uid, gid }: SelfHostInitializationOptions): string {
  return `RELEASE_VERSION=dev
RELEASE_ROOT=..
DATA_ROOT=./data
SECRETS_ROOT=./secrets
PUBLIC_ORIGIN=http://127.0.0.1:8787
COUNCIL_PORT=8787
COUNCIL_SOURCE_URL=
APP_UID=${uid}
APP_GID=${gid}

AUTH_DISABLED=false
ALLOW_PRODUCTION_AUTH_BYPASS=false
TAILNET_QUICK_LOGIN_ENABLED=false
TAILNET_QUICK_LOGIN_IDENTITY=
TAILNET_QUICK_LOGIN_OWNER_EMAIL=
MCP_LOCAL_HOST_ALLOWLIST=mcp-readonly
MCP_ARGUMENT_ENCRYPTION_WRITE_ENABLED=true
MCP_KEYED_FINGERPRINT_WRITE_ENABLED=true
MCP_LEGACY_ARGUMENT_READER_ENABLED=true
GOAL_RUN_AUTONOMY_ENABLED=false
OMP_RUNTIME_ENABLED=false
OMP_HOST_TOOLS_ENABLED=false
OMP_SUBAGENTS_ENABLED=false
OMP_SANDBOX_PROFILE_ID=
OMP_RUNTIME_IMAGE_DIGEST=
OMP_BROKER_IMAGE_DIGEST=
OMP_WORKSPACE_SOURCE_ID=
OMP_WORKSPACE_ARCHIVE_DIGEST=
HARNESS_ACTION_ADAPTER_ENABLED=false
HARNESS_ACTION_ADAPTER_ENDPOINT_ALLOWLIST=
GOVERNANCE_PROVIDER=native
GOVERNANCE_MODE=off
GOVERNANCE_TIMEOUT_MS=2000
GOVERNANCE_ACS_MANIFEST_PATH=/etc/council/governance/acs-mcp-readonly.manifest.yaml
GOVERNANCE_ACS_POLICY_ARTIFACT_PATHS=/etc/council/governance/policy
GOVERNANCE_ACS_EXPECTED_POLICY_DIGEST=sha256:29f8adb7a73ff7811bd286c4b8adc47014ed7a23f21d35e0c5b735484bf60744
MODEL_TUNNEL_SSH_HOST=
MODEL_TUNNEL_SSH_PORT=22
MODEL_TUNNEL_SSH_USER=
MODEL_TUNNEL_TARGET_HOST=127.0.0.1
MODEL_TUNNEL_TARGET_PORT=4001
`;
}

async function createNew(path: string, content: string, mode: number, created: string, result: string[]): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx", mode });
    result.push(created);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function initializeSelfHost(root: string, options: SelfHostInitializationOptions): Promise<{ created: string[] }> {
  const deploy = join(root, "deploy");
  const secrets = join(deploy, "secrets");
  const data = join(deploy, "data");
  await mkdir(secrets, { recursive: true, mode: 0o700 });
  await mkdir(data, { recursive: true, mode: 0o700 });

  const created: string[] = [];
  await createNew(join(deploy, ".env"), environmentFile(options), 0o600, "deploy/.env", created);
  await createNew(join(secrets, "postgres_password"), `${randomBytes(32).toString("base64url")}\n`, 0o444, "deploy/secrets/postgres_password", created);
  await createNew(join(secrets, "app_master_key"), `${randomBytes(32).toString("base64")}\n`, 0o444, "deploy/secrets/app_master_key", created);
  await createNew(join(secrets, "task_adapter_token"), `${randomBytes(32).toString("base64url")}\n`, 0o444, "deploy/secrets/task_adapter_token", created);
  await createNew(join(secrets, "sandbox_broker_token"), `${randomBytes(32).toString("base64url")}\n`, 0o444, "deploy/secrets/sandbox_broker_token", created);
  return { created };
}
