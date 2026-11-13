import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostGameChatCipher } from "./chat-crypto";
import { runMigrations } from "./migrate";
import { PostgresApplicationRepository } from "./repository";
import { aiIdentityId, INITIAL_AI_ROSTER, PostgresAiStore } from "../ai-repository";

const databaseUrl = process.env.AI_RATINGS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("model-bound identities and composition ratings in PostgreSQL", () => {
  const schema = `trinity_ai_test_${randomUUID().replaceAll("-", "")}`;
  const legacyId = randomUUID();
  const humanIds = [randomUUID(), randomUUID()];
  const aiIds = [randomUUID(), randomUUID()];
  const startedAt = new Date("2026-11-13T10:00:00Z");
  const endedAt = new Date("2026-11-13T10:15:00Z");
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let repository: PostgresApplicationRepository;

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.toLowerCase().includes("test")) {
      throw new Error("AI_RATINGS_TEST_DATABASE_URL must name an isolated test database.");
    }
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const migration = (name: string) => ({
      name, sql: readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
    });
    const previous = [
      "0001_core_persistence.sql", "0002_post_game_chat.sql", "0003_private_matches.sql",
      "0004_distributed_game_runtime.sql", "0005_matchmaking_ticket_liveness.sql",
      "0006_replay_exports.sql", "0007_admin_passkeys.sql"
    ].map(migration);
    await runMigrations(pool, previous);
    await pool.query("INSERT INTO app_users (id, email) VALUES ($1, $2)", [legacyId, `${legacyId}@example.test`]);
    await pool.query("INSERT INTO player_profiles (user_id, display_name) VALUES ($1, 'Legacy player')", [legacyId]);
    await pool.query(
      "INSERT INTO player_rankings (user_id, rating, games_played, wins, losses) VALUES ($1, 1250, 4, 3, 1)",
      [legacyId]
    );
    await runMigrations(pool, [...previous, migration("0008_model_bound_ai_players.sql")]);
    repository = new PostgresApplicationRepository(pool, new PostGameChatCipher(Buffer.alloc(32, 9).toString("base64"), 1));
    for (const [index, id] of humanIds.entries()) {
      await repository.upsertUserProfile({
        id, email: `${id}@example.test`, displayName: `Human ${index}`, badgeId: "rookie", phone: null
      });
    }
    for (const [index, id] of aiIds.entries()) {
      await pool.query("INSERT INTO app_users (id, email, actor_kind) VALUES ($1, $2, 'ai')", [id, `${id}@agents.example.test`]);
      await pool.query("INSERT INTO player_profiles (user_id, display_name) VALUES ($1, $2)", [id, `AI ${index}`]);
      await pool.query(
        "INSERT INTO ai_agents (user_id, model_id, model_name) VALUES ($1, $2, $3)",
        [id, `provider/model-${index}`, `Model ${index}`]
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it("preserves pre-existing human ratings during the upgrade", async () => {
    const rating = await pool!.query("SELECT * FROM player_rankings_by_composition WHERE user_id = $1", [legacyId]);
    expect(rating.rows).toMatchObject([{ composition: "human", rating: 1250, games_played: 4, wins: 3, losses: 1 }]);
  });

  it("keeps human, AI, and mixed Elo histories independent and completion idempotent", async () => {
    const complete = async (players: string[], suffix: string) => {
      const matchId = randomUUID();
      await repository.createMatch({
        id: matchId, publicName: `rating-match-${suffix}`, playerCount: 2, startedAt,
        participants: players.map((id, seatNumber) => ({
          userId: id, seatNumber, displayName: `Player ${seatNumber}`, badgeId: "rookie"
        }))
      });
      const input = {
        matchId, winnerUserId: players[0]!, endReason: "declaration" as const, endedAt,
        participantOutcomes: [
          { userId: players[0]!, outcome: "won" as const },
          { userId: players[1]!, outcome: "lost" as const }
        ]
      };
      const first = await repository.completeMatchAndUpdateRatings(input);
      const retry = await repository.completeMatchAndUpdateRatings(input);
      expect(retry).toEqual(first);
      expect(first.participants.map(({ ratingAfter }) => ratingAfter)).toEqual([1016, 984]);
    };
    await complete(humanIds, "12345671");
    await complete([humanIds[0]!, aiIds[0]!], "12345672");
    await complete(aiIds, "12345673");
    const ratings = await pool!.query(
      `SELECT user_id, composition, rating, games_played FROM player_rankings_by_composition
       WHERE user_id = ANY($1::uuid[]) ORDER BY user_id, composition`,
      [[...humanIds, ...aiIds]]
    );
    expect(ratings.rows).toHaveLength(6);
    expect(ratings.rows).toEqual(expect.arrayContaining([
      { user_id: humanIds[0], composition: "human", rating: 1016, games_played: 1 },
      { user_id: humanIds[0], composition: "mixed", rating: 1016, games_played: 1 },
      { user_id: humanIds[1], composition: "human", rating: 984, games_played: 1 },
      { user_id: aiIds[0], composition: "mixed", rating: 984, games_played: 1 },
      { user_id: aiIds[0], composition: "ai", rating: 1016, games_played: 1 },
      { user_id: aiIds[1], composition: "ai", rating: 984, games_played: 1 }
    ]));
    const legacy = await pool!.query("SELECT rating, games_played FROM player_rankings WHERE user_id = $1", [humanIds[0]]);
    expect(legacy.rows).toEqual([{ rating: 1016, games_played: 1 }]);
    const humanBoard = await repository.listRankings({ composition: "human" });
    const aiBoard = await repository.listRankings({ composition: "ai" });
    const mixedBoard = await repository.listRankings({ composition: "mixed" });
    expect(humanBoard.items.every(({ actorKind }) => actorKind === "human")).toBe(true);
    expect(aiBoard.items.map(({ userId }) => userId)).toEqual([aiIds[0], aiIds[1]]);
    expect(aiBoard.items.every(({ actorKind, modelId }) => actorKind === "ai" && modelId?.startsWith("provider/model-"))).toBe(true);
    expect(mixedBoard.items.map(({ userId }) => userId)).toEqual([humanIds[0], aiIds[0]]);
  });

  it("prevents changing identity kind, model, or prompt version after creation", async () => {
    await expect(pool!.query("UPDATE app_users SET actor_kind = 'ai' WHERE id = $1", [humanIds[0]]))
      .rejects.toThrow("cannot change between human and AI");
    await expect(pool!.query("UPDATE ai_agents SET model_id = 'provider/other' WHERE user_id = $1", [aiIds[0]]))
      .rejects.toThrow("permanently bound");
    await expect(pool!.query("UPDATE ai_agents SET prompt_version = 'trinity-v2' WHERE user_id = $1", [aiIds[0]]))
      .rejects.toThrow("permanently bound");
    await expect(pool!.query("UPDATE ai_agents SET memory = 'remember public moves' WHERE user_id = $1", [aiIds[0]]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(pool!.query(
      "INSERT INTO ai_agents (user_id, model_id, model_name) VALUES ($1, 'provider/model-human', 'Invalid agent')",
      [humanIds[1]]
    )).rejects.toThrow();
  });

  it("provisions stable model identities idempotently and retains memory across store instances", async () => {
    const store = new PostgresAiStore(pool!);
    await store.provision();
    const id = aiIdentityId(INITIAL_AI_ROSTER[0].modelId);
    await store.saveMemory(id, "Use only observed public moves; remember the last match's strategy.");
    await store.provision();
    const restartedStore = new PostgresAiStore(pool!);
    const agents = await restartedStore.listAgents();
    for (const configured of INITIAL_AI_ROSTER) {
      expect(agents.filter(({ id: candidate }) => candidate === aiIdentityId(configured.modelId))).toHaveLength(1);
      expect(agents.find(({ id: candidate }) => candidate === aiIdentityId(configured.modelId)))
        .toMatchObject({ modelId: configured.modelId, enabled: true });
    }
    expect(agents.find(({ id: candidate }) => candidate === id)?.memory)
      .toBe("Use only observed public moves; remember the last match's strategy.");
    expect(aiIdentityId(INITIAL_AI_ROSTER[0].modelId)).not.toBe(aiIdentityId(INITIAL_AI_ROSTER[1].modelId));
    await expect(store.saveMemory(id, "x".repeat(4001))).rejects.toThrow("too long");
  });

  it("atomically enforces one shared daily budget across parallel agents and keeps unknown failed costs reserved", async () => {
    const store = new PostgresAiStore(pool!);
    const id = aiIdentityId(INITIAL_AI_ROSTER[0].modelId);
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const configured = INITIAL_AI_ROSTER[index % INITIAL_AI_ROSTER.length]!;
      return store.reserveRequest(aiIdentityId(configured.modelId), configured.modelId, 0.10);
    }));
    const accepted = attempts.filter((value): value is string => value !== null);
    expect(accepted).toHaveLength(2);
    expect(new Set(accepted).size).toBe(2);
    expect(await store.budgetAvailable(0.10)).toBe(false);
    await store.finishRequest(accepted[0]!, null, false);
    const failed = await pool!.query("SELECT status, actual_usd, reserved_usd FROM ai_model_requests WHERE id=$1", [accepted[0]]);
    expect(failed.rows).toEqual([{ status: "failed", actual_usd: null, reserved_usd: "0.050000" }]);
    expect(await store.reserveRequest(id, INITIAL_AI_ROSTER[0].modelId, 0.10)).toBeNull();
    await store.finishRequest(accepted[0]!, 0, true);
    const replay = await pool!.query("SELECT status, actual_usd FROM ai_model_requests WHERE id=$1", [accepted[0]]);
    expect(replay.rows).toEqual([{ status: "failed", actual_usd: null }]);
    // A completed response with known lower cost releases only its unused allocation.
    await store.finishRequest(accepted[1]!, 0.01, true);
    expect(await store.budgetAvailable(0.10)).toBe(false);
    await expect(store.finishRequest(accepted[1]!, -1, true)).rejects.toThrow("Invalid model usage cost");
  });

  it("starts a fresh UTC-day allowance and refuses disabled, suspended, or incorrectly bound agents", async () => {
    const store = new PostgresAiStore(pool!);
    await pool!.query("UPDATE ai_model_requests SET budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1");
    expect(await store.budgetAvailable(0.10)).toBe(true);
    const configured = INITIAL_AI_ROSTER[0];
    const id = aiIdentityId(configured.modelId);
    const request = await store.reserveRequest(id, configured.modelId, 0.10);
    expect(request).toBeTypeOf("string");
    const ledgerDate = await pool!.query(
      "SELECT budget_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AS is_today FROM ai_model_requests WHERE id=$1",
      [request]
    );
    expect(ledgerDate.rows).toEqual([{ is_today: true }]);
    await pool!.query("UPDATE ai_agents SET enabled=false WHERE user_id=$1", [id]);
    expect(await store.reserveRequest(id, configured.modelId, 100)).toBeNull();
    expect((await store.listAgents()).find(({ id: candidate }) => candidate === id)?.enabled).toBe(false);
    await pool!.query("UPDATE ai_agents SET enabled=true WHERE user_id=$1", [id]);
    await pool!.query("UPDATE app_users SET suspended_at=clock_timestamp(), suspension_reason='Integration test' WHERE id=$1", [id]);
    expect(await store.reserveRequest(id, configured.modelId, 100)).toBeNull();
    expect((await store.listAgents()).find(({ id: candidate }) => candidate === id)?.enabled).toBe(false);
    await pool!.query("UPDATE app_users SET suspended_at=NULL, suspension_reason=NULL WHERE id=$1", [id]);
    expect(await store.reserveRequest(id, "provider/different-model", 100)).toBeNull();
  });
});
