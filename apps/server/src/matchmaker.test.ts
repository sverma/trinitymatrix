import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { RankingGame } from "./game";
import { Matchmaker, type GameArchive } from "./matchmaker";
import { MemoryStateStore } from "./persistence";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }> = [];

  send(message: string) {
    this.sent.push(message);
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }
}

const asWebSocket = (socket: FakeSocket) => socket as unknown as WebSocket;
const messages = (socket: FakeSocket) => socket.sent.map((message) => JSON.parse(message) as {
  type: string;
  gameId?: string;
  hand?: unknown[];
  matchType?: string;
  code?: string;
  phase?: string;
  revision?: number;
  reason?: string;
  winnerName?: string;
  showdown?: {
    declarerId: string;
    pendingPlayerIds: string[];
    submittedPlayerIds: string[];
    endsAt: number;
  } | null;
  room?: { status: string; invites: Array<{ seatNumber: number; email?: string; isCurrentUser?: boolean }> };
});

const createDeclarableTwoPlayerFixture = () => {
  const seeded = new RankingGame([
    { id: "player-1", displayName: "Alex" },
    { id: "player-2", displayName: "Saurabh" }
  ], () => 0);
  const snapshot = seeded.snapshot();
  const declarerId = seeded.currentPlayerId;
  const responderId = snapshot.seats.find(({ id }) => id !== declarerId)!.id;
  const responderCardIds = snapshot.hands
    .find(({ playerId }) => playerId === responderId)!
    .cards.map(({ id }) => id);
  const card = (id: string, suit: "clubs" | "diamonds" | "hearts" | "spades", rank: number) => ({
    id,
    deck: 1,
    suit,
    rank,
    printedJoker: false
  });
  const melds = [
    [card("pure-clubs-2", "clubs", 2), card("pure-clubs-3", "clubs", 3), card("pure-clubs-4", "clubs", 4)],
    [card("pure-diamonds-5", "diamonds", 5), card("pure-diamonds-6", "diamonds", 6), card("pure-diamonds-7", "diamonds", 7)],
    [card("pure-hearts-8", "hearts", 8), card("pure-hearts-9", "hearts", 9), card("pure-hearts-10", "hearts", 10)],
    [card("spades-2", "spades", 2), card("spades-4", "spades", 4), card("spades-6", "spades", 6), card("spades-9", "spades", 9)]
  ];
  const finalDiscard = card("final-discard", "clubs", 9);
  snapshot.hands = snapshot.hands.map((entry) => entry.playerId === declarerId
    ? { playerId: declarerId, cards: [...melds.flat(), finalDiscard] }
    : entry);
  snapshot.drawnBy = declarerId;
  snapshot.drawnCardId = finalDiscard.id;
  snapshot.revision = 2;
  snapshot.turnEndsAt = Date.now() + 45_000;
  return { seeded, snapshot, declarerId, responderId, responderCardIds, melds, finalDiscard };
};

const seedActiveGame = async (
  store: MemoryStateStore,
  fixture: ReturnType<typeof createDeclarableTwoPlayerFixture>
) => {
  await store.set("matchmaker:active-games", {
    version: 2,
    games: [fixture.snapshot],
    queues: { twoPlayer: [], sixPlayer: [] },
    gameTypes: { [fixture.seeded.id]: "general" },
    privateRoomCodes: {},
    privateRooms: []
  });
};

