import { describe, expect, it } from "vitest";
import type { Card } from "@trinitymatrix/protocol";
import { RankingGame } from "./game";

const players = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `player-${index}`,
  displayName: `Player ${index + 1}`
}));

const card = (id: string, suit: Card["suit"], rank: number): Card => ({
  id,
  deck: 1,
  suit,
  rank,
  printedJoker: false
});

function readyToDeclare(count: 2 | 6, droppedPlayerIds: readonly string[] = []) {
  const base = new RankingGame(players(count), () => 0);
  const snapshot = base.snapshot();
  const declarerId = base.currentPlayerId;
  const meldCards = [
    [card("h1", "hearts", 1), card("h2", "hearts", 2), card("h3", "hearts", 3)],
    [card("s4", "spades", 4), card("s5", "spades", 5), card("s6", "spades", 6)],
    [card("c7", "clubs", 7), card("d7", "diamonds", 7), card("h7", "hearts", 7)],
    [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6), card("d9", "diamonds", 9)]
  ];
  const showCard = card("show-card", "clubs", 2);
  snapshot.hands = snapshot.hands.map((entry) => entry.playerId === declarerId
    ? { ...entry, cards: [...meldCards.flat(), showCard] }
    : entry);
  snapshot.seats = snapshot.seats.map((seat) => droppedPlayerIds.includes(seat.id)
    ? { ...seat, status: "dropped" as const, detached: true }
    : seat);
  snapshot.drawnBy = declarerId;
  snapshot.drawnCardId = showCard.id;
  snapshot.wildRank = 13;
  const game = RankingGame.restore(snapshot);
  return {
    game,
    declarerId,
    showCardId: showCard.id,
    melds: meldCards.map((group) => group.map(({ id }) => id))
  };
}

function declareReadyHand(input: ReturnType<typeof readyToDeclare>, commandId: string) {
  return input.game.apply(input.declarerId, {
    type: "game.declare",
    commandId,
    gameId: input.game.id,
    expectedRevision: input.game.publicState().revision,
    discardCardId: input.showCardId,
    melds: input.melds
  });
}

