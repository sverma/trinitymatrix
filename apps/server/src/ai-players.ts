import { randomUUID } from "node:crypto";
import { clientMessageSchema, type ClientMessage, type ServerMessage } from "@trinitymatrix/protocol";
import { Matchmaker, type GameplaySocket } from "./matchmaker";
import type { AiIdentity, AiStore } from "./ai-repository";
import type { AiAgentDecision, AiAgentDecisionResult, AiAgentObservation } from "./ai-openrouter";

type GameCommand = Extract<ClientMessage, { type: `game.${string}` }>;
type ModelClient = {
  decide(input: { modelId: string; observation: AiAgentObservation; memory: string }): Promise<AiAgentDecisionResult>;
  cancelAll?(): void;
};
type Agent = {
  identity: AiIdentity; socket: GameplaySocket; timer: NodeJS.Timeout | null; flight: Promise<void> | null;
  history: string[]; gameId: string | null; blockedGameId: string | null; lastRevision: number; failures: number; feedback: string;
};

export function decisionCommand(decision: AiAgentDecision, observation: AiAgentObservation): GameCommand {
  const fields = { commandId: randomUUID(), gameId: observation.state.gameId, expectedRevision: observation.state.revision };
  const type = decision.action;
  const command = type === "draw-stock" || type === "draw-discard"
    ? { type: "game.draw", ...fields, source: type === "draw-stock" ? "stock" : "discard" }
    : type === "discard" ? { type: "game.discard", ...fields, cardId: decision.cardId }
    : type === "declare" ? { type: "game.declare", ...fields, discardCardId: decision.cardId, melds: decision.groups }
    : { type: "game.submit-hand", ...fields, groups: decision.groups };
  return clientMessageSchema.parse(command) as GameCommand;
}

/** Model inference is asynchronous. No game-search engine chooses the agent's moves. */
export class AiPlayers {
  private readonly agents = new Map<string, Agent>();
  private availableModels = new Set<string>();
  private stopped = true;
  private startGeneration = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private catalogController: AbortController | null = null;
  private readonly pending = new Set<Promise<void>>();
  private lastError = new Map<string, number>();

  constructor(
    private readonly matchmaker: Matchmaker,
    private readonly store: AiStore,
    private readonly client: ModelClient | null,
    readonly dailyBudgetUsd: number,
    private readonly report: (code: string, agentId?: string) => void = () => undefined,
    private readonly options: { availableModels?: readonly string[]; actionDelayMs?: number; fetch?: typeof fetch } = {}
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    const generation = ++this.startGeneration;
    this.stopped = false;
    try {
      if (this.client) await this.refreshModels();
      if (this.stopped || generation !== this.startGeneration) return;
      const identities = await this.store.listAgents();
      if (this.stopped || generation !== this.startGeneration) return;
      for (const identity of identities) {
        let agent: Agent;
        const socket: GameplaySocket = {
          readyState: 1,
          send: (raw) => this.onMessage(agent, JSON.parse(raw) as ServerMessage),
          close: () => { socket.readyState = 3; }
        };
        agent = { identity, socket, timer: null, flight: null, history: [], gameId: null, blockedGameId: null, lastRevision: -1, failures: 0, feedback: "" };
        this.agents.set(identity.id, agent);
        this.matchmaker.register({ playerId: identity.id, displayName: identity.displayName, badgeId: "strategist",
          actorKind: "ai", aiModelId: identity.modelId, socket });
      }
      if (this.client && !this.options.availableModels) {
        this.refreshTimer = setInterval(() => { void this.refreshModels().catch(() => this.report("catalog-unavailable")); }, 300_000);
        this.refreshTimer.unref();
      }
    } catch (error) {
      if (generation === this.startGeneration) {
        this.stopped = true;
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        for (const agent of this.agents.values()) {
          if (agent.timer) clearTimeout(agent.timer);
          agent.socket.close();
          // Detach a partially registered worker without dropping its restored game.
          this.matchmaker.disconnect(agent.identity.id, agent.socket);
        }
        this.agents.clear();
      }
      throw error;
    }
  }

