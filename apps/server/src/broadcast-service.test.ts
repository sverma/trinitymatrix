import { afterEach, describe, expect, it, vi } from "vitest";
import type { BroadcastEvent } from "@trinitymatrix/protocol";
import type { BroadcastDetail } from "./broadcast-repository";
import { BroadcastService } from "./broadcast-service";

const detail: BroadcastDetail = {
  broadcast: { gameName: "amber-lotus-12345678", gameId: "00000000-0000-4000-8000-000000000001", title: "Table", playerCount: 2, composition: "human", players: [],
    status: "buffering", delayMs: 120_000, availableAt: 120_000, viewerCount: 0 }, frame: null, comments: []
};
describe("shared spectator polling", () => {
  const services: BroadcastService[] = [];
  afterEach(() => { services.forEach((service) => service.dispose()); services.length = 0; vi.useRealTimers(); });
  function fixture(options: ConstructorParameters<typeof BroadcastService>[1] = {}) {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const repository = { detail: vi.fn(async () => detail as BroadcastDetail | null) };
    const service = new BroadcastService(repository, options); services.push(service);
    return { repository, service };
  }

  it("shares one poll across tabs and counts distinct authenticated viewers", async () => {
    const { repository, service } = fixture();
    const first = vi.fn(() => true); const second = vi.fn(() => true); const third = vi.fn(() => true);
    const release = service.subscribe("table", "user-a", first, async () => true);
    service.subscribe("table", "user-a", second, async () => true);
    service.subscribe("table", "user-b", third, async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.detail).toHaveBeenCalledTimes(1);
    expect(service.viewerCount("table")).toBe(2);
    expect(first).toHaveBeenLastCalledWith({ type: "viewers", viewerCount: 2 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.detail).toHaveBeenCalledTimes(2);
    release(); expect(service.viewerCount("table")).toBe(2);
  });

  it("disconnects revoked sessions without a gameplay connection", async () => {
    const { repository, service } = fixture({ authIntervalMs: 2_000 });
    const events: BroadcastEvent[] = []; let valid = true;
    service.subscribe("table", "user", (event) => { events.push(event); return true; }, async () => valid);
    await vi.advanceTimersByTimeAsync(1_000);
    valid = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.at(-1)).toMatchObject({ type: "closed", code: "auth-required", reason: expect.stringContaining("Authentication") });
    expect(service.viewerCount("table")).toBe(0);
    const calls = repository.detail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repository.detail).toHaveBeenCalledTimes(calls);
  });

  it("bounds subscribers and removes a backpressured client without leaving polling timers", async () => {
    const { repository, service } = fixture({ maxWatchers: 2, maxPerUser: 1 });
    service.subscribe("table", "slow", () => false, async () => true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repository.detail).not.toHaveBeenCalled();
    service.subscribe("table", "a", () => true, async () => true);
    expect(() => service.subscribe("other", "a", () => true, async () => true)).toThrow("limit");
    service.subscribe("table", "b", () => true, async () => true);
    expect(() => service.subscribe("table", "c", () => true, async () => true)).toThrow("limit");
  });

  it("never overlaps a slow poll and ignores its completion after immediate closure", async () => {
    const { repository, service } = fixture();
    let release!: (value: BroadcastDetail) => void;
    repository.detail.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const send = vi.fn<(event: BroadcastEvent) => boolean>(() => true);
    service.subscribe("table", "a", send, async () => true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repository.detail).toHaveBeenCalledTimes(1);
    service.close("table");
    const count = send.mock.calls.length;
    release(detail); await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(count);
    expect(send).toHaveBeenLastCalledWith({ type: "closed", code: "closed", reason: expect.stringContaining("ended") });
  });

  it("emits comment deletions and changed frames once without replaying unchanged pages", async () => {
    const { repository, service } = fixture();
    const comment = { id: "comment", playerId: "player", displayName: "Viewer", message: "Hello", createdAt: 1, releasedAt: 1, deleted: false };
    repository.detail.mockResolvedValue({ ...detail, comments: [comment] });
    const send = vi.fn<(event: BroadcastEvent) => boolean>(() => true);
    service.subscribe("table", "a", send, async () => true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send.mock.calls.filter(([event]) => event.type === "comment")).toHaveLength(1);
    repository.detail.mockResolvedValue({ ...detail, comments: [{ ...comment, message: "", deleted: true }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send.mock.calls.filter(([event]) => event.type === "comment")).toHaveLength(2);
  });

  it("distinguishes restart and temporary storage failures from permanent broadcast withdrawal", async () => {
    const { repository, service } = fixture();
    const restart = vi.fn<(event: BroadcastEvent) => boolean>(() => true);
    service.subscribe("restart", "user", restart, async () => true);
    await vi.advanceTimersByTimeAsync(0);
    service.dispose();
    expect(restart).toHaveBeenLastCalledWith({ type: "closed", code: "restart", reason: expect.stringContaining("restarting") });
    const retrying = new BroadcastService(repository); services.push(retrying);
    repository.detail.mockRejectedValue(new Error("private database error"));
    const unavailable = vi.fn<(event: BroadcastEvent) => boolean>(() => true);
    retrying.subscribe("database", "user", unavailable, async () => true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(unavailable).toHaveBeenLastCalledWith({ type: "closed", code: "unavailable", reason: expect.stringContaining("temporarily") });
    repository.detail.mockResolvedValue(null);
    const withdrawn = vi.fn<(event: BroadcastEvent) => boolean>(() => true);
    retrying.subscribe("withdrawn", "user", withdrawn, async () => true);
    await vi.advanceTimersByTimeAsync(0);
    expect(withdrawn).toHaveBeenLastCalledWith({ type: "closed", code: "closed", reason: expect.stringContaining("no longer") });
  });
});