describe("RankingGame", () => {
  it.each([2, 6] as const)("deals 13 cards to every player in a %i-player game", (count) => {
    const game = new RankingGame(players(count), () => 0);
    expect(game.publicState().players).toHaveLength(count);
    for (const player of players(count)) expect(game.handFor(player.id)).toHaveLength(13);
    expect(game.publicState().toss?.cards).toHaveLength(count);
    expect(game.currentPlayerId).toBe(game.publicState().toss?.winnerId);
  });

  it("enforces draw then discard and advances the turn", () => {
    const game = new RankingGame(players(2), () => 0);
    const first = game.currentPlayerId;
    const start = game.publicState();
    const draw = game.apply(first, {
      type: "game.draw",
      commandId: "00000000-0000-4000-8000-000000000001",
      gameId: game.id,
      expectedRevision: start.revision,
      source: "stock"
    });
    expect(draw.accepted).toBe(true);
    expect(game.handFor(first)).toHaveLength(14);
    const cardId = game.handFor(first)[0]!.id;
    const discard = game.apply(first, {
      type: "game.discard",
      commandId: "00000000-0000-4000-8000-000000000002",
      gameId: game.id,
      expectedRevision: game.publicState().revision,
      cardId
    });
    expect(discard.accepted).toBe(true);
    expect(game.handFor(first)).toHaveLength(13);
    expect(game.currentPlayerId).not.toBe(first);
  });

  it("rejects commands from another player", () => {
    const game = new RankingGame(players(2), () => 0);
    const other = players(2).find(({ id }) => id !== game.currentPlayerId)!;
    const result = game.apply(other.id, {
      type: "game.draw",
      commandId: "00000000-0000-4000-8000-000000000003",
      gameId: game.id,
      expectedRevision: game.publicState().revision,
      source: "stock"
    });
    expect(result).toMatchObject({ accepted: false, code: "NOT_YOUR_TURN" });
  });

  it("commits an invalid show, drops the declarer, and awards a two-player round", () => {
    const game = new RankingGame(players(2), () => 0);
    const declarer = game.currentPlayerId;
    const opponent = players(2).find(({ id }) => id !== declarer)!;
    const draw = game.apply(declarer, {
      type: "game.draw",
      commandId: "00000000-0000-4000-8000-000000000010",
      gameId: game.id,
      expectedRevision: game.publicState().revision,
      source: "stock"
    });
    expect(draw.accepted).toBe(true);
    const hand = game.handFor(declarer);
    const result = game.apply(declarer, {
      type: "game.declare",
      commandId: "00000000-0000-4000-8000-000000000011",
      gameId: game.id,
      expectedRevision: game.publicState().revision,
      discardCardId: hand[0]!.id,
      melds: [hand.slice(1).map(({ id }) => id)]
    });

    expect(result).toMatchObject({
      accepted: true,
      dropped: { playerId: declarer },
      ended: { winnerId: opponent.id }
    });
    expect(game.publicState().phase).toBe("finished");
    expect(game.publicState().players.find(({ id }) => id === declarer)?.status).toBe("dropped");
    expect(game.handFor(declarer)).toHaveLength(13);
    expect(game.isAttached(declarer)).toBe(true);
  });

  it("holds a valid two-player show open until the opponent submits all 13 cards", () => {
    const ready = readyToDeclare(2);
    const opponentId = players(2).find(({ id }) => id !== ready.declarerId)!.id;
    const declared = declareReadyHand(ready, "00000000-0000-4000-8000-000000000030");

    expect(declared).toEqual({ accepted: true });
    expect(ready.game.publicState()).toMatchObject({
      phase: "showdown",
      showdown: {
        declarerId: ready.declarerId,
        pendingPlayerIds: [opponentId],
        submittedPlayerIds: [],
        score: 63
      }
    });
    expect(ready.game.publicState().showdown?.endsAt).toBe(ready.game.publicState().turnEndsAt);
    expect(ready.game.publicState().players.find(({ id }) => id === ready.declarerId)?.status).toBe("declared");

    const opponentGroups = [ready.game.handFor(opponentId).map(({ id }) => id)];
    const submitted = ready.game.apply(opponentId, {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000031",
      gameId: ready.game.id,
      expectedRevision: ready.game.publicState().revision,
      groups: opponentGroups
    });

    expect(submitted).toMatchObject({
      accepted: true,
      ended: { winnerId: ready.declarerId, reason: "declaration", score: 63 }
    });
    expect(ready.game.publicState()).toMatchObject({
      phase: "finished",
      showdown: { pendingPlayerIds: [], submittedPlayerIds: [opponentId] }
    });
    expect(ready.game.publicState().showdown).not.toHaveProperty("submissions");
    expect(ready.game.publicState().showdown).not.toHaveProperty("groups");
    expect(ready.game.snapshot().showdown?.submissions).toEqual([{ playerId: opponentId, groups: opponentGroups }]);
    expect(RankingGame.restore(ready.game.snapshot()).publicState().showdown?.submittedPlayerIds).toEqual([opponentId]);
  });

  it("rejects missing, duplicate, and non-pending showdown cards without advancing settlement", () => {
    const ready = readyToDeclare(2);
    const opponentId = players(2).find(({ id }) => id !== ready.declarerId)!.id;
    declareReadyHand(ready, "00000000-0000-4000-8000-000000000032");
    const handIds = ready.game.handFor(opponentId).map(({ id }) => id);
    const revision = ready.game.publicState().revision;

    const missing = ready.game.apply(opponentId, {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000033",
      gameId: ready.game.id,
      expectedRevision: revision,
      groups: [handIds.slice(0, 12)]
    });
    const duplicate = ready.game.apply(opponentId, {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000034",
      gameId: ready.game.id,
      expectedRevision: revision,
      groups: [[...handIds.slice(0, 12), handIds[0]!]]
    });
    const declarerSubmission = ready.game.apply(ready.declarerId, {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000035",
      gameId: ready.game.id,
      expectedRevision: revision,
      groups: [ready.game.handFor(ready.declarerId).map(({ id }) => id)]
    });

    expect(missing).toMatchObject({ accepted: false, code: "INVALID_HAND_SUBMISSION" });
    expect(duplicate).toMatchObject({ accepted: false, code: "INVALID_HAND_SUBMISSION" });
    expect(declarerSubmission).toMatchObject({ accepted: false, code: "HAND_NOT_PENDING" });
    expect(ready.game.publicState()).toMatchObject({
      phase: "showdown",
      revision,
      showdown: { pendingPlayerIds: [opponentId], submittedPlayerIds: [] }
    });
  });

  it("waits only for live six-player seats and ends when the showdown deadline expires", () => {
    const initial = new RankingGame(players(6), () => 0);
    const declarerId = initial.currentPlayerId;
    const droppedIds = players(6).filter(({ id }) => id !== declarerId).slice(0, 2).map(({ id }) => id);
    const ready = readyToDeclare(6, droppedIds);
    const expectedPending = players(6)
      .map(({ id }) => id)
      .filter((id) => id !== ready.declarerId && !droppedIds.includes(id));
    declareReadyHand(ready, "00000000-0000-4000-8000-000000000036");

    expect(ready.game.publicState().showdown?.pendingPlayerIds).toEqual(expectedPending);
    const firstResponder = expectedPending[0]!;
    const response = ready.game.apply(firstResponder, {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000037",
      gameId: ready.game.id,
      expectedRevision: ready.game.publicState().revision,
      groups: [ready.game.handFor(firstResponder).map(({ id }) => id)]
    });
    expect(response).toEqual({ accepted: true });
    expect(ready.game.publicState().showdown).toMatchObject({
      pendingPlayerIds: expectedPending.slice(1),
      submittedPlayerIds: [firstResponder]
    });

    const timedOut = ready.game.timeout();
    expect(timedOut).toMatchObject({
      accepted: true,
      ended: { winnerId: ready.declarerId, reason: "declaration", score: 63 }
    });
    expect(ready.game.publicState()).toMatchObject({
      phase: "finished",
      showdown: { pendingPlayerIds: [], submittedPlayerIds: [firstResponder] }
    });
  });

  it("lets either player concede immediately and awards the opponent", () => {
    const game = new RankingGame(players(2), () => 0);
    const playerId = players(2).find(({ id }) => id !== game.currentPlayerId)!.id;
    const opponentId = game.currentPlayerId;

    const result = game.apply(playerId, {
      type: "game.drop",
      commandId: "00000000-0000-4000-8000-000000000020",
      gameId: game.id,
      expectedRevision: game.publicState().revision
    });

    expect(result).toMatchObject({
      accepted: true,
      left: { playerId },
      ended: { winnerId: opponentId, reason: "player-dropped" }
    });
    expect(game.publicState().phase).toBe("finished");
    expect(game.publicState().players.find(({ id }) => id === playerId)?.status).toBe("dropped");
    expect(game.isAttached(playerId)).toBe(false);
  });

  it("detaches a voluntarily dropped six-player seat while the table continues", () => {
    const game = new RankingGame(players(6), () => 0);
    const currentPlayerId = game.currentPlayerId;
    const playerId = players(6).find(({ id }) => id !== currentPlayerId)!.id;

    const result = game.apply(playerId, {
      type: "game.drop",
      commandId: "00000000-0000-4000-8000-000000000021",
      gameId: game.id,
      expectedRevision: game.publicState().revision
    });

    expect(result).toMatchObject({ accepted: true, left: { playerId } });
    expect(result).not.toHaveProperty("ended");
    expect(game.publicState().phase).toBe("playing");
    expect(game.currentPlayerId).toBe(currentPlayerId);
    expect(game.isAttached(playerId)).toBe(false);
  });

  it("restores an in-progress game without changing private card state", () => {
    const game = new RankingGame(players(2), () => 0);
    const first = game.currentPlayerId;
    game.apply(first, {
      type: "game.draw",
      commandId: "00000000-0000-4000-8000-000000000004",
      gameId: game.id,
      expectedRevision: game.publicState().revision,
      source: "stock"
    });

    const restored = RankingGame.restore(game.snapshot());

    expect(restored.id).toBe(game.id);
    expect(restored.publicState()).toMatchObject({
      revision: game.publicState().revision,
      currentPlayerId: first,
      stockCount: game.publicState().stockCount,
      toss: game.publicState().toss
    });
    expect(restored.handFor(first)).toEqual(game.handFor(first));
    expect(restored.handFor(first)).toHaveLength(14);
    expect(restored.publicState().players.every(({ connected }) => !connected)).toBe(true);
  });

  it("restores a legacy version-one snapshot that predates showdown state", () => {
    const game = new RankingGame(players(2), () => 0);
    const { showdown: _showdown, ...legacySnapshot } = game.snapshot();

    const restored = RankingGame.restore(legacySnapshot);

    expect(restored.publicState()).toMatchObject({ phase: "playing", showdown: null });
  });
});
