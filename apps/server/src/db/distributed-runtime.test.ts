import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresDistributedGameRuntime } from "./distributed-runtime";

function result<Row extends QueryResultRow>(rows: Row[] = [], rowCount = rows.length): QueryResult<Row> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

type Step = Readonly<{
  contains: string;
  rows?: QueryResultRow[];
  rowCount?: number;
}>;

function scriptedRuntime(steps: readonly Step[]) {
  const pending = [...steps];
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = async <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<Row>> => {
    calls.push({ sql, values });
    const step = pending.shift();
    if (!step) throw new Error(`Unexpected query: ${sql}`);
    expect(sql).toContain(step.contains);
    return result(step.rows as Row[] ?? [], step.rowCount);
  };
  const client = {
    query,
    release() {}
  } as unknown as PoolClient;
  const pool = {
    query,
    connect: async () => client
  } as unknown as Pick<Pool, "query" | "connect">;
  return {
    runtime: new PostgresDistributedGameRuntime(pool),
    calls,
    assertDone: () => expect(pending).toEqual([])
  };
}

const ids = {
  match: "00000000-0000-4000-8000-000000000001",
  actor: "00000000-0000-4000-8000-000000000002",
  command: "00000000-0000-4000-8000-000000000003",
  event: "00000000-0000-4000-8000-000000000004"
} as const;

const now = new Date("2026-08-29T12:00:00.000Z");
const leaseExpiry = new Date("2026-08-29T12:00:30.000Z");
const ownershipRow = {
  match_id: ids.match,
  owner_instance_id: "app-a",
  fencing_token: "7",
  lease_expires_at: leaseExpiry,
  protocol_min: 1,
  protocol_max: 1,
  draining: false
};

