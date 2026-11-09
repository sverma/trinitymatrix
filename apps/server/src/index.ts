import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { parseClientMessage } from "@trinitymatrix/protocol";
import {
  AuthService,
  MockEmailOtpSender,
  ResendEmailOtpSender,
  normalizeEmail,
  profileUpdateSchema,
  type EmailOtpSender
} from "./auth";
import { assertServerAuthConfig, authIpRateLimits, loadRuntimeConfig } from "./config";
import { Matchmaker } from "./matchmaker";
import { RedisStateStore } from "./persistence";
import { PostGameChatCipher } from "./db/chat-crypto";
import { createPostgresPool } from "./db/pool";
import { PostgresApplicationRepository } from "./db/repository";
import { registerDurableDataRoutes } from "./durable-routes";
import { PostgresGameArchive } from "./game-archive";
import { runMigrations } from "./db/migrate";
import { sqlMigrations } from "./db/migrations";
import { coordinatorPrivateRoom, registerPrivateMatchRoutes } from "./private-routes";
import {
  LoadMetrics,
  instrumentPostgresPool,
  instrumentValkeyClient,
  isLoadMetricsRequestAuthorized
} from "./load-metrics";
import { createValkeyRateLimitStore } from "./valkey-rate-limit";
import { PostgresDistributedGameRuntime } from "./db/distributed-runtime";
import {
  DistributedMatchmaker,
  distributedGameplayProtocolVersion,
  distributedOwnershipLeaseDurationMs
} from "./distributed-matchmaker";
import { ValkeyDistributedGameTransport } from "./distributed-transport";
import {
  DistributedRuntimeWorkers,
  distributedRuntimeWorkerIntervalMs,
  GameLeaseSupervisor
} from "./distributed-workers";
import { WebSocketInboundGuard } from "./websocket-inbound-guard";
import { CloudWatchMetricsReporter } from "./cloudwatch-metrics";
import {
  PostgresReplayExportLedger,
  ReplayExportWorker,
  replayBucketName,
  S3ReplayObjectStore
} from "./replay-export";
import {
  AdminPasskeyService,
  PostgresAdminPasskeyRepository,
  registerAdminPasskeyRoutes
} from "./admin-passkeys";
import { serializePublicPolicyMetadataScript } from "./public-policy-metadata";
import { createValkeyClient } from "./valkey-client";

const config = loadRuntimeConfig(process.env);
assertServerAuthConfig(config);
const authRateLimits = authIpRateLimits(config);
const allowedSocketOrigins = [...config.allowedOrigins].map((origin) =>
  origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
);

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: ["req.headers.cookie", "res.headers.set-cookie"]
  },
  bodyLimit: 16 * 1024,
  trustProxy: config.trustProxy
});

await app.register(cookie);
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'", ...allowedSocketOrigins],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: config.cookieSecure ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false,
  strictTransportSecurity: config.cookieSecure
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
    : false,
  referrerPolicy: { policy: "no-referrer" }
});
await app.register(websocket, { options: { maxPayload: 16 * 1024, perMessageDeflate: false } });

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/api/")
    || request.url.startsWith("/internal/load-metrics")
    || ["/healthz", "/readyz", "/version", "/policy-metadata.js"].includes(request.url)) {
    reply.header("Cache-Control", "no-store");
  }
  reply.header("Permissions-Policy", "accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  reply.header("Origin-Agent-Cluster", "?1");
  const origin = request.headers.origin;
  if (request.url.startsWith("/api/") && origin && !config.allowedOrigins.has(origin)) {
    return reply.code(403).send({ error: "Origin not allowed." });
  }
});

// Collect the same bounded operational aggregates in every environment. The
// authenticated load endpoint remains opt-in, while production emits only
// aggregate CloudWatch EMF documents through the existing awslogs stream.
const metrics = new LoadMetrics();
const loadMetrics = config.loadMetricsEnabled ? metrics : null;
const cloudWatchMetrics = config.cloudWatchEmfEnabled
  ? new CloudWatchMetricsReporter(metrics, config.nodeEnv)
  : null;
