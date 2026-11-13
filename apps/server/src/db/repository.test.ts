import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { PostGameChatCipher } from "./chat-crypto";
import {
  calculateDeterministicElo,
  PostgresApplicationRepository,
  RepositoryConflictError
} from "./repository";

type Step = {
  contains: string;
  respond?: (values: readonly unknown[], sql: string) => QueryResult<QueryResultRow>;
};

function result<Row extends QueryResultRow>(rows: Row[] = [], rowCount = rows.length): QueryResult<Row> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

function scriptedRepository(steps: Step[]) {
  const remaining = [...steps];
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let releases = 0;
  const query = async <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<Row>> => {
    calls.push({ sql, values });
    const step = remaining.shift();
    if (!step) throw new Error(`Unexpected SQL: ${sql}`);
    expect(sql).toContain(step.contains);
    return (step.respond?.(values, sql) ?? result()) as QueryResult<Row>;
  };
  const client = { query, release: () => { releases += 1; } } as unknown as PoolClient;
  const pool = { query, connect: async () => client } as unknown as Pick<Pool, "query" | "connect">;
  const cipher = new PostGameChatCipher(Buffer.alloc(32, 4).toString("base64"), 1);
  return {
    repository: new PostgresApplicationRepository(pool, cipher),
    cipher,
    calls,
    assertDone: () => {
      expect(remaining).toEqual([]);
      expect(releases).toBeGreaterThanOrEqual(0);
    }
  };
}

const ids = {
  match: "00000000-0000-4000-8000-000000000001",
  user: "00000000-0000-4000-8000-000000000002",
  other: "00000000-0000-4000-8000-000000000003",
  event: "00000000-0000-4000-8000-000000000004",
  command: "00000000-0000-4000-8000-000000000005",
  message: "00000000-0000-4000-8000-000000000006",
  clientMessage: "00000000-0000-4000-8000-000000000007"
};

