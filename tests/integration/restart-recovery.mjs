import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createClient } from "redis";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "../..");
const port = 8091;
const origin = `http://127.0.0.1:${port}`;
const namespace = `trinitymatrix:restart-test:${randomUUID()}`;
const sessionIds = [];
let server;

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function startServer() {
  server = spawn(process.execPath, [resolve(root, "apps/server/dist/index.js")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      ALLOWED_ORIGINS: origin,
      STATE_NAMESPACE: namespace,
      WEB_DIST_PATH: resolve(root, "apps/web/dist"),
      LOG_LEVEL: "fatal"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let diagnostics = "";
  server.stdout.on("data", (chunk) => { diagnostics += chunk.toString(); });
  server.stderr.on("data", (chunk) => { diagnostics += chunk.toString(); });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited during startup.\n${diagnostics}`);
    try {
      const response = await fetch(`${origin}/readyz`);
      if (response.ok) return;
    } catch {
      // The listener may not be open yet.
    }
    await wait(100);
  }
  throw new Error(`Server did not become ready.\n${diagnostics}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    wait(5_000).then(() => { throw new Error("Server did not stop gracefully."); })
  ]);
}

async function authenticate(index) {
  const requested = await fetch(`${origin}/api/auth/request-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `restart${index}@example.test` })
  });
  const { challengeId } = await requested.json();
  const verified = await fetch(`${origin}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId, code: "123456", displayName: `Restart ${index}` })
  });
  if (!verified.ok) throw new Error(`Authentication failed with ${verified.status}.`);
  const cookie = verified.headers.get("set-cookie").split(";", 1)[0];
  sessionIds.push(cookie.split("=", 2)[1]);
  return cookie;
}

async function connect(cookie) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin, Cookie: cookie } });
  const messages = [];
  const pending = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of [...pending]) {
      if (waiter.predicate(message)) {
        pending.splice(pending.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (predicate, timeoutMs = 5_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveMessage, rejectMessage) => {
      const waiter = { predicate, resolve: resolveMessage };
      pending.push(waiter);
      setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        rejectMessage(new Error("Timed out waiting for a WebSocket message."));
      }, timeoutMs);
    });
  };
  await waitFor((message) => message.type === "session.ready");
  return { socket, waitFor };
}

async function cleanState() {
  const redis = createClient({ url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379" });
  await redis.connect();
  await redis.del([
    `${namespace}:matchmaker:active-games`,
    ...sessionIds.map((id) => `${namespace}:auth:session:${id}`)
  ]);
  await redis.quit();
}

try {
  await startServer();
  const cookies = await Promise.all([authenticate(1), authenticate(2)]);
  const firstConnections = await Promise.all(cookies.map(connect));
  firstConnections[0].socket.send(JSON.stringify({ type: "queue.join", playerCount: 2 }));
  firstConnections[1].socket.send(JSON.stringify({ type: "queue.join", playerCount: 2 }));
  const originalGames = await Promise.all(firstConnections.map(({ waitFor }) => waitFor((message) => message.type === "game.started")));
  const originalGameId = originalGames[0].gameId;
  const originalHands = originalGames.map(({ hand }) => hand);

  await stopServer();
  await startServer();
  const restoredConnections = await Promise.all(cookies.map(connect));
  const restoredGames = await Promise.all(restoredConnections.map(({ waitFor }) => waitFor((message) => message.type === "game.started")));
  if (restoredGames.some(({ gameId }) => gameId !== originalGameId)) throw new Error("The table id changed after restart.");
  if (restoredGames.some(({ hand }, index) => JSON.stringify(hand) !== JSON.stringify(originalHands[index]))) {
    throw new Error("A private hand changed after restart.");
  }
  for (const { socket } of restoredConnections) socket.close();
  console.log(`Restart recovery passed for table ${originalGameId.slice(0, 8)}.`);
} finally {
  await stopServer().catch(() => undefined);
  await cleanState().catch(() => undefined);
}
