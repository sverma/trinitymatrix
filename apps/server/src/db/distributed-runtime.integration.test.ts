import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDistributedGameRuntime } from "./distributed-runtime";
import { runMigrations } from "./migrate";
import { RankingGame } from "../game";

const databaseUrl = process.env.DISTRIBUTED_RUNTIME_TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("distributed runtime PostgreSQL integration", () => {
  let pool: Pool;
  let secondPool: Pool;

  const ids = {
    first: randomUUID(),
    second: randomUUID(),
    match: randomUUID(),
    initialEvent: randomUUID(),
    command: randomUUID(),
    commandEvent: randomUUID(),
    timeoutEvent: randomUUID(),
    matchTwo: randomUUID(),
    matchThree: randomUUID(),
    initialTwo: randomUUID(),
    initialThree: randomUUID(),
    concurrentCommand: randomUUID(),
    concurrentEvent: randomUUID(),
    ticketOne: randomUUID(),
    ticketTwo: randomUUID(),
    ghostMatch: randomUUID(),
    ghostEvent: randomUUID()
  };
  const startedAt = new Date("2026-08-29T12:00:00.000Z");

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!parsed.pathname.toLowerCase().includes("test")) {
      throw new Error("DISTRIBUTED_RUNTIME_TEST_DATABASE_URL must target a dedicated database whose name contains 'test'.");
    }
    pool = new Pool({ connectionString: databaseUrl });
    secondPool = new Pool({ connectionString: databaseUrl });
    const migration = (name: string) => ({
      name,
      sql: readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8")
    });
    await runMigrations(pool, [
      migration("0001_core_persistence.sql"),
      migration("0002_post_game_chat.sql"),
      migration("0003_private_matches.sql"),
      migration("0004_distributed_game_runtime.sql"),
      migration("0005_matchmaking_ticket_liveness.sql")
    ]);
    for (const [id, email, displayName] of [
      [ids.first, `${ids.first}@example.test`, "Asha"],
      [ids.second, `${ids.second}@example.test`, "Bela"]
    ]) {
      await pool.query("INSERT INTO app_users (id, email) VALUES ($1, $2)", [id, email]);
      await pool.query(
        "INSERT INTO player_profiles (user_id, display_name, badge_id) VALUES ($1, $2, 'rookie')",
        [id, displayName]
      );
      await pool.query("INSERT INTO player_rankings (user_id) VALUES ($1)", [id]);
    }
    const createMatch = async (matchId: string, eventId: string, suffix: string) => {
      await pool.query(
        `INSERT INTO ranking_matches (id, public_name, player_count, match_type, started_at)
         VALUES ($1, $2, 2, 'general', $3)`,
        [matchId, `amber-lotus-${suffix}`, startedAt]
      );
      await pool.query(
        `INSERT INTO match_participants (match_id, user_id, seat_number, display_name, badge_id)
         VALUES ($1, $2, 0, 'Asha', 'rookie'), ($1, $3, 1, 'Bela', 'rookie')`,
        [matchId, ids.first, ids.second]
      );
      await pool.query(
        `INSERT INTO game_events (
           event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
         ) VALUES ($1, $2, 1, 'game.started', NULL, NULL, $3::jsonb, $4)`,
        [eventId, matchId, JSON.stringify({
          state: {
            revision: 1,
            seats: [
              { id: ids.first, detached: false },
              { id: ids.second, detached: false }
            ]
          }
        }), startedAt]
      );
    };
    await createMatch(ids.match, ids.initialEvent, "10000001");
    await createMatch(ids.matchTwo, ids.initialTwo, "10000002");
    await createMatch(ids.matchThree, ids.initialThree, "10000003");
  });

  afterAll(async () => {
    await Promise.all([pool?.end(), secondPool?.end()]);
  });

  it("fences an expired owner and replays a duplicate command without a second event or outbox row", async () => {
    const runtime = new PostgresDistributedGameRuntime(pool);
    const ownerA = await runtime.claimOwnership({
      matchId: ids.match,
      ownerInstanceId: "app-a",
      protocolVersion: 1,
      leaseDurationMs: 30_000,
      now: startedAt
    });
    expect(ownerA.fencingToken).toBe(1);

    const transition = {
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: ownerA.fencingToken,
      expectedNextSequence: 2,
      event: {
        eventId: ids.commandEvent,
        eventType: "game.draw-stock",
        actorUserId: ids.first,
        commandId: ids.command,
        payload: { state: { revision: 2 } },
        occurredAt: new Date(startedAt.getTime() + 1_000)
      },
      command: {
        actorUserId: ids.first,
        commandType: "game.draw-stock",
        expectedRevision: 1,
        payload: { expectedRevision: 1 },
        result: { accepted: true, revision: 2 }
      },
      nextDeadline: {
        type: "turn" as const,
        dueAt: new Date(startedAt.getTime() + 45_000),
        expectedRevision: 2,
        payload: { matchId: ids.match }
      }
    };
    await expect(runtime.commitTransition(transition, new Date(startedAt.getTime() + 1_000)))
      .resolves.toMatchObject({ disposition: "committed", eventSequence: 2 });
    await expect(runtime.commitTransition(transition, new Date(startedAt.getTime() + 2_000)))
      .resolves.toMatchObject({ disposition: "replayed", eventSequence: 2 });

    const recovered = await runtime.claimOrphanedDueDeadlines({
      workerId: "timer-worker",
      ownerInstanceId: "app-b",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      deadlineLeaseDurationMs: 10_000,
      now: new Date(startedAt.getTime() + 46_000)
    });
    expect(recovered).toHaveLength(1);
    const ownerB = recovered[0]!.lease;
    expect(ownerB.fencingToken).toBe(2);
    expect(recovered[0]!.deadline).toMatchObject({
      matchId: ids.match,
      expectedRevision: 2,
      fencingToken: ownerB.fencingToken,
      ownerInstanceId: "app-b"
    });
    await expect(runtime.readOperationalMetrics(new Date(startedAt.getTime() + 46_000))).resolves.toMatchObject({
      outboxBacklog: 1,
      dueDeadlineCount: 1,
      orphanedGameCount: 0
    });

    const timeout = {
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: ownerA.fencingToken,
      expectedNextSequence: 3,
      event: {
        eventId: ids.timeoutEvent,
        eventType: "game.turn-timed-out",
        actorUserId: null,
        commandId: null,
        payload: { state: { revision: 3 } },
        occurredAt: new Date(startedAt.getTime() + 46_000)
      },
      command: null,
      nextDeadline: null
    } as const;
    await expect(runtime.commitTransition(timeout, new Date(startedAt.getTime() + 46_000)))
      .rejects.toThrow("fencing token");
    await expect(runtime.commitTransition({
      ...timeout,
      ownerInstanceId: "app-b",
      fencingToken: ownerB.fencingToken
    }, new Date(startedAt.getTime() + 46_000))).resolves.toMatchObject({
      disposition: "committed",
      eventSequence: 3
    });

    const counts = await pool.query<{ events: string; commands: string; outbox: string; deadlines: string }>(
      `SELECT
         (SELECT count(*) FROM game_events WHERE match_id = $1) AS events,
         (SELECT count(*) FROM durable_game_commands WHERE match_id = $1) AS commands,
         (SELECT count(*) FROM game_event_outbox WHERE match_id = $1) AS outbox,
         (SELECT count(*) FROM recoverable_game_deadlines WHERE match_id = $1) AS deadlines`,
      [ids.match]
    );
    expect(counts.rows[0]).toEqual({ events: "3", commands: "1", outbox: "2", deadlines: "0" });
    const predecessor = await runtime.claimOutbox({
      workerId: "publisher-after-takeover",
      leaseDurationMs: 10_000,
      now: new Date(startedAt.getTime() + 47_000)
    });
    expect(predecessor.map(({ eventSequence, fencingToken }) => ({ eventSequence, fencingToken })))
      .toEqual([{ eventSequence: 2, fencingToken: 1 }]);
    await runtime.markOutboxPublished({
      outboxId: predecessor[0]!.outboxId,
      workerId: "publisher-after-takeover",
      publishedAt: new Date(startedAt.getTime() + 47_000)
    });
    const successor = await runtime.claimOutbox({
      workerId: "publisher-after-takeover",
      leaseDurationMs: 10_000,
      now: new Date(startedAt.getTime() + 47_001)
    });
    expect(successor.map(({ eventSequence, fencingToken }) => ({ eventSequence, fencingToken })))
      .toEqual([{ eventSequence: 3, fencingToken: 2 }]);
  });

  it("serializes simultaneous duplicate first attempts across two pools and renews owners in one batch", async () => {
    const firstRuntime = new PostgresDistributedGameRuntime(pool);
    const secondRuntime = new PostgresDistributedGameRuntime(secondPool);
    const owner = await firstRuntime.claimOwnership({
      matchId: ids.matchTwo,
      ownerInstanceId: "app-c",
      protocolVersion: 1,
      leaseDurationMs: 30_000,
      now: startedAt
    });
    const transition = {
      matchId: ids.matchTwo,
      ownerInstanceId: "app-c",
      fencingToken: owner.fencingToken,
      expectedNextSequence: 2,
      event: {
        eventId: ids.concurrentEvent,
        eventType: "game.draw-stock",
        actorUserId: ids.first,
        commandId: ids.concurrentCommand,
        payload: { state: { revision: 2 } },
        occurredAt: new Date(startedAt.getTime() + 1_000)
      },
      command: {
        actorUserId: ids.first,
        commandType: "game.draw-stock",
        expectedRevision: 1,
        payload: { expectedRevision: 1 },
        result: { accepted: true, revision: 2 }
      },
      nextDeadline: {
        type: "turn" as const,
        dueAt: new Date(startedAt.getTime() + 45_000),
        expectedRevision: 2,
        payload: { matchId: ids.matchTwo }
      }
    };

    const results = await Promise.all([
      firstRuntime.commitTransition(transition, new Date(startedAt.getTime() + 1_000)),
      secondRuntime.commitTransition(transition, new Date(startedAt.getTime() + 1_000))
    ]);
    expect(results.map(({ disposition }) => disposition).sort()).toEqual(["committed", "replayed"]);
    const counts = await pool.query<{ events: string; commands: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM game_events WHERE match_id = $1) AS events,
         (SELECT count(*) FROM durable_game_commands WHERE match_id = $1) AS commands,
         (SELECT count(*) FROM game_event_outbox WHERE match_id = $1) AS outbox`,
      [ids.matchTwo]
    );
    expect(counts.rows[0]).toEqual({ events: "2", commands: "1", outbox: "1" });

    const thirdOwner = await firstRuntime.claimOwnership({
      matchId: ids.matchThree,
      ownerInstanceId: "app-c",
      protocolVersion: 1,
      leaseDurationMs: 30_000,
      now: startedAt
    });
    const renewed = await firstRuntime.renewOwnershipBatch({
      ownerInstanceId: "app-c",
      leases: [
        { matchId: ids.matchTwo, fencingToken: owner.fencingToken },
        { matchId: ids.matchThree, fencingToken: thirdOwner.fencingToken }
      ],
      leaseDurationMs: 60_000,
      now: new Date(startedAt.getTime() + 2_000)
    });
    expect(renewed).toHaveLength(2);
    expect(renewed.every(({ leaseExpiresAt }) => leaseExpiresAt.getTime() === startedAt.getTime() + 62_000)).toBe(true);
  });

  it("heartbeats the same reconnect ticket and cancellation prevents a claimed ghost match", async () => {
    const runtime = new PostgresDistributedGameRuntime(pool);
    const first = await runtime.enqueueMatchmakingTicket({
      ticketId: ids.ticketOne,
      playerId: ids.first,
      playerCount: 2,
      region: "ap-south-1",
      protocolVersion: 1,
      ttlMs: 30_000,
      now: startedAt
    });
    const reconnect = await runtime.enqueueMatchmakingTicket({
      ticketId: randomUUID(),
      playerId: ids.first,
      playerCount: 2,
      region: "ap-south-1",
      protocolVersion: 1,
      ttlMs: 30_000,
      now: new Date(startedAt.getTime() + 1_000)
    });
    expect(reconnect.ticketId).toBe(first.ticketId);
    expect(reconnect.expiresAt.getTime()).toBe(startedAt.getTime() + 31_000);
    const heartbeat = await runtime.heartbeatMatchmakingTicket({
      ticketId: first.ticketId,
      playerId: ids.first,
      ttlMs: 30_000,
      now: new Date(startedAt.getTime() + 1_500)
    });
    expect(heartbeat.expiresAt.getTime()).toBe(startedAt.getTime() + 31_500);
    await expect(runtime.heartbeatMatchmakingTickets({
      tickets: [
        { ticketId: first.ticketId, playerId: ids.first },
        { ticketId: randomUUID(), playerId: ids.second }
      ],
      ttlMs: 30_000,
      now: new Date(startedAt.getTime() + 1_750)
    })).resolves.toEqual([
      expect.objectContaining({ ticketId: first.ticketId, playerId: ids.first })
    ]);

    await runtime.enqueueMatchmakingTicket({
      ticketId: ids.ticketTwo,
      playerId: ids.second,
      playerCount: 2,
      region: "ap-south-1",
      protocolVersion: 1,
      ttlMs: 30_000,
      now: new Date(startedAt.getTime() + 1_000)
    });
    const claimed = await runtime.claimMatchmakingGroup({
      coordinatorId: "matcher-a",
      playerCount: 2,
      region: "ap-south-1",
      protocolVersion: 1,
      leaseDurationMs: 10_000,
      now: new Date(startedAt.getTime() + 2_000)
    });
    expect(claimed).toHaveLength(2);
    await expect(runtime.cancelMatchmakingTicket({
      ticketId: first.ticketId,
      playerId: ids.first,
      now: new Date(startedAt.getTime() + 3_000)
    })).resolves.toBe(true);

    await expect(runtime.startClaimedGeneralGame({
      coordinatorId: "matcher-a",
      ticketIds: claimed.map(({ ticketId }) => ticketId),
      matchId: ids.ghostMatch,
      publicName: "amber-lotus-10000004",
      playerCount: 2,
      ownerInstanceId: "app-d",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      startedAt: new Date(startedAt.getTime() + 3_000),
      now: new Date(startedAt.getTime() + 3_000),
      participants: [
        { userId: ids.first, seatNumber: 0, displayName: "Asha", badgeId: "rookie" },
        { userId: ids.second, seatNumber: 1, displayName: "Bela", badgeId: "rookie" }
      ],
      initialEvent: { eventId: ids.ghostEvent, payload: { state: { revision: 1 } } },
      firstDeadline: {
        type: "turn",
        dueAt: new Date(startedAt.getTime() + 48_000),
        expectedRevision: 1,
        payload: { matchId: ids.ghostMatch }
      }
    })).rejects.toThrow("claim expired");
    const ghost = await pool.query("SELECT id FROM ranking_matches WHERE id = $1", [ids.ghostMatch]);
    expect(ghost.rows).toEqual([]);

    // The still-waiting second ticket expires without a heartbeat and is
    // cancelled before it can be selected into a future match.
    await runtime.claimMatchmakingGroup({
      coordinatorId: "matcher-b",
      playerCount: 2,
      region: "ap-south-1",
      protocolVersion: 1,
      leaseDurationMs: 10_000,
      now: new Date(startedAt.getTime() + 32_000)
    });
    const status = await pool.query<{ status: string }>(
      "SELECT status FROM distributed_matchmaking_tickets WHERE ticket_id = $1",
      [ids.ticketTwo]
    );
    expect(status.rows[0]?.status).toBe("cancelled");
  });

  it("batch-acknowledges independent claimed events atomically and changes nothing on partial ownership", async () => {
    const runtime = new PostgresDistributedGameRuntime(pool);
    const firstOutbox = randomUUID();
    const secondOutbox = randomUUID();
    const outboxIds = [firstOutbox, secondOutbox] as const;
    const claimedUntil = new Date(startedAt.getTime() + 120_000);
    await pool.query(
      `INSERT INTO game_event_outbox (
         outbox_id, match_id, event_sequence, fencing_token, topic, routing_key,
         payload, created_at, available_at, locked_by, locked_until
       ) VALUES
         ($1, $2, 1, 1, 'game.event', $2::uuid::text, '{}', $5, $5, 'batch-a', $6),
         ($3, $4, 1, 1, 'game.event', $4::uuid::text, '{}', $5, $5, 'batch-a', $6)`,
      [firstOutbox, ids.matchTwo, secondOutbox, ids.matchThree, startedAt, claimedUntil]
    );

    const publishedAt = new Date(startedAt.getTime() + 60_000);
    await expect(runtime.markOutboxPublishedBatch({
      outboxIds,
      workerId: "batch-a",
      publishedAt
    })).resolves.toBeUndefined();
    const published = await pool.query<{ outbox_id: string; published_at: Date; locked_by: string | null }>(
      `SELECT outbox_id, published_at, locked_by
       FROM game_event_outbox WHERE outbox_id = ANY($1::uuid[]) ORDER BY outbox_id`,
      [outboxIds]
    );
    expect(published.rows).toHaveLength(2);
    expect(published.rows.every((row) => row.published_at.getTime() === publishedAt.getTime())).toBe(true);
    expect(published.rows.every((row) => row.locked_by === null)).toBe(true);

    await pool.query(
      `UPDATE game_event_outbox
       SET published_at = NULL,
           locked_by = CASE WHEN outbox_id = $1 THEN 'batch-a' ELSE 'batch-b' END,
           locked_until = $3
       WHERE outbox_id = ANY($2::uuid[])`,
      [firstOutbox, outboxIds, claimedUntil]
    );
    await expect(runtime.markOutboxPublishedBatch({
      outboxIds,
      workerId: "batch-a",
      publishedAt
    })).rejects.toThrow("outbox claims were lost");
    const unchanged = await pool.query<{ outbox_id: string; published_at: Date | null; locked_by: string }>(
      `SELECT outbox_id, published_at, locked_by
       FROM game_event_outbox WHERE outbox_id = ANY($1::uuid[]) ORDER BY outbox_id`,
      [outboxIds]
    );
    expect(unchanged.rows.every((row) => row.published_at === null)).toBe(true);
    expect(unchanged.rows.map(({ locked_by }) => locked_by).sort()).toEqual(["batch-a", "batch-b"]);
  });

  it("atomically starts and materializes a ready private game", async () => {
    const runtime = new PostgresDistributedGameRuntime(pool);
    const roomId = randomUUID();
    const roomCode = "amber-lotus-654321";
    const secondEmail = `${ids.second}@example.test`;
    await pool.query(
      `INSERT INTO private_match_rooms (
         id, room_code, creator_user_id, player_count, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 2, 'waiting', $4, $4)`,
      [roomId, roomCode, ids.first, startedAt]
    );
    await pool.query(
      `INSERT INTO private_match_invitations (
         room_id, invite_email, seat_number, accepted_by_user_id, accepted_at, created_at
       ) VALUES ($1, $2, 1, $3, $4, $4)`,
      [roomId, secondEmail, ids.second, startedAt]
    );

    const game = new RankingGame([
      { id: ids.first, displayName: "Asha", badgeId: "rookie" },
      { id: ids.second, displayName: "Bela", badgeId: "rookie" }
    ], () => 0);
    const snapshot = game.snapshot();
    const startedPrivateAt = new Date(startedAt.getTime() + 100_000);
    const initialEventId = randomUUID();
    const lease = await runtime.startReadyPrivateGame({
      roomCode,
      matchId: game.id,
      publicName: game.publicName,
      playerCount: 2,
      ownerInstanceId: "private-app",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      startedAt: startedPrivateAt,
      now: startedPrivateAt,
      participants: snapshot.seats.map((seat, seatNumber) => ({
        userId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      initialEvent: {
        eventId: initialEventId,
        payload: {
          state: snapshot,
          matchType: "private",
          privateRoomCode: roomCode,
          result: null,
          actorPlayerId: null
        }
      },
      firstDeadline: {
        type: "turn",
        dueAt: new Date(snapshot.turnEndsAt),
        expectedRevision: 1,
        payload: { matchId: game.id, phase: "playing" }
      }
    });
    expect(lease).toMatchObject({ matchId: game.id, ownerInstanceId: "private-app", fencingToken: 1 });
    await expect(runtime.loadMaterializedGame(game.id)).resolves.toMatchObject({
      matchId: game.id,
      matchType: "private",
      eventSequence: 1,
      privateRoomCode: roomCode,
      participants: expect.arrayContaining([
        expect.objectContaining({ playerId: ids.first }),
        expect.objectContaining({ playerId: ids.second })
      ])
    });
    await expect(runtime.getActiveMatchIdForPlayer(ids.first)).resolves.toBe(game.id);
    const room = await pool.query<{ status: string; match_id: string }>(
      "SELECT status, match_id FROM private_match_rooms WHERE room_code = $1",
      [roomCode]
    );
    expect(room.rows[0]).toEqual({ status: "active", match_id: game.id });
  });
});
