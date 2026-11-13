import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const localRunId = process.env.TRINITY_E2E_RUN_ID ?? String(Date.now());
const localAdminEmail = process.env.TRINITY_E2E_ADMIN_EMAIL ?? `admin-e2e-${localRunId}@example.test`;
const localAdminBootstrapSecret = process.env.TRINITY_E2E_ADMIN_BOOTSTRAP_SECRET
  ?? "local-e2e-admin-bootstrap-secret";

if (!externalBaseUrl) {
  // The browser test and the spawned server share these run-scoped values.
  // A fresh allowlisted identity avoids reusing a credential from a previous
  // PostgreSQL-backed run while still exercising the real WebAuthn verifier.
  process.env.TRINITY_E2E_RUN_ID = localRunId;
  process.env.TRINITY_E2E_ADMIN_EMAIL = localAdminEmail;
  process.env.TRINITY_E2E_ADMIN_BOOTSTRAP_SECRET = localAdminBootstrapSecret;
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: externalBaseUrl ?? "http://localhost:8180",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] }, grep: /responsive (lobby|game)/ }
  ],
  webServer: externalBaseUrl ? undefined : {
    command: "npm run build && node apps/server/dist/index.js",
    env: {
      PORT: "8180",
      HOST: "127.0.0.1",
      WEB_DIST_PATH: fileURLToPath(new URL("./apps/web/dist", import.meta.url)),
      STATE_NAMESPACE: `trinitymatrix:e2e:${localRunId}`,
      DATABASE_URL: process.env.TRINITY_E2E_DATABASE_URL
        ?? "postgresql://trinitymatrix:trinitymatrix@127.0.0.1:5433/trinitymatrix",
      DATABASE_SSL_MODE: "disable",
      DURABLE_DATA_REQUIRED: "true",
      BROADCASTS_ENABLED: process.env.TRINITY_E2E_BROADCASTS ?? "false",
      BROADCAST_MEDIA_ENABLED: process.env.TRINITY_E2E_BROADCASTS ?? "false",
      BROADCAST_MEDIA_URL: process.env.BROADCAST_MEDIA_URL ?? "http://127.0.0.1:8182",
      BROADCAST_MEDIA_SECRET: process.env.BROADCAST_MEDIA_SECRET ?? "local-media-secret-for-development-only",
      CHAT_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      CHAT_ENCRYPTION_KEY_VERSION: "1",
      ADMIN_EMAILS: localAdminEmail,
      ADMIN_ACCESS_SECRET: localAdminBootstrapSecret,
      ADMIN_WEBAUTHN_RP_ID: "localhost",
      ADMIN_WEBAUTHN_ORIGIN: "http://localhost:8180",
      LOG_LEVEL: "warn",
      ALLOWED_ORIGINS: "http://127.0.0.1:8180,http://localhost:8180"
    },
    url: "http://127.0.0.1:8180/readyz",
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe"
  }
});
