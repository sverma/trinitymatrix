import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@trinitymatrix/protocol";
import type { AiAgentDecision, AiAgentDecisionResult, AiAgentObservation } from "./ai-openrouter";
import { OpenRouterAgentClient, OpenRouterAgentError } from "./ai-openrouter";
import type { AiIdentity, AiStore } from "./ai-repository";
import { qualifyAiModel } from "./ai-qualification";
import { RankingGame } from "./game";

const identity: AiIdentity = {
  id: "33333333-3333-4333-8333-333333333333", modelId: "provider/model-version", modelName: "Example model",
  displayName: "Model AI", memory: "Private real-profile memory must not be read or changed", enabled: true,
  rating: 1234, gamesPlayed: 99, wins: 50
};
type Input = { modelId: string; observation: AiAgentObservation; memory: string };

function selected(input: Input, override: Partial<AiAgentDecision> = {}): AiAgentDecisionResult {
  const drawn = input.observation.hand.length === 14;
  return {
    modelId: input.modelId,
    decision: { action: drawn ? "discard" : "draw-stock", cardId: drawn ? input.observation.hand.at(-1)!.id : null,
      groups: [], memory: "Fixture-local note", ...override },
    usage: { costUsd: 0.001, promptTokens: 1000, completionTokens: 100 }
  };
}

function store() {
  return {
    reserveRequest: vi.fn<AiStore["reserveRequest"]>(async () => randomUUID()),
    finishRequest: vi.fn<AiStore["finishRequest"]>(async () => undefined),
    saveMemory: vi.fn<AiStore["saveMemory"]>(async () => undefined),
    listAgents: vi.fn<AiStore["listAgents"]>(async () => [identity])
  };
}

function setup(decide = vi.fn(async (input: Input) => selected(input))) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
  const ledger = store();
  const cancelAll = vi.fn();
  const createClient = vi.fn((_timeoutMs: number) => ({ decide, cancelAll }));
  return { ledger, decide, cancelAll, createClient };
}

