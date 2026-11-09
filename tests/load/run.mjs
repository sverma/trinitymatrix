#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { authenticateMockPlayer, checkReadiness, loadSessionPool } from "./lib/auth.mjs";
import { confirmationPhrase, parseLoadConfig, publicConfig } from "./lib/config.mjs";
import { VirtualPlayer } from "./lib/player.mjs";
import {
  evaluateTerminalConsensus,
  evaluateThresholds,
  LoadMetrics,
  reconnectCoverageRequired
} from "./lib/statistics.mjs";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function log(message) {
  process.stderr.write(`[load] ${message}\n`);
}

function defaultCounts(metrics, gamesStarted, peakActiveGames) {
  const names = [
    "authAttempts", "authSuccesses", "authFailures", "providedSessions",
    "connectAttempts", "connectSuccesses", "connectFailures", "unexpectedDisconnects",
    "scheduledReconnects", "reconnectAttempts", "reconnectSuccesses", "reconnectFailures",
    "commandsAttempted", "commandsAccepted", "commandsRejected", "commandsTimedOut",
    "serverErrors", "unreadableMessages", "staleStateRejections", "cleanupStaleStateRetries",
    "gamesEnded", "prematureGamesEnded", "cleanupFailures",
    "terminalOutcomeObservers", "terminalConsensusGames",
    "terminalConsensusMismatches", "terminalConsensusTimeouts"
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, metrics.count(name)])),
    gamesStarted,
    peakActiveGames,
    reconnectPlayersScheduled: metrics.uniqueCount("reconnectPlayersScheduled"),
    reconnectPlayersAttempted: metrics.uniqueCount("reconnectPlayersAttempted"),
    reconnectPlayersSucceeded: metrics.uniqueCount("reconnectPlayersSucceeded")
  };
}