describe("distributed game runtime repository", () => {
  it("discovers and materializes an active game entirely from PostgreSQL", async () => {
    const scripted = scriptedRuntime([
      { contains: "JOIN ranking_matches", rows: [{ match_id: ids.match }] },
      { contains: "BEGIN" },
      { contains: "JOIN LATERAL", rows: [{
        match_id: ids.match,
        public_name: "amber-lotus-12345678",
        player_count: 2,
        match_type: "general",
        status: "active",
        event_sequence: "3",
        event_type: "game.discard",
        event_payload: { state: { revision: 3 } },
        private_room_code: null
      }] },
      { contains: "FROM match_participants", rows: [
        { user_id: ids.actor, seat_number: 0, display_name: "Asha", badge_id: "rookie" },
        { user_id: "00000000-0000-4000-8000-000000000012", seat_number: 1, display_name: "Bela", badge_id: "strategist" }
      ] },
      { contains: "COMMIT" }
    ]);

    await expect(scripted.runtime.getActiveMatchIdForPlayer(ids.actor)).resolves.toBe(ids.match);
    await expect(scripted.runtime.loadMaterializedGame(ids.match)).resolves.toEqual({
      matchId: ids.match,
      publicName: "amber-lotus-12345678",
      playerCount: 2,
      matchType: "general",
      status: "active",
      eventSequence: 3,
      eventType: "game.discard",
      eventPayload: { state: { revision: 3 } },
      privateRoomCode: null,
      participants: [
        { playerId: ids.actor, seatNumber: 0, displayName: "Asha", badgeId: "rookie" },
        { playerId: "00000000-0000-4000-8000-000000000012", seatNumber: 1, displayName: "Bela", badgeId: "strategist" }
      ]
    });
    scripted.assertDone();
  });

  it("reads reconnect queue state and a live global queue count", async () => {
    const ticketId = "00000000-0000-4000-8000-000000000010";
    const scripted = scriptedRuntime([
      { contains: "FROM distributed_matchmaking_tickets", rows: [{
        ticket_id: ticketId,
        player_id: ids.actor,
        player_count: 6,
        region: "ap-south-1",
        protocol_version: 1,
        enqueued_at: now,
        heartbeat_at: now,
        expires_at: leaseExpiry
      }] },
      { contains: "count(*) AS waiting", rows: [{ waiting: "17" }] }
    ]);

    await expect(scripted.runtime.getWaitingMatchmakingTicket(ids.actor, now)).resolves.toMatchObject({
      ticketId,
      playerId: ids.actor,
      playerCount: 6
    });
    await expect(scripted.runtime.countWaitingMatchmakingTickets({
      playerCount: 6,
      region: "ap-south-1",
      protocolVersion: 1,
      now
    })).resolves.toBe(17);
    scripted.assertDone();
  });

  it("heartbeats waiting matchmaking tickets in one bounded query", async () => {
    const firstTicket = "00000000-0000-4000-8000-000000000010";
    const secondTicket = "00000000-0000-4000-8000-000000000011";
    const secondPlayer = "00000000-0000-4000-8000-000000000012";
    const scripted = scriptedRuntime([{
      contains: "FROM unnest($1::uuid[], $2::uuid[])",
      rows: [{
        ticket_id: firstTicket,
        player_id: ids.actor,
        player_count: 2,
        region: "ap-south-1",
        protocol_version: 1,
        enqueued_at: now,
        heartbeat_at: now,
        expires_at: leaseExpiry
      }]
    }]);

    await expect(scripted.runtime.heartbeatMatchmakingTickets({
      tickets: [
        { ticketId: firstTicket, playerId: ids.actor },
        { ticketId: secondTicket, playerId: secondPlayer }
      ],
      ttlMs: 30_000,
      now
    })).resolves.toEqual([expect.objectContaining({ ticketId: firstTicket, playerId: ids.actor })]);
    expect(scripted.calls[0]?.values).toEqual([
      [firstTicket, secondTicket],
      [ids.actor, secondPlayer],
      30_000,
      now
    ]);
    scripted.assertDone();
  });

  it("claims a version-compatible ownership lease and exposes its fencing token", async () => {
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "INSERT INTO game_runtime_owners", rows: [ownershipRow] },
      { contains: "UPDATE recoverable_game_deadlines" },
      { contains: "DELETE FROM recoverable_game_deadlines" },
      { contains: "COMMIT" }
    ]);

    await expect(scripted.runtime.claimOwnership({
      matchId: ids.match,
      ownerInstanceId: "app-a",
      protocolVersion: 1,
      leaseDurationMs: 30_000,
      now
    })).resolves.toEqual({
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: 7,
      leaseExpiresAt: leaseExpiry,
      protocolMin: 1,
      protocolMax: 1,
      draining: false
    });
    const claimSql = scripted.calls.find(({ sql }) => sql.includes("INSERT INTO game_runtime_owners"))!.sql;
    expect(claimSql).toContain("fencing_token + 1");
    expect(claimSql).toContain("BETWEEN game_runtime_owners.protocol_min");
    scripted.assertDone();
  });

  it("observes a higher fence when an expired owner is taken over", async () => {
    const takeoverExpiry = new Date("2026-08-29T12:01:00.000Z");
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "INSERT INTO game_runtime_owners", rows: [{
        ...ownershipRow,
        owner_instance_id: "app-b",
        fencing_token: "8",
        lease_expires_at: takeoverExpiry
      }] },
      { contains: "UPDATE recoverable_game_deadlines" },
      { contains: "DELETE FROM recoverable_game_deadlines" },
      { contains: "COMMIT" }
    ]);

    await expect(scripted.runtime.claimOwnership({
      matchId: ids.match,
      ownerInstanceId: "app-b",
      protocolVersion: 1,
      leaseDurationMs: 30_000,
      now: new Date("2026-08-29T12:00:30.000Z")
    })).resolves.toMatchObject({ ownerInstanceId: "app-b", fencingToken: 8 });
    expect(scripted.calls.find(({ sql }) => sql.includes("INSERT INTO game_runtime_owners"))!.sql)
      .toContain("game_runtime_owners.fencing_token + 1");
    scripted.assertDone();
  });

  it("uses the fifth bind parameter as the batch-renewal clock and the fourth as duration", async () => {
    const scripted = scriptedRuntime([
      { contains: "UPDATE game_runtime_owners", rows: [ownershipRow] }
    ]);
    await expect(scripted.runtime.renewOwnershipBatch({
      ownerInstanceId: "app-a",
      leases: [{ matchId: ids.match, fencingToken: 7 }],
      leaseDurationMs: 30_000,
      now
    })).resolves.toHaveLength(1);
    const { sql, values } = scripted.calls[0]!;
    expect(sql).toContain("COALESCE($5::timestamptz, clock_timestamp())");
    expect(sql).toContain("$4::bigint * interval '1 millisecond'");
    expect(values[3]).toBe(30_000);
    expect(values[4]).toBe(now);
    scripted.assertDone();
  });

  it("atomically commits command, event, outbox, and replacement deadline behind the fence", async () => {
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "FROM durable_game_commands", rows: [] },
      { contains: "FROM game_runtime_owners", rows: [ownershipRow] },
      { contains: "FROM durable_game_commands", rows: [] },
      { contains: "FROM ranking_matches", rows: [{ status: "active" }] },
      { contains: "MAX(sequence)", rows: [{ last_sequence: "1" }] },
      { contains: "INSERT INTO game_events" },
      { contains: "INSERT INTO durable_game_commands" },
      { contains: "INSERT INTO game_event_outbox" },
      { contains: "DELETE FROM recoverable_game_deadlines" },
      { contains: "INSERT INTO recoverable_game_deadlines" },
      { contains: "COMMIT" }
    ]);

    await expect(scripted.runtime.commitTransition({
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: 7,
      expectedNextSequence: 2,
      event: {
        eventId: ids.event,
        eventType: "game.draw-stock",
        actorUserId: ids.actor,
        commandId: ids.command,
        payload: { state: { revision: 2 } },
        occurredAt: now
      },
      command: {
        actorUserId: ids.actor,
        commandType: "game.draw-stock",
        expectedRevision: 1,
        payload: { expectedRevision: 1 },
        result: { accepted: true, revision: 2 }
      },
      nextDeadline: {
        type: "turn",
        dueAt: leaseExpiry,
        expectedRevision: 2,
        payload: { gameId: ids.match }
      }
    }, now)).resolves.toEqual({
      disposition: "committed",
      eventSequence: 2,
      result: { accepted: true, revision: 2 }
    });

    const statements = scripted.calls.map(({ sql }) => sql);
    expect(statements.indexOf("COMMIT")).toBeGreaterThan(statements.findIndex((sql) => sql.includes("INSERT INTO game_events")));
    expect(statements.indexOf("COMMIT")).toBeGreaterThan(statements.findIndex((sql) => sql.includes("INSERT INTO game_event_outbox")));
    scripted.assertDone();
  });

  it("commits the terminal event, outcomes, ratings, and match completion in the same transaction", async () => {
    const actorB = "00000000-0000-4000-8000-000000000012";
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "FROM durable_game_commands", rows: [] },
      { contains: "FROM game_runtime_owners", rows: [ownershipRow] },
      { contains: "FROM durable_game_commands", rows: [] },
      { contains: "FROM ranking_matches", rows: [{ status: "active", match_type: "general", participant_count: 2 }] },
      { contains: "MAX(sequence)", rows: [{ last_sequence: "2" }] },
      { contains: "INSERT INTO game_events" },
      { contains: "INSERT INTO durable_game_commands" },
      { contains: "INSERT INTO game_event_outbox" },
      { contains: "DELETE FROM recoverable_game_deadlines" },
      { contains: "SELECT user_id FROM match_participants", rows: [{ user_id: ids.actor }, { user_id: actorB }] },
      { contains: "SELECT user_id, rating FROM player_rankings", rows: [
        { user_id: ids.actor, rating: 1000 },
        { user_id: actorB, rating: 1000 }
      ] },
      { contains: "UPDATE match_participants", rowCount: 1 },
      { contains: "UPDATE player_rankings", rowCount: 1 },
      { contains: "UPDATE match_participants", rowCount: 1 },
      { contains: "UPDATE player_rankings", rowCount: 1 },
      { contains: "UPDATE ranking_matches", rowCount: 1 },
      { contains: "COMMIT" }
    ]);

    await expect(scripted.runtime.commitTransition({
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: 7,
      expectedNextSequence: 3,
      event: {
        eventId: ids.event,
        eventType: "game.drop",
        actorUserId: ids.actor,
        commandId: ids.command,
        payload: { state: { revision: 3, phase: "finished" } },
        occurredAt: now
      },
      command: {
        actorUserId: ids.actor,
        commandType: "game.drop",
        expectedRevision: 2,
        payload: { expectedRevision: 2 },
        result: { accepted: true, revision: 3 }
      },
      nextDeadline: null,
      completion: {
        matchType: "general",
        winnerUserId: actorB,
        endReason: "player-dropped",
        endedAt: now,
        participantOutcomes: [
          { userId: ids.actor, outcome: "dropped" },
          { userId: actorB, outcome: "won" }
        ]
      }
    }, now)).resolves.toMatchObject({ disposition: "committed", eventSequence: 3 });

    const commit = scripted.calls.findIndex(({ sql }) => sql === "COMMIT");
    expect(scripted.calls.findIndex(({ sql }) => sql.includes("UPDATE ranking_matches"))).toBeLessThan(commit);
    expect(scripted.calls.findIndex(({ sql }) => sql.includes("INSERT INTO game_event_outbox"))).toBeLessThan(commit);
    scripted.assertDone();
  });

  it("returns the previously committed result for an exact idempotent retry", async () => {
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "FROM durable_game_commands", rows: [{
        actor_user_id: ids.actor,
        expected_revision: "1",
        command_type: "game.draw-stock",
        command_payload: { expectedRevision: 1 },
        result_payload: { accepted: true, revision: 2 },
        event_sequence: "2"
      }] },
      { contains: "COMMIT" }
    ]);

    const transition = {
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: 7,
      expectedNextSequence: 2,
      event: {
        eventId: ids.event,
        eventType: "game.draw-stock",
        actorUserId: ids.actor,
        commandId: ids.command,
        payload: { state: { revision: 2 } },
        occurredAt: now
      },
      command: {
        actorUserId: ids.actor,
        commandType: "game.draw-stock",
        expectedRevision: 1,
        payload: { expectedRevision: 1 },
        result: { ignored: "the stored result is authoritative" }
      },
      nextDeadline: null
    } as const;

    await expect(scripted.runtime.commitTransition(transition, now)).resolves.toEqual({
      disposition: "replayed",
      eventSequence: 2,
      result: { accepted: true, revision: 2 }
    });
    expect(scripted.calls.some(({ sql }) => sql.includes("INSERT INTO game_events"))).toBe(false);
    expect(scripted.calls.some(({ sql }) => sql.includes("FROM game_runtime_owners"))).toBe(false);
    scripted.assertDone();
  });

  it("rejects a stale owner before writing any game state", async () => {
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "FROM game_runtime_owners", rows: [] },
      { contains: "ROLLBACK" }
    ]);

    await expect(scripted.runtime.commitTransition({
      matchId: ids.match,
      ownerInstanceId: "app-a",
      fencingToken: 7,
      expectedNextSequence: 2,
      event: {
        eventId: ids.event,
        eventType: "game.turn-timed-out",
        actorUserId: null,
        commandId: null,
        payload: { state: { revision: 2 } },
        occurredAt: now
      },
      command: null,
      nextDeadline: null
    }, now)).rejects.toThrow("fencing token");
    expect(scripted.calls.some(({ sql }) => sql.includes("INSERT INTO game_events"))).toBe(false);
    scripted.assertDone();
  });

  it("uses skip-locked leases for independent outbox, timer, and matchmaking workers", async () => {
    const scripted = scriptedRuntime([
      { contains: "FROM game_event_outbox", rows: [] },
      { contains: "FROM recoverable_game_deadlines", rows: [] },
      { contains: "BEGIN" },
      { contains: "UPDATE distributed_matchmaking_tickets" },
      { contains: "FROM distributed_matchmaking_tickets", rows: [] },
      { contains: "COMMIT" }
    ]);

    await scripted.runtime.claimOutbox({ workerId: "publisher-a", leaseDurationMs: 10_000, now });
    await scripted.runtime.claimDueDeadlines({ workerId: "timer-a", leaseDurationMs: 10_000, now });
    await scripted.runtime.claimMatchmakingGroup({
      coordinatorId: "matcher-a",
      playerCount: 6,
      region: "ap-south-1",
      protocolVersion: 1,
      leaseDurationMs: 10_000,
      now
    });

    const workerQueries = scripted.calls.filter(({ sql }) => sql.includes("SKIP LOCKED"));
    expect(workerQueries).toHaveLength(3);
    const outboxQuery = workerQueries.find(({ sql }) => sql.includes("FROM game_event_outbox"))!;
    expect(outboxQuery.sql).toContain("predecessor.match_id = pending.match_id");
    expect(outboxQuery.sql).toContain("predecessor.published_at IS NULL");
    expect(outboxQuery.sql).toContain("predecessor.event_sequence < pending.event_sequence");
    scripted.assertDone();
  });

  it("acknowledges an owned outbox batch in one statement and rejects partial ownership without partial updates", async () => {
    const secondOutbox = "00000000-0000-4000-8000-000000000014";
    const outboxIds = [ids.event, secondOutbox] as const;
    const scripted = scriptedRuntime([
      { contains: "WITH requested AS MATERIALIZED", rows: [{ updated_count: "2" }] },
      { contains: "WITH requested AS MATERIALIZED", rows: [{ updated_count: "0" }] }
    ]);

    await expect(scripted.runtime.markOutboxPublishedBatch({
      outboxIds,
      workerId: "publisher-a",
      publishedAt: now
    })).resolves.toBeUndefined();
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.sql).toContain("FOR UPDATE OF o");
    expect(scripted.calls[0]?.sql).toContain("v.all_claims_owned");
    expect(scripted.calls[0]?.values).toEqual([outboxIds, "publisher-a", now]);

    await expect(scripted.runtime.markOutboxPublishedBatch({
      outboxIds,
      workerId: "publisher-b",
      publishedAt: now
    })).rejects.toThrow("outbox claims were lost");
    expect(scripted.calls).toHaveLength(2);
    scripted.assertDone();
  });

  it("starts a claimed general game with its match, owner, event, outbox, timer, and tickets in one transaction", async () => {
    const ticketA = "00000000-0000-4000-8000-000000000010";
    const ticketB = "00000000-0000-4000-8000-000000000011";
    const actorB = "00000000-0000-4000-8000-000000000012";
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "FROM distributed_matchmaking_tickets", rows: [
        {
          ticket_id: ticketA,
          player_id: ids.actor,
          player_count: 2,
          region: "ap-south-1",
          protocol_version: 1,
          enqueued_at: now,
          claimed_by: "matcher-a",
          claimed_until: leaseExpiry
        },
        {
          ticket_id: ticketB,
          player_id: actorB,
          player_count: 2,
          region: "ap-south-1",
          protocol_version: 1,
          enqueued_at: now,
          claimed_by: "matcher-a",
          claimed_until: leaseExpiry
        }
      ] },
      { contains: "INSERT INTO ranking_matches" },
      { contains: "INSERT INTO match_participants" },
      { contains: "INSERT INTO match_participants" },
      { contains: "INSERT INTO game_events" },
      { contains: "INSERT INTO game_runtime_owners", rows: [{ ...ownershipRow, fencing_token: "1" }] },
      { contains: "INSERT INTO game_event_outbox" },
      { contains: "INSERT INTO recoverable_game_deadlines" },
      { contains: "UPDATE distributed_matchmaking_tickets", rowCount: 2 },
      { contains: "COMMIT" }
    ]);

    await scripted.runtime.startClaimedGeneralGame({
      coordinatorId: "matcher-a",
      ticketIds: [ticketA, ticketB],
      matchId: ids.match,
      publicName: "amber-lotus-12345678",
      playerCount: 2,
      ownerInstanceId: "app-a",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      startedAt: now,
      participants: [
        { userId: ids.actor, seatNumber: 0, displayName: "Asha", badgeId: "rookie" },
        { userId: actorB, seatNumber: 1, displayName: "Bela", badgeId: "strategist" }
      ],
      initialEvent: { eventId: ids.event, payload: { state: { revision: 1 } } },
      firstDeadline: {
        type: "turn",
        dueAt: leaseExpiry,
        expectedRevision: 1,
        payload: { matchId: ids.match }
      }
    });

    const statements = scripted.calls.map(({ sql }) => sql);
    const commit = statements.indexOf("COMMIT");
    for (const required of [
      "INSERT INTO ranking_matches",
      "INSERT INTO game_runtime_owners",
      "INSERT INTO game_events",
      "INSERT INTO game_event_outbox",
      "INSERT INTO recoverable_game_deadlines",
      "UPDATE distributed_matchmaking_tickets"
    ]) {
      expect(statements.findIndex((sql) => sql.includes(required))).toBeLessThan(commit);
    }
    scripted.assertDone();
  });

  it("starts a ready private room with activation and runtime durability in one transaction", async () => {
    const actorB = "00000000-0000-4000-8000-000000000012";
    const scripted = scriptedRuntime([
      { contains: "BEGIN" },
      { contains: "FROM private_match_rooms", rows: [{
        id: "00000000-0000-4000-8000-000000000020",
        status: "waiting",
        match_id: null,
        player_count: 2,
        creator_user_id: ids.actor,
        accepted_player_ids: [actorB]
      }] },
      { contains: "INSERT INTO ranking_matches" },
      { contains: "INSERT INTO match_participants" },
      { contains: "INSERT INTO match_participants" },
      { contains: "INSERT INTO game_events" },
      { contains: "INSERT INTO game_runtime_owners", rows: [{ ...ownershipRow, fencing_token: "1" }] },
      { contains: "INSERT INTO game_event_outbox" },
      { contains: "INSERT INTO recoverable_game_deadlines" },
      { contains: "UPDATE private_match_rooms", rowCount: 1 },
      { contains: "COMMIT" }
    ]);

    await expect(scripted.runtime.startReadyPrivateGame({
      roomCode: "amber-lotus-123456",
      matchId: ids.match,
      publicName: "amber-lotus-12345678",
      playerCount: 2,
      ownerInstanceId: "app-a",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      startedAt: now,
      participants: [
        { userId: ids.actor, seatNumber: 0, displayName: "Asha", badgeId: "rookie" },
        { userId: actorB, seatNumber: 1, displayName: "Bela", badgeId: "strategist" }
      ],
      initialEvent: { eventId: ids.event, payload: { state: { revision: 1 }, matchType: "private" } },
      firstDeadline: {
        type: "turn",
        dueAt: leaseExpiry,
        expectedRevision: 1,
        payload: { matchId: ids.match }
      }
    })).resolves.toMatchObject({ matchId: ids.match, ownerInstanceId: "app-a", fencingToken: 1 });

    const statements = scripted.calls.map(({ sql }) => sql);
    const commit = statements.indexOf("COMMIT");
    expect(statements.findIndex((sql) => sql.includes("UPDATE private_match_rooms"))).toBeLessThan(commit);
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO game_event_outbox"))).toBeLessThan(commit);
    scripted.assertDone();
  });
});
