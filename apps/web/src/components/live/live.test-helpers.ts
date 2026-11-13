import { vi } from "vitest";
import type { BroadcastComment, BroadcastFrame, LiveBroadcastSummary } from "@trinitymatrix/protocol";
import type { AuthPlayer, BroadcastVideoInfo, LiveBroadcastDetail } from "../../api";

export const liveName = "amber-forest-12345678";
export const livePlayer: AuthPlayer = { id: "11111111-1111-4111-8111-111111111111", email: "watch@example.test", displayName: "Asha", badgeId: "rookie", phone: null, createdAt: 1, updatedAt: 1 };
export const liveSummary: LiveBroadcastSummary = {
  gameName: liveName, gameId: "33333333-3333-4333-8333-333333333333", title: "Asha and Model AI", playerCount: 2,
  composition: "mixed", players: [{ id: livePlayer.id, displayName: "Asha", badgeId: "rookie", actorKind: "human" },
    { id: "22222222-2222-4222-8222-222222222222", displayName: "Model AI", badgeId: "strategist", actorKind: "ai", aiModelId: "fixture/model-one" }],
  status: "live", delayMs: 120_000, availableAt: 1_800_000_000_000, viewerCount: 3
};
export function liveFrame(sequence = 1): BroadcastFrame {
  const players = liveSummary.players.map((player) => ({ ...player, connected: true, cardCount: 13, status: "playing" as const }));
  return { sequence, capturedAt: 1_799_999_880_000 + sequence * 1_000, releasedAt: 1_800_000_000_000 + sequence * 1_000,
    game: { gameId: liveSummary.gameId, gameName: liveName, playerCount: 2, matchType: "general", players, currentPlayerId: livePlayer.id,
      topDiscard: null, wildRank: 7, stockCount: 26 - sequence, turnEndsAt: 1_800_000_050_000, phase: "playing", showdown: null, revision: sequence, toss: null },
    hands: players.map((player, playerIndex) => ({ playerId: player.id, cards: Array.from({ length: 13 }, (_, index) => ({ id: `${player.id}-card-${index}`, deck: 1, rank: index + 1, suit: playerIndex === 0 ? "clubs" as const : "hearts" as const, printedJoker: false })) })),
    event: { type: "game.discard", actorPlayerId: livePlayer.id, summary: `Released move ${sequence}` } };
}
export function liveComment(message = "Hello spectators"): BroadcastComment {
  return { id: "44444444-4444-4444-8444-444444444444", playerId: livePlayer.id, displayName: "Asha", message, createdAt: 1_800_000_000_000, releasedAt: 1_800_000_000_000, deleted: false };
}
export function liveDetail(frame: BroadcastFrame | null = liveFrame()): LiveBroadcastDetail {
  return { broadcast: liveSummary, frame, comments: [], serverNow: 1_800_000_005_000, canModerate: false };
}
export function videoInfo(overrides: Partial<BroadcastVideoInfo> = {}): BroadcastVideoInfo {
  return { enabled: true, canPublish: true, serverNow: Date.now(), limits: { width: 854, height: 480, frameRate: 15, maxDurationSeconds: 7200 }, video: null, ...overrides };
}
export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  onopen: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  close = vi.fn();
  constructor(readonly url: string, readonly options?: EventSourceInit) { super(); FakeEventSource.instances.push(this); }
  open() { this.onopen?.(new Event("open")); }
  fail() { this.onerror?.(new Event("error")); }
  emit(name: string, payload: unknown) { this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) })); }
}
