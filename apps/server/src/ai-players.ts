import { randomUUID } from "node:crypto";
import { clientMessageSchema, type ClientMessage, type ServerMessage } from "@trinitymatrix/protocol";
import { validateDeclaration } from "@trinitymatrix/game-domain";
import { Matchmaker, type GameplaySocket, type AiForfeitNotice } from "./matchmaker";
import type { AiIdentity, AiStore, AiRequestCompletion } from "./ai-repository";
import { AI_MAX_DECISION_TIME_MS, OpenRouterAgentError, type AiAgentDecision, type AiAgentDecisionResult, type AiAgentObservation } from "./ai-openrouter";
import { AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_GAME_PROTOCOL_VERSION, AI_GAME_PROTOCOL_REVISION_HASH,
  AI_GAME_RULES_REVISION, AI_LEGACY_V1_PROTOCOL_VERSION, type AiGameRulesFacts } from "./ai-game-protocol";
import { AiRuleToolService } from "./ai-rule-tool-service";
import { AI_RULES_TOOL_VERSION, unavailableAiRules, type AiRulesInput } from "./ai-rule-tools";

type GameCommand = Extract<ClientMessage, { type: `game.${string}` }>;
type ModelClient = {
  decide(input: { modelId: string; observation: AiAgentObservation; memory: string; timeoutMs?: number;
    protocolId?: string; rulesFacts?: AiGameRulesFacts }): Promise<AiAgentDecisionResult>;
  cancelAll?(): void;
};
type RulesTool = { compute(input: AiRulesInput, timeoutMs?: number, signal?: AbortSignal): Promise<AiGameRulesFacts>; stop?(): Promise<void> };
type Agent = {
  identity: AiIdentity; socket: GameplaySocket; timer: NodeJS.Timeout | null; flight: Promise<void> | null;
  history: string[]; gameId: string | null; blockedGameId: string | null; lastRevision: number; failures: number; feedback: string;
  failureRevision: number; pausedRevision: number; failedTurnDeadline: number; failedTurns: number;
};

