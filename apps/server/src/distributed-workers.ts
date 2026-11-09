import { performance } from "node:perf_hooks";
import type {
  DistributedRuntimeOperationalMetrics,
  GameOwnershipLease,
  OutboxMessage,
  RecoverableDeadline,
  RecoveredDeadline
} from "./db/distributed-runtime";

type WorkerRuntime = {
  claimOutbox(input: {
    workerId: string;
    leaseDurationMs: number;
    limit?: number;
    now?: Date;
  }): Promise<readonly OutboxMessage[]>;
  markOutboxPublishedBatch(input: {
    outboxIds: readonly string[];
    workerId: string;
    publishedAt?: Date;
  }): Promise<void>;
  rescheduleOutbox(input: {
    outboxId: string;
    workerId: string;
    retryAt: Date;
    error: string;
  }): Promise<void>;
  claimDueDeadlines(input: {
    workerId: string;
    leaseDurationMs: number;
    limit?: number;
    now?: Date;
  }): Promise<readonly RecoverableDeadline[]>;
  claimOrphanedDueDeadlines?(input: {
    workerId: string;
    ownerInstanceId: string;
    protocolVersion: number;
    ownershipLeaseDurationMs: number;
    deadlineLeaseDurationMs: number;
    limit?: number;
    now?: Date;
  }): Promise<readonly RecoveredDeadline[]>;
  readOperationalMetrics?(now?: Date): Promise<DistributedRuntimeOperationalMetrics>;
  renewOwnership(input: {
    matchId: string;
    ownerInstanceId: string;
    fencingToken: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<GameOwnershipLease>;
  renewOwnershipBatch(input: {
    ownerInstanceId: string;
    leases: readonly { matchId: string; fencingToken: number }[];
    leaseDurationMs: number;
    now?: Date;
  }): Promise<readonly GameOwnershipLease[]>;
  beginDraining(input: { ownerInstanceId: string; now?: Date }): Promise<number>;
  expireOwnedLeases(input: { ownerInstanceId: string; now?: Date }): Promise<number>;
};

type WorkerTransport = {
  publishEvent(input: {
    matchId: string;
    outboxId: string;
    eventSequence: number;
    topic: string;
    routingKey: string;
    eventPayload: Readonly<Record<string, unknown>>;
    deliverySemantics: "committed-event-log";
    ownershipFenceAtCommit: number;
  }): Promise<number>;
  routeDeadline(input: {
    matchId: string;
    fencingToken: number;
    targetInstanceId: string;
    deadlineType: "turn" | "showdown";
    expectedRevision: number;
    deadlinePayload: Readonly<Record<string, unknown>>;
  }): Promise<number>;
};

type WorkerCoordination = Readonly<{
  ownerInstanceId: string;
  protocolVersion: number;
  ownershipLeaseDurationMs: number;
  onOwnershipRecovered(lease: GameOwnershipLease): void;
  observeOperationalMetrics(metrics: DistributedRuntimeOperationalMetrics): void;
  metricsIntervalMs?: number;
}>;

export const distributedRuntimeWorkerIntervalMs = 100;
// Leave most of the ten-connection production pool available for gameplay
// commits while each task drains independent matches in parallel.
export const distributedRuntimeOutboxConcurrency = 4;
// Bound the cross-match acknowledgement barrier. This preserves most of the
// WAL/commit savings from batching without coupling the successor event for as
// many as 100 independent games to the slowest publication in a worker pass.
export const distributedRuntimeOutboxAckBatchSize = 16;

export class DistributedRuntimeWorkers {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private schedulerGeneration = 0;
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  private lastMetricsAt = Number.NEGATIVE_INFINITY;
  private activeRun: Promise<void> | null = null;
  private readonly observedRunFailures = new WeakSet<Promise<void>>();
  private readonly outboxConcurrency: number;
  private readonly outboxAckBatchSize: number;

  constructor(
    private readonly runtime: WorkerRuntime,
    private readonly transport: WorkerTransport,
    private readonly workerId: string,
    private readonly reportError: (error: unknown) => void,
    private readonly intervalMs = distributedRuntimeWorkerIntervalMs,
    private readonly leaseDurationMs = 10_000,
    private readonly coordination?: WorkerCoordination,
    outboxConcurrency = distributedRuntimeOutboxConcurrency,
    outboxAckBatchSize = distributedRuntimeOutboxAckBatchSize
  ) {
    this.outboxConcurrency = Math.max(1, Math.min(32, Math.trunc(outboxConcurrency)));
    this.outboxAckBatchSize = Math.max(1, Math.min(100, Math.trunc(outboxAckBatchSize)));
  }

  runOnce(now?: Date): Promise<void> {
    if (this.activeRun) return this.activeRun;
    // Once shutdown draining begins, only the pass that was already active is
    // allowed to finish. A later caller cannot reopen Valkey/Postgres work
    // behind the lifecycle owner's dependency-close fence.
    if (this.draining) return Promise.resolve();
    const activeRun = this.performRunOnce(now).finally(() => {
      if (this.activeRun === activeRun) this.activeRun = null;
    });
    this.activeRun = activeRun;
    return activeRun;
  }

  private async performRunOnce(now?: Date): Promise<void> {
    const observedAt = now ?? new Date();
    const messages = await this.runtime.claimOutbox({
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      limit: 100,
      ...(now ? { now } : {})
    });
    await this.publishOutbox(messages, observedAt, now);

    if (this.coordination && this.runtime.claimOrphanedDueDeadlines) {
      const recovered = await this.runtime.claimOrphanedDueDeadlines({
        workerId: this.workerId,
        ownerInstanceId: this.coordination.ownerInstanceId,
        protocolVersion: this.coordination.protocolVersion,
        ownershipLeaseDurationMs: this.coordination.ownershipLeaseDurationMs,
        deadlineLeaseDurationMs: this.leaseDurationMs,
        limit: 100,
        ...(now ? { now } : {})
      });
      for (const recovery of recovered) {
        try {
          this.coordination.onOwnershipRecovered(recovery.lease);
          await this.routeDeadline(recovery.deadline);
        } catch (error) {
          // The deadline claim and recovered ownership remain fenced. If this
          // instance cannot accept the lease, both leases expire and another
          // healthy worker takes over without player activity.
          this.reportError(error);
        }
      }
    }

    const deadlines = await this.runtime.claimDueDeadlines({
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      limit: 100,
      ...(now ? { now } : {})
    });
    for (const deadline of deadlines) {
      try {
        await this.routeDeadline(deadline);
      } catch (error) {
        // The claim is deliberately not acknowledged. Its lease expires and a
        // worker redelivers; the owner deduplicates by fence + revision.
        this.reportError(error);
      }
    }

    const metricsIntervalMs = this.coordination?.metricsIntervalMs ?? 5_000;
    if (this.coordination && this.runtime.readOperationalMetrics
      && observedAt.getTime() - this.lastMetricsAt >= metricsIntervalMs) {
      this.lastMetricsAt = observedAt.getTime();
      this.coordination.observeOperationalMetrics(await this.runtime.readOperationalMetrics(now));
    }
  }

  private async publishOutbox(
    messages: readonly OutboxMessage[],
    observedAt: Date,
    publishedAt?: Date
  ): Promise<void> {
    const byMatch = new Map<string, OutboxMessage[]>();
    for (const message of messages) {
      const match = byMatch.get(message.matchId) ?? [];
      match.push(message);
      byMatch.set(message.matchId, match);
    }
    const matches = [...byMatch.values()].map((match) =>
      match.sort((left, right) => left.eventSequence - right.eventSequence)
    );
    for (let offset = 0; offset < matches.length; offset += this.outboxAckBatchSize) {
      const matchBatch = matches.slice(offset, offset + this.outboxAckBatchSize);
      const publishedOutboxIds = new Set<string>();
      let nextMatch = 0;
      const publishNextMatch = async () => {
        while (nextMatch < matchBatch.length) {
          const match = matchBatch[nextMatch++]!;
          for (const message of match) {
            if (!await this.publishOutboxMessage(message, observedAt)) break;
            publishedOutboxIds.add(message.outboxId);
          }
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(this.outboxConcurrency, matchBatch.length) },
        publishNextMatch
      ));

      const acknowledgedOutboxIds = messages
        .filter(({ outboxId }) => publishedOutboxIds.has(outboxId))
        .map(({ outboxId }) => outboxId);
      if (acknowledgedOutboxIds.length > 0) {
        // Claims expose at most one ready row per match. Publishing remains
        // sequential inside each match, while bounded cross-match updates
        // avoid per-event commits without a 100-match acknowledgement fence.
        await this.runtime.markOutboxPublishedBatch({
          outboxIds: acknowledgedOutboxIds,
          workerId: this.workerId,
          ...(publishedAt ? { publishedAt } : {})
        });
      }
    }
  }

  private async publishOutboxMessage(
    message: OutboxMessage,
    observedAt: Date
  ): Promise<boolean> {
    try {
      const receivers = await this.transport.publishEvent({
        matchId: message.matchId,
        outboxId: message.outboxId,
        eventSequence: message.eventSequence,
        topic: message.topic,
        routingKey: message.routingKey,
        eventPayload: message.payload,
        deliverySemantics: "committed-event-log",
        ownershipFenceAtCommit: message.fencingToken
      });
      if (receivers < 1) throw new Error("The durable event had no active Valkey subscribers.");
      return true;
    } catch (error) {
      const exponent = Math.min(message.publishAttempts, 8);
      try {
        await this.runtime.rescheduleOutbox({
          outboxId: message.outboxId,
          workerId: this.workerId,
          retryAt: new Date(observedAt.getTime() + 250 * (2 ** exponent)),
          error: error instanceof Error ? error.message : "Unknown outbox publish error"
        });
      } catch (rescheduleError) {
        this.reportError(rescheduleError);
      }
      this.reportError(error);
      return false;
    }
  }

  private async routeDeadline(deadline: RecoverableDeadline): Promise<void> {
    const receivers = await this.transport.routeDeadline({
      matchId: deadline.matchId,
      fencingToken: deadline.fencingToken,
      targetInstanceId: deadline.ownerInstanceId,
      deadlineType: deadline.type,
      expectedRevision: deadline.expectedRevision,
      deadlinePayload: deadline.payload
    });
    if (receivers < 1) throw new Error("The game deadline owner had no active Valkey subscriber.");
  }

  private observeRunFailure(activeRun: Promise<void>, error: unknown): void {
    if (this.observedRunFailures.has(activeRun)) return;
    this.observedRunFailures.add(activeRun);
    this.reportError(error);
  }

  start(): void {
    if (!this.stopped || this.drainPromise) return;
    this.draining = false;
    this.stopped = false;
    const generation = ++this.schedulerGeneration;
    const schedule = (delayMs: number) => {
      if (this.stopped || generation !== this.schedulerGeneration) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.stopped || generation !== this.schedulerGeneration) return;
        const startedAt = performance.now();
        const activeRun = this.runOnce();
        void activeRun.catch((error) => this.observeRunFailure(activeRun, error)).finally(() => {
          const elapsedMs = performance.now() - startedAt;
          // Maintain a start-to-start cadence without ever overlapping runs.
          // An overrun receives one immediate follow-up rather than a burst of
          // accumulated ticks, preserving the pool and ordering bounds.
          schedule(Math.max(0, this.intervalMs - elapsedMs));
        });
      }, delayMs);
      this.timer.unref();
    };
    schedule(this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.draining = true;
    // Invalidate the closure owned by an active pass. Without this epoch, a
    // stop -> start while that pass is running lets the old finally callback
    // schedule a second timer chain after the new generation has started.
    this.schedulerGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    // A generation cannot start another scheduled pass after stop(), but use
    // a loop so a run that was already coalesced when flushing began is also
    // observed before shutdown closes its data-plane dependencies.
    while (this.activeRun) {
      const activeRun = this.activeRun;
      try {
        await activeRun;
      } catch (error) {
        // The work remains durably retryable. Observe the failure once, but do
        // not abort ordered shutdown cleanup and strand open dependencies.
        this.observeRunFailure(activeRun, error);
      }
    }
  }

  drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.draining = true;
    this.stop();
    const drainPromise = this.flush().finally(() => {
      if (this.drainPromise === drainPromise) this.drainPromise = null;
    });
    this.drainPromise = drainPromise;
    return drainPromise;
  }
}

