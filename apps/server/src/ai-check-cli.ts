import { existsSync, readFileSync } from "node:fs";
import { loadRuntimeConfig } from "./config";
import { createPostgresPool } from "./db/pool";
import { PostgresAiStore } from "./ai-repository";
import { OpenRouterAgentClient } from "./ai-openrouter";
import { qualifyAiModel } from "./ai-qualification";
import { createSchemaDiagnosticFetch } from "./ai-schema-diagnostics";

// Operator-only diagnostic: real provider decisions in disposable in-memory
// games. Charges use the production budget ledger; rankings/history are untouched.
async function main(): Promise<void> {
  const selected: string[] = [];
  let turns = 10;
  let diagnoseSchema = false;
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node dist/ops/ai-check.js [--turns 1..10] [--diagnose-schema] [MODEL_ID ...]\nRuns full AI turns in disposable fixtures; every request uses the shared daily budget ledger.\n--diagnose-schema emits only allowlisted HTTP/schema error hints; never raw provider text.");
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--diagnose-schema") diagnoseSchema = true;
    else if (value === "--turns" || value.startsWith("--turns=")) {
      const count = value === "--turns" ? args[++index] : value.slice("--turns=".length);
      if (!count || !/^(?:[1-9]|10)$/.test(count)) {
        console.log(JSON.stringify({ status: "invalid-options", code: "turns-must-be-1-through-10" }));
        process.exitCode = 1;
        return;
      }
      turns = Number(count);
    } else if (value.startsWith("--")) {
      console.log(JSON.stringify({ status: "invalid-options", code: "unknown-option" }));
      process.exitCode = 1;
      return;
    } else selected.push(value);
  }
  const environment = { ...process.env };
  const caPath = "/run/trinitymatrix/postgres-ca.crt";
  if (!environment.DATABASE_SSL_CA && existsSync(caPath)) environment.DATABASE_SSL_CA = readFileSync(caPath, "utf8");
  const config = loadRuntimeConfig(environment);
  if (!config.aiPlayersEnabled || !config.databaseUrl || !config.openRouterApiKey) {
    console.log(JSON.stringify({ status: "unconfigured", code: "ai-database-and-provider-required" }));
    process.exitCode = 1;
    return;
  }
  const pool = createPostgresPool(config);
  const store = new PostgresAiStore(pool);
  let failures = 0;
  try {
    await store.provision();
    const identities = await store.listAgents();
    if (selected.some((id) => !identities.some(({ modelId }) => modelId === id))) {
      console.log(JSON.stringify({ status: "invalid-options", code: "unknown-model" }));
      process.exitCode = 1;
      return;
    }
    for (const identity of identities) {
      if (selected.length && !selected.includes(identity.modelId)) continue;
      const report = await qualifyAiModel({
        identity, ledger: store, dailyBudgetUsd: config.aiDailyBudgetUsd, turns,
        createClient: (timeoutMs) => new OpenRouterAgentClient({ apiKey: config.openRouterApiKey!, timeoutMs,
          ...(diagnoseSchema ? { fetch: createSchemaDiagnosticFetch(fetch, (diagnostic) => console.log(JSON.stringify(diagnostic))) } : {}) })
      });
      if (report.status !== "passed") failures++;
      console.log(JSON.stringify(report));
      if (report.status === "budget-unavailable") break;
    }
  } finally { await pool.end(); }
  if (failures) process.exitCode = 1;
}

try { await main(); }
catch {
  // Provider, database, environment and filesystem error details may contain secrets.
  console.log(JSON.stringify({ status: "qualification-unavailable", code: "operator-check-failed" }));
  process.exitCode = 1;
}
