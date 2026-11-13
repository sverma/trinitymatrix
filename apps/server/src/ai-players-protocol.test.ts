import { randomUUID } from "node:crypto";
import type { ServerMessage } from "@trinitymatrix/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiPlayers } from "./ai-players";
import type { AiIdentity, AiStore } from "./ai-repository";
import type { AiAgentDecision, AiAgentDecisionResult } from "./ai-openrouter";
import { AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_LEGACY_V1_PROTOCOL_VERSION, type AiGameRulesFacts } from "./ai-game-protocol";
import { checkAiRules, unavailableAiRules, type AiRulesInput } from "./ai-rule-tools";
import { missedWinDeclaration, missedWinHand13, missedWinHand14, missedWinWildRank } from "./ai-missed-win.fixture";
import { RankingGame } from "./game";
import { Matchmaker, type GameplaySocket } from "./matchmaker";
import { MemoryStateStore } from "./persistence";

type ModelClient = NonNullable<ConstructorParameters<typeof AiPlayers>[2]>;
type DecisionInput = Parameters<ModelClient["decide"]>[0];
const aiId = "00000000-0000-4000-8000-000000000101";
const humanId = "00000000-0000-4000-8000-000000000102";
const currentId = "00000000-0000-4000-8000-000000000103";
const modelId = "fixture/exact-selected-model";

class Socket implements GameplaySocket {
  readyState = 1;
  messages: ServerMessage[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw) as ServerMessage); }
  close() { this.readyState = 3; }
}
class Store implements AiStore {
  identities: AiIdentity[] = [{ id: aiId, displayName: "Protocol AI", modelId, modelName: "Exact model", memory: "Own persistent note",
    enabled: true, selectable: true, protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION, identityVersion: AI_GAME_PROTOCOL_IDENTITY_VERSION,
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
    groups: [], memory: "The selected model returned this action.", ...decision },
    usage: { costUsd: 0.001, promptTokens: 1000, completionTokens: 100 } };
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
  return { compute: vi.fn(async (input: AiRulesInput, _timeoutMs?: number, _signal?: AbortSignal) => checkAiRules(input)), stop: vi.fn<() => Promise<void>>(async () => undefined) };
}

