import { createPostgresPoolFromEnv } from "./config.js";
import {
  completeMeetingUtteranceBackfill,
  cutoverMeetingUtteranceProjection,
  migrateDatabase
} from "./migrations.js";

const pool = await createPostgresPoolFromEnv();
try {
  await migrateDatabase(pool);
  const backfill = await completeMeetingUtteranceBackfill(pool);
  const cutover = await cutoverMeetingUtteranceProjection(pool);
  process.stdout.write(
    `Database migrations applied; Utterance projection ${backfill.processedCount}/${backfill.sourceCount} complete with ${cutover.utteranceCount} durable rows.\n`
  );
} finally {
  await pool.end();
}