cloudWatchMetrics?.start();
const redisClient = createValkeyClient(config.redisUrl);
const redis = instrumentValkeyClient(redisClient, metrics);
let redisReady = false;
let stateHydrated = false;
let hydrationPromise: Promise<void> | null = null;
let shuttingDown = false;
const store = new RedisStateStore(redis, config.stateNamespace);
// Mutable/session route counters are atomic in Valkey and therefore cannot be
// bypassed by letting the ALB spread attempts across application replicas.
// Applying a global IP limit to SPA assets would penalize six-player homes, so
// only explicitly configured routes use this shared store.
await app.register(rateLimit, {
  global: false,
  store: createValkeyRateLimitStore(redis, `${config.stateNamespace}:rate-limit`),
  skipOnError: false
});
const postgresClient = config.databaseUrl ? createPostgresPool(config) : null;
const postgres = postgresClient
  ? instrumentPostgresPool(postgresClient, metrics)
  : postgresClient;
if (postgres && config.nodeEnv !== "production") await runMigrations(postgres, sqlMigrations);
if (postgres) await postgres.query("SELECT 1");
postgres?.on("error", (error) => app.log.error({ err: error }, "Unexpected idle PostgreSQL client error"));
const repository = postgres && config.chatEncryptionKey
  ? new PostgresApplicationRepository(
      postgres,
      new PostGameChatCipher(config.chatEncryptionKey, config.chatEncryptionKeyVersion)
    )
  : null;
if (postgres && !repository) throw new Error("CHAT_ENCRYPTION_KEY is required whenever DATABASE_URL is configured.");
let emailSender: EmailOtpSender;
if (config.authProvider === "mock") {
  emailSender = new MockEmailOtpSender();
} else if (config.authProvider === "disabled") {
  emailSender = { send: async () => { throw new Error("Email sign-in is disabled."); } };
} else {
  emailSender = new ResendEmailOtpSender(config.resendApiKey!, config.emailFrom!);
}
const auth = new AuthService(emailSender, store, {
  otpSecret: config.otpHashSecret,
  ...(config.authStateEpoch ? { stateEpoch: config.authStateEpoch } : {}),
  ...(config.authProvider === "mock" ? { fixedCode: config.mockOtpCode } : {})
}, repository ?? undefined);
const archive = repository ? new PostgresGameArchive(repository) : undefined;
const instanceId = `${config.appRevision.slice(0, 24)}-${randomUUID()}`;
// A single-server install retains replay events in its backed-up PostgreSQL
// database. Distributed production additionally requires the S3 export worker.
const replayBucket = replayBucketName(
  process.env.REPLAY_BUCKET,
  config.nodeEnv === "production" && postgres !== null && config.gameplayRuntimeMode === "distributed"
);
const replayExporter = postgres && replayBucket
  ? new ReplayExportWorker(
      new PostgresReplayExportLedger(postgres),
      new S3ReplayObjectStore(replayBucket),
      `${instanceId}:replay-export`,
      (error, matchId) => app.log.error({ err: error, matchId }, "Replay export failed")
    )
  : null;
