import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAgentDecisionResult, AiAgentObservation } from "./ai-openrouter";
import { OpenRouterAgentClient, OpenRouterAgentError } from "./ai-openrouter";
import { AI_VALIDATION_IDENTITY_VERSION, buildValidationSystemPrompt } from "./ai-game-protocol-v3";
import type { AiIdentity, AiStore } from "./ai-repository";
import { AI_PRACTICE_CURRICULUM_HASH, AI_PRACTICE_MEMORY_PREFIX } from "./ai-practice-curriculum";
import { practiceAiModel } from "./ai-practice";
import { AiRuleToolService } from "./ai-rule-tool-service";

const identity: AiIdentity = { id: "33333333-3333-4333-8333-333333333333", modelId: "provider/model-version",
  modelName: "Example model", displayName: "Model AI", memory: "PRIVATE_LIVE_MEMORY", enabled: true,
  rating: 1300, gamesPlayed: 99, wins: 40, protocolId: AI_VALIDATION_IDENTITY_VERSION };
type Input = { modelId: string; protocolId: string; observation: AiAgentObservation; memory: string };
function selected(input: Input, memory = "Keep a natural 21 and group every remaining card before declaring."): AiAgentDecisionResult {
  const drawn = input.observation.hand.length === 14;
  return { modelId: input.modelId, decision: { action: drawn ? "discard" : "draw-stock",
    cardId: drawn ? input.observation.hand[0]!.id : null, groups: [], memory },
    usage: { costUsd: 0.001, promptTokens: 1000, completionTokens: 100 } };
}
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  const ledger = { reserveRequest: vi.fn<AiStore["reserveRequest"]>(async () => randomUUID()),
    finishRequest: vi.fn<AiStore["finishRequest"]>(async () => undefined), saveMemory: vi.fn() };
  const decide = vi.fn(async (input: Input) => selected(input));
  const cancelAll = vi.fn();
  const createClient = vi.fn((_timeoutMs: number) => ({ decide, cancelAll }));
  return { ledger, decide, cancelAll, createClient };
}

