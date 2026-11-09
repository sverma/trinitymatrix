import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  CommandRejectedError,
  stateAcknowledgesCommand,
  stateRestoresControlledReconnect,
  VirtualPlayer
} from "./lib/player.mjs";

function playerWith(state) {
  const player = new VirtualPlayer({
    index: 0,
    config: { commandTimeoutMs: 100 },
    session: {},
    metrics: { increment() {}, sample() {}, recordUnique() {} },
    onGameStarted() {},
    onGameEnded() {}
  });
  player.playerId = "player-1";
  player.state = state;
  return player;
}

test("cleanup reports a no-op for a player that is no longer active", async () => {
  const player = playerWith({
    phase: "playing",
    players: [{ id: "player-1", status: "dropped" }]
  });
  assert.equal(await player.dropForCleanup(), false);
});

test("cleanup reports that an active player's drop was sent", async () => {
  const player = playerWith({
    phase: "playing",
    players: [{ id: "player-1", status: "playing" }]
  });
  let command = null;
  player.sendCommand = async (type) => { command = type; };
  assert.equal(await player.dropForCleanup(), true);
  assert.equal(command, "game.drop");
});

test("cleanup waits for a hydrated stale revision and retries with a new command", async () => {
  const player = playerWith({
    gameId: "game-1",
    revision: 4,
    phase: "playing",
    players: [{ id: "player-1", status: "playing" }]
  });
  const revisions = [];
  player.sendCommand = async (type) => {
    assert.equal(type, "game.drop");
    revisions.push(player.state.revision);
    if (revisions.length === 1) {
      setTimeout(() => {
        player.state = { ...player.state, revision: 5 };
      }, 10);
      throw new CommandRejectedError("STALE_STATE", 5);
    }
  };

  assert.equal(await player.dropForCleanup(), true);
  assert.deepEqual(revisions, [4, 5]);
});

test("cleanup does not retry a stale rejection without a hydrated state", async () => {
  const player = playerWith({
    gameId: "game-1",
    revision: 4,
    phase: "playing",
    players: [{ id: "player-1", status: "playing" }]
  });
  player.sendCommand = async () => { throw new CommandRejectedError("STALE_STATE", 5); };

  await assert.rejects(player.dropForCleanup(), /STALE_STATE/);
  assert.equal(player.state.revision, 4);
});

test("a revision increase only acknowledges the command whose effect is visible", () => {
  const playerId = "player-1";
  const playing = {
    currentPlayerId: playerId,
    players: [{ id: playerId, status: "playing", cardCount: 13 }]
  };
  assert.equal(stateAcknowledgesCommand("game.drop", playing, new Array(13), playerId), false);
  assert.equal(stateAcknowledgesCommand("game.draw", playing, new Array(13), playerId), false);

  const dropped = {
    ...playing,
    players: [{ id: playerId, status: "dropped", cardCount: 0 }]
  };
  assert.equal(stateAcknowledgesCommand("game.drop", dropped, new Array(13), playerId), true);
  const drawn = { ...playing, players: [{ id: playerId, status: "playing", cardCount: 14 }] };
  assert.equal(stateAcknowledgesCommand("game.draw", drawn, new Array(14), playerId), true);
  assert.equal(stateAcknowledgesCommand("game.discard", { ...playing, currentPlayerId: "player-2" }, new Array(13), playerId), true);
});

test("cleanup can wait for an in-flight gameplay command to settle", async () => {
  const player = playerWith({ phase: "playing", players: [] });
  player.pendingCommand = { commandId: "command-1" };
  setTimeout(() => { player.pendingCommand = null; }, 10);
  assert.equal(await player.waitForIdle(), true);
});

test("controlled reconnects are allowed only while the virtual player is idle", () => {
  const player = playerWith({ gameId: "game-1", revision: 4, phase: "playing", players: [] });
  player.socket = { readyState: 1 };
  assert.equal(player.canReconnectSafely(), true);
  player.pendingCommand = { commandId: "command-1" };
  assert.equal(player.canReconnectSafely(), false);
  player.pendingCommand = null;
  player.actionTimer = setTimeout(() => {}, 1_000);
  assert.equal(player.canReconnectSafely(), false);
  clearTimeout(player.actionTimer);
});

test("a controlled reconnect records its distinct scheduled player", () => {
  const unique = [];
  const counters = [];
  const player = new VirtualPlayer({
    index: 7,
    config: { commandTimeoutMs: 100 },
    session: {},
    metrics: {
      increment(name) { counters.push(name); },
      sample() {},
      recordUnique(name, value) { unique.push([name, value]); }
    },
    onGameStarted() {},
    onTerminalOutcome() {}
  });
  player.state = { gameId: "game-1", revision: 4 };
  let close = null;
  player.socket = { readyState: 1, close(code, reason) { close = [code, reason]; } };
  assert.equal(player.triggerReconnect(), true);
  assert.equal(player.controlledReconnectPending, true);
  assert.deepEqual(counters, ["scheduledReconnects"]);
  assert.deepEqual(unique, [["reconnectPlayersScheduled", 7]]);
  assert.deepEqual(close, [4000, "Controlled load-test reconnect"]);
  assert.equal(player.triggerReconnect(), false);
});

test("controlled reconnect restoration requires the same game at an equal or newer revision", () => {
  const expected = { gameId: "game-1", revision: 7 };
  assert.equal(stateRestoresControlledReconnect(expected, { gameId: "game-1", revision: 7 }), true);
  assert.equal(stateRestoresControlledReconnect(expected, { gameId: "game-1", revision: 8 }), true);
  assert.equal(stateRestoresControlledReconnect(expected, { gameId: "game-2", revision: 8 }), false);
  assert.equal(stateRestoresControlledReconnect(expected, { gameId: "game-1", revision: 6 }), false);
  assert.equal(stateRestoresControlledReconnect(expected, { gameId: "game-1" }), false);
});

test("controlled load WebSocket handshakes carry a fixed non-secret user agent", async () => {
  const server = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  let observedUserAgent = null;
  server.on("upgrade", (request, socket, head) => {
    observedUserAgent = request.headers["user-agent"] ?? null;
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.send(JSON.stringify({ type: "session.ready", playerId: "player-1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");

  const player = new VirtualPlayer({
    index: 0,
    config: {
      baseUrl: new URL(`http://127.0.0.1:${address.port}`),
      playerCount: 2,
      commandTimeoutMs: 100
    },
    session: { cookie: "rm_session=synthetic-session" },
    metrics: { increment() {}, sample() {}, recordUnique() {} },
    onGameStarted() {},
    onTerminalOutcome() {}
  });

  try {
    await player.connect();
    assert.equal(observedUserAgent, "trinitymatrix-controlled-load-player/1.0");
  } finally {
    await player.close();
    await new Promise((resolve) => webSockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
