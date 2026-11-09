import type { CloudWatchRuntimeValues, LoadMetrics } from "./load-metrics";

const counterNames = [
  "LeaseLosses",
  "FenceRecoveries",
  "ReconnectSuccesses",
  "ReconnectFailures",
  "PostgresPoolWaitFailures",
  "PostgresCommitFailures"
] as const;

const metricDefinitions = [
  { Name: "OutboxBacklog", Unit: "Count" },
  { Name: "OldestOutboxAgeMs", Unit: "Milliseconds" },
  { Name: "DueDeadlineCount", Unit: "Count" },
  { Name: "OldestDeadlineLagMs", Unit: "Milliseconds" },
  { Name: "OrphanedGameCount", Unit: "Count" },
  { Name: "MatchmakingQueueDepth", Unit: "Count" },
  { Name: "OldestMatchmakingQueueAgeMs", Unit: "Milliseconds" },
  { Name: "LeaseLosses", Unit: "Count" },
  { Name: "FenceRecoveries", Unit: "Count" },
  { Name: "ReconnectSuccesses", Unit: "Count" },
  { Name: "ReconnectFailures", Unit: "Count" },
  { Name: "PostgresPoolWaitP95Ms", Unit: "Milliseconds" },
  { Name: "PostgresPoolWaitFailures", Unit: "Count" },
  { Name: "PostgresCommitP95Ms", Unit: "Milliseconds" },
  { Name: "PostgresCommitFailures", Unit: "Count" }
] as const;

type MetricDocument = Record<string, unknown> & {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: readonly [{
      Namespace: "TrinityMatrix/Runtime";
      Dimensions: readonly [readonly ["Service", "Environment"]];
      Metrics: typeof metricDefinitions;
    }];
  };
  Service: string;
  Environment: string;
};

const fieldNames: Readonly<Record<keyof CloudWatchRuntimeValues, string>> = {
  outboxBacklog: "OutboxBacklog",
  oldestOutboxAgeMs: "OldestOutboxAgeMs",
  dueDeadlineCount: "DueDeadlineCount",
  oldestDeadlineLagMs: "OldestDeadlineLagMs",
  orphanedGameCount: "OrphanedGameCount",
  matchmakingQueueDepth: "MatchmakingQueueDepth",
  oldestMatchmakingQueueAgeMs: "OldestMatchmakingQueueAgeMs",
  leaseLosses: "LeaseLosses",
  fenceRecoveries: "FenceRecoveries",
  reconnectSuccesses: "ReconnectSuccesses",
  reconnectFailures: "ReconnectFailures",
  postgresPoolWaitP95Ms: "PostgresPoolWaitP95Ms",
  postgresPoolWaitFailures: "PostgresPoolWaitFailures",
  postgresCommitP95Ms: "PostgresCommitP95Ms",
  postgresCommitFailures: "PostgresCommitFailures"
};

/**
 * Emits CloudWatch Embedded Metric Format through the existing awslogs stream.
 * No AWS SDK permission or sidecar is required and the document contains only
 * bounded service-level aggregates—never game, player, request or SQL data.
 */
export class CloudWatchMetricsReporter {
  private timer: NodeJS.Timeout | null = null;
  private previousCounters = new Map<string, number>();

  constructor(
    private readonly metrics: Pick<LoadMetrics, "cloudWatchValues">,
    private readonly environment: string,
    private readonly service = "trinitymatrix-web",
    private readonly intervalMs = 60_000,
    private readonly write: (line: string) => void = (line) => process.stdout.write(line)
  ) {}

  document(now = Date.now()): MetricDocument {
    const values = this.metrics.cloudWatchValues();
    const fields = Object.fromEntries(Object.entries(values).map(([name, value]) => [fieldNames[name as keyof CloudWatchRuntimeValues], value]));
    for (const name of counterNames) {
      const current = Number(fields[name] ?? 0);
      const previous = this.previousCounters.get(name) ?? 0;
      fields[name] = Math.max(0, current - previous);
      this.previousCounters.set(name, current);
    }
    return {
      _aws: {
        Timestamp: now,
        CloudWatchMetrics: [{
          Namespace: "TrinityMatrix/Runtime",
          Dimensions: [["Service", "Environment"]],
          Metrics: metricDefinitions
        }]
      },
      Service: this.service,
      Environment: this.environment,
      ...fields
    };
  }

  emit(now = Date.now()): void {
    this.write(`${JSON.stringify(this.document(now))}\n`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