describe("PostgresApplicationRepository", () => {
  it("calculates deterministic zero-sum Elo changes", () => {
    const result = calculateDeterministicElo([
      { userId: ids.user, rating: 1000, outcome: "won" },
      { userId: ids.other, rating: 1000, outcome: "lost" }
    ]);
    expect(result).toEqual([
      { userId: ids.user, outcome: "won", scoreDelta: 16, ratingAfter: 1016 },
      { userId: ids.other, outcome: "lost", scoreDelta: -16, ratingAfter: 984 }
    ]);
    expect(result.reduce((sum, entry) => sum + entry.scoreDelta, 0)).toBe(0);
  });

  it("upserts identity/profile data in one parameterized transaction", async () => {
    const now = new Date("2026-08-23T10:00:00Z");
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "INSERT INTO app_users", respond: (values) => {
        expect(values).toEqual([ids.user, "asha@example.com", now]);
        return result([{ id: ids.user }]);
      } },
      { contains: "INSERT INTO player_profiles" },
      { contains: "INSERT INTO player_rankings" },
      { contains: "FROM app_users u", respond: () => result([{
        id: ids.user,
        email: "asha@example.com",
        display_name: "Asha",
        badge_id: "strategist",
        phone_country_code: null,
        phone_national_number: null,
        suspended_at: null,
        suspension_reason: null,
        created_at: now,
        updated_at: now
      }]) },
      { contains: "COMMIT" }
    ]);

    const profile = await scripted.repository.upsertUserProfile({
      id: ids.user,
      email: " Asha@Example.com ",
      displayName: "Asha",
      badgeId: "strategist",
      phone: null,
      now
    });
    expect(profile.email).toBe("asha@example.com");
    expect(scripted.calls.find(({ sql }) => sql.includes("INSERT INTO app_users"))?.sql).not.toContain("asha@example.com");
    scripted.assertDone();
  });

  it("searches admin users with literal case-insensitive text and reports the full result count", async () => {
    const firstCreatedAt = new Date("2026-08-23T10:00:00Z");
    const secondCreatedAt = new Date("2026-08-22T10:00:00Z");
    const profileRow = (id: string, createdAt: Date) => ({
      id,
      email: "asha_%@example.com",
      display_name: "Asha_%",
      badge_id: "strategist",
      phone_country_code: null,
      phone_national_number: null,
      suspended_at: null,
      suspension_reason: null,
      created_at: createdAt,
      updated_at: createdAt
    });
    const scripted = scriptedRepository([
      {
        contains: "SELECT count(*) AS total",
        respond: (values, sql) => {
          expect(values).toEqual(["%Asha\\_\\%%"]);
          expect(sql).toContain("u.email ILIKE $1");
          expect(sql).toContain("p.display_name ILIKE $1");
          expect(sql).toContain("u.email !~ '^tm-load-[a-f0-9]{32}-[0-9]{4}@example[.]test$'");
          return result([{ total: "2" }]);
        }
      },
      {
        contains: "SELECT u.id, u.email",
        respond: (values, sql) => {
          expect(values).toEqual(["%Asha\\_\\%%", firstCreatedAt, ids.user, 2]);
          expect(sql).toContain("(u.created_at, u.id) < ($2, $3)");
          expect(sql).toContain("u.email !~ '^tm-load-[a-f0-9]{32}-[0-9]{4}@example[.]test$'");
          return result([
            profileRow(ids.user, firstCreatedAt),
            profileRow(ids.other, secondCreatedAt)
          ]);
        }
      }
    ]);

    const page = await scripted.repository.listAdminUsers({
      query: " Asha_% ",
      cursor: { createdAt: firstCreatedAt, userId: ids.user },
      limit: 1
    });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual({ createdAt: firstCreatedAt, userId: ids.user });
    expect(page.total).toBe(2);
    scripted.assertDone();
  });

  it("keeps immutable load evidence out of normal admin game totals and history", async () => {
    const scripted = scriptedRepository([
      {
        contains: "FROM ranking_matches m",
        respond: (values, sql) => {
          expect(values).toEqual([26]);
          expect(sql).toContain("visible_user.email !~ '^tm-load-[a-f0-9]{32}-[0-9]{4}@example[.]test$'");
          return result([]);
        }
      },
      {
        contains: "AS active_matches",
        respond: (values, sql) => {
          expect(values).toEqual([]);
          expect(sql).toContain("email !~ '^tm-load-[a-f0-9]{32}-[0-9]{4}@example[.]test$'");
          return result([{
            users: "0",
            suspended_users: "0",
            active_matches: "0",
            active_general_matches: "0",
            active_private_matches: "0",
            waiting_private_rooms: "0",
            completed_matches: "0",
            chat_messages: "0"
          }]);
        }
      }
    ]);

    await expect(scripted.repository.listAdminGames()).resolves.toEqual({ items: [], nextCursor: null });
    await expect(scripted.repository.getAdminOverview()).resolves.toMatchObject({ users: 0, activeMatches: 0 });
    scripted.assertDone();
  });

  it("serializes and appends ordered immutable game events", async () => {
    const occurredAt = new Date("2026-08-23T10:01:00Z");
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "FOR UPDATE", respond: () => result([{ status: "active" }]) },
      { contains: "event_id = ANY", respond: () => result([]) },
      { contains: "MAX(sequence)", respond: () => result([{ last_sequence: "0" }]) },
      { contains: "INSERT INTO game_events", respond: (values) => result([{
        event_id: values[0],
        match_id: values[1],
        sequence: values[2],
        event_type: values[3],
        actor_user_id: values[4],
        command_id: values[5],
        payload: JSON.parse(String(values[6])),
        occurred_at: values[7]
      }]) },
      { contains: "COMMIT" }
    ]);
    const events = await scripted.repository.appendGameEvents({
      matchId: ids.match,
      expectedNextSequence: 1,
      events: [{
        eventId: ids.event,
        eventType: "game.started",
        actorUserId: ids.user,
        commandId: ids.command,
        payload: { playerCount: 2 },
        occurredAt
      }]
    });
    expect(events).toMatchObject([{ sequence: 1, eventType: "game.started", payload: { playerCount: 2 } }]);
    scripted.assertDone();
  });

  it("atomically claims a waiting private room, creates its match, and records the initial event", async () => {
    const startedAt = new Date("2026-08-24T08:30:00Z");
    const roomId = "00000000-0000-4000-8000-000000000008";
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "FOR UPDATE OF r", respond: () => result([{
        id: roomId,
        status: "waiting",
        match_id: null,
        player_count: 2,
        accepted_count: "1"
      }]) },
      { contains: "INSERT INTO ranking_matches", respond: () => result([{ id: ids.match }]) },
      { contains: "INSERT INTO match_participants" },
      { contains: "INSERT INTO match_participants" },
      { contains: "UPDATE private_match_rooms", respond: () => result([], 1) },
      { contains: "INSERT INTO game_events" },
      { contains: "FROM ranking_matches", respond: () => result([{
        id: ids.match,
        public_name: "amber-forest-12345678",
        player_count: 2,
        match_type: "private",
        status: "active",
        winner_user_id: null,
        end_reason: null,
        started_at: startedAt,
        ended_at: null
      }]) },
      { contains: "FROM match_participants", respond: () => result([
        { user_id: ids.user, seat_number: 0, display_name: "Asha", badge_id: "strategist", outcome: null, score_delta: null, rating_after: null },
        { user_id: ids.other, seat_number: 1, display_name: "Bela", badge_id: "rookie", outcome: null, score_delta: null, rating_after: null }
      ]) },
      { contains: "COMMIT" }
    ]);

    await scripted.repository.startPrivateMatch({
      roomCode: "amber-lotus-123456",
      id: ids.match,
      publicName: "amber-forest-12345678",
      playerCount: 2,
      startedAt,
      participants: [
        { userId: ids.user, seatNumber: 0, displayName: "Asha", badgeId: "strategist" },
        { userId: ids.other, seatNumber: 1, displayName: "Bela", badgeId: "rookie" }
      ],
      initialEvent: { eventId: ids.event, payload: { state: { revision: 1 } } }
    });

    const statements = scripted.calls.map(({ sql }) => sql);
    expect(statements.findIndex((sql) => sql.includes("UPDATE private_match_rooms")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("COMMIT")));
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO game_events")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("COMMIT")));
    scripted.assertDone();
  });

  it("rolls back a private start when cancellation already owns the room lifecycle", async () => {
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "FOR UPDATE OF r", respond: () => result([{
        id: "00000000-0000-4000-8000-000000000008",
        status: "cancelled",
        match_id: null,
        player_count: 2,
        accepted_count: "1"
      }]) },
      { contains: "ROLLBACK" }
    ]);

    await expect(scripted.repository.startPrivateMatch({
      roomCode: "amber-lotus-123456",
      id: ids.match,
      publicName: "amber-forest-12345678",
      playerCount: 2,
      startedAt: new Date("2026-08-24T08:30:00Z"),
      participants: [
        { userId: ids.user, seatNumber: 0, displayName: "Asha", badgeId: "strategist" },
        { userId: ids.other, seatNumber: 1, displayName: "Bela", badgeId: "rookie" }
      ],
      initialEvent: { eventId: ids.event, payload: { state: { revision: 1 } } }
    })).rejects.toBeInstanceOf(RepositoryConflictError);
    expect(scripted.calls.some(({ sql }) => sql.includes("INSERT INTO ranking_matches"))).toBe(false);
    scripted.assertDone();
  });

  it("encrypts chat fields and never sends plaintext to PostgreSQL", async () => {
    const createdAt = new Date("2026-08-23T10:02:00Z");
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "FOR UPDATE OF m, p", respond: () => result([{ status: "completed" }]) },
      { contains: "FROM post_game_chat_messages", respond: () => result([]) },
      { contains: "count(*)::int", respond: () => result([{ message_count: 2 }]) },
      { contains: "INSERT INTO post_game_chat_messages", respond: (values, sql) => {
        expect(sql).not.toMatch(/\bbody\b/);
        expect(values).not.toContain("Well played!");
        return result([{
          id: values[0],
          match_id: values[1],
          author_user_id: values[2],
          client_message_id: values[3],
          body_ciphertext: values[4],
          body_iv: values[5],
          body_auth_tag: values[6],
          body_key_version: values[7],
          created_at: values[8]
        }]);
      } },
      { contains: "COMMIT" }
    ]);
    const message = await scripted.repository.addPostGameChatMessage({
      id: ids.message,
      matchId: ids.match,
      authorUserId: ids.user,
      clientMessageId: ids.clientMessage,
      body: "Well played!",
      createdAt
    });
    expect(message.body).toBe("Well played!");
    scripted.assertDone();
  });

  it("enforces the three-message cap while holding participant/match locks", async () => {
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "FOR UPDATE OF m, p", respond: () => result([{ status: "completed" }]) },
      { contains: "FROM post_game_chat_messages", respond: () => result([]) },
      { contains: "count(*)::int", respond: () => result([{ message_count: 3 }]) },
      { contains: "ROLLBACK" }
    ]);
    await expect(scripted.repository.addPostGameChatMessage({
      id: ids.message,
      matchId: ids.match,
      authorUserId: ids.user,
      clientMessageId: ids.clientMessage,
      body: "Fourth message",
      createdAt: new Date()
    })).rejects.toBeInstanceOf(RepositoryConflictError);
    scripted.assertDone();
  });

  it("uses stable keyset pagination for the leaderboard", async () => {
    const scripted = scriptedRepository([
      { contains: "r.rating < $1", respond: (values, sql) => {
        expect(values).toEqual([1200, 10, ids.user, 3, "human"]);
        expect(sql).toContain("r.composition = $5");
        expect(sql).toContain("u.email !~ '^tm-load-[a-f0-9]{32}-[0-9]{4}@example[.]test$'");
        return result([
          { user_id: ids.user, display_name: "Asha", badge_id: "strategist", rating: 1190, games_played: 12, wins: 9, losses: 3, drops: 0 },
          { user_id: ids.other, display_name: "Dev", badge_id: "rookie", rating: 1180, games_played: 11, wins: 8, losses: 2, drops: 1 },
          { user_id: ids.match, display_name: "Lee", badge_id: "royal", rating: 1170, games_played: 10, wins: 7, losses: 3, drops: 0 }
        ]);
      } }
    ]);
    const page = await scripted.repository.listRankings({
      cursor: { rating: 1200, wins: 10, userId: ids.user },
      limit: 2
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual({ rating: 1180, wins: 8, userId: ids.other });
    scripted.assertDone();
  });

  it("filters mixed rankings at the database level and includes model identity", async () => {
    const scripted = scriptedRepository([
      { contains: "FROM player_rankings_by_composition", respond: (values, sql) => {
        expect(values).toEqual([26, "mixed"]);
        expect(sql).toContain("r.composition = $2");
        expect(sql).toContain("LEFT JOIN ai_agents");
        return result([{
          user_id: ids.other, display_name: "Model player", badge_id: "strategist",
          actor_kind: "ai", model_id: "provider/model-version",
          rating: 1016, games_played: 1, wins: 1, losses: 0, drops: 0
        }]);
      } }
    ]);
    const page = await scripted.repository.listRankings({ composition: "mixed" });
    expect(page.items[0]).toMatchObject({ actorKind: "ai", modelId: "provider/model-version" });
    scripted.assertDone();
  });

  it("rejects human sign-in upserts for an existing AI identity", async () => {
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "INSERT INTO app_users", respond: () => result([{ id: ids.other, actor_kind: "ai" }]) },
      { contains: "ROLLBACK" }
    ]);
    await expect(scripted.repository.upsertUserProfile({
      id: ids.user, email: "agent@example.test", displayName: "Impersonator", badgeId: "rookie", phone: null
    })).rejects.toThrow("AI player identities cannot be used for human sign-in.");
    scripted.assertDone();
  });

  it("records private outcomes with zero deltas without mutating public rankings", async () => {
    const endedAt = new Date("2026-08-24T09:00:00Z");
    const scripted = scriptedRepository([
      { contains: "BEGIN" },
      { contains: "SELECT match_type", respond: () => result([{ match_type: "private" }]) },
      { contains: "FROM player_rankings", respond: () => result([
        { user_id: ids.user, rating: 1_120 },
        { user_id: ids.other, rating: 980 }
      ]) },
      { contains: "participant_count", respond: () => result([{
        status: "active",
        winner_user_id: null,
        end_reason: null,
        participant_count: 2
      }]) },
      { contains: "UPDATE match_participants", respond: () => result([], 1) },
      { contains: "UPDATE match_participants", respond: () => result([], 1) },
      { contains: "UPDATE ranking_matches" },
      { contains: "FROM ranking_matches", respond: () => result([{
        id: ids.match,
        public_name: "amber-forest-12345678",
        player_count: 2,
        match_type: "private",
        status: "completed",
        winner_user_id: ids.user,
        end_reason: "declaration",
        started_at: new Date("2026-08-24T08:30:00Z"),
        ended_at: endedAt
      }]) },
      { contains: "FROM match_participants", respond: () => result([
        { user_id: ids.user, seat_number: 0, display_name: "Asha", badge_id: "strategist", outcome: "won", score_delta: 0, rating_after: 1_120 },
        { user_id: ids.other, seat_number: 1, display_name: "Bela", badge_id: "rookie", outcome: "lost", score_delta: 0, rating_after: 980 }
      ]) },
      { contains: "COMMIT" }
    ]);
    const completed = await scripted.repository.completePrivateMatch({
      matchId: ids.match,
      winnerUserId: ids.user,
      endReason: "declaration",
      endedAt,
      participantOutcomes: [
        { userId: ids.user, outcome: "won" },
        { userId: ids.other, outcome: "lost" }
      ]
    });
    expect(completed.participants.map(({ scoreDelta, ratingAfter }) => ({ scoreDelta, ratingAfter }))).toEqual([
      { scoreDelta: 0, ratingAfter: 1_120 },
      { scoreDelta: 0, ratingAfter: 980 }
    ]);
    expect(scripted.calls.some(({ sql }) => sql.includes("INSERT INTO player_rankings"))).toBe(false);
    scripted.assertDone();
  });
});
