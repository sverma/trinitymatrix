import { createHash, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { DistributedRuntimeOperationalMetrics } from "./db/distributed-runtime";

type DependencyName = "postgres" | "valkey";
type MetricGroupName = DependencyName | "commands";

const latencyBucketBoundsMs = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000] as const;
const measuredValkeyOperations = new Set(["get", "set", "del"]);
const gameCommandTypes = new Set([
  "game.draw",
  "game.discard",
  "game.drop",
  "game.submit-hand",
  "game.declare"
]);

export function isLoadMetricsRequestAuthorized(authorization: string | undefined, expectedToken: string): boolean {
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!supplied) return false;
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

type LatencySnapshot = {
  count: number;
  failures: number;
  throughputPerSecond: number;
  minimumMs: number;
  averageMs: number;
  maximumMs: number;
  p50UpperBoundMs: number;
  p95UpperBoundMs: number;
  p99UpperBoundMs: number;
  cumulativeBuckets: Array<{ upperBoundMs: number | null; count: number }>;
};

export type CloudWatchRuntimeValues = Readonly<{
  outboxBacklog: number;
  oldestOutboxAgeMs: number;
  dueDeadlineCount: number;
  oldestDeadlineLagMs: number;
  orphanedGameCount: number;
  matchmakingQueueDepth: number;
  oldestMatchmakingQueueAgeMs: number;
  leaseLosses: number;
  fenceRecoveries: number;
  reconnectSuccesses: number;
  reconnectFailures: number;
  postgresPoolWaitP95Ms: number;
  postgresPoolWaitFailures: number;
  postgresCommitP95Ms: number;
  postgresCommitFailures: number;
}>;

class LatencyAccumulator {
  count = 0;
  failures = 0;
  totalMs = 0;
  minimumMs = Number.POSITIVE_INFINITY;
  maximumMs = 0;
  readonly buckets = new Array<number>(latencyBucketBoundsMs.length + 1).fill(0);

  record(durationMs: number, failed: boolean): void {
    const normalizedDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    this.count += 1;
    if (failed) this.failures += 1;
    this.totalMs += normalizedDuration;
    this.minimumMs = Math.min(this.minimumMs, normalizedDuration);
    this.maximumMs = Math.max(this.maximumMs, normalizedDuration);
    const bucket = latencyBucketBoundsMs.findIndex((bound) => normalizedDuration <= bound);
    const bucketIndex = bucket === -1 ? latencyBucketBoundsMs.length : bucket;
    this.buckets[bucketIndex] = this.buckets[bucketIndex]! + 1;
  }

  snapshot(intervalSeconds: number): LatencySnapshot {
    let cumulativeCount = 0;
    const cumulativeBuckets = this.buckets.map((count, index) => {
      cumulativeCount += count;
      return {
        upperBoundMs: index < latencyBucketBoundsMs.length ? latencyBucketBoundsMs[index]! : null,
        count: cumulativeCount
      };
    });
    const percentileUpperBound = (quantile: number): number => {
      if (this.count === 0) return 0;
      const target = Math.max(1, Math.ceil(this.count * quantile));
      const bucket = cumulativeBuckets.find(({ count }) => count >= target);
      return bucket?.upperBoundMs ?? this.maximumMs;
    };
    return {
      count: this.count,
      failures: this.failures,
      throughputPerSecond: this.count / intervalSeconds,
      minimumMs: this.count === 0 ? 0 : this.minimumMs,
      averageMs: this.count === 0 ? 0 : this.totalMs / this.count,
      maximumMs: this.maximumMs,
      p50UpperBoundMs: percentileUpperBound(0.5),
      p95UpperBoundMs: percentileUpperBound(0.95),
      p99UpperBoundMs: percentileUpperBound(0.99),
      cumulativeBuckets
    };
  }
}

