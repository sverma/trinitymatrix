import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_GAME_RULES_REVISION } from "../ai-game-protocol";
import { AI_VALIDATION_IDENTITY_VERSION } from "../ai-game-protocol-v3";
import { PostgresAiPracticeStore, type AiPracticeBinding } from "../ai-practice-repository";
import { aiIdentityId, INITIAL_AI_ROSTER, PostgresAiStore } from "../ai-repository";
import { runMigrations } from "./migrate";

const databaseUrl = process.env.AI_RATINGS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("private leased AI practice persistence in PostgreSQL", () => {
  const schema = `ai_practice_test_${randomUUID().replaceAll("-", "")}`;
  const humanId = randomUUID();
  const v2Id = aiIdentityId(INITIAL_AI_ROSTER[0].modelId, AI_GAME_PROTOCOL_IDENTITY_VERSION);
  const migration = (name: string) => ({ name, sql: readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8") });
  const practiceMigration = migration("0013_ai_practice.sql");
  const binding = (index = 0, curriculumId = "fixture-practice/1.0.0"): AiPracticeBinding => ({
    agentId: aiIdentityId(INITIAL_AI_ROSTER[index]!.modelId), modelId: INITIAL_AI_ROSTER[index]!.modelId,
    protocolId: AI_VALIDATION_IDENTITY_VERSION, curriculumId, curriculumHash: "a".repeat(64), rulesRevision: AI_GAME_RULES_REVISION
  });
  let admin: Pool; let pool: Pool; let store: PostgresAiPracticeStore;
  const publicState = async () => ({
    users: (await pool.query("SELECT * FROM app_users ORDER BY id")).rows,
    agents: (await pool.query("SELECT * FROM ai_agents ORDER BY user_id")).rows,
    profiles: (await pool.query("SELECT * FROM player_profiles ORDER BY user_id")).rows,
    ratings: (await pool.query("SELECT * FROM player_rankings_by_composition ORDER BY user_id,composition")).rows,
    legacyRatings: (await pool.query("SELECT * FROM player_rankings ORDER BY user_id")).rows,
    matches: (await pool.query("SELECT * FROM ranking_matches ORDER BY id")).rows,
    participants: (await pool.query("SELECT * FROM match_participants ORDER BY match_id,user_id")).rows,
    events: (await pool.query("SELECT * FROM game_events ORDER BY event_id")).rows,
    billing: (await pool.query("SELECT * FROM ai_model_requests ORDER BY id")).rows
  });

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.toLowerCase().includes("test")) throw new Error("AI practice integration requires an isolated test database.");
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await runMigrations(pool, [
      "0001_core_persistence.sql", "0002_post_game_chat.sql", "0003_private_matches.sql", "0004_distributed_game_runtime.sql",
      "0005_matchmaking_ticket_liveness.sql", "0006_replay_exports.sql", "0007_admin_passkeys.sql", "0008_model_bound_ai_players.sql",
      "0009_live_broadcasts.sql", "0010_ai_protocol_provenance.sql", "0011_default_ai_v2.sql", "0012_validation_only_ai.sql"
    ].map(migration));
    await new PostgresAiStore(pool).provision();
    await pool.query("UPDATE ai_agents SET enabled=false WHERE model_id=ANY($1::text[])", [["deepseek/deepseek-v3.2", "openai/gpt-6-luna"]]);
    await pool.query("UPDATE ai_agents SET memory='Existing private live memory' WHERE user_id=$1", [binding().agentId]);
    await pool.query("INSERT INTO app_users(id,email) VALUES($1,$2)", [humanId, `${humanId}@example.test`]);
    await pool.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,'Practice human')", [humanId]);
    await pool.query("INSERT INTO player_rankings(user_id,rating,games_played,wins,losses) VALUES($1,1230,3,2,1)", [humanId]);
    await pool.query("INSERT INTO player_rankings_by_composition(user_id,composition,rating,games_played,wins,losses) VALUES($1,'human',1230,3,2,1)", [humanId]);
    await pool.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,'ai')", [v2Id, `${v2Id}@example.test`]);
    await pool.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,'Haiku AI · v2')", [v2Id]);
    await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name,prompt_version,memory) VALUES($1,$2,'Haiku',$3,'Old v2 live memory')", [v2Id, INITIAL_AI_ROSTER[0].modelId, AI_GAME_PROTOCOL_IDENTITY_VERSION]);
    store = new PostgresAiPracticeStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("adds private tables without changing any existing public identity, availability, rating or billing row", async () => {
    const before = await publicState();
    expect((await runMigrations(pool, [practiceMigration])).applied).toEqual([practiceMigration.name]);
    expect(await publicState()).toEqual(before);
    expect((await runMigrations(pool, [practiceMigration])).alreadyApplied).toEqual([practiceMigration.name]);
    expect((await new PostgresAiStore(pool).listAgents()).filter(({ enabled, selectable }) => enabled && selectable)).toHaveLength(11);
  });

  it("keeps versioned practice memory private and promotes only bounded notes for the same idle v3 identity", async () => {
    const before = await publicState();
    const started = await store.beginRun(binding());
    expect(started).toMatchObject({ practiceMemory: "", liveMemory: "Existing private live memory" });
    const input = { runId: started.runId, notes: "Model-generated lesson about checking a natural 21.", metrics: { requests: 5, validDeclarations: 1, knownCostUsd: 0.002 }, promote: false };
    expect(await store.completeRun(input)).toEqual({ notesPromoted: false, reason: "promotion-disabled" });
    expect(await publicState()).toEqual(before);
    const next = await store.beginRun(binding());
    expect(next.practiceMemory).toBe(input.notes);
    expect(next.liveMemory).toBe(started.liveMemory);
    const completion = { runId: next.runId, notes: "The same model's improved private lesson.", metrics: { requests: 3, validDeclarations: 1 }, promote: true };
    expect(await store.completeRun(completion)).toEqual({ notesPromoted: true });
    expect(await store.completeRun(completion)).toEqual({ notesPromoted: true });
    expect((await pool.query("SELECT memory,enabled FROM ai_agents WHERE user_id=$1", [binding().agentId])).rows).toEqual([{ memory: completion.notes, enabled: true }]);
    await expect(store.completeRun({ ...completion, notes: "different" })).rejects.toThrow("completed differently");
    const otherCurriculum = await store.beginRun(binding(0, "fixture-practice/2.0.0"));
    expect(otherCurriculum.practiceMemory).toBe("");
    await store.failRun(otherCurriculum.runId);
    const otherModel = await store.beginRun(binding(1));
    expect(otherModel.practiceMemory).toBe("");
    await store.failRun(otherModel.runId);
  });

  it("serializes sessions per agent and rejects changes to exact model, protocol, rules or curriculum bindings", async () => {
    for (const patch of [{ modelId: "fixture/wrong-model" }, { protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION }, { rulesRevision: "wrong-rules" }]) {
      await expect(store.beginRun({ ...binding(2), ...patch })).rejects.toThrow();
    }
    const sessions = await Promise.allSettled([store.beginRun(binding(2)), store.beginRun(binding(2))]);
    expect(sessions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(sessions.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const accepted = sessions.find((value) => value.status === "fulfilled")!;
    if (accepted.status !== "fulfilled") throw new Error("Expected one acquired practice session.");
    await store.failRun(accepted.value.runId);
    await expect(store.beginRun({ ...binding(2), curriculumHash: "b".repeat(64) })).rejects.toThrow("cannot be redefined");
    await expect(pool.query("UPDATE ai_practice_curricula SET curriculum_hash=$2 WHERE id=$1", [binding().curriculumId, "c".repeat(64)])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM ai_practice_curricula WHERE id=$1", [binding().curriculumId])).rejects.toThrow("immutable");
  });

  it("retains notes in practice when a live match or changed live memory prevents promotion", async () => {
    const current = binding(3);
    const first = await store.beginRun(current);
    await pool.query("UPDATE ai_agents SET memory='Newer live-match memory' WHERE user_id=$1", [current.agentId]);
    expect(await store.completeRun({ runId: first.runId, notes: "Practice lesson kept separate.", metrics: { completedRounds: 1 }, promote: true }))
      .toEqual({ notesPromoted: false, reason: "live-memory-changed" });
    const second = await store.beginRun(current);
    expect(second.practiceMemory).toBe("Practice lesson kept separate.");
    const matchId = randomUUID();
    await pool.query("INSERT INTO ranking_matches(id,public_name,player_count) VALUES($1,'practice-active-12345678',2)", [matchId]);
    await pool.query("INSERT INTO match_participants(match_id,user_id,seat_number,display_name,badge_id) VALUES($1,$2,0,'Qwen AI','strategist'),($1,$3,1,'Human','rookie')", [matchId, current.agentId, humanId]);
    const before = await publicState();
    expect(await store.completeRun({ runId: second.runId, notes: "Another model-generated practice lesson.", metrics: { completedRounds: 1 }, promote: true }))
      .toEqual({ notesPromoted: false, reason: "active-match" });
    expect(await publicState()).toEqual(before);
    const third = await store.beginRun(current);
    expect(third).toMatchObject({ practiceMemory: "Another model-generated practice lesson.", liveMemory: "Newer live-match memory" });
    await store.failRun(third.runId);
  });

  it("never promotes an older protocol's practice notes into any live cohort", async () => {
    const currentMemory = (await pool.query("SELECT memory FROM ai_agents WHERE user_id=$1", [binding().agentId])).rows;
    const oldBinding = { ...binding(), agentId: v2Id, protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION, curriculumId: "fixture-v2-practice/1.0.0" };
    const started = await store.beginRun(oldBinding);
    expect(await store.completeRun({ runId: started.runId, notes: "Older protocol's model lesson.", metrics: { requests: 1 }, promote: true }))
      .toEqual({ notesPromoted: false, reason: "not-current-protocol" });
    expect((await pool.query("SELECT memory FROM ai_agents WHERE user_id=$1", [v2Id])).rows).toEqual([{ memory: "Old v2 live memory" }]);
    expect((await pool.query("SELECT memory FROM ai_agents WHERE user_id=$1", [binding().agentId])).rows).toEqual(currentMemory);
  });

  it("recovers stale fifteen-minute leases and refuses late completion without overwriting newer notes", async () => {
    const current = binding(4);
    const first = await store.beginRun(current); await store.failRun(first.runId);
    const insertExpired = async () => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO ai_practice_runs(id,agent_id,model_id,protocol_id,curriculum_id,curriculum_hash,rules_revision,
         baseline_live_memory,baseline_practice_revision,started_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,'',0,clock_timestamp()-interval '16 minutes',clock_timestamp()-interval '1 minute')`,
        [id, current.agentId, current.modelId, current.protocolId, current.curriculumId, current.curriculumHash, current.rulesRevision]
      );
      return id;
    };
    const staleId = await insertExpired();
    const recovered = await store.beginRun(current);
    expect((await pool.query("SELECT status FROM ai_practice_runs WHERE id=$1", [staleId])).rows).toEqual([{ status: "expired" }]);
    await expect(store.completeRun({ runId: staleId, notes: "Stale lesson.", metrics: {}, promote: true })).rejects.toThrow("no longer running");
    await store.completeRun({ runId: recovered.runId, notes: "Newer completed lesson.", metrics: {}, promote: false });
    const expiredId = await insertExpired();
    await expect(store.completeRun({ runId: expiredId, notes: "Expired lesson.", metrics: {}, promote: true })).rejects.toThrow("expired");
    expect((await pool.query("SELECT status FROM ai_practice_runs WHERE id=$1", [expiredId])).rows).toEqual([{ status: "expired" }]);
    const last = await store.beginRun(current);
    expect(last.practiceMemory).toBe("Newer completed lesson.");
    await store.failRun(last.runId);
  });

  it("protects private baselines and finished results and rejects raw or unbounded diagnostics", async () => {
    const started = await store.beginRun(binding(6));
    await expect(pool.query("UPDATE ai_practice_runs SET baseline_live_memory='changed' WHERE id=$1", [started.runId])).rejects.toThrow("immutable");
    await expect(pool.query("UPDATE ai_practice_runs SET protocol_id=$2 WHERE id=$1", [started.runId, AI_GAME_PROTOCOL_IDENTITY_VERSION])).rejects.toThrow("immutable");
    for (const metrics of [{ providerBody: "private" }, { requests: -1 }, { requests: "1" }, { requests: 9007199254740992 }]) {
      await expect(pool.query("UPDATE ai_practice_runs SET status='completed',completed_at=clock_timestamp(),notes='lesson',metrics=$2,promotion_reason='promotion-disabled' WHERE id=$1", [started.runId, metrics])).rejects.toThrow();
    }
    await expect(store.completeRun({ runId: started.runId, notes: "x".repeat(513), metrics: {}, promote: false })).rejects.toThrow();
    expect(await store.completeRun({ runId: started.runId, notes: "", metrics: {}, promote: true })).toEqual({ notesPromoted: false, reason: "no-notes" });
    await expect(pool.query("UPDATE ai_practice_runs SET notes='different' WHERE id=$1", [started.runId])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM ai_practice_runs WHERE id=$1", [started.runId])).rejects.toThrow("immutable");
    await store.failRun(started.runId);
    expect((await pool.query("SELECT status FROM ai_practice_runs WHERE id=$1", [started.runId])).rows).toEqual([{ status: "completed" }]);
  });
});
