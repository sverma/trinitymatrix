import { Pool, type PoolConfig } from "pg";
import type { RuntimeConfig } from "../config";

export type DatabaseConfig = Pick<
  RuntimeConfig,
  "databaseUrl" | "databaseSslMode" | "databaseSslCa" | "databasePoolMax"
>;

export function createPostgresPool(config: DatabaseConfig, applicationName = "trinitymatrix-server"): Pool {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL operations.");

  const ssl: PoolConfig["ssl"] = config.databaseSslMode === "disable"
    ? false
    : {
        rejectUnauthorized: config.databaseSslMode === "verify-full",
        ...(config.databaseSslCa ? { ca: config.databaseSslCa } : {})
      };

  return new Pool({
    connectionString: config.databaseUrl,
    ssl,
    max: config.databasePoolMax,
    min: 0,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: applicationName,
    // Keep timeout enforcement client-side. node-postgres serializes
    // statement_timeout as a startup parameter, which RDS Proxy rejects.
    query_timeout: 20_000
  });
}
