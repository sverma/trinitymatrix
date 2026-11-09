import { describe, expect, it, vi } from "vitest";
import { CloudWatchMetricsReporter } from "./cloudwatch-metrics";
import type { CloudWatchRuntimeValues } from "./load-metrics";

const values = (overrides: Partial<CloudWatchRuntimeValues> = {}): CloudWatchRuntimeValues => ({
  outboxBacklog: 4,
  oldestOutboxAgeMs: 1200,
  dueDeadlineCount: 2,
  oldestDeadlineLagMs: 300,
  orphanedGameCount: 1,
  matchmakingQueueDepth: 6,
  oldestMatchmakingQueueAgeMs: 9000,
  leaseLosses: 3,
  fenceRecoveries: 2,
  reconnectSuccesses: 8,
  reconnectFailures: 1,
  postgresPoolWaitP95Ms: 25,
  postgresPoolWaitFailures: 1,
  postgresCommitP95Ms: 10,
  postgresCommitFailures: 0,
  ...overrides
});

describe("CloudWatch embedded runtime metrics", () => {
  it("emits bounded service aggregates and interval deltas without identity fields", () => {
    const cloudWatchValues = vi.fn()
      .mockReturnValueOnce(values())
      .mockReturnValueOnce(values({ leaseLosses: 5, reconnectFailures: 4 }));
    const reporter = new CloudWatchMetricsReporter({ cloudWatchValues }, "production");

    const first = reporter.document(1_000);
    const second = reporter.document(2_000);

    expect(first).toMatchObject({
      Service: "trinitymatrix-web",
      Environment: "production",
      OutboxBacklog: 4,
      LeaseLosses: 3,
      ReconnectFailures: 1,
      _aws: { Timestamp: 1_000 }
    });
    expect(second).toMatchObject({ LeaseLosses: 2, ReconnectFailures: 3 });
    const serialized = JSON.stringify(second);
    expect(serialized).not.toMatch(/email|player|gameName|sql|commandPayload/i);
  });

  it("writes one newline-delimited EMF object", () => {
    const write = vi.fn();
    const reporter = new CloudWatchMetricsReporter({ cloudWatchValues: () => values() }, "production", "trinitymatrix-web", 60_000, write);
    reporter.emit(1234);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toMatch(/^\{"_aws":.*\}\n$/);
  });
});