export class GameLeaseSupervisor {
  private readonly leases = new Map<string, GameOwnershipLease>();
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly runtime: Pick<WorkerRuntime, "renewOwnershipBatch" | "beginDraining" | "expireOwnedLeases">,
    readonly instanceId: string,
    private readonly leaseDurationMs: number,
    private readonly onOwnershipLost: (lease: GameOwnershipLease, error: unknown) => void,
    private readonly reportError: (error: unknown) => void
  ) {}

  track(lease: GameOwnershipLease): void {
    if (lease.ownerInstanceId !== this.instanceId) throw new Error("Cannot track another instance's lease.");
    if (this.draining) throw new Error("A draining instance cannot acquire new game leases.");
    this.leases.set(lease.matchId, lease);
  }

  forget(matchId: string): void {
    this.leases.delete(matchId);
  }

  async renewOnce(now?: Date): Promise<void> {
    if (this.draining) return;
    const tracked = [...this.leases.values()];
    if (tracked.length === 0) return;
    for (let offset = 0; offset < tracked.length; offset += 1_000) {
      const chunk = tracked.slice(offset, offset + 1_000);
      let renewed: readonly GameOwnershipLease[];
      try {
        renewed = await this.runtime.renewOwnershipBatch({
          ownerInstanceId: this.instanceId,
          leases: chunk.map(({ matchId, fencingToken }) => ({ matchId, fencingToken })),
          leaseDurationMs: this.leaseDurationMs,
          ...(now ? { now } : {})
        });
      } catch (error) {
        // A database-level failure is not evidence that this chunk was fenced.
        // Retain it for the next tick and continue renewing independent chunks.
        this.reportError(error);
        continue;
      }
      const renewedByMatch = new Map(renewed.map((lease) => [lease.matchId, lease]));
      for (const lease of chunk) {
        const current = renewedByMatch.get(lease.matchId);
        if (current) {
          this.leases.set(lease.matchId, current);
        } else {
          this.leases.delete(lease.matchId);
          this.onOwnershipLost(lease, new Error("The ownership lease was fenced or expired."));
        }
      }
    }
  }

  start(): void {
    if (this.timer || this.draining) return;
    const tick = () => {
      if (this.draining) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.renewOnce().catch(this.reportError).finally(tick);
      }, Math.max(250, Math.trunc(this.leaseDurationMs / 3)));
      this.timer.unref();
    };
    tick();
  }

  async drain(now = new Date()): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.runtime.beginDraining({ ownerInstanceId: this.instanceId, now });
    await this.runtime.expireOwnedLeases({ ownerInstanceId: this.instanceId, now });
    this.leases.clear();
  }

  get isDraining(): boolean {
    return this.draining;
  }
}
