import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  RepositoryConflictError,
  type ApplicationRepository,
  type MatchRecord,
  type PrivateRoomRecord
} from "./db/repository";
import {
  registerDurableDataRoutes,
  type DurableRoutesOptions,
  type DurableRouteSession
} from "./durable-routes";

const playerId = "11111111-1111-4111-8111-111111111111";
const opponentId = "22222222-2222-4222-8222-222222222222";
const adminId = "33333333-3333-4333-8333-333333333333";
const matchId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const messageId = "66666666-6666-4666-8666-666666666666";
const clientMessageId = "77777777-7777-4777-8777-777777777777";
const auditId = "88888888-8888-4888-8888-888888888888";
const gameName = "amber-forest-12345678";
const startedAt = new Date("2026-08-23T06:00:00.000Z");
const endedAt = new Date("2026-08-23T06:20:00.000Z");

function archivedCard(id: string, suit: "clubs" | "diamonds" | "hearts" | "spades" | null, rank: number | null, printedJoker = false) {
  return { id, deck: 1, suit, rank, printedJoker };
}

const match: MatchRecord = {
  id: matchId,
  publicName: gameName,
  playerCount: 2,
  status: "completed",
  winnerUserId: playerId,
  endReason: "declaration",
  startedAt,
  endedAt,
  participants: [
    {
      userId: playerId,
      seatNumber: 0,
      displayName: "Asha",
      badgeId: "strategist",
      outcome: "won",
      scoreDelta: 18,
      ratingAfter: 1_018
    },
    {
      userId: opponentId,
      seatNumber: 1,
      displayName: "Bela",
      badgeId: "rookie",
      outcome: "lost",
      scoreDelta: -18,
      ratingAfter: 982
    }
  ]
};

function repository(overrides: Partial<ApplicationRepository> = {}): ApplicationRepository {
  const notUsed = async (): Promise<never> => { throw new Error("Unexpected repository call"); };
  return {
    upsertUserProfile: notUsed,
    getUserProfile: notUsed,
    createMatch: notUsed,
    startPrivateMatch: notUsed,
    createPrivateRoom: notUsed,
    getPrivateRoomByCode: notUsed,
    listPrivateRoomsForUser: notUsed,
    listWaitingPrivateRooms: vi.fn(async () => []),
    listPrivateRoomsByMatchIds: vi.fn(async () => []),
    acceptPrivateRoomInvitation: notUsed,
    cancelPrivateRoom: notUsed,
    activatePrivateRoom: notUsed,
    completePrivateRoom: notUsed,
    getMatch: notUsed,
    getMatchByPublicName: vi.fn(async () => match),
    appendGameEvents: notUsed,
    listGameEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
    completeMatch: notUsed,
    completeMatchAndUpdateRatings: notUsed,
    completePrivateMatch: notUsed,
    getRankingsForUsers: vi.fn(async () => []),
    listRankings: vi.fn(async () => ({ items: [], nextCursor: null })),
    listUserMatches: vi.fn(async () => ({ items: [], nextCursor: null })),
    addPostGameChatMessage: notUsed,
    listPostGameChat: vi.fn(async () => ({ items: [], nextCursor: null })),
    listAdminUsers: vi.fn(async () => ({ items: [], nextCursor: null, total: 0 })),
    listAdminGames: vi.fn(async () => ({ items: [], nextCursor: null })),
    getAdminOverview: vi.fn(async () => ({
      users: 0,
      suspendedUsers: 0,
      activeMatches: 0,
      completedMatches: 0,
      chatMessages: 0
    })),
    getAdminGameByPublicName: vi.fn(async () => match),
    setUserSuspended: notUsed,
    appendAdminAudit: notUsed,
    listAdminAuditLog: notUsed,
    ...overrides
  };
}

