import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type SqlMigration = Readonly<{ name: string; sql: string }>;
export type MigrationResult = Readonly<{ applied: readonly string[]; alreadyApplied: readonly string[] }>;

const migrationNamePattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const migrationLockId = "824667773549";

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function validateMigrations(migrations: readonly SqlMigration[]): void {
  const names = migrations.map(({ name }) => name);
  if (names.some((name) => !migrationNamePattern.test(name))) {
    throw new Error("Migration names must match NNNN_lowercase_name.sql.");
  }
  if (new Set(names).size !== names.length) throw new Error("Migration names must be unique.");
  const sorted = [...names].sort();
  if (names.some((name, index) => name !== sorted[index])) {
    throw new Error("Migrations must be supplied in lexical order.");
  }
  if (migrations.some(({ sql }) => sql.trim().length === 0)) throw new Error("Migrations cannot be empty.");
}

async function applyMigration(client: PoolClient, migration: SqlMigration, digest: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '5min'");
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO schema_migrations (name, checksum)
       VALUES ($1, $2)`,
      [migration.name, digest]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(
  pool: Pick<Pool, "connect">,
  migrations: readonly SqlMigration[]
): Promise<MigrationResult> {
  validateMigrations(migrations);
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  let locked = false;

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )
    `);
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [migrationLockId]
    );
    locked = lockResult.rows[0]?.acquired === true;
    if (!locked) throw new Error("Another database migration process currently holds the migration lock.");

    for (const migration of migrations) {
      const digest = checksum(migration.sql);
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name = $1",
        [migration.name]
      );
      const storedChecksum = existing.rows[0]?.checksum;
      if (storedChecksum) {
        if (storedChecksum !== digest) {
          throw new Error(`Applied migration ${migration.name} has been modified.`);
        }
        alreadyApplied.push(migration.name);
        continue;
      }
      await applyMigration(client, migration, digest);
      applied.push(migration.name);
    }
    return { applied, alreadyApplied };
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [migrationLockId]).catch(() => undefined);
    }
    client.release();
  }
}
