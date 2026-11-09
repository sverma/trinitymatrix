import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameOwnershipLease } from "./db/distributed-runtime";
import {
  DistributedRuntimeWorkers,
  distributedRuntimeWorkerIntervalMs,
  distributedRuntimeOutboxAckBatchSize,
  GameLeaseSupervisor
} from "./distributed-workers";

const ids = {
  match: "00000000-0000-4000-8000-000000000001",
  outbox: "00000000-0000-4000-8000-000000000002"
} as const;
const now = new Date("2026-08-29T12:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function useWorkerFakeTimers(): void {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(performance, "now").mockImplementation(() => Date.now() - now.getTime());
}

describe("distributed runtime workers", () => {
  it("publishes and acknowledges outbox rows, then routes claimed deadlines", async () => {
    const runtime = {
      claimOutbox: vi.fn(async () => [{
        outboxId: ids.outbox,
        matchId: ids.match,
        eventSequence: 2,
        fencingToken: 7,
        topic: "game.event",
        routingKey: ids.match,
        payload: { state: { revision: 2 } },
        publishAttempts: 1
      }]),
      markOutboxPublishedBatch: vi.fn(async () => undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimDueDeadlines: vi.fn(async () => [{
        matchId: ids.match,
        type: "turn" as const,
        dueAt: now,
        expectedRevision: 2,
        fencingToken: 7,
        payload: { matchId: ids.match },
        ownerInstanceId: "app-a"
      }]),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const transport = {
      publishEvent: vi.fn(async () => 2),
      routeDeadline: vi.fn(async () => 1)
    };
    const worker = new DistributedRuntimeWorkers(runtime, transport, "worker-a", vi.fn());

    await worker.runOnce(now);

    expect(transport.publishEvent).toHaveBeenCalledWith(expect.objectContaining({
      outboxId: ids.outbox,
      eventSequence: 2,
      deliverySemantics: "committed-event-log",
      ownershipFenceAtCommit: 7
    }));
    expect(runtime.markOutboxPublishedBatch).toHaveBeenCalledWith({
      outboxIds: [ids.outbox],
      workerId: "worker-a",
      publishedAt: now
    });
    expect(transport.routeDeadline).toHaveBeenCalledWith(expect.objectContaining({
      targetInstanceId: "app-a",
      fencingToken: 7,
      expectedRevision: 2
    }));
  });

  it("reschedules a failed outbox publish without acknowledging it", async () => {
    const failure = new Error("Valkey unavailable");
    const runtime = {
      claimOutbox: vi.fn(async () => [{
        outboxId: ids.outbox,
        matchId: ids.match,
        eventSequence: 2,
        fencingToken: 7,
        topic: "game.event",
        routingKey: ids.match,
        payload: {},
        publishAttempts: 2
      }]),
      markOutboxPublishedBatch: vi.fn(async () => undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const report = vi.fn();
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(async () => { throw failure; }),
      routeDeadline: vi.fn()
    }, "worker-a", report);

    await worker.runOnce(now);

    expect(runtime.markOutboxPublishedBatch).not.toHaveBeenCalled();
    expect(runtime.rescheduleOutbox).toHaveBeenCalledWith({
      outboxId: ids.outbox,
      workerId: "worker-a",
      retryAt: new Date(now.getTime() + 1_000),
      error: "Valkey unavailable"
    });
    expect(report).toHaveBeenCalledWith(failure);
  });

  it("batch-acknowledges successful matches while rescheduling a failed match without publishing its successor", async () => {
    const matchA = "00000000-0000-4000-8000-000000000010";
    const matchB = "00000000-0000-4000-8000-000000000020";
    const messages = [
      {
        outboxId: "00000000-0000-4000-8000-000000000011",
        matchId: matchA,
        eventSequence: 1,
        fencingToken: 7,
        topic: "game.event",
        routingKey: matchA,
        payload: { eventSequence: 1 },
        publishAttempts: 1
      },
      {
        outboxId: "00000000-0000-4000-8000-000000000012",
        matchId: matchA,
        eventSequence: 2,
        fencingToken: 7,
        topic: "game.event",
        routingKey: matchA,
        payload: { eventSequence: 2 },
        publishAttempts: 1
      },
      {
        outboxId: "00000000-0000-4000-8000-000000000021",
        matchId: matchB,
        eventSequence: 1,
        fencingToken: 8,
        topic: "game.event",
        routingKey: matchB,
        payload: { eventSequence: 1 },
        publishAttempts: 1
      }
    ] as const;
    const runtime = {
      claimOutbox: vi.fn(async () => messages),
      markOutboxPublishedBatch: vi.fn(async () => undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const publishFailure = new Error("Valkey publish failed");
    const publishEvent = vi.fn(async ({ outboxId }: { outboxId: string }) => {
      if (outboxId === messages[0].outboxId) throw publishFailure;
      return 1;
    });
    const report = vi.fn();
    const worker = new DistributedRuntimeWorkers(
      runtime,
      { publishEvent, routeDeadline: vi.fn() },
      "worker-a",
      report,
      distributedRuntimeWorkerIntervalMs,
      10_000,
      undefined,
      2
    );

    await worker.runOnce(now);

    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({ outboxId: messages[0].outboxId }));
    expect(publishEvent).not.toHaveBeenCalledWith(expect.objectContaining({ outboxId: messages[1].outboxId }));
    expect(publishEvent).toHaveBeenCalledWith(expect.objectContaining({ outboxId: messages[2].outboxId }));
    expect(runtime.rescheduleOutbox).toHaveBeenCalledWith({
      outboxId: messages[0].outboxId,
      workerId: "worker-a",
      retryAt: new Date(now.getTime() + 500),
      error: publishFailure.message
    });
    expect(runtime.markOutboxPublishedBatch).toHaveBeenCalledWith({
      outboxIds: [messages[2].outboxId],
      workerId: "worker-a",
      publishedAt: now
    });
    expect(report).toHaveBeenCalledWith(publishFailure);
  });

  it("leaves a successfully published batch leased for at-least-once retry when its acknowledgement fails", async () => {
    const message = {
      outboxId: ids.outbox,
      matchId: ids.match,
      eventSequence: 2,
      fencingToken: 7,
      topic: "game.event",
      routingKey: ids.match,
      payload: { state: { revision: 2 } },
      publishAttempts: 1
    } as const;
    const acknowledgementFailure = new Error("PostgreSQL acknowledgement unavailable");
    const runtime = {
      claimOutbox: vi.fn(async () => [message]),
      markOutboxPublishedBatch: vi.fn()
        .mockRejectedValueOnce(acknowledgementFailure)
        .mockResolvedValueOnce(undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const publishEvent = vi.fn(async () => 1);
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent,
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    await expect(worker.runOnce(now)).rejects.toBe(acknowledgementFailure);
    expect(runtime.rescheduleOutbox).not.toHaveBeenCalled();

    await expect(worker.runOnce(new Date(now.getTime() + 10_001))).resolves.toBeUndefined();
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(runtime.markOutboxPublishedBatch).toHaveBeenCalledTimes(2);
    expect(runtime.rescheduleOutbox).not.toHaveBeenCalled();
  });

  it("preserves event order per match while publishing different matches with bounded concurrency", async () => {
    const matchA = "00000000-0000-4000-8000-000000000010";
    const matchB = "00000000-0000-4000-8000-000000000020";
    const matchC = "00000000-0000-4000-8000-000000000030";
    const outbox = (matchId: string, eventSequence: number) => ({
      outboxId: `${matchId.slice(0, -4)}${matchId.slice(-2)}${String(eventSequence).padStart(2, "0")}`,
      matchId,
      eventSequence,
      fencingToken: 7,
      topic: "game.event",
      routingKey: matchId,
      payload: { eventSequence },
      publishAttempts: 1
    });
    const runtime = {
      claimOutbox: vi.fn(async () => [
        outbox(matchA, 2),
        outbox(matchB, 1),
        outbox(matchA, 1),
        outbox(matchC, 1)
      ]),
      markOutboxPublishedBatch: vi.fn(async () => undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    let activePublishes = 0;
    let peakPublishes = 0;
    const started: Array<{ matchId: string; eventSequence: number }> = [];
    const publishEvent = vi.fn(async (input: { matchId: string; eventSequence: number }) => {
      activePublishes += 1;
      peakPublishes = Math.max(peakPublishes, activePublishes);
      started.push(input);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      activePublishes -= 1;
      return 1;
    });
    const worker = new DistributedRuntimeWorkers(
      runtime,
      { publishEvent, routeDeadline: vi.fn() },
      "worker-a",
      vi.fn(),
      distributedRuntimeWorkerIntervalMs,
      10_000,
      undefined,
      2
    );

    await worker.runOnce(now);

    expect(peakPublishes).toBe(2);
    expect(started.filter(({ matchId }) => matchId === matchA).map(({ eventSequence }) => eventSequence))
      .toEqual([1, 2]);
    expect(runtime.markOutboxPublishedBatch).toHaveBeenCalledOnce();
    expect(runtime.markOutboxPublishedBatch).toHaveBeenCalledWith({
      outboxIds: [
        outbox(matchA, 2).outboxId,
        outbox(matchB, 1).outboxId,
        outbox(matchA, 1).outboxId,
        outbox(matchC, 1).outboxId
      ],
      workerId: "worker-a",
      publishedAt: now
    });
    expect(runtime.rescheduleOutbox).not.toHaveBeenCalled();
  });

  it("acknowledges independent matches in bounded batches", async () => {
    const messages = Array.from({ length: distributedRuntimeOutboxAckBatchSize + 1 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      const matchId = `00000000-0000-4000-8000-${suffix}`;
      return {
        outboxId: `10000000-0000-4000-8000-${suffix}`,
        matchId,
        eventSequence: 1,
        fencingToken: 7,
        topic: "game.event",
        routingKey: matchId,
        payload: { index },
        publishAttempts: 1
      };
    });
    const runtime = {
      claimOutbox: vi.fn(async () => messages),
      markOutboxPublishedBatch: vi.fn(async () => undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(async () => 1),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    await worker.runOnce(now);

    expect(runtime.markOutboxPublishedBatch).toHaveBeenCalledTimes(2);
    expect(runtime.markOutboxPublishedBatch).toHaveBeenNthCalledWith(1, {
      outboxIds: messages.slice(0, distributedRuntimeOutboxAckBatchSize).map(({ outboxId }) => outboxId),
      workerId: "worker-a",
      publishedAt: now
    });
    expect(runtime.markOutboxPublishedBatch).toHaveBeenNthCalledWith(2, {
      outboxIds: [messages.at(-1)!.outboxId],
      workerId: "worker-a",
      publishedAt: now
    });
  });

  it("coalesces overlapping run requests into one worker pass", async () => {
    let releaseClaim!: (messages: []) => void;
    const claimOutbox = vi.fn()
      .mockImplementationOnce(() => new Promise<[]>((resolve) => { releaseClaim = resolve; }))
      .mockResolvedValue([]);
    const runtime = {
      claimOutbox,
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    const first = worker.runOnce(now);
    const overlapping = worker.runOnce(new Date(now.getTime() + 1));

    expect(overlapping).toBe(first);
    expect(claimOutbox).toHaveBeenCalledOnce();
    releaseClaim([]);
    await Promise.all([first, overlapping]);

    await worker.runOnce(new Date(now.getTime() + 2));
    expect(claimOutbox).toHaveBeenCalledTimes(2);
  });

  it("maintains a 100ms start-to-start cadence after a 30ms pass", async () => {
    useWorkerFakeTimers();
    const startedAt: number[] = [];
    const runtime = {
      claimOutbox: vi.fn(async () => {
        startedAt.push(Date.now() - now.getTime());
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        return [];
      }),
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(startedAt).toEqual([100]);
    await vi.advanceTimersByTimeAsync(99);
    expect(startedAt).toEqual([100]);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toEqual([100, 200]);

    worker.stop();
    await vi.advanceTimersByTimeAsync(30);
  });

  it("runs one immediate non-overlapping pass after a 150ms overrun", async () => {
    useWorkerFakeTimers();
    const startedAt: number[] = [];
    let activeRuns = 0;
    let peakActiveRuns = 0;
    const runtime = {
      claimOutbox: vi.fn(async () => {
        startedAt.push(Date.now() - now.getTime());
        activeRuns += 1;
        peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        activeRuns -= 1;
        return [];
      }),
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    worker.start();
    await vi.advanceTimersByTimeAsync(249);
    expect(startedAt).toEqual([100]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    expect(startedAt).toEqual([100, 251]);
    expect(peakActiveRuns).toBe(1);

    worker.stop();
    await vi.advanceTimersByTimeAsync(150);
  });

  it("does not accumulate catch-up ticks after a multi-interval overrun", async () => {
    useWorkerFakeTimers();
    const startedAt: number[] = [];
    const runtime = {
      claimOutbox: vi.fn(async () => {
        startedAt.push(Date.now() - now.getTime());
        if (startedAt.length === 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 350));
        }
        return [];
      }),
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    worker.start();
    await vi.advanceTimersByTimeAsync(450);
    await vi.advanceTimersToNextTimerAsync();
    expect(startedAt).toEqual([100, 451]);
    await vi.advanceTimersByTimeAsync(99);
    expect(startedAt).toEqual([100, 451]);
    await vi.advanceTimersByTimeAsync(1);
    expect(startedAt).toEqual([100, 451, 551]);

    worker.stop();
  });

  it("does not reschedule when stopped during an active pass", async () => {
    useWorkerFakeTimers();
    const startedAt: number[] = [];
    const runtime = {
      claimOutbox: vi.fn(async () => {
        startedAt.push(Date.now() - now.getTime());
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        return [];
      }),
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    worker.start();
    await vi.advanceTimersByTimeAsync(110);
    expect(startedAt).toEqual([100]);
    worker.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(startedAt).toEqual([100]);
  });

  it("invalidates the old scheduler generation when restarted during an active pass", async () => {
    useWorkerFakeTimers();
    let releaseClaim!: (messages: []) => void;
    const claimOutbox = vi.fn()
      .mockImplementationOnce(() => new Promise<[]>((resolve) => { releaseClaim = resolve; }))
      .mockResolvedValue([]);
    const runtime = {
      claimOutbox,
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(claimOutbox).toHaveBeenCalledOnce();

    worker.stop();
    worker.start();
    releaseClaim([]);
    await vi.advanceTimersByTimeAsync(0);

    // The new generation owns the only timer. The old pass must not schedule
    // another chain from its finally callback after restart.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(claimOutbox).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(claimOutbox).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it("drains an active pass before dependency close and prevents post-stop work", async () => {
    useWorkerFakeTimers();
    const lifecycle: string[] = [];
    let releaseClaim!: (messages: []) => void;
    const claimOutbox = vi.fn()
      .mockImplementationOnce(() => new Promise<[]>((resolve) => {
        lifecycle.push("worker-pass-started");
        releaseClaim = resolve;
      }))
      .mockResolvedValue([]);
    const runtime = {
      claimOutbox,
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => {
        lifecycle.push("worker-pass-finished");
        return [];
      }),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", vi.fn());

    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    const shutdown = (async () => {
      await worker.drain();
      lifecycle.push("valkey-closed");
      lifecycle.push("postgres-closed");
    })();

    expect(lifecycle).toEqual(["worker-pass-started"]);
    expect(claimOutbox).toHaveBeenCalledOnce();
    const coalescedDuringDrain = worker.runOnce();
    expect(claimOutbox).toHaveBeenCalledOnce();

    releaseClaim([]);
    await Promise.all([shutdown, coalescedDuringDrain]);
    expect(lifecycle).toEqual([
      "worker-pass-started",
      "worker-pass-finished",
      "valkey-closed",
      "postgres-closed"
    ]);

    await worker.runOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claimOutbox).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes a rejecting active pass once and still drains before dependency close", async () => {
    useWorkerFakeTimers();
    const lifecycle: string[] = [];
    const failure = new Error("PostgreSQL connection ended during worker pass");
    let rejectClaim!: (error: Error) => void;
    const runtime = {
      claimOutbox: vi.fn(() => new Promise<[]>((_, reject) => {
        lifecycle.push("worker-pass-started");
        rejectClaim = reject;
      })),
      markOutboxPublishedBatch: vi.fn(),
      rescheduleOutbox: vi.fn(),
      claimDueDeadlines: vi.fn(async () => []),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const reportError = vi.fn((error: unknown) => {
      expect(error).toBe(failure);
      lifecycle.push("error-observed");
    });
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline: vi.fn()
    }, "worker-a", reportError);

    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    const shutdown = (async () => {
      await worker.drain();
      lifecycle.push("valkey-closed");
      lifecycle.push("postgres-closed");
    })();

    rejectClaim(failure);
    await expect(shutdown).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual([
      "worker-pass-started",
      "error-observed",
      "valkey-closed",
      "postgres-closed"
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers an orphaned due deadline under a new fence without player activity", async () => {
    const recoveredLease: GameOwnershipLease = {
      matchId: ids.match,
      ownerInstanceId: "app-b",
      fencingToken: 8,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
      protocolMin: 1,
      protocolMax: 1,
      draining: false
    };
    const runtimeMetrics = {
      outboxBacklog: 1,
      oldestOutboxAgeMs: 250,
      dueDeadlineCount: 1,
      oldestDeadlineLagMs: 100,
      orphanedGameCount: 0,
      matchmakingQueueDepth: 3,
      oldestMatchmakingQueueAgeMs: 2_000
    };
    const runtime = {
      claimOutbox: vi.fn(async () => []),
      markOutboxPublishedBatch: vi.fn(async () => undefined),
      rescheduleOutbox: vi.fn(async () => undefined),
      claimOrphanedDueDeadlines: vi.fn(async () => [{
        lease: recoveredLease,
        deadline: {
          matchId: ids.match,
          type: "turn" as const,
          dueAt: now,
          expectedRevision: 2,
          fencingToken: 8,
          payload: { matchId: ids.match },
          ownerInstanceId: "app-b"
        }
      }]),
      claimDueDeadlines: vi.fn(async () => []),
      readOperationalMetrics: vi.fn(async () => runtimeMetrics),
      renewOwnership: vi.fn(),
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(),
      expireOwnedLeases: vi.fn()
    };
    const routeDeadline = vi.fn(async () => 1);
    const onOwnershipRecovered = vi.fn();
    const observeOperationalMetrics = vi.fn();
    const worker = new DistributedRuntimeWorkers(runtime, {
      publishEvent: vi.fn(),
      routeDeadline
    }, "worker-b", vi.fn(), 250, 10_000, {
      ownerInstanceId: "app-b",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      onOwnershipRecovered,
      observeOperationalMetrics,
      metricsIntervalMs: 5_000
    });

    await worker.runOnce(now);

    expect(runtime.claimOrphanedDueDeadlines).toHaveBeenCalledWith({
      workerId: "worker-b",
      ownerInstanceId: "app-b",
      protocolVersion: 1,
      ownershipLeaseDurationMs: 30_000,
      deadlineLeaseDurationMs: 10_000,
      limit: 100,
      now
    });
    expect(onOwnershipRecovered).toHaveBeenCalledWith(recoveredLease);
    expect(routeDeadline).toHaveBeenCalledWith(expect.objectContaining({
      targetInstanceId: "app-b",
      fencingToken: 8,
      expectedRevision: 2
    }));
    expect(observeOperationalMetrics).toHaveBeenCalledWith(runtimeMetrics);
  });
});

describe("game lease supervisor", () => {
  const lease: GameOwnershipLease = {
    matchId: ids.match,
    ownerInstanceId: "app-a",
    fencingToken: 7,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    protocolMin: 1,
    protocolMax: 1,
    draining: false
  };

  it("renews tracked fences and evicts ownership immediately on a failed renewal", async () => {
    const lost = vi.fn();
    const runtime = {
      renewOwnershipBatch: vi.fn()
        .mockResolvedValueOnce([{ ...lease, leaseExpiresAt: new Date(now.getTime() + 60_000) }])
        .mockResolvedValueOnce([]),
      beginDraining: vi.fn(async () => 0),
      expireOwnedLeases: vi.fn(async () => 0)
    };
    const supervisor = new GameLeaseSupervisor(runtime, "app-a", 30_000, lost, vi.fn());
    supervisor.track(lease);
    await supervisor.renewOnce(now);
    await supervisor.renewOnce(new Date(now.getTime() + 10_000));
    expect(lost).toHaveBeenCalledWith(expect.objectContaining({ fencingToken: 7 }), expect.any(Error));
    expect(runtime.renewOwnershipBatch).toHaveBeenCalledTimes(2);
    expect(runtime.renewOwnershipBatch).toHaveBeenCalledWith(expect.objectContaining({
      leases: [{ matchId: ids.match, fencingToken: 7 }]
    }));
  });

  it("marks and expires every owned lease during drain and refuses new work", async () => {
    const runtime = {
      renewOwnershipBatch: vi.fn(),
      beginDraining: vi.fn(async () => 1),
      expireOwnedLeases: vi.fn(async () => 1)
    };
    const supervisor = new GameLeaseSupervisor(runtime, "app-a", 30_000, vi.fn(), vi.fn());
    supervisor.track(lease);
    await supervisor.drain(now);
    expect(runtime.beginDraining).toHaveBeenCalledWith({ ownerInstanceId: "app-a", now });
    expect(runtime.expireOwnedLeases).toHaveBeenCalledWith({ ownerInstanceId: "app-a", now });
    expect(supervisor.isDraining).toBe(true);
    expect(() => supervisor.track(lease)).toThrow("draining instance");
  });

  it("renews 1001 games in bounded chunks and continues after one chunk fails", async () => {
    const allLeases = Array.from({ length: 1_001 }, (_, index): GameOwnershipLease => ({
      ...lease,
      matchId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    }));
    const secondChunkLease = allLeases.at(-1)!;
    const firstFailure = new Error("temporary pool failure");
    const runtime = {
      renewOwnershipBatch: vi.fn()
        .mockRejectedValueOnce(firstFailure)
        .mockResolvedValueOnce([secondChunkLease]),
      beginDraining: vi.fn(async () => 0),
      expireOwnedLeases: vi.fn(async () => 0)
    };
    const report = vi.fn();
    const lost = vi.fn();
    const supervisor = new GameLeaseSupervisor(runtime, "app-a", 30_000, lost, report);
    for (const current of allLeases) supervisor.track(current);

    await supervisor.renewOnce(now);

    expect(runtime.renewOwnershipBatch).toHaveBeenCalledTimes(2);
    expect(runtime.renewOwnershipBatch.mock.calls[0]![0].leases).toHaveLength(1_000);
    expect(runtime.renewOwnershipBatch.mock.calls[1]![0].leases).toHaveLength(1);
    expect(report).toHaveBeenCalledWith(firstFailure);
    expect(lost).not.toHaveBeenCalled();
  });
});