replayExporter?.start();
let distributedMatchmaker: DistributedMatchmaker | null = null;
let distributedTransport: ValkeyDistributedGameTransport | null = null;
let distributedWorkers: DistributedRuntimeWorkers | null = null;
let leaseSupervisor: GameLeaseSupervisor | null = null;
if (config.gameplayRuntimeMode === "distributed") {
  if (!postgres || !repository || !archive) {
    throw new Error("The distributed gameplay runtime requires PostgreSQL, the application repository, and durable archival.");
  }
  const runtime = new PostgresDistributedGameRuntime(postgres);
  distributedTransport = new ValkeyDistributedGameTransport(redis, config.stateNamespace, instanceId, {
    onInstanceEnvelope: (envelope) => distributedMatchmaker!.onInstanceEnvelope(envelope),
    onPlayerMessage: (envelope) => distributedMatchmaker!.onPlayerMessage(envelope),
    onPublishedEvent: (envelope) => distributedMatchmaker!.onPublishedEvent(envelope),
    onInvalidEnvelope: (error, channel) => app.log.error({ err: error, channel }, "Invalid distributed gameplay envelope")
  });
  leaseSupervisor = new GameLeaseSupervisor(
    runtime,
    instanceId,
    30_000,
    (lease, error) => {
      metrics.recordLeaseLoss();
      app.log.error({ err: error, matchId: lease.matchId, fencingToken: lease.fencingToken }, "Game ownership lease lost");
    },
    (error) => app.log.error({ err: error }, "Game ownership renewal failed")
  );
  distributedMatchmaker = new DistributedMatchmaker(
    runtime,
    repository,
    distributedTransport,
    leaseSupervisor,
    instanceId,
    config.matchmakingRegion,
    (error) => app.log.error({ err: error }, "Distributed gameplay coordination failed"),
    metrics
  );
  distributedWorkers = new DistributedRuntimeWorkers(
    runtime,
    distributedTransport,
    `${instanceId}:worker`,
    (error) => app.log.error({ err: error }, "Distributed gameplay worker failed"),
    distributedRuntimeWorkerIntervalMs,
    10_000,
    {
      ownerInstanceId: instanceId,
      protocolVersion: distributedGameplayProtocolVersion,
      ownershipLeaseDurationMs: distributedOwnershipLeaseDurationMs,
      onOwnershipRecovered: (lease) => {
        leaseSupervisor!.track(lease);
        metrics.recordFenceRecovery();
      },
      observeOperationalMetrics: (snapshot) => metrics.observeDistributedRuntime(snapshot)
    }
  );
}
const matchmaker = distributedMatchmaker ?? new Matchmaker(
  store,
  (error) => app.log.error({ err: error }, "Could not persist match state"),
  archive
);
const hydrateState = (): Promise<void> => {
  if (stateHydrated) return Promise.resolve();
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    if (distributedTransport) await distributedTransport.start();
    await matchmaker.restore();
    if (leaseSupervisor) leaseSupervisor.start();
    if (distributedWorkers) distributedWorkers.start();
  })()
    .then(async () => {
      if (repository) {
        const waitingRooms = await repository.listWaitingPrivateRooms();
        await matchmaker.replaceWaitingPrivateRooms(waitingRooms.map(coordinatorPrivateRoom));
      }
    })
    .then(() => { stateHydrated = true; })
    .catch((error) => {
      app.log.error({ err: error }, "Could not restore match state");
    })
    .finally(() => { hydrationPromise = null; });
  return hydrationPromise;
};
redis.on("ready", () => {
  redisReady = true;
  if (!stateHydrated) void hydrateState();
  else void matchmaker.flush().catch((error) => app.log.error({ err: error }, "Could not flush gameplay state"));
});
redis.on("end", () => { redisReady = false; });
redis.on("error", (error) => app.log.warn({ err: error }, "Redis connection error"));
// Give local Redis a short opportunity to hydrate state before accepting traffic,
// but still expose liveness if the dependency is temporarily unavailable.
const redisStartup = redis.connect().then(hydrateState).catch((error) => {
  app.log.warn({ err: error }, "Redis connection attempt stopped");
});
await Promise.race([
  redisStartup,
  new Promise<void>((resolveStartup) => setTimeout(resolveStartup, 2_000))
]);

const requestOtpSchema = z.object({ email: z.string().trim().email().max(254) }).strict();
const verifyOtpSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  displayName: z.string().trim().min(2).max(24).optional()
}).strict();
const requestOtpEmailRateLimit = app.createRateLimit({
  max: config.authProvider === "resend" ? 5 : authRateLimits.requestOtpPerTenMinutes,
  timeWindow: "10 minutes",
  keyGenerator: (request) => {
    const parsed = requestOtpSchema.safeParse(request.body);
    if (!parsed.success) return `email-invalid:${request.ip}`;
    const emailDigest = createHash("sha256").update(normalizeEmail(parsed.data.email)).digest("hex");
    return `email:${emailDigest}`;
  }
});
const adminPasskeys = postgres && config.adminEmails.size > 0 && config.adminAccessSecret
  ? new AdminPasskeyService(
      new PostgresAdminPasskeyRepository(postgresClient!),
      store,
      {
        rpName: "TrinityMatrix Administration",
        rpId: config.adminWebauthnRpId,
        origin: config.adminWebauthnOrigin,
        bootstrapSecret: config.adminAccessSecret
      }
    )
  : null;

