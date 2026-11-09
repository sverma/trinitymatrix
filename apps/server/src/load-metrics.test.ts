import { describe, expect, it } from "vitest";
import {
  LoadMetrics,
  instrumentPostgresPool,
  instrumentValkeyClient,
  isLoadMetricsRequestAuthorized
} from "./load-metrics";

type MetricSnapshot = {
  webSockets: Record<string, unknown>;
  distributedRuntime: Record<string, unknown>;
  commands: { aggregate: { count: number; failures: number }; byOperation: Record<string, { count: number }> };
  postgres: {
    aggregate: { count: number; failures: number };
    byOperation: Record<string, { count: number; failures: number }>;
  };
  valkey: { aggregate: { count: number; failures: number }; byOperation: Record<string, { count: number }> };
};

describe("load metrics", () => {
  it("accepts only an exact bearer token", () => {
    const token = "local-load-test-token-with-32-characters";
    expect(isLoadMetricsRequestAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isLoadMetricsRequestAuthorized(undefined, token)).toBe(false);
    expect(isLoadMetricsRequestAuthorized(token, token)).toBe(false);
    expect(isLoadMetricsRequestAuthorized(`Bearer ${token}-wrong`, token)).toBe(false);
    expect(isLoadMetricsRequestAuthorized(`Bearer ${token} trailing`, token)).toBe(false);
  });

  it("reports bounded operational aggregates without command payloads", () => {
    const metrics = new LoadMetrics();
    metrics.recordWebSocketOpen();
    metrics.recordWebSocketOpen();
    metrics.recordWebSocketError();
    metrics.recordWebSocketClose(1006);
    metrics.recordWebSocketClose(4001);
    metrics.recordWebSocketRejected();
    metrics.recordWebSocketRateLimitClose();
    metrics.recordWebSocketBackpressureClose();
    metrics.recordReconnectSuccess();
    metrics.recordReconnectFailure();
    metrics.recordLeaseLoss();
    metrics.recordFenceRecovery();
    metrics.observeDistributedRuntime({
      outboxBacklog: 2,
      oldestOutboxAgeMs: 15,
      dueDeadlineCount: 1,
      oldestDeadlineLagMs: 5,
      orphanedGameCount: 0,
      matchmakingQueueDepth: 6,
      oldestMatchmakingQueueAgeMs: 100
    });
    metrics.recordCommand("game.draw", 7);
    metrics.recordCommand("user@example.com", 19, true);

    const snapshot = metrics.snapshot() as unknown as MetricSnapshot;
    expect(snapshot.webSockets).toMatchObject({
      activeConnections: 0,
      opened: 2,
      closed: 2,
      errors: 1,
      rejectedBeforeAuthentication: 1,
      reconnectCandidateCloses: 1,
      sessionReplacementCloses: 1,
      rateLimitCloses: 1,
      backpressureCloses: 1,
      reconnectSuccesses: 1,
      reconnectFailures: 1,
      closeCodes: { "1006": 1, "4001": 1 }
    });
    expect(snapshot.distributedRuntime).toMatchObject({
      outboxBacklog: 2,
      dueDeadlineCount: 1,
      matchmakingQueueDepth: 6,
      leaseLosses: 1,
      fenceRecoveries: 1
    });
    expect(snapshot.commands.aggregate).toMatchObject({ count: 2, failures: 1 });
    expect(snapshot.commands.byOperation).toHaveProperty("game.draw");
    expect(snapshot.commands.byOperation).toHaveProperty("other");
    expect(JSON.stringify(snapshot)).not.toContain("user@example.com");
    metrics.close();
  });

  it("times successful and failed PostgreSQL and Valkey operations", async () => {
    const metrics = new LoadMetrics();
    const postgres = instrumentPostgresPool({ query: async () => ({ rows: [] }), end: async () => undefined }, metrics);
    const valkey = instrumentValkeyClient({
      get: async () => "value",
      set: async () => "OK",
      del: async () => { throw new Error("unavailable"); },
      on: () => "listener"
    }, metrics);

    await postgres.query();
    await valkey.get();
    await valkey.set();
    await expect(valkey.del()).rejects.toThrow("unavailable");
    expect(valkey.on()).toBe("listener");

    const snapshot = metrics.snapshot() as unknown as MetricSnapshot;
    expect(snapshot.postgres.aggregate).toMatchObject({ count: 1, failures: 0 });
    expect(snapshot.valkey.aggregate).toMatchObject({ count: 3, failures: 1 });
    expect(snapshot.valkey.byOperation.get?.count).toBe(1);
    metrics.close();
  });

  it("times PostgreSQL transaction-client queries and preserves release binding", async () => {
    const metrics = new LoadMetrics();
    const client = {
      released: false,
      query: async (statementOrFailure?: string | boolean) => {
        if (statementOrFailure === true) throw new Error("transaction failed");
        return { rows: [{ ok: true }] };
      },
      release() {
        this.released = true;
      }
    };
    const postgres = instrumentPostgresPool({
      connect: async () => client,
      query: async () => ({ rows: [] })
    }, metrics);

    const transaction = await postgres.connect();
    await transaction.query("BEGIN");
    await expect(transaction.query()).resolves.toEqual({ rows: [{ ok: true }] });
    await transaction.query("COMMIT");
    await expect(transaction.query(true)).rejects.toThrow("transaction failed");
    transaction.release();

    const snapshot = metrics.snapshot() as unknown as MetricSnapshot;
    expect(client.released).toBe(true);
    expect(snapshot.postgres.aggregate).toMatchObject({ count: 5, failures: 1 });
    expect(snapshot.postgres.byOperation).toMatchObject({
      "pool.wait": { count: 1, failures: 0 },
      "transaction.begin": { count: 1, failures: 0 },
      "transaction.commit": { count: 1, failures: 0 },
      "client.query": { count: 2, failures: 1 }
    });
    expect(metrics.cloudWatchValues()).toMatchObject({
      postgresPoolWaitFailures: 0,
      postgresCommitFailures: 0
    });
    metrics.close();
  });

  it("does not decrement the WebSocket gauge on error before close", () => {
    const metrics = new LoadMetrics();
    metrics.recordWebSocketOpen();
    metrics.recordWebSocketError();
    expect(metrics.snapshot()).toMatchObject({
      webSockets: { activeConnections: 1, errors: 1, closed: 0 }
    });
    metrics.recordWebSocketClose(1006);
    expect(metrics.snapshot()).toMatchObject({
      webSockets: { activeConnections: 0, errors: 1, closed: 1 }
    });
    metrics.close();
  });

  it("resets counters while retaining the active connection gauge", () => {
    const metrics = new LoadMetrics();
    metrics.recordWebSocketOpen();
    metrics.recordCommand("game.discard", 4);
    metrics.reset();

    const snapshot = metrics.snapshot() as unknown as MetricSnapshot;
    expect(snapshot.webSockets).toMatchObject({ activeConnections: 1, opened: 0, closed: 0 });
    expect(snapshot.commands.aggregate.count).toBe(0);
    metrics.close();
  });
});