function nanosecondsToMilliseconds(value: number): number {
  return Number.isFinite(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
    ? value / 1_000_000
    : 0;
}

function recordFor(
  groups: Map<MetricGroupName, Map<string, LatencyAccumulator>>,
  group: MetricGroupName,
  operation: string,
  durationMs: number,
  failed: boolean
): void {
  let operations = groups.get(group);
  if (!operations) {
    operations = new Map();
    groups.set(group, operations);
  }
  let metric = operations.get(operation);
  if (!metric) {
    metric = new LatencyAccumulator();
    operations.set(operation, metric);
  }
  metric.record(durationMs, failed);
}

export class LoadMetrics {
  private resetAt = Date.now();
  private resetAtMonotonic = performance.now();
  private cpuBaseline = process.cpuUsage();
  private eventLoopUtilizationBaseline = performance.eventLoopUtilization();
  private readonly eventLoopDelay: IntervalHistogram;
  private readonly groups = new Map<MetricGroupName, Map<string, LatencyAccumulator>>();
  private activeWebSockets = 0;
  private openedWebSockets = 0;
  private closedWebSockets = 0;
  private websocketErrors = 0;
  private rejectedWebSockets = 0;
  private reconnectCandidateCloses = 0;
  private sessionReplacementCloses = 0;
  private websocketRateLimitCloses = 0;
  private websocketBackpressureCloses = 0;
  private reconnectSuccesses = 0;
  private reconnectFailures = 0;
  private leaseLosses = 0;
  private fenceRecoveries = 0;
  private runtime: DistributedRuntimeOperationalMetrics = {
    outboxBacklog: 0,
    oldestOutboxAgeMs: 0,
    dueDeadlineCount: 0,
    oldestDeadlineLagMs: 0,
    orphanedGameCount: 0,
    matchmakingQueueDepth: 0,
    oldestMatchmakingQueueAgeMs: 0
  };
  private readonly websocketCloseCodes = new Map<number, number>();

  constructor(eventLoopResolutionMs = 20) {
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: eventLoopResolutionMs });
    this.eventLoopDelay.enable();
  }

  recordWebSocketOpen(): void {
    this.activeWebSockets += 1;
    this.openedWebSockets += 1;
  }

  recordWebSocketRejected(): void {
    this.rejectedWebSockets += 1;
  }

  recordWebSocketError(): void {
    this.websocketErrors += 1;
  }

  recordWebSocketRateLimitClose(): void {
    this.websocketRateLimitCloses += 1;
  }

  recordWebSocketBackpressureClose(): void {
    this.websocketBackpressureCloses += 1;
  }

  recordReconnectSuccess(): void {
    this.reconnectSuccesses += 1;
  }

  recordReconnectFailure(): void {
    this.reconnectFailures += 1;
  }

  recordLeaseLoss(): void {
    this.leaseLosses += 1;
  }

  recordFenceRecovery(): void {
    this.fenceRecoveries += 1;
  }

  observeDistributedRuntime(metrics: DistributedRuntimeOperationalMetrics): void {
    this.runtime = { ...metrics };
  }

  recordWebSocketClose(code: number): void {
    this.activeWebSockets = Math.max(0, this.activeWebSockets - 1);
    this.closedWebSockets += 1;
    this.websocketCloseCodes.set(code, (this.websocketCloseCodes.get(code) ?? 0) + 1);
    if ([1001, 1006, 1011, 1012, 1013].includes(code)) this.reconnectCandidateCloses += 1;
    if (code === 4001) this.sessionReplacementCloses += 1;
  }

  recordCommand(commandType: string, durationMs: number, failed = false): void {
    const safeType = gameCommandTypes.has(commandType) ? commandType : "other";
    recordFor(this.groups, "commands", safeType, durationMs, failed);
  }

  recordDependencyOperation(
    dependency: DependencyName,
    operation: string,
    durationMs: number,
    failed = false
  ): void {
    recordFor(this.groups, dependency, operation, durationMs, failed);
  }

  snapshot(): Record<string, unknown> {
    const generatedAt = Date.now();
    const intervalSeconds = Math.max(0.001, (performance.now() - this.resetAtMonotonic) / 1_000);
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(this.cpuBaseline);
    const cpuMilliseconds = (cpu.user + cpu.system) / 1_000;
    const eventLoopUtilization = performance.eventLoopUtilization(this.eventLoopUtilizationBaseline);
    const groupSnapshot = (group: MetricGroupName) => {
      const operations = this.groups.get(group) ?? new Map<string, LatencyAccumulator>();
      const all = new LatencyAccumulator();
      for (const metric of operations.values()) {
        all.count += metric.count;
        all.failures += metric.failures;
        all.totalMs += metric.totalMs;
        all.minimumMs = Math.min(all.minimumMs, metric.minimumMs);
        all.maximumMs = Math.max(all.maximumMs, metric.maximumMs);
        metric.buckets.forEach((count, index) => { all.buckets[index] = all.buckets[index]! + count; });
      }
      return {
        aggregate: all.snapshot(intervalSeconds),
        byOperation: Object.fromEntries(
          [...operations.entries()].sort(([left], [right]) => left.localeCompare(right))
            .map(([operation, metric]) => [operation, metric.snapshot(intervalSeconds)])
        )
      };
    };
    return {
      schemaVersion: 1,
      generatedAt: new Date(generatedAt).toISOString(),
      resetAt: new Date(this.resetAt).toISOString(),
      intervalSeconds,
      process: {
        uptimeSeconds: process.uptime(),
        cpuUserMilliseconds: cpu.user / 1_000,
        cpuSystemMilliseconds: cpu.system / 1_000,
        cpuPercentOfOneCore: cpuMilliseconds / (intervalSeconds * 1_000) * 100,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers
      },
      eventLoop: {
        utilization: eventLoopUtilization.utilization,
        delayMeanMs: nanosecondsToMilliseconds(this.eventLoopDelay.mean),
        delayMaximumMs: nanosecondsToMilliseconds(this.eventLoopDelay.max),
        delayP50Ms: nanosecondsToMilliseconds(this.eventLoopDelay.percentile(50)),
        delayP95Ms: nanosecondsToMilliseconds(this.eventLoopDelay.percentile(95)),
        delayP99Ms: nanosecondsToMilliseconds(this.eventLoopDelay.percentile(99)),
        delayExceededCount: this.eventLoopDelay.exceeds
      },
      webSockets: {
        activeConnections: this.activeWebSockets,
        opened: this.openedWebSockets,
        closed: this.closedWebSockets,
        errors: this.websocketErrors,
        rejectedBeforeAuthentication: this.rejectedWebSockets,
        reconnectCandidateCloses: this.reconnectCandidateCloses,
        sessionReplacementCloses: this.sessionReplacementCloses,
        rateLimitCloses: this.websocketRateLimitCloses,
        backpressureCloses: this.websocketBackpressureCloses,
        reconnectSuccesses: this.reconnectSuccesses,
        reconnectFailures: this.reconnectFailures,
        closeCodes: Object.fromEntries([...this.websocketCloseCodes.entries()].sort(([left], [right]) => left - right))
      },
      distributedRuntime: {
        ...this.runtime,
        leaseLosses: this.leaseLosses,
        fenceRecoveries: this.fenceRecoveries
      },
      commands: groupSnapshot("commands"),
      postgres: groupSnapshot("postgres"),
      valkey: groupSnapshot("valkey")
    };
  }

  cloudWatchValues(): CloudWatchRuntimeValues {
    const intervalSeconds = Math.max(0.001, (performance.now() - this.resetAtMonotonic) / 1_000);
    const postgres = this.groups.get("postgres");
    const poolWait = postgres?.get("pool.wait")?.snapshot(intervalSeconds);
    const commit = postgres?.get("transaction.commit")?.snapshot(intervalSeconds);
    return {
      ...this.runtime,
      leaseLosses: this.leaseLosses,
      fenceRecoveries: this.fenceRecoveries,
      reconnectSuccesses: this.reconnectSuccesses,
      reconnectFailures: this.reconnectFailures,
      postgresPoolWaitP95Ms: poolWait?.p95UpperBoundMs ?? 0,
      postgresPoolWaitFailures: poolWait?.failures ?? 0,
      postgresCommitP95Ms: commit?.p95UpperBoundMs ?? 0,
      postgresCommitFailures: commit?.failures ?? 0
    };
  }

  reset(): void {
    this.resetAt = Date.now();
    this.resetAtMonotonic = performance.now();
    this.cpuBaseline = process.cpuUsage();
    this.eventLoopUtilizationBaseline = performance.eventLoopUtilization();
    this.eventLoopDelay.reset();
    this.groups.clear();
    this.openedWebSockets = 0;
    this.closedWebSockets = 0;
    this.websocketErrors = 0;
    this.rejectedWebSockets = 0;
    this.reconnectCandidateCloses = 0;
    this.sessionReplacementCloses = 0;
    this.websocketRateLimitCloses = 0;
    this.websocketBackpressureCloses = 0;
    this.reconnectSuccesses = 0;
    this.reconnectFailures = 0;
    this.leaseLosses = 0;
    this.fenceRecoveries = 0;
    this.websocketCloseCodes.clear();
  }

  close(): void {
    this.eventLoopDelay.disable();
  }
}

