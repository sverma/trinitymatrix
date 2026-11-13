import { randomUUID } from "node:crypto";
import type { ServerMessage } from "@trinitymatrix/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiPlayers } from "./ai-players";
import type { AiIdentity, AiStore } from "./ai-repository";
import type { AiAgentDecision, AiAgentDecisionResult } from "./ai-openrouter";
import { AI_GAME_PROTOCOL_IDENTITY_VERSION } from "./ai-game-protocol";
import { AI_VALIDATION_IDENTITY_VERSION, AI_VALIDATION_TOOL_VERSION } from "./ai-game-protocol-v3";
import { checkAiRules, type AiRulesInput } from "./ai-rule-tools";
import { missedWinDeclaration, missedWinHand14, missedWinWildRank } from "./ai-missed-win.fixture";
import { RankingGame } from "./game";
import { Matchmaker, type GameplaySocket } from "./matchmaker";
import { MemoryStateStore } from "./persistence";

type ModelClient = NonNullable<ConstructorParameters<typeof AiPlayers>[2]>;
type DecisionInput = Parameters<ModelClient["decide"]>[0];
const aiId = "00000000-0000-4000-8000-000000000201";
const humanId = "00000000-0000-4000-8000-000000000202";
const modelId = "fixture/exact-selected-model";
const initialMemory = "A private persistent note that must not enter diagnostics.";
const nextMemory = "A private note returned by the selected model.";

