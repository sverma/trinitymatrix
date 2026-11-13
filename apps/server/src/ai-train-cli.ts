import { existsSync, readFileSync } from "node:fs";
import { createClient } from "redis";
import { loadRuntimeConfig } from "./config";
import { createPostgresPool } from "./db/pool";
import { PostgresAiStore } from "./ai-repository";
import { PostgresAiPracticeStore } from "./ai-practice-repository";
import { OpenRouterAgentClient } from "./ai-openrouter";
import { AI_VALIDATION_IDENTITY_VERSION } from "./ai-game-protocol-v3";
import { practiceAiModel } from "./ai-practice";
import { AI_PRACTICE_CURRICULUM_ID, AI_PRACTICE_CURRICULUM_HASH, AI_PRACTICE_RULES_REVISION } from "./ai-practice-curriculum";
import { parseAiPracticeOptions } from "./ai-practice-options";
import { isPracticePromotionIdle } from "./ai-practice-promotion";

async function main(): Promise<void> {
  let options;
  try { options = parseAiPracticeOptions(process.argv.slice(2)); }
  catch {
    console.log(JSON.stringify({ status: "invalid-options", code: "finite-rounds-and-known-options-required" }));
    process.exitCode = 1; return;
  }
  if (options.help) {
    console.log("Usage: node dist/ops/ai-train.js [--rounds 1..3] [--concurrency 1..3] [--no-promote] [MODEL_ID ...]\nDefault: one finite practice round per enabled current-protocol model, two models at a time.\nUses synthetic lessons and held-out evaluation; every provider request uses the shared daily budget.\nOnly the selected model's concise notes may be promoted to its same-protocol memory; visible busy matches or changed memory defer promotion.\n--no-promote retains private practice notes without changing live memory. No model weights, ratings or availability flags change.");
    return;
  }
  const environment = { ...process.env };
  const caPath = "/run/trinitymatrix/postgres-ca.crt";
  if (!environment.DATABASE_SSL_CA && existsSync(caPath)) environment.DATABASE_SSL_CA = readFileSync(caPath, "utf8");
  const config = loadRuntimeConfig(environment);
  if (!config.aiPlayersEnabled || !config.databaseUrl || !config.openRouterApiKey) {
    console.log(JSON.stringify({ status: "unconfigured", code: "ai-database-and-provider-required" }));
    process.exitCode = 1; return;
  }
  const pool = createPostgresPool(config, "trinitymatrix-ai-training");
  const identities = new PostgresAiStore(pool);
  const practice = new PostgresAiPracticeStore(pool);
  const redis = createClient({ url: config.redisUrl, socket: { connectTimeout: 5_000, reconnectStrategy: false } });
  redis.on("error", () => undefined);
  const clients = new Set<OpenRouterAgentClient>();
  let stopped = false;
  const stop = () => { stopped = true; for (const client of clients) client.cancelAll(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let failures = 0;
  try {
    await identities.provision();
    const roster = (await identities.listAgents()).filter(({ selectable }) => selectable !== false);
    if (options.modelIds.some((id) => !roster.some(({ modelId }) => modelId === id))) {
      console.log(JSON.stringify({ status: "invalid-options", code: "unknown-model" }));
      process.exitCode = 1; return;
    }
    const selected = roster.filter((identity) => options.modelIds.length ? options.modelIds.includes(identity.modelId) : identity.enabled);
    if (options.promote && config.gameplayRuntimeMode === "single") {
      try { await redis.connect(); } catch { /* Private notes remain useful; defer promotion when state is unknown. */ }
    }
    let index = 0;
    const worker = async () => {
      while (!stopped) {
        const identity = selected[index++];
        if (!identity) return;
        if (!identity.enabled || identity.protocolId !== AI_VALIDATION_IDENTITY_VERSION) {
          console.log(JSON.stringify({ modelId: identity.modelId, status: "skipped", code: identity.enabled ? "unsupported-protocol" : "agent-disabled" }));
          failures += 1; continue;
        }
        let runId: string | undefined;
        try {
          const session = await practice.beginRun({ agentId: identity.id, modelId: identity.modelId, protocolId: identity.protocolId,
            curriculumId: AI_PRACTICE_CURRICULUM_ID, curriculumHash: AI_PRACTICE_CURRICULUM_HASH, rulesRevision: AI_PRACTICE_RULES_REVISION });
          runId = session.runId;
          const result = await practiceAiModel({ identity, ledger: identities, dailyBudgetUsd: config.aiDailyBudgetUsd,
            rounds: options.rounds, initialNotes: session.practiceMemory, serverRevision: config.appRevision,
            createClient: (timeoutMs) => {
              if (stopped) throw new Error("operator-stopped");
              const client = new OpenRouterAgentClient({ apiKey: config.openRouterApiKey!, timeoutMs });
              clients.add(client);
              return { decide: client.decide.bind(client), cancelAll: () => { client.cancelAll(); clients.delete(client); } };
            } });
          const idle = options.promote && !stopped && config.gameplayRuntimeMode === "single" && redis.isReady
            && await isPracticePromotionIdle(redis, config.stateNamespace, identity.id);
          const promotion = await practice.completeRun({ runId, notes: result.notes, metrics: result.report.metrics, promote: !!idle });
          console.log(JSON.stringify({ ...result.report, runId, ...promotion,
            ...(options.promote && !idle ? { promotionDeferred: "live-runtime-busy-or-unavailable" } : {}) }));
          if (result.report.status !== "completed") failures += 1;
        } catch {
          if (runId) { try { await practice.failRun(runId); } catch { /* The bounded lease allows crash recovery. */ } }
          console.log(JSON.stringify({ modelId: identity.modelId, ...(runId ? { runId } : {}), status: "practice-unavailable", code: "operator-practice-failed" }));
          failures += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, worker));
  } finally {
    for (const client of clients) client.cancelAll();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (redis.isOpen) { try { await redis.quit(); } catch { redis.destroy(); } }
    await pool.end();
  }
  if (failures || stopped) process.exitCode = 1;
}

try { await main(); }
catch {
  console.log(JSON.stringify({ status: "practice-unavailable", code: "operator-practice-failed" }));
  process.exitCode = 1;
}
