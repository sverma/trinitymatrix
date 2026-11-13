import { randomUUID } from "node:crypto";
import type { AiAgentDecisionResult, AiAgentObservation } from "./ai-openrouter";
import { AI_MAX_DECISION_TIME_MS, OpenRouterAgentError } from "./ai-openrouter";
import type { AiIdentity, AiStore, AiRequestCompletion } from "./ai-repository";
import { decisionCommand } from "./ai-players";
import { RankingGame } from "./game";
import { validateDeclaration } from "@trinitymatrix/game-domain";
import { AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_LEGACY_V1_PROTOCOL_VERSION, type AiGameRulesFacts } from "./ai-game-protocol";
import { AiRuleToolService } from "./ai-rule-tool-service";
import { unavailableAiRules } from "./ai-rule-tools";
import { missedWinHand14, missedWinWildRank } from "./ai-missed-win.fixture";
import { AI_VALIDATION_IDENTITY_VERSION, AI_VALIDATION_TOOL_VERSION } from "./ai-game-protocol-v3";
import { validateAiProposal } from "./ai-proposal-validation";

export type QualificationClient = {
  decide(input: { modelId: string; observation: AiAgentObservation; memory: string; protocolId: string; rulesFacts?: AiGameRulesFacts }): Promise<AiAgentDecisionResult>;
  cancelAll(): void;
};

export type AiQualificationReport = {
  modelId: string;
  protocolId: string;
  scenario: "full-turn" | "winning-hand";
  status: "passed" | "failed" | "budget-unavailable" | "disabled";
  turnsRequested: number;
  turnsCompleted: number;
  turnsMissed: number;
  requests: number;
  draws: number;
  discards: number;
  declarations: number;
  validDeclarations: number;
  invalidDeclarations: number;
  terminalFixtures: number;
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
  rulesChecks: number;
  rulesUnavailable: number;
  policyRejected: number;
  winningDecisionsAvailable: number;
  winningDecisionsMissed: number;
};

/** Fixture-only opponent. It never enters matchmaking, archival, profiles or ratings. */
function qualificationGame(identity: AiIdentity, humanId: string): RankingGame {
  // A reproducible shuffled deal exercises ordinary draws/discards as well as
  // readiness. An always-zero shuffle happened to start with a winning hand.
  let seed = 94;
  const randomIndex = (maximum: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  const seeded = new RankingGame([
    { id: identity.id, displayName: identity.displayName, actorKind: "ai", aiModelId: identity.modelId },
    { id: humanId, displayName: "Diagnostic seat", actorKind: "human" }
  ], randomIndex);
  const snapshot = seeded.snapshot();
  snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === identity.id);
  snapshot.turnEndsAt = Date.now() + 45_000;
  return RankingGame.restore(snapshot);
}

