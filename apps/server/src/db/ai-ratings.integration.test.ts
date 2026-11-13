import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostGameChatCipher } from "./chat-crypto";
import { runMigrations } from "./migrate";
import { PostgresApplicationRepository } from "./repository";
import { AI_CURRENT_IDENTITY_VERSION, AI_LEGACY_IDENTITY_VERSION, aiIdentityId, INITIAL_AI_ROSTER, PostgresAiStore } from "../ai-repository";
import { AI_GAME_PROTOCOL_DESCRIPTOR, AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_LEGACY_V1_PROTOCOL_DESCRIPTOR } from "../ai-game-protocol";
import { AI_VALIDATION_IDENTITY_VERSION, AI_VALIDATION_TOOL_VERSION } from "../ai-game-protocol-v3";

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
    await runMigrations(pool, [...previous, migration("0008_model_bound_ai_players.sql"), migration("0009_live_broadcasts.sql"), migration("0010_ai_protocol_provenance.sql")]);
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

  it("expands the roster while retaining existing identities, memory, ratings and operator disable flags", async () => {
    const store = new PostgresAiStore(pool!);
    const inheritedModelIds = new Set(["anthropic/claude-haiku-5.5", "google/gemini-3.8-flash", "deepseek/deepseek-v3.2", "qwen/qwen3.8-flash", "mistralai/mistral-small-2603"]);
    const inheritedRoster = INITIAL_AI_ROSTER.filter(({ modelId }) => inheritedModelIds.has(modelId));
    const retiredModelId = "deepseek/deepseek-v4.1-flash-1017";
    const retiredId = aiIdentityId(retiredModelId, AI_LEGACY_IDENTITY_VERSION);
    const disabledId = aiIdentityId("deepseek/deepseek-v3.2", AI_LEGACY_IDENTITY_VERSION);
    const suspendedId = aiIdentityId("qwen/qwen3.8-flash", AI_LEGACY_IDENTITY_VERSION);
    const latestDisabledModel = "mistralai/mistral-small-2603";
    for (const configured of [...inheritedRoster, {
      modelId: retiredModelId, modelName: "Retired DeepSeek Flash", displayName: "Retired Flash AI"
    }]) {
      const userId = aiIdentityId(configured.modelId, AI_LEGACY_IDENTITY_VERSION);
      await pool!.query("INSERT INTO app_users (id, email, actor_kind) VALUES ($1, $2, 'ai')", [userId, `agent-${userId}@ai.trinitymatrix.invalid`]);
      await pool!.query("INSERT INTO player_profiles (user_id, display_name) VALUES ($1, $2)", [userId, configured.displayName]);
      await pool!.query(
        "INSERT INTO ai_agents (user_id, model_id, model_name, prompt_version, memory, enabled) VALUES ($1, $2, $3, $4, $5, $6)",
        [userId, configured.modelId, configured.modelName, AI_LEGACY_IDENTITY_VERSION, `Existing notes for ${configured.modelId}`, userId !== disabledId]
      );
      await pool!.query(
        "INSERT INTO player_rankings_by_composition (user_id, composition, rating, games_played, wins, losses) VALUES ($1, 'mixed', 1234, 4, 3, 1)",
        [userId]
      );
    }
    await pool!.query("UPDATE app_users SET suspended_at=clock_timestamp(),suspension_reason='Disabled legacy model' WHERE id=$1", [suspendedId]);
    // A later operator-disabled cohort must take precedence over an older
    // enabled v1 row on future upgrades, without changing either old identity.
    const predecessorId = aiIdentityId(latestDisabledModel, "historical-protocol-cohort");
    await pool!.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,'ai')", [predecessorId, `agent-${predecessorId}@ai.trinitymatrix.invalid`]);
    await pool!.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,'Older model cohort')", [predecessorId]);
    await pool!.query("INSERT INTO ai_agents(user_id,model_id,model_name,prompt_version,enabled) VALUES($1,$2,'Mistral','historical-protocol-cohort',false)", [predecessorId, latestDisabledModel]);
    const existingIds = [...inheritedRoster.map(({ modelId }) => aiIdentityId(modelId, AI_LEGACY_IDENTITY_VERSION)), retiredId];
    const existingState = () => pool!.query(
      `SELECT a.user_id, a.model_id, a.model_name, a.prompt_version, a.memory, a.enabled,
              p.display_name, r.rating, r.games_played, r.wins, r.losses
       FROM ai_agents a JOIN player_profiles p ON p.user_id=a.user_id
       JOIN player_rankings_by_composition r ON r.user_id=a.user_id AND r.composition='mixed'
       WHERE a.user_id=ANY($1::uuid[]) ORDER BY a.user_id`, [existingIds]
    );
    const originalState = (await existingState()).rows;
    await store.provision();
    expect((await existingState()).rows).toEqual(originalState);
    const id = aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_CURRENT_IDENTITY_VERSION);
    await store.saveMemory(id, "Use only observed public moves; remember the last match's strategy.");
    const updatedState = (await existingState()).rows;
    await store.provision();
    expect((await existingState()).rows).toEqual(updatedState);
    const restartedStore = new PostgresAiStore(pool!);
    const agents = await restartedStore.listAgents();
    expect(agents).toHaveLength(INITIAL_AI_ROSTER.length);
    expect(agents.some(({ id: candidate }) => candidate === retiredId)).toBe(false);
    for (const configured of INITIAL_AI_ROSTER) {
      const currentId = aiIdentityId(configured.modelId, AI_CURRENT_IDENTITY_VERSION);
      expect(agents.filter(({ id: candidate }) => candidate === currentId)).toHaveLength(1);
      expect(agents.find(({ id: candidate }) => candidate === currentId))
        .toMatchObject({ modelId: configured.modelId, modelName: configured.modelName, enabled: ![disabledId, suspendedId].includes(aiIdentityId(configured.modelId, AI_LEGACY_IDENTITY_VERSION)) && configured.modelId !== latestDisabledModel,
          protocolId: AI_CURRENT_IDENTITY_VERSION, identityVersion: AI_CURRENT_IDENTITY_VERSION, selectable: true,
          displayName: configured.displayName, rating: 1000, gamesPlayed: 0, wins: 0 });
      if (currentId !== id) expect(agents.find(({ id: candidate }) => candidate === currentId)?.memory).toBe("");
    }
    expect(agents.find(({ id: candidate }) => candidate === id)?.memory)
      .toBe("Use only observed public moves; remember the last match's strategy.");
    expect(agents.find(({ id: candidate }) => candidate === aiIdentityId("deepseek/deepseek-v3.2", AI_CURRENT_IDENTITY_VERSION)))
      .toMatchObject({ enabled: false, rating: 1000, gamesPlayed: 0, wins: 0 });
    const currentDisabledId = aiIdentityId(INITIAL_AI_ROSTER[1].modelId, AI_CURRENT_IDENTITY_VERSION);
    await pool!.query("UPDATE ai_agents SET enabled=false WHERE user_id=$1", [currentDisabledId]);
    await store.provision();
    expect((await store.listAgents()).find(({ id: candidate }) => candidate === currentDisabledId)?.enabled).toBe(false);
    expect(aiIdentityId("deepseek/deepseek-v4.1-flash", AI_LEGACY_IDENTITY_VERSION)).not.toBe(retiredId);
    expect(aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_LEGACY_IDENTITY_VERSION)).not.toBe(aiIdentityId(INITIAL_AI_ROSTER[1].modelId, AI_LEGACY_IDENTITY_VERSION));
    await expect(store.saveMemory(id, "x".repeat(4001))).rejects.toThrow("too long");
  });

  it("keeps legacy workers only for active matches and never admits them as new opponents", async () => {
    const store = new PostgresAiStore(pool!);
    const legacyId = aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_LEGACY_IDENTITY_VERSION);
    const legacyDisabledId = aiIdentityId("deepseek/deepseek-v3.2", AI_LEGACY_IDENTITY_VERSION);
    const matches: string[] = [];
    for (const oldId of [legacyId, legacyDisabledId]) {
      const matchId = randomUUID(); matches.push(matchId);
      await repository.createMatch({ id: matchId, publicName: `legacy-recovery-${matches.length === 1 ? "12345671" : "12345672"}`, playerCount: 2, startedAt,
        participants: [{ userId: oldId, seatNumber: 0, displayName: "Legacy AI", badgeId: "strategist" }, { userId: humanIds[0]!, seatNumber: 1, displayName: "Human", badgeId: "rookie" }] });
    }
    const runtime = await store.listAgents();
    expect(runtime.filter(({ selectable }) => selectable)).toHaveLength(INITIAL_AI_ROSTER.length);
    expect(runtime.find(({ id }) => id === legacyId)).toMatchObject({ protocolId: AI_LEGACY_IDENTITY_VERSION, identityVersion: AI_LEGACY_IDENTITY_VERSION, selectable: false, enabled: true });
    expect(runtime.find(({ id }) => id === legacyDisabledId)).toMatchObject({ protocolId: AI_LEGACY_IDENTITY_VERSION, selectable: false, enabled: false });
    expect(runtime.find(({ id }) => id === aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_CURRENT_IDENTITY_VERSION)))
      .toMatchObject({ protocolId: AI_CURRENT_IDENTITY_VERSION, selectable: true });
    await pool!.query("UPDATE ranking_matches SET status='abandoned',end_reason='cancelled',ended_at=clock_timestamp() WHERE id=ANY($1::uuid[])", [matches]);
    const retired = await store.listAgents();
    expect(retired.some(({ id }) => id === legacyId || id === legacyDisabledId)).toBe(false);
  });

  it("atomically enforces one shared daily budget across parallel agents and keeps unknown failed costs reserved", async () => {
    const store = new PostgresAiStore(pool!);
    const id = aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_CURRENT_IDENTITY_VERSION);
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const configured = INITIAL_AI_ROSTER[index % INITIAL_AI_ROSTER.length]!;
      return store.reserveRequest(aiIdentityId(configured.modelId, AI_CURRENT_IDENTITY_VERSION), configured.modelId, 0.10);
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
    const id = aiIdentityId(configured.modelId, AI_CURRENT_IDENTITY_VERSION);
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
  it("makes v2 the default and labels earlier profiles v0 without changing identities or results", async () => {
    const currentId = aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_GAME_PROTOCOL_IDENTITY_VERSION);
    await pool!.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,'ai')", [currentId, `${currentId}@example.test`]);
    await pool!.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,'Haiku AI · v2')", [currentId]);
    await pool!.query("INSERT INTO ai_agents(user_id,model_id,model_name,prompt_version) VALUES($1,$2,$3,$4)", [currentId, INITIAL_AI_ROSTER[0].modelId, INITIAL_AI_ROSTER[0].modelName, AI_GAME_PROTOCOL_IDENTITY_VERSION]);
    await pool!.query("UPDATE player_profiles SET display_name='Human · v2' WHERE user_id=$1", [humanIds[0]]);
    await pool!.query("INSERT INTO player_rankings_by_composition(user_id,composition,rating,games_played,wins,losses) VALUES($1,'mixed',1464,5,3,2) ON CONFLICT(user_id,composition) DO UPDATE SET rating=1464,games_played=5,wins=3,losses=2,drops=0", [currentId]);
    const identities = (await pool!.query("SELECT * FROM ai_agents ORDER BY user_id")).rows;
    const ratings = (await pool!.query("SELECT * FROM player_rankings_by_composition ORDER BY user_id,composition")).rows;
    const participants = (await pool!.query("SELECT * FROM match_participants ORDER BY match_id,user_id")).rows;
    const requests = (await pool!.query("SELECT * FROM ai_model_requests ORDER BY id")).rows;
    const migration = { name: "0011_default_ai_v2.sql", sql: readFileSync(new URL("../../migrations/0011_default_ai_v2.sql", import.meta.url), "utf8") };
    expect((await runMigrations(pool!, [migration])).applied).toEqual([migration.name]);
    expect((await pool!.query("SELECT * FROM ai_agents ORDER BY user_id")).rows).toEqual(identities);
    expect((await pool!.query("SELECT * FROM player_rankings_by_composition ORDER BY user_id,composition")).rows).toEqual(ratings);
    expect((await pool!.query("SELECT * FROM match_participants ORDER BY match_id,user_id")).rows).toEqual(participants);
    expect((await pool!.query("SELECT * FROM ai_model_requests ORDER BY id")).rows).toEqual(requests);
    expect((await pool!.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [currentId])).rows).toEqual([{ display_name: "Haiku AI" }]);
    expect((await pool!.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_LEGACY_IDENTITY_VERSION)])).rows).toEqual([{ display_name: "Haiku AI · v0" }]);
    expect((await pool!.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [humanIds[0]])).rows).toEqual([{ display_name: "Human · v2" }]);
    expect((await runMigrations(pool!, [migration])).alreadyApplied).toEqual([migration.name]);
    const newId = randomUUID();
    await pool!.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,'ai')", [newId, `${newId}@example.test`]);
    await pool!.query("INSERT INTO ai_agents(user_id,model_id,model_name) VALUES($1,'fixture/new-model','New model')", [newId]);
    expect((await pool!.query("SELECT prompt_version FROM ai_agents WHERE user_id=$1", [newId])).rows).toEqual([{ prompt_version: AI_GAME_PROTOCOL_IDENTITY_VERSION }]);
  });

});