export type AiOperationContext = {
  gameId: string; modelId: string; revision: number; phase: string; handCount: number;
  attempt?: number; requestId?: string; errorCode?: string; httpStatus?: number; finishReason?: string;
  elapsedMs?: number; remainingMs?: number; costUsd?: number | null;
  protocolId?: string; toolsVersion?: string; declarationAvailable?: boolean | null;
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
  private rulesTool: RulesTool | null = null;

  constructor(
    private readonly matchmaker: Matchmaker,
    private readonly store: AiStore,
    private readonly client: ModelClient | null,
    readonly dailyBudgetUsd: number,
    private readonly report: (code: string, agentId?: string, context?: AiOperationContext) => void = () => undefined,
    private readonly options: { availableModels?: readonly string[]; actionDelayMs?: number; fetch?: typeof fetch; rulesTool?: RulesTool } = {}
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
        agent = { identity, socket, timer: null, flight: null, history: [], gameId: null, blockedGameId: null, lastRevision: -1, failures: 0, feedback: "",
          failureRevision: -1, pausedRevision: -1, failedTurnDeadline: 0, failedTurns: 0 };
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
    } catch { if (!this.stopped && this.catalogController === controller) this.report("catalog-unavailable"); }
    finally { clearTimeout(timeout); if (this.catalogController === controller) this.catalogController = null; }
  }

  async roster() {
    const budget = await this.store.budgetAvailable(this.dailyBudgetUsd);
    const identities = await this.store.listAgents();
    return { enabled: !this.stopped && this.client !== null, dailyBudgetUsd: this.dailyBudgetUsd,
      players: identities.filter((identity) => identity.selectable !== false).map((identity) => {
        const coolingDown = Date.now() - (this.lastError.get(identity.id) ?? 0) < 300_000;
        const reason = !this.client ? "OpenRouter is not configured."
          : this.stopped ? "AI players are restarting."
          : !identity.enabled ? "This AI player is disabled."
          : !budget ? "The shared daily AI budget has been reached."
          : !this.availableModels.has(identity.modelId) || coolingDown ? "This model is currently unavailable."
          : !this.matchmaker.isPlayerAvailable(identity.id) ? "Playing another match." : undefined;
        return { id: identity.id, displayName: identity.displayName, modelId: identity.modelId,
          modelName: identity.modelName, rating: identity.rating, gamesPlayed: identity.gamesPlayed, wins: identity.wins,
          protocolId: identity.protocolId ?? identity.identityVersion ?? AI_LEGACY_V1_PROTOCOL_VERSION,
          ...(identity.protocolId === AI_GAME_PROTOCOL_IDENTITY_VERSION ? {
            protocolVersion: AI_GAME_PROTOCOL_VERSION, rulesRevision: AI_GAME_RULES_REVISION, protocolHash: AI_GAME_PROTOCOL_REVISION_HASH
          } : {}), available: !reason, ...(reason ? { reason } : {}) };
      }) };
  }

  async startMatch(humanId: string | null, agentIds: readonly string[], options: { broadcast?: boolean } = {}): Promise<string> {
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
    const participants = [...(humanId ? [humanId] : []), ...agentIds];
    return options.broadcast ? this.matchmaker.startSelectedMatch(participants, { broadcast: true })
      : this.matchmaker.startSelectedMatch(participants);
  }

  private onMessage(agent: Agent, message: ServerMessage): void {
    if (message.type === "game.started" || message.type === "game.state") {
      if (agent.gameId !== message.gameId) {
        agent.gameId = message.gameId; agent.blockedGameId = null; agent.history = []; agent.lastRevision = -1; agent.failures = 0; agent.feedback = "";
        agent.failureRevision = -1; agent.pausedRevision = -1; agent.failedTurnDeadline = 0; agent.failedTurns = 0;
      }
      if (message.revision !== agent.lastRevision) {
        agent.history.push(JSON.stringify({ revision: message.revision, currentPlayerId: message.currentPlayerId,
          topDiscard: message.topDiscard, players: message.players.map(({ id, cardCount, status }) => ({ id, cardCount, status })) }));
        agent.history = agent.history.slice(-6);
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
        this.forfeit(agent, gameId, { code: "AI_UNAVAILABLE", message: "The AI could not continue because its game service became unavailable." });
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
    if (!view || view.state.phase === "finished" || view.state.gameId === agent.blockedGameId || view.state.revision === agent.pausedRevision) return null;
    const ownSeat = view.state.players.find(({ id }) => id === agent.identity.id);
    const showdown = view.state.phase === "showdown" && view.state.showdown?.pendingPlayerIds.includes(agent.identity.id);
    if (!showdown && (view.state.phase !== "playing" || ownSeat?.status !== "playing" || view.state.currentPlayerId !== agent.identity.id)) return null;
    return { ...view, state: { ...view.state, players: view.state.players.map((player, index) => ({
      ...player, displayName: player.actorKind === "ai" ? player.displayName : `Human seat ${index + 1}`
    })) }, publicHistory: [...agent.history, ...(agent.feedback ? [agent.feedback] : [])] };
  }

  private forfeit(agent: Agent, gameId = agent.gameId, notice: AiForfeitNotice = {
    code: "AI_UNAVAILABLE", message: "The AI could not continue because its selected model is unavailable."
  }): void {
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
        }, notice);
      } catch { this.report("agent-forfeit-failed", agent.identity.id); }
    }
    // Existing showdown deadlines handle a missing final-layout submission.
  }

  private remainingTime(observation: AiAgentObservation): number {
    const deadline = observation.state.phase === "showdown" ? observation.state.showdown?.endsAt : observation.state.turnEndsAt;
    return Math.max(0, (deadline ?? 0) - Date.now() - 1_000);
  }

  private recover(agent: Agent, observation: AiAgentObservation, errorCode: string, feedback: string): void {
    if (this.stopped || !this.isCurrent(observation)) return;
    if (agent.failureRevision !== observation.state.revision) { agent.failureRevision = observation.state.revision; agent.failures = 0; }
    agent.failures += 1;
    agent.feedback = `${feedback} Current hand has ${observation.hand.length} cards. Follow the action and card IDs in the response schema.`;
    if (agent.failures < 2 && this.remainingTime(observation) > 1_000) return;
    agent.pausedRevision = observation.state.revision;
    if (observation.state.phase === "showdown") { agent.blockedGameId = observation.state.gameId; return; }
    // Treat an inference miss like a human turn timeout. It must not be an
    // immediate surrender or a secret replacement strategy.
    if (agent.failedTurnDeadline !== observation.state.turnEndsAt) {
      agent.failedTurnDeadline = observation.state.turnEndsAt;
      agent.failedTurns += 1;
    }
    this.report("ai-turn-paused", agent.identity.id, { gameId: observation.state.gameId, modelId: agent.identity.modelId,
      revision: observation.state.revision, phase: observation.state.phase, handCount: observation.hand.length,
      attempt: agent.failures, errorCode, remainingMs: this.remainingTime(observation) });
    if (agent.failedTurns >= 3) {
      this.lastError.set(agent.identity.id, Date.now());
      this.forfeit(agent, observation.state.gameId, {
        code: ["server-rejected", "invalid-command", "missed-declaration", "invalid-declaration"].includes(errorCode) ? "AI_INVALID_ACTION" : "AI_UNAVAILABLE",
        message: "The AI could not complete three consecutive turns after retrying its selected model."
      });
    }
  }

  private async takeTurn(agent: Agent): Promise<void> {
    const observation = this.actionable(agent);
    if (!observation) return;
    const identity = (await this.store.listAgents()).find(({ id }) => id === agent.identity.id);
    if (this.stopped) return;
    if (!this.client || !identity?.enabled) { this.forfeit(agent, observation.state.gameId); return; }
    if (!this.isCurrent(observation)) return;
    if (this.remainingTime(observation) <= 1_000) { this.recover(agent, observation, "turn-deadline", "The turn deadline is too close for another model request."); return; }
    const protocolId = identity.protocolId ?? identity.identityVersion ?? AI_LEGACY_V1_PROTOCOL_VERSION;
    const versioned = identity.protocolId !== undefined || identity.identityVersion !== undefined;
    const v2 = protocolId === AI_GAME_PROTOCOL_IDENTITY_VERSION;
    if (!v2 && protocolId !== AI_LEGACY_V1_PROTOCOL_VERSION) {
      this.report("unknown-protocol", identity.id);
      this.forfeit(agent, observation.state.gameId); return;
    }
    let rulesFacts: AiGameRulesFacts | undefined;
    if (v2 && observation.state.phase === "playing") {
      this.rulesTool ??= this.options.rulesTool ?? new AiRuleToolService();
      try {
        rulesFacts = await this.rulesTool.compute({ hand: observation.hand, wildRank: observation.state.wildRank,
          visibleDiscard: observation.state.topDiscard }, Math.min(1_000, this.remainingTime(observation) - 1_000));
      } catch { rulesFacts = unavailableAiRules("tool-error"); }
      if (this.stopped || !this.isCurrent(observation)) return;
      if (this.remainingTime(observation) <= 1_000) {
        this.recover(agent, observation, "turn-deadline", "The turn deadline is too close for another model request."); return;
      }
    }
    const declarationAvailable = observation.hand.length === 14 && rulesFacts?.status === "complete"
      ? rulesFacts.immediateDeclaration !== null : null;
    const serverRevision = process.env.APP_REVISION;
    const context = { protocolId, matchId: observation.state.gameId, gameRevision: observation.state.revision,
      ...(v2 ? { toolsVersion: AI_RULES_TOOL_VERSION, declarationAvailable } : {}),
      ...(serverRevision && serverRevision.length <= 100 ? { serverRevision } : {}) };
    const requestId = versioned ? await this.store.reserveRequest(identity.id, identity.modelId, this.dailyBudgetUsd, context)
      : await this.store.reserveRequest(identity.id, identity.modelId, this.dailyBudgetUsd);
    if (this.stopped) return;
    if (!requestId) { this.forfeit(agent, observation.state.gameId, {
      code: "AI_BUDGET_EXHAUSTED", message: "The AI stopped because the shared daily inference budget was reached."
    }); return; }
    const finish = (cost: number | null, success: boolean, audit: AiRequestCompletion) => versioned
      ? this.store.finishRequest(requestId, cost, success, audit) : this.store.finishRequest(requestId, cost, success);
    const outcome = async (audit: AiRequestCompletion) => {
      if (versioned) await this.store.recordRequestOutcome?.(requestId, audit);
    };
    if (!this.isCurrent(observation)) {
      await finish(0, false, { outcome: "stale" });
      return;
    }
    const timeoutMs = Math.min(AI_MAX_DECISION_TIME_MS, this.remainingTime(observation));
    if (timeoutMs <= 1_000) {
      await finish(0, false, { outcome: "cancelled" });
      this.recover(agent, observation, "turn-deadline", "The turn deadline is too close for another model request.");
      return;
    }
    let result: AiAgentDecisionResult;
    const started = Date.now();
    try {
      result = await this.client.decide({ modelId: identity.modelId, observation, memory: identity.memory, timeoutMs,
        protocolId, ...(rulesFacts ? { rulesFacts } : {}) });
    } catch (error) {
      // A shutdown leaves its already-durable reservation intact at unknown cost.
      // Avoid starting a new database operation after cancellation/teardown.
      if (this.stopped) return;
      const known = error instanceof OpenRouterAgentError ? error : null;
      const errorCode = known?.code ?? "provider-unavailable";
      const costUsd = known?.metadata.usage?.costUsd ?? (["configuration", "invalid-rules-facts"].includes(errorCode) ? 0 : null);
      await finish(costUsd, false, { ...(known?.metadata.action ? { action: known.metadata.action } : {}),
        outcome: ["missed-declaration", "invalid-declaration", "invalid-rules-facts"].includes(errorCode) ? "policy-rejected" : "provider-failed" });
      this.report("model-request-failed", identity.id, {
        gameId: observation.state.gameId, modelId: identity.modelId, revision: observation.state.revision,
        phase: observation.state.phase, handCount: observation.hand.length, requestId,
        attempt: (agent.failureRevision === observation.state.revision ? agent.failures : 0) + 1,
        errorCode, elapsedMs: Date.now() - started, remainingMs: this.remainingTime(observation), costUsd,
        protocolId, ...(v2 ? { toolsVersion: AI_RULES_TOOL_VERSION, declarationAvailable } : {}),
        ...(known?.metadata.status === undefined ? {} : { httpStatus: known.metadata.status }),
        ...(known?.metadata.finishReason === undefined ? {} : { finishReason: known.metadata.finishReason })
      });
      const permanentAccessFailure = errorCode === "http-error" && [401, 402, 403].includes(known?.metadata.status ?? 0);
      if (errorCode === "model-mismatch" || errorCode === "configuration" || permanentAccessFailure) {
        this.lastError.set(identity.id, Date.now());
        this.forfeit(agent, observation.state.gameId, { code: "AI_UNAVAILABLE",
          message: permanentAccessFailure ? "The AI could not continue because its model provider denied access." : "The AI could not continue with its configured model." });
      } else this.recover(agent, observation, errorCode, `The previous model response failed: ${errorCode}. Please return a complete valid decision.`);
      return;
    }
    if (this.stopped) return;
    await finish(result.usage.costUsd, true, { action: result.decision.action });
    if (this.stopped) return;
    if (!this.isCurrent(observation)) { await outcome({ outcome: "stale" }); return; }
    if (result.modelId !== identity.modelId) {
      this.lastError.set(identity.id, Date.now());
      this.report("model-mismatch", identity.id);
      await outcome({ outcome: "provider-failed" });
      this.forfeit(agent, observation.state.gameId);
      return;
    }
    // Recheck locally as well as in the provider adapter. Only the model's own
    // validated command is ever executed; a tool plan cannot play a move.
    const missedWin = v2 && rulesFacts?.status === "complete" && rulesFacts.immediateDeclaration !== null
      && result.decision.action !== "declare";
    const illegalDeclaration = v2 && result.decision.action === "declare"
      && !validateDeclaration(observation.hand, result.decision.cardId ?? "", result.decision.groups, observation.state.wildRank).valid;
    if (missedWin || illegalDeclaration) {
      const code = missedWin ? "missed-declaration" : "invalid-declaration";
      await outcome({ outcome: "policy-rejected" });
      this.report("model-action-rejected", identity.id, { gameId: observation.state.gameId, modelId: identity.modelId,
        revision: observation.state.revision, phase: observation.state.phase, handCount: observation.hand.length,
        requestId, errorCode: code, protocolId, toolsVersion: AI_RULES_TOOL_VERSION, declarationAvailable });
      this.recover(agent, observation, code, missedWin
        ? "A legal declaration is available. Return declare now with a valid final discard and all thirteen remaining cards grouped."
        : "Your declaration was invalid. Check the rules facts and return a legal decision.");
      return;
    }
    let command: GameCommand;
    try { command = decisionCommand(result.decision, observation); }
    catch {
      await outcome({ outcome: "policy-rejected" });
      this.report("model-action-rejected", identity.id, { gameId: observation.state.gameId, modelId: identity.modelId,
        revision: observation.state.revision, phase: observation.state.phase, handCount: observation.hand.length,
        requestId, errorCode: "invalid-command", attempt: (agent.failureRevision === observation.state.revision ? agent.failures : 0) + 1 });
      this.recover(agent, observation, "invalid-command", "Your last response was not a valid game command."); return;
    }
    const applied = this.matchmaker.executeAgentCommand(identity.id, command);
    if (applied?.accepted) {
      await outcome({ outcome: "accepted" });
      agent.failures = 0; agent.feedback = "";
      agent.failureRevision = -1;
      if (command.type === "game.discard" || (command.type === "game.declare" && !applied.dropped)) {
        agent.failedTurns = 0; agent.failedTurnDeadline = 0;
      }
      await this.store.saveMemory(identity.id, result.decision.memory);
    } else {
      await outcome({ outcome: "server-rejected" });
      this.report("model-action-rejected", identity.id, { gameId: observation.state.gameId, modelId: identity.modelId,
        revision: observation.state.revision, phase: observation.state.phase, handCount: observation.hand.length,
        requestId, errorCode: applied && !applied.accepted ? applied.code : "game-ended",
        attempt: (agent.failureRevision === observation.state.revision ? agent.failures : 0) + 1 });
      this.recover(agent, observation, "server-rejected", applied && !applied.accepted
        ? `The server rejected your action: ${applied.message}` : "The game has ended.");
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
    const rulesTool = this.rulesTool; this.rulesTool = null;
    await rulesTool?.stop?.();
    await Promise.allSettled([...this.pending]);
  }
}
