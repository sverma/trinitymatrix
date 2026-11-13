import { describe, expect, it } from "vitest";
import { assertServerAuthConfig, authIpRateLimits, loadRuntimeConfig } from "./config";

describe("runtime configuration", () => {
  it("requires durable single-instance broadcasts and a distinct private video credential", () => {
    expect(loadRuntimeConfig({}).broadcastsEnabled).toBe(false);
    expect(loadRuntimeConfig({ BROADCAST_MEDIA_SECRET: "", BROADCAST_MEDIA_URL: "" }).broadcastMediaEnabled).toBe(false);
    expect(() => loadRuntimeConfig({ BROADCASTS_ENABLED: "true" })).toThrow("PostgreSQL");
    const database = { DATABASE_URL: "postgresql://db/trinity", BROADCASTS_ENABLED: "true" };
    expect(() => loadRuntimeConfig({ ...database, GAMEPLAY_RUNTIME_MODE: "distributed", DURABLE_DATA_REQUIRED: "true" })).toThrow("single");
    expect(() => loadRuntimeConfig({ ...database, BROADCAST_MEDIA_ENABLED: "true" })).toThrow("Broadcast video requires");
    expect(() => loadRuntimeConfig({ ...database, BROADCAST_MEDIA_SECRET: "short" })).toThrow();
    expect(() => loadRuntimeConfig({ ...database, BROADCAST_MEDIA_URL: "file:///private" })).toThrow();
    expect(() => loadRuntimeConfig({ ...database, BROADCAST_MAX_VIDEO_STREAMS: "5" })).toThrow();
    const config = loadRuntimeConfig({ ...database, BROADCAST_MEDIA_ENABLED: "true", BROADCAST_MEDIA_URL: "http://media:8082", BROADCAST_MEDIA_SECRET: "a-private-media-secret-with-at-least-32-characters" });
    expect(config.broadcastMediaEnabled).toBe(true);
    expect(config.broadcastMaxVideoStreams).toBe(1);
  });
  it("keeps AI opt-in and caps its shared daily budget at the approved amount", () => {
    const defaults = loadRuntimeConfig({ OPENROUTER_API_KEY: "" });
    expect(defaults.aiPlayersEnabled).toBe(false);
    expect(defaults.aiDailyBudgetUsd).toBe(10);
    expect(() => loadRuntimeConfig({ AI_DAILY_BUDGET_USD: "10.01" })).toThrow("AI_DAILY_BUDGET_USD");
    expect(() => loadRuntimeConfig({ AI_DAILY_BUDGET_USD: "0" })).toThrow("AI_DAILY_BUDGET_USD");
    expect(() => loadRuntimeConfig({ AI_PLAYERS_ENABLED: "true" })).toThrow("requires PostgreSQL");
    expect(() => loadRuntimeConfig({ AI_PLAYERS_ENABLED: "true", DATABASE_URL: "postgresql://db/trinity", GAMEPLAY_RUNTIME_MODE: "distributed", DURABLE_DATA_REQUIRED: "true" }))
      .toThrow("single-instance");
    expect(loadRuntimeConfig({ AI_PLAYERS_ENABLED: "true", DATABASE_URL: "postgresql://db/trinity", AI_DAILY_BUDGET_USD: "2.50" }).aiDailyBudgetUsd).toBe(2.5);
  });
  it("preserves loopback defaults for local development", () => {
    const config = loadRuntimeConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8181);
    expect(config.cookieSecure).toBe(false);
    expect(config.loadMetricsEnabled).toBe(false);
    expect(config.loadMetricsToken).toBeUndefined();
    expect(config.cloudWatchEmfEnabled).toBe(false);
    expect(config.appReplicaCount).toBe(1);
    expect(config.gameplayRuntimeMode).toBe("single");
    expect(config.webSocketMessageRatePerSecond).toBe(10);
    expect(config.webSocketMessageBurst).toBe(20);
    expect(config.webSocketMaxBufferedMessages).toBe(8);
    expect(config.allowedOrigins).toEqual(new Set(["http://127.0.0.1:8180", "http://localhost:8180"]));
  });

  it("requires the durable runtime instead of allowing a process-local matchmaker across replicas", () => {
    expect(() => loadRuntimeConfig({ APP_REPLICA_COUNT: "2" })).toThrow(
      "requires GAMEPLAY_RUNTIME_MODE=distributed"
    );
    expect(() => loadRuntimeConfig({
      APP_REPLICA_COUNT: "2",
      GAMEPLAY_RUNTIME_MODE: "distributed"
    })).toThrow("requires DATABASE_URL and DURABLE_DATA_REQUIRED=true");
    expect(loadRuntimeConfig({
      APP_REPLICA_COUNT: "2",
      GAMEPLAY_RUNTIME_MODE: "distributed",
      DATABASE_URL: "postgresql://database.internal/trinitymatrix",
      DURABLE_DATA_REQUIRED: "true"
    }).gameplayRuntimeMode).toBe("distributed");
  });

  it("binds production containers on all interfaces and enables secure cookies", () => {
    const config = loadRuntimeConfig({ NODE_ENV: "production" });
    expect(config.host).toBe("0.0.0.0");
    expect(config.cookieSecure).toBe(true);
    expect(config.durableDataRequired).toBe(false);
    expect(config.publicPolicyMetadata.publicationApproved).toBe(false);
  });

  it("fails closed when policy publication is asserted without complete legal facts", () => {
    expect(() => loadRuntimeConfig({ LEGAL_PUBLICATION_APPROVED: "true" }))
      .toThrow("Invalid approved public policy metadata");
    expect(() => loadRuntimeConfig({ LEGAL_PUBLICATION_APPROVED: "yes" }))
      .toThrow();
  });

  it("fails closed when durable data is required without PostgreSQL", () => {
    expect(() => loadRuntimeConfig({ DURABLE_DATA_REQUIRED: "true" })).toThrow(
      "DURABLE_DATA_REQUIRED=true requires DATABASE_URL"
    );
  });

  it("accepts an exact HTTPS deployment origin and a bounded proxy hop count", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://play.example.com/",
      TRUST_PROXY: "2"
    });
    expect(config.allowedOrigins).toEqual(new Set(["https://play.example.com"]));
    expect(config.trustedProxyHops).toBe(2);
    expect(typeof config.trustProxy).toBe("function");
  });

  it("rejects origin paths and insecure public production cookies", () => {
    expect(() => loadRuntimeConfig({ ALLOWED_ORIGINS: "https://play.example.com/game" })).toThrow("exact origins");
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      COOKIE_SECURE: "false",
      ALLOWED_ORIGINS: "https://play.example.com"
    })).toThrow("COOKIE_SECURE=false");
  });

  it("requires complete Resend credentials", () => {
    expect(() => loadRuntimeConfig({ AUTH_PROVIDER: "resend" })).toThrow("AUTH_PROVIDER=resend requires");
    expect(() => loadRuntimeConfig({
      AUTH_PROVIDER: "resend",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "TrinityMatrix <login@example.com>",
      OTP_HASH_SECRET: "a-long-test-only-otp-hashing-secret"
    })).toThrow("AUTH_STATE_EPOCH");
    expect(loadRuntimeConfig({
      AUTH_PROVIDER: "resend",
      AUTH_STATE_EPOCH: "resend-2026-08-28",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "TrinityMatrix <login@example.com>",
      OTP_HASH_SECRET: "a-long-test-only-otp-hashing-secret"
    }).authStateEpoch).toBe("resend-2026-08-28");
    expect(() => loadRuntimeConfig({ AUTH_STATE_EPOCH: "invalid:*" })).toThrow("AUTH_STATE_EPOCH");
  });

  it("refuses to start a production-mode public server with mock authentication", () => {
    expect(() => assertServerAuthConfig(loadRuntimeConfig({ NODE_ENV: "production" }))).toThrow(
      "refuses AUTH_PROVIDER=mock"
    );
    expect(() => assertServerAuthConfig(loadRuntimeConfig({
      NODE_ENV: "development",
      AUTH_PROVIDER: "mock"
    }))).not.toThrow();
  });

  it("can serve a production installation with sign-in explicitly disabled before email is configured", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "production",
      AUTH_PROVIDER: "disabled",
      RESEND_API_KEY: "",
      EMAIL_FROM: "",
      DATABASE_URL: "postgresql://app:secret@postgres:5432/trinitymatrix",
      CHAT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64")
    });
    expect(config.authProvider).toBe("disabled");
    expect(config.cookieSecure).toBe(true);
    expect(config.adminEmails.size).toBe(0);
    expect(() => assertServerAuthConfig(config)).not.toThrow();
  });

  it("rejects an unbounded production proxy trust setting", () => {
    expect(() => loadRuntimeConfig({ NODE_ENV: "production", TRUST_PROXY: "true" })).toThrow("too broad");
  });

  it("uses verified TLS for production PostgreSQL connections", () => {
    const config = loadRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@database.internal:5432/trinitymatrix",
      CHAT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ADMIN_EMAILS: "admin@example.com",
      ADMIN_ACCESS_SECRET: "a-secure-admin-access-secret"
    });
    expect(config.databaseSslMode).toBe("verify-full");
    expect(config.databasePoolMax).toBe(5);
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://database.internal/trinitymatrix",
      DATABASE_SSL_MODE: "disable",
      CHAT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ADMIN_EMAILS: "admin@example.com",
      ADMIN_ACCESS_SECRET: "a-secure-admin-access-secret"
    })).toThrow("require DATABASE_SSL_MODE=verify-full");
  });

  it("requires a canonical 256-bit chat key with production persistence", () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://database.internal/trinitymatrix",
      ADMIN_ACCESS_SECRET: "a-secure-admin-access-secret"
    })).toThrow("CHAT_ENCRYPTION_KEY");
    expect(() => loadRuntimeConfig({ CHAT_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow("32 random bytes");
  });

  it("requires a second admin access factor in production", () => {
    expect(() => loadRuntimeConfig({
      NODE_ENV: "production",
      ADMIN_EMAILS: "admin@example.com"
    })).toThrow("ADMIN_ACCESS_SECRET");
  });

  it("requires an exact HTTPS passkey origin and RP ID for the production admin", () => {
    const environment = {
      NODE_ENV: "production",
      AUTH_PROVIDER: "resend",
      AUTH_STATE_EPOCH: "production-v1",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "TrinityMatrix <login@example.com>",
      OTP_HASH_SECRET: "a-long-test-only-otp-hashing-secret",
      DATABASE_URL: "postgresql://app:secret@database.internal:5432/trinitymatrix",
      CHAT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ADMIN_EMAILS: "admin@example.com",
      ADMIN_ACCESS_SECRET: "a-secure-admin-access-secret",
      ALLOWED_ORIGINS: "https://play.example.com,https://admin.example.com",
      ADMIN_WEBAUTHN_RP_ID: "admin.example.com",
      ADMIN_WEBAUTHN_ORIGIN: "https://admin.example.com"
    } as const;
    expect(() => assertServerAuthConfig(loadRuntimeConfig(environment))).not.toThrow();
    expect(() => assertServerAuthConfig(loadRuntimeConfig({
      ...environment,
      ADMIN_WEBAUTHN_ORIGIN: "http://admin.example.com",
      ALLOWED_ORIGINS: "https://play.example.com,http://admin.example.com"
    }))).toThrow("exact HTTPS origin");
    expect(() => assertServerAuthConfig(loadRuntimeConfig({
      ...environment,
      ADMIN_WEBAUTHN_ORIGIN: "https://other.example.com",
      ALLOWED_ORIGINS: "https://play.example.com,https://other.example.com"
    }))).toThrow("ADMIN_WEBAUTHN_RP_ID");
  });

  it("rejects non-PostgreSQL database URLs and oversized pools", () => {
    expect(() => loadRuntimeConfig({ DATABASE_URL: "mysql://database.internal/trinitymatrix" })).toThrow("DATABASE_URL");
    expect(() => loadRuntimeConfig({ DATABASE_POOL_MAX: "50" })).toThrow("DATABASE_POOL_MAX");
  });

  it("keeps load-test metrics opt-in and requires a strong bearer token", () => {
    expect(() => loadRuntimeConfig({ LOAD_METRICS_ENABLED: "true" })).toThrow("LOAD_METRICS_TOKEN");
    expect(() => loadRuntimeConfig({
      LOAD_METRICS_ENABLED: "true",
      LOAD_METRICS_TOKEN: "too-short"
    })).toThrow("LOAD_METRICS_TOKEN");
    expect(() => loadRuntimeConfig({
      LOAD_METRICS_ENABLED: "true",
      LOAD_METRICS_TOKEN: "invalid load test token with whitespace"
    })).toThrow("cannot contain whitespace");
    const config = loadRuntimeConfig({
      LOAD_METRICS_ENABLED: "true",
      LOAD_METRICS_TOKEN: "local-load-test-token-with-32-characters"
    });
    expect(config.loadMetricsEnabled).toBe(true);
    expect(config.loadMetricsToken).toBe("local-load-test-token-with-32-characters");
  });

  it("enables CloudWatch EMF independently of the protected load-test endpoint", () => {
    const config = loadRuntimeConfig({ CLOUDWATCH_EMF_ENABLED: "true" });
    expect(config.cloudWatchEmfEnabled).toBe(true);
    expect(config.loadMetricsEnabled).toBe(false);
    expect(config.loadMetricsToken).toBeUndefined();
  });

  it("accepts bounded WebSocket abuse-control overrides", () => {
    const config = loadRuntimeConfig({
      WEBSOCKET_MESSAGE_RATE_PER_SECOND: "25",
      WEBSOCKET_MESSAGE_BURST: "40",
      WEBSOCKET_MAX_BUFFERED_MESSAGES: "12"
    });
    expect(config.webSocketMessageRatePerSecond).toBe(25);
    expect(config.webSocketMessageBurst).toBe(40);
    expect(config.webSocketMaxBufferedMessages).toBe(12);
    expect(() => loadRuntimeConfig({ WEBSOCKET_MESSAGE_RATE_PER_SECOND: "0" })).toThrow("WEBSOCKET_MESSAGE_RATE_PER_SECOND");
    expect(() => loadRuntimeConfig({ WEBSOCKET_MESSAGE_BURST: "2001" })).toThrow("WEBSOCKET_MESSAGE_BURST");
    expect(() => loadRuntimeConfig({ WEBSOCKET_MAX_BUFFERED_MESSAGES: "129" })).toThrow("WEBSOCKET_MAX_BUFFERED_MESSAGES");
  });

  it("raises auth ceilings only for the explicit mock-auth load stack", () => {
    const loadToken = "local-load-test-token-with-32-characters";
    expect(authIpRateLimits(loadRuntimeConfig({ AUTH_PROVIDER: "mock" }))).toEqual({
      requestOtpPerTenMinutes: 300,
      verifyOtpPerTenMinutes: 60
    });
    expect(authIpRateLimits(loadRuntimeConfig({
      AUTH_PROVIDER: "mock",
      LOAD_METRICS_ENABLED: "true",
      LOAD_METRICS_TOKEN: loadToken
    }))).toEqual({
      requestOtpPerTenMinutes: 10_000,
      verifyOtpPerTenMinutes: 10_000
    });
    expect(authIpRateLimits(loadRuntimeConfig({
      AUTH_PROVIDER: "resend",
      AUTH_STATE_EPOCH: "load-test",
      OTP_HASH_SECRET: "a-long-test-only-otp-hashing-secret",
      RESEND_API_KEY: "re_test",
      EMAIL_FROM: "TrinityMatrix <login@example.com>",
      LOAD_METRICS_ENABLED: "true",
      LOAD_METRICS_TOKEN: loadToken
    }))).toEqual({
      requestOtpPerTenMinutes: 30,
      verifyOtpPerTenMinutes: 60
    });
  });
});