async function hasAdminAccess(request: FastifyRequest): Promise<boolean> {
  if (!adminPasskeys) return false;
  const session = await auth.getSession(request.cookies.rm_session);
  if (!session) return false;
  return adminPasskeys.hasAccess(session.id, session.playerId, request.cookies.rm_admin);
}

// Normal ceilings accommodate a full six-player household/NAT. Only the
// explicitly enabled, token-protected mock load stack raises them for thousands
// of isolated loopback identities; Resend ceilings are never relaxed.
app.post("/api/auth/request-otp", { config: { rateLimit: { max: authRateLimits.requestOtpPerTenMinutes, timeWindow: "10 minutes" } } }, async (request, reply) => {
  if (config.authProvider === "disabled") return reply.code(503).send({ error: "Email sign-in is not configured yet. Please try again later." });
  if (!redisReady || !stateHydrated) return reply.code(503).send({ error: "The game service is starting. Please retry shortly." });
  const parsed = requestOtpSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid email address." });
  const emailLimit = await requestOtpEmailRateLimit(request);
  if (!emailLimit.isAllowed && emailLimit.isExceeded) {
    reply.header("Retry-After", String(emailLimit.ttlInSeconds));
    return reply.code(429).send({ error: "Too many verification emails were requested. Please try again later." });
  }
  try {
    const challengeId = await auth.requestOtp(parsed.data.email);
    return reply.send({ challengeId, delivery: config.authProvider === "mock" ? "mock" : "email" });
  } catch (error) {
    app.log.error({ err: error }, "Could not deliver login OTP");
    return reply.code(502).send({ error: "We could not send the verification email. Please try again." });
  }
});

app.post("/api/auth/verify-otp", { config: { rateLimit: { max: authRateLimits.verifyOtpPerTenMinutes, timeWindow: "10 minutes" } } }, async (request, reply) => {
  if (config.authProvider === "disabled") return reply.code(503).send({ error: "Email sign-in is not configured yet. Please try again later." });
  if (!redisReady || !stateHydrated) return reply.code(503).send({ error: "The game service is starting. Please retry shortly." });
  const parsed = verifyOtpSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid 6-digit OTP." });
  const session = await auth.verifyOtp(parsed.data.challengeId, parsed.data.code, parsed.data.displayName);
  if (!session) return reply.code(401).send({ error: "The OTP is incorrect or expired." });
  reply.setCookie("rm_session", session.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: 12 * 60 * 60
  });
  return reply.send({ player: session.profile });
});

if (adminPasskeys) {
  await registerAdminPasskeyRoutes(app, {
    service: adminPasskeys,
    resolveSession: async (request) => auth.getSession(request.cookies.rm_session),
    adminEmails: config.adminEmails,
    cookieSecure: config.cookieSecure
  });
}

app.get("/api/session", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
  if (!redisReady || !stateHydrated) return reply.code(503).send({ error: "The game service is starting. Please retry shortly." });
  const session = await auth.getSession(request.cookies.rm_session);
  if (!session) return reply.code(401).send({ authenticated: false });
  const isAdmin = config.adminEmails.has(session.profile.email.toLowerCase());
  return reply.send({
    authenticated: true,
    player: session.profile,
    isAdmin,
    adminUnlocked: isAdmin && await hasAdminAccess(request)
  });
});

app.patch("/api/profile", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
  if (!redisReady || !stateHydrated) return reply.code(503).send({ error: "The game service is starting. Please retry shortly." });
  const parsed = profileUpdateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Check your display name, badge, and complete phone number." });
  const profile = await auth.updateProfile(request.cookies.rm_session, parsed.data);
  if (!profile) return reply.code(401).send({ error: "Your session expired. Please sign in again." });
  await matchmaker.updateProfile(profile.id, profile.displayName, profile.badgeId);
  return reply.send({ player: profile });
});

app.post("/api/auth/logout", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (request, reply) => {
  await adminPasskeys?.revokeAccess(request.cookies.rm_admin);
  await auth.deleteSession(request.cookies.rm_session);
  reply.clearCookie("rm_session", { path: "/" });
  reply.clearCookie("rm_admin", { path: "/" });
  return reply.code(204).send();
});

