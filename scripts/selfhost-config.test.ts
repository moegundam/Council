import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeSelfHost } from "./selfhost-config.js";

describe("self-host initialization", () => {
  it("creates local configuration and secrets without overwriting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-selfhost-"));
    const first = await initializeSelfHost(root, { uid: 1234, gid: 5678 });
    expect(first.created).toContain("deploy/.env");
    expect(await readFile(join(root, "deploy/.env"), "utf8")).toContain("APP_UID=1234\nAPP_GID=5678");
    const secret = join(root, "deploy/secrets/app_master_key");
    expect(Buffer.from((await readFile(secret, "utf8")).trim(), "base64")).toHaveLength(32);
    expect((await stat(secret)).mode & 0o777).toBe(0o444);

    await chmod(secret, 0o600);
    await writeFile(secret, "operator-owned-secret\n");
    const second = await initializeSelfHost(root, { uid: 9, gid: 9 });
    expect(second.created).toEqual([]);
    expect(await readFile(secret, "utf8")).toBe("operator-owned-secret\n");
    expect(await readFile(join(root, "deploy/.env"), "utf8")).toContain("APP_UID=1234\nAPP_GID=5678");
  });

  it("does not create optional model tunnel credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "council-selfhost-"));
    await initializeSelfHost(root, { uid: 1000, gid: 1000 });
    await expect(readFile(join(root, "deploy/secrets/model_tunnel_key"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