describe.skipIf(!databaseUrl)("validation-only cohort upgrade in PostgreSQL", () => {
  const schema = `trinity_v3_test_${randomUUID().replaceAll("-", "")}`;
  const migration = (name: string) => ({ name, sql: readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8") });
  const humanId = randomUUID();
  const legacyId = aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_LEGACY_IDENTITY_VERSION);
  const v2Ids = INITIAL_AI_ROSTER.map(({ modelId }) => aiIdentityId(modelId, AI_GAME_PROTOCOL_IDENTITY_VERSION));
  const unknownId = randomUUID();
  const oldIds = [humanId, legacyId, ...v2Ids, unknownId];
  const activeMatches: string[] = [];
  let admin: Pool; let pool: Pool; let store: PostgresAiStore;

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.toLowerCase().includes("test")) throw new Error("Validation cohort integration requires an isolated test database.");
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await runMigrations(pool, [
      "0001_core_persistence.sql", "0002_post_game_chat.sql", "0003_private_matches.sql", "0004_distributed_game_runtime.sql",
      "0005_matchmaking_ticket_liveness.sql", "0006_replay_exports.sql", "0007_admin_passkeys.sql", "0008_model_bound_ai_players.sql",
      "0009_live_broadcasts.sql", "0010_ai_protocol_provenance.sql", "0011_default_ai_v2.sql"
    ].map(migration));
    store = new PostgresAiStore(pool);
    await store.registerProtocol(AI_LEGACY_V1_PROTOCOL_DESCRIPTOR);
    await store.registerProtocol(AI_GAME_PROTOCOL_DESCRIPTOR);
    const seed = async (id: string, modelId: string, modelName: string, version: string, displayName: string, enabled: boolean) => {
      await pool.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,'ai')", [id, `${id}@example.test`]);
      await pool.query("INSERT INTO player_profiles(user_id,display_name,badge_id) VALUES($1,$2,'strategist')", [id, displayName]);
      await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name,prompt_version,memory,enabled) VALUES($1,$2,$3,$4,$5,$6)",
        [id, modelId, modelName, version, `Retained ${version} memory`, enabled]);
      for (const composition of ["ai", "mixed"]) {
        await pool.query("INSERT INTO player_rankings_by_composition(user_id,composition,rating,games_played,wins,losses,drops) VALUES($1,$2,1320,8,5,2,1)", [id, composition]);
      }
    };
    // The newer enabled v2 identity takes precedence over a disabled v0 row.
    await seed(legacyId, INITIAL_AI_ROSTER[0].modelId, INITIAL_AI_ROSTER[0].modelName, AI_LEGACY_IDENTITY_VERSION, "Haiku AI · v0", false);
    for (const [index, agent] of INITIAL_AI_ROSTER.entries()) {
      await seed(v2Ids[index]!, agent.modelId, agent.modelName, AI_GAME_PROTOCOL_IDENTITY_VERSION,
        index === INITIAL_AI_ROSTER.length - 1 ? "ABCDEFGHIJKLMNOPQRSTUVWX" : agent.displayName,
        !["deepseek/deepseek-v3.2", "openai/gpt-6-luna"].includes(agent.modelId));
    }
    await pool.query("UPDATE app_users SET suspended_at=clock_timestamp(),suspension_reason='Operator suspension' WHERE id=$1", [aiIdentityId("qwen/qwen3.8-flash", AI_GAME_PROTOCOL_IDENTITY_VERSION)]);
    await seed(unknownId, "fixture/unknown-protocol", "Unknown protocol model", "unrecognized-protocol", "Unknown AI", true);
    await pool.query("INSERT INTO app_users(id,email) VALUES($1,$2)", [humanId, `${humanId}@example.test`]);
    await pool.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,'Human · v2')", [humanId]);
    await pool.query("INSERT INTO player_rankings(user_id,rating,games_played,wins,losses) VALUES($1,1440,4,3,1)", [humanId]);
    await pool.query("INSERT INTO player_rankings_by_composition(user_id,composition,rating,games_played,wins,losses) VALUES($1,'human',1440,4,3,1)", [humanId]);
    const repository = new PostgresApplicationRepository(pool, new PostGameChatCipher(Buffer.alloc(32, 9).toString("base64"), 1));
    for (const [index, id] of [legacyId, v2Ids[0]!, aiIdentityId("openai/gpt-6-luna", AI_GAME_PROTOCOL_IDENTITY_VERSION), unknownId].entries()) {
      const matchId = randomUUID(); activeMatches.push(matchId);
      await repository.createMatch({ id: matchId, publicName: `cohort-active-${10000000 + index}`, playerCount: 2, startedAt: new Date("2026-11-13T10:00:00Z"),
        participants: [{ userId: id, seatNumber: 0, displayName: "Archived AI name", badgeId: "strategist" }, { userId: humanId, seatNumber: 1, displayName: "Human", badgeId: "rookie" }] });
    }
    const completedId = randomUUID();
    await repository.createMatch({ id: completedId, publicName: "cohort-archive-12345678", playerCount: 2, startedAt: new Date("2026-11-13T10:00:00Z"),
      participants: [{ userId: v2Ids[1]!, seatNumber: 0, displayName: "Gemini AI", badgeId: "strategist" }, { userId: humanId, seatNumber: 1, displayName: "Human", badgeId: "rookie" }] });
    await pool.query("INSERT INTO game_events(event_id,match_id,sequence,event_type,payload,occurred_at) VALUES($1,$2,1,'cohort-fixture',$3,clock_timestamp())", [randomUUID(), completedId, { immutable: true }]);
    await repository.completeMatchAndUpdateRatings({ matchId: completedId, winnerUserId: v2Ids[1]!, endReason: "declaration", endedAt: new Date("2026-11-13T10:15:00Z"),
      participantOutcomes: [{ userId: v2Ids[1]!, outcome: "won" }, { userId: humanId, outcome: "lost" }] });
    const completedRequest = (await store.reserveRequest(v2Ids[0]!, INITIAL_AI_ROSTER[0].modelId, 10, { protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION, matchId: activeMatches[1], gameRevision: 7, declarationAvailable: true, toolsVersion: "own-hand-rules/1.0.0" }))!;
    await store.finishRequest(completedRequest, 0.003, true, { action: "declare", outcome: "accepted" });
    const unknownCost = (await store.reserveRequest(v2Ids[1]!, INITIAL_AI_ROSTER[1].modelId, 10))!;
    await store.finishRequest(unknownCost, null, false, { outcome: "provider-failed" });
  });

  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("archives solver-assisted names and creates fresh identities without changing old data or shared charges", async () => {
    const snapshots = async () => ({
      users: (await pool.query("SELECT * FROM app_users WHERE id=ANY($1::uuid[]) ORDER BY id", [oldIds])).rows,
      agents: (await pool.query("SELECT * FROM ai_agents WHERE user_id=ANY($1::uuid[]) ORDER BY user_id", [oldIds])).rows,
      profiles: (await pool.query("SELECT to_jsonb(p)-'display_name' AS preserved FROM player_profiles p WHERE user_id=ANY($1::uuid[]) ORDER BY user_id", [oldIds])).rows,
      oldRankings: (await pool.query("SELECT * FROM player_rankings ORDER BY user_id")).rows,
      ratings: (await pool.query("SELECT * FROM player_rankings_by_composition ORDER BY user_id,composition")).rows,
      matches: (await pool.query("SELECT * FROM ranking_matches ORDER BY id")).rows,
      participants: (await pool.query("SELECT * FROM match_participants ORDER BY match_id,user_id")).rows,
      events: (await pool.query("SELECT * FROM game_events ORDER BY event_id")).rows,
      replays: (await pool.query("SELECT * FROM replay_exports ORDER BY match_id")).rows,
      broadcasts: (await pool.query("SELECT * FROM live_broadcasts ORDER BY id")).rows,
      requests: (await pool.query("SELECT * FROM ai_model_requests ORDER BY id")).rows
    });
    const before = await snapshots();
    const descriptors = (await pool.query("SELECT * FROM ai_protocol_revisions ORDER BY id")).rows;
    const upgrade = migration("0012_validation_only_ai.sql");
    expect((await runMigrations(pool, [upgrade])).applied).toEqual([upgrade.name]);
    await store.provision();
    expect(await snapshots()).toEqual(before);
    expect((await pool.query("SELECT * FROM ai_protocol_revisions WHERE id=ANY($1::text[]) ORDER BY id", [[AI_LEGACY_IDENTITY_VERSION, AI_GAME_PROTOCOL_IDENTITY_VERSION]])).rows).toEqual(descriptors);
    expect((await pool.query("SELECT count(*)::int AS n FROM ai_protocol_revisions")).rows).toEqual([{ n: 3 }]);
    expect((await pool.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [legacyId])).rows).toEqual([{ display_name: "Haiku AI · v0" }]);
    expect((await pool.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [v2Ids[0]])).rows).toEqual([{ display_name: "Haiku AI · v2" }]);
    expect((await pool.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [v2Ids.at(-1)])).rows).toEqual([{ display_name: "ABCDEFGHIJKLMNOPQRS · v2" }]);
    expect((await pool.query("SELECT display_name FROM player_profiles WHERE user_id=$1", [humanId])).rows).toEqual([{ display_name: "Human · v2" }]);
    const current = (await store.listAgents()).filter(({ selectable }) => selectable);
    expect(current).toHaveLength(13);
    for (const agent of INITIAL_AI_ROSTER) {
      expect(current.find(({ id }) => id === aiIdentityId(agent.modelId))).toMatchObject({ displayName: agent.displayName, modelId: agent.modelId,
        protocolId: AI_VALIDATION_IDENTITY_VERSION, identityVersion: AI_VALIDATION_IDENTITY_VERSION, memory: "", rating: 1000, gamesPlayed: 0, wins: 0,
        enabled: !["deepseek/deepseek-v3.2", "openai/gpt-6-luna", "qwen/qwen3.8-flash"].includes(agent.modelId) });
    }
    const implicitId = randomUUID();
    await pool.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,'ai')", [implicitId, `${implicitId}@example.test`]);
    await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name) VALUES($1,'fixture/v3-default','Default model')", [implicitId]);
    expect((await pool.query("SELECT prompt_version FROM ai_agents WHERE user_id=$1", [implicitId])).rows).toEqual([{ prompt_version: AI_VALIDATION_IDENTITY_VERSION }]);
    expect((await runMigrations(pool, [upgrade])).alreadyApplied).toEqual([upgrade.name]);
    await store.provision();
    expect((await store.listAgents()).filter(({ selectable }) => selectable)).toEqual(current);
  });

  it("recovers only active supported old cohorts and never offers them for new matches", async () => {
    const agents = await store.listAgents();
    const recovered = agents.filter(({ selectable }) => !selectable);
    expect(recovered.map(({ id }) => id).sort()).toEqual([legacyId, v2Ids[0]!, aiIdentityId("openai/gpt-6-luna", AI_GAME_PROTOCOL_IDENTITY_VERSION)].sort());
    expect(recovered.find(({ id }) => id === legacyId)).toMatchObject({ enabled: false, protocolId: AI_LEGACY_IDENTITY_VERSION });
    expect(recovered.find(({ id }) => id === v2Ids[0])).toMatchObject({ enabled: true, protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION });
    expect(agents.some(({ id }) => id === unknownId || id === v2Ids[1])).toBe(false);
    await pool.query("UPDATE ranking_matches SET status='abandoned',end_reason='cancelled',ended_at=clock_timestamp() WHERE id=ANY($1::uuid[])", [activeMatches]);
    expect((await store.listAgents()).every(({ selectable }) => selectable)).toBe(true);
  });

  it("leaves all cohorts on one UTC ledger and persists no validation-only readiness diagnostic", async () => {
    const modelId = INITIAL_AI_ROSTER[0].modelId;
    const currentId = aiIdentityId(modelId);
    for (const readiness of [true, false, null]) {
      const request = (await store.reserveRequest(currentId, modelId, 10, { protocolId: AI_VALIDATION_IDENTITY_VERSION, toolsVersion: AI_VALIDATION_TOOL_VERSION, declarationAvailable: readiness }))!;
      expect((await pool.query("SELECT declaration_available,tools_version FROM ai_model_requests WHERE id=$1", [request])).rows).toEqual([{ declaration_available: null, tools_version: AI_VALIDATION_TOOL_VERSION }]);
    }
    const oldRequest = (await store.reserveRequest(v2Ids[0]!, modelId, 10, { protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION, declarationAvailable: true }))!;
    expect((await pool.query("SELECT declaration_available FROM ai_model_requests WHERE id=$1", [oldRequest])).rows).toEqual([{ declaration_available: true }]);
    await expect(pool.query("INSERT INTO ai_model_requests(id,user_id,model_id,budget_day,reserved_usd,protocol_id,declaration_available) VALUES($1,$2,$3,(statement_timestamp() AT TIME ZONE 'UTC')::date,0.05,$4,true)",
      [randomUUID(), currentId, modelId, AI_VALIDATION_IDENTITY_VERSION])).rejects.toThrow("ai_validation_only_no_readiness");
    const spent = Number((await pool.query("SELECT sum(COALESCE(actual_usd,reserved_usd))::text AS spent FROM ai_model_requests WHERE budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date")).rows[0]!.spent);
    const reservations = await Promise.all(Array.from({ length: 12 }, (_, index) => store.reserveRequest(index % 2 ? currentId : v2Ids[0]!, modelId, spent + 0.10,
      { protocolId: index % 2 ? AI_VALIDATION_IDENTITY_VERSION : AI_GAME_PROTOCOL_IDENTITY_VERSION })));
    expect(reservations.filter(Boolean)).toHaveLength(2);
    expect(await store.budgetAvailable(spent + 0.10)).toBe(false);
  });
});
