import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BroadcastEvent } from "@trinitymatrix/protocol";
import { BroadcastService } from "./broadcast-service";
import type { BroadcastDetail } from "./broadcast-repository";
import { Matchmaker } from "./matchmaker";
import { MemoryStateStore } from "./persistence";

// Isolated fan-out/bounds regression, not a measurement of host throughput.
describe("bounded native broadcast fan-out", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const close of cleanup.splice(0)) close(); vi.useRealTimers(); });

  const detail = (gameName: string, comments: BroadcastDetail["comments"] = []): BroadcastDetail => ({
    broadcast: { gameName, gameId: randomUUID(), title: "Synthetic table", playerCount: 2, composition: "human", players: [],
      status: "buffering", delayMs: 120000, availableAt: 120000, viewerCount: 0 }, frame: null, comments
  });

  it("shares 20 polls for 200 watchers, bounds stalled work, and isolates gameplay and slow-reader cleanup", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const names = Array.from({ length: 20 }, (_, index) => `amber-lotus-${10000000 + index}`);
    const waiting = new Map<string, (value: BroadcastDetail) => void>();
    let stalled = true; let publishComment = false;
    const repository = { detail: vi.fn((name: string) => stalled
      ? new Promise<BroadcastDetail>((resolve) => waiting.set(name, resolve))
      : Promise.resolve(detail(name, publishComment ? [{ id: "synthetic-comment", playerId: "synthetic-viewer", displayName: "Viewer", message: "Released comment", createdAt: 1, releasedAt: 1, deleted: false }] : []))) };
    const service = new BroadcastService(repository); cleanup.push(() => service.dispose());
    const slow = new Set<string>();
    const disconnect: (() => void)[] = [];
    for (const name of names) for (let index = 0; index < 10; index++) {
      const userId = `${name}-viewer-${index}`;
      if (index === 0) slow.add(userId);
      disconnect.push(service.subscribe(name, userId, (event) => !(event.type === "comment" && slow.has(userId)), async () => true));
    }
    expect(() => service.subscribe(names[0]!, "watcher-201", () => true, async () => true)).toThrow("limit");
    await vi.advanceTimersByTimeAsync(5000);
    expect(repository.detail).toHaveBeenCalledTimes(20);
    expect(waiting.size).toBe(20);
    for (const name of names) {
      expect(service.viewerCount(name)).toBe(10);
      expect(repository.detail.mock.calls.filter(([called]) => called === name)).toHaveLength(1);
    }

    // Spectator DB work is deliberately unresolved while an ordinary match takes a turn.
    class Socket {
      readyState = 1; sent: any[] = []; closed = false;
      send(raw: string) { this.sent.push(JSON.parse(raw)); }
      close() { this.closed = true; this.readyState = 3; }
    }
    const matchmaker = new Matchmaker(new MemoryStateStore()); cleanup.push(() => matchmaker.shutdown());
    const sockets = [new Socket(), new Socket()];
    for (const [index, socket] of sockets.entries()) matchmaker.register({ playerId: `human-${index}`, displayName: `Human ${index}`, socket });
    for (const index of [0, 1]) matchmaker.handle(`human-${index}`, { type: "queue.join", playerCount: 2 });
    const started = sockets[0]!.sent.find((message) => message.type === "game.started");
    const actor = started.currentPlayerId as string;
    matchmaker.handle(actor, { type: "game.draw", gameId: started.gameId, commandId: randomUUID(), expectedRevision: started.revision, source: "stock" });
    const drawn = matchmaker.agentView(actor)!;
    expect(drawn.hand).toHaveLength(14);
    matchmaker.handle(actor, { type: "game.discard", gameId: started.gameId, commandId: randomUUID(), expectedRevision: drawn.state.revision, cardId: drawn.hand.at(-1)!.id });
    expect(matchmaker.agentView(actor)!.hand).toHaveLength(13);
    expect(sockets.every((socket) => !socket.closed)).toBe(true);
    expect(repository.detail).toHaveBeenCalledTimes(20);

    stalled = false;
    for (const [name, resolve] of waiting) resolve(detail(name));
    await vi.advanceTimersByTimeAsync(0);
    publishComment = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(repository.detail).toHaveBeenCalledTimes(40);
    for (const name of names) expect(service.viewerCount(name)).toBe(9);
    for (const release of disconnect) release();
    const calls = repository.detail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(repository.detail).toHaveBeenCalledTimes(calls);
    for (const name of names) expect(service.viewerCount(name)).toBe(0);
    service.dispose();
    expect(sockets.every((socket) => !socket.closed)).toBe(true);
    await matchmaker.flush();
  });

  it("enforces the default three-tab account cap across games and reclaims slots on disconnect", async () => {
    vi.useFakeTimers();
    const repository = { detail: vi.fn(async (name: string) => detail(name)) };
    const service = new BroadcastService(repository); cleanup.push(() => service.dispose());
    const sent: BroadcastEvent[] = [];
    const release = service.subscribe("first", "one-account", (event) => { sent.push(event); return true; }, async () => true);
    service.subscribe("second", "one-account", () => true, async () => true);
    service.subscribe("third", "one-account", () => true, async () => true);
    expect(() => service.subscribe("fourth", "one-account", () => true, async () => true)).toThrow("limit");
    release();
    expect(() => service.subscribe("fourth", "one-account", () => true, async () => true)).not.toThrow();
    service.dispose();
    expect(() => service.subscribe("fifth", "another-account", () => true, async () => true)).toThrow("stopped");
    expect(service.viewerCount("fourth")).toBe(0);
  });
});
