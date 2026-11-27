import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActivityFilters, ActivityIngest } from "@trinitymatrix/protocol";
import { PostgresActivityRepository } from "../activity-repository";
import { runMigrations } from "./migrate";

const databaseUrl = process.env.ACTIVITY_TEST_DATABASE_URL ?? process.env.AI_RATINGS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("activity analytics in isolated PostgreSQL", () => {
  const schema = `activity_test_${randomUUID().replaceAll("-", "")}`;
  const alice = randomUUID(), bob = randomUUID(), ai = randomUUID();
  const now = new Date("2026-11-27T13:00:00Z");
  const filters: ActivityFilters = { from: "2026-11-26T00:00:00Z", to: now.toISOString(), actorKind: "all" };
  const identity = (userId = alice, marker = "a") => ({ userId, sessionHash: marker.repeat(64), expiresAt: new Date("2026-11-28T00:00:00Z") });
  const at = (seconds: number) => new Date(Date.parse("2026-11-27T12:00:00Z") + seconds * 1000);
  let admin: Pool, pool: Pool, repository: PostgresActivityRepository;
  const snapshot = async () => ({
    users: (await pool.query("SELECT * FROM app_users ORDER BY id")).rows,
    profiles: (await pool.query("SELECT * FROM player_profiles ORDER BY user_id")).rows,
    matches: (await pool.query("SELECT * FROM ranking_matches ORDER BY id")).rows,
    participants: (await pool.query("SELECT * FROM match_participants ORDER BY match_id,user_id")).rows,
    events: (await pool.query("SELECT * FROM game_events ORDER BY event_id")).rows,
    ratings: (await pool.query("SELECT * FROM player_rankings_by_composition ORDER BY user_id,composition")).rows,
    billing: (await pool.query("SELECT * FROM ai_model_requests ORDER BY id")).rows,
    agents: (await pool.query("SELECT * FROM ai_agents ORDER BY user_id")).rows
  });
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.includes("test")) throw new Error("An isolated test database is required.");
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const directory = new URL("../../migrations/", import.meta.url);
    const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(new URL(name, directory), "utf8") }));
    await runMigrations(pool, migrations.filter(({ name }) => name !== "0014_user_activity.sql"));
    for (const [id, name, kind] of [[alice, "Alice", "human"], [bob, "Bob", "human"], [ai, "Fixture AI", "ai"]]) {
      await pool.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,$3)", [id, `${name!.replaceAll(" ", "").toLowerCase()}@example.test`, kind]);
      await pool.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,$2)", [id, name]);
    }
    await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name,prompt_version,enabled,memory) VALUES($1,'fixture/model','Fixture model','trinity-v1',false,'Retained private AI notes')", [ai]);
    const matchId = randomUUID();
    await pool.query("BEGIN");
    await pool.query("INSERT INTO ranking_matches(id,public_name,player_count,started_at) VALUES($1,'amber-otter-12345678',2,'2026-11-26T12:00:00Z')", [matchId]);
    await pool.query(`INSERT INTO match_participants(match_id,user_id,seat_number,display_name,badge_id,outcome,score_delta,rating_after) VALUES
      ($1,$2,0,'Alice','rookie','won',16,1016),($1,$3,1,'Fixture AI','rookie','dropped',-16,984)`, [matchId, alice, ai]);
    await pool.query("UPDATE ranking_matches SET status='completed',winner_user_id=$2,end_reason='declaration',ended_at='2026-11-26T12:05:00Z' WHERE id=$1", [matchId, alice]);
    await pool.query("INSERT INTO game_events(event_id,match_id,sequence,event_type,actor_user_id,payload,occurred_at) VALUES($1,$2,1,'game.draw',$3,$4,'2026-11-26T12:00:01Z')", [randomUUID(), matchId, alice, { hand: "PRIVATE_CARD_SENTINEL", email: "PRIVATE_PAYLOAD_EMAIL" }]);
    await pool.query("COMMIT");
    const secondMatch = randomUUID();
    await pool.query("BEGIN");
    await pool.query("INSERT INTO ranking_matches(id,public_name,player_count,started_at) VALUES($1,'brisk-ibis-23456789',2,'2026-11-26T14:00:00Z')", [secondMatch]);
    await pool.query(`INSERT INTO match_participants(match_id,user_id,seat_number,display_name,badge_id,outcome,score_delta,rating_after) VALUES
      ($1,$2,0,'Alice','rookie','lost',-16,1000),($1,$3,1,'Bob','rookie','won',16,1016)`, [secondMatch, alice, bob]);
    await pool.query("UPDATE ranking_matches SET status='completed',winner_user_id=$2,end_reason='declaration',ended_at='2026-11-26T14:05:00Z' WHERE id=$1", [secondMatch, bob]);
    await pool.query("COMMIT");
    const before = await snapshot();
    await runMigrations(pool, migrations.filter(({ name }) => name === "0014_user_activity.sql"));
    expect(await snapshot()).toEqual(before);
    repository = new PostgresActivityRepository(pool, () => now);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });

  it("records real login/logout once without returning credentials, and baseline sessions never fabricate logins", async () => {
    const before = await snapshot();
    await repository.recordLogin(identity(), at(0)); await repository.recordLogin(identity(), at(1));
    await repository.ingest({ ...identity(bob, "b"), event: { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: false } }, at(0));
    const aliceOverview = await repository.overview({ ...filters, userId: alice });
    const bobOverview = await repository.overview({ ...filters, userId: bob });
    expect(aliceOverview.summary.signIns).toBe(1); expect(bobOverview.summary.signIns).toBe(0);
    const sessions = await repository.sessions(filters);
    expect(sessions.items).toHaveLength(2);
    expect(sessions.items.find((s) => s.userId === bob)?.signedInAt).toBeNull();
    expect(sessions.items.every((s) => s.expiresAt === "2026-11-28T00:00:00.000Z")).toBe(true);
    expect(JSON.stringify(sessions)).not.toContain("session_hash"); expect(JSON.stringify(sessions)).not.toContain("a".repeat(64));
    await repository.recordLogout(identity(), at(2)); await repository.recordLogout(identity(), at(3));
    expect((await repository.events(filters, { kind: "auth" })).items.map((e) => e.action).sort()).toEqual(["login", "logout"]);
    expect(await snapshot()).toEqual(before);
  });

  it("uses server elapsed samples, dedupes retries and prevents multiple tabs or sessions double-crediting time", async () => {
    const a = identity(bob, "b"), b = identity(bob, "c");
    const pulse = (eventId = randomUUID(), fresh = false): ActivityIngest => ({ type: "heartbeat", eventId, page: "table", active: true, fresh });
    await repository.ingest({ ...a, event: pulse() }, at(0));
    await repository.ingest({ ...b, event: pulse() }, at(0));
    const packet = pulse();
    await Promise.all([repository.ingest({ ...a, event: packet }, at(15)), repository.ingest({ ...b, event: pulse() }, at(15))]);
    await repository.ingest({ ...a, event: packet }, at(20));
    await repository.ingest({ ...b, event: pulse() }, at(30));
    expect((await repository.overview({ ...filters, userId: bob })).summary.activeSeconds).toBe(30);
    await repository.ingest({ ...a, event: { type: "heartbeat", eventId: randomUUID(), page: "table", active: false } }, at(40));
    await repository.ingest({ ...a, event: pulse(randomUUID(), true) }, at(50));
    expect((await repository.overview({ ...filters, userId: bob })).summary.activeSeconds).toBe(30);
    await repository.ingest({ ...a, event: pulse() }, at(65));
    expect((await repository.overview({ ...filters, userId: bob })).summary.activeSeconds).toBe(45);
    await repository.ingest({ ...a, event: pulse() }, at(200));
    expect((await repository.overview({ ...filters, userId: bob })).summary.activeSeconds).toBe(45);
    const bounds = { ...filters, from: at(60).toISOString(), to: at(120).toISOString(), userId: bob };
    expect((await repository.overview(bounds)).summary.activeSeconds).toBe(5);
  });

  it("protects session ownership and rejects client-invented results/private payloads", async () => {
    await expect(repository.ingest({ ...identity(bob), event: { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: true } }, at(210))).rejects.toThrow();
    await expect(repository.ingest({ ...identity(ai, "d"), event: { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: true } }, at(210))).rejects.toThrow();
    await expect(repository.ingest({ ...identity(bob, "b"), event: { type: "interaction", eventId: randomUUID(), page: "table", action: "match.won" } as unknown as ActivityIngest }, at(210))).rejects.toThrow();
    const event = { type: "interaction", eventId: randomUUID(), page: "rankings", action: "page.view" } as const;
    await repository.ingest({ ...identity(bob, "b"), event }, at(210));
    await repository.ingest({ ...identity(bob, "b"), event }, at(211));
    await repository.recordServerInteraction({ ...identity(bob, "b"), action: "profile.save", page: "profile" }, at(212));
    const events = await repository.events(filters, { kind: "interaction" });
    expect(events.items.map((e) => [e.action, e.source]).sort()).toEqual([["page.view", "browser"], ["profile.save", "server"]]);
    expect(JSON.stringify(await repository.events(filters))).not.toMatch(/PRIVATE_CARD_SENTINEL|PRIVATE_PAYLOAD_EMAIL|session_hash|payload|cookie/);
  });

  it("derives outcomes and game actions from original archive and keeps dropped players separate from losses", async () => {
    const overview = await repository.overview(filters);
    expect(overview.summary).toMatchObject({ matches: 2, wins: 2, losses: 1, drops: 1 });
    expect((await repository.overview({ ...filters, userId: alice })).summary).toMatchObject({ matches: 2, wins: 1, losses: 1, drops: 0 });
    expect((await repository.overview({ ...filters, from: "2026-11-27T00:00:00Z" })).summary.matches).toBe(0);
    expect((await repository.overview({ ...filters, actorKind: "ai" })).summary).toMatchObject({ signIns: 0, activeSeconds: 0, matches: 1, wins: 0, losses: 0, drops: 1 });
    expect((await repository.overview({ ...filters, q: "fixture ai" })).summary.drops).toBe(1);
    expect((await repository.overview({ ...filters, q: "%" })).summary.matches).toBe(0);
    expect(overview.actions).toContainEqual({ action: "game.draw", count: 1, source: "server" });
    expect(overview.daily.find((day) => day.date === "2026-11-26")).toMatchObject({ matches: 2, signIns: 0 });
    const feed = (await repository.events(filters, { kind: "match" })).items;
    expect(feed.map((e) => e.action).sort()).toEqual(["game.draw", "match.dropped", "match.lost", "match.won", "match.won"]);
    const aiRows = (await repository.users({ ...filters, actorKind: "ai" })).items;
    expect(aiRows).toHaveLength(1); expect(aiRows[0]).toMatchObject({ actorKind: "ai", signIns: 0, sessionCount: 0, drops: 1 });
  });

  it("paginates timestamp ties without omission and binds cursors to filters", async () => {
    // SQL-created historical timestamps can retain microseconds even though
    // node-postgres Dates and public cursors have millisecond precision.
    await pool.query(`INSERT INTO activity_events(event_id,user_id,kind,action,source,page,occurred_at) VALUES
      ($1,$3,'interaction','help.open','browser','lobby','2026-11-27T12:10:00.000100Z'),
      ($2,$3,'interaction','help.open','browser','lobby','2026-11-27T12:10:00.000900Z')`, [randomUUID(), randomUUID(), bob]);
    const all = (await repository.events(filters, { limit: 100 })).items;
    const collected: string[] = []; let cursor: string | undefined;
    do {
      const page = await repository.events(filters, { limit: 1, ...(cursor ? { cursor } : {}) });
      collected.push(...page.items.map((e) => e.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(collected).toEqual(all.map((e) => e.id)); expect(new Set(collected).size).toBe(collected.length);
    const first = await repository.events(filters, { limit: 1 });
    await expect(repository.events({ ...filters, actorKind: "ai" }, { cursor: first.nextCursor! })).rejects.toThrow("different filters");
    await expect(repository.events(filters, { kind: "auth", cursor: first.nextCursor! })).rejects.toThrow("different filters");
    const users = await repository.users(filters, { limit: 1 });
    expect(users.nextCursor).not.toBeNull();
    const usersNext = await repository.users(filters, { limit: 1, cursor: users.nextCursor! });
    expect(users.items[0]?.userId).not.toBe(usersNext.items[0]?.userId);
    const sessionPage = await repository.sessions(filters, { limit: 1 });
    expect(sessionPage.nextCursor).not.toBeNull();
    expect((await repository.sessions(filters, { limit: 1, cursor: sessionPage.nextCursor! })).items[0]?.id).not.toBe(sessionPage.items[0]?.id);
  });

  it("serializes concurrent heartbeats, server interactions and another session's logout without deadlocks", async () => {
    const primary = identity(bob, "e");
    const other = identity(bob, "f");
    await repository.recordLogin(primary, at(300));
    await repository.recordLogin(other, at(300));
    const jobs: Array<Promise<void>> = [];
    for (let index = 0; index < 12; index++) {
      const receivedAt = at(300 + index);
      jobs.push(repository.recordServerInteraction({ ...primary, action: "profile.save", page: "profile" }, receivedAt));
      jobs.push(repository.ingest({ ...primary, event: { type: "heartbeat", eventId: randomUUID(), page: "profile", active: true, fresh: index === 0 } }, receivedAt));
      jobs.push(repository.recordLogout(other, receivedAt));
    }
    const results = await Promise.allSettled(jobs);
    expect(results.every(({ status }) => status === "fulfilled")).toBe(true);
    const count = await pool.query("SELECT count(*) FROM activity_events WHERE user_id=$1 AND action='profile.save' AND occurred_at>=$2", [bob, at(300)]);
    expect(count.rows[0].count).toBe("12");
    const logouts = await pool.query("SELECT count(*) FROM activity_events WHERE user_id=$1 AND action='logout'", [bob]);
    expect(logouts.rows[0].count).toBe("1");
    const sessions = await repository.sessions({ ...filters, userId: bob }, { limit: 100 });
    expect(sessions.items.filter((session) => session.endedAt !== null)).toHaveLength(1);
  });

  it("prunes only retained analytics, preserves collection start and never deletes game history", async () => {
    const before = await snapshot();
    const trackingSince = (await repository.overview(filters)).trackingSince;
    await repository.pruneRetention(new Date("2027-04-01T00:00:00Z"));
    expect((await pool.query("SELECT count(*) FROM activity_events")).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM activity_sessions")).rows[0].count).toBe("0");
    expect((await pool.query("SELECT collection_started_at FROM activity_settings")).rows[0].collection_started_at.toISOString()).toBe(trackingSince);
    expect(await snapshot()).toEqual(before);
  });
});
