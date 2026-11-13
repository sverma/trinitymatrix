import type { AiAgentObservation } from "./ai-openrouter";
import { OpenRouterAgentError } from "./ai-openrouter";
import { AI_VALIDATION_IDENTITY_VERSION } from "./ai-game-protocol-v3";
import type { AiIdentity, AiStore } from "./ai-repository";
import { qualifyAiModel, type AiQualificationReport, type QualificationClient } from "./ai-qualification";
import { AI_PRACTICE_CURRICULUM_ID, AI_PRACTICE_CURRICULUM_HASH, AI_PRACTICE_RULES_REVISION,
  AI_PRACTICE_CURRICULUM_DESCRIPTOR, AI_PRACTICE_MEMORY_PREFIX, aiPracticeFixtureId, createAiPracticeGame,
  type AiPracticeStage, type AiPracticeScenario } from "./ai-practice-curriculum";

export const AI_PRACTICE_VERSION = "trinity-agent-practice/1.0.0";
export const AI_PRACTICE_MAX_DURATION_MS = 10 * 60_000;
export type AiPracticeMetrics = {
  requestedRounds: number; completedRounds: number; trainingEpisodes: number; evaluationEpisodes: number;
  completedEpisodes: number; requests: number; retries: number; validDeclarations: number;
  invalidActions: number; providerErrors: number; winningDecisionsMissed: number;
  knownCostUsd: number; unknownCostRequests: number; maxLatencyMs: number; maxTurnDurationMs: number;
};
export type AiPracticeReport = {
  practiceVersion: string; curriculumId: string; curriculumHash: string; rulesRevision: string;
  protocolId: string; modelId: string;
  status: "completed" | "budget-unavailable" | "time-limit" | "disabled" | "unsupported-protocol";
  metrics: AiPracticeMetrics;
  episodes: Array<{ round: number; stage: AiPracticeStage; fixtureId: string; report: AiQualificationReport }>;
};
export type AiPracticeResult = { report: AiPracticeReport; notes: string };

/** Private notes remain model-authored. Never promote a copied exercise/answer into live memory. */
function reusableNotes(value: string, observation: AiAgentObservation): string | null {
  const note = value.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 512);
  if (!note || /SYNTHETIC_PAST_PRACTICE_DATA|REUSABLE_PRACTICE_NOTES_DATA|lesson-\w|practice-(?:training|evaluation)-|"(?:groups|cards|cardId)"|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}/i.test(note)
    || observation.hand.some(({ id }) => note.includes(id))) return null;
  return note;
}

/**
 * Finite, operator-triggered practice only. No matchmaking, ratings, broadcasts,
 * live memory writes, solver calls, enabled flags, or automatic move replacement.
 */
