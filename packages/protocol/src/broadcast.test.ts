import { describe, expect, it } from "vitest";
import { broadcastCommentBodySchema, broadcastCommentSchema, broadcastEventSchema, broadcastFrameSchema, broadcastHandSchema, parseClientMessage, parseServerMessage } from "./index";

const playerId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const game = {
  gameId: "00000000-0000-4000-8000-000000000003", gameName: "amber-lotus-12345678", playerCount: 2, matchType: "general",
  players: [playerId, otherId].map((id) => ({ id, displayName: "Player", badgeId: "rookie", connected: true, cardCount: 13, status: "playing" })),
  currentPlayerId: playerId, topDiscard: null, wildRank: 7, stockCount: 80, turnEndsAt: 45_000,
  phase: "playing", showdown: null, revision: 1, toss: null
};
describe("broadcast protocol compatibility and privacy", () => {
  it("preserves legacy queues and accepts only explicit optional boolean consent", () => {
    expect(parseClientMessage({ type: "queue.join", playerCount: 2 })).toEqual({ type: "queue.join", playerCount: 2 });
    expect(parseClientMessage({ type: "queue.join", playerCount: 6, broadcast: true })).toMatchObject({ broadcast: true });
    expect(() => parseClientMessage({ type: "queue.join", playerCount: 2, broadcast: "yes" })).toThrow();
    expect(parseServerMessage({ type: "queue.status", playerCount: 6, joined: 1, required: 6, broadcast: false })).toMatchObject({ broadcast: false });
  });
  it("adds static broadcast metadata without weakening the gameplay state boundary", () => {
    expect(parseServerMessage({ type: "game.state", ...game })).toMatchObject({ gameName: game.gameName });
    expect(parseServerMessage({ type: "game.state", ...game, broadcast: { gameName: game.gameName, delayMs: 120_000 } })).toMatchObject({ broadcast: { delayMs: 120_000 } });
    expect(() => parseServerMessage({ type: "game.state", ...game, broadcast: { gameName: game.gameName, delayMs: 119_999 } })).toThrow();
    expect(() => parseServerMessage({ type: "game.state", ...game, hands: [] })).toThrow();
  });
  it("allows released hand frames but rejects raw snapshot fields", () => {
    const frame = { sequence: 1, capturedAt: 0, releasedAt: 120_000, game,
      hands: [playerId, otherId].map((playerId) => ({ playerId, cards: [] })), event: { type: "game.started", summary: "Game started" } };
    expect(broadcastFrameSchema.parse(frame)).toMatchObject({ hands: [{ playerId }, { playerId: otherId }] });
    expect(() => broadcastFrameSchema.parse({ ...frame, stock: ["private"] })).toThrow();
    expect(() => broadcastFrameSchema.parse({ ...frame, game: { ...game, seenCommands: ["private"] } })).toThrow();
    expect(broadcastEventSchema.parse({ type: "frame", frame })).toMatchObject({ type: "frame" });
    expect(() => broadcastEventSchema.parse({ type: "viewers", viewerCount: -1 })).toThrow();
  });
  it("counts Unicode comment characters and requires retry-safe message IDs", () => {
    const body = { message: "🙂".repeat(280), clientMessageId: playerId };
    expect(broadcastCommentBodySchema.parse(body)).toEqual(body);
    expect(() => broadcastCommentBodySchema.parse({ ...body, message: "🙂".repeat(281) })).toThrow();
    expect(() => broadcastCommentBodySchema.parse({ message: "Hello" })).toThrow();
    expect(() => broadcastCommentSchema.parse({ id: playerId, playerId, displayName: "Player", message: "x".repeat(281), createdAt: 0, releasedAt: 0, deleted: false })).toThrow();
  });
  it("accepts structured stream closure codes and retains legacy reason-only messages", () => {
    expect(broadcastEventSchema.parse({ type: "closed", reason: "Legacy closure" })).toEqual({ type: "closed", reason: "Legacy closure" });
    for (const code of ["closed", "restart", "unavailable", "auth-required"]) {
      expect(broadcastEventSchema.parse({ type: "closed", code, reason: "Stream closed" })).toMatchObject({ code });
    }
    expect(() => broadcastEventSchema.parse({ type: "closed", code: "unknown", reason: "Stream closed" })).toThrow();
  });
  it("keeps legacy hands compatible and accepts recorded groupings only when they partition the released cards", () => {
    const cards = ["a", "b", "c"].map((id) => ({ id, suit: "clubs", rank: 7, deck: 1, printedJoker: false }));
    const hand = { playerId, cards };
    expect(broadcastHandSchema.parse(hand)).toEqual(hand);
    expect(broadcastHandSchema.parse({ ...hand, layout: { source: "recorded", groups: [["c"], ["a", "b"]] } })).toMatchObject({ layout: { source: "recorded" } });
    for (const groups of [[["a"], ["b"]], [["a", "b", "foreign"]], [["a", "b"], ["a", "c"]]]) {
      expect(() => broadcastHandSchema.parse({ ...hand, layout: { source: "recorded", groups } })).toThrow();
    }
    expect(() => broadcastHandSchema.parse({ ...hand, layout: { source: "suggested", groups: [["a", "b", "c"]] } })).toThrow();
  });
});
