import type { Pool, QueryResult, QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runMigrations, type SqlMigration } from "./migrate";

function result<Row extends QueryResultRow>(rows: Row[] = [], rowCount = rows.length): QueryResult<Row> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

class MigrationClient {
  readonly applied = new Map<string, string>();
  readonly rawSql: string[] = [];
  released = false;
  lockAvailable = true;

  async query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>> {
    if (text.includes("pg_try_advisory_lock")) {
      return result([{ acquired: this.lockAvailable }] as unknown as Row[]);
    }
    if (text.includes("pg_advisory_unlock")) return result<Row>();
    if (text.includes("SELECT checksum FROM schema_migrations")) {
      const checksum = this.applied.get(String(values?.[0]));
      return result(checksum ? [{ checksum }] as unknown as Row[] : []);
    }
    if (text.includes("INSERT INTO schema_migrations")) {
      this.applied.set(String(values?.[0]), String(values?.[1]));
      return result<Row>([], 1);
    }
    if (!text.includes("schema_migrations") && !["BEGIN", "COMMIT", "ROLLBACK"].includes(text)
      && !text.startsWith("SET LOCAL")) {
      this.rawSql.push(text);
    }
    return result<Row>();
  }

  release(): void {
    this.released = true;
  }
}

function poolFor(client: MigrationClient): Pick<Pool, "connect"> {
  return { connect: async () => client } as unknown as Pick<Pool, "connect">;
}

const migrations: readonly SqlMigration[] = [
  { name: "0001_users.sql", sql: "CREATE TABLE users(id uuid PRIMARY KEY)" },
  { name: "0002_matches.sql", sql: "CREATE TABLE matches(id uuid PRIMARY KEY)" }
];

describe("database migration runner", () => {
  it("applies ordered migrations once and verifies their checksums on retry", async () => {
    const firstClient = new MigrationClient();
    const first = await runMigrations(poolFor(firstClient), migrations);
    expect(first).toEqual({ applied: ["0001_users.sql", "0002_matches.sql"], alreadyApplied: [] });
    expect(firstClient.rawSql).toEqual(migrations.map(({ sql }) => sql));
    expect(firstClient.released).toBe(true);

    const retryClient = new MigrationClient();
    retryClient.applied.set("0001_users.sql", firstClient.applied.get("0001_users.sql")!);
    retryClient.applied.set("0002_matches.sql", firstClient.applied.get("0002_matches.sql")!);
    const retry = await runMigrations(poolFor(retryClient), migrations);
    expect(retry).toEqual({ applied: [], alreadyApplied: ["0001_users.sql", "0002_matches.sql"] });
    expect(retryClient.rawSql).toEqual([]);
  });

  it("fails closed for a modified applied migration or a concurrent runner", async () => {
    const modified = new MigrationClient();
    modified.applied.set("0001_users.sql", "0".repeat(64));
    await expect(runMigrations(poolFor(modified), migrations)).rejects.toThrow("has been modified");

    const busy = new MigrationClient();
    busy.lockAvailable = false;
    await expect(runMigrations(poolFor(busy), migrations)).rejects.toThrow("currently holds the migration lock");
  });

  it("keeps private matches forward-only, typed, indexed, and linked by a private-only composite key", () => {
    const privateSql = readFileSync(new URL("../../migrations/0003_private_matches.sql", import.meta.url), "utf8");
    expect(privateSql).toContain("match_type text NOT NULL DEFAULT 'general'");
    expect(privateSql).toContain("CHECK (match_type = 'private')");
    expect(privateSql).toContain("FOREIGN KEY (match_id, match_type)");
    expect(privateSql).toContain("FOREIGN KEY (accepted_by_user_id, invite_email)");
    expect(privateSql).toContain("private_match_rooms_waiting_idx");
    expect(privateSql).toContain("private_match_invitations_open_email_idx");
  });

  it("adds fenced ownership, transactional outbox, recoverable timers, and distributed queue primitives additively", () => {
    const runtimeSql = readFileSync(new URL("../../migrations/0004_distributed_game_runtime.sql", import.meta.url), "utf8");
    expect(runtimeSql).toContain("CREATE TABLE game_runtime_owners");
    expect(runtimeSql).toContain("fencing_token bigint NOT NULL");
    expect(runtimeSql).toContain("CREATE TABLE durable_game_commands");
    expect(runtimeSql).toContain("CREATE TABLE game_event_outbox");
    expect(runtimeSql).toContain("CREATE TABLE recoverable_game_deadlines");
    expect(runtimeSql).toContain("CREATE TABLE distributed_matchmaking_tickets");
    expect(runtimeSql).toContain("distributed_matchmaking_player_waiting_unique");
    expect(runtimeSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it("adds backward-compatible ticket heartbeat and expiry columns", () => {
    const livenessSql = readFileSync(new URL("../../migrations/0005_matchmaking_ticket_liveness.sql", import.meta.url), "utf8");
    expect(livenessSql).toContain("ADD COLUMN expires_at timestamptz NOT NULL");
    expect(livenessSql).toContain("ADD COLUMN heartbeat_at timestamptz NOT NULL");
    expect(livenessSql).toContain("DEFAULT (clock_timestamp() + interval '90 seconds')");
    expect(livenessSql).toContain("distributed_matchmaking_live_waiting_idx");
    expect(livenessSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
  });

  it("additively enqueues completed matches for durable replay export", () => {
    const exportSql = readFileSync(new URL("../../migrations/0006_replay_exports.sql", import.meta.url), "utf8");
    expect(exportSql).toContain("CREATE TABLE replay_exports");
    expect(exportSql).toContain("CREATE TRIGGER ranking_matches_enqueue_replay_export");
    expect(exportSql).toContain("AFTER UPDATE OF status ON ranking_matches");
    expect(exportSql).toContain("WHERE status = 'completed'");
    expect(exportSql).toContain("ON CONFLICT (match_id) DO NOTHING");
    expect(exportSql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TRIGGER|FUNCTION)/i);
  });
});
