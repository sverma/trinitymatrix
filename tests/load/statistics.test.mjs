import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateTerminalConsensus,
  evaluateThresholds,
  LoadMetrics,
  percentile,
  reconnectCoverageRequired,
  safeRate,
  summarize
} from "./lib/statistics.mjs";

describe("load statistics", () => {
  it("calculates nearest-rank percentiles without mutating samples", () => {
    const samples = [100, 10, 50, 30, 20];
    assert.equal(percentile(samples, 50), 30);
    assert.equal(percentile(samples, 95), 100);
    assert.equal(percentile(samples, 0), 10);
    assert.deepEqual(samples, [100, 10, 50, 30, 20]);
    assert.equal(percentile([], 95), null);
  });

  it("summarizes latency samples and handles empty sets", () => {
    assert.deepEqual(summarize([]), {
      count: 0, min: null, max: null, mean: null, p50: null, p90: null, p95: null, p99: null
    });
    assert.deepEqual(summarize([1, 2, 3, 4]), {
      count: 4, min: 1, max: 4, mean: 2.5, p50: 2, p90: 4, p95: 4, p99: 4
    });
  });

  it("tracks counters/samples and evaluates threshold rates", () => {
    const metrics = new LoadMetrics();
    metrics.increment("commandsAttempted", 100);
    metrics.increment("commandsRejected");
    metrics.sample("moveMs", 40);
    metrics.sample("moveMs", 80);
    assert.equal(metrics.snapshot().latencies.moveMs.p95, 80);
    assert.equal(safeRate(0, 0), 0);

    const checks = evaluateThresholds({
      config: { games: 25, players: 50, reconnectEveryMs: 0 },
      counts: {
        gamesStarted: 25,
        peakActiveGames: 25,
        commandsAttempted: 100,
        commandsRejected: 1,
        commandsTimedOut: 0,
        connectAttempts: 50,
        connectSuccesses: 50,
        connectFailures: 0,
        unexpectedDisconnects: 0,
        reconnectAttempts: 10,
        reconnectFailures: 1,
        prematureGamesEnded: 0,
        gamesEnded: 25,
        terminalOutcomeObservers: 50,
        terminalConsensusGames: 25,
        terminalConsensusMismatches: 0,
        terminalConsensusTimeouts: 0,
        cleanupFailures: 0,
        serverErrors: 0,
        unreadableMessages: 0
      },
      latencies: { moveMs: { p95: 80, p99: 100 } }
    }, {
      maxP95Ms: 100,
      maxP99Ms: 150,
      maxCommandFailureRate: 0.01,
      maxConnectFailureRate: 0,
      maxReconnectFailureRate: 0.1,
      maxUnexpectedDisconnectRate: 0
    });
    assert.equal(checks.every(({ passed }) => passed), true);
  });

  it("requires one matching cleanup outcome from every distinct participant", () => {
    const participantIds = new Set(["player-1", "player-2", "player-3"]);
    const observations = new Map([
      ["player-1", { kind: "dropped", gameId: "game-1", playerId: "player-1" }],
      ["player-2", { kind: "dropped", gameId: "game-1", playerId: "player-2" }]
    ]);
    const incomplete = evaluateTerminalConsensus({
      gameId: "game-1", participantIds, observations, expectedPlayers: 3
    });
    assert.deepEqual(incomplete, { complete: false, consensus: false, errors: [] });

    observations.set("player-3", {
      kind: "winner", gameId: "game-1", winnerId: "player-3", reason: "player-dropped"
    });
    assert.deepEqual(evaluateTerminalConsensus({
      gameId: "game-1", participantIds, observations, expectedPlayers: 3
    }), { complete: true, consensus: true, errors: [] });
  });

  it("rejects conflicting, non-participant, and incorrectly classified terminal outcomes", () => {
    const result = evaluateTerminalConsensus({
      gameId: "game-1",
      participantIds: new Set(["player-1", "player-2"]),
      observations: new Map([
        ["player-1", { kind: "winner", gameId: "game-1", winnerId: "player-2", reason: "declaration" }],
        ["outsider", { kind: "dropped", gameId: "game-2", playerId: "player-1" }]
      ]),
      expectedPlayers: 2
    });
    assert.equal(result.consensus, false);
    assert.match(result.errors.join("\n"), /different winner|reason declaration|not a participant|different game/);
    const duplicateParticipants = evaluateTerminalConsensus({
      gameId: "game-1",
      participantIds: ["player-1", "player-1"],
      observations: [],
      expectedPlayers: 2
    });
    assert.match(duplicateParticipants.errors.join("\n"), /expected 2 distinct participants/);
  });

  it("requires drained reconnect accounting and unique-player coverage when enabled", () => {
    assert.equal(reconnectCoverageRequired(50, 1_000), 10);
    assert.equal(reconnectCoverageRequired(500, 1_000), 25);
    assert.equal(reconnectCoverageRequired(500, 0), 0);
    const counts = {
      peakActiveGames: 25,
      commandsAttempted: 100,
      commandsRejected: 0,
      commandsTimedOut: 0,
      connectAttempts: 50,
      connectSuccesses: 50,
      connectFailures: 0,
      unexpectedDisconnects: 0,
      scheduledReconnects: 10,
      reconnectAttempts: 11,
      reconnectSuccesses: 10,
      reconnectFailures: 1,
      reconnectPlayersScheduled: 10,
      reconnectPlayersAttempted: 10,
      reconnectPlayersSucceeded: 10,
      reconnectCoverageRequired: 10,
      prematureGamesEnded: 0,
      gamesEnded: 25,
      terminalOutcomeObservers: 50,
      terminalConsensusGames: 25,
      terminalConsensusMismatches: 0,
      terminalConsensusTimeouts: 0,
      cleanupFailures: 0,
      serverErrors: 0,
      unreadableMessages: 0
    };
    const summary = {
      config: { games: 25, players: 50, reconnectEveryMs: 1_000 },
      counts,
      latencies: { moveMs: { p95: 80, p99: 100 } }
    };
    const thresholds = {
      maxP95Ms: 100,
      maxP99Ms: 150,
      maxCommandFailureRate: 0.01,
      maxConnectFailureRate: 0,
      maxReconnectFailureRate: 0.1,
      maxUnexpectedDisconnectRate: 0
    };
    assert.equal(evaluateThresholds(summary, thresholds).every(({ passed }) => passed), true);
    counts.reconnectPlayersSucceeded = 9;
    const failed = evaluateThresholds(summary, thresholds).filter(({ passed }) => !passed);
    assert.deepEqual(failed.map(({ name }) => name), ["reconnect-success-player-coverage"]);
  });

  it("tracks unique metric values without double counting", () => {
    const metrics = new LoadMetrics();
    metrics.recordUnique("players", "player-1");
    metrics.recordUnique("players", "player-1");
    metrics.recordUnique("players", "player-2");
    assert.equal(metrics.uniqueCount("players"), 2);
  });
});
