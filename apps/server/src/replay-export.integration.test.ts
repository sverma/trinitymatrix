import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./db/migrate";
import {
  PostgresReplayExportLedger,
  ReplayExportWorker,
  type ReplayObjectStore
} from "./replay-export";

const databaseUrl = process.env.REPLAY_EXPORT_TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgreSQL replay export integration", () => {
  let pool: Pool;
  const firstUser = randomUUID();
  const secondUser = randomUUID();
  const matchId = randomUUID();
  const eventId = randomUUID();
  const publicName = `amber-lotus-${randomInt(10_000_000, 100_000_000)}`;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!parsed.pathname.toLowerCase().includes("test")) {
      throw new Error("REPLAY_EXPORT_TEST_DATABASE_URL must target a dedicated database whose name contains 'test'.");
    }
    pool = new Pool({ connectionString: databaseUrl });
    const names = [
      "0001_core_persistence.sql",
      "0002_post_game_chat.sql",
      "0003_private_matches.sql",
      "0004_distributed_game_runtime.sql",
      "0005_matchmaking_ticket_liveness.sql",
      "0006_replay_exports.sql"
    ];
    await runMigrations(pool, names.map((name) => ({
      name,
      sql: readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
    })));
    for (const [userId, displayName] of [[firstUser, "Asha"], [secondUser, "Bela"]]) {
      await pool.query("INSERT INTO app_users (id, email) VALUES ($1, $2)", [userId, `${userId}@example.test`]);
      await pool.query(
        "INSERT INTO player_profiles (user_id, display_name, badge_id) VALUES ($1, $2, 'rookie')",
        [userId, displayName]
      );
      await pool.query("INSERT INTO player_rankings (user_id) VALUES ($1)", [userId]);
    }
    await pool.query(
      `INSERT INTO ranking_matches (id, public_name, player_count, match_type, started_at)
       VALUES ($1, $2, 2, 'general', '2026-08-31T10:00:00.000Z')`,
      [matchId, publicName]
    );
    await pool.query(
      `INSERT INTO match_participants (match_id, user_id, seat_number, display_name, badge_id)
       VALUES ($1, $2, 0, 'Asha', 'rookie'), ($1, $3, 1, 'Bela', 'rookie')`,
      [matchId, firstUser, secondUser]
    );
    await pool.query(
      `INSERT INTO game_events (
         event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
       ) VALUES ($1, $2, 1, 'game.started', NULL, NULL, '{"state":{"revision":1}}'::jsonb,
                 '2026-08-31T10:00:00.000Z')`,
      [eventId, matchId]
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE match_participants
         SET outcome = CASE WHEN user_id = $2 THEN 'won' ELSE 'lost' END,
             score_delta = CASE WHEN user_id = $2 THEN 16 ELSE -16 END,
             rating_after = CASE WHEN user_id = $2 THEN 1016 ELSE 984 END
         WHERE match_id = $1`,
        [matchId, firstUser]
      );
      await client.query(
        `UPDATE ranking_matches
         SET status = 'completed', winner_user_id = $2, end_reason = 'declaration',
             ended_at = '2026-08-31T10:15:00.000Z'
         WHERE id = $1`,
        [matchId, firstUser]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enqueues completion atomically and exports one content-addressed object", async () => {
    const pending = await pool.query<{ exported_at: Date | null; export_attempts: number; available_at: Date }>(
      "SELECT exported_at, export_attempts, available_at FROM replay_exports WHERE match_id = $1",
      [matchId]
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]).toMatchObject({ exported_at: null, export_attempts: 0 });

    const objects = new Map<string, Uint8Array>();
    const store: ReplayObjectStore = {
      putIfAbsent: async (input) => {
        if (!objects.has(input.key)) objects.set(input.key, input.body);
        return { etag: "integration-etag", versionId: "integration-version" };
      }
    };
    const worker = new ReplayExportWorker(
      new PostgresReplayExportLedger(pool),
      store,
      "integration-worker",
      (error) => { throw error; }
    );
    const exportedAt = new Date(pending.rows[0]!.available_at.getTime() + 1_000);
    await worker.runOnce(exportedAt);
    await worker.runOnce(new Date(exportedAt.getTime() + 1_000));

    expect(objects.size).toBe(1);
    const exported = await pool.query<{
      content_sha256: string;
      object_key: string;
      event_count: string;
      export_attempts: number;
      exported_at: Date;
    }>(
      `SELECT content_sha256, object_key, event_count, export_attempts, exported_at
       FROM replay_exports WHERE match_id = $1`,
      [matchId]
    );
    expect(exported.rows[0]).toMatchObject({ event_count: "1", export_attempts: 1, exported_at: exportedAt });
    expect(exported.rows[0]!.object_key).toContain(exported.rows[0]!.content_sha256);
  });
});
