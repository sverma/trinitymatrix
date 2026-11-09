import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const firstBase = process.env.DISTRIBUTED_NODE_A_URL ?? "http://127.0.0.1:8091";
const secondBase = process.env.DISTRIBUTED_NODE_B_URL ?? "http://127.0.0.1:8092";
const playerCount = Number(process.env.DISTRIBUTED_PLAYER_COUNT ?? "2");
assert.ok(playerCount === 2 || playerCount === 6, "DISTRIBUTED_PLAYER_COUNT must be 2 or 6.");

async function login(base, email, displayName) {
  const requested = await fetch(`${base}/api/auth/request-otp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email })
  });
  if (requested.status !== 200) throw new Error(`OTP request failed (${requested.status}): ${await requested.text()}`);
  const { challengeId } = await requested.json();
  const verified = await fetch(`${base}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ challengeId, code: "123456", displayName })
  });
  if (verified.status !== 200) throw new Error(`OTP verification failed (${verified.status}): ${await verified.text()}`);
  const cookie = verified.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("rm_session="), "OTP verification did not issue a session cookie.");
  return cookie;
}

function openPlayer(base, cookie) {
  const url = new URL(base);
  const socket = new WebSocket(`${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}/ws`, {
    headers: { cookie, origin: base }
  });
  const messages = [];
  const listeners = new Set();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const listener of [...listeners]) listener(message);
  });
  socket.on("error", (error) => {
    for (const listener of [...listeners]) listener({ type: "test.socket-error", error });
  });
  const waitFor = (predicate, label, timeoutMs = 10_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${label}. Seen: ${messages.map(({ type }) => type).join(", ")}`));
      }, timeoutMs);
      const listener = (message) => {
        if (message.type === "test.socket-error") {
          clearTimeout(timer);
          listeners.delete(listener);
          reject(message.error);
          return;
        }
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      listeners.add(listener);
    });
  };
  return { socket, messages, waitFor };
}

const players = await Promise.all(Array.from({ length: playerCount }, async (_, index) => {
  const base = index % 2 === 0 ? firstBase : secondBase;
  const cookie = await login(base, `node-${index + 1}-${randomUUID()}@example.test`, `Node ${index + 1}`);
  return { base, connection: openPlayer(base, cookie) };
}));

try {
  const ready = await Promise.all(players.map(({ connection }, index) =>
    connection.waitFor(({ type }) => type === "session.ready", `player ${index + 1} session`)));
  for (const [index, { connection }] of players.entries()) {
    connection.socket.send(JSON.stringify({ type: "queue.join", playerCount }));
    await connection.waitFor(
      ({ type, joined }) => type === "queue.status" && joined >= 1,
      `player ${index + 1} queue status`
    );
  }

  const started = await Promise.all(players.map(({ connection }, index) =>
    connection.waitFor(({ type }) => type === "game.started", `player ${index + 1} game start`)));
  assert.equal(new Set(started.map(({ gameId }) => gameId)).size, 1);
  assert.ok(started.every(({ revision }) => revision === 1));
  const gameId = started[0].gameId;
  const gameName = started[0].gameName;

  const currentIndex = ready.findIndex(({ playerId }) => playerId === started[0].currentPlayerId);
  assert.notEqual(currentIndex, -1);
  players[currentIndex].connection.socket.send(JSON.stringify({
    type: "game.draw",
    commandId: randomUUID(),
    gameId,
    expectedRevision: 1,
    source: "stock"
  }));
  await Promise.all(players.map(({ connection }, index) => connection.waitFor(
    ({ type, revision }) => type === "game.state" && revision === 2,
    `player ${index + 1} committed draw`
  )));

  // The final queue joiner owns the match. Alternating gateways guarantees
  // several drops cross an instance route in both 2- and 6-player scenarios.
  let revision = 2;
  const active = new Set(ready.map(({ playerId }) => playerId));
  let finalResult;
  for (let index = 0; active.size > 1; index += 1) {
    const candidateIndex = index % players.length;
    const playerId = ready[candidateIndex].playerId;
    if (!active.has(playerId)) continue;
    const finalDrop = active.size === 2;
    players[candidateIndex].connection.socket.send(JSON.stringify({
      type: "game.drop",
      commandId: randomUUID(),
      gameId,
      expectedRevision: revision
    }));
    revision += 1;
    active.delete(playerId);
    await players[candidateIndex].connection.waitFor(
      ({ type, gameId: leftGameId }) => type === "game.left" && leftGameId === gameId,
      `player ${candidateIndex + 1} lobby release`
    );
    await Promise.all([...active].map((activePlayerId) => {
      const activeIndex = ready.findIndex(({ playerId: id }) => id === activePlayerId);
      return players[activeIndex].connection.waitFor(
        ({ type, revision: observed }) => type === "game.state" && observed === revision,
        `player ${activeIndex + 1} revision ${revision}`
      );
    }));
    if (finalDrop) {
      finalResult = await players[candidateIndex].connection.waitFor(
        ({ type }) => type === "game.ended",
        `player ${candidateIndex + 1} committed game end`
      );
      const winnerId = [...active][0];
      const winnerIndex = ready.findIndex(({ playerId }) => playerId === winnerId);
      const winnerResult = await players[winnerIndex].connection.waitFor(
        ({ type }) => type === "game.ended",
        `winner ${winnerIndex + 1} committed game end`
      );
      assert.equal(finalResult.winnerId, winnerResult.winnerId);
      assert.equal(finalResult.reason, "player-dropped");
    }
  }
  assert.ok(finalResult);

  const terminalStates = players.flatMap(({ connection }) => connection.messages)
    .filter(({ type }) => type === "game.state")
    .map(({ revision }) => revision);
  assert.ok(terminalStates.every((revision) => revision >= 2), "A delayed outbox event regressed a client state.");
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    playerCount,
    gameId,
    gameName,
    gateways: [firstBase, secondBase],
    finalRevision: revision,
    winnerId: finalResult.winnerId
  })}\n`);
} finally {
  for (const { connection } of players) connection.socket.close();
}
