import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "./config";
import { createPostgresPool } from "./db/pool";
import { PostgresAiStore } from "./ai-repository";
import { OpenRouterAgentClient, OpenRouterAgentError } from "./ai-openrouter";
import { RankingGame } from "./game";
import { decisionCommand } from "./ai-players";

// Operator-only diagnostic: real provider decisions in disposable in-memory
// games. Charges use the production budget ledger; rankings/history are untouched.
const environment = { ...process.env };
const caPath = "/run/trinitymatrix/postgres-ca.crt";
if (!environment.DATABASE_SSL_CA && existsSync(caPath)) environment.DATABASE_SSL_CA = readFileSync(caPath, "utf8");
const config = loadRuntimeConfig(environment);
if (!config.aiPlayersEnabled || !config.databaseUrl || !config.openRouterApiKey) {
  throw new Error("Enable AI players and configure the server-side database and OpenRouter key before checking models.");
}
const pool = createPostgresPool(config);
const store = new PostgresAiStore(pool);
const client = new OpenRouterAgentClient({ apiKey: config.openRouterApiKey });
let failures = 0;
try {
  await store.provision();
  const identities = await store.listAgents();
  const selected = process.argv.slice(2);
  if (selected.some((id) => !identities.some(({ modelId }) => modelId === id))) throw new Error("Select models from the configured AI roster.");
  for (const identity of identities) {
    if (selected.length && !selected.includes(identity.modelId)) continue;
    if (!identity.enabled) continue;
    const fixture = new RankingGame([
      { id: identity.id, displayName: identity.displayName, actorKind: "ai", aiModelId: identity.modelId },
      { id: randomUUID(), displayName: "Diagnostic seat", actorKind: "human" }
    ], () => 0);
    // Make the model-controlled identity the player to act while preserving the
    // valid deal; the diagnostic fixture never enters the live matchmaker.
    const snapshot = fixture.snapshot();
    snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === identity.id);
    const game = RankingGame.restore(snapshot);
    const observation = { playerId: identity.id, state: game.publicState(), hand: game.handFor(identity.id) };
    const requestId = await store.reserveRequest(identity.id, identity.modelId, config.aiDailyBudgetUsd);
    if (!requestId) { failures++; console.log(JSON.stringify({ modelId: identity.modelId, status: "budget-unavailable" })); break; }
    const started = Date.now();
    try {
      const result = await client.decide({ modelId: identity.modelId, observation, memory: "" });
      await store.finishRequest(requestId, result.usage.costUsd, true);
      const applied = game.apply(identity.id, decisionCommand(result.decision, observation));
      if (!applied.accepted) failures++;
      console.log(JSON.stringify({ modelId: identity.modelId, status: applied.accepted ? "passed" : "illegal-move",
        costUsd: result.usage.costUsd, durationMs: Date.now() - started }));
    } catch (error) {
      await store.finishRequest(requestId, null, false);
      failures++;
      console.log(JSON.stringify({ modelId: identity.modelId, status: "provider-check-failed",
        code: error instanceof OpenRouterAgentError ? error.code : "local-check-failed", durationMs: Date.now() - started }));
    }
  }
} finally { client.cancelAll(); await pool.end(); }
if (failures) process.exitCode = 1;