describe("versioned model-player runtime policy", () => {
  const runtimes: AiPlayers[] = []; const matchmakers: Matchmaker[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
    matchmakers.splice(0).forEach((matchmaker) => matchmaker.shutdown());
    vi.useRealTimers();
  });
  async function fixture(options: { model?: ReturnType<typeof modelClient>; tool?: ReturnType<typeof rulesTool>; legacy?: boolean; drawn?: boolean } = {}) {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    const persistence = new MemoryStateStore(); const store = new Store();
    if (options.legacy) {
      store.identities[0] = { ...store.identities[0]!, protocolId: AI_LEGACY_V1_PROTOCOL_VERSION, identityVersion: AI_LEGACY_V1_PROTOCOL_VERSION, selectable: false };
      store.identities.push({ ...store.identities[0]!, id: currentId, displayName: "Current protocol AI", protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION,
        identityVersion: AI_GAME_PROTOCOL_IDENTITY_VERSION, selectable: true });
    }
    const game = new RankingGame([{ id: humanId, displayName: "Private human name" }, { id: aiId, displayName: "Protocol AI", actorKind: "ai", aiModelId: modelId }], () => 0);
    const snapshot = game.snapshot(); snapshot.toss = null; snapshot.wildRank = missedWinWildRank;
    snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === aiId);
    snapshot.revision = 2; snapshot.turnEndsAt = Date.now() + 45_000;
    snapshot.hands = snapshot.hands.map(({ playerId, cards }) => ({ playerId,
      cards: playerId === aiId ? (options.drawn === false ? missedWinHand13 : missedWinHand14).map((card) => ({ ...card }))
        : cards.map((card, index) => ({ ...card, id: `opponent-secret-${index}` })) }));
    snapshot.stock = snapshot.stock.map((card, index) => ({ ...card, id: `stock-secret-${index}` }));
    if (options.drawn !== false) { snapshot.drawnBy = aiId; snapshot.drawnCardId = missedWinDeclaration.cardId; }
    await persistence.set("matchmaker:active-games", { version: 2, games: [snapshot], queues: { twoPlayer: [], sixPlayer: [] },
      gameTypes: { [snapshot.id]: "general" }, privateRoomCodes: {}, privateRooms: [] });
    const matchmaker = new Matchmaker(persistence); matchmakers.push(matchmaker); await matchmaker.restore();
    const human = new Socket(); matchmaker.register({ playerId: humanId, displayName: "Private human name", socket: human });
    const execute = vi.spyOn(matchmaker, "executeAgentCommand"); const report = vi.fn();
    const model = options.model ?? modelClient(); const tool = options.tool ?? rulesTool();
    const runtime = new AiPlayers(matchmaker, store, model, 10, report, { availableModels: [modelId], actionDelayMs: 1, rulesTool: tool });
    runtimes.push(runtime); await runtime.start();
    return { runtime, matchmaker, model, tool, store, human, execute, report };
  }

  it("rejects a missed winning discard, retries the same model, and executes only its later valid declaration", async () => {
    const model = modelClient(); const pending = deferred<AiAgentDecisionResult>();
    model.decide.mockImplementationOnce(async (input) => result(input))
      .mockImplementationOnce(() => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("Test shutdown")));
    const { matchmaker, tool, store, execute } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(2);
    expect(model.decide).toHaveBeenCalledTimes(2);
    const calls = model.decide.mock.calls.map(([input]) => input);
    expect(calls.map(({ modelId }) => modelId)).toEqual([modelId, modelId]);
    expect(calls.every(({ protocolId }) => protocolId === AI_GAME_PROTOCOL_IDENTITY_VERSION)).toBe(true);
    expect(calls[0]!.rulesFacts).toMatchObject({ status: "complete", immediateDeclaration: expect.any(Object) });
    expect((calls[1]!.observation.publicHistory ?? []).join(" ")).toContain("legal declaration is available");
    expect(tool.compute).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.state).toMatchObject({ revision: 2, phase: "playing" });
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(14);
    expect(store.saveMemory).not.toHaveBeenCalled();
    pending.resolve(result(calls[1]!, { action: "declare", cardId: missedWinDeclaration.cardId, groups: missedWinDeclaration.groups }));
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toMatchObject({ type: "game.declare", discardCardId: missedWinDeclaration.cardId, melds: missedWinDeclaration.groups });
    expect(matchmaker.agentView(aiId)?.state).toMatchObject({ phase: "showdown", showdown: { declarerId: aiId } });
    expect(store.recordRequestOutcome.mock.calls.map(([, context]) => context.outcome)).toEqual(["policy-rejected", "accepted"]);
    expect(store.reserveRequest).toHaveBeenCalledTimes(2);
    expect(store.reserveRequest.mock.calls[0]![3]).toMatchObject({ protocolId: AI_GAME_PROTOCOL_IDENTITY_VERSION, declarationAvailable: true, toolsVersion: "shared-own-hand-legality/1.0.0" });
    expect(JSON.stringify(calls)).not.toMatch(/opponent-secret|stock-secret|Private human name/);
  });

  it("retries a v2 invalid declaration before the engine can drop the AI", async () => {
    const model = modelClient(); const pending = deferred<AiAgentDecisionResult>();
    model.decide.mockImplementationOnce(async (input) => result(input, { action: "declare", groups: [input.observation.hand.slice(0, 13).map(({ id }) => id)] }))
      .mockImplementationOnce(() => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("Test shutdown")));
    const { matchmaker, execute, human, store } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(2);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("playing");
    expect(human.messages.some(({ type }) => type === "game.declaration-rejected" || type === "game.ended")).toBe(false);
    const second = model.decide.mock.calls[1]![0];
    expect(second.modelId).toBe(modelId);
    expect((second.observation.publicHistory ?? []).join(" ")).toContain("declaration was invalid");
    pending.resolve(result(second, { action: "declare", cardId: missedWinDeclaration.cardId, groups: missedWinDeclaration.groups }));
    await vi.advanceTimersByTimeAsync(0);
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("showdown");
    expect(store.recordRequestOutcome.mock.calls[0]![1]).toMatchObject({ outcome: "policy-rejected" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("registers recovered legacy identities while excluding them from the new-match roster", async () => {
    const { runtime, matchmaker, tool, model } = await fixture({ legacy: true });
    expect(matchmaker.agentView(aiId)?.state.players.find(({ id }) => id === aiId)?.connected).toBe(true);
    const roster = await runtime.roster();
    expect(roster.players.map(({ id }) => id)).toEqual([currentId]);
    expect(roster.players[0]?.protocolId).toBe(AI_GAME_PROTOCOL_IDENTITY_VERSION);
    await expect(runtime.startMatch(humanId, [aiId])).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(1);
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(model.decide.mock.calls[0]![0].protocolId).toBe(AI_LEGACY_V1_PROTOCOL_VERSION);
    expect(model.decide.mock.calls[0]![0].rulesFacts).toBeUndefined();
    expect(tool.compute).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(13);
  });

  it("keeps unavailable tool facts unknown while allowing the model's own ordinary legal discard", async () => {
    const tool = rulesTool(); tool.compute.mockResolvedValue(unavailableAiRules("time-budget"));
    const { model, matchmaker, store, execute } = await fixture({ tool });
    await vi.advanceTimersByTimeAsync(1);
    expect(model.decide.mock.calls[0]![0].rulesFacts).toMatchObject({ status: "unavailable", immediateDeclaration: null });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1].type).toBe("game.discard");
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(13);
    expect(store.reserveRequest.mock.calls[0]![3]).toMatchObject({ declarationAvailable: null });
  });

  it("ignores a tool result for an obsolete revision before reserving any model budget", async () => {
    const pending = deferred<AiGameRulesFacts>(); const tool = rulesTool(); tool.compute.mockImplementationOnce(() => pending.promise);
    tool.stop.mockImplementation(async () => pending.resolve(unavailableAiRules("tool-error")));
    const { matchmaker, model, store } = await fixture({ tool });
    await vi.advanceTimersByTimeAsync(1);
    expect(tool.compute).toHaveBeenCalledTimes(1); expect(store.reserveRequest).not.toHaveBeenCalled();
    const before = matchmaker.agentView(aiId)!;
    matchmaker.executeAgentCommand(aiId, { type: "game.discard", cardId: missedWinDeclaration.cardId, commandId: randomUUID(), gameId: before.state.gameId, expectedRevision: before.state.revision });
    pending.resolve(checkAiRules({ hand: missedWinHand14, wildRank: missedWinWildRank }));
    await vi.advanceTimersByTimeAsync(0);
    expect(model.decide).not.toHaveBeenCalled(); expect(store.reserveRequest).not.toHaveBeenCalled();
  });

  it("stops a pending tool computation before awaiting turn shutdown and makes no paid request", async () => {
    const pending = deferred<AiGameRulesFacts>(); const tool = rulesTool(); tool.compute.mockImplementationOnce(() => pending.promise);
    tool.stop.mockImplementation(async () => pending.resolve(unavailableAiRules("tool-error")));
    const { runtime, store, model } = await fixture({ tool });
    await vi.advanceTimersByTimeAsync(1);
    await runtime.stop();
    expect(tool.stop).toHaveBeenCalledOnce();
    expect(store.reserveRequest).not.toHaveBeenCalled(); expect(model.decide).not.toHaveBeenCalled();
  });
});
