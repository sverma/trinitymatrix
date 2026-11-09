import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CommandRejectedError extends Error {
  constructor(code, revision) {
    super(`Command rejected: ${code}`);
    this.name = "CommandRejectedError";
    this.code = code;
    this.revision = Number.isInteger(revision) ? revision : null;
  }
}

export function stateAcknowledgesCommand(commandType, state, hand, playerId) {
  if (!state || !playerId) return false;
  const own = state.players?.find(({ id }) => id === playerId);
  if (commandType === "game.draw") return own?.cardCount === 14 && hand.length === 14;
  if (commandType === "game.discard") {
    return own?.cardCount === 13 && hand.length === 13 && state.currentPlayerId !== playerId;
  }
  if (commandType === "game.drop") {
    return own?.status === "dropped";
  }
  return false;
}

export function stateRestoresControlledReconnect(expected, state) {
  return Boolean(expected
    && state?.gameId === expected.gameId
    && Number.isInteger(state.revision)
    && state.revision >= expected.revision);
}

export class VirtualPlayer {
  constructor({ index, config, session, metrics, onGameStarted, onTerminalOutcome, onGameEnded }) {
    this.index = index;
    this.config = config;
    this.session = session;
    this.metrics = metrics;
    this.onGameStarted = onGameStarted;
    this.onTerminalOutcome = onTerminalOutcome ?? onGameEnded;
    this.socket = null;
    this.playerId = null;
    this.state = null;
    this.hand = [];
    this.pendingCommand = null;
    this.desiredQueue = true;
    this.autoplay = true;
    this.stopping = false;
    this.deliberateClose = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.controlledReconnectPending = false;
    this.controlledReconnectExpected = null;
    this.controlledReconnectStartedAt = null;
    this.reconnectAttemptAwaitingOutcome = false;
    this.actionTimer = null;
    this.heartbeatTimer = null;
    this.pendingPings = new Map();
    this.lastActionKey = null;
    this.queuedAt = null;
  }

  async connect() {
    return this.#openSocket(false);
  }

