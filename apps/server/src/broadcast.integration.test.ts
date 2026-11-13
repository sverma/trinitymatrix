import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./db/migrate";
import { RankingGame, type RankingGameSnapshot } from "./game";
import { BroadcastConflictError, PostgresBroadcastRepository } from "./broadcast-repository";
import { registerBroadcastMediaRoutes } from "./broadcast-media-routes";

const databaseUrl = process.env.BROADCAST_TEST_DATABASE_URL ?? process.env.AI_RATINGS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("delayed broadcasts in isolated PostgreSQL", () => {
  const schema = `broadcast_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let repository: PostgresBroadcastRepository;
  let serial = 10_000_000;
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.toLowerCase().includes("test")) throw new Error("Broadcast integration requires a dedicated test database.");
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const names = ["0001_core_persistence.sql", "0002_post_game_chat.sql", "0003_private_matches.sql", "0004_distributed_game_runtime.sql",
      "0005_matchmaking_ticket_liveness.sql", "0006_replay_exports.sql", "0007_admin_passkeys.sql", "0008_model_bound_ai_players.sql", "0009_live_broadcasts.sql"];
    await runMigrations(pool, names.map((name) => ({ name, sql: readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8") })));
    repository = new PostgresBroadcastRepository(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  async function user(kind: "human" | "ai" = "human", name = "Viewer") {
    const id = randomUUID();
    await pool.query("INSERT INTO app_users(id,email,actor_kind) VALUES($1,$2,$3)", [id, `${id}@example.test`, kind]);
    await pool.query("INSERT INTO player_profiles(user_id,display_name) VALUES($1,$2)", [id, name]);
    if (kind === "ai") await pool.query("INSERT INTO ai_agents(user_id,model_id,model_name) VALUES($1,$2,'Fixture model')", [id, `fixture/${id}`]);
    return id;
  }
  async function event(snapshot: RankingGameSnapshot, sequence: number, occurredAt: Date, recordedAt = occurredAt) {
    await pool.query(
      `INSERT INTO game_events(event_id,match_id,sequence,event_type,payload,occurred_at,recorded_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), snapshot.id, sequence, sequence === 1 ? "game.started" : "game.discard", {
        state: { ...snapshot, revision: sequence }, email: "PRIVATE_EMAIL", memory: "PRIVATE_AGENT_NOTES", command: { token: "PRIVATE_COMMAND_TOKEN" }
      }, occurredAt, recordedAt]
    );
  }
  async function game(options: { composition?: "human" | "ai" | "mixed"; private?: boolean; archived?: boolean; enabled?: boolean } = {}) {
    const composition = options.composition ?? "human";
    const ids = [await user(composition === "ai" ? "ai" : "human", "First player"), await user(composition === "human" ? "human" : "ai", "Second player")];
    const snapshot = new RankingGame(ids.map((id, index) => ({ id, displayName: index ? "Second player" : "First player",
      actorKind: (composition === "ai" || (composition === "mixed" && index === 1)) ? "ai" : "human" })), () => 0).snapshot();
    snapshot.publicName = `amber-lotus-${serial++}`;
    snapshot.toss = null;
    snapshot.stock[0]!.id = "PRIVATE_STOCK_ORDER";
    snapshot.seenCommands = ["PRIVATE_SEEN_COMMAND"];
    await pool.query("INSERT INTO ranking_matches(id,public_name,player_count,match_type) VALUES($1,$2,2,$3)", [snapshot.id, snapshot.publicName, options.private ? "private" : "general"]);
    for (const [seat, id] of ids.entries()) await pool.query(
      "INSERT INTO match_participants(match_id,user_id,seat_number,display_name,badge_id) VALUES($1,$2,$3,$4,'rookie')",
      [snapshot.id, id, seat, snapshot.seats[seat]!.displayName]
    );
    if (options.archived !== false) await event(snapshot, 1, new Date(Date.now() - 300_000));
    if (options.enabled !== false) await repository.enableForGame(snapshot);
    return { snapshot, ids, name: snapshot.publicName };
  }
  async function complete(snapshot: RankingGameSnapshot) {
    await pool.query("UPDATE ranking_matches SET status='completed',winner_user_id=$2,end_reason='declaration',ended_at=clock_timestamp()-interval '10 minutes' WHERE id=$1", [snapshot.id, snapshot.seats[0]!.id]);
  }

  it("guards both timestamps for detail, full hands, directory status, timeline and exact DVR fetch", async () => {
    const { snapshot, name } = await game(); const anchor = new Date();
    const recent = { ...snapshot, phase: "finished" as const };
    await event(recent, 2, new Date(+anchor - 300_000), anchor);
    expect((await repository.detail(name, new Date(+anchor + 119_999)))?.frame?.sequence).toBe(1);
    expect((await repository.detail(name, new Date(+anchor + 119_999)))?.broadcast.status).toBe("live");
    expect(await repository.frame(name, 2, new Date(+anchor + 119_999))).toBeNull();
    const released = await repository.detail(name, new Date(+anchor + 120_000));
    expect(released?.frame?.sequence).toBe(2);
    expect(released?.frame?.hands).toEqual(snapshot.hands);
    expect(released?.broadcast.status).toBe("ended");
    expect(JSON.stringify(released)).not.toMatch(/PRIVATE_|seenCommands|"stock"|"payload"|"memory"|"command"|"email"/);
    await event(snapshot, 3, new Date(+anchor + 20_000), new Date(+anchor - 300_000));
    expect((await repository.timeline(name, undefined, 100, new Date(+anchor + 120_000))).frames.map(({ sequence }) => sequence)).toEqual([2, 1]);
    expect(await repository.frame(name, 3, new Date(+anchor + 139_999))).toBeNull();
    expect((await repository.frame(name, 3, new Date(+anchor + 140_000)))?.sequence).toBe(3);
    const firstPage = await repository.timeline(name, undefined, 1, new Date(+anchor + 140_000));
    expect(firstPage.nextCursor).toBe("3");
    expect((await repository.timeline(name, 3, 1, new Date(+anchor + 140_000))).frames[0]?.sequence).toBe(2);
  });

  it("delays results from server completion receipt even when ended_at was backdated", async () => {
    const { snapshot, name } = await game();
    await event({ ...snapshot, phase: "finished" }, 2, new Date(Date.now() - 300_000));
    await complete(snapshot);
    const stamp = Number((await pool.query<{ received_ms: string }>("SELECT ceil(extract(epoch FROM result_recorded_at)*1000)::bigint AS received_ms FROM live_broadcasts WHERE match_id=$1", [snapshot.id])).rows[0]!.received_ms);
    expect((await repository.detail(name, new Date(stamp + 119_999)))?.frame?.winner).toBeUndefined();
    expect((await repository.detail(name, new Date(stamp + 120_000)))?.frame?.winner)
      .toMatchObject({ id: snapshot.seats[0]!.id, name: "First player", reason: "declaration" });
  });

  it("requires an archive, excludes private games, preserves closed rows and enrolls authorized fast completions safely", async () => {
    const privateGame = await game({ private: true });
    expect(await repository.detail(privateGame.name)).toBeNull();
    await expect(pool.query("INSERT INTO live_broadcasts(id,match_id,public_name) VALUES($1,$2,$3)", [randomUUID(), privateGame.snapshot.id, privateGame.name])).rejects.toThrow("Only public general");
    const missingArchive = await game({ archived: false });
    expect(await repository.detail(missingArchive.name)).toBeNull();
    const fast = await game({ enabled: false }); await complete(fast.snapshot); await repository.enableForGame(fast.snapshot);
    const row = (await pool.query<{ result_recorded_at: Date }>("SELECT result_recorded_at FROM live_broadcasts WHERE match_id=$1", [fast.snapshot.id])).rows[0]!;
    expect(row.result_recorded_at).toBeInstanceOf(Date);
    await repository.enableForGame(fast.snapshot);
    expect((await repository.access(fast.name, fast.ids[0]!))?.participantIds).toEqual(fast.ids);
    expect(await repository.close(fast.name)).toBeTypeOf("string");
    await repository.enableForGame(fast.snapshot);
    expect(await repository.access(fast.name, fast.ids[0]!)).toBeNull();
    expect(await repository.detail(fast.name)).toBeNull();
    expect(await repository.frame(fast.name, 1)).toBeNull();
    expect((await repository.timeline(fast.name, undefined, 50)).frames).toEqual([]);
  });

  it("delays participant chat, serializes per-user rate limits and retries idempotently", async () => {
    const { name, ids } = await game(); const spectator = await user();
    const pending = await repository.addComment(name, ids[0]!, { message: "Private until delayed", clientMessageId: randomUUID() });
    expect(pending.delayed).toBe(true); expect(pending.comment).toBeUndefined();
    expect((await repository.detail(name))?.comments).toEqual([]);
    expect((await repository.detail(name, new Date(pending.availableAt)))?.comments[0]?.message).toBe("Private until delayed");
    const bodies = Array.from({ length: 6 }, (_, index) => ({ message: `Message ${index}`, clientMessageId: randomUUID() }));
    const attempts = await Promise.allSettled(bodies.map((body) => repository.addComment(name, spectator, body)));
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(5);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const acceptedIndex = attempts.findIndex(({ status }) => status === "fulfilled");
    const replay = await repository.addComment(name, spectator, { ...bodies[acceptedIndex]!, message: "Do not replace original" });
    expect(replay.comment?.message).toBe(bodies[acceptedIndex]!.message);
    const count = (await pool.query("SELECT count(*)::int AS n FROM live_broadcast_comments WHERE author_user_id=$1", [spectator])).rows[0]!.n;
    expect(count).toBe(5);
  });

  it("supports idempotent reports, moderation tombstones and suspended-author exclusion", async () => {
    const { name, ids } = await game(); const spectator = await user();
    const immediate = await repository.addComment(name, spectator, { message: "A spectator comment", clientMessageId: randomUUID() });
    const id = immediate.comment!.id;
    expect(await repository.reportComment(name, id, ids[0]!, "Please review")).toBe(true);
    expect(await repository.reportComment(name, id, ids[0]!, "Repeated report")).toBe(true);
    const reports = await repository.reports(50);
    expect(reports.reports.filter(({ comment }) => comment.id === id)).toHaveLength(1);
    expect(await repository.resolveReport(reports.reports.find(({ comment }) => comment.id === id)!.id, ids[0]!, true)).toBe(true);
    expect((await repository.detail(name))?.comments.find((comment) => comment.id === id)).toMatchObject({ deleted: true, message: "" });
    await pool.query("UPDATE app_users SET suspended_at=clock_timestamp(),suspension_reason='Integration moderation' WHERE id=$1", [spectator]);
    expect(await repository.access(name, spectator)).toBeNull();
    expect((await repository.detail(name))?.comments.find((comment) => comment.id === id)).toBeUndefined();
    await expect(repository.addComment(name, spectator, { message: "No access", clientMessageId: randomUUID() })).rejects.toBeInstanceOf(BroadcastConflictError);
  });

  it("returns spectator comments immediately despite application clock skew and allows reporting at once", async () => {
    const { name, ids } = await game(); const spectator = await user(); const clientMessageId = randomUUID();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 1_000);
    let posted: Awaited<ReturnType<PostgresBroadcastRepository["addComment"]>>;
    try {
      posted = await repository.addComment(name, spectator, { message: "Immediate spectator comment", clientMessageId });
      expect(posted.delayed).toBe(false);
      expect(posted.comment).toMatchObject({ playerId: spectator, message: "Immediate spectator comment" });
      const replay = await repository.addComment(name, spectator, { message: "Do not replace original", clientMessageId });
      expect(replay).toEqual(posted);
    } finally { clock.mockRestore(); }
    expect(await repository.reportComment(name, posted!.comment!.id, ids[0]!, "Please review")).toBe(true);
    expect((await repository.detail(name))?.comments).toContainEqual(posted!.comment!);
    const release = (await pool.query<{ immediate: boolean; released: boolean }>(
      "SELECT released_at=created_at AS immediate,released_at<=clock_timestamp() AS released FROM live_broadcast_comments WHERE id=$1", [posted!.comment!.id]
    )).rows[0]!;
    expect(release).toEqual({ immediate: true, released: true });
  });

  it("paginates a composition-filtered directory and enforces the single active video publisher", async () => {
    const first = await game({ composition: "ai" }); await game({ composition: "mixed" }); await game({ composition: "ai" });
    const page = await repository.directory({ composition: "ai", status: "live", limit: 1 });
    expect(page.broadcasts).toHaveLength(1); expect(page.broadcasts[0]!.composition).toBe("ai"); expect(page.nextCursor).not.toBeNull();
    const next = await repository.directory({ composition: "ai", status: "live", limit: 1, cursor: page.nextCursor! });
    expect(next.broadcasts).toHaveLength(1); expect(next.broadcasts[0]!.gameId).not.toBe(page.broadcasts[0]!.gameId);
    expect((await repository.directory({ composition: "all", status: "all", q: first.name, limit: 50 })).broadcasts.map(({ gameName }) => gameName)).toEqual([first.name]);
    const broadcastId = (await repository.access(first.name, first.ids[0]!))!.broadcastId;
    await pool.query("INSERT INTO live_broadcast_video_sessions(id,broadcast_id,publisher_id,status) VALUES($1,$2,$3,'starting')", [randomUUID(), broadcastId, first.ids[0]]);
    await expect(pool.query("INSERT INTO live_broadcast_video_sessions(id,broadcast_id,publisher_id,status) VALUES($1,$2,$3,'live')", [randomUUID(), broadcastId, first.ids[1]])).rejects.toThrow("duplicate");
    await pool.query("UPDATE live_broadcast_video_sessions SET status='stopped',ended_at=clock_timestamp() WHERE broadcast_id=$1", [broadcastId]);
    await expect(pool.query("INSERT INTO live_broadcast_video_sessions(id,broadcast_id,publisher_id,status) VALUES($1,$2,$3,'starting')", [randomUUID(), broadcastId, first.ids[1]])).resolves.toMatchObject({ rowCount: 1 });
  });

  it("atomically admits only one of two simultaneous gateway publishers into the last global slot", async () => {
    const first = await game(); const second = await game();
    const activeBefore = Number((await pool.query("SELECT count(*)::int AS n FROM live_broadcast_video_sessions WHERE status IN ('starting','live')")).rows[0]!.n);
    const app = Fastify(); let workerStarts = 0;
    registerBroadcastMediaRoutes(app, {
      pool, repository, resolveSession: async (request) => ({ playerId: String(request.headers["x-user"]) }), resolveAdminAccess: async () => false,
      allowedOrigins: new Set(["https://trinitymatrix.org"]), isReady: () => true, enabled: true, mediaUrl: "http://fixture-media:8082",
      mediaSecret: "synthetic-integration-media-secret", maximumStreams: activeBefore + 1,
      fetch: async (_url, init) => {
        workerStarts += 1;
        return Response.json({ id: JSON.parse(String(init!.body)).id, availableAt: Date.now() + 120_000 }, { status: 201 });
      }
    });
    try {
      const results = await Promise.all([first, second].map((table) => app.inject({ method: "POST", url: `/api/live/${table.name}/video/start`,
        headers: { "x-user": table.ids[0]!, origin: "https://trinitymatrix.org" } })));
      expect(results.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
      expect(workerStarts).toBe(1);
      const activeAfter = Number((await pool.query("SELECT count(*)::int AS n FROM live_broadcast_video_sessions WHERE status IN ('starting','live')")).rows[0]!.n);
      expect(activeAfter).toBe(activeBefore + 1);
    } finally { await app.close(); }
  });
});