  private async refreshModels(): Promise<void> {
    if (this.options.availableModels) { this.availableModels = new Set(this.options.availableModels); return; }
    const controller = new AbortController();
    this.catalogController = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await (this.options.fetch ?? fetch)("https://openrouter.ai/api/v1/models", {
        signal: controller.signal, redirect: "error"
      });
      if (!response.ok) throw new Error("catalog");
      const data = await response.json() as { data?: Array<{ id: string; supported_parameters?: string[]; pricing?: Record<string, string> }> };
      if (this.stopped || this.catalogController !== controller) return;
      this.availableModels = new Set((data.data ?? []).filter((model) => {
        const prompt = Number(model.pricing?.prompt ?? NaN);
        const completion = Number(model.pricing?.completion ?? NaN);
        return model.supported_parameters?.includes("structured_outputs") && Number.isFinite(prompt)
          && Number.isFinite(completion) && prompt <= 0.000001 && completion <= 0.000005
          && Number(model.pricing?.request ?? 0) === 0;
      }).map(({ id }) => id));
    } catch { if (!this.stopped && this.catalogController === controller) { this.availableModels.clear(); this.report("catalog-unavailable"); } }
    finally { clearTimeout(timeout); if (this.catalogController === controller) this.catalogController = null; }
  }

  async roster() {
    const budget = await this.store.budgetAvailable(this.dailyBudgetUsd);
    const identities = await this.store.listAgents();
    return { enabled: !this.stopped && this.client !== null, dailyBudgetUsd: this.dailyBudgetUsd,
      players: identities.map((identity) => {
        const coolingDown = Date.now() - (this.lastError.get(identity.id) ?? 0) < 300_000;
        const reason = !this.client ? "OpenRouter is not configured."
          : this.stopped ? "AI players are restarting."
          : !identity.enabled ? "This AI player is disabled."
          : !budget ? "The shared daily AI budget has been reached."
          : !this.availableModels.has(identity.modelId) || coolingDown ? "This model is currently unavailable."
          : !this.matchmaker.isPlayerAvailable(identity.id) ? "Playing another match." : undefined;
        return { id: identity.id, displayName: identity.displayName, modelId: identity.modelId,
          modelName: identity.modelName, rating: identity.rating, gamesPlayed: identity.gamesPlayed, wins: identity.wins,
          available: !reason, ...(reason ? { reason } : {}) };
      }) };
  }

  async startMatch(humanId: string | null, agentIds: readonly string[]): Promise<string> {
    const total = agentIds.length + (humanId ? 1 : 0);
    if ((total !== 2 && total !== 6) || new Set(agentIds).size !== agentIds.length || agentIds.includes(humanId ?? "")) {
      throw new Error("Choose distinct AI players to fill a two- or six-player table.");
    }
    const roster = await this.roster();
    if (agentIds.some((id) => !roster.players.some((p) => p.id === id && p.available))) {
      throw new Error("A selected AI player is unavailable. Refresh the roster and retry.");
    }
    // This final availability check and the table allocation are synchronous,
    // so simultaneous HTTP requests cannot assign an identity to two games.
    return this.matchmaker.startSelectedMatch([...(humanId ? [humanId] : []), ...agentIds]);
  }

  private onMessage(agent: Agent, message: ServerMessage): void {
    if (message.type === "game.started" || message.type === "game.state") {
      if (agent.gameId !== message.gameId) {
        agent.gameId = message.gameId; agent.blockedGameId = null; agent.history = []; agent.lastRevision = -1; agent.failures = 0; agent.feedback = "";
      }
      if (message.revision !== agent.lastRevision) {
        agent.history.push(JSON.stringify({ revision: message.revision, currentPlayerId: message.currentPlayerId,
          topDiscard: message.topDiscard, players: message.players.map(({ id, cardCount, status }) => ({ id, cardCount, status })) }));
        agent.history = agent.history.slice(-12);
        agent.lastRevision = message.revision;
      }
    }
    if (message.type === "game.started" || message.type === "game.state" || message.type === "game.hand") this.schedule(agent);
  }

  private schedule(agent: Agent): void {
    if (this.stopped || agent.timer || agent.flight) return;
    agent.timer = setTimeout(() => {
      agent.timer = null;
      if (this.stopped) return;
      const gameId = agent.gameId;
      const flight = this.takeTurn(agent).catch(() => {
        this.report("agent-turn-failed", agent.identity.id);
        // Persistence failures must not create a repeated paid-inference loop.
        this.forfeit(agent, gameId);
      });
      agent.flight = flight;
      this.pending.add(flight);
      void flight.finally(() => {
        this.pending.delete(flight); agent.flight = null;
        if (!this.stopped && this.actionable(agent)) this.schedule(agent);
      });
    }, this.options.actionDelayMs ?? 900);
    agent.timer.unref();
  }

  private actionable(agent: Agent): AiAgentObservation | null {
    const view = this.matchmaker.agentView(agent.identity.id);
    if (!view || view.state.phase === "finished" || view.state.gameId === agent.blockedGameId) return null;
    const ownSeat = view.state.players.find(({ id }) => id === agent.identity.id);
    const showdown = view.state.phase === "showdown" && view.state.showdown?.pendingPlayerIds.includes(agent.identity.id);
    if (!showdown && (view.state.phase !== "playing" || ownSeat?.status !== "playing" || view.state.currentPlayerId !== agent.identity.id)) return null;
    return { ...view, state: { ...view.state, players: view.state.players.map((player, index) => ({
      ...player, displayName: player.actorKind === "ai" ? player.displayName : `Human seat ${index + 1}`
    })) }, publicHistory: [...agent.history, ...(agent.feedback ? [agent.feedback] : [])] };
  }

  private forfeit(agent: Agent, gameId = agent.gameId): void {
    if (this.stopped || !gameId) return;
    const view = this.matchmaker.agentView(agent.identity.id);
    if (!view || view.state.gameId !== gameId) return;
    // A missing showdown submission is completed by the authoritative deadline.
    // Block this game now so the scheduler cannot bill another request meanwhile.
    agent.blockedGameId = gameId;
    if (view.state.phase === "playing") {
      try {
        this.matchmaker.executeAgentCommand(agent.identity.id, {
          type: "game.drop", commandId: randomUUID(), gameId: view.state.gameId, expectedRevision: view.state.revision
        });
      } catch { this.report("agent-forfeit-failed", agent.identity.id); }
    }
    // Existing showdown deadlines handle a missing final-layout submission.
  }

  private async takeTurn(agent: Agent): Promise<void> {
    const observation = this.actionable(agent);
    if (!observation) return;
    const identity = (await this.store.listAgents()).find(({ id }) => id === agent.identity.id);
    if (this.stopped) return;
    if (!this.client || !identity?.enabled || !this.availableModels.has(identity.modelId)) { this.forfeit(agent, observation.state.gameId); return; }
    if (!this.isCurrent(observation)) return;
    const requestId = await this.store.reserveRequest(identity.id, identity.modelId, this.dailyBudgetUsd);
    if (this.stopped) return;
    if (!requestId) { this.forfeit(agent, observation.state.gameId); return; }
    if (!this.isCurrent(observation)) {
      await this.store.finishRequest(requestId, 0, false);
      return;
    }
    let result: AiAgentDecisionResult;
    try {
      result = await this.client.decide({ modelId: identity.modelId, observation, memory: identity.memory });
    } catch {
      // A shutdown leaves its already-durable reservation intact at unknown cost.
      // Avoid starting a new database operation after cancellation/teardown.
      if (this.stopped) return;
      await this.store.finishRequest(requestId, null, false);
      this.lastError.set(identity.id, Date.now());
      this.report("model-unavailable", identity.id);
      this.forfeit(agent, observation.state.gameId);
      return;
    }
    if (this.stopped) return;
    await this.store.finishRequest(requestId, result.usage.costUsd, true);
    if (this.stopped) return;
    if (!this.isCurrent(observation)) return;
    if (result.modelId !== identity.modelId) {
      this.lastError.set(identity.id, Date.now());
      this.report("model-mismatch", identity.id);
      this.forfeit(agent, observation.state.gameId);
      return;
    }
    let command: GameCommand;
    try { command = decisionCommand(result.decision, observation); }
    catch { agent.failures += 1; agent.feedback = "Your last response was not a valid game command. Follow the required action shape.";
      if (agent.failures >= 2) this.forfeit(agent, observation.state.gameId); return; }
    const applied = this.matchmaker.executeAgentCommand(identity.id, command);
    if (applied?.accepted) {
      agent.failures = 0; agent.feedback = "";
      await this.store.saveMemory(identity.id, result.decision.memory);
    } else {
      agent.failures += 1;
      agent.feedback = applied && !applied.accepted ? `The server rejected your action: ${applied.message}` : "The game has ended.";
      if (agent.failures >= 2) this.forfeit(agent, observation.state.gameId);
    }
  }

  private isCurrent(observation: AiAgentObservation): boolean {
    const current = this.matchmaker.agentView(observation.playerId);
    return current?.state.gameId === observation.state.gameId && current.state.revision === observation.state.revision;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.startGeneration += 1;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.catalogController?.abort();
    this.catalogController = null;
    for (const agent of this.agents.values()) if (agent.timer) { clearTimeout(agent.timer); agent.timer = null; }
    this.client?.cancelAll?.();
    await Promise.allSettled([...this.pending]);
  }
}