function instrumentClient<T extends object>(
  client: T,
  metrics: LoadMetrics,
  dependency: DependencyName,
  measuredOperations: ReadonlySet<string>,
  metricOperationName: (operation: string, args: readonly unknown[]) => string = (operation) => operation,
  transformResolved: (operation: string, result: unknown) => unknown = (_operation, result) => result
): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      const operation = typeof property === "string" ? property : "unknown";
      if (!measuredOperations.has(operation)) return value.bind(target);
      return (...args: unknown[]) => {
        const metricOperation = metricOperationName(operation, args);
        const startedAt = performance.now();
        try {
          const result = Reflect.apply(value, target, args) as unknown;
          if (!(result && typeof result === "object" && "then" in result)) {
            metrics.recordDependencyOperation(dependency, metricOperation, performance.now() - startedAt);
            return transformResolved(operation, result);
          }
          return Promise.resolve(result).then((resolved) => {
            metrics.recordDependencyOperation(dependency, metricOperation, performance.now() - startedAt);
            return transformResolved(operation, resolved);
          }, (error: unknown) => {
            metrics.recordDependencyOperation(dependency, metricOperation, performance.now() - startedAt, true);
            throw error;
          });
        } catch (error) {
          metrics.recordDependencyOperation(dependency, metricOperation, performance.now() - startedAt, true);
          throw error;
        }
      };
    }
  });
}

