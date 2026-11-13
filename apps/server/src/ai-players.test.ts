import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@trinitymatrix/protocol";
import { AiPlayers } from "./ai-players";
import type { AiIdentity, AiStore } from "./ai-repository";
import type { AiAgentDecision, AiAgentDecisionResult } from "./ai-openrouter";
import { OpenRouterAgentError } from "./ai-openrouter";
import { RankingGame } from "./game";
import { Matchmaker, type GameplaySocket } from "./matchmaker";
import { MemoryStateStore } from "./persistence";

type ModelClient = NonNullable<ConstructorParameters<typeof AiPlayers>[2]>;
type DecisionInput = Parameters<ModelClient["decide"]>[0];
const aiId = "00000000-0000-4000-8000-000000000001";
const humanId = "00000000-0000-4000-8000-000000000002";
const modelId = "example/model-v1";
const realHumanName = "Private human name";

class HumanSocket implements GameplaySocket {
  readyState = 1;
  messages: ServerMessage[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw) as ServerMessage); }
  close() { this.readyState = 3; }
}

class MemoryAiStore implements AiStore {
  identities: AiIdentity[] = [{
    id: aiId, displayName: "Model AI", modelId, modelName: "Example model", memory: "Retained strategy note",
    enabled: true, rating: 1000, gamesPlayed: 0, wins: 0
  }];
  budget = true;
  listAgents = vi.fn(async () => this.identities.map((identity) => ({ ...identity })));
  reserveRequest = vi.fn<AiStore["reserveRequest"]>(async () => this.budget ? randomUUID() : null);
  finishRequest = vi.fn<AiStore["finishRequest"]>(async () => undefined);
  budgetAvailable = vi.fn<AiStore["budgetAvailable"]>(async () => this.budget);
  saveMemory = vi.fn<AiStore["saveMemory"]>(async (id, memory) => {
    this.identities.find((identity) => identity.id === id)!.memory = memory;
  });
}

function chosenDecision(input: DecisionInput, override: Partial<AiAgentDecision> = {}): AiAgentDecisionResult {
  return {
    modelId: input.modelId,
    decision: {
      action: input.observation.hand.length === 13 ? "draw-stock" : "discard",
      cardId: input.observation.hand.length === 13 ? null : input.observation.hand.at(-1)!.id,
      groups: [], memory: "The model chose this move.", ...override
    },
    usage: { costUsd: 0.001, promptTokens: 1000, completionTokens: 100 }
  };
}