if (repository) {
  await registerDurableDataRoutes(app, {
    repository,
    resolveSession: async (request) => auth.getSession(request.cookies.rm_session),
    resolveAdminAccess: hasAdminAccess,
    onUserSuspended: (playerId) => matchmaker.suspendPlayer(playerId),
    publishPostGameChatMessage: ({ participantPlayerIds, gameName, message }) =>
      matchmaker.broadcastPostGameChat(participantPlayerIds, gameName, message),
    adminEmails: config.adminEmails
  });
  await registerPrivateMatchRoutes(app, {
    repository,
    matchmaker,
    resolveSession: async (request) => auth.getSession(request.cookies.rm_session),
    resolveAdminAccess: hasAdminAccess,
    adminEmails: config.adminEmails
  });
}

app.get("/healthz", async () => ({
  status: "ok",
  service: "trinitymatrix-web",
  version: config.appVersion
}));
app.get("/readyz", async (_request, reply) => {
  let postgresReady = postgres === null;
  if (postgres) {
    try {
      await postgres.query("SELECT 1");
      postgresReady = true;
    } catch {
      postgresReady = false;
    }
  }
  if (!shuttingDown && redisReady && stateHydrated && postgresReady) {
    return {
      status: "ready",
      dependencies: { redis: "ready", state: "hydrated", postgres: postgres ? "ready" : "disabled" }
    };
  }
  return reply.code(503).send({
    status: "not-ready",
    dependencies: {
      redis: redisReady ? "ready" : "not-ready",
      state: stateHydrated ? "hydrated" : "not-hydrated",
      postgres: postgresReady ? (postgres ? "ready" : "disabled") : "not-ready"
    },
    draining: shuttingDown
  });
});
app.get("/version", async () => ({
  service: "trinitymatrix-web",
  version: config.appVersion,
  revision: config.appRevision,
  buildTime: config.appBuildTime
}));
app.get("/policy-metadata.js", async (_request, reply) => reply
  .type("application/javascript; charset=utf-8")
  .send(serializePublicPolicyMetadataScript(config.publicPolicyMetadata)));

if (loadMetrics) {
  const authorizeLoadMetrics = (request: FastifyRequest): boolean => config.loadMetricsToken !== undefined
    && isLoadMetricsRequestAuthorized(request.headers.authorization, config.loadMetricsToken);
  app.get("/internal/load-metrics", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!authorizeLoadMetrics(request)) return reply.code(401).send({ error: "Authentication required." });
    return reply.send(loadMetrics.snapshot());
  });
  app.post("/internal/load-metrics/reset", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!authorizeLoadMetrics(request)) return reply.code(401).send({ error: "Authentication required." });
    loadMetrics.reset();
    return reply.code(204).send();
  });
}

