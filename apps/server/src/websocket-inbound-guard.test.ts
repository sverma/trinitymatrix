import { describe, expect, it, vi } from "vitest";
import { WebSocketInboundGuard } from "./websocket-inbound-guard";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("WebSocketInboundGuard", () => {
  it("rejects a message flood when the token bucket is empty", () => {
    const guard = new WebSocketInboundGuard({
      messagesPerSecond: 2,
      burst: 2,
      maxBufferedMessages: 10,
      now: () => 0
    });

    const results = Array.from({ length: 100 }, () => guard.enqueue(() => undefined));
    expect(results.filter((result) => result === "accepted")).toHaveLength(2);
    expect(results.filter((result) => result === "rate-limited")).toHaveLength(98);
  });

  it("refills tokens over time without a per-connection timer", async () => {
    let now = 1_000;
    const handled = vi.fn();
    const guard = new WebSocketInboundGuard({
      messagesPerSecond: 2,
      burst: 2,
      maxBufferedMessages: 10,
      now: () => now
    });

    expect(guard.enqueue(handled)).toBe("accepted");
    expect(guard.enqueue(handled)).toBe("accepted");
    expect(guard.enqueue(handled)).toBe("rate-limited");
    now += 500;
    expect(guard.enqueue(handled)).toBe("accepted");
    await flush();
    expect(handled).toHaveBeenCalledTimes(3);
  });

  it("does not create refill credit when the clock moves backwards", () => {
    let now = 1_000;
    const guard = new WebSocketInboundGuard({
      messagesPerSecond: 1,
      burst: 1,
      maxBufferedMessages: 10,
      now: () => now
    });

    expect(guard.enqueue(() => undefined)).toBe("accepted");
    now = 500;
    expect(guard.enqueue(() => undefined)).toBe("rate-limited");
    now = 1_000;
    expect(guard.enqueue(() => undefined)).toBe("rate-limited");
    now = 2_000;
    expect(guard.enqueue(() => undefined)).toBe("accepted");
  });

  it("serializes work and enforces the total active-plus-queued bound", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started: number[] = [];
    const guard = new WebSocketInboundGuard({
      messagesPerSecond: 100,
      burst: 100,
      maxBufferedMessages: 3,
      now: () => 0
    });

    expect(guard.enqueue(async () => {
      started.push(1);
      await firstBlocked;
    })).toBe("accepted");
    expect(guard.enqueue(() => { started.push(2); })).toBe("accepted");
    expect(guard.enqueue(() => { started.push(3); })).toBe("accepted");
    expect(guard.bufferedMessages).toBe(3);
    expect(guard.enqueue(() => { started.push(4); })).toBe("backpressure");
    expect(started).toEqual([1]);

    releaseFirst();
    await flush();
    expect(started).toEqual([1, 2, 3]);
    expect(guard.bufferedMessages).toBe(0);
  });

  it("drops queued work and rejects future work during socket cleanup", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const queued = vi.fn();
    const guard = new WebSocketInboundGuard({
      messagesPerSecond: 100,
      burst: 100,
      maxBufferedMessages: 3,
      now: () => 0
    });

    expect(guard.enqueue(() => firstBlocked)).toBe("accepted");
    expect(guard.enqueue(queued)).toBe("accepted");
    guard.close();
    expect(guard.enqueue(queued)).toBe("closed");

    releaseFirst();
    await flush();
    expect(queued).not.toHaveBeenCalled();
    expect(guard.bufferedMessages).toBe(0);
  });

  it("contains task failures and continues draining serialized work", async () => {
    const onTaskError = vi.fn();
    const next = vi.fn();
    const guard = new WebSocketInboundGuard({
      messagesPerSecond: 100,
      burst: 100,
      maxBufferedMessages: 3,
      onTaskError,
      now: () => 0
    });

    guard.enqueue(() => { throw new Error("failed"); });
    guard.enqueue(next);
    await flush();

    expect(onTaskError).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