describe("Matchmaker restart recovery", () => {
  const active: Matchmaker[] = [];
  afterEach(() => {
    active.splice(0).forEach((matchmaker) => matchmaker.shutdown());
    vi.useRealTimers();
  });

  it("terminates the older socket when the same player opens a newer window", () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    active.push(matchmaker);
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();

    matchmaker.register({ playerId: "player-1", displayName: "One", socket: asWebSocket(firstSocket) });
    matchmaker.register({ playerId: "player-1", displayName: "One", socket: asWebSocket(secondSocket) });

    expect(firstSocket.closes).toContainEqual({ code: 4001, reason: "Session opened in another window" });
    expect(messages(secondSocket)).toContainEqual(expect.objectContaining({ type: "session.ready" }));
  });

  it("broadcasts persisted post-game chat only to the supplied match participants", () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    active.push(matchmaker);
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const outsiderSocket = new FakeSocket();
    matchmaker.register({ playerId: "player-1", displayName: "One", socket: asWebSocket(firstSocket) });
    matchmaker.register({ playerId: "player-2", displayName: "Two", socket: asWebSocket(secondSocket) });
    matchmaker.register({ playerId: "outsider", displayName: "Other", socket: asWebSocket(outsiderSocket) });

    matchmaker.broadcastPostGameChat(
      ["player-1", "player-2", "player-1"],
      "amber-forest-12345678",
      {
        id: "66666666-6666-4666-8666-666666666666",
        playerId: "11111111-1111-4111-8111-111111111111",
        displayName: "One",
        message: "Good game!",
        createdAt: "2026-08-23T06:21:00.000Z"
      }
    );

    const expected = {
      type: "chat.message",
      gameName: "amber-forest-12345678",
      message: expect.objectContaining({ message: "Good game!", createdAt: "2026-08-23T06:21:00.000Z" })
    };
    expect(messages(firstSocket)).toContainEqual(expected);
    expect(messages(secondSocket)).toContainEqual(expected);
    expect(messages(firstSocket).filter(({ type }) => type === "chat.message")).toHaveLength(1);
    expect(messages(outsiderSocket).some(({ type }) => type === "chat.message")).toBe(false);
  });

  it("restores the same active table and private hands after restart", async () => {
    const store = new MemoryStateStore();
    const beforeRestart = new Matchmaker(store);
    active.push(beforeRestart);
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    beforeRestart.register({ playerId: "player-1", displayName: "One", socket: asWebSocket(firstSocket) });
    beforeRestart.register({ playerId: "player-2", displayName: "Two", socket: asWebSocket(secondSocket) });
    beforeRestart.handle("player-1", { type: "queue.join", playerCount: 2 });
    beforeRestart.handle("player-2", { type: "queue.join", playerCount: 2 });
    await beforeRestart.flush();

    const originalStart = messages(firstSocket).find(({ type }) => type === "game.started")!;
    expect(originalStart.hand).toHaveLength(13);
    beforeRestart.shutdown();

    const afterRestart = new Matchmaker(store);
    active.push(afterRestart);
    await afterRestart.restore();
    const restoredFirstSocket = new FakeSocket();
    const restoredSecondSocket = new FakeSocket();
    afterRestart.register({ playerId: "player-1", displayName: "One", socket: asWebSocket(restoredFirstSocket) });
    afterRestart.register({ playerId: "player-2", displayName: "Two", socket: asWebSocket(restoredSecondSocket) });

    const restoredStart = messages(restoredFirstSocket).find(({ type }) => type === "game.started")!;
    expect(restoredStart.gameId).toBe(originalStart.gameId);
    expect(restoredStart.hand).toEqual(originalStart.hand);
    expect(messages(restoredSecondSocket).some(({ type }) => type === "game.started")).toBe(true);
  });

  it("waits for the responder's hand, then ends without waiting for durable completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T08:00:00.000Z"));
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const archive = {
      startPrivateGame: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      completeGame: vi.fn(() => completion)
    } satisfies GameArchive;
    const store = new MemoryStateStore();
    const fixture = createDeclarableTwoPlayerFixture();
    const { seeded, snapshot, declarerId, responderId, responderCardIds, melds, finalDiscard } = fixture;
    await seedActiveGame(store, fixture);

    const matchmaker = new Matchmaker(store, vi.fn(), archive);
    active.push(matchmaker);
    await matchmaker.restore();
    const alex = new FakeSocket();
    const saurabh = new FakeSocket();
    const sockets = new Map([
      ["player-1", alex],
      ["player-2", saurabh]
    ]);
    matchmaker.register({ playerId: "player-1", displayName: "Alex", socket: asWebSocket(alex) });
    matchmaker.register({ playerId: "player-2", displayName: "Saurabh", socket: asWebSocket(saurabh) });

    matchmaker.handle(declarerId, {
      type: "game.declare",
      commandId: "00000000-0000-4000-8000-000000000099",
      gameId: seeded.id,
      expectedRevision: snapshot.revision,
      discardCardId: finalDiscard.id,
      melds: melds.map((group) => group.map(({ id }) => id))
    });

    for (const socket of sockets.values()) {
      const showdown = messages(socket).findLast(({ type }) => type === "game.state");
      expect(showdown).toEqual(expect.objectContaining({
        type: "game.state",
        phase: "showdown",
        showdown: expect.objectContaining({
          declarerId,
          pendingPlayerIds: [responderId],
          submittedPlayerIds: []
        })
      }));
      expect(messages(socket)).not.toContainEqual(expect.objectContaining({
        type: "game.ended",
      }));
    }
    expect(vi.getTimerCount(), "showdown must retain one deadline timer").toBe(1);
    expect(archive.completeGame).not.toHaveBeenCalled();

    const showdownRevision = messages(saurabh).findLast(({ type }) => type === "game.state")!.revision!;
    matchmaker.handle(responderId, {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000100",
      gameId: seeded.id,
      expectedRevision: showdownRevision,
      groups: [responderCardIds]
    });

    for (const socket of sockets.values()) {
      expect(messages(socket).findLast(({ type }) => type === "game.state")).toEqual(expect.objectContaining({
        type: "game.state",
        phase: "finished"
      }));
      expect(messages(socket)).toContainEqual(expect.objectContaining({
        type: "game.ended",
        winnerName: "Alex",
        reason: "declaration"
      }));
    }
    expect(vi.getTimerCount(), "a finished game must not retain or re-arm its turn timer").toBe(0);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(archive.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "game.submit-hand",
      actorPlayerId: responderId,
      command: expect.objectContaining({ type: "game.submit-hand", groups: [responderCardIds] })
    }));
    expect(archive.completeGame).toHaveBeenCalledOnce();

    resolveCompletion();
    await completion;
  });

  it("restores a showdown and completes it at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T08:00:00.000Z"));
    const archive = {
      startPrivateGame: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
      completeGame: vi.fn(async () => undefined)
    } satisfies GameArchive;
    const store = new MemoryStateStore();
    const fixture = createDeclarableTwoPlayerFixture();
    const { seeded, snapshot, declarerId, responderId, melds, finalDiscard } = fixture;
    await seedActiveGame(store, fixture);

    const beforeRestart = new Matchmaker(store, vi.fn(), archive);
    active.push(beforeRestart);
    await beforeRestart.restore();
    beforeRestart.register({ playerId: "player-1", displayName: "Alex", socket: asWebSocket(new FakeSocket()) });
    beforeRestart.register({ playerId: "player-2", displayName: "Saurabh", socket: asWebSocket(new FakeSocket()) });
    beforeRestart.handle(declarerId, {
      type: "game.declare",
      commandId: "00000000-0000-4000-8000-000000000101",
      gameId: seeded.id,
      expectedRevision: snapshot.revision,
      discardCardId: finalDiscard.id,
      melds: melds.map((group) => group.map(({ id }) => id))
    });
    await beforeRestart.flush();
    beforeRestart.shutdown();

    const afterRestart = new Matchmaker(store, vi.fn(), archive);
    active.push(afterRestart);
    await afterRestart.restore();
    const alex = new FakeSocket();
    const saurabh = new FakeSocket();
    afterRestart.register({ playerId: "player-1", displayName: "Alex", socket: asWebSocket(alex) });
    afterRestart.register({ playerId: "player-2", displayName: "Saurabh", socket: asWebSocket(saurabh) });

    for (const socket of [alex, saurabh]) {
      expect(messages(socket)).toContainEqual(expect.objectContaining({
        type: "game.started",
        phase: "showdown",
        showdown: expect.objectContaining({
          declarerId,
          pendingPlayerIds: [responderId],
          submittedPlayerIds: []
        })
      }));
    }
    expect(vi.getTimerCount(), "a restored showdown must have one deadline timer").toBe(1);

    await vi.advanceTimersByTimeAsync(45_000);

    for (const socket of [alex, saurabh]) {
      expect(messages(socket).findLast(({ type }) => type === "game.state")).toEqual(expect.objectContaining({
        type: "game.state",
        phase: "finished"
      }));
      expect(messages(socket)).toContainEqual(expect.objectContaining({
        type: "game.ended",
        winnerName: "Alex",
        reason: "declaration"
      }));
    }
    expect(vi.getTimerCount(), "a timed-out showdown must release its deadline timer").toBe(0);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(archive.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "game.showdown-timed-out",
      actorPlayerId: null,
      command: null
    }));
    expect(archive.completeGame).toHaveBeenCalledOnce();
  });

  it("keeps a waiting player in the correct queue through restart", async () => {
    const store = new MemoryStateStore();
    const beforeRestart = new Matchmaker(store);
    active.push(beforeRestart);
    const firstSocket = new FakeSocket();
    beforeRestart.register({ playerId: "queued-1", displayName: "Waiting", socket: asWebSocket(firstSocket) });
    beforeRestart.handle("queued-1", { type: "queue.join", playerCount: 2 });
    await beforeRestart.flush();
    beforeRestart.shutdown();

    const afterRestart = new Matchmaker(store);
    active.push(afterRestart);
    await afterRestart.restore();
    const restoredFirst = new FakeSocket();
    const secondSocket = new FakeSocket();
    afterRestart.register({ playerId: "queued-1", displayName: "Waiting", socket: asWebSocket(restoredFirst) });
    expect(messages(restoredFirst)).toContainEqual(expect.objectContaining({ type: "queue.status" }));

    afterRestart.register({ playerId: "queued-2", displayName: "Joining", socket: asWebSocket(secondSocket) });
    afterRestart.handle("queued-2", { type: "queue.join", playerCount: 2 });
    expect(messages(restoredFirst).some(({ type }) => type === "game.started")).toBe(true);
    expect(messages(secondSocket).some(({ type }) => type === "game.started")).toBe(true);
  });

  it("starts one unranked private game only after every exact invite is accepted and connected", () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    active.push(matchmaker);
    const creator = new FakeSocket();
    const invitee = new FakeSocket();
    const creatorId = "11111111-1111-4111-8111-111111111111";
    const inviteeId = "22222222-2222-4222-8222-222222222222";
    matchmaker.register({ playerId: creatorId, email: "asha@example.com", displayName: "Asha", socket: asWebSocket(creator) });
    matchmaker.register({ playerId: inviteeId, email: "bela@example.com", displayName: "Bela", socket: asWebSocket(invitee) });
    matchmaker.upsertPrivateRoom({
      roomCode: "amber-lotus-123456",
      playerCount: 2,
      status: "waiting",
      creator: { playerId: creatorId, displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "pending" }],
      acceptedCount: 1,
      requiredCount: 2,
      createdAt: "2026-08-24T08:30:00.000Z"
    });
    expect(messages(creator).some(({ type }) => type === "game.started")).toBe(false);
    expect(messages(invitee)).toContainEqual(expect.objectContaining({ type: "private.room-status" }));

    matchmaker.upsertPrivateRoom({
      roomCode: "amber-lotus-123456",
      playerCount: 2,
      status: "waiting",
      creator: { playerId: creatorId, displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "accepted", playerId: inviteeId, displayName: "Bela" }],
      acceptedCount: 2,
      requiredCount: 2,
      createdAt: "2026-08-24T08:30:00.000Z"
    });

    expect(messages(creator).filter(({ type }) => type === "game.started")).toHaveLength(1);
    expect(messages(invitee).filter(({ type }) => type === "game.started")).toHaveLength(1);
    expect(messages(creator)).toContainEqual(expect.objectContaining({ type: "game.started", matchType: "private" }));
  });

  it("retains private classification while delayed archival follows an immediate drop", async () => {
    let resolveEvent!: () => void;
    const eventPersistence = new Promise<void>((resolve) => { resolveEvent = resolve; });
    const archive = {
      startPrivateGame: vi.fn(async () => undefined),
      recordEvent: vi.fn(() => eventPersistence),
      completeGame: vi.fn(async () => undefined)
    } satisfies GameArchive;
    const matchmaker = new Matchmaker(new MemoryStateStore(), vi.fn(), archive);
    active.push(matchmaker);
    const creator = new FakeSocket();
    const invitee = new FakeSocket();
    const creatorId = "11111111-1111-4111-8111-111111111111";
    const inviteeId = "22222222-2222-4222-8222-222222222222";
    const roomCode = "amber-lotus-123456";
    matchmaker.register({ playerId: creatorId, email: "asha@example.com", displayName: "Asha", socket: asWebSocket(creator) });
    matchmaker.register({ playerId: inviteeId, email: "bela@example.com", displayName: "Bela", socket: asWebSocket(invitee) });
    matchmaker.upsertPrivateRoom({
      roomCode,
      playerCount: 2,
      status: "waiting",
      creator: { playerId: creatorId, displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "accepted", playerId: inviteeId, displayName: "Bela" }],
      acceptedCount: 2,
      requiredCount: 2,
      createdAt: "2026-08-24T08:30:00.000Z"
    });
    await matchmaker.flush();

    const started = messages(invitee).findLast(({ type }) => type === "game.started")!;
    matchmaker.handle(inviteeId, {
      type: "game.drop",
      commandId: "00000000-0000-4000-8000-000000000123",
      gameId: started.gameId!,
      expectedRevision: started.revision!
    });

    expect(archive.completeGame).not.toHaveBeenCalled();
    resolveEvent();
    await matchmaker.flush();

    expect(archive.recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "game.drop",
      matchType: "private",
      privateRoomCode: roomCode
    }));
    expect(archive.completeGame).toHaveBeenCalledWith(expect.objectContaining({
      matchType: "private",
      privateRoomCode: roomCode,
      reason: "player-dropped"
    }));
  });

  it("does not expose a private game when cancellation wins the durable start race", async () => {
    let rejectStart!: (error: Error) => void;
    const durableStart = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
    const startPrivateGame = vi.fn(() => durableStart);
    const reportPersistenceError = vi.fn();
    const archive = {
      startPrivateGame,
      recordEvent: vi.fn(async () => undefined),
      completeGame: vi.fn(async () => undefined)
    } satisfies GameArchive;
    const matchmaker = new Matchmaker(new MemoryStateStore(), reportPersistenceError, archive);
    active.push(matchmaker);
    const creator = new FakeSocket();
    const invitee = new FakeSocket();
    const creatorId = "11111111-1111-4111-8111-111111111111";
    const inviteeId = "22222222-2222-4222-8222-222222222222";
    matchmaker.register({ playerId: creatorId, email: "asha@example.com", displayName: "Asha", socket: asWebSocket(creator) });
    matchmaker.register({ playerId: inviteeId, email: "bela@example.com", displayName: "Bela", socket: asWebSocket(invitee) });
    const readyRoom = {
      roomCode: "amber-lotus-123456",
      playerCount: 2 as const,
      status: "waiting" as const,
      creator: { playerId: creatorId, displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "accepted" as const, playerId: inviteeId, displayName: "Bela" }],
      acceptedCount: 2,
      requiredCount: 2 as const,
      createdAt: "2026-08-24T08:30:00.000Z"
    };
    matchmaker.upsertPrivateRoom(readyRoom);

    expect(startPrivateGame).toHaveBeenCalledOnce();
    expect(messages(creator).some(({ type }) => type === "game.started")).toBe(false);
    matchmaker.cancelPrivateRoom({ ...readyRoom, status: "cancelled" });
    rejectStart(new Error("The waiting room was cancelled before activation."));
    await matchmaker.flush();

    expect(startPrivateGame).toHaveBeenCalledOnce();
    expect(reportPersistenceError).toHaveBeenCalledOnce();
    expect(messages(creator).some(({ type }) => type === "game.started")).toBe(false);
    expect(messages(invitee).some(({ type }) => type === "game.started")).toBe(false);
    expect(messages(creator).findLast(({ type }) => type === "private.room-status")?.room?.status).toBe("cancelled");
  });

  it("reserves private entry across asynchronous persistence and rejects a queue race", () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    active.push(matchmaker);
    const socket = new FakeSocket();
    const playerId = "33333333-3333-4333-8333-333333333333";
    matchmaker.register({ playerId, email: "cora@example.com", displayName: "Cora", socket: asWebSocket(socket) });

    expect(matchmaker.reservePrivateEntry(playerId)).toBe(true);
    expect(matchmaker.reservePrivateEntry(playerId)).toBe(false);
    matchmaker.handle(playerId, { type: "queue.join", playerCount: 2 });
    expect(messages(socket)).toContainEqual(expect.objectContaining({ type: "error", code: "PRIVATE_ROOM_PENDING" }));
    matchmaker.releasePrivateEntry(playerId);
    matchmaker.handle(playerId, { type: "queue.join", playerCount: 2 });
    expect(messages(socket)).toContainEqual(expect.objectContaining({ type: "queue.status" }));
  });

  it("restores private-game classification and hands across a coordinator restart", async () => {
    const store = new MemoryStateStore();
    const before = new Matchmaker(store);
    active.push(before);
    const creatorId = "11111111-1111-4111-8111-111111111111";
    const inviteeId = "22222222-2222-4222-8222-222222222222";
    const creator = new FakeSocket();
    const invitee = new FakeSocket();
    before.register({ playerId: creatorId, email: "asha@example.com", displayName: "Asha", socket: asWebSocket(creator) });
    before.register({ playerId: inviteeId, email: "bela@example.com", displayName: "Bela", socket: asWebSocket(invitee) });
    before.upsertPrivateRoom({
      roomCode: "swift-river-777777",
      playerCount: 2,
      status: "waiting",
      creator: { playerId: creatorId, displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "accepted", playerId: inviteeId, displayName: "Bela" }],
      acceptedCount: 2,
      requiredCount: 2,
      createdAt: "2026-08-24T08:30:00.000Z"
    });
    const original = messages(creator).find(({ type }) => type === "game.started")!;
    await before.flush();
    before.shutdown();

    const after = new Matchmaker(store);
    active.push(after);
    await after.restore();
    const reconnected = new FakeSocket();
    after.register({ playerId: creatorId, email: "asha@example.com", displayName: "Asha", socket: asWebSocket(reconnected) });
    expect(messages(reconnected)).toContainEqual(expect.objectContaining({
      type: "game.started",
      gameId: original.gameId,
      matchType: "private"
    }));
  });

  it("personalizes six-player room events so an invitee cannot see other invitation emails", () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    active.push(matchmaker);
    const invitee = new FakeSocket();
    matchmaker.register({
      playerId: "22222222-2222-4222-8222-222222222222",
      email: "bela@example.com",
      displayName: "Bela",
      socket: asWebSocket(invitee)
    });
    matchmaker.upsertPrivateRoom({
      roomCode: "coral-tiger-999999",
      playerCount: 6,
      status: "waiting",
      creator: { playerId: "11111111-1111-4111-8111-111111111111", displayName: "Asha" },
      invites: [
        { seatNumber: 1, email: "bela@example.com", status: "pending" },
        { seatNumber: 2, email: "cora@example.com", status: "pending" },
        { seatNumber: 3, email: "dev@example.com", status: "pending" },
        { seatNumber: 4, email: "esha@example.com", status: "pending" },
        { seatNumber: 5, email: "farah@example.com", status: "pending" }
      ],
      acceptedCount: 1,
      requiredCount: 6,
      createdAt: "2026-08-24T08:30:00.000Z"
    });
    const event = messages(invitee).findLast(({ type }) => type === "private.room-status")!;
    expect(event.room?.invites).toEqual([
      { seatNumber: 1, email: "bela@example.com", isCurrentUser: true, status: "pending" },
      { seatNumber: 2, status: "pending" },
      { seatNumber: 3, status: "pending" },
      { seatNumber: 4, status: "pending" },
      { seatNumber: 5, status: "pending" }
    ]);
    expect(JSON.stringify(event)).not.toContain("cora@example.com");
  });

  it("starts a six-player private table only when all five accepted invitees are connected", () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    active.push(matchmaker);
    const players = [
      ["11111111-1111-4111-8111-111111111111", "asha@example.com", "Asha"],
      ["22222222-2222-4222-8222-222222222222", "bela@example.com", "Bela"],
      ["33333333-3333-4333-8333-333333333333", "cora@example.com", "Cora"],
      ["44444444-4444-4444-8444-444444444444", "dev@example.com", "Dev"],
      ["55555555-5555-4555-8555-555555555555", "esha@example.com", "Esha"],
      ["66666666-6666-4666-8666-666666666666", "farah@example.com", "Farah"]
    ] as const;
    const sockets = players.map(([playerId, email, displayName]) => {
      const socket = new FakeSocket();
      matchmaker.register({ playerId, email, displayName, socket: asWebSocket(socket) });
      return socket;
    });
    matchmaker.upsertPrivateRoom({
      roomCode: "royal-summit-121212",
      playerCount: 6,
      status: "waiting",
      creator: { playerId: players[0][0], displayName: players[0][2] },
      invites: players.slice(1).map(([playerId, email, displayName], index) => ({
        seatNumber: index + 1,
        email,
        status: "accepted" as const,
        playerId,
        displayName
      })),
      acceptedCount: 6,
      requiredCount: 6,
      createdAt: "2026-08-24T08:30:00.000Z"
    });
    for (const socket of sockets) {
      expect(messages(socket).filter(({ type }) => type === "game.started")).toEqual([
        expect.objectContaining({ matchType: "private" })
      ]);
    }
  });
});
