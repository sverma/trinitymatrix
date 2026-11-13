import { describe, expect, it } from "vitest";
import { parseClientMessage, parseServerMessage } from "./index";

describe("client protocol", () => {
  it("accepts literal two-player and six-player queues", () => {
    expect(parseClientMessage({ type: "queue.join", playerCount: 2 })).toEqual({ type: "queue.join", playerCount: 2 });
    expect(parseClientMessage({ type: "queue.join", playerCount: 6 })).toEqual({ type: "queue.join", playerCount: 6 });
  });

  it("rejects unsupported queue sizes and extra fields", () => {
    expect(() => parseClientMessage({ type: "queue.join", playerCount: 4 })).toThrow();
    expect(() => parseClientMessage({ type: "queue.leave", playerId: "forged" })).toThrow();
  });

  it("does not let clients attach an AI technical reason to a drop command", () => {
    const command = { type: "game.drop", commandId: "00000000-0000-4000-8000-000000000001", gameId: "00000000-0000-4000-8000-000000000002", expectedRevision: 1 };
    expect(() => parseClientMessage({ ...command, reasonCode: "AI_UNAVAILABLE", reason: "Provider unavailable." })).toThrow();
    expect(() => parseClientMessage({ ...command, aiFailure: { code: "AI_UNAVAILABLE", message: "Provider unavailable." } })).toThrow();
  });

  it("accepts a showdown hand submission with singleton unmatched groups", () => {
    const command = {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000001",
      gameId: "00000000-0000-4000-8000-000000000002",
      expectedRevision: 4,
      groups: [["card-1", "card-2", "card-3"], ["unmatched-card"]]
    } as const;
    expect(parseClientMessage(command)).toEqual(command);
  });

  it("rejects an empty showdown submission or empty group", () => {
    const base = {
      type: "game.submit-hand",
      commandId: "00000000-0000-4000-8000-000000000001",
      gameId: "00000000-0000-4000-8000-000000000002",
      expectedRevision: 4
    } as const;
    expect(() => parseClientMessage({ ...base, groups: [] })).toThrow();
    expect(() => parseClientMessage({ ...base, groups: [[]] })).toThrow();
  });

  it("accepts bounded replay layouts on moves and rejects duplicate card ids", () => {
    const command = {
      type: "game.discard",
      commandId: "00000000-0000-4000-8000-000000000001",
      gameId: "00000000-0000-4000-8000-000000000002",
      expectedRevision: 4,
      cardId: "card-4",
      layout: [["card-1", "card-2", "card-3"], ["card-4"]]
    } as const;

    expect(parseClientMessage(command)).toEqual(command);
    expect(() => parseClientMessage({ ...command, layout: [["card-1"], ["card-1"]] })).toThrow();
  });
});

describe("server protocol", () => {
  it("accepts bounded server-authored AI forfeit reasons while preserving ordinary drops", () => {
    const event = { type: "game.player-dropped", playerId: "ai-1", playerName: "Model One" };
    expect(parseServerMessage(event)).toEqual(event);
    const technical = { ...event, reasonCode: "AI_BUDGET_EXHAUSTED", reason: "The shared daily AI budget was reached." };
    expect(parseServerMessage(technical)).toEqual(technical);
    expect(() => parseServerMessage({ ...technical, reasonCode: "ARBITRARY_PROVIDER_ERROR" })).toThrow();
    expect(() => parseServerMessage({ ...technical, reason: "x".repeat(301) })).toThrow();
  });
  const chatEvent = {
    type: "chat.message",
    gameName: "amber-forest-12345678",
    message: {
      id: "66666666-6666-4666-8666-666666666666",
      playerId: "11111111-1111-4111-8111-111111111111",
      displayName: "Asha",
      message: "Well played!",
      createdAt: "2026-08-23T06:21:00.000Z"
    }
  } as const;

  it("accepts an authoritative post-game chat event", () => {
    expect(parseServerMessage(chatEvent)).toEqual(chatEvent);
  });

  it("rejects malformed timestamps, extra fields, and chat over 280 Unicode characters", () => {
    expect(() => parseServerMessage({
      ...chatEvent,
      message: { ...chatEvent.message, createdAt: "yesterday" }
    })).toThrow();
    expect(() => parseServerMessage({ ...chatEvent, participantIds: [chatEvent.message.playerId] })).toThrow();
    expect(() => parseServerMessage({
      ...chatEvent,
      message: { ...chatEvent.message, message: "🙂".repeat(281) }
    })).toThrow();
  });

  it("accepts private-room invitation and status events without exposing an internal room id", () => {
    const room = {
      roomCode: "amber-lotus-123456",
      playerCount: 2,
      status: "waiting",
      creator: { playerId: "11111111-1111-4111-8111-111111111111", displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "pending" }],
      acceptedCount: 1,
      requiredCount: 2,
      createdAt: "2026-08-24T08:30:00.000Z"
    } as const;
    expect(parseServerMessage({ type: "private.room-status", room })).toEqual({ type: "private.room-status", room });
    expect(parseServerMessage({
      type: "private.invitation",
      invitation: {
        roomCode: room.roomCode,
        playerCount: 2,
        creatorDisplayName: "Asha",
        status: "pending",
        createdAt: room.createdAt
      }
    })).toMatchObject({ type: "private.invitation", invitation: { roomCode: room.roomCode } });
    expect(() => parseServerMessage({
      type: "private.room-status",
      room: { ...room, id: "22222222-2222-4222-8222-222222222222" }
    })).toThrow();
  });

  it("accepts showdown state while exposing responder ids but no submitted groups", () => {
    const state = {
      type: "game.state",
      gameId: "00000000-0000-4000-8000-000000000001",
      gameName: "amber-forest-12345678",
      playerCount: 2,
      matchType: "general",
      players: [
        { id: "player-1", displayName: "Asha", badgeId: "strategist", connected: true, cardCount: 0, status: "declared" },
        { id: "player-2", displayName: "Bela", badgeId: "rookie", connected: true, cardCount: 13, status: "playing" }
      ],
      currentPlayerId: "player-1",
      topDiscard: null,
      wildRank: 7,
      stockCount: 10,
      turnEndsAt: 2_000,
      phase: "showdown",
      showdown: {
        declarerId: "player-1",
        pendingPlayerIds: ["player-2"],
        submittedPlayerIds: [],
        endsAt: 2_000,
        score: 63
      },
      revision: 3,
      toss: null
    } as const;
    expect(parseServerMessage(state)).toEqual(state);
    expect(JSON.stringify(parseServerMessage(state))).not.toContain("groups");
  });

  it("accepts a declaration result with the winner's Trinity score", () => {
    const result = {
      type: "game.ended",
      winnerId: "player-1",
      winnerName: "Asha",
      reason: "declaration",
      score: 63
    } as const;
    expect(parseServerMessage(result)).toEqual(result);
  });
});
