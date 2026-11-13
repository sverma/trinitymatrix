import { randomUUID } from "node:crypto";
import type { AiAgentDecisionResult, AiAgentObservation } from "./ai-openrouter";
import { OpenRouterAgentError } from "./ai-openrouter";
import type { AiIdentity, AiStore } from "./ai-repository";
import { decisionCommand } from "./ai-players";
import { RankingGame } from "./game";

type QualificationClient = {
  decide(input: { modelId: string; observation: AiAgentObservation; memory: string }): Promise<AiAgentDecisionResult>;
  cancelAll(): void;
};

export type AiQualificationReport = {
  modelId: string;
  status: "passed" | "failed" | "budget-unavailable" | "disabled";
  turnsRequested: number;
  turnsCompleted: number;
  turnsMissed: number;
  requests: number;
  draws: number;
  discards: number;
  declarations: number;
  invalidActions: number;
  retries: number;
  providerErrors: number;
  forcedDrops: number;
  errors: Record<string, number>;
  httpStatuses: Record<string, number>;
  finishReasons: Record<string, number>;
  maxLatencyMs: number;
  maxTurnDurationMs: number;
  knownCostUsd: number;
  unknownCostRequests: number;
};

/** Fixture-only opponent. It never enters matchmaking, archival, profiles or ratings. */
function qualificationGame(identity: AiIdentity, humanId: string): RankingGame {
  const seeded = new RankingGame([
    { id: identity.id, displayName: identity.displayName, actorKind: "ai", aiModelId: identity.modelId },
    { id: humanId, displayName: "Diagnostic seat", actorKind: "human" }
  ], () => 0);
  const snapshot = seeded.snapshot();
  snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === identity.id);
  snapshot.turnEndsAt = Date.now() + 45_000;
  return RankingGame.restore(snapshot);
}

/** Only mechanically legal fixture moves; these never choose an AI player's cards. */
function advanceSyntheticHuman(game: RankingGame, humanId: string): void {
  let state = game.publicState();
  if (state.phase === "showdown" && state.showdown?.pendingPlayerIds.includes(humanId)) {
    const submitted = game.apply(humanId, {
      type: "game.submit-hand", commandId: randomUUID(), gameId: state.gameId, expectedRevision: state.revision,
      groups: [game.handFor(humanId).map(({ id }) => id)]
    });
    if (!submitted.accepted) throw new Error("Synthetic final layout failed.");
    return;
  }
  if (state.phase !== "playing" || state.currentPlayerId !== humanId) return;
  const drawn = game.apply(humanId, {
    type: "game.draw", source: "stock", commandId: randomUUID(), gameId: state.gameId, expectedRevision: state.revision
  });
  if (!drawn.accepted) throw new Error("Synthetic draw failed.");
  state = game.publicState();
  const discarded = game.apply(humanId, {
    type: "game.discard", cardId: game.handFor(humanId).at(-1)!.id,
    commandId: randomUUID(), gameId: state.gameId, expectedRevision: state.revision
  });
  if (!discarded.accepted) throw new Error("Synthetic discard failed.");
}

