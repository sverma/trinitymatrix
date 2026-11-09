import { z } from "zod";
import { loadPublicPolicyMetadata } from "./public-policy-metadata";

const booleanString = z.enum(["true", "false"]);
const portValue = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(65_535)
);
const positiveMilliseconds = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1_000).max(60_000)
);
const redisUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "redis:" || protocol === "rediss:";
}, "REDIS_URL must use redis:// or rediss://");
const postgresUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}, "DATABASE_URL must use postgres:// or postgresql://");
const poolSize = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(20)
);
const replicaCount = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(100)
);
const chatEncryptionKey = z.string().trim().refine((value) => {
  try {
    return Buffer.from(value, "base64").length === 32 && Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}, "CHAT_ENCRYPTION_KEY must be the canonical base64 encoding of exactly 32 random bytes");
const keyVersion = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(32_767)
);
const webSocketMessageRate = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(1_000)
);
const webSocketMessageBurst = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(2_000)
);
const webSocketBufferedMessages = z.preprocess(
  (value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
  z.number().int().min(1).max(128)
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: portValue.default(8181),
  HOST: z.string().trim().min(1).optional(),
  REDIS_URL: redisUrl.default("redis://127.0.0.1:6379"),
  STATE_NAMESPACE: z.string().trim().regex(/^[a-zA-Z0-9:_-]+$/).default("trinitymatrix:v1"),
  DATABASE_URL: postgresUrl.optional(),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).optional(),
  DATABASE_SSL_CA: z.string().min(1).optional(),
  DATABASE_POOL_MAX: poolSize.default(5),
  APP_REPLICA_COUNT: replicaCount.default(1),
  GAMEPLAY_RUNTIME_MODE: z.enum(["single", "distributed"]).default("single"),
  MATCHMAKING_REGION: z.string().trim().regex(/^[a-z0-9-]{2,32}$/).default("ap-south-1"),
  DURABLE_DATA_REQUIRED: booleanString.default("false"),
  CHAT_ENCRYPTION_KEY: chatEncryptionKey.optional(),
  CHAT_ENCRYPTION_KEY_VERSION: keyVersion.default(1),
  ADMIN_EMAILS: z.string().default(""),
  ADMIN_ACCESS_SECRET: z.string().min(16).optional(),
  ADMIN_WEBAUTHN_RP_ID: z.string().trim().regex(/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})$/).optional(),
  ADMIN_WEBAUTHN_ORIGIN: z.string().trim().url().optional(),
  AUTH_PROVIDER: z.enum(["mock", "resend", "disabled"]).default("mock"),
  AUTH_STATE_EPOCH: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).optional(),
  MOCK_OTP_CODE: z.string().regex(/^\d{6}$/).default("123456"),
  OTP_HASH_SECRET: z.string().min(32).optional(),
  RESEND_API_KEY: z.string().trim().min(1).optional().or(z.literal("")),
  EMAIL_FROM: z.string().trim().min(3).optional().or(z.literal("")),
  COOKIE_SECURE: booleanString.optional(),
  ALLOWED_ORIGINS: z.string().trim().min(1).default("http://127.0.0.1:8180,http://localhost:8180"),
  TRUST_PROXY: z.string().regex(/^(?:true|false|[1-9]\d*)$/).default("false"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  WEB_DIST_PATH: z.string().trim().min(1).optional(),
  APP_VERSION: z.string().trim().min(1).default("development"),
  APP_REVISION: z.string().trim().min(1).default("unknown"),
  APP_BUILD_TIME: z.string().trim().min(1).default("unknown"),
  LOAD_METRICS_ENABLED: booleanString.default("false"),
  LOAD_METRICS_TOKEN: z.string().min(32).regex(/^\S+$/, "LOAD_METRICS_TOKEN cannot contain whitespace").optional(),
  CLOUDWATCH_EMF_ENABLED: booleanString.default("false"),
  WEBSOCKET_MESSAGE_RATE_PER_SECOND: webSocketMessageRate.default(10),
  WEBSOCKET_MESSAGE_BURST: webSocketMessageBurst.default(20),
  WEBSOCKET_MAX_BUFFERED_MESSAGES: webSocketBufferedMessages.default(8),
  SHUTDOWN_GRACE_PERIOD_MS: positiveMilliseconds.default(10_000)
}).passthrough();

const localOrigins = new Set(["http://127.0.0.1:8180", "http://localhost:8180"]);

function parseAllowedOrigins(value: string): ReadonlySet<string> {
  const origins = value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const parsed = new URL(entry);
    if (!(["http:", "https:"] as string[]).includes(parsed.protocol)) {
      throw new Error(`ALLOWED_ORIGINS contains an unsupported protocol: ${entry}`);
    }
    if (parsed.origin !== entry.replace(/\/$/, "") || parsed.username || parsed.password) {
      throw new Error(`ALLOWED_ORIGINS entries must be exact origins without paths, credentials, queries, or fragments: ${entry}`);
    }
    return parsed.origin;
  });
  if (origins.length === 0) throw new Error("ALLOWED_ORIGINS must contain at least one exact origin.");
  return new Set(origins);
}