function client() {
  return {
    decide: vi.fn<ModelClient["decide"]>(async (input) => chosenDecision(input)),
    cancelAll: vi.fn()
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("persistent model players", () => {
  const runtimes: AiPlayers[] = [];
  const matchmakers: Matchmaker[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
    matchmakers.splice(0).forEach((matchmaker) => matchmaker.shutdown());
    vi.useRealTimers();
  });

  async function fixture(options: { botTurn?: boolean; drawn?: boolean; showdown?: boolean; deadlineMs?: number; model?: ReturnType<typeof client> } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const stateStore = new MemoryStateStore();
    const store = new MemoryAiStore();
    const model = options.model ?? client();
    const game = new RankingGame([
      { id: humanId, displayName: realHumanName },
      { id: aiId, displayName: "Model AI", actorKind: "ai", aiModelId: modelId }
    ], () => 0);
    const snapshot = game.snapshot();
    snapshot.toss = null;
    snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === (options.botTurn === false ? humanId : aiId));
    snapshot.hands = snapshot.hands.map(({ playerId, cards }) => ({
      playerId, cards: cards.map((card, index) => ({ ...card, id: `${playerId === aiId ? "ai-owned" : "opponent-secret"}-${index}` }))
    }));
    snapshot.stock = snapshot.stock.map((card, index) => ({ ...card, id: `stock-secret-${index}` }));
    snapshot.revision = 2;
    snapshot.turnEndsAt = Date.now() + (options.deadlineMs ?? 45_000);
    if (options.drawn) {
      const drawn = { ...snapshot.stock.pop()!, id: "ai-drawn-card" };
      snapshot.hands.find(({ playerId }) => playerId === aiId)!.cards.push(drawn);
      snapshot.drawnBy = aiId;
      snapshot.drawnCardId = drawn.id;
    }
    if (options.showdown) {
      snapshot.phase = "showdown";
      snapshot.seats = snapshot.seats.map((seat) => seat.id === humanId ? { ...seat, status: "declared" } : seat);
      snapshot.showdown = { declarerId: humanId, pendingPlayerIds: [aiId], submissions: [], endsAt: Date.now() + 45_000, score: 72 };
    }
    await stateStore.set("matchmaker:active-games", {
      version: 2, games: [snapshot], queues: { twoPlayer: [], sixPlayer: [] },
      gameTypes: { [snapshot.id]: "general" }, privateRoomCodes: {}, privateRooms: []
    });
    const matchmaker = new Matchmaker(stateStore);
    matchmakers.push(matchmaker);
    await matchmaker.restore();
    const humanSocket = new HumanSocket();
    matchmaker.register({ playerId: humanId, displayName: realHumanName, socket: humanSocket });
    const report = vi.fn();
    const runtime = new AiPlayers(matchmaker, store, model, 10, report, { availableModels: [modelId], actionDelayMs: 1 });
    runtimes.push(runtime);
    await runtime.start();
    return { runtime, matchmaker, model, store, stateStore, snapshot, humanSocket, report };
  }

  it("sends only the AI's hand and public observations, with human names pseudonymized", async () => {
    const { model, store, snapshot } = await fixture();
    await vi.advanceTimersByTimeAsync(1);
    expect(model.decide).toHaveBeenCalledTimes(1);
    const input = model.decide.mock.calls[0]![0];
    expect(input.modelId).toBe(modelId);
    expect(input.memory).toBe("Retained strategy note");
    expect(input.observation.hand).toEqual(snapshot.hands.find(({ playerId }) => playerId === aiId)!.cards);
    const serialized = JSON.stringify(input.observation);
    expect(serialized).not.toContain("opponent-secret");
    expect(serialized).not.toContain("stock-secret");
    expect(serialized).not.toContain(realHumanName);
    expect(serialized).not.toContain('"hands"');
    expect(serialized).not.toContain('"stock":');
    expect(input.observation.state.players.find(({ id }) => id === humanId)?.displayName).toMatch(/^Human seat [12]$/);
    expect(store.reserveRequest).toHaveBeenCalledWith(aiId, modelId, 10);
  });

  it("retries persistent identity registration after a transient startup-store failure", async () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    matchmakers.push(matchmaker);
    const store = new MemoryAiStore();
    store.listAgents.mockRejectedValueOnce(new Error("Transient PostgreSQL disconnect"));
    const runtime = new AiPlayers(matchmaker, store, null, 10);
    runtimes.push(runtime);
    await expect(runtime.start()).rejects.toThrow("Transient PostgreSQL disconnect");
    await runtime.start();
    expect(store.listAgents).toHaveBeenCalledTimes(2);
    expect(matchmaker.isPlayerAvailable(aiId)).toBe(true);
  });

  it("cleans up a partial registration failure without forfeiting the restored game", async () => {
    const { runtime, matchmaker, store, model } = await fixture({ botTurn: false });
    await runtime.stop();
    store.identities.push({ ...store.identities[0]!, id: randomUUID(), displayName: "Other AI" });
    const originalRegister = matchmaker.register.bind(matchmaker);
    vi.spyOn(matchmaker, "register")
      .mockImplementationOnce(originalRegister)
      .mockImplementationOnce(() => { throw new Error("Temporary registration failure"); })
      .mockImplementation(originalRegister);
    const before = matchmaker.agentView(aiId)!;
    await expect(runtime.start()).rejects.toThrow("Temporary registration failure");
    expect(matchmaker.agentView(aiId)?.state).toMatchObject({ gameId: before.state.gameId, phase: "playing" });
    expect(matchmaker.agentView(aiId)?.state.players.find(({ id }) => id === aiId)?.connected).toBe(false);
    await runtime.start();
    expect(matchmaker.agentView(aiId)?.hand).toEqual(before.hand);
    expect(matchmaker.agentView(aiId)?.state.players.find(({ id }) => id === aiId)?.connected).toBe(true);
    expect(model.decide).not.toHaveBeenCalled();
  });

  it("does not attach a stale startup when stopped and restarted during an identity-store request", async () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    matchmakers.push(matchmaker);
    const store = new MemoryAiStore();
    const oldIdentities = deferred<AiIdentity[]>();
    store.listAgents.mockImplementationOnce(() => oldIdentities.promise);
    const register = vi.spyOn(matchmaker, "register");
    const runtime = new AiPlayers(matchmaker, store, null, 10);
    runtimes.push(runtime);
    const oldStart = runtime.start();
    await runtime.stop();
    await runtime.start();
    oldIdentities.resolve([{ ...store.identities[0]!, displayName: "Stale identity" }]);
    await oldStart;
    expect(store.listAgents).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0].displayName).toBe("Model AI");
    expect(matchmaker.isPlayerAvailable(aiId)).toBe(true);
  });

  it("executes the model's draw and subsequent discard without a strategy-engine substitute", async () => {
    const { model, matchmaker, store } = await fixture();
    await vi.advanceTimersByTimeAsync(2);
    expect(model.decide).toHaveBeenCalledTimes(2);
    const second = model.decide.mock.calls[1]![0];
    expect(second.observation.hand).toHaveLength(14);
    const chosenCard = second.observation.hand.at(-1)!;
    const view = matchmaker.agentView(aiId)!;
    expect(view.state.topDiscard?.id).toBe(chosenCard.id);
    expect(view.hand).toHaveLength(13);
    expect(view.state.currentPlayerId).toBe(humanId);
    expect(store.saveMemory).toHaveBeenCalledTimes(2);
    expect(model.decide.mock.calls[1]![0].memory).toBe("The model chose this move.");
  });

  it("does not spend inference budget while it is another player's turn", async () => {
    const { model, store } = await fixture({ botTurn: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).not.toHaveBeenCalled();
    expect(store.reserveRequest).not.toHaveBeenCalled();
  });

  it("rejects concurrent requests that attempt to seat one persistent identity twice", async () => {
    const { runtime, matchmaker } = await fixture();
    // Release the seeded table, then let two humans contend for the same AI.
    matchmaker.handle(humanId, { type: "game.drop", gameId: matchmaker.agentView(aiId)!.state.gameId, expectedRevision: 2, commandId: randomUUID() });
    const anotherHuman = "00000000-0000-4000-8000-000000000004";
    matchmaker.register({ playerId: anotherHuman, displayName: "Another human", socket: new HumanSocket() });
    const results = await Promise.allSettled([runtime.startMatch(humanId, [aiId]), runtime.startMatch(anotherHuman, [aiId])]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const roster = await runtime.roster();
    expect(roster.players[0]).toMatchObject({ available: false, reason: "Playing another match." });
  });

  it("restores the same identity, model and hand when the server worker restarts", async () => {
    const { runtime, matchmaker, store, stateStore, model } = await fixture();
    const before = matchmaker.agentView(aiId)!;
    await matchmaker.flush();
    await runtime.stop();
    matchmaker.shutdown();
    const recovered = new Matchmaker(stateStore);
    matchmakers.push(recovered);
    await recovered.restore();
    recovered.register({ playerId: humanId, displayName: realHumanName, socket: new HumanSocket() });
    const restarted = new AiPlayers(recovered, store, model, 10, vi.fn(), { availableModels: [modelId], actionDelayMs: 1 });
    runtimes.push(restarted);
    await restarted.start();
    const after = recovered.agentView(aiId)!;
    expect(after.state.gameId).toBe(before.state.gameId);
    expect(after.hand).toEqual(before.hand);
    expect(after.state.players.find(({ id }) => id === aiId)).toMatchObject({ actorKind: "ai", aiModelId: modelId });
    await vi.advanceTimersByTimeAsync(1);
    expect(model.decide.mock.calls[0]![0]).toMatchObject({ modelId, memory: "Retained strategy note" });
  });

  it("ignores an inference result when the authoritative revision changed meanwhile", async () => {
    const pending = deferred<AiAgentDecisionResult>();
    const model = client();
    model.decide.mockImplementationOnce(async () => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("cancelled")));
    const { matchmaker, store } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(1);
    const old = model.decide.mock.calls[0]![0];
    matchmaker.executeAgentCommand(aiId, {
      type: "game.draw", source: "stock", commandId: randomUUID(), gameId: old.observation.state.gameId,
      expectedRevision: old.observation.state.revision
    });
    pending.resolve(chosenDecision(old, { action: "discard", cardId: old.observation.hand[0]!.id }));
    await vi.advanceTimersByTimeAsync(0);
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(14);
    expect(store.finishRequest).toHaveBeenCalledWith(expect.any(String), 0.001, true);
    expect(store.saveMemory).not.toHaveBeenCalled();
  });

  it("cannot forfeit a new game because a previous game's inference failed late", async () => {
    const pending = deferred<AiAgentDecisionResult>();
    const model = client();
    model.decide.mockImplementationOnce(async () => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("cancelled")));
    const { runtime, matchmaker } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(1);
    const old = model.decide.mock.calls[0]![0];
    matchmaker.handle(humanId, {
      type: "game.drop", commandId: randomUUID(), gameId: old.observation.state.gameId, expectedRevision: old.observation.state.revision
    });
    const newId = await runtime.startMatch(humanId, [aiId]);
    pending.reject(new Error("late provider error"));
    await vi.advanceTimersByTimeAsync(0);
    expect(newId).not.toBe(old.observation.state.gameId);
    expect(matchmaker.agentView(aiId)?.state).toMatchObject({ gameId: newId, phase: "playing" });
  });

  it("lets the ordinary validator forfeit an illegal model declaration", async () => {
    const model = client();
    model.decide.mockImplementation(async (input) => chosenDecision(input, {
      action: "declare", cardId: input.observation.hand.at(-1)!.id,
      groups: [input.observation.hand.slice(0, -1).map(({ id }) => id)]
    }));
    const { humanSocket, matchmaker } = await fixture({ drawn: true, model });
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(matchmaker.agentView(aiId)).toBeNull();
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.declaration-rejected", dropped: true }));
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.ended", winnerId: humanId, reason: "invalid-declaration" }));
  });

  it("pauses after two invalid commands and applies the normal turn timeout without surrendering", async () => {
    const model = client();
    model.decide.mockImplementation(async (input) => chosenDecision(input, { action: "discard", cardId: input.observation.hand[0]!.id }));
    const { humanSocket, matchmaker } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(model.decide.mock.calls[1]![0].observation.publicHistory?.at(-1)).toContain("Draw before discarding");
    expect(humanSocket.messages.some(({ type }) => type === "game.ended")).toBe(false);
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("playing");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(matchmaker.agentView(aiId)?.state.currentPlayerId).toBe(humanId);
  });

  it("retains unknown failed-request cost and never falls back to another model", async () => {
    const model = client();
    model.decide.mockRejectedValue(new Error("provider failed"));
    const { store, humanSocket } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(model.decide.mock.calls.every(([input]) => input.modelId === modelId)).toBe(true);
    expect(store.finishRequest).toHaveBeenCalledWith(expect.any(String), null, false);
    expect(humanSocket.messages.some(({ type }) => type === "game.ended")).toBe(false);
  });

  it("does not contact a model when the shared daily reservation cannot be obtained", async () => {
    const { model, store, humanSocket } = await fixture();
    store.budget = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(store.reserveRequest).toHaveBeenCalledTimes(1);
    expect(model.decide).not.toHaveBeenCalled();
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.ended", winnerId: humanId }));
  });

  it("blocks showdown after a failed model call instead of repeatedly spending on submissions", async () => {
    const model = client();
    model.decide.mockRejectedValue(new Error("provider failed"));
    const { matchmaker, store } = await fixture({ showdown: true, model });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(store.reserveRequest).toHaveBeenCalledTimes(2);
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("showdown");
  });

  it("recovers from a malformed discard with the same model and records known billed usage", async () => {
    const model = client();
    model.decide.mockRejectedValueOnce(new OpenRouterAgentError("invalid-decision", {
      usage: { costUsd: 0.002, promptTokens: 1000, completionTokens: 200 }
    }));
    const { matchmaker, humanSocket, store, report } = await fixture({ drawn: true, model });
    await vi.advanceTimersByTimeAsync(2);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(model.decide.mock.calls.every(([input]) => input.modelId === modelId && input.observation.hand.length === 14)).toBe(true);
    expect(model.decide.mock.calls[1]![0].observation.publicHistory?.at(-1)).toContain("invalid-decision");
    expect(matchmaker.agentView(aiId)?.state.currentPlayerId).toBe(humanId);
    expect(store.finishRequest).toHaveBeenCalledWith(expect.any(String), 0.002, false);
    expect(report).toHaveBeenCalledWith("model-request-failed", aiId, expect.objectContaining({ errorCode: "invalid-decision", handCount: 14, modelId }));
    expect(humanSocket.messages.some(({ type }) => type === "game.ended")).toBe(false);
  });

  it.each([401, 402, 403])("does not repeatedly bill retries when the provider denies access with HTTP %s", async (status) => {
    const model = client();
    model.decide.mockRejectedValue(new OpenRouterAgentError("http-error", { status }));
    const { matchmaker, humanSocket } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(matchmaker.agentView(aiId)).toBeNull();
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.player-dropped", reasonCode: "AI_UNAVAILABLE", reason: expect.stringContaining("provider denied access") }));
  });

  it("shrinks the retry timeout to the remaining normal turn deadline", async () => {
    const model = client();
    model.decide.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      throw new OpenRouterAgentError("timeout");
    });
    const { matchmaker } = await fixture({ drawn: true, deadlineMs: 23_000, model });
    await vi.advanceTimersByTimeAsync(20_002);
    expect(model.decide).toHaveBeenCalledTimes(2);
    expect(model.decide.mock.calls[0]![0].timeoutMs).toBe(20_000);
    expect(model.decide.mock.calls[1]![0].timeoutMs).toBeGreaterThan(1_000);
    expect(model.decide.mock.calls[1]![0].timeoutMs).toBeLessThanOrEqual(2_000);
    expect(matchmaker.agentView(aiId)?.state.currentPlayerId).toBe(humanId);
  });

  it("does not reserve or dispatch another request when the turn deadline is too close", async () => {
    const { matchmaker, model, store } = await fixture({ drawn: true, deadlineMs: 1_500 });
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).not.toHaveBeenCalled();
    expect(store.reserveRequest).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(14);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(matchmaker.agentView(aiId)?.hand).toHaveLength(13);
    expect(matchmaker.agentView(aiId)?.state.currentPlayerId).toBe(humanId);
  });

  it("forfeits with a technical reason only after three consecutive failed AI turns", async () => {
    const model = client();
    model.decide.mockRejectedValue(new OpenRouterAgentError("timeout"));
    const { matchmaker, humanSocket } = await fixture({ model });
    for (let turn = 0; turn < 3; turn++) {
      await vi.advanceTimersByTimeAsync(3);
      expect(model.decide).toHaveBeenCalledTimes((turn + 1) * 2);
      if (turn === 2) break;
      expect(humanSocket.messages.some(({ type }) => type === "game.ended")).toBe(false);
      await vi.advanceTimersByTimeAsync(45_000);
      let view = matchmaker.agentView(humanId)!;
      matchmaker.handle(humanId, { type: "game.draw", source: "stock", commandId: randomUUID(), gameId: view.state.gameId, expectedRevision: view.state.revision });
      view = matchmaker.agentView(humanId)!;
      matchmaker.handle(humanId, { type: "game.discard", cardId: view.hand.at(-1)!.id, commandId: randomUUID(), gameId: view.state.gameId, expectedRevision: view.state.revision });
    }
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.player-dropped", reasonCode: "AI_UNAVAILABLE", reason: expect.stringContaining("three consecutive turns") }));
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.ended", winnerId: humanId }));
  });

  it("clears the consecutive-failure count after a complete successful model turn", async () => {
    const model = client();
    model.decide.mockRejectedValueOnce(new OpenRouterAgentError("timeout")).mockRejectedValueOnce(new OpenRouterAgentError("timeout"));
    const { matchmaker, humanSocket } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(45_000);
    const playHumanTurn = () => {
      let view = matchmaker.agentView(humanId)!;
      matchmaker.handle(humanId, { type: "game.draw", source: "stock", commandId: randomUUID(), gameId: view.state.gameId, expectedRevision: view.state.revision });
      view = matchmaker.agentView(humanId)!;
      matchmaker.handle(humanId, { type: "game.discard", cardId: view.hand.at(-1)!.id, commandId: randomUUID(), gameId: view.state.gameId, expectedRevision: view.state.revision });
    };
    playHumanTurn();
    await vi.advanceTimersByTimeAsync(3);
    expect(matchmaker.agentView(aiId)?.state.currentPlayerId).toBe(humanId);
    model.decide.mockRejectedValue(new OpenRouterAgentError("timeout"));
    for (let turn = 0; turn < 2; turn++) {
      playHumanTurn();
      await vi.advanceTimersByTimeAsync(45_000);
    }
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("playing");
    expect(humanSocket.messages.some(({ type }) => type === "game.ended")).toBe(false);
  });

  it("blocks showdown budget exhaustion and storage failures without further model requests", async () => {
    const { matchmaker, store, model } = await fixture({ showdown: true });
    store.reserveRequest.mockRejectedValue(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.reserveRequest).toHaveBeenCalledTimes(1);
    expect(model.decide).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("showdown");
  });

  it("waits for the showdown deadline after budget exhaustion instead of repeatedly reserving", async () => {
    const { matchmaker, store, model } = await fixture({ showdown: true });
    store.budget = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.reserveRequest).toHaveBeenCalledTimes(1);
    expect(model.decide).not.toHaveBeenCalled();
    expect(matchmaker.agentView(aiId)?.state.phase).toBe("showdown");
  });

  it("does not repeat a paid call after ledger finalization fails", async () => {
    const { store, model, humanSocket } = await fixture();
    store.finishRequest.mockRejectedValue(new Error("database unavailable"));
    await vi.advanceTimersByTimeAsync(100);
    expect(model.decide).toHaveBeenCalledTimes(1);
    expect(humanSocket.messages).toContainEqual(expect.objectContaining({ type: "game.ended", winnerId: humanId }));
  });

  it("aborts a pending inference on shutdown without a late action or database settlement", async () => {
    const pending = deferred<AiAgentDecisionResult>();
    const model = client();
    model.decide.mockImplementationOnce(async () => pending.promise);
    model.cancelAll.mockImplementation(() => pending.reject(new Error("cancelled")));
    const { runtime, matchmaker, store } = await fixture({ model });
    await vi.advanceTimersByTimeAsync(1);
    const before = matchmaker.agentView(aiId)!;
    await runtime.stop();
    expect(model.cancelAll).toHaveBeenCalledTimes(1);
    expect(matchmaker.agentView(aiId)).toEqual(before);
    expect(store.finishRequest).not.toHaveBeenCalled();
    expect(store.saveMemory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(model.decide).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-progress catalog request and does not attach players after shutdown", async () => {
    const matchmaker = new Matchmaker(new MemoryStateStore());
    matchmakers.push(matchmaker);
    const store = new MemoryAiStore();
    const model = client();
    let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const runtime = new AiPlayers(matchmaker, store, model, 10, vi.fn(), { fetch: fetcher });
    runtimes.push(runtime);
    const starting = runtime.start();
    expect(signal?.aborted).toBe(false);
    await runtime.stop();
    await starting;
    expect(signal?.aborted).toBe(true);
    expect(store.listAgents).not.toHaveBeenCalled();
    expect(model.decide).not.toHaveBeenCalled();
  });
});