function sessionResolver(request: FastifyRequest): Promise<DurableRouteSession | null> {
  const identity = request.headers["x-test-user"];
  if (identity === "player") {
    return Promise.resolve({ playerId, profile: { email: "player@example.com", displayName: "Asha" } });
  }
  if (identity === "opponent") {
    return Promise.resolve({ playerId: opponentId, profile: { email: "opponent@example.com", displayName: "Bela" } });
  }
  if (identity === "outsider") {
    return Promise.resolve({
      playerId: "99999999-9999-4999-8999-999999999999",
      profile: { email: "outsider@example.com", displayName: "Cora" }
    });
  }
  if (identity === "admin") {
    return Promise.resolve({ playerId: adminId, profile: { email: "OWNER@EXAMPLE.COM", displayName: "Owner" } });
  }
  return Promise.resolve(null);
}

async function buildApp(repo: ApplicationRepository, overrides: Readonly<{
  publishPostGameChatMessage?: NonNullable<DurableRoutesOptions["publishPostGameChatMessage"]>;
}> = {}) {
  const app = Fastify({ logger: false });
  await registerDurableDataRoutes(app, {
    repository: repo,
    resolveSession: sessionResolver,
    adminEmails: ["owner@example.com"],
    createId: () => auditId,
    now: () => endedAt,
    ...overrides
  });
  return app;
}