describe("operator full-turn model qualification", () => {
  afterEach(() => vi.useRealTimers());

  it("requires ten complete model-chosen draw/discard cycles and never writes live profile memory", async () => {
    const { ledger, decide, createClient, cancelAll } = setup();
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10 });
    expect(report).toMatchObject({ status: "passed", turnsRequested: 10, turnsCompleted: 10, turnsMissed: 0,
      draws: 10, discards: 10, requests: 20, retries: 0, invalidActions: 0, forcedDrops: 0, errors: {}, knownCostUsd: 0.02 });
    expect(decide.mock.calls.map(([input]) => input.observation.hand.length)).toEqual(Array.from({ length: 20 }, (_, i) => i % 2 ? 14 : 13));
    expect(decide.mock.calls[0]![0].memory).toBe("");
    expect(decide.mock.calls[1]![0].memory).toBe("Fixture-local note");
    expect(ledger.saveMemory).not.toHaveBeenCalled();
    expect(ledger.listAgents).not.toHaveBeenCalled();
    expect(ledger.reserveRequest).toHaveBeenCalledTimes(20);
    expect(ledger.finishRequest).toHaveBeenCalledTimes(20);
    expect(cancelAll).toHaveBeenCalledTimes(20);
    const encoded = JSON.stringify(report);
    expect(encoded).not.toContain("Fixture-local");
    expect(encoded).not.toContain(identity.memory);
    expect(encoded).not.toContain('"hand"');
    for (const [input] of decide.mock.calls) {
      expect(input.observation.state).not.toHaveProperty("hands");
      expect(input.observation.state).not.toHaveProperty("stock");
    }
  });

  it("respects the shared budget before a timeout retry and retains its unknown cost", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 15_000);
      throw new OpenRouterAgentError("timeout");
    });
    ledger.reserveRequest.mockResolvedValueOnce(randomUUID()).mockResolvedValueOnce(null);
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "budget-unavailable", requests: 1, retries: 0, turnsCompleted: 0,
      turnsMissed: 1, providerErrors: 1, unknownCostRequests: 1, maxLatencyMs: 15_000,
      errors: { timeout: 1, "budget-unavailable": 1 } });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(ledger.finishRequest).toHaveBeenCalledWith(expect.any(String), null, false);
  });

  it("runs complete cycles through the real adapter using only a simulated provider transport", async () => {
    const { ledger } = setup();
    const lengths: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
      const supplied = JSON.parse(request.messages[1]!.content) as Pick<Input, "observation" | "memory">;
      lengths.push(supplied.observation.hand.length);
      const result = selected({ ...supplied, modelId: request.model });
      return new Response(JSON.stringify({
        model: request.model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result.decision) } }],
        usage: { cost: 0.001, prompt_tokens: 1000, completion_tokens: 100 }
      }), { status: 200 });
    });
    const report = await qualifyAiModel({ identity, ledger, dailyBudgetUsd: 10, turns: 2,
      createClient: (timeoutMs) => new OpenRouterAgentClient({ apiKey: "synthetic-qualification-key", timeoutMs, fetch: fetcher }) });
    expect(report).toMatchObject({ status: "passed", turnsCompleted: 2, draws: 2, discards: 2, requests: 4, errors: {} });
    expect(lengths).toEqual([13, 14, 13, 14]);
    expect(ledger.reserveRequest).toHaveBeenCalledTimes(4);
    expect(ledger.finishRequest).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(report)).not.toContain("synthetic-qualification-key");
  });

  it("shares one 45-second deadline across draw and discard and limits each revision to two requests", async () => {
    const { ledger, decide, createClient } = setup();
    let call = 0;
    decide.mockImplementation(async (input) => {
      const durations = [15_000, 14_000, 12_000, 4_000];
      vi.setSystemTime(Date.now() + durations[call]!);
      call += 1;
      if (call === 2) return selected(input);
      throw new OpenRouterAgentError("timeout");
    });
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "failed", turnsCompleted: 0, turnsMissed: 1, requests: 4,
      draws: 1, discards: 0, retries: 2, forcedDrops: 0, maxTurnDurationMs: 45_000,
      errors: { timeout: 3, "turn-deadline": 1 } });
    expect(createClient.mock.calls.map(([timeout]) => timeout)).toEqual([20_000, 20_000, 15_000, 3_000]);
    expect(new Set(decide.mock.calls.map(([input]) => input.observation.state.turnEndsAt)).size).toBe(1);
    expect(ledger.saveMemory).not.toHaveBeenCalled();
  });

  it("counts an illegal fourteen-card action and lets only the same model retry it", async () => {
    const { ledger, decide, createClient } = setup();
    let call = 0;
    decide.mockImplementation(async (input) => {
      call += 1;
      return call === 2 ? selected(input, { action: "draw-stock", cardId: null }) : selected(input);
    });
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "passed", turnsCompleted: 1, requests: 3, draws: 1,
      discards: 1, invalidActions: 1, retries: 1, errors: { "command-already_drawn": 1 } });
    expect(decide.mock.calls.every(([input]) => input.modelId === identity.modelId)).toBe(true);
    expect(decide.mock.calls[2]![0].observation.publicHistory?.at(-1)).toContain("Discard a card before drawing again");
  });

  it("fails qualification when invalid actions exhaust both attempts without choosing a fallback AI move", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => selected(input, { action: "discard", cardId: input.observation.hand[0]!.id }));
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "failed", turnsCompleted: 0, turnsMissed: 1, requests: 2,
      draws: 0, discards: 0, invalidActions: 2, retries: 1, forcedDrops: 0,
      errors: { "command-draw_required": 2, "attempts-exhausted": 1 } });
  });

  it("records a model-chosen invalid declaration as a completed terminal rule loss", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => input.observation.hand.length === 13 ? selected(input) : selected(input, {
      action: "declare", cardId: input.observation.hand.at(-1)!.id,
      groups: [input.observation.hand.slice(0, -1).map(({ id }) => id)]
    }));
    let game: RankingGame | undefined;
    const createGame = (who: AiIdentity, humanId: string) => {
      const seeded = new RankingGame([{ id: who.id, displayName: who.displayName }, { id: humanId, displayName: "Synthetic human" }], () => 0);
      const snapshot = seeded.snapshot();
      snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === who.id);
      game = RankingGame.restore(snapshot);
      return game;
    };
    const report = await qualifyAiModel({ identity, ledger, createClient, createGame, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "passed", turnsCompleted: 1, turnsMissed: 0, declarations: 1,
      validDeclarations: 0, invalidDeclarations: 1, terminalFixtures: 1,
      invalidActions: 1, forcedDrops: 0, providerErrors: 0, errors: {} });
    expect(game!.publicState().phase).toBe("finished");
    expect(game!.publicState().players.find(({ id }) => id === identity.id)?.status).toBe("dropped");
    expect(game!.publicState().players.find(({ id }) => id !== identity.id)?.status).toBe("playing");
  });

  it("continues all ten qualifications in fresh fixtures after visible invalid declaration losses", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockImplementation(async (input) => input.observation.hand.length === 13 ? selected(input) : selected(input, {
      action: "declare", cardId: input.observation.hand.at(-1)!.id,
      groups: [input.observation.hand.slice(0, -1).map(({ id }) => id)]
    }));
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10 });
    expect(report).toMatchObject({ status: "passed", turnsRequested: 10, turnsCompleted: 10, turnsMissed: 0,
      draws: 10, discards: 0, declarations: 10, validDeclarations: 0, invalidDeclarations: 10,
      terminalFixtures: 10, invalidActions: 10, forcedDrops: 0, retries: 0, providerErrors: 0, requests: 20, errors: {} });
    expect(decide.mock.calls.filter(([input]) => input.observation.hand.length === 13).every(([input]) => input.memory === "")).toBe(true);
    expect(new Set(decide.mock.calls.map(([input]) => input.observation.state.gameId)).size).toBe(10);
    expect(ledger.saveMemory).not.toHaveBeenCalled();
  });

  it("completes valid declarations using synthetic final submissions and fresh fixtures for later turns", async () => {
    const { ledger, decide, createClient } = setup();
    const card = (id: string, suit: Card["suit"], rank: number): Card => ({ id, suit, rank, deck: 1, printedJoker: false });
    const groups = [
      [card("ca", "clubs", 1), card("s10", "spades", 10), card("hq", "hearts", 12)],
      [card("c3", "clubs", 3), card("c6", "clubs", 6), card("c9", "clubs", 9)],
      [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6)],
      [card("s2", "spades", 2), card("s4", "spades", 4), card("s6", "spades", 6), card("s3", "spades", 3)]
    ];
    const createGame = vi.fn((who: AiIdentity, humanId: string) => {
      const seeded = new RankingGame([{ id: who.id, displayName: who.displayName }, { id: humanId, displayName: "Synthetic human" }], () => 0);
      const snapshot = seeded.snapshot();
      snapshot.hands = snapshot.hands.map((entry) => entry.playerId === who.id ? { playerId: who.id, cards: groups.flat() } : entry);
      snapshot.stock = [card("final-discard", "hearts", 5)];
      snapshot.wildRank = 13;
      snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === who.id);
      snapshot.turnEndsAt = Date.now() + 45_000;
      return RankingGame.restore(snapshot);
    });
    decide.mockImplementation(async (input) => input.observation.hand.length === 13 ? selected(input) : selected(input, {
      action: "declare", cardId: "final-discard", groups: groups.map((group) => group.map(({ id }) => id))
    }));
    const report = await qualifyAiModel({ identity, ledger, createClient, createGame, dailyBudgetUsd: 10, turns: 2 });
    expect(report).toMatchObject({ status: "passed", turnsCompleted: 2, draws: 2, declarations: 2,
      validDeclarations: 2, invalidDeclarations: 0, terminalFixtures: 2, forcedDrops: 0, requests: 4 });
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[2]![0].memory).toBe("");
  });

  it("stops after a ledger failure and sanitizes unexpected errors without persisting memory", async () => {
    const { ledger, decide, createClient } = setup();
    ledger.finishRequest.mockRejectedValue(new Error("private database detail"));
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "failed", requests: 1, turnsCompleted: 0, errors: { "ledger-unavailable": 1 } });
    expect(JSON.stringify(report)).not.toContain("private database detail");
    expect(decide).toHaveBeenCalledTimes(1);
    expect(ledger.saveMemory).not.toHaveBeenCalled();
  });

  it("validates turn count before spending and never qualifies disabled identities", async () => {
    const { ledger, createClient } = setup();
    await expect(qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 11 })).rejects.toThrow("1 through 10");
    await expect(qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 11 })).rejects.toThrow("at most USD 10");
    const disabled = await qualifyAiModel({ identity: { ...identity, enabled: false }, ledger, createClient, dailyBudgetUsd: 10 });
    expect(disabled).toMatchObject({ status: "disabled", requests: 0, errors: { "agent-disabled": 1 } });
    expect(ledger.reserveRequest).not.toHaveBeenCalled();
  });

  it("reports safe provider diagnostics and settles known billed usage on malformed decisions", async () => {
    const { ledger, decide, createClient } = setup();
    decide.mockRejectedValueOnce(new OpenRouterAgentError("invalid-decision", {
      status: 200, finishReason: "stop", usage: { costUsd: 0.002, promptTokens: 100, completionTokens: 100 }
    }));
    const report = await qualifyAiModel({ identity, ledger, createClient, dailyBudgetUsd: 10, turns: 1 });
    expect(report).toMatchObject({ status: "passed", turnsCompleted: 1, invalidActions: 1, retries: 1,
      errors: { "invalid-decision": 1 }, httpStatuses: { "200": 1 }, finishReasons: { stop: 1 }, knownCostUsd: 0.004 });
    expect(ledger.finishRequest).toHaveBeenCalledWith(expect.any(String), 0.002, false);
  });
});