/** Sanitized missed-win regression, never an archived/live/ranked game. */
export function winningQualificationGame(identity: AiIdentity, humanId: string): RankingGame {
  const base = qualificationGame(identity, humanId);
  const snapshot = base.snapshot();
  const ownIds = new Set(missedWinHand14.map(({ id }) => id));
  snapshot.hands = snapshot.hands.map((entry) => entry.playerId === identity.id
    ? { playerId: identity.id, cards: structuredClone(missedWinHand14) } : entry);
  snapshot.stock = snapshot.stock.filter(({ id }) => !ownIds.has(id));
  snapshot.wildRank = missedWinWildRank;
  snapshot.drawnBy = identity.id;
  snapshot.drawnCardId = missedWinHand14.at(-1)!.id;
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
  scenario?: "full-turn" | "winning-hand";
  serverRevision?: string;
  rulesTools?: Pick<AiRuleToolService, "compute">;
  createClient: (timeoutMs: number) => QualificationClient;
  createGame?: (identity: AiIdentity, syntheticHumanId: string) => RankingGame;
  /** Optional fixture-local data for practice; never reads or saves profile memory. */
  initialMemory?: string;
  memoryPrefix?: string;
  onMemory?: (memory: string, observation: AiAgentObservation) => void;
}): Promise<AiQualificationReport> {
  const turns = options.turns ?? (options.scenario === "winning-hand" ? 1 : 10);
  if (!Number.isInteger(turns) || turns < 1 || turns > 10) throw new Error("Qualification turns must be an integer from 1 through 10.");
  if (!Number.isFinite(options.dailyBudgetUsd) || options.dailyBudgetUsd <= 0 || options.dailyBudgetUsd > 10) {
    throw new Error("The shared daily qualification budget must be positive and at most USD 10.");
  }
  for (const memory of [options.initialMemory, options.memoryPrefix]) {
    if (memory !== undefined && (typeof memory !== "string" || memory.length > 4_000)) throw new Error("Fixture memory must be bounded text.");
  }
  const { identity, ledger } = options;
  const protocolId = identity.protocolId ?? AI_LEGACY_V1_PROTOCOL_VERSION;
  const v2 = protocolId === AI_GAME_PROTOCOL_IDENTITY_VERSION;
  const validationOnly = protocolId === AI_VALIDATION_IDENTITY_VERSION;
  const scenario = options.scenario ?? "full-turn";
  if (!["full-turn", "winning-hand"].includes(scenario)) throw new Error("Unknown qualification scenario.");
  const report: AiQualificationReport = {
    modelId: identity.modelId, protocolId, scenario, status: identity.enabled ? "passed" : "disabled", turnsRequested: turns,
    turnsCompleted: 0, turnsMissed: 0, requests: 0, draws: 0, discards: 0, declarations: 0,
    validDeclarations: 0, invalidDeclarations: 0, terminalFixtures: 0,
    invalidActions: 0, retries: 0, providerErrors: 0, forcedDrops: 0, errors: {}, httpStatuses: {}, finishReasons: {},
    maxLatencyMs: 0, maxTurnDurationMs: 0, knownCostUsd: 0, unknownCostRequests: 0,
    rulesChecks: 0, rulesUnavailable: 0, policyRejected: 0, winningDecisionsAvailable: 0, winningDecisionsMissed: 0
  };
  const record = (code: string) => { report.errors[code] = (report.errors[code] ?? 0) + 1; };
  if (!identity.enabled) { record("agent-disabled"); return report; }
  if (!v2 && !validationOnly && protocolId !== AI_LEGACY_V1_PROTOCOL_VERSION) { record("configuration"); report.status = "failed"; return report; }
  const ownedTools = v2 && !options.rulesTools ? new AiRuleToolService() : null;
  const rulesTools = options.rulesTools ?? ownedTools;
  let syntheticHumanId = randomUUID();
  const createGame = options.createGame ?? (scenario === "winning-hand" ? winningQualificationGame : qualificationGame);
  let game = createGame(identity, syntheticHumanId);
  let memory = options.initialMemory ?? "";
  let publicHistory: string[] = [];
  let feedback = "";

  try { while (report.turnsCompleted < turns && report.status === "passed") {
    const turnStarted = Date.now();
    let revision = -1;
    let attempts = 0;
    let turnComplete = false;
    let rulesFacts: AiGameRulesFacts | undefined;
    while (!turnComplete && report.status === "passed") {
      const state = game.publicState();
      if (state.phase !== "playing" || state.currentPlayerId !== identity.id) {
        record("fixture-state-invalid"); report.status = "failed"; break;
      }
      if (state.revision !== revision) { revision = state.revision; attempts = 0; feedback = ""; rulesFacts = undefined; }
      const remainingMs = state.turnEndsAt - Date.now() - 1_000;
      if (remainingMs <= 0) { record("turn-deadline"); report.status = "failed"; break; }
      if (attempts >= 2) { record("attempts-exhausted"); report.status = "failed"; break; }
      const observation: AiAgentObservation = {
        playerId: identity.id, state, hand: game.handFor(identity.id),
        publicHistory: [...publicHistory, ...(feedback ? [feedback] : [])]
      };
      // The known fixture supplies an offline performance metric only. Never
      // search ordinary v3 hands or send readiness information to the model.
      if (validationOnly && scenario === "winning-hand" && attempts === 0) report.winningDecisionsAvailable += 1;
      if (v2 && !rulesFacts) {
        report.rulesChecks += 1;
        try { rulesFacts = await rulesTools!.compute({ hand: observation.hand, wildRank: state.wildRank, visibleDiscard: state.topDiscard }, Math.min(1000, remainingMs)); }
        catch { rulesFacts = unavailableAiRules("tool-error"); }
        if (rulesFacts.status === "unavailable") report.rulesUnavailable += 1;
        if (rulesFacts.status === "complete" && rulesFacts.immediateDeclaration) report.winningDecisionsAvailable += 1;
      }
      let requestId: string | null;
      try {
        requestId = await ledger.reserveRequest(identity.id, identity.modelId, options.dailyBudgetUsd, {
          protocolId, matchId: state.gameId, gameRevision: state.revision,
          ...(rulesFacts ? { toolsVersion: rulesFacts.toolVersion,
            declarationAvailable: rulesFacts.status === "complete" ? !!rulesFacts.immediateDeclaration : null } : {}),
          ...(validationOnly ? { toolsVersion: AI_VALIDATION_TOOL_VERSION, declarationAvailable: null } : {}),
          ...(options.serverRevision ? { serverRevision: options.serverRevision.slice(0, 100) } : {})
        });
      } catch { record("ledger-unavailable"); report.status = "failed"; break; }
      if (!requestId) { record("budget-unavailable"); report.status = "budget-unavailable"; break; }
      const afterReservationMs = state.turnEndsAt - Date.now() - 1_000;
      if (afterReservationMs <= 0) {
        try { await ledger.finishRequest(requestId, 0, false, { outcome: "cancelled" }); } catch { record("ledger-unavailable"); }
        record("turn-deadline"); report.status = "failed"; break;
      }
      let client: QualificationClient;
      try { client = options.createClient(Math.min(AI_MAX_DECISION_TIME_MS, afterReservationMs)); }
      catch {
        try { await ledger.finishRequest(requestId, 0, false, { outcome: "cancelled" }); } catch { record("ledger-unavailable"); }
        record("client-configuration"); report.status = "failed"; break;
      }
      if (attempts > 0) report.retries += 1;
      attempts += 1;
      report.requests += 1;
      const started = Date.now();
      let result: AiAgentDecisionResult;
      try {
        const requestMemory = options.memoryPrefix
          ? `${options.memoryPrefix}\n${memory.slice(0, Math.max(0, 3_999 - options.memoryPrefix.length))}`.slice(0, 4_000)
          : memory;
        result = await client.decide({ modelId: identity.modelId, observation, memory: requestMemory, protocolId, ...(rulesFacts ? { rulesFacts } : {}) });
        report.maxLatencyMs = Math.max(report.maxLatencyMs, Date.now() - started);
      } catch (error) {
        report.maxLatencyMs = Math.max(report.maxLatencyMs, Date.now() - started);
        const known = error instanceof OpenRouterAgentError ? error : null;
        const code = known?.code ?? "qualification-unavailable";
        const policyRejected = code === "missed-declaration" || code === "invalid-declaration" || !!known?.metadata.validation;
        record(code);
        if (policyRejected) report.policyRejected += 1; else report.providerErrors += 1;
        if (policyRejected || code === "invalid-json" || code === "invalid-decision" || code === "invalid-card-reference") report.invalidActions += 1;
        if (code === "missed-declaration") report.winningDecisionsMissed += 1;
        const status = known?.metadata.status;
        if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
          report.httpStatuses[String(status)] = (report.httpStatuses[String(status)] ?? 0) + 1;
        }
        const finish = known?.metadata.finishReason;
        if (finish && /^[a-z_]{1,40}$/.test(finish)) report.finishReasons[finish] = (report.finishReasons[finish] ?? 0) + 1;
        const costUsd = known?.metadata.usage?.costUsd ?? null;
        if (costUsd === null) report.unknownCostRequests += 1;
        else report.knownCostUsd += costUsd;
        try { await ledger.finishRequest(requestId, costUsd, false, {
          ...(known?.metadata.action ? { action: known.metadata.action } : {}),
          outcome: code === "cancelled" ? "cancelled" : policyRejected ? "policy-rejected" : "provider-failed"
        }); }
        catch { record("ledger-unavailable"); report.status = "failed"; }
        feedback = validationOnly && known?.metadata.validation
          ? `Your proposed move was rejected: ${known.metadata.validation.message} Return a corrected legal decision.`
          : `Your previous request failed with ${code}. Return a valid action for the same observed turn.`;
        if (code === "model-mismatch" || code === "configuration" || code === "invalid-observation" || code === "invalid-rules-facts") report.status = "failed";
        continue;
      } finally {
        client.cancelAll();
      }
      if (result.usage.costUsd === null) report.unknownCostRequests += 1;
      else report.knownCostUsd += result.usage.costUsd;
      const settle = async (success: boolean, outcome: AiRequestCompletion["outcome"]): Promise<boolean> => {
        try { await ledger.finishRequest(requestId, result.usage.costUsd, success, { action: result.decision.action, outcome }); return true; }
        catch { record("ledger-unavailable"); report.status = "failed"; return false; }
      };
      if (result.modelId !== identity.modelId) { await settle(false, "provider-failed"); record("model-mismatch"); report.status = "failed"; break; }
      if (Date.now() >= state.turnEndsAt) { await settle(false, "stale"); record("turn-deadline"); report.status = "failed"; break; }
      if (validationOnly) {
        const validation = validateAiProposal(observation, result.decision);
        if (!validation.valid) {
          record(validation.validation.code); report.invalidActions += 1; report.policyRejected += 1;
          if (!(await settle(false, "policy-rejected"))) break;
          feedback = `Your proposed move was rejected: ${validation.validation.message} Return a corrected legal decision.`;
          continue;
        }
      }
      const mustDeclare = (!validationOnly && scenario === "winning-hand") || (v2 && rulesFacts?.status === "complete" && !!rulesFacts.immediateDeclaration);
      const missedWin = mustDeclare && result.decision.action !== "declare";
      const invalidPlan = !validationOnly && (v2 || scenario === "winning-hand") && result.decision.action === "declare"
        && !validateDeclaration(observation.hand, result.decision.cardId ?? "", result.decision.groups, state.wildRank).valid;
      if (missedWin || invalidPlan) {
        const code = missedWin ? "missed-declaration" : "invalid-declaration";
        record(code); report.invalidActions += 1; report.policyRejected += 1;
        if (missedWin) report.winningDecisionsMissed += 1;
        if (!(await settle(false, "policy-rejected"))) break;
        feedback = "An immediately legal declaration is available. Return a valid declaration now; do not discard to improve points.";
        continue;
      }
      let applied;
      try { applied = game.apply(identity.id, decisionCommand(result.decision, observation)); }
      catch {
        report.invalidActions += 1; record("invalid-action-shape"); feedback = "Return a valid game action matching your current hand size.";
        if (!(await settle(false, "server-rejected"))) break;
        continue;
      }
      if (!applied.accepted) {
        report.invalidActions += 1;
        record(`command-${applied.code.toLowerCase()}`);
        feedback = `The server rejected your action: ${applied.message}`;
        if (!(await settle(false, "server-rejected"))) break;
        continue;
      }
      if (!(await settle(true, "accepted"))) break;
      if (validationOnly && scenario === "winning-hand" && result.decision.action === "discard") report.winningDecisionsMissed += 1;
      if (result.decision.action === "declare") report.declarations += 1;
      if (applied.dropped) {
        // The model chose a committed declaration and lost under ordinary rules.
        // Record the strategic loss rather than misclassifying it as a worker failure.
        report.invalidActions += 1;
        report.invalidDeclarations += 1;
        turnComplete = true;
      } else if (result.decision.action === "declare") {
        report.validDeclarations += 1;
      }
      memory = result.decision.memory;
      options.onMemory?.(memory, observation);
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
    try { advanceSyntheticHuman(game, syntheticHumanId); }
    catch { record("fixture-opponent-failed"); report.status = "failed"; break; }
    if (game.publicState().phase === "finished") {
      report.terminalFixtures += 1;
      if (report.turnsCompleted >= turns) break;
      syntheticHumanId = randomUUID();
      game = createGame(identity, syntheticHumanId);
      memory = ""; publicHistory = []; feedback = "";
    }
  } } finally { await ownedTools?.stop(); }
  report.knownCostUsd = Math.round(report.knownCostUsd * 1e8) / 1e8;
  return report;
}
