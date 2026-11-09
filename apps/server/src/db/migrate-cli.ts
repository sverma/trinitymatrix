import { loadRuntimeConfig } from "../config";
import { runMigrations } from "./migrate";
import { sqlMigrations } from "./migrations";
import { createPostgresPool } from "./pool";

const config = loadRuntimeConfig(process.env);
const pool = createPostgresPool(config, "trinitymatrix-migrations");

try {
  const result = await runMigrations(pool, sqlMigrations);
  process.stdout.write(
    `Database migrations complete: ${result.applied.length} applied, ${result.alreadyApplied.length} already present.\n`
  );
} finally {
  await pool.end();
}