class LoadRun {
  constructor(config) {
    this.config = config;
    this.metrics = new LoadMetrics();
    this.players = new Array(config.players);
    this.sessions = null;
    this.games = new Map();
    this.activeGameIds = new Set();
    this.peakActiveGames = 0;
    this.phase = "preflight";
    this.phaseTimes = {};
    this.startedAt = new Date();
    this.runId = `${this.startedAt.toISOString().replace(/\D/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    this.reconnectTimer = null;
    this.reconnectIndex = 0;
    this.stopping = false;
    this.stopPromise = null;
    this.interruptedSignal = null;
  }

  markPhase(name) {
    this.phase = name;
    this.phaseTimes[name] = new Date().toISOString();
    log(`${name} phase`);
  }

  onGameStarted(player, state) {
    let game = this.games.get(state.gameId);
    if (!game) {
      game = {
        id: state.gameId,
        name: state.gameName,
        players: new Set(),
        participantIds: null,
        participantViews: new Map(),
        terminalOutcomes: new Map(),
        terminalMismatch: false,
        terminalTimeout: false,
        ended: false
      };
      this.games.set(state.gameId, game);
      this.activeGameIds.add(state.gameId);
      this.peakActiveGames = Math.max(this.peakActiveGames, this.activeGameIds.size);
    }
    game.players.add(player);
    const participantIds = state.players?.map(({ id }) => id) ?? [];
    const distinctIds = new Set(participantIds);
    const signature = [...distinctIds].sort().join("\u0000");
    const priorSignature = game.participantViews.get(player.playerId);
    const invalidView = participantIds.length !== this.config.playerCount
      || distinctIds.size !== this.config.playerCount
      || participantIds.some((participantId) => typeof participantId !== "string" || participantId.length === 0)
      || !distinctIds.has(player.playerId)
      || (priorSignature !== undefined && priorSignature !== signature);
    if (priorSignature === undefined) game.participantViews.set(player.playerId, signature);
    if (!game.participantIds && !invalidView) game.participantIds = distinctIds;
    const canonicalMismatch = game.participantIds
      && (game.participantIds.size !== distinctIds.size
        || [...game.participantIds].some((participantId) => !distinctIds.has(participantId)));
    if (invalidView || canonicalMismatch) this.markTerminalMismatch(game, "participant-set mismatch");
  }

  markTerminalMismatch(game, reason) {
    if (game.terminalMismatch) return;
    game.terminalMismatch = true;
    this.metrics.increment("terminalConsensusMismatches");
    log(`${game.name ?? game.id}: ${reason}`);
  }

  onTerminalOutcome(player, outcome) {
    const gameId = outcome?.gameId;
    if (!gameId) return;
    const game = this.games.get(gameId);
    if (!game || game.ended) return;
    const observerId = player.playerId;
    const previous = game.terminalOutcomes.get(observerId);
    if (!previous) {
      game.terminalOutcomes.set(observerId, outcome);
      this.metrics.increment("terminalOutcomeObservers");
    } else if (JSON.stringify(previous) !== JSON.stringify(outcome)) {
      this.markTerminalMismatch(game, `observer ${observerId} reported conflicting terminal outcomes`);
    }
    const status = evaluateTerminalConsensus({
      gameId: game.id,
      participantIds: game.participantIds ?? new Set(),
      observations: game.terminalOutcomes,
      expectedPlayers: this.config.playerCount
    });
    if (status.errors.length) this.markTerminalMismatch(game, status.errors[0]);
    if (!status.consensus || game.terminalMismatch) return;
    game.ended = true;
    this.activeGameIds.delete(gameId);
    this.metrics.increment("gamesEnded");
    this.metrics.increment("terminalConsensusGames");
    if (this.phase !== "ramp-down") this.metrics.increment("prematureGamesEnded");
  }

  async sessionFor(index) {
    if (this.sessions) {
      this.metrics.increment("providedSessions");
      return this.sessions[index];
    }
    this.metrics.increment("authAttempts");
    try {
      const session = await authenticateMockPlayer(this.config, index, this.runId);
      this.metrics.increment("authSuccesses");
      this.metrics.sample("authMs", session.authMs);
      return session;
    } catch (error) {
      this.metrics.increment("authFailures");
      throw error;
    }
  }

  async startPlayer(index) {
    const session = await this.sessionFor(index);
    const player = new VirtualPlayer({
      index,
      config: this.config,
      session,
      metrics: this.metrics,
      onGameStarted: (current, state) => this.onGameStarted(current, state),
      onTerminalOutcome: (current, outcome) => this.onTerminalOutcome(current, outcome)
    });
    this.players[index] = player;
    await player.connect();
  }

  async startGroup(gameIndex, rampStartedAt) {
    const offset = this.config.games === 1 ? 0 : (this.config.rampUpMs * gameIndex) / (this.config.games - 1);
    await wait(Math.max(0, rampStartedAt + offset - performance.now()));
    const firstPlayer = gameIndex * this.config.playerCount;
    const starts = Array.from({ length: this.config.playerCount }, (_, seat) => this.startPlayer(firstPlayer + seat));
    const results = await Promise.allSettled(starts);
    for (const result of results) {
      if (result.status === "rejected") log(`player startup failed: ${result.reason?.message ?? result.reason}`);
    }
  }

  startReconnects() {
    if (this.config.reconnectEveryMs <= 0) return;
    this.reconnectTimer = setInterval(() => {
      for (let checked = 0; checked < this.players.length; checked += 1) {
        const player = this.players[this.reconnectIndex % this.players.length];
        this.reconnectIndex += 1;
        if (player?.triggerReconnect()) break;
      }
    }, this.config.reconnectEveryMs);
  }

  stopReconnects() {
    clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async cleanupGame(game) {
    const players = [...game.players].sort((left, right) => left.index - right.index);
    for (const player of players) player.autoplay = false;
    const idle = await Promise.all(players.map((player) => player.waitForIdle()));
    if (idle.some((ready) => !ready)) this.metrics.increment("cleanupFailures");
    for (let dropped = 0; dropped < this.config.playerCount - 1 && !game.ended; dropped += 1) {
      let cleaned = false;
      for (const player of players) {
        const own = player.state?.players?.find(({ id }) => id === player.playerId);
        if (own?.status !== "playing") continue;
        try {
          const didDrop = await player.dropForCleanup();
          if (!didDrop) continue;
          cleaned = true;
          const acceptedRevision = player.state?.revision ?? 0;
          for (let attempt = 0; attempt < Math.ceil(this.config.commandTimeoutMs / 25) && !game.ended; attempt += 1) {
            const remainingPlayersAreCurrent = players.every((candidate) => {
              const ownState = candidate.state?.players?.find(({ id }) => id === candidate.playerId);
              return ownState?.status !== "playing" || (candidate.state?.revision ?? -1) >= acceptedRevision;
            });
            if (remainingPlayersAreCurrent) break;
            await wait(25);
          }
          break;
        } catch {
          await wait(25);
        }
      }
      if (!cleaned) {
        this.metrics.increment("cleanupFailures");
        break;
      }
    }
    if (!game.ended && !game.terminalMismatch) {
      try {
        await waitUntil(
          () => game.ended || game.terminalMismatch,
          this.config.commandTimeoutMs,
          `terminal consensus for ${game.name ?? game.id}`
        );
      } catch {
        if (!game.terminalTimeout) {
          game.terminalTimeout = true;
          this.metrics.increment("terminalConsensusTimeouts");
        }
      }
    }
    await Promise.allSettled(players.map((player) => player.close()));
  }

  async rampDown() {
    this.stopReconnects();
    const reconnectsDrained = await Promise.all(
      this.players.filter(Boolean).map((player) => player.waitForReconnectSettled())
    );
    if (reconnectsDrained.some((drained) => !drained)) this.metrics.increment("cleanupFailures");
    const games = [...this.games.values()];
    const rampStartedAt = performance.now();
    await Promise.all(games.map(async (game, index) => {
      const offset = games.length <= 1 ? 0 : (this.config.rampDownMs * index) / (games.length - 1);
      await wait(Math.max(0, rampStartedAt + offset - performance.now()));
      await this.cleanupGame(game);
    }));
    await Promise.allSettled(this.players.filter(Boolean).map((player) => player.close()));
  }

  async execute() {
    await checkReadiness(this.config);
    if (this.config.sessionFile) this.sessions = await loadSessionPool(this.config.sessionFile, this.config.players);

    this.markPhase("ramp-up");
    const rampStartedAt = performance.now();
    await Promise.all(Array.from({ length: this.config.games }, (_, index) => this.startGroup(index, rampStartedAt)));
    await waitUntil(
      () => this.games.size >= this.config.games
        && [...this.games.values()].filter(({ players }) => players.size >= this.config.playerCount).length >= this.config.games,
      this.config.matchTimeoutMs,
      `${this.config.games} complete games to start`
    );

    this.markPhase("hold");
    this.startReconnects();
    await wait(this.config.holdMs);

    this.markPhase("ramp-down");
    await this.rampDown();
    this.markPhase("complete");
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.stopReconnects();
      await Promise.allSettled(this.players.filter(Boolean).map((player) => player.close()));
    })();
    return this.stopPromise;
  }

  async interrupt(signal) {
    if (!this.interruptedSignal) this.interruptedSignal = signal;
    await this.stop();
  }

  result(fatalError = null) {
    const metricSnapshot = this.metrics.snapshot();
    const result = {
      schemaVersion: 1,
      runId: this.runId,
      startedAt: this.startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      phase: this.phase,
      phaseTimes: this.phaseTimes,
      config: publicConfig(this.config),
      counts: {
        ...defaultCounts(this.metrics, this.games.size, this.peakActiveGames),
        terminalObservations: this.metrics.count("terminalOutcomeObservers"),
        reconnectCoverageRequired: reconnectCoverageRequired(
          this.config.players,
          this.config.reconnectEveryMs
        )
      },
      latencies: metricSnapshot.latencies,
      fatalError: fatalError ? String(fatalError.message ?? fatalError) : null
    };
    result.thresholds = evaluateThresholds(result, this.config.thresholds);
    result.success = !result.fatalError && result.thresholds.every(({ passed }) => passed);
    return result;
  }
}

async function writeResult(config, result) {
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(config.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

let run;
let config;
try {
  config = parseLoadConfig(process.argv.slice(2));
  if (config.dryRun) {
    process.stdout.write(`${JSON.stringify({ config: publicConfig(config), confirmationPhrase: confirmationPhrase(config) }, null, 2)}\n`);
    process.exitCode = 0;
  } else {
    run = new LoadRun(config);
    const stopOnSignal = (signal) => {
      void run.interrupt(signal).finally(() => process.exit(130));
    };
    process.once("SIGINT", () => stopOnSignal("SIGINT"));
    process.once("SIGTERM", () => stopOnSignal("SIGTERM"));
    let fatal = null;
    try {
      await run.execute();
    } catch (error) {
      fatal = error;
      log(`failed: ${error.message ?? error}`);
      await run.stop();
    }
    const result = run.result(fatal);
    await writeResult(config, result);
    process.exitCode = result.success ? 0 : 1;
  }
} catch (error) {
  process.stderr.write(`[load] configuration error: ${error.message ?? error}\n`);
  process.exitCode = 2;
}