class Socket implements GameplaySocket {
  readyState = 1;
  messages: ServerMessage[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw) as ServerMessage); }
  close() { this.readyState = 3; }
}
class Store implements AiStore {
  identities: AiIdentity[] = [{ id: aiId, displayName: "Validation AI", modelId, modelName: "Exact model", memory: initialMemory,
    enabled: true, selectable: true, protocolId: AI_VALIDATION_IDENTITY_VERSION, identityVersion: AI_VALIDATION_IDENTITY_VERSION,
    rating: 1000, gamesPlayed: 0, wins: 0 }];
  listAgents = vi.fn(async () => this.identities.map((identity) => ({ ...identity })));
  reserveRequest = vi.fn<AiStore["reserveRequest"]>(async () => randomUUID());
  finishRequest = vi.fn<AiStore["finishRequest"]>(async () => undefined);
  recordRequestOutcome = vi.fn<NonNullable<AiStore["recordRequestOutcome"]>>(async () => undefined);
  budgetAvailable = vi.fn(async () => true);
  saveMemory = vi.fn<AiStore["saveMemory"]>(async (id, memory) => { this.identities.find((identity) => identity.id === id)!.memory = memory; });
}
function result(input: DecisionInput, decision: Partial<AiAgentDecision> = {}): AiAgentDecisionResult {
  return { modelId: input.modelId, decision: { action: "discard", cardId: missedWinDeclaration.cardId,
    groups: [], memory: nextMemory, ...decision }, usage: { costUsd: 0.001, promptTokens: 1000, completionTokens: 100 } };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function modelClient() {
  return { decide: vi.fn<ModelClient["decide"]>(async (input) => result(input)), cancelAll: vi.fn() };
}
function rulesTool() {
  return { compute: vi.fn(async (input: AiRulesInput, _timeoutMs?: number, _signal?: AbortSignal) => checkAiRules(input)),
    stop: vi.fn<() => Promise<void>>(async () => undefined) };
}

// The fixture can declare immediately, but v3 must never discover or supply that plan.
describe("validation-only model-player runtime", () => {
  const runtimes: AiPlayers[] = []; const matchmakers: Matchmaker[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
    matchmakers.splice(0).forEach((matchmaker) => matchmaker.shutdown());
    vi.useRealTimers();
  });
  async function fixture(options: { model?: ReturnType<typeof modelClient>; protocolId?: string } = {}) {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    const persistence = new MemoryStateStore(); const store = new Store();
    if (options.protocolId) store.identities[0] = { ...store.identities[0]!, protocolId: options.protocolId, identityVersion: options.protocolId };
    const game = new RankingGame([{ id: humanId, displayName: "Private human name" },
      { id: aiId, displayName: "Validation AI", actorKind: "ai", aiModelId: modelId }], () => 0);
    const snapshot = game.snapshot(); snapshot.toss = null; snapshot.wildRank = missedWinWildRank;
    snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === aiId);
    snapshot.revision = 2; snapshot.turnEndsAt = Date.now() + 45_000;
    snapshot.hands = snapshot.hands.map(({ playerId, cards }) => ({ playerId,
      cards: playerId === aiId ? missedWinHand14.map((card) => ({ ...card }))
        : cards.map((card, index) => ({ ...card, id: `opponent-secret-${index}` })) }));
    snapshot.stock = snapshot.stock.map((card, index) => ({ ...card, id: `stock-secret-${index}` }));
    snapshot.drawnBy = aiId; snapshot.drawnCardId = missedWinDeclaration.cardId;
    await persistence.set("matchmaker:active-games", { version: 2, games: [snapshot], queues: { twoPlayer: [], sixPlayer: [] },
      gameTypes: { [snapshot.id]: "general" }, privateRoomCodes: {}, privateRooms: [] });
    const matchmaker = new Matchmaker(persistence); matchmakers.push(matchmaker); await matchmaker.restore();
    const human = new Socket(); matchmaker.register({ playerId: humanId, displayName: "Private human name", socket: human });
    const execute = vi.spyOn(matchmaker, "executeAgentCommand"); const report = vi.fn();
    const model = options.model ?? modelClient(); const tool = rulesTool();
    const runtime = new AiPlayers(matchmaker, store, model, 10, report, { availableModels: [modelId], actionDelayMs: 1, rulesTool: tool });
    runtimes.push(runtime); await runtime.start();
    return { runtime, matchmaker, model, tool, store, human, execute, report };
  }

  it("accepts a legal missed-win discard without computing readiness, supplying facts or forcing a retry", async () => {
    const { model, tool, matchmaker, store, execute, report } = await fixture();
    await vi.advanceTimersByTimeAsync(2);
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(tool.compute).not.toHaveBeenCalled();
    const input = model.decide.mock.calls[0]![0];
    expect(input.protocolId).toBe(AI_VALIDATION_IDENTITY_VERSION);
    expect(input).not.toHaveProperty("rulesFacts");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toMatchObject({ type: "game.discard", cardId: missedWinDeclaration.cardId });
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(13);
    expect(store.reserveRequest.mock.calls[0]![3]).toMatchObject({ protocolId: AI_VALIDATION_IDENTITY_VERSION,
      toolsVersion: AI_VALIDATION_TOOL_VERSION, declarationAvailable: null });
    expect(store.recordRequestOutcome.mock.calls.map(([, audit]) => audit.outcome)).toEqual(["accepted"]);
    expect(report).not.toHaveBeenCalled();
    expect(store.saveMemory).toHaveBeenCalledExactlyOnceWith(aiId, nextMemory);
    expect(JSON.stringify(input)).not.toMatch(/opponent-secret|stock-secret|Private human name/);
  });

  it("rejects an invalid declaration before the engine can drop the player and lets the same model choose a discard", async () => {
    const model = modelClient(); const pending = deferred<AiAgentDecisionResult>();
    model.decide.mockImplementationOnce(async (input) => result(input, { action: "declare",
      groups: [input.observation.hand.slice(0, 13).map(({ id }) => id)] })).mockImplementationOnce(() => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("Test shutdown")));
    const { tool, matchmaker, store, human, execute, report } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(2);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(tool.compute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("playing");
    expect(human.messages.some(({ type }) => type === "game.declaration-rejected" || type === "game.ended")).toBe(false);
    const inputs = model.decide.mock.calls.map(([input]) => input);
    expect(inputs.map(({ modelId }) => modelId)).toEqual([modelId, modelId]);
    expect(inputs.every(({ protocolId }) => protocolId === AI_VALIDATION_IDENTITY_VERSION)).toBe(true);
    expect(inputs.every((input) => !("rulesFacts" in input))).toBe(true);
    const feedback = (inputs[1]!.observation.publicHistory ?? []).join(" ");
    expect(feedback).toContain("Your proposed move was rejected:");
    expect(feedback).not.toMatch(/legal declaration is available|rules facts|winning-card|immediateDeclaration|readyHand/);
    expect(store.saveMemory).not.toHaveBeenCalled();
    pending.resolve(result(inputs[1]!));
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1].type).toBe("game.discard");
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(13);
    expect(store.recordRequestOutcome.mock.calls.map(([, audit]) => audit.outcome)).toEqual(["policy-rejected", "accepted"]);
    expect(store.reserveRequest.mock.calls.every(([, , , audit]) => audit?.declarationAvailable === null)).toBe(true);
    const diagnostics = JSON.stringify({ reports: report.mock.calls, reservations: store.reserveRequest.mock.calls,
      finishes: store.finishRequest.mock.calls, outcomes: store.recordRequestOutcome.mock.calls });
    expect(diagnostics).not.toMatch(/winning-card|opponent-secret|stock-secret|Private human name|persistent note|private note|"groups"|"hand"/);
  });

  it("executes the selected model's valid declaration without replacing or adding groups", async () => {
    const model = modelClient();
    const groups = missedWinDeclaration.groups.map((group) => [...group].reverse()).reverse();
    model.decide.mockImplementation(async (input) => result(input, { action: "declare", groups }));
    const { matchmaker, tool, execute, store } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(1);
    expect(tool.compute).not.toHaveBeenCalled();
    expect(model.decide).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toMatchObject({ type: "game.declare", discardCardId: missedWinDeclaration.cardId, melds: groups });
    expect(matchmaker.agentView(aiId)?.state).toMatchObject({ phase: "showdown", showdown: { declarerId: aiId } });
    expect(store.recordRequestOutcome.mock.calls[0]![1]).toEqual({ outcome: "accepted" });
  });

  it("blocks an unknown protocol before reserving budget or contacting a model", async () => {
    const { tool, store, model, report } = await fixture({ protocolId: "trinity-agent-protocol/999.0.0:unknown" });
    await vi.advanceTimersByTimeAsync(1);
    expect(tool.compute).not.toHaveBeenCalled();
    expect(store.reserveRequest).not.toHaveBeenCalled();
    expect(model.decide).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("unknown-protocol", aiId);
  });

  it("preserves solver-assisted v2 behavior for a game pinned to its historical identity", async () => {
    const model = modelClient(); const pending = deferred<AiAgentDecisionResult>();
    model.decide.mockImplementationOnce(async (input) => result(input)).mockImplementationOnce(() => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("Test shutdown")));
    const { tool, store, execute } = await fixture({ model, protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION });
    await vi.advanceTimersByTimeAsync(2);
    expect(tool.compute).toHaveBeenCalledTimes(2);
    expect(model.decide).toHaveBeenCalledTimes(2);
    const input = model.decide.mock.calls[0]![0];
    expect(input.protocolId).toBe(AI_GAME_PROTOCOL_IDENTITY_VERSION);
    expect(input.rulesFacts).toMatchObject({ status: "complete", immediateDeclaration: expect.any(Object) });
    expect(execute).not.toHaveBeenCalled();
    expect(store.recordRequestOutcome.mock.calls[0]![1]).toEqual({ outcome: "policy-rejected" });
    expect(store.reserveRequest.mock.calls[0]![3]).toMatchObject({ declarationAvailable: true, toolsVersion: "shared-own-hand-legality/1.0.0" });
  });
});