describe("finite private agent practice", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("trains with past examples then evaluates disjoint fixtures without examples, preserving flags, live memory and ratings", async () => {
    const before = structuredClone(identity); const { ledger, decide, createClient } = setup();
    const compute = vi.spyOn(AiRuleToolService.prototype, "compute").mockImplementation(() => { throw new Error("No hand search in practice"); });
    const result = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, initialNotes: "Reusable earlier practice note." });
    expect(result.report).toMatchObject({ status: "completed", protocolId: AI_VALIDATION_IDENTITY_VERSION,
      curriculumHash: AI_PRACTICE_CURRICULUM_HASH, metrics: { requestedRounds: 1, completedRounds: 1,
        trainingEpisodes: 2, evaluationEpisodes: 2, completedEpisodes: 4, requests: 6,
        validDeclarations: 0, winningDecisionsMissed: 2, knownCostUsd: 0.006, unknownCostRequests: 0 } });
    expect(result.notes).toBe("Keep a natural 21 and group every remaining card before declaring.");
    expect(result.report.episodes.map(({ stage, report }) => [stage, report.scenario])).toEqual([
      ["training", "full-turn"], ["training", "winning-hand"], ["evaluation", "full-turn"], ["evaluation", "winning-hand"]
    ]);
    expect(decide.mock.calls.slice(0, 3).every(([input]) => input.memory.startsWith(AI_PRACTICE_MEMORY_PREFIX))).toBe(true);
    expect(decide.mock.calls.slice(3).every(([input]) => !input.memory.includes("lesson-") && !input.memory.includes(AI_PRACTICE_MEMORY_PREFIX))).toBe(true);
    expect(decide.mock.calls.every(([input]) => input.memory.length <= 4000 && input.modelId === identity.modelId
      && input.protocolId === AI_VALIDATION_IDENTITY_VERSION && !("rulesFacts" in input))).toBe(true);
    expect(ledger.reserveRequest.mock.calls.every((call) => call[2] === 10 && call[3]?.declarationAvailable === null)).toBe(true);
    expect(ledger.finishRequest).toHaveBeenCalledTimes(6); expect(compute).not.toHaveBeenCalled();
    expect(ledger.saveMemory).not.toHaveBeenCalled(); expect(identity).toEqual(before);
    expect(JSON.stringify(result.report)).not.toMatch(/PRIVATE_LIVE_MEMORY|Reusable earlier|natural 21 and group|practice-training-r1.*clubs/);
  });

  it("retains earlier good model notes through failed exercises and does not learn from held-out evaluation responses", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => {
      if (input.observation.hand[0]!.id.includes("training-r1-winning-hand")) {
        return { ...selected(input), decision: { action: "declare", cardId: input.observation.hand[0]!.id, groups: [], memory: "Unaccepted output" } };
      }
      return selected(input, input.memory.startsWith(AI_PRACTICE_MEMORY_PREFIX) ? "Never use a joker in a natural 21." : "PRIVATE_EVALUATION_NOTE");
    });
    const { report, notes } = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10 });
    expect(report.status).toBe("completed");
    expect(report.metrics).toMatchObject({ completedRounds: 1, completedEpisodes: 3, invalidActions: 2, requests: 7, retries: 1 });
    expect(report.episodes[1]!.report.status).toBe("failed");
    expect(notes).toBe("Never use a joker in a natural 21.");
    expect(decide.mock.calls.at(-1)![0].memory).toBe("Never use a joker in a natural 21.");
  });

  it("records a model-returned legal winning partition without choosing the declaration on its behalf", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => {
      if (!input.observation.hand[0]!.id.includes("training-r1-winning-hand")) return selected(input);
      const hand = input.observation.hand;
      const id = (suit: string, rank: number) => hand.find((card) => card.suit === suit && card.rank === rank)!.id;
      return { ...selected(input), decision: { action: "declare", cardId: id("clubs", 13), memory: "Cover thirteen cards once and retain a natural 21.", groups: [
        [id("clubs", 1), id("hearts", 10), id("diamonds", 10)], [id("clubs", 3), id("clubs", 6), id("clubs", 9)],
        [id("diamonds", 2), id("diamonds", 4), id("diamonds", 6)], [id("spades", 2), id("spades", 4), id("spades", 6), id("spades", 3)]
      ] } };
    });
    const result = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10 });
    expect(result.report.metrics).toMatchObject({ validDeclarations: 1, winningDecisionsMissed: 1, completedEpisodes: 4 });
    expect(result.report.episodes[1]!.report).toMatchObject({ declarations: 1, validDeclarations: 1, terminalFixtures: 1 });
    expect(ledger.finishRequest.mock.calls.some((call) => call[3]?.action === "declare" && call[3]?.outcome === "accepted")).toBe(true);
    expect(result.notes).toBe("Cover thirteen cards once and retain a natural 21.");
  });

  it("bounds the longest curriculum to twelve finite episodes across three rounds", async () => {
    const { ledger, decide, createClient } = setup();
    const result = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, rounds: 3 });
    expect(result.report.metrics).toMatchObject({ requestedRounds: 3, completedRounds: 3, trainingEpisodes: 6,
      evaluationEpisodes: 6, completedEpisodes: 12, requests: 18 });
    expect(new Set(result.report.episodes.map(({ fixtureId }) => fixtureId)).size).toBe(12);
    expect(decide).toHaveBeenCalledTimes(18);
    expect(createClient.mock.calls.every(([timeout]) => timeout <= 20_000)).toBe(true);
  });

  it("rejects copied exercise answers and oversized output while retaining bounded reusable notes", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => selected(input, input.observation.hand[0]!.id + ' {"groups":["lesson-1"]}'));
    const result = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, initialNotes: "Keep reusable lessons." });
    expect(result.notes).toBe("Keep reusable lessons.");
    decide.mockImplementation(async (input) => selected(input, "a".repeat(800)));
    const bounded = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10 });
    expect(bounded.notes.length).toBe(512);
  });

  it("stops immediately when the shared ledger declines a reservation and preserves notes from an earlier accepted move", async () => {
    const { ledger, decide, createClient } = setup();
    ledger.reserveRequest.mockResolvedValueOnce(randomUUID()).mockResolvedValue(null);
    const { report, notes } = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10 });
    expect(report).toMatchObject({ status: "budget-unavailable", metrics: { requests: 1, completedRounds: 0, trainingEpisodes: 1 } });
    expect(decide).toHaveBeenCalledTimes(1); expect(ledger.finishRequest).toHaveBeenCalledTimes(1);
    expect(notes).not.toBe("");
  });

  it("does not start another paid call or reservation after its absolute deadline", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => { vi.setSystemTime(Date.now() + 1000); return selected(input); });
    const { report } = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, maxDurationMs: 1000 });
    expect(report.status).toBe("time-limit"); expect(decide).toHaveBeenCalledTimes(1);
    expect(ledger.reserveRequest).toHaveBeenCalledTimes(1);
    expect(createClient.mock.calls[0]![0]).toBe(1000);
  });

  it("accounts for unknown provider failures without exposing causes, changing models or disabling identities", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockRejectedValue(new OpenRouterAgentError("timeout"));
    const { report, notes } = await practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, initialNotes: "Earlier good note." });
    expect(report.status).toBe("completed");
    expect(report.metrics).toMatchObject({ completedEpisodes: 0, requests: 8, providerErrors: 8, unknownCostRequests: 8 });
    expect(notes).toBe("Earlier good note."); expect(ledger.finishRequest).toHaveBeenCalledTimes(8);
    expect(ledger.finishRequest.mock.calls.every((call) => call[1] === null)).toBe(true);
    expect(identity.enabled).toBe(true);
  });

  it("runs the frozen live v3 adapter without modifying its prompt or leaking examples into evaluation", async () => {
    const { ledger } = setup(); const bodies: any[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      const input = JSON.parse(body.messages[1].content); const result = selected({ ...input, modelId: body.model, protocolId: AI_VALIDATION_IDENTITY_VERSION });
      return new Response(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result.decision) } }],
        usage: { cost: 0.001, prompt_tokens: 1000, completion_tokens: 100 } }));
    });
    const result = await practiceAiModel({ identity, ledger, dailyBudgetUsd: 10,
      createClient: (timeoutMs) => new OpenRouterAgentClient({ apiKey: "synthetic-not-real-key", timeoutMs, fetch: fetcher }) });
    expect(result.report.metrics.requests).toBe(6);
    expect(bodies.every((body) => body.messages[0].content === buildValidationSystemPrompt() && body.max_tokens === 1600)).toBe(true);
    expect(bodies.slice(3).every((body) => !body.messages[1].content.includes("SYNTHETIC_PAST_PRACTICE_DATA"))).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain("synthetic-not-real-key");
  });

  it.each(["future-protocol", "trinity-v1"])("fails closed before any provider request for %s", async (protocolId) => {
    const { ledger, createClient } = setup();
    const result = await practiceAiModel({ identity: { ...identity, protocolId }, ledger, createClient, dailyBudgetUsd: 10 });
    expect(result.report.status).toBe("unsupported-protocol"); expect(ledger.reserveRequest).not.toHaveBeenCalled();
  });

  it("skips disabled identities and bounds rounds, notes and duration", async () => {
    const { ledger, createClient } = setup();
    expect((await practiceAiModel({ identity: { ...identity, enabled: false }, ledger, createClient, dailyBudgetUsd: 10 })).report.status).toBe("disabled");
    for (const extra of [{ rounds: 0 }, { rounds: 4 }, { maxDurationMs: 600_001 }, { initialNotes: "x".repeat(513) }, { dailyBudgetUsd: 11 }]) {
      await expect(practiceAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, ...extra })).rejects.toThrow();
    }
    expect(ledger.reserveRequest).not.toHaveBeenCalled();
  });
});