  async #openSocket(reconnect) {
    if (this.stopping) throw new Error("Player is stopping.");
    if (reconnect) {
      this.metrics.increment("reconnectAttempts");
      this.reconnectAttemptAwaitingOutcome = true;
      if (this.controlledReconnectPending) this.metrics.recordUnique("reconnectPlayersAttempted", this.index);
    }
    else this.metrics.increment("connectAttempts");
    const startedAt = performance.now();
    const wsUrl = new URL("/ws", this.config.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl, {
      headers: {
        Origin: this.config.baseUrl.origin,
        Cookie: this.session.cookie,
        "User-Agent": "trinitymatrix-controlled-load-player/1.0"
      },
      ...(this.session.localAddress ? { localAddress: this.session.localAddress } : {}),
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
      maxPayload: 16 * 1024
    });
    this.socket = socket;

    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      const readyTimeout = setTimeout(() => {
        if (ready) return;
        socket.terminate();
        fail(new Error("Timed out waiting for session.ready."));
      }, 10_000);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimeout);
        if (reconnect && this.reconnectAttemptAwaitingOutcome) {
          this.metrics.increment("reconnectFailures");
          this.reconnectAttemptAwaitingOutcome = false;
        }
        else this.metrics.increment("connectFailures");
        reject(error);
      };
      socket.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch {
          this.metrics.increment("unreadableMessages");
          return;
        }
        if (message?.type === "session.ready" && !ready) {
          ready = true;
          settled = true;
          clearTimeout(readyTimeout);
          this.playerId = message.playerId;
          const latency = performance.now() - startedAt;
          if (reconnect) {
            if (!this.controlledReconnectPending) this.#recordReconnectSuccess(latency);
          } else {
            this.metrics.increment("connectSuccesses");
            this.metrics.sample("connectMs", latency);
          }
          this.reconnectAttempt = 0;
          this.#startHeartbeat();
          if (this.desiredQueue) {
            this.queuedAt = performance.now();
            this.#send({ type: "queue.join", playerCount: this.config.playerCount });
          }
          resolve();
        }
        this.#handleMessage(message);
      });
      socket.once("error", (error) => {
        if (!ready) fail(error);
      });
      socket.once("close", () => {
        clearTimeout(readyTimeout);
        this.#clearSocketTimers();
        if (this.socket === socket) this.socket = null;
        if (!ready) fail(new Error("WebSocket closed before session.ready."));
        if (this.pendingCommand) this.#failPending("connection-closed");
        if (this.stopping) return;
        if (ready && this.controlledReconnectPending && this.reconnectAttemptAwaitingOutcome) {
          this.metrics.increment("reconnectFailures");
          this.reconnectAttemptAwaitingOutcome = false;
        }
        if (ready && !this.deliberateClose) this.metrics.increment("unexpectedDisconnects");
        this.deliberateClose = false;
        if (ready) this.#scheduleReconnect();
      });
    });
  }

  #handleMessage(message) {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "pong") {
      const sentAt = this.pendingPings.get(message.at);
      if (sentAt !== undefined) {
        this.pendingPings.delete(message.at);
        this.metrics.sample("heartbeatMs", performance.now() - sentAt);
      }
      return;
    }
    if (message.type === "game.started") {
      if (this.desiredQueue && this.queuedAt !== null) {
        this.metrics.sample("matchStartMs", performance.now() - this.queuedAt);
      }
      this.state = message;
      this.hand = message.hand;
      this.desiredQueue = false;
      this.lastActionKey = null;
      if (this.controlledReconnectPending
        && stateRestoresControlledReconnect(this.controlledReconnectExpected, message)) {
        const latency = this.controlledReconnectStartedAt === null
          ? 0
          : performance.now() - this.controlledReconnectStartedAt;
        this.#recordReconnectSuccess(latency);
        this.metrics.recordUnique("reconnectPlayersSucceeded", this.index);
        this.controlledReconnectPending = false;
        this.controlledReconnectExpected = null;
        this.controlledReconnectStartedAt = null;
      }
      this.onGameStarted(this, message);
      this.#scheduleDrive();
      return;
    }
    if (message.type === "game.hand") {
      this.hand = message.hand;
      return;
    }
    if (message.type === "game.state") {
      this.state = message;
      if (this.pendingCommand && message.gameId === this.pendingCommand.gameId
        && message.revision > this.pendingCommand.expectedRevision
        && stateAcknowledgesCommand(this.pendingCommand.type, message, this.hand, this.playerId)) {
        this.#acceptPending();
      }
      this.#scheduleDrive();
      return;
    }
    if (message.type === "command.rejected") {
      // A rejection revision is a synchronization watermark, not a complete
      // game snapshot. Mutating only state.revision would combine a new
      // revision with a stale hand/current-player view and can make the next
      // synthetic command invalid. Wait for the durable game.state instead.
      if (this.pendingCommand?.commandId === message.commandId) {
        this.#rejectPending(message.code, message.revision);
      }
      this.#scheduleDrive();
      return;
    }
    if (message.type === "game.ended") {
      if (this.pendingCommand?.type === "game.drop") this.#acceptPending();
      this.autoplay = false;
      const own = this.state?.players?.find(({ id }) => id === this.playerId);
      if (own?.status !== "dropped") {
        this.onTerminalOutcome(this, {
          kind: "winner",
          gameId: this.state?.gameId ?? null,
          winnerId: message.winnerId,
          reason: message.reason
        });
      }
      return;
    }
    if (message.type === "game.left") {
      if (this.pendingCommand?.type === "game.drop") this.#acceptPending();
      this.autoplay = false;
      this.onTerminalOutcome(this, {
        kind: "dropped",
        gameId: message.gameId,
        playerId: this.playerId
      });
      return;
    }
    if (message.type === "error") this.metrics.increment("serverErrors");
  }

  #startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const at = Date.now();
      this.pendingPings.set(at, performance.now());
      this.#send({ type: "ping", at });
      for (const [key, sentAt] of this.pendingPings) {
        if (performance.now() - sentAt > 30_000) this.pendingPings.delete(key);
      }
    }, 20_000);
    this.heartbeatTimer.unref?.();
  }

  #clearSocketTimers() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.pendingPings.clear();
  }

  #scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = Math.min(250 * (2 ** this.reconnectAttempt), 5_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#openSocket(true).catch(() => this.#scheduleReconnect());
    }, delay);
  }

  triggerReconnect() {
    if (!this.canReconnectSafely()) return false;
    this.metrics.increment("scheduledReconnects");
    this.metrics.recordUnique("reconnectPlayersScheduled", this.index);
    this.controlledReconnectPending = true;
    this.controlledReconnectExpected = {
      gameId: this.state.gameId,
      revision: this.state.revision
    };
    this.controlledReconnectStartedAt = performance.now();
    this.deliberateClose = true;
    this.socket.close(4000, "Controlled load-test reconnect");
    return true;
  }

  canReconnectSafely() {
    return !this.stopping
      && !this.controlledReconnectPending
      && this.socket?.readyState === WebSocket.OPEN
      && this.pendingCommand === null
      && this.actionTimer === null
      && typeof this.state?.gameId === "string"
      && Number.isInteger(this.state?.revision);
  }

  #recordReconnectSuccess(latency) {
    if (!this.reconnectAttemptAwaitingOutcome) return;
    this.reconnectAttemptAwaitingOutcome = false;
    this.metrics.increment("reconnectSuccesses");
    this.metrics.sample("reconnectMs", latency);
  }

  #scheduleDrive() {
    if (!this.autoplay || this.stopping || this.pendingCommand || this.actionTimer || !this.state) return;
    if (this.state.phase !== "playing" || this.state.currentPlayerId !== this.playerId) return;
    const key = `${this.state.gameId}:${this.state.revision}:${this.hand.length}`;
    if (this.lastActionKey === key) return;
    this.lastActionKey = key;
    const delay = this.config.actionDelayMs + (this.index % 7);
    this.actionTimer = setTimeout(() => {
      this.actionTimer = null;
      if (!this.autoplay || !this.state || this.state.currentPlayerId !== this.playerId) return;
      if (this.hand.length === 13) {
        void this.sendCommand("game.draw", { source: "stock" }).catch(() => undefined);
      } else if (this.hand.length === 14) {
        const ordered = [...this.hand].sort((left, right) => left.id.localeCompare(right.id));
        const card = ordered[(this.index + this.state.revision) % ordered.length];
        if (card) void this.sendCommand("game.discard", { cardId: card.id }).catch(() => undefined);
      }
    }, delay);
  }

  sendCommand(type, payload = {}, options = {}) {
    if (!this.state || !this.playerId) return Promise.reject(new Error("Player has no active game state."));
    if (this.pendingCommand) return Promise.reject(new Error("Player already has a command in flight."));
    const commandId = randomUUID();
    const command = {
      type,
      ...payload,
      commandId,
      gameId: this.state.gameId,
      expectedRevision: this.state.revision
    };
    this.metrics.increment("commandsAttempted");
    const sentAt = performance.now();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingCommand?.commandId !== commandId) return;
        this.pendingCommand = null;
        this.metrics.increment("commandsTimedOut");
        reject(new Error("Command timed out."));
      }, this.config.commandTimeoutMs);
      this.pendingCommand = {
        commandId,
        type,
        context: options.context ?? "gameplay",
        gameId: this.state.gameId,
        expectedRevision: this.state.revision,
        sentAt,
        timeout,
        resolve,
        reject
      };
      if (!this.#send(command)) this.#failPending("socket-not-open");
    });
  }

  #acceptPending() {
    const pending = this.pendingCommand;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCommand = null;
    this.metrics.increment("commandsAccepted");
    this.metrics.sample("moveMs", performance.now() - pending.sentAt);
    pending.resolve();
  }

  #rejectPending(code, revision) {
    const pending = this.pendingCommand;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCommand = null;
    this.metrics.increment("commandsRejected");
    if (code === "STALE_STATE") {
      this.metrics.increment(pending.context === "cleanup"
        ? "cleanupStaleStateRetries"
        : "staleStateRejections");
    }
    pending.reject(new CommandRejectedError(code, revision));
  }

  #failPending(reason) {
    const pending = this.pendingCommand;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingCommand = null;
    this.metrics.increment("commandsTimedOut");
    pending.reject(new Error(`Command failed: ${reason}`));
  }

  #send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async dropForCleanup() {
    this.autoplay = false;
    clearTimeout(this.actionTimer);
    this.actionTimer = null;
    const retryDeadline = Date.now() + Math.max(this.config.commandTimeoutMs, 1_000);
    while (Date.now() <= retryDeadline) {
      if (!this.state || this.state.phase !== "playing") return false;
      const own = this.state.players?.find(({ id }) => id === this.playerId);
      if (own?.status !== "playing") return false;
      await this.waitForIdle();
      if (this.pendingCommand) throw new Error("Player still has a command in flight during cleanup.");
      try {
        await this.sendCommand("game.drop", {}, { context: "cleanup" });
        return true;
      } catch (error) {
        if (!(error instanceof CommandRejectedError)
          || error.code !== "STALE_STATE"
          || !Number.isInteger(error.revision)) throw error;
        const hydrated = await this.waitForRevision(error.revision, retryDeadline - Date.now());
        if (!hydrated) throw error;
      }
    }
    return false;
  }

  async waitForRevision(revision, timeoutMs = this.config.commandTimeoutMs) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
      if (Number.isInteger(this.state?.revision) && this.state.revision >= revision) return true;
      await wait(25);
    }
    return false;
  }

  async waitForIdle() {
    const attempts = Math.ceil((this.config.commandTimeoutMs + 500) / 25);
    for (let attempt = 0; this.pendingCommand && attempt < attempts; attempt += 1) await wait(25);
    return !this.pendingCommand;
  }

  async waitForReconnectSettled() {
    const timeoutMs = Math.max(12_000, this.config.commandTimeoutMs + 1_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.controlledReconnectPending
        && !this.reconnectTimer
        && this.socket?.readyState === WebSocket.OPEN) return true;
      await wait(25);
    }
    if (this.reconnectAttemptAwaitingOutcome) {
      this.metrics.increment("reconnectFailures");
      this.reconnectAttemptAwaitingOutcome = false;
    }
    this.controlledReconnectPending = false;
    this.controlledReconnectExpected = null;
    this.controlledReconnectStartedAt = null;
    return false;
  }

  async close() {
    this.stopping = true;
    this.autoplay = false;
    clearTimeout(this.actionTimer);
    clearTimeout(this.reconnectTimer);
    this.actionTimer = null;
    this.reconnectTimer = null;
    this.#clearSocketTimers();
    if (this.pendingCommand) this.#failPending("player-stopped");
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    socket.close(1000, "Load test complete");
    await Promise.race([
      new Promise((resolve) => socket.once("close", resolve)),
      wait(1_000).then(() => socket.terminate())
    ]);
  }
}