app.get("/ws", { websocket: true }, (socket, request) => {
  let socketTracked = false;
  void (async () => {
    const origin = request.headers.origin;
    if (!origin || !config.allowedOrigins.has(origin)) {
      loadMetrics?.recordWebSocketRejected();
      socket.close(1008, "Origin not allowed");
      return;
    }
    if (!redisReady || !stateHydrated) {
      loadMetrics?.recordWebSocketRejected();
      socket.close(1013, "Game service is starting");
      return;
    }
    const session = await auth.getSession(request.cookies.rm_session);
    if (!session) {
      loadMetrics?.recordWebSocketRejected();
      socket.close(1008, "Authentication required");
      return;
    }
    loadMetrics?.recordWebSocketOpen();
    socketTracked = true;
    const inbound = new WebSocketInboundGuard({
      messagesPerSecond: config.webSocketMessageRatePerSecond,
      burst: config.webSocketMessageBurst,
      maxBufferedMessages: config.webSocketMaxBufferedMessages,
      onTaskError: (error) => app.log.error(
        { err: error, playerId: session.playerId },
        "Unexpected WebSocket inbound task failure"
      )
    });
    socket.on("close", (code) => {
      inbound.close();
      loadMetrics?.recordWebSocketClose(code);
      void Promise.resolve(matchmaker.disconnect(session.playerId, socket))
        .catch((error) => app.log.error({ err: error, playerId: session.playerId }, "Gameplay disconnect failed"));
    });
    socket.on("error", () => {
      inbound.close();
      loadMetrics?.recordWebSocketError();
      void Promise.resolve(matchmaker.disconnect(session.playerId, socket))
        .catch((error) => app.log.error({ err: error, playerId: session.playerId }, "Gameplay disconnect failed"));
    });
    socket.on("message", (data) => {
      const admission = inbound.enqueue(async () => {
        let message;
        try {
          message = parseClientMessage(JSON.parse(data.toString()));
        } catch {
          socket.send(JSON.stringify({ type: "error", code: "INVALID_MESSAGE", message: "The message was not valid." }));
          return;
        }
        const startedAt = performance.now();
        try {
          await matchmaker.handle(session.playerId, message);
          if (message.type.startsWith("game.")) {
            loadMetrics?.recordCommand(message.type, performance.now() - startedAt);
          }
        } catch (error) {
          if (message.type.startsWith("game.")) {
            loadMetrics?.recordCommand(message.type, performance.now() - startedAt, true);
          }
          app.log.error({ err: error, playerId: session.playerId, messageType: message.type }, "Gameplay message failed");
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "error", code: "GAMEPLAY_UNAVAILABLE", message: "The game service could not process that request safely." }));
          }
        }
      });
      if (admission === "rate-limited") {
        inbound.close();
        loadMetrics?.recordWebSocketRateLimitClose();
        socket.close(1008, "Message rate limit exceeded");
      } else if (admission === "backpressure") {
        inbound.close();
        loadMetrics?.recordWebSocketBackpressureClose();
        socket.close(1008, "Too many pending messages");
      }
    });
    // Install the inbound listener before registration can emit session.ready.
    // Mobile and scripted clients may enqueue immediately on that message.
    await matchmaker.register({
      playerId: session.playerId,
      email: session.profile.email,
      displayName: session.profile.displayName,
      badgeId: session.profile.badgeId,
      socket
    });
  })().catch((error) => {
    if (!socketTracked) loadMetrics?.recordWebSocketRejected();
    app.log.error({ err: error }, "WebSocket authentication failed");
    socket.close(1011, "Could not authenticate connection");
  });
});

const webDist = resolve(config.webDistPath ?? "../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    setHeaders(response, filePath) {
      if (filePath.endsWith("index.html") || filePath.endsWith("sw.js") || filePath.endsWith("manifest.webmanifest")) {
        response.header("Cache-Control", "no-cache");
      } else if (filePath.includes("/assets/")) {
        response.header("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  });
  app.setNotFoundHandler((request, reply) => {
    // Never disguise an unavailable or misspelled API route as a successful
    // SPA navigation. Besides being misleading, index.html can be revalidated
    // as a bodyless 304 and crash JSON consumers during retry loops.
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "The API endpoint was not found." });
    }
    return reply.sendFile("index.html");
  });
}

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: NodeJS.Signals): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    shuttingDown = true;
    app.log.info({ signal }, "Graceful shutdown started");
    const forcedExit = setTimeout(() => {
      app.log.fatal({ signal }, "Graceful shutdown deadline exceeded");
      process.exit(1);
    }, config.shutdownGracePeriodMs);
    forcedExit.unref();

    try {
      // Finish any already-claimed outbox/deadline pass before closing the
      // Valkey transport or PostgreSQL pool it may still be using.
      if (distributedWorkers) await distributedWorkers.drain();
      if (leaseSupervisor) await leaseSupervisor.drain();
      await matchmaker.shutdown();
      await app.close();
      await matchmaker.flush();
      if (distributedTransport) await distributedTransport.close();
      if (replayExporter) await replayExporter.stop();
      cloudWatchMetrics?.stop();
      if (redis.isOpen) await redis.quit();
      if (postgres) await postgres.end();
      clearTimeout(forcedExit);
      app.log.info({ signal }, "Graceful shutdown completed");
    } catch (error) {
      clearTimeout(forcedExit);
      app.log.error({ err: error, signal }, "Graceful shutdown failed");
      process.exitCode = 1;
    } finally {
      cloudWatchMetrics?.stop();
      metrics.close();
    }
  })();
  return shutdownPromise;
};
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

await app.listen({ port: config.port, host: config.host });
