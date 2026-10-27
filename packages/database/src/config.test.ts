import { describe, expect, it, vi } from "vitest";
import { createPostgresPoolFromEnv } from "./config.js";

describe("PostgreSQL Pool configuration", () => {
  it("handles idle-client errors without terminating the process", async () => {
    const onError = vi.fn();
    const pool = await createPostgresPoolFromEnv({
      DATABASE_URL: "postgresql://agent:test@example.invalid:5432/agent",
      PGPOOL_MAX: "2"
    }, { onError });

    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    const error = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
    expect(() => pool.emit("error", error)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
    await pool.end();

    const defaultPool = await createPostgresPoolFromEnv({
      DATABASE_URL: "postgresql://agent:test@example.invalid:5432/agent"
    });
    expect(defaultPool.listenerCount("error")).toBeGreaterThan(0);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveMessage = "connection failed with secret test-only-database-password";
    expect(() => defaultPool.emit("error", Object.assign(new Error(sensitiveMessage), { code: "57P01" }))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    const record = String(log.mock.calls[0]?.[0]);
    expect(record).toContain('"event":"postgres.pool.idle_client_error"');
    expect(record).toContain('"code":"57P01"');
    expect(record).toContain('"errorType":"Error"');
    expect(record).not.toContain(sensitiveMessage);
    log.mockRestore();
    await defaultPool.end();
  });
});