export async function qualifyAiModel(options: {
  identity: AiIdentity;
  ledger: Pick<AiStore, "reserveRequest" | "finishRequest">;
  dailyBudgetUsd: number;
  turns?: number;
  createClient: (timeoutMs: number) => QualificationClient;
  createGame?: (identity: AiIdentity, syntheticHumanId: string) => RankingGame;
}): Promise<AiQualificationReport> {
  const turns = options.turns ?? 10;
  if (!Number.isInteger(turns) || turns < 1 || turns > 10) throw new Error("Qualification turns must be an integer from 1 through 10.");
  if (!Number.isFinite(options.dailyBudgetUsd) || options.dailyBudgetUsd <= 0 || options.dailyBudgetUsd > 10) {
    throw new Error("The shared daily qualification budget must be positive and at most USD 10.");
  }
  const { identity, ledger } = options;
  const report: AiQualificationReport = {
    modelId: identity.modelId, status: identity.enabled ? "passed" : "disabled", turnsRequested: turns,
    turnsCompleted: 0, turnsMissed: 0, requests: 0, draws: 0, discards: 0, declarations: 0,
    invalidActions: 0, retries: 0, providerErrors: 0, forcedDrops: 0, errors: {}, httpStatuses: {}, finishReasons: {},
    maxLatencyMs: 0, maxTurnDurationMs: 0, knownCostUsd: 0, unknownCostRequests: 0
  };
  const record = (code: string) => { report.errors[code] = (report.errors[code] ?? 0) + 1; };
  if (!identity.enabled) { record("agent-disabled"); return report; }
  let syntheticHumanId = randomUUID();
  const createGame = options.createGame ?? qualificationGame;
  let game = createGame(identity, syntheticHumanId);
  let memory = "";
  let publicHistory: string[] = [];
  let feedback = "";

  while (report.turnsCompleted < turns && report.status === "passed") {
    const turnStarted = Date.now();
    let revision = -1;
    let attempts = 0;
    let turnComplete = false;
    while (!turnComplete && report.status === "passed") {
      const state = game.publicState();
      if (state.phase !== "playing" || state.currentPlayerId !== identity.id) {
        record("fixture-state-invalid"); report.status = "failed"; break;
      }
      if (state.revision !== revision) { revision = state.revision; attempts = 0; feedback = ""; }
      const remainingMs = state.turnEndsAt - Date.now() - 1_000;
      if (remainingMs <= 0) { record("turn-deadline"); report.status = "failed"; break; }
      if (attempts >= 2) { record("attempts-exhausted"); report.status = "failed"; break; }
      const observation: AiAgentObservation = {
        playerId: identity.id, state, hand: game.handFor(identity.id),
        publicHistory: [...publicHistory, ...(feedback ? [feedback] : [])]
      };
      let requestId: string | null;
      try {
        requestId = await ledger.reserveRequest(identity.id, identity.modelId, options.dailyBudgetUsd);
      } catch { record("ledger-unavailable"); report.status = "failed"; break; }
      if (!requestId) { record("budget-unavailable"); report.status = "budget-unavailable"; break; }
      const afterReservationMs = state.turnEndsAt - Date.now() - 1_000;
      if (afterReservationMs <= 0) {
        try { await ledger.finishRequest(requestId, 0, false); } catch { record("ledger-unavailable"); }
        record("turn-deadline"); report.status = "failed"; break;
      }
      let client: QualificationClient;
      try { client = options.createClient(Math.min(15_000, afterReservationMs)); }
      catch {
        try { await ledger.finishRequest(requestId, 0, false); } catch { record("ledger-unavailable"); }
        record("client-configuration"); report.status = "failed"; break;
      }
      if (attempts > 0) report.retries += 1;
      attempts += 1;
      report.requests += 1;
      const started = Date.now();
      let result: AiAgentDecisionResult;
      try {
        result = await client.decide({ modelId: identity.modelId, observation, memory });
        report.maxLatencyMs = Math.max(report.maxLatencyMs, Date.now() - started);
      } catch (error) {
        report.maxLatencyMs = Math.max(report.maxLatencyMs, Date.now() - started);
        const known = error instanceof OpenRouterAgentError ? error : null;
        const code = known?.code ?? "qualification-unavailable";
        record(code); report.providerErrors += 1;
        if (code === "invalid-json" || code === "invalid-decision" || code === "invalid-card-reference") report.invalidActions += 1;
        const status = known?.metadata.status;
        if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
          report.httpStatuses[String(status)] = (report.httpStatuses[String(status)] ?? 0) + 1;
        }
        const finish = known?.metadata.finishReason;
        if (finish && /^[a-z_]{1,40}$/.test(finish)) report.finishReasons[finish] = (report.finishReasons[finish] ?? 0) + 1;
        const costUsd = known?.metadata.usage?.costUsd ?? null;
        if (costUsd === null) report.unknownCostRequests += 1;
        else report.knownCostUsd += costUsd;
        try { await ledger.finishRequest(requestId, costUsd, false); }
        catch { record("ledger-unavailable"); report.status = "failed"; }
        feedback = `Your previous request failed with ${code}. Return a valid action for the same observed turn.`;
        if (code === "model-mismatch" || code === "configuration" || code === "invalid-observation") report.status = "failed";
        continue;
      } finally {
        client.cancelAll();
      }
      if (result.usage.costUsd === null) report.unknownCostRequests += 1;
      else report.knownCostUsd += result.usage.costUsd;
      try { await ledger.finishRequest(requestId, result.usage.costUsd, true); }
      catch { record("ledger-unavailable"); report.status = "failed"; break; }
      if (result.modelId !== identity.modelId) { record("model-mismatch"); report.status = "failed"; break; }
      if (Date.now() >= state.turnEndsAt) { record("turn-deadline"); report.status = "failed"; break; }
      let applied;
      try { applied = game.apply(identity.id, decisionCommand(result.decision, observation)); }
      catch { report.invalidActions += 1; record("invalid-action-shape"); feedback = "Return a valid game action matching your current hand size."; continue; }
      if (!applied.accepted) {
        report.invalidActions += 1;
        record(`command-${applied.code.toLowerCase()}`);
        feedback = `The server rejected your action: ${applied.message}`;
        continue;
      }
      if (result.decision.action === "declare") report.declarations += 1;
      if (applied.dropped) {
        report.invalidActions += 1; report.forcedDrops += 1;
        record("invalid-declaration"); report.status = "failed"; break;
      }
      memory = result.decision.memory;
      const action = result.decision.action;
      if (action === "draw-stock" || action === "draw-discard") report.draws += 1;
      if (action === "discard") { report.discards += 1; turnComplete = true; }
      if (action === "declare") turnComplete = true;
      const updated = game.publicState();
      publicHistory.push(JSON.stringify({ revision: updated.revision, currentPlayerId: updated.currentPlayerId,
        topDiscard: updated.topDiscard, players: updated.players.map(({ id, cardCount, status }) => ({ id, cardCount, status })) }));
      publicHistory = publicHistory.slice(-6);
    }
    report.maxTurnDurationMs = Math.max(report.maxTurnDurationMs, Date.now() - turnStarted);
    if (!turnComplete) { report.turnsMissed += 1; break; }
    report.turnsCompleted += 1;
    if (report.turnsCompleted >= turns) break;
    try { advanceSyntheticHuman(game, syntheticHumanId); }
    catch { record("fixture-opponent-failed"); report.status = "failed"; break; }
    if (game.publicState().phase === "finished") {
      syntheticHumanId = randomUUID();
      game = createGame(identity, syntheticHumanId);
      memory = ""; publicHistory = []; feedback = "";
    }
  }
  report.knownCostUsd = Math.round(report.knownCostUsd * 1e8) / 1e8;
  return report;
}