function parseTrustProxy(value: string): { trustProxy: boolean | ((address: string, hop: number) => boolean); trustedProxyHops: number | null } {
  if (value === "true") return { trustProxy: true, trustedProxyHops: null };
  if (value === "false") return { trustProxy: false, trustedProxyHops: null };
  const trustedProxyHops = Number(value);
  return {
    trustProxy: (_address: string, hop: number) => hop <= trustedProxyHops,
    trustedProxyHops
  };
}

export type RuntimeConfig = ReturnType<typeof loadRuntimeConfig>;

export function authIpRateLimits(config: Pick<RuntimeConfig, "authProvider" | "loadMetricsEnabled">) {
  if (config.authProvider === "mock" && config.loadMetricsEnabled) {
    return { requestOtpPerTenMinutes: 10_000, verifyOtpPerTenMinutes: 10_000 } as const;
  }
  return {
    requestOtpPerTenMinutes: config.authProvider === "mock" ? 300 : 30,
    verifyOtpPerTenMinutes: 60
  } as const;
}

/**
 * Apply checks that are specific to the public HTTP/WebSocket server. Database
 * migration CLIs also load RuntimeConfig, so public-auth policy does not belong
 * in the shared parser.
 */
export function assertServerAuthConfig(config: RuntimeConfig): void {
  if (config.nodeEnv === "production" && config.authProvider === "mock") {
    throw new Error("The public production-mode server refuses AUTH_PROVIDER=mock.");
  }
  if (config.nodeEnv === "production" && config.adminEmails.size > 0) {
    if (!config.databaseUrl || !config.adminAccessSecret || !config.adminWebauthnRpId || !config.adminWebauthnOrigin) {
      throw new Error(
        "Production administration requires PostgreSQL, ADMIN_ACCESS_SECRET bootstrap recovery, ADMIN_WEBAUTHN_RP_ID, and ADMIN_WEBAUTHN_ORIGIN."
      );
    }
    const origin = new URL(config.adminWebauthnOrigin);
    if (origin.protocol !== "https:" || origin.hostname !== config.adminWebauthnRpId || origin.origin !== config.adminWebauthnOrigin) {
      throw new Error("Production ADMIN_WEBAUTHN_ORIGIN must be the exact HTTPS origin for ADMIN_WEBAUTHN_RP_ID.");
    }
    if (!config.allowedOrigins.has(config.adminWebauthnOrigin)) {
      throw new Error("ADMIN_WEBAUTHN_ORIGIN must also be present in ALLOWED_ORIGINS.");
    }
  }
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv) {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid runtime environment: ${details}`);
  }

  const env = parsed.data;
  const publicPolicyMetadata = loadPublicPolicyMetadata(environment);
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const proxyConfig = parseTrustProxy(env.TRUST_PROXY);
  const cookieSecure = env.COOKIE_SECURE === undefined
    ? env.NODE_ENV === "production"
    : env.COOKIE_SECURE === "true";
  const otpHashSecret = env.OTP_HASH_SECRET
    ?? (env.AUTH_PROVIDER === "mock" ? "local-trinitymatrix-otp-secret-change-me" : undefined);

  if (env.AUTH_PROVIDER === "resend" && (!env.RESEND_API_KEY || !env.EMAIL_FROM || !otpHashSecret || !env.AUTH_STATE_EPOCH)) {
    throw new Error("AUTH_PROVIDER=resend requires RESEND_API_KEY, EMAIL_FROM, OTP_HASH_SECRET (at least 32 characters), and an explicit AUTH_STATE_EPOCH.");
  }
  if (env.NODE_ENV === "production" && !cookieSecure && [...allowedOrigins].some((origin) => !localOrigins.has(origin))) {
    throw new Error("COOKIE_SECURE=false is only permitted for the documented localhost origins in production mode.");
  }
  if (env.NODE_ENV === "production" && env.TRUST_PROXY === "true") {
    throw new Error("TRUST_PROXY=true is too broad for production; configure the exact trusted hop count instead.");
  }
  const databaseSslMode = env.DATABASE_SSL_MODE
    ?? (env.NODE_ENV === "production" ? "verify-full" : "disable");
  if (env.NODE_ENV === "production" && env.DATABASE_URL && databaseSslMode !== "verify-full") {
    throw new Error("Production DATABASE_URL connections require DATABASE_SSL_MODE=verify-full.");
  }
  if (env.NODE_ENV === "production" && env.DATABASE_URL && !env.CHAT_ENCRYPTION_KEY) {
    throw new Error("Production PostgreSQL persistence requires CHAT_ENCRYPTION_KEY (32 random bytes encoded as base64).");
  }
  const adminEmails = new Set(env.ADMIN_EMAILS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
  if ([...adminEmails].some((email) => !z.string().email().safeParse(email).success)) {
    throw new Error("ADMIN_EMAILS must contain comma-separated valid email addresses.");
  }
  if (env.NODE_ENV === "production" && env.DATABASE_URL && env.AUTH_PROVIDER !== "disabled" && adminEmails.size === 0) {
    throw new Error("Production durable-data administration requires at least one ADMIN_EMAILS entry.");
  }
  if (env.NODE_ENV === "production" && adminEmails.size > 0 && !env.ADMIN_ACCESS_SECRET) {
    throw new Error("Production administration requires ADMIN_ACCESS_SECRET for one-time passkey bootstrap and recovery protection.");
  }
  const localAdminOrigin = [...allowedOrigins][0]!;
  const adminWebauthnOrigin = env.ADMIN_WEBAUTHN_ORIGIN ?? localAdminOrigin;
  const adminWebauthnRpId = env.ADMIN_WEBAUTHN_RP_ID ?? new URL(adminWebauthnOrigin).hostname;
  if (env.DURABLE_DATA_REQUIRED === "true" && !env.DATABASE_URL) {
    throw new Error("DURABLE_DATA_REQUIRED=true requires DATABASE_URL.");
  }
  if (env.LOAD_METRICS_ENABLED === "true" && !env.LOAD_METRICS_TOKEN) {
    throw new Error("LOAD_METRICS_ENABLED=true requires LOAD_METRICS_TOKEN with at least 32 characters.");
  }
  if (env.APP_REPLICA_COUNT > 1 && env.GAMEPLAY_RUNTIME_MODE !== "distributed") {
    throw new Error("APP_REPLICA_COUNT above 1 requires GAMEPLAY_RUNTIME_MODE=distributed.");
  }
  if (env.GAMEPLAY_RUNTIME_MODE === "distributed" && (!env.DATABASE_URL || env.DURABLE_DATA_REQUIRED !== "true")) {
    throw new Error(
      "GAMEPLAY_RUNTIME_MODE=distributed requires DATABASE_URL and DURABLE_DATA_REQUIRED=true."
    );
  }

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST ?? (env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
    redisUrl: env.REDIS_URL,
    stateNamespace: env.STATE_NAMESPACE,
    databaseUrl: env.DATABASE_URL,
    databaseSslMode,
    databaseSslCa: env.DATABASE_SSL_CA,
    databasePoolMax: env.DATABASE_POOL_MAX,
    appReplicaCount: env.APP_REPLICA_COUNT,
    gameplayRuntimeMode: env.GAMEPLAY_RUNTIME_MODE,
    matchmakingRegion: env.MATCHMAKING_REGION,
    durableDataRequired: env.DURABLE_DATA_REQUIRED === "true",
    chatEncryptionKey: env.CHAT_ENCRYPTION_KEY,
    chatEncryptionKeyVersion: env.CHAT_ENCRYPTION_KEY_VERSION,
    adminEmails,
    adminAccessSecret: env.ADMIN_ACCESS_SECRET,
    adminWebauthnRpId,
    adminWebauthnOrigin,
    authProvider: env.AUTH_PROVIDER,
    authStateEpoch: env.AUTH_STATE_EPOCH,
    mockOtpCode: env.MOCK_OTP_CODE,
    otpHashSecret: otpHashSecret ?? "",
    resendApiKey: env.RESEND_API_KEY,
    emailFrom: env.EMAIL_FROM,
    publicPolicyMetadata,
    cookieSecure,
    allowedOrigins,
    ...proxyConfig,
    logLevel: env.LOG_LEVEL,
    webDistPath: env.WEB_DIST_PATH,
    appVersion: env.APP_VERSION,
    appRevision: env.APP_REVISION,
    appBuildTime: env.APP_BUILD_TIME,
    loadMetricsEnabled: env.LOAD_METRICS_ENABLED === "true",
    loadMetricsToken: env.LOAD_METRICS_TOKEN,
    cloudWatchEmfEnabled: env.CLOUDWATCH_EMF_ENABLED === "true",
    webSocketMessageRatePerSecond: env.WEBSOCKET_MESSAGE_RATE_PER_SECOND,
    webSocketMessageBurst: env.WEBSOCKET_MESSAGE_BURST,
    webSocketMaxBufferedMessages: env.WEBSOCKET_MAX_BUFFERED_MESSAGES,
    shutdownGracePeriodMs: env.SHUTDOWN_GRACE_PERIOD_MS
  } as const;
}
