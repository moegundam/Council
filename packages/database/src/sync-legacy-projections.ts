import { createPostgresPoolFromEnv } from "./config.js";
import { synchronizeMeetingUtterancesToPlatformState } from "./migrations.js";

const pool = await createPostgresPoolFromEnv();
try {
  const result = await synchronizeMeetingUtterancesToPlatformState(pool);
  process.stdout.write(
    `Legacy projection synchronized: ${result.utteranceCount} Utterances at platform revision ${result.platformRevision}.\n`
  );
} finally {
  await pool.end();
}
