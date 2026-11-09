import { describe, expect, it } from "vitest";
import { createPostgresPool } from "./pool";

describe("PostgreSQL pool configuration", () => {
  it("uses a client-side query timeout without an RDS Proxy-incompatible startup parameter", async () => {
    const pool = createPostgresPool({
      databaseUrl: "postgresql://runtime:secret@proxy.example.test:5432/trinitymatrix",
      databaseSslMode: "verify-full",
      databaseSslCa: "test-ca",
      databasePoolMax: 10,
    });

    expect(pool.options).not.toHaveProperty("statement_timeout");
    expect(pool.options).toMatchObject({
      query_timeout: 20_000,
      max: 10,
      ssl: { rejectUnauthorized: true, ca: "test-ca" },
    });
    await pool.end();
  });
});
