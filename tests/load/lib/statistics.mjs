export function percentile(samples, percentileValue) {
  if (!samples.length) return null;
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 100) {
    throw new Error("Percentile must be between 0 and 100.");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  if (percentileValue === 0) return sorted[0];
  const rank = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, rank)];
}

function rounded(value) {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function summarize(samples) {
  if (!samples.length) {
    return { count: 0, min: null, max: null, mean: null, p50: null, p90: null, p95: null, p99: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const at = (value) => {
    const rank = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
    return sorted[rank];
  };
  return {
    count: sorted.length,
    min: rounded(sorted[0]),
    max: rounded(sorted.at(-1)),
    mean: rounded(total / sorted.length),
    p50: rounded(at(50)),
    p90: rounded(at(90)),
    p95: rounded(at(95)),
    p99: rounded(at(99))
  };
}

export function safeRate(failures, attempts) {
  return attempts > 0 ? failures / attempts : 0;
}

export function reconnectCoverageRequired(players, reconnectEveryMs) {
  if (!(reconnectEveryMs > 0)) return 0;
  return Math.max(10, Math.ceil(players * 0.05));
}

/**
 * Cleanup deliberately drops N-1 participants. Each dropper's authoritative
 * terminal outcome is game.left; the one attached survivor observes game.ended.
 */
export function evaluateTerminalConsensus({
  gameId,
  participantIds,
  observations,
  expectedPlayers,
  requiredReason = "player-dropped"
}) {
  const participants = participantIds instanceof Set ? participantIds : new Set(participantIds ?? []);
  const terminals = observations instanceof Map ? observations : new Map(observations ?? []);
  const errors = [];
  if (participants.size !== expectedPlayers) {
    errors.push(`expected ${expectedPlayers} distinct participants, observed ${participants.size}`);
  }
  for (const [observerId, terminal] of terminals) {
    if (!participants.has(observerId)) errors.push(`terminal observer ${observerId} is not a participant`);
    if (terminal?.gameId !== gameId) errors.push(`observer ${observerId} reported a different game`);
    if (terminal?.kind === "dropped") {
      if (terminal.playerId !== observerId) errors.push(`drop outcome for ${observerId} identifies a different player`);
    } else if (terminal?.kind === "winner") {
      if (terminal.winnerId !== observerId) errors.push(`winner outcome for ${observerId} identifies a different winner`);
      if (!participants.has(terminal.winnerId)) errors.push(`observer ${observerId} reported a non-participant winner`);
      if (terminal.reason !== requiredReason) errors.push(`observer ${observerId} reported reason ${terminal?.reason ?? "missing"}`);
    } else {
      errors.push(`observer ${observerId} reported an unknown terminal outcome`);
    }
  }
  const complete = participants.size === expectedPlayers
    && terminals.size === expectedPlayers
    && [...participants].every((participantId) => terminals.has(participantId));
  if (complete) {
    const winners = [...terminals.values()].filter(({ kind }) => kind === "winner");
    const dropped = [...terminals.values()].filter(({ kind }) => kind === "dropped");
    if (winners.length !== 1) errors.push(`expected one winner outcome, observed ${winners.length}`);
    if (dropped.length !== expectedPlayers - 1) {
      errors.push(`expected ${expectedPlayers - 1} dropped outcomes, observed ${dropped.length}`);
    }
  }
  return { complete, consensus: complete && errors.length === 0, errors };
}

export function evaluateThresholds(summary, thresholds) {
  const reconnectEnabled = summary.config.reconnectEveryMs > 0;
  const reconnectChecks = reconnectEnabled ? [
    {
      name: "scheduled-reconnect-player-coverage",
      actual: summary.counts.reconnectPlayersScheduled,
      limit: summary.counts.reconnectCoverageRequired,
      operator: ">=",
      passed: summary.counts.reconnectPlayersScheduled >= summary.counts.reconnectCoverageRequired
    },
    {
      name: "reconnect-attempt-player-coverage",
      actual: summary.counts.reconnectPlayersAttempted,
      limit: summary.counts.reconnectCoverageRequired,
      operator: ">=",
      passed: summary.counts.reconnectPlayersAttempted >= summary.counts.reconnectCoverageRequired
    },
    {
      name: "reconnect-success-player-coverage",
      actual: summary.counts.reconnectPlayersSucceeded,
      limit: summary.counts.reconnectCoverageRequired,
      operator: ">=",
      passed: summary.counts.reconnectPlayersSucceeded >= summary.counts.reconnectCoverageRequired
    },
    {
      name: "scheduled-reconnects-attempted",
      actual: summary.counts.reconnectAttempts,
      limit: summary.counts.scheduledReconnects,
      operator: ">=",
      passed: summary.counts.reconnectAttempts >= summary.counts.scheduledReconnects
    },
    {
      name: "scheduled-reconnects-succeeded",
      actual: summary.counts.reconnectSuccesses,
      limit: summary.counts.scheduledReconnects,
      operator: ">=",
      passed: summary.counts.reconnectSuccesses >= summary.counts.scheduledReconnects
    },
    {
      name: "reconnect-attempts-accounted",
      actual: summary.counts.reconnectSuccesses + summary.counts.reconnectFailures,
      limit: summary.counts.reconnectAttempts,
      operator: "===",
      passed: summary.counts.reconnectAttempts
        === summary.counts.reconnectSuccesses + summary.counts.reconnectFailures
    }
  ] : [];
  const checks = [
    {
      name: "target-concurrent-games",
      actual: summary.counts.peakActiveGames,
      limit: summary.config.games,
      operator: ">=",
      passed: summary.counts.peakActiveGames >= summary.config.games
    },
    {
      name: "move-latency-p95-ms",
      actual: summary.latencies.moveMs.p95,
      limit: thresholds.maxP95Ms,
      operator: "<=",
      passed: summary.latencies.moveMs.p95 !== null && summary.latencies.moveMs.p95 <= thresholds.maxP95Ms
    },
    {
      name: "move-latency-p99-ms",
      actual: summary.latencies.moveMs.p99,
      limit: thresholds.maxP99Ms,
      operator: "<=",
      passed: summary.latencies.moveMs.p99 !== null && summary.latencies.moveMs.p99 <= thresholds.maxP99Ms
    },
    {
      name: "command-failure-rate",
      actual: safeRate(
        summary.counts.commandsRejected + summary.counts.commandsTimedOut,
        summary.counts.commandsAttempted
      ),
      limit: thresholds.maxCommandFailureRate,
      operator: "<="
    },
    {
      name: "connect-failure-rate",
      actual: safeRate(summary.counts.connectFailures, summary.counts.connectAttempts),
      limit: thresholds.maxConnectFailureRate,
      operator: "<="
    },
    {
      name: "reconnect-failure-rate",
      actual: safeRate(summary.counts.reconnectFailures, summary.counts.reconnectAttempts),
      limit: thresholds.maxReconnectFailureRate,
      operator: "<="
    },
    {
      name: "unexpected-disconnect-rate",
      actual: safeRate(summary.counts.unexpectedDisconnects, summary.counts.connectSuccesses),
      limit: thresholds.maxUnexpectedDisconnectRate,
      operator: "<="
    },
    {
      name: "gameplay-stale-state-rejections",
      actual: summary.counts.staleStateRejections ?? 0,
      limit: 0,
      operator: "<="
    },
    {
      name: "cleanup-stale-state-retries",
      actual: summary.counts.cleanupStaleStateRetries ?? 0,
      limit: 0,
      operator: "<="
    },
    {
      name: "premature-games-ended",
      actual: summary.counts.prematureGamesEnded,
      limit: 0,
      operator: "<="
    },
    {
      name: "games-completed-during-ramp-down",
      actual: summary.counts.gamesEnded,
      limit: summary.config.games,
      operator: ">=",
      passed: summary.counts.gamesEnded >= summary.config.games
    },
    {
      name: "terminal-outcome-observers",
      actual: summary.counts.terminalOutcomeObservers,
      limit: summary.config.players,
      operator: "===",
      passed: summary.counts.terminalOutcomeObservers === summary.config.players
    },
    {
      name: "terminal-consensus-games",
      actual: summary.counts.terminalConsensusGames,
      limit: summary.config.games,
      operator: "===",
      passed: summary.counts.terminalConsensusGames === summary.config.games
    },
    {
      name: "terminal-consensus-mismatches",
      actual: summary.counts.terminalConsensusMismatches,
      limit: 0,
      operator: "<="
    },
    {
      name: "terminal-consensus-timeouts",
      actual: summary.counts.terminalConsensusTimeouts,
      limit: 0,
      operator: "<="
    },
    {
      name: "cleanup-failures",
      actual: summary.counts.cleanupFailures,
      limit: 0,
      operator: "<="
    },
    {
      name: "protocol-errors",
      actual: summary.counts.serverErrors + summary.counts.unreadableMessages,
      limit: 0,
      operator: "<="
    },
    ...reconnectChecks
  ];
  return checks.map((check) => ({
    ...check,
    passed: check.passed ?? check.actual <= check.limit
  }));
}

export class LoadMetrics {
  constructor() {
    this.counts = Object.create(null);
    this.uniqueValues = new Map();
    this.samples = Object.fromEntries([
      "authMs", "connectMs", "matchStartMs", "moveMs", "reconnectMs", "heartbeatMs"
    ].map((name) => [name, new LatencyDistribution()]));
  }

  increment(name, amount = 1) {
    this.counts[name] = (this.counts[name] ?? 0) + amount;
  }

  sample(name, value) {
    if (!this.samples[name]) throw new Error(`Unknown metric sample: ${name}`);
    if (Number.isFinite(value) && value >= 0) this.samples[name].add(value);
  }

  count(name) {
    return this.counts[name] ?? 0;
  }

  recordUnique(name, value) {
    if (!this.uniqueValues.has(name)) this.uniqueValues.set(name, new Set());
    this.uniqueValues.get(name).add(value);
  }

  uniqueCount(name) {
    return this.uniqueValues.get(name)?.size ?? 0;
  }

  snapshot() {
    return {
      counts: { ...this.counts },
      latencies: Object.fromEntries(Object.entries(this.samples).map(([name, values]) => [name, values.summary()]))
    };
  }
}

class LatencyDistribution {
  constructor() {
    this.count = 0;
    this.total = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.buckets = new Map();
  }

  add(value) {
    this.count += 1;
    this.total += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    const bucket = Math.round(value);
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + 1);
  }

  percentile(value) {
    const target = Math.max(1, Math.ceil((value / 100) * this.count));
    let seen = 0;
    for (const [bucket, count] of [...this.buckets].sort(([left], [right]) => left - right)) {
      seen += count;
      if (seen >= target) return bucket;
    }
    return null;
  }

  summary() {
    if (this.count === 0) return summarize([]);
    return {
      count: this.count,
      min: rounded(this.min),
      max: rounded(this.max),
      mean: rounded(this.total / this.count),
      p50: this.percentile(50),
      p90: this.percentile(90),
      p95: this.percentile(95),
      p99: this.percentile(99)
    };
  }
}