export async function practiceAiModel(options: {
  identity: AiIdentity;
  ledger: Pick<AiStore, "reserveRequest" | "finishRequest">;
  dailyBudgetUsd: number;
  createClient: (timeoutMs: number) => QualificationClient;
  rounds?: number;
  initialNotes?: string;
  serverRevision?: string;
  maxDurationMs?: number;
}): Promise<AiPracticeResult> {
  const rounds = options.rounds ?? 1;
  const maxDurationMs = options.maxDurationMs ?? AI_PRACTICE_MAX_DURATION_MS;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("Practice rounds must be an integer from 1 through 3.");
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > AI_PRACTICE_MAX_DURATION_MS) throw new Error("Practice duration exceeds the finite run limit.");
  if (options.initialNotes !== undefined && (typeof options.initialNotes !== "string" || options.initialNotes.length > 512)) throw new Error("Practice notes must be bounded text.");
  if (!Number.isFinite(options.dailyBudgetUsd) || options.dailyBudgetUsd <= 0 || options.dailyBudgetUsd > 10) throw new Error("Practice shares the daily budget of at most USD 10.");
  const identity = options.identity;
  const protocolId = identity.protocolId ?? "unknown";
  const metrics: AiPracticeMetrics = { requestedRounds: rounds, completedRounds: 0, trainingEpisodes: 0, evaluationEpisodes: 0,
    completedEpisodes: 0, requests: 0, retries: 0, validDeclarations: 0, invalidActions: 0, providerErrors: 0,
    winningDecisionsMissed: 0, knownCostUsd: 0, unknownCostRequests: 0, maxLatencyMs: 0, maxTurnDurationMs: 0 };
  const report: AiPracticeReport = { practiceVersion: AI_PRACTICE_VERSION, curriculumId: AI_PRACTICE_CURRICULUM_ID,
    curriculumHash: AI_PRACTICE_CURRICULUM_HASH, rulesRevision: AI_PRACTICE_RULES_REVISION, protocolId,
    modelId: identity.modelId, status: "completed", metrics, episodes: [] };
  let notes = options.initialNotes ?? "";
  if (!identity.enabled) { report.status = "disabled"; return { report, notes }; }
  if (protocolId !== AI_VALIDATION_IDENTITY_VERSION || AI_PRACTICE_CURRICULUM_DESCRIPTOR.protocolId !== protocolId
    || AI_PRACTICE_CURRICULUM_DESCRIPTOR.rulesRevision !== AI_PRACTICE_RULES_REVISION) {
    report.status = "unsupported-protocol"; return { report, notes };
  }
  const deadline = Date.now() + maxDurationMs;
  let deadlineReached = false;
  const ledger: Pick<AiStore, "reserveRequest" | "finishRequest"> = {
    reserveRequest: async (...args) => {
      if (Date.now() >= deadline) { deadlineReached = true; return null; }
      return options.ledger.reserveRequest(...args);
    },
    finishRequest: (...args) => options.ledger.finishRequest(...args)
  };
  const createClient = (timeoutMs: number): QualificationClient => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { deadlineReached = true; throw new OpenRouterAgentError("cancelled"); }
    const client = options.createClient(Math.min(timeoutMs, remaining));
    return { cancelAll: () => client.cancelAll(), decide: async (input) => {
      if (Date.now() >= deadline) { deadlineReached = true; throw new OpenRouterAgentError("cancelled"); }
      return client.decide(input);
    } };
  };
  const episode = async (round: number, stage: AiPracticeStage, scenario: AiPracticeScenario, initialMemory: string) => {
    if (Date.now() >= deadline) { deadlineReached = true; report.status = "time-limit"; return false; }
    const result = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: options.dailyBudgetUsd,
      turns: 1, scenario, initialMemory,
      ...(stage === "training" ? { memoryPrefix: AI_PRACTICE_MEMORY_PREFIX,
        onMemory: (value: string, observation: AiAgentObservation) => { const accepted = reusableNotes(value, observation); if (accepted) notes = accepted; } } : {}),
      ...(options.serverRevision ? { serverRevision: options.serverRevision } : {}),
      createGame: (who, syntheticHumanId) => createAiPracticeGame({ identity: who, syntheticHumanId, stage, scenario, round }) });
    report.episodes.push({ round, stage, fixtureId: aiPracticeFixtureId(stage, scenario, round), report: result });
    if (stage === "training") metrics.trainingEpisodes++; else metrics.evaluationEpisodes++;
    if (result.status === "passed") metrics.completedEpisodes++;
    metrics.requests += result.requests; metrics.retries += result.retries;
    metrics.validDeclarations += result.validDeclarations; metrics.invalidActions += result.invalidActions;
    metrics.providerErrors += result.providerErrors; metrics.winningDecisionsMissed += result.winningDecisionsMissed;
    metrics.knownCostUsd = Math.round((metrics.knownCostUsd + result.knownCostUsd) * 1e8) / 1e8;
    metrics.unknownCostRequests += result.unknownCostRequests;
    metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, result.maxLatencyMs);
    metrics.maxTurnDurationMs = Math.max(metrics.maxTurnDurationMs, result.maxTurnDurationMs);
    if (deadlineReached || Date.now() >= deadline) { report.status = "time-limit"; return false; }
    if (result.status === "budget-unavailable") { report.status = "budget-unavailable"; return false; }
    // A failed exercise is evidence, not a reason to disable an agent or erase
    // earlier good notes. Continue only this already bounded curriculum.
    return true;
  };
  for (let round = 1; round <= rounds; round++) {
    if (!(await episode(round, "training", "full-turn", notes))) break;
    if (!(await episode(round, "training", "winning-hand", notes))) break;
    const evaluationNotes = notes;
    if (!(await episode(round, "evaluation", "full-turn", evaluationNotes))) break;
    if (!(await episode(round, "evaluation", "winning-hand", evaluationNotes))) break;
    metrics.completedRounds++;
  }
  return { report, notes };
}