describe("durable data HTTP routes", () => {
  it("returns the canonical anonymous leaderboard and an opaque keyset cursor", async () => {
    const listRankings = vi.fn(async () => ({
      items: [{
        userId: playerId,
        displayName: "Asha",
        badgeId: "strategist" as const,
        rating: 1_018,
        gamesPlayed: 1,
        wins: 1,
        losses: 0,
        drops: 0
      }],
      nextCursor: { rating: 1_018, wins: 1, userId: playerId }
    }));
    const app = await buildApp(repository({ listRankings }));

    const response = await app.inject({ method: "GET", url: "/api/rankings?limit=1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rankings: [{
      rank: 1,
      playerId,
      displayName: "Asha",
      badgeId: "strategist",
      rating: 1_018,
      wins: 1,
      gamesPlayed: 1,
      actorKind: "human"
    }] });
    expect(response.headers["x-next-cursor"]).toEqual(expect.any(String));
    expect(response.body).not.toContain("email");
    await app.close();
  });

  it("isolates ranking cursors by match composition and exposes AI identities", async () => {
    const listRankings = vi.fn(async () => ({
      items: [{
        userId: opponentId, displayName: "Model Player", badgeId: "strategist" as const,
        rating: 1016, gamesPlayed: 1, wins: 1, losses: 0, drops: 0,
        actorKind: "ai" as const, modelId: "provider/model-version"
      }],
      nextCursor: { rating: 1016, wins: 1, userId: opponentId }
    }));
    const app = await buildApp(repository({ listRankings }));
    const response = await app.inject({ method: "GET", url: "/api/rankings?composition=mixed&limit=1" });
    expect(response.statusCode).toBe(200);
    expect(listRankings).toHaveBeenCalledWith({ composition: "mixed", limit: 1 });
    expect(response.json().rankings[0]).toMatchObject({ actorKind: "ai", modelId: "provider/model-version" });
    const cursor = response.headers["x-next-cursor"];
    const mismatched = await app.inject({ method: "GET", url: `/api/rankings?composition=ai&cursor=${cursor}` });
    expect(mismatched.statusCode).toBe(400);
    expect(listRankings).toHaveBeenCalledTimes(1);
    const nextPage = await app.inject({ method: "GET", url: `/api/rankings?composition=mixed&cursor=${cursor}` });
    expect(nextPage.statusCode).toBe(200);
    expect(nextPage.json().rankings[0].rank).toBe(2);
    await app.close();
  });

  it("rejects malformed and non-canonical pagination parameters", async () => {
    const app = await buildApp(repository());
    const unknown = await app.inject({ method: "GET", url: "/api/rankings?offset=10" });
    const malformed = await app.inject({ method: "GET", url: "/api/rankings?cursor=not-base64-json" });
    expect(unknown.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    await app.close();
  });

  it("requires a session for history and returns only the player's public match view", async () => {
    const repo = repository({
      listUserMatches: vi.fn(async () => ({ items: [match], nextCursor: null }))
    });
    const app = await buildApp(repo);
    const anonymous = await app.inject({ method: "GET", url: "/api/me/history" });
    const response = await app.inject({
      method: "GET",
      url: "/api/me/history",
      headers: { "x-test-user": "player" }
    });

    expect(anonymous.statusCode).toBe(401);
    expect(response.json()).toEqual({ games: [{
      gameName,
      finishedAt: endedAt.toISOString(),
      playerCount: 2,
      matchType: "general",
      result: "won",
      winnerName: "Asha",
      reason: "declaration",
      score: 18
    }] });
    expect(response.body).not.toMatch(/email|phone/i);
    await app.close();
  });

  it("authorizes replay access, drains every event page, and redacts private payload fields", async () => {
    const listGameEvents = vi.fn(async (input: { cursor?: { sequence: number } }) => input.cursor
      ? {
          items: [{
            eventId,
            matchId,
            sequence: 2,
            eventType: "game.ended",
            actorUserId: playerId,
            commandId: null,
            payload: { winner: "Asha" },
            occurredAt: endedAt
          }],
          nextCursor: null
        }
      : {
          items: [{
            eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            matchId,
            sequence: 1,
            eventType: "game.started",
            actorUserId: null,
            commandId: null,
            payload: {
              state: { stockCount: 27 },
              email: "private@example.com",
              nested: { phone: "+919999999999", safe: "visible" }
            },
            occurredAt: startedAt
          }],
          nextCursor: { sequence: 1 }
        });
    const app = await buildApp(repository({ listGameEvents } as Partial<ApplicationRepository>));

    const outsider = await app.inject({
      method: "GET",
      url: `/api/games/${gameName}/replay`,
      headers: { "x-test-user": "outsider" }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/games/${gameName}/replay`,
      headers: { "x-test-user": "player" }
    });

    expect(outsider.statusCode).toBe(404);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ gameName, events: [{ sequence: 1 }, { sequence: 2 }] });
    expect(response.body).not.toContain("private@example.com");
    expect(response.body).not.toContain("+919999999999");
    expect(response.body).toContain("visible");
    expect(listGameEvents).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("shows the archived AI technical forfeit cause in the replay summary", async () => {
    const message = "The selected model was unavailable for several turns.";
    const listGameEvents = vi.fn(async () => ({ items: [{
      eventId,
      matchId,
      sequence: 1,
      eventType: "game.drop",
      actorUserId: opponentId,
      commandId: null,
      payload: { aiFailure: { code: "AI_UNAVAILABLE", message } },
      occurredAt: endedAt
    }], nextCursor: null }));
    const app = await buildApp(repository({ listGameEvents }));
    const response = await app.inject({ method: "GET", url: `/api/games/${gameName}/replay`, headers: { "x-test-user": "player" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().events[0].summary).toBe(`Bela forfeited. ${message}`);
    await app.close();
  });

  it("preserves ordinary drop summaries and ignores malformed or unrelated AI failure payloads", async () => {
    const payloads = [
      {},
      { aiFailure: "not a structured notice" },
      { aiFailure: { code: "UNTRUSTED_CODE", message: "Untrusted cause" } },
      { aiFailure: { code: "AI_UNAVAILABLE", message: "x".repeat(301) } },
      { aiFailure: { code: "AI_UNAVAILABLE", message: "Untrusted cause", extra: "not allowed" } }
    ];
    const items = payloads.map((payload, index) => ({ eventId, matchId, sequence: index + 1, eventType: "game.drop", actorUserId: opponentId, commandId: null, payload, occurredAt: endedAt }));
    items.push({ eventId, matchId, sequence: items.length + 1, eventType: "game.draw", actorUserId: opponentId, commandId: null,
      payload: { aiFailure: { code: "AI_UNAVAILABLE", message: "An unrelated cause" } }, occurredAt: endedAt });
    const app = await buildApp(repository({ listGameEvents: vi.fn(async () => ({ items, nextCursor: null })) }));
    const response = await app.inject({ method: "GET", url: `/api/games/${gameName}/replay`, headers: { "x-test-user": "player" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().events.map((event: { summary: string }) => event.summary)).toEqual([
      ...payloads.map(() => "Bela: game drop"), "Bela: game draw"
    ]);
    await app.close();
  });

  it("reconstructs legacy melds, preserves recorded declaration groups, and identifies the winner", async () => {
    const abhiMatch: MatchRecord = {
      ...match,
      winnerUserId: opponentId,
      participants: [
        { ...match.participants[0]!, outcome: "lost", displayName: "Saurabh" },
        { ...match.participants[1]!, outcome: "won", displayName: "abhi" }
      ]
    };
    const abhiHand = [
      archivedCard("s5", "spades", 5), archivedCard("s3", "spades", 3), archivedCard("h5", "hearts", 5),
      archivedCard("ca", "clubs", 1), archivedCard("joker", null, null, true), archivedCard("h7", "hearts", 7),
      archivedCard("s4", "spades", 4), archivedCard("c4", "clubs", 4), archivedCard("c8", "clubs", 8),
      archivedCard("c6", "clubs", 6), archivedCard("ha", "hearts", 1), archivedCard("h6", "hearts", 6),
      archivedCard("s2", "spades", 2)
    ];
    const state = {
      phase: "showdown",
      seats: [
        { id: playerId, displayName: "Saurabh", status: "playing" },
        { id: opponentId, displayName: "abhi", status: "declared" }
      ],
      hands: [
        { playerId, cards: [archivedCard("d2", "diamonds", 2)] },
        { playerId: opponentId, cards: abhiHand }
      ],
      stock: [],
      discard: [],
      currentPlayerIndex: 0,
      wildRank: 9,
      showdown: { declarerId: opponentId, pendingPlayerIds: [playerId], submissions: [] }
    };
    const exactGroups = [
      ["ca", "s5", "h5"],
      ["s2", "s3", "s4"],
      ["h6", "h7", "ha", "joker"],
      ["c4", "c6", "c8"]
    ];
    const listGameEvents = vi.fn(async () => ({
      items: [
        {
          eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          matchId,
          sequence: 1,
          eventType: "game.started",
          actorUserId: null,
          commandId: null,
          payload: { state },
          occurredAt: startedAt
        },
        {
          eventId,
          matchId,
          sequence: 2,
          eventType: "game.declare",
          actorUserId: opponentId,
          commandId: clientMessageId,
          payload: { command: { type: "game.declare", melds: exactGroups }, state },
          occurredAt: endedAt
        }
      ],
      nextCursor: null
    }));
    const app = await buildApp(repository({
      getMatchByPublicName: vi.fn(async () => abhiMatch),
      listGameEvents
    }));

    const response = await app.inject({
      method: "GET",
      url: `/api/games/${gameName}/replay`,
      headers: { "x-test-user": "player" }
    });
    const body = response.json();
    const initialAbhi = body.events[0].state.players.find((player: { displayName: string }) => player.displayName === "abhi");
    const declaredAbhi = body.events[1].state.players.find((player: { displayName: string }) => player.displayName === "abhi");

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({ winnerName: "abhi", reason: "declaration" });
    expect(initialAbhi).toMatchObject({ isWinner: true, layoutSource: "suggested" });
    expect(initialAbhi.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "trinity"
      })
    ]));
    expect(declaredAbhi).toMatchObject({ layoutSource: "recorded" });
    expect(declaredAbhi.groups[0]).toMatchObject({
      label: "Trinity · 21",
      total: 21,
      cards: [
        expect.objectContaining({ id: "ca" }),
        expect.objectContaining({ id: "h5" }),
        expect.objectContaining({ id: "s5" })
      ]
    });
    await app.close();
  });

  it("enforces the Unicode 280-character chat limit and maps repository message limits to conflict", async () => {
    const addPostGameChatMessage = vi.fn(async () => {
      throw new RepositoryConflictError("Each participant may send at most three post-game messages per match.");
    });
    const app = await buildApp(repository({ addPostGameChatMessage }));

    const tooLong = await app.inject({
      method: "POST",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "player" },
      payload: { message: "🙂".repeat(281) }
    });
    const fourth = await app.inject({
      method: "POST",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "player" },
      payload: { message: "Good game" }
    });

    expect(tooLong.statusCode).toBe(400);
    expect(addPostGameChatMessage).toHaveBeenCalledTimes(1);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toEqual({ error: "Each participant may send at most three post-game messages per match." });
    await app.close();
  });

  it("publishes a server-timestamped persisted message only to completed-match participants", async () => {
    const persistedMessage = {
      id: messageId,
      matchId,
      authorUserId: playerId,
      clientMessageId,
      body: "Good game!",
      createdAt: endedAt
    };
    const addPostGameChatMessage = vi.fn(async () => persistedMessage);
    const publishPostGameChatMessage = vi.fn();
    const app = await buildApp(repository({
      addPostGameChatMessage,
      listPostGameChat: vi.fn(async () => ({ items: [persistedMessage], nextCursor: null }))
    }), { publishPostGameChatMessage });

    const forgedTimestamp = await app.inject({
      method: "POST",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "player" },
      payload: { message: "Good game!", clientMessageId, createdAt: startedAt.toISOString() }
    });
    const outsider = await app.inject({
      method: "POST",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "outsider" },
      payload: { message: "Let me in", clientMessageId }
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "player" },
      payload: { message: "Good game!", clientMessageId }
    });

    expect(forgedTimestamp.statusCode).toBe(400);
    expect(outsider.statusCode).toBe(404);
    expect(addPostGameChatMessage).toHaveBeenCalledOnce();
    expect(addPostGameChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      matchId,
      authorUserId: playerId,
      clientMessageId,
      body: "Good game!",
      createdAt: endedAt
    }));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      message: {
        id: messageId,
        playerId,
        displayName: "Asha",
        message: "Good game!",
        createdAt: endedAt.toISOString()
      },
      remaining: 2
    });
    expect(publishPostGameChatMessage).toHaveBeenCalledOnce();
    expect(publishPostGameChatMessage).toHaveBeenCalledWith({
      gameName,
      participantPlayerIds: [playerId, opponentId],
      message: response.json().message
    });
    await app.close();
  });

  it("maps encrypted repository chat records to public author identities", async () => {
    const app = await buildApp(repository({
      listPostGameChat: vi.fn(async () => ({
        items: [{
          id: messageId,
          matchId,
          authorUserId: opponentId,
          clientMessageId,
          body: "Well played!",
          createdAt: endedAt
        }],
        nextCursor: null
      }))
    }));
    const outsider = await app.inject({
      method: "GET",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "outsider" }
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/games/${gameName}/chat`,
      headers: { "x-test-user": "player" }
    });
    expect(outsider.statusCode).toBe(404);
    expect(response.json()).toEqual({
      messages: [{
        id: messageId,
        playerId: opponentId,
        displayName: "Bela",
        message: "Well played!",
        createdAt: endedAt.toISOString()
      }],
      remaining: 3
    });
    await app.close();
  });

  it("requires an allowlisted authenticated email for every admin endpoint", async () => {
    const repo = repository({
      getAdminOverview: vi.fn(async () => ({
        users: 12,
        suspendedUsers: 1,
        activeMatches: 4,
        completedMatches: 20,
        chatMessages: 9
      }))
    });
    const app = await buildApp(repo);
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/overview" });
    const player = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { "x-test-user": "player" }
    });
    const admin = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: { "x-test-user": "admin" }
    });
    expect(anonymous.statusCode).toBe(401);
    expect(player.statusCode).toBe(403);
    expect(admin.json()).toEqual({
      totalUsers: 12,
      totalGames: 24,
      activeGames: 4,
      activeGeneralMatches: 4,
      activePrivateMatches: 0,
      waitingPrivateRooms: 0,
      completedGames: 20,
      totalChatMessages: 9
    });
    await app.close();
  });

  it("searches admin users, returns total and an opaque query-bound cursor", async () => {
    const listAdminUsers = vi.fn(async () => ({
      items: [{
        id: playerId,
        email: "asha@example.com",
        displayName: "Asha",
        badgeId: "strategist" as const,
        phone: null,
        suspendedAt: null,
        suspensionReason: null,
        createdAt: startedAt,
        updatedAt: startedAt
      }],
      nextCursor: { createdAt: startedAt, userId: playerId },
      total: 1
    }));
    const app = await buildApp(repository({ listAdminUsers }));

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/users?q=%20ASHA%20&limit=1",
      headers: { "x-test-user": "admin" }
    });

    expect(response.statusCode).toBe(200);
    expect(listAdminUsers).toHaveBeenCalledWith({ query: "ASHA", limit: 1 });
    expect(response.json()).toEqual({
      users: [expect.objectContaining({
        id: playerId,
        email: "asha@example.com",
        displayName: "Asha"
      })],
      nextCursor: expect.any(String),
      total: 1
    });
    expect(response.headers["x-next-cursor"]).toBe(response.json().nextCursor);

    const changedSearch = await app.inject({
      method: "GET",
      url: `/api/admin/users?q=bela&cursor=${encodeURIComponent(response.json().nextCursor)}`,
      headers: { "x-test-user": "admin" }
    });
    expect(changedSearch.statusCode).toBe(400);
    expect(listAdminUsers).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("preserves creator and invite rows in unlocked-admin waiting-room list and detail responses", async () => {
    const waitingRoom: PrivateRoomRecord = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      roomCode: "velvet-lotus-654321",
      creatorUserId: playerId,
      creatorDisplayName: "Asha",
      creatorEmail: "asha@example.com",
      playerCount: 2,
      status: "waiting",
      matchId: null,
      gameName: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt: null,
      completedAt: null,
      invites: [{
        email: "bela@example.com",
        seatNumber: 1,
        acceptedByUserId: null,
        acceptedDisplayName: null,
        acceptedAt: null
      }]
    };
    const repo = repository({
      listAdminGames: vi.fn(async () => ({ items: [], nextCursor: null })),
      listWaitingPrivateRooms: vi.fn(async () => [waitingRoom]),
      getAdminGameByPublicName: vi.fn(async () => null),
      getPrivateRoomByCode: vi.fn(async () => waitingRoom)
    });
    const app = await buildApp(repo);
    const list = await app.inject({ method: "GET", url: "/api/admin/games", headers: { "x-test-user": "admin" } });
    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/games/${waitingRoom.roomCode}`,
      headers: { "x-test-user": "admin" }
    });
    expect(list.json().games).toEqual([expect.objectContaining({
      gameName: waitingRoom.roomCode,
      status: "waiting",
      matchType: "private",
      creator: expect.objectContaining({
        displayName: "Asha",
        email: "asha@example.com"
      }),
      invites: [{ email: "bela@example.com", status: "pending" }]
    })]);
    expect(detail.json()).toEqual(expect.objectContaining({
      game: expect.objectContaining({
        creator: expect.objectContaining({ email: "asha@example.com" }),
        invites: [{ email: "bela@example.com", status: "pending" }]
      }),
      replayAvailable: false
    }));
    expect(JSON.stringify(list.json())).not.toContain("\"invitations\"");
    expect(JSON.stringify(detail.json())).not.toContain("\"invitations\"");
    await app.close();
  });

  it("uses the repository's atomic suspension-and-audit operation and blocks self-suspension", async () => {
    const setUserSuspended = vi.fn(async () => ({
      id: playerId,
      email: "player@example.com",
      displayName: "Asha",
      badgeId: "strategist" as const,
      phone: null,
      suspendedAt: endedAt,
      suspensionReason: "Repeated abusive chat",
      createdAt: startedAt,
      updatedAt: endedAt
    }));
    const app = await buildApp(repository({ setUserSuspended }));
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${playerId}/suspension`,
      headers: { "x-test-user": "admin" },
      payload: { suspended: true, reason: "Repeated abusive chat" }
    });
    const self = await app.inject({
      method: "POST",
      url: `/api/admin/users/${adminId}/suspension`,
      headers: { "x-test-user": "admin" },
      payload: { suspended: true, reason: "Should not work" }
    });

    expect(response.statusCode).toBe(200);
    expect(setUserSuspended).toHaveBeenCalledWith({
      targetUserId: playerId,
      suspended: true,
      reason: "Repeated abusive chat",
      actorUserId: adminId,
      auditId,
      occurredAt: endedAt
    });
    expect(self.statusCode).toBe(409);
    expect(setUserSuspended).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
