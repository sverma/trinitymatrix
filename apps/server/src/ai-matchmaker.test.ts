import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Card, ServerMessage } from "@trinitymatrix/protocol";
import { RankingGame } from "./game";
import { Matchmaker, type GameplaySocket } from "./matchmaker";
import { MemoryStateStore } from "./persistence";

class TestSocket implements GameplaySocket {
  readyState = 1;
  readonly events: ServerMessage[] = [];
  send(message: string) { this.events.push(JSON.parse(message) as ServerMessage); }
  close() { this.readyState = 3; }
}

const human = "11111111-1111-4111-8111-111111111111";
const otherHuman = "22222222-2222-4222-8222-222222222222";
const ai = "33333333-3333-4333-8333-333333333333";
const modelId = "provider/model-version";

describe("selected AI table allocation and shared gameplay validation", () => {
  const active: Matchmaker[] = [];
  afterEach(() => { active.splice(0).forEach((matchmaker) => matchmaker.shutdown()); });
  const make = (store = new MemoryStateStore()) => {
    const matchmaker = new Matchmaker(store);
    active.push(matchmaker);
    return matchmaker;
  };
  const connect = (matchmaker: Matchmaker, id: string, kind: "human" | "ai" = "human") => {
    const socket = new TestSocket();
    matchmaker.register({
      playerId: id, displayName: kind === "ai" ? "Model AI" : "Human player", actorKind: kind,
      ...(kind === "ai" ? { aiModelId: modelId } : {}), socket
    });
    return socket;
  };

  it("allocates an AI identity to exactly one of two simultaneous challengers", async () => {
    const store = new MemoryStateStore();
    const matchmaker = make(store);
    const first = connect(matchmaker, human);
    const second = connect(matchmaker, otherHuman);
    const model = connect(matchmaker, ai, "ai");
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => matchmaker.startSelectedMatch([human, ai])),
      Promise.resolve().then(() => matchmaker.startSelectedMatch([otherHuman, ai]))
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(model.events.filter(({ type }) => type === "game.started")).toHaveLength(1);
    expect(first.events.filter(({ type }) => type === "game.started")).toHaveLength(1);
    expect(second.events.some(({ type }) => type === "game.started")).toBe(false);
    expect(matchmaker.isPlayerAvailable(otherHuman)).toBe(true);
    expect(matchmaker.agentView(otherHuman)).toBeNull();
    await matchmaker.flush();
    const saved = await store.get<{ games: unknown[]; queues: { twoPlayer: string[]; sixPlayer: string[] } }>("matchmaker:active-games");
    expect(saved?.games).toHaveLength(1);
    expect(saved?.queues).toEqual({ twoPlayer: [], sixPlayer: [] });
  });

  it.each(["queue", "private reservation", "private waiting room", "disconnected"] as const)(
    "rejects a selected table while a human is committed to a %s", (commitment) => {
      const matchmaker = make();
      const humanSocket = connect(matchmaker, human);
      const modelSocket = connect(matchmaker, ai, "ai");
      if (commitment === "queue") matchmaker.handle(human, { type: "queue.join", playerCount: 2 });
      if (commitment === "private reservation") expect(matchmaker.reservePrivateEntry(human)).toBe(true);
      if (commitment === "private waiting room") {
        matchmaker.upsertPrivateRoom({
          roomCode: "amber-lotus-123456", playerCount: 2, status: "waiting",
          creator: { playerId: human, displayName: "Human player" },
          invites: [{ seatNumber: 1, email: "friend@example.test", status: "pending" }],
          acceptedCount: 1, requiredCount: 2, createdAt: "2026-11-13T10:00:00Z"
        });
      }
      if (commitment === "disconnected") {
        humanSocket.close();
        matchmaker.disconnect(human, humanSocket);
      }
      expect(matchmaker.isPlayerAvailable(human)).toBe(false);
      expect(() => matchmaker.startSelectedMatch([human, ai])).toThrow("busy, queued, or disconnected");
      expect(modelSocket.events.some(({ type }) => type === "game.started")).toBe(false);
      expect(matchmaker.isPlayerAvailable(ai)).toBe(true);
    }
  );

  it("rejects duplicate selections and accepts a complete six-seat mixed table", () => {
    const matchmaker = make();
    connect(matchmaker, human);
    connect(matchmaker, ai, "ai");
    expect(() => matchmaker.startSelectedMatch([human, human])).toThrow("distinct players");
    const aiIds = [ai, ...Array.from({ length: 4 }, () => randomUUID())];
    for (const id of aiIds.slice(1)) connect(matchmaker, id, "ai");
    const gameId = matchmaker.startSelectedMatch([human, ...aiIds]);
    const view = matchmaker.agentView(ai)!;
    expect(view.state.gameId).toBe(gameId);
    expect(view.state.playerCount).toBe(6);
    expect(view.state.players.filter(({ actorKind }) => actorKind === "ai")).toHaveLength(5);
    expect(Object.keys(view).sort()).toEqual(["hand", "playerId", "state"]);
    expect(view.hand).toHaveLength(13);
    expect(view.state).not.toHaveProperty("hands");
    expect(view.state).not.toHaveProperty("stock");
  });

  it("retains model identity and private hands after a persisted game restart", async () => {
    const store = new MemoryStateStore();
    const before = make(store);
    connect(before, human);
    connect(before, ai, "ai");
    const gameId = before.startSelectedMatch([human, ai]);
    const original = before.agentView(ai)!;
    await before.flush();
    before.shutdown();
    const after = make(store);
    await after.restore();
    const humanSocket = connect(after, human);
    connect(after, ai, "ai");
    const restored = after.agentView(ai)!;
    expect(restored.hand).toEqual(original.hand);
    expect(restored.state.gameId).toBe(gameId);
    expect(restored.state.players.find(({ id }) => id === ai)).toMatchObject({ actorKind: "ai", aiModelId: modelId });
    expect(humanSocket.events.find(({ type }) => type === "game.started"))
      .toMatchObject({ players: expect.arrayContaining([expect.objectContaining({ id: ai, actorKind: "ai", aiModelId: modelId })]) });
    expect(() => after.executeAgentCommand(human, {
      type: "game.drop", commandId: randomUUID(), gameId, expectedRevision: restored.state.revision
    })).toThrow("AI connection is required");
  });

  it.each(["printed joker", "selected wild"] as const)("drops an AI declaration whose only possible 21 uses a %s", async (wildType) => {
    const store = new MemoryStateStore();
    const game = new RankingGame([
      { id: ai, displayName: "Model AI", actorKind: "ai", aiModelId: modelId },
      { id: human, displayName: "Human player", actorKind: "human" }
    ], () => 0);
    const card = (id: string, suit: Card["suit"], rank: Card["rank"], printedJoker = false): Card =>
      ({ id, suit, rank, printedJoker, deck: 1 });
    const wildCard = wildType === "printed joker" ? card("joker", null, null, true) : card("wild7", "clubs", 7);
    const groups = [
      [card("c8", "clubs", 8), card("c10", "clubs", 10), wildCard],
      [card("h3", "hearts", 3), card("h6", "hearts", 6), card("h9", "hearts", 9)],
      [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6)],
      [card("s2", "spades", 2), card("s4", "spades", 4), card("s6", "spades", 6), card("s3", "spades", 3)]
    ];
    const discard = card("discard", "clubs", 5);
    const snapshot = game.snapshot();
    snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === ai);
    snapshot.hands = snapshot.hands.map((entry) => entry.playerId === ai ? { playerId: ai, cards: [...groups.flat(), discard] } : entry);
    snapshot.drawnBy = ai;
    snapshot.drawnCardId = discard.id;
    snapshot.wildRank = 7;
    snapshot.turnEndsAt = Date.now() + 45_000;
    await store.set("matchmaker:active-games", {
      version: 2, games: [snapshot], queues: { twoPlayer: [], sixPlayer: [] },
      gameTypes: { [game.id]: "general" }, privateRoomCodes: {}, privateRooms: []
    });
    const matchmaker = make(store);
    await matchmaker.restore();
    const modelSocket = connect(matchmaker, ai, "ai");
    const humanSocket = connect(matchmaker, human);
    const result = matchmaker.executeAgentCommand(ai, {
      type: "game.declare", commandId: randomUUID(), gameId: game.id, expectedRevision: snapshot.revision,
      discardCardId: discard.id, melds: groups.map((group) => group.map(({ id }) => id))
    });
    expect(result).toMatchObject({
      accepted: true, dropped: { playerId: ai, reason: expect.stringContaining("natural meld totaling exactly 21") },
      ended: { winnerId: human, reason: "invalid-declaration" }
    });
    expect(modelSocket.events).toContainEqual(expect.objectContaining({ type: "game.declaration-rejected", dropped: true }));
    expect(humanSocket.events).toContainEqual(expect.objectContaining({ type: "game.ended", winnerId: human }));
  });
});
