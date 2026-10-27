import { readFile } from "node:fs/promises";
import { Pool, type PoolConfig } from "pg";

export interface PostgresPoolOptions {
  onError?: (error: Error) => void;
}

async function secretValue(value: string | undefined, file: string | undefined): Promise<string | undefined> {
  if (value) return value;
  if (!file) return undefined;
  return (await readFile(file, "utf8")).trim();
}

function defaultPostgresPoolErrorHandler(error: Error): void {
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "postgres.pool.idle_client_error",
    code,
    errorType: error.name
  }));
}

function monitoredPool(config: PoolConfig, options: PostgresPoolOptions): Pool {
  const pool = new Pool(config);
  pool.on("error", options.onError ?? defaultPostgresPoolErrorHandler);
  return pool;
}

export async function createPostgresPoolFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: PostgresPoolOptions = {}
): Promise<Pool> {
  if (env.DATABASE_URL) {
    return monitoredPool({ connectionString: env.DATABASE_URL, max: Number(env.PGPOOL_MAX ?? 10) }, options);
  }

  const password = await secretValue(env.PGPASSWORD, env.POSTGRES_PASSWORD_FILE);
  if (!env.PGHOST || !env.PGDATABASE || !env.PGUSER || !password) {
    throw new Error("PostgreSQL configuration is incomplete.");
  }

  const config: PoolConfig = {
    host: env.PGHOST,
    port: Number(env.PGPORT ?? 5432),
    database: env.PGDATABASE,
    user: env.PGUSER,
    password,
    max: Number(env.PGPOOL_MAX ?? 10)
  };
  return monitoredPool(config, options);
}
