import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { PostgresAiStore, type AiProtocolRevision } from "../ai-repository";

const databaseUrl = process.env.AI_RATINGS_TEST_DATABASE_URL ?? process.env.BROADCAST_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("immutable AI protocol provenance in PostgreSQL", () => {
  const schema = `ai_protocol_test_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID(); const nextUserId = randomUUID(); const disabledId = randomUUID(); const humanId = randomUUID(); const legacyRequestId = randomUUID();
  const modelId = "fixture/protocol-model";
  const first: AiProtocolRevision = { id: "trinity-v1", policyHash: "a".repeat(64), semver: "1.0.0", rulesRevision: "rules-v1", manifest: { promptSHA: "b".repeat(64), legacy: true } };
  const second: AiProtocolRevision = { id: "trinity-v2", policyHash: "c".repeat(64), semver: "2.0.0", rulesRevision: "rules-v1", manifest: { promptSHA: "d".repeat(64), toolVersion: "own-hand-v1" } };
  let pool: Pool; let admin: Pool; let store: PostgresAiStore;
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.toLowerCase().includes("test")) throw new Error("Protocol integration requires an isolated test database.");
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const names = ["0001_core_persistence.sql", "0002_post_game_chat.sql", "0003_private_matches.sql", "0004_distributed_game_runtime.sql", "0005_matchmaking_ticket_liveness.sql",
      "0006_replay_exports.sql", "0007_admin_passkeys.sql", "0008_model_bound_ai_players.sql", "0009_live_broadcasts.sql"];
    const migration = (name: string) => ({ name, sql: readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8") });
    await runMigrations(pool, names.map(migration));
    for (const id of [userId, nextUserId, disabledId, humanId]) {
      await pool.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,$3)", [id, `${id}@example.test`, id === humanId ? "human" : "ai"]);
      await pool.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,'Protocol fixture')", [id]);
    }
    await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name,enabled,memory) VALUES($1,$3,'Fixture model',true,'Existing memory'),($2,$3,'Fixture model',false,'Disabled memory')", [userId, disabledId, modelId]);
    await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name,prompt_version) VALUES($1,$2,'Fixture model',$3)", [nextUserId, modelId, second.id]);
    await pool.query("INSERT INTO player_rankings(user_id,rating,games_played,wins,losses) VALUES($1,1412,4,3,1)", [humanId]);
    await pool.query("INSERT INTO player_rankings_by_composition(user_id,composition,rating,games_played,wins,losses) VALUES($1,'human',1412,4,3,1)", [humanId]);
    await pool.query("INSERT INTO ai_model_requests(id,user_id,model_id,budget_day,reserved_usd,actual_usd,status) VALUES($1,$2,$3,(clock_timestamp() AT TIME ZONE 'UTC')::date-1,0.05,0.002,'completed')", [legacyRequestId, userId, modelId]);
    await runMigrations(pool, [...names, "0010_ai_protocol_provenance.sql"].map(migration));
    store = new PostgresAiStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("keeps legacy charges, human ratings, memory, enabled flags and identities unchanged", async () => {
    expect((await pool.query("SELECT protocol_id,match_id,game_revision,tools_version,server_revision,declaration_available,action,outcome,actual_usd,status FROM ai_model_requests WHERE id=$1", [legacyRequestId])).rows)
      .toEqual([{ protocol_id: null, match_id: null, game_revision: null, tools_version: null, server_revision: null, declaration_available: null, action: null, outcome: null, actual_usd: "0.002000", status: "completed" }]);
    expect((await pool.query("SELECT rating,games_played FROM player_rankings WHERE user_id=$1", [humanId])).rows).toEqual([{ rating: 1412, games_played: 4 }]);
    expect((await pool.query("SELECT rating,games_played FROM player_rankings_by_composition WHERE user_id=$1 AND composition='human'", [humanId])).rows).toEqual([{ rating: 1412, games_played: 4 }]);
    expect((await pool.query("SELECT enabled,memory,prompt_version FROM ai_agents WHERE user_id=$1", [disabledId])).rows)
      .toEqual([{ enabled: false, memory: "Disabled memory", prompt_version: "trinity-v1" }]);
  });
  it("registers exact protocol descriptors idempotently and rejects redefinition or deletion", async () => {
    await store.registerProtocol(first); await store.registerProtocol(second); await store.registerProtocol({ ...second, manifest: { toolVersion: "own-hand-v1", promptSHA: "d".repeat(64) } });
    for (const patch of [{ policyHash: "f".repeat(64) }, { semver: "2.0.1" }, { rulesRevision: "other-rules" }, { manifest: { changed: true } }]) {
      await expect(store.registerProtocol({ ...second, ...patch })).rejects.toThrow("cannot be redefined");
    }
    await expect(pool.query("UPDATE ai_protocol_revisions SET semver='9.0.0' WHERE id=$1", [second.id])).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM ai_protocol_revisions WHERE id=$1", [second.id])).rejects.toThrow("immutable");
    expect((await pool.query("SELECT count(*)::int AS n FROM ai_protocol_revisions")).rows[0]!.n).toBe(2);
  });
  it("shares the exact same budget across legacy/v1/v2 and retains unknown failed reservations", async () => {
    const matchId = randomUUID();
    const reserved = await Promise.all(Array.from({ length: 12 }, (_, index) => store.reserveRequest(index % 3 === 2 ? nextUserId : userId, modelId, 0.10,
      index % 3 === 0 ? undefined : { protocolId: index % 3 === 1 ? first.id : second.id, matchId, gameRevision: 4, toolsVersion: "own-hand-v1", declarationAvailable: index % 2 === 0 })));
    const accepted = reserved.filter((id): id is string => id !== null); expect(accepted).toHaveLength(2);
    expect(await store.budgetAvailable(0.10)).toBe(false);
    await store.finishRequest(accepted[0]!, null, false, { outcome: "provider-failed" });
    await store.finishRequest(accepted[0]!, 0, true);
    expect((await pool.query("SELECT status,actual_usd,outcome FROM ai_model_requests WHERE id=$1", [accepted[0]])).rows)
      .toEqual([{ status: "failed", actual_usd: null, outcome: "provider-failed" }]);
    expect(await store.budgetAvailable(0.10)).toBe(false);
    expect(await store.reserveRequest(disabledId, modelId, 10, { protocolId: first.id })).toBeNull();
    expect(await store.reserveRequest(userId, modelId, 10, { protocolId: second.id })).toBeNull();
  });
  it("records immutable server context and a write-once post-validator outcome without changing the charge", async () => {
    const context = { protocolId: second.id, matchId: randomUUID(), gameRevision: 17, toolsVersion: "own-hand-v1", serverRevision: "test-build-abc123", declarationAvailable: false };
    const id = (await store.reserveRequest(nextUserId, modelId, 10, context))!;
    await store.finishRequest(id, 0.003, true);
    await store.recordRequestOutcome(id, { action: "discard", outcome: "accepted" });
    await store.recordRequestOutcome(id, { action: "discard", outcome: "accepted" });
    await expect(store.recordRequestOutcome(id, { action: "declare", outcome: "server-rejected" })).rejects.toThrow("already recorded differently");
    const row = (await pool.query("SELECT protocol_id,match_id,game_revision,tools_version,server_revision,declaration_available,action,outcome,status,actual_usd FROM ai_model_requests WHERE id=$1", [id])).rows[0]!;
    expect(row).toEqual({ protocol_id: second.id, match_id: context.matchId, game_revision: "17", tools_version: "own-hand-v1", server_revision: context.serverRevision, declaration_available: false,
      action: "discard", outcome: "accepted", status: "completed", actual_usd: "0.003000" });
    await expect(pool.query("UPDATE ai_model_requests SET protocol_id=$2 WHERE id=$1", [id, first.id])).rejects.toThrow("provenance is immutable");
    await expect(pool.query("UPDATE ai_model_requests SET server_revision='different-build' WHERE id=$1", [id])).rejects.toThrow("provenance is immutable");
    await expect(pool.query("UPDATE ai_model_requests SET action='declare' WHERE id=$1", [id])).rejects.toThrow("write-once");
    const unavailable = await store.reserveRequest(nextUserId, modelId, 10, { protocolId: second.id, declarationAvailable: null });
    expect((await pool.query("SELECT declaration_available FROM ai_model_requests WHERE id=$1", [unavailable])).rows).toEqual([{ declaration_available: null }]);
  });
  it("rejects unknown/private provenance before contacting or charging a model", async () => {
    const before = Number((await pool.query("SELECT count(*)::int AS n FROM ai_model_requests")).rows[0]!.n);
    expect(await store.reserveRequest(userId, modelId, 10, { protocolId: "unregistered" })).toBeNull();
    await expect(store.reserveRequest(userId, modelId, 10, { protocolId: second.id, memory: "private" } as never)).rejects.toThrow();
    await expect(store.registerProtocol({ ...second, id: "unsafe", manifest: { prompt: "raw prompt" } })).rejects.toThrow();
    expect(Number((await pool.query("SELECT count(*)::int AS n FROM ai_model_requests")).rows[0]!.n)).toBe(before);
  });
});