export function instrumentValkeyClient<T extends object>(client: T, metrics: LoadMetrics): T {
  return instrumentClient(client, metrics, "valkey", measuredValkeyOperations);
}

export function instrumentPostgresPool<T extends object>(client: T, metrics: LoadMetrics): T {
  const wrappedClients = new WeakMap<object, object>();
  const wrapPoolClient = (result: unknown): unknown => {
    if (typeof result !== "object" || result === null) return result;
    const existing = wrappedClients.get(result);
    if (existing) return existing;
    const wrapped = instrumentClient(
      result,
      metrics,
      "postgres",
      new Set(["query"]),
      (_operation, args) => {
        const statement = typeof args[0] === "string" ? args[0].trim().split(/\s+/, 1)[0]?.toUpperCase() : undefined;
        if (statement === "BEGIN") return "transaction.begin";
        if (statement === "COMMIT") return "transaction.commit";
        if (statement === "ROLLBACK") return "transaction.rollback";
        return "client.query";
      }
    );
    wrappedClients.set(result, wrapped);
    return wrapped;
  };
  return instrumentClient(
    client,
    metrics,
    "postgres",
    new Set(["connect", "query"]),
    (operation) => operation === "connect" ? "pool.wait" : "pool.query",
    (operation, result) => operation === "connect" ? wrapPoolClient(result) : result
  );
}
