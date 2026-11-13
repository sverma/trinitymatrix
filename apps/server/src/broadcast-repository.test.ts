import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROADCAST_DELAY_MS } from "@trinitymatrix/protocol";
import { RankingGame } from "./game";
import { projectBroadcastFrame } from "./broadcast-repository";

describe("broadcast archive privacy boundary", () => {
  const receivedAt = new Date("2026-11-13T10:00:00Z");
  function fixture() {
    const game = new RankingGame([{ id: randomUUID(), displayName: "Human" }, { id: randomUUID(), displayName: "AI player", actorKind: "ai", aiModelId: "provider/model" }], () => 0);
    const state = game.snapshot();
    state.toss = null;
    state.stock[0]!.id = "NEVER_EXPOSE_STOCK_ORDER";
    state.discard.unshift({ ...state.discard[0]!, id: "NEVER_EXPOSE_OLD_DISCARD" });
    state.seenCommands = ["NEVER_EXPOSE_COMMAND_ID"];
    return { state, event: { sequence: 1, eventType: "game.started", actorUserId: null,
      payload: { state, email: "NEVER_EXPOSE_EMAIL", memory: "NEVER_EXPOSE_MEMORY", command: { secret: "NEVER_EXPOSE_COMMAND" } },
      occurredAt: receivedAt, recordedAt: receivedAt } };
  }

  it("releases every hand only at the exact two-minute server receipt boundary", () => {
    const { state, event } = fixture();
    expect(projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS - 1))).toBeNull();
    const frame = projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS))!;
    expect(frame.hands).toEqual(state.hands);
    expect(frame.releasedAt).toBe(+receivedAt + BROADCAST_DELAY_MS);
    expect(frame.game.players.map(({ cardCount }) => cardCount)).toEqual([13, 13]);
    expect(frame.game.broadcast).toEqual({ gameName: state.publicName, delayMs: BROADCAST_DELAY_MS });
  });

  it.each(["occurredAt", "recordedAt"] as const)("honors %s independently and does not trust backdated events", (timestamp) => {
    const { state, event } = fixture();
    event[timestamp] = new Date(+receivedAt + 30_000);
    expect(projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS))).toBeNull();
    expect(projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS + 30_000))?.releasedAt)
      .toBe(+receivedAt + BROADCAST_DELAY_MS + 30_000);
  });

  it("projects an allowlist and never spreads the archive, stock, commands or private layouts", () => {
    const { state, event } = fixture();
    state.phase = "showdown";
    state.showdown = { declarerId: state.seats[0]!.id, pendingPlayerIds: [], submissions: [{ playerId: state.seats[1]!.id, groups: [["PRIVATE_LAYOUT"]] }], endsAt: +receivedAt, score: 21 };
    const frame = projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS))!;
    const text = JSON.stringify(frame);
    expect(text).not.toMatch(/NEVER_EXPOSE|PRIVATE_LAYOUT|seenCommands|submissions|"stock"|"payload"|"memory"|"command"|"email"/);
    expect(frame.game.showdown?.submittedPlayerIds).toEqual([state.seats[1]!.id]);
    expect(Object.keys(frame)).toEqual(["sequence", "capturedAt", "releasedAt", "game", "hands", "event"]);
  });

  it("rejects mismatched games, malformed or duplicate hands and unsafe event labels", () => {
    const { state, event } = fixture();
    const now = new Date(+receivedAt + BROADCAST_DELAY_MS);
    expect(projectBroadcastFrame(event, "amber-lotus-12345678", now)).toBeNull();
    event.eventType = "NEVER_EXPOSE_EVENT_TEXT";
    expect(projectBroadcastFrame(event, state.publicName!, now)?.event).toEqual({ type: "game.update", summary: "Game updated" });
    state.hands[1]!.playerId = state.hands[0]!.playerId;
    expect(projectBroadcastFrame(event, state.publicName!, now)).toBeNull();
  });

  it("does not attach an outcome to a still-playing delayed frame", () => {
    const { state, event } = fixture();
    const winner = { id: state.seats[0]!.id, name: "Human", reason: "declaration" as const };
    expect(projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS), winner)?.winner).toBeUndefined();
    state.phase = "finished";
    expect(projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS), winner)?.winner).toEqual(winner);
  });

  it("projects only the actor's recorded grouping and reconciles it against the post-move hand", () => {
    const { state, event } = fixture(); const hand = state.hands[0]!;
    const ids = hand.cards.map(({ id }) => id);
    const command = { type: "game.draw", layout: [[ids[2], ids[0], "PRIVATE_FOREIGN_ID"], ids.slice(3, 12), [ids[1]]], memory: "PRIVATE_NOTES" };
    const frame = projectBroadcastFrame({ ...event, eventType: "game.draw", actorUserId: hand.playerId, payload: { state, command } },
      state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS))!;
    expect(frame.hands[0]!.layout).toEqual({ source: "recorded", groups: [[ids[2], ids[0]], ids.slice(3, 12), [ids[1]], [ids[12]]] });
    expect(frame.hands[0]!.layout!.groups.flat().sort()).toEqual([...ids].sort());
    expect(frame.hands[1]!.layout).toBeUndefined();
    expect(JSON.stringify(frame)).not.toMatch(/PRIVATE_|"command"|"memory"|"layout":\{"type"/);
    const wrongOwner = projectBroadcastFrame({ ...event, actorUserId: state.hands[1]!.playerId, payload: { state, command } },
      state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS))!;
    expect(wrongOwner.hands.every(({ layout }) => !layout)).toBe(true);
  });

  it("uses valid submitted groups from the released showdown snapshot and ignores malformed/unowned layouts", () => {
    const { state, event } = fixture(); const hand = state.hands[1]!; const ids = hand.cards.map(({ id }) => id);
    state.phase = "showdown";
    state.showdown = { declarerId: state.seats[0]!.id, pendingPlayerIds: [], submissions: [{ playerId: hand.playerId, groups: [ids.slice(0, 3), ids.slice(3)] }], endsAt: +receivedAt, score: 21 };
    const layouts = new Map<string, unknown>([[hand.playerId, [ids]], [state.hands[0]!.playerId, { invalid: true }], ["not-seated", [["PRIVATE_OTHER_HAND"]]]]);
    const frame = projectBroadcastFrame(event, state.publicName!, new Date(+receivedAt + BROADCAST_DELAY_MS), undefined, layouts)!;
    expect(frame.hands[1]!.layout).toEqual({ source: "recorded", groups: [ids.slice(0, 3), ids.slice(3)] });
    expect(frame.hands[0]!.layout).toBeUndefined();
    expect(JSON.stringify(frame)).not.toMatch(/PRIVATE_OTHER_HAND|submissions|"groups":\{.*invalid/);
  });
});
