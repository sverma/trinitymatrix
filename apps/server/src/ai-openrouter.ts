import { z } from "zod";
import { validateDeclaration, validateMeld } from "@trinitymatrix/game-domain";
import {
  AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_GAME_PROTOCOL_REVISION_HASH, AI_GAME_PROTOCOL_VERSION,
  AI_GAME_RULES_REVISION, AI_GAME_RULES_TOOL_VERSION, AI_LEGACY_V1_PROTOCOL_VERSION,
  AI_LEGACY_V1_SYSTEM_PROMPT, buildSystemPrompt, type AiGameRulesFacts
} from "./ai-game-protocol";
import {
  cardSchema,
  gamePublicStateSchema,
  publicPlayerSchema,
  tossResultSchema,
  type Card,
  type GamePublicState
} from "@trinitymatrix/protocol";

/** Reserve this before dispatch, retaining the reservation if billing is unknown. */
export const AI_REQUEST_RESERVATION_USD = 0.05;
export const AI_MAX_REQUEST_BYTES = 24_000;
export const AI_MAX_RESPONSE_BYTES = 64_000;
export const AI_MAX_OUTPUT_TOKENS = 1_600;
export const AI_MAX_DECISION_TIME_MS = 20_000;

const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const strictCard = cardSchema.strict();
const observationSchema = z.object({
  playerId: z.string().uuid(),
  state: gamePublicStateSchema.extend({
    players: z.array(publicPlayerSchema.strict()),
    topDiscard: strictCard.nullable(),
    toss: tossResultSchema.extend({
      cards: z.array(z.object({ playerId: z.string(), card: strictCard }).strict())
    }).nullable()
  }).strict(),
  hand: z.array(strictCard).min(1).max(14),
  publicHistory: z.array(z.string().max(1_000)).max(40).optional()
}).strict();

const actionSchema = z.enum(["draw-stock", "draw-discard", "discard", "declare", "submit-hand"]);
const cardIdSchema = z.string().min(1).max(128);
const decisionSchema = z.object({
  action: actionSchema,
  cardId: cardIdSchema.nullable(),
  groups: z.array(z.array(cardIdSchema).min(1).max(14)).max(14),
  memory: z.string().max(4_000)
}).strict();

const planSchema = z.object({
  cardId: cardIdSchema,
  groups: z.array(z.array(cardIdSchema).min(3).max(13)).min(1).max(4),
  score: z.number().int().nonnegative().max(108)
}).strict();
const rulesFactsSchema = z.object({
  rulesRevision: z.literal(AI_GAME_RULES_REVISION),
  toolVersion: z.literal(AI_GAME_RULES_TOOL_VERSION),
  status: z.enum(["complete", "unavailable"]),
  reason: z.enum(["time-budget", "tool-error"]).optional(),
  immediateDeclaration: planSchema.nullable(),
  readyHand: planSchema.omit({ cardId: true }).nullable(),
  afterDiscardDraw: planSchema.nullable().optional()
}).strict();

export type AiAgentDecision = z.infer<typeof decisionSchema>;
export type AiAgentObservation = {
  playerId: string;
  state: GamePublicState;
  hand: Card[];
  publicHistory?: string[] | undefined;
};
export type AiAgentDecisionResult = {
  decision: AiAgentDecision;
  modelId: string;
  usage: AiAgentUsage;
};
export type AiAgentUsage = {
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
};
export type OpenRouterAgentErrorMetadata = {
  status?: number;
  finishReason?: string;
  usage?: AiAgentUsage;
  action?: AiAgentDecision["action"];
};

export type OpenRouterAgentErrorCode =
  | "configuration"
  | "invalid-observation"
  | "invalid-rules-facts"
  | "request-too-large"
  | "cancelled"
  | "timeout"
  | "provider-unavailable"
  | "response-too-large"
  | "invalid-response"
  | "truncated-response"
  | "refused-response"
  | "invalid-json"
  | "invalid-decision"
  | "invalid-card-reference"
  | "missed-declaration"
  | "invalid-declaration"
  | "http-error"
  | "model-mismatch";

/** Intentionally excludes provider bodies, prompts, credentials and raw causes. */
export class OpenRouterAgentError extends Error {
  constructor(readonly code: OpenRouterAgentErrorCode, readonly metadata: OpenRouterAgentErrorMetadata = {}) {
    super(`AI decision unavailable (${code}).`);
    this.name = "OpenRouterAgentError";
  }
}

const systemPrompt = AI_LEGACY_V1_SYSTEM_PROMPT;

function allowedActions(observation: AiAgentObservation): AiAgentDecision["action"][] {
  if (observation.state.phase === "showdown") {
    return observation.state.showdown?.pendingPlayerIds.includes(observation.playerId) ? ["submit-hand"] : [];
  }
  if (observation.state.phase !== "playing" || observation.state.currentPlayerId !== observation.playerId
    || observation.state.players.find(({ id }) => id === observation.playerId)?.status !== "playing") return [];
  if (observation.hand.length === 13) return observation.state.topDiscard ? ["draw-stock", "draw-discard"] : ["draw-stock"];
  return observation.hand.length === 14 ? ["discard", "declare"] : [];
}

function decisionJsonSchema(observation: AiAgentObservation, modelId: string, mustDeclare: boolean) {
  const actions = mustDeclare ? ["declare"] : allowedActions(observation);
  const cardRequired = actions.includes("discard") || actions.includes("declare");
  const cardIds = observation.hand.map(({ id }) => id);
  // This Gemini endpoint rejects otherwise valid minItems/maxItems constraints.
  // Retain all array bounds in local validation and exact action/card enums here.
  const portableArrays = modelId === "google/gemini-3.8-flash";
  return {
    type: "object",
    properties: {
      action: { type: "string", enum: actions },
      cardId: cardRequired
        ? { type: "string", enum: cardIds, description: "Choose the exact owned card ID to discard." }
        // Nullable strings are portable through Gemini's JSON-schema mapping;
        // the local validator still requires an actual null in these stages.
        : { type: ["string", "null"], description: "Return null. No card is discarded by this action." },
      groups: { type: "array", ...(!portableArrays ? { maxItems: 14, ...(mustDeclare ? { minItems: 1 } : {}) } : {}), items: {
        type: "array", ...(!portableArrays ? { minItems: cardRequired ? 3 : 1, maxItems: 14 } : {}),
        items: { type: "string", enum: cardIds } } },
      memory: { type: "string", description: "Concise persistent factual memory or strategy summary: one short sentence, at most 512 characters." }
    },
    required: ["action", "cardId", "groups", "memory"],
    additionalProperties: false
  };
}

function validatedRulesFacts(value: AiGameRulesFacts | undefined, observation: AiAgentObservation): AiGameRulesFacts {
  if (value === undefined) return {
    rulesRevision: AI_GAME_RULES_REVISION, toolVersion: AI_GAME_RULES_TOOL_VERSION,
    status: "unavailable", reason: "tool-error", immediateDeclaration: null, readyHand: null
  };
  const parsed = rulesFactsSchema.safeParse(value);
  if (!parsed.success) throw new OpenRouterAgentError("invalid-rules-facts");
  const facts: AiGameRulesFacts = {
    rulesRevision: parsed.data.rulesRevision, toolVersion: parsed.data.toolVersion, status: parsed.data.status,
    immediateDeclaration: parsed.data.immediateDeclaration, readyHand: parsed.data.readyHand,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    ...(parsed.data.afterDiscardDraw !== undefined ? { afterDiscardDraw: parsed.data.afterDiscardDraw } : {})
  };
  if (facts.status === "unavailable") {
    if (facts.immediateDeclaration || facts.readyHand || facts.afterDiscardDraw) throw new OpenRouterAgentError("invalid-rules-facts");
    return facts;
  }
  if (facts.reason) throw new OpenRouterAgentError("invalid-rules-facts");
  const validPlan = (cards: readonly Card[], plan: NonNullable<AiGameRulesFacts["immediateDeclaration"]>) => {
    const result = validateDeclaration(cards, plan.cardId, plan.groups, observation.state.wildRank);
    return result.valid && result.score === plan.score;
  };
  if (facts.immediateDeclaration && (observation.hand.length !== 14 || observation.state.phase !== "playing"
    || !validPlan(observation.hand, facts.immediateDeclaration))) throw new OpenRouterAgentError("invalid-rules-facts");
  if (facts.readyHand) {
    const ids = facts.readyHand.groups.flat();
    const owned = new Set(observation.hand.map(({ id }) => id));
    const melds = facts.readyHand.groups.map((group) => validateMeld(group.map((id) => observation.hand.find((card) => card.id === id)).filter((card): card is Card => !!card), observation.state.wildRank));
    if (observation.hand.length !== 13 || ids.length !== 13 || new Set(ids).size !== 13 || ids.some((id) => !owned.has(id))
      || melds.some((meld) => !meld.valid) || !melds.some((meld) => meld.validTotals.includes(21))
      || melds.reduce((total, meld) => total + (meld.total ?? 0), 0) !== facts.readyHand.score) throw new OpenRouterAgentError("invalid-rules-facts");
  }
  if (facts.afterDiscardDraw !== undefined && (observation.hand.length !== 13 || !observation.state.topDiscard)) throw new OpenRouterAgentError("invalid-rules-facts");
  if (facts.afterDiscardDraw) {
    const top = observation.state.topDiscard;
    if (observation.hand.length !== 13 || !top || observation.hand.some(({ id }) => id === top.id)
      || !validPlan([...observation.hand, top], facts.afterDiscardDraw)) throw new OpenRouterAgentError("invalid-rules-facts");
  }
  return facts;
}

/** Keep reasoning inside the shared output/turn budget without changing models. */
function modelReasoningOptions(modelId: string) {
  if (["openai/gpt-6.1-terra", "openai/gpt-5.4-mini", "nvidia/nemotron-3-ultra-550b-a55b",
    "xiaomi/mimo-v2.6-flash", "z-ai/glm-5"].includes(modelId)) return { enabled: false, exclude: true };
  if (modelId === "openai/gpt-6-luna" || modelId === "deepseek/deepseek-v4.1-flash") return { enabled: false, exclude: true };
  if (modelId === "anthropic/claude-haiku-5.5" || modelId === "deepseek/deepseek-v3.2") return { enabled: false, exclude: true };
  if (modelId === "google/gemini-3.8-flash") return { effort: "low", exclude: true };
  if (modelId === "deepseek/deepseek-v4.1-flash-1017") return { effort: "low", exclude: true };
  if (modelId === "mistralai/mistral-large-4-0") return { enabled: false, exclude: true };
  if (modelId === "qwen/qwen3.8-flash") return { max_tokens: 256, exclude: true };
  return undefined;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenCount(value: unknown): number | null {
  const parsed = nonnegativeNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

async function boundedBody(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > AI_MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new OpenRouterAgentError("response-too-large");
  }
  if (!response.body) throw new OpenRouterAgentError("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AI_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OpenRouterAgentError("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function validateOwnedCards(decision: AiAgentDecision, observation: AiAgentObservation, metadata: OpenRouterAgentErrorMetadata): AiAgentDecision {
  const hand = new Set(observation.hand.map(({ id }) => id));
  const grouped = decision.groups.flat();
  if (new Set(grouped).size !== grouped.length || grouped.some((id) => !hand.has(id))
    || (decision.cardId !== null && !hand.has(decision.cardId))) {
    throw new OpenRouterAgentError("invalid-card-reference", metadata);
  }
  if (!allowedActions(observation).includes(decision.action)) throw new OpenRouterAgentError("invalid-decision", metadata);
  if (decision.action === "draw-stock" || decision.action === "draw-discard") {
    if (decision.cardId !== null) throw new OpenRouterAgentError("invalid-decision", metadata);
  } else if (decision.action === "discard") {
    if (decision.cardId === null) throw new OpenRouterAgentError("invalid-decision", metadata);
  } else if (decision.action === "declare") {
    if (decision.cardId === null || decision.groups.length === 0 || grouped.includes(decision.cardId)) {
      throw new OpenRouterAgentError("invalid-decision", metadata);
    }
    // Meld correctness deliberately belongs to the authoritative game validator.
    // An invalid model-chosen declaration has the same outcome as a human one.
  } else if (decision.cardId !== null || grouped.length !== observation.hand.length) {
    throw new OpenRouterAgentError("invalid-decision", metadata);
  }
  // Layouts accompanying an ordinary draw/discard have no effect on the move.
  // Normalize that harmless extra output without changing the model's card choice.
  return decision.action === "declare" || decision.action === "submit-hand" ? decision : { ...decision, groups: [] };
}

function responseUsage(value: unknown): AiAgentUsage | undefined {
  if (!value || typeof value !== "object" || !("usage" in value)) return undefined;
  const usage = value.usage;
  if (!usage || typeof usage !== "object") return undefined;
  return {
    costUsd: nonnegativeNumber("cost" in usage ? usage.cost : undefined),
    promptTokens: tokenCount("prompt_tokens" in usage ? usage.prompt_tokens : undefined),
    completionTokens: tokenCount("completion_tokens" in usage ? usage.completion_tokens : undefined)
  };
}

function safeFinishReason(value: string | null): string {
  return value && ["stop", "length", "content_filter", "tool_calls", "function_call", "error"].includes(value) ? value : "unknown";
}

export class OpenRouterAgentClient {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly active = new Map<AbortController, (error: Error) => void>();

  constructor(options: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey || /\s/.test(options.apiKey) || options.apiKey.length > 1_024
      || (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > AI_MAX_DECISION_TIME_MS))) {
      throw new OpenRouterAgentError("configuration");
    }
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? AI_MAX_DECISION_TIME_MS;
  }

  async decide(input: {
    modelId: string; observation: AiAgentObservation; memory: string; timeoutMs?: number;
    protocolId?: string | undefined; rulesFacts?: AiGameRulesFacts | undefined
  }): Promise<AiAgentDecisionResult> {
    const protocolId = input.protocolId ?? AI_GAME_PROTOCOL_IDENTITY_VERSION;
    if (protocolId !== AI_GAME_PROTOCOL_IDENTITY_VERSION && protocolId !== AI_LEGACY_V1_PROTOCOL_VERSION) throw new OpenRouterAgentError("configuration");
    const v2 = protocolId === AI_GAME_PROTOCOL_IDENTITY_VERSION;
    if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > AI_MAX_DECISION_TIME_MS)) {
      throw new OpenRouterAgentError("configuration");
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/.test(input.modelId)
      || input.modelId.startsWith("openrouter/") || input.modelId.endsWith(":nitro") || input.modelId.endsWith(":floor")) {
      throw new OpenRouterAgentError("configuration");
    }
    const parsed = observationSchema.safeParse(input.observation);
    if (!parsed.success || typeof input.memory !== "string" || input.memory.length > 4_000
      || new Set(parsed.data.hand.map(({ id }) => id)).size !== parsed.data.hand.length
      || !parsed.data.state.players.some(({ id }) => id === parsed.data.playerId)) {
      throw new OpenRouterAgentError("invalid-observation");
    }
    const observation = parsed.data;
    if (allowedActions(observation).length === 0) throw new OpenRouterAgentError("invalid-observation");
    const rulesFacts = v2 ? validatedRulesFacts(input.rulesFacts, observation) : undefined;
    const mustDeclare = rulesFacts?.status === "complete" && !!rulesFacts.immediateDeclaration;
    const timeoutMs = Math.min(input.timeoutMs ?? this.timeoutMs, this.timeoutMs);
    const reasoning = modelReasoningOptions(input.modelId);
    const body = JSON.stringify({
      model: input.modelId,
      messages: [
        { role: "system", content: v2 ? buildSystemPrompt() : systemPrompt },
        { role: "user", content: JSON.stringify(v2 ? {
          protocol: { id: protocolId, version: AI_GAME_PROTOCOL_VERSION, rulesRevision: AI_GAME_RULES_REVISION, policyHash: AI_GAME_PROTOCOL_REVISION_HASH },
          observation, memory: input.memory, rulesFacts
        } : { observation, memory: input.memory }) }
      ],
      response_format: { type: "json_schema", json_schema: { name: "trinity_move", strict: true, schema: decisionJsonSchema(observation, input.modelId, mustDeclare) } },
      max_tokens: AI_MAX_OUTPUT_TOKENS,
      ...(reasoning ? { reasoning } : {}),
      stream: false,
      provider: {
        require_parameters: true,
        sort: "latency",
        data_collection: "deny",
        max_price: { prompt: 1, completion: 5, request: 0 }
      }
    });
    if (Buffer.byteLength(body, "utf8") > AI_MAX_REQUEST_BYTES) throw new OpenRouterAgentError("request-too-large");

    const controller = new AbortController();
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    this.active.set(controller, rejectTimeout!);
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new OpenRouterAgentError("timeout"));
    }, timeoutMs);
    try {
      return await Promise.race([this.request(body, input.modelId, observation, controller.signal, { v2, mustDeclare }), timeout]);
    } catch (error) {
      if (error instanceof OpenRouterAgentError) throw error;
      throw new OpenRouterAgentError(controller.signal.aborted ? "timeout" : "provider-unavailable");
    } finally {
      clearTimeout(timer);
      this.active.delete(controller);
    }
  }

  /** Cancel only current requests; a later process start may use this client again. */
  cancelAll(): void {
    for (const [controller, reject] of this.active) {
      controller.abort();
      reject(new OpenRouterAgentError("cancelled"));
    }
    this.active.clear();
  }

  private async request(body: string, modelId: string, observation: AiAgentObservation, signal: AbortSignal,
    policy: { v2: boolean; mustDeclare: boolean }): Promise<AiAgentDecisionResult> {
    const response = await this.fetcher(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://trinitymatrix.org",
        "X-OpenRouter-Title": "TrinityMatrix"
      },
      body,
      signal,
      redirect: "error"
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new OpenRouterAgentError("http-error", { status: response.status });
    }
    let text: string;
    try { text = await boundedBody(response); }
    catch (error) {
      if (error instanceof OpenRouterAgentError) throw new OpenRouterAgentError(error.code, { status: response.status });
      throw error;
    }
    let result: unknown;
    try { result = JSON.parse(text); } catch { throw new OpenRouterAgentError("invalid-json", { status: response.status }); }
    const usage = responseUsage(result);
    const metadata: OpenRouterAgentErrorMetadata = { status: response.status, ...(usage ? { usage } : {}) };
    const envelope = z.object({
      model: z.string(),
      choices: z.array(z.object({
        finish_reason: z.string().nullable(),
        message: z.object({ content: z.unknown().optional(), refusal: z.unknown().optional() })
      })).length(1),
      usage: z.object({ cost: z.unknown().optional(), prompt_tokens: z.unknown().optional(), completion_tokens: z.unknown().optional() }).optional()
    }).safeParse(result);
    if (!envelope.success) throw new OpenRouterAgentError("invalid-response", metadata);
    if (envelope.data.model !== modelId) throw new OpenRouterAgentError("model-mismatch", metadata);
    const choice = envelope.data.choices[0]!;
    metadata.finishReason = safeFinishReason(choice.finish_reason);
    if (choice.finish_reason === "length") throw new OpenRouterAgentError("truncated-response", metadata);
    if (choice.finish_reason === "content_filter" || (typeof choice.message.refusal === "string" && choice.message.refusal.length > 0)) {
      throw new OpenRouterAgentError("refused-response", metadata);
    }
    if (choice.finish_reason !== "stop") throw new OpenRouterAgentError("invalid-response", metadata);
    if (typeof choice.message.content !== "string") throw new OpenRouterAgentError("invalid-json", metadata);
    let content: unknown;
    try { content = JSON.parse(choice.message.content); } catch { throw new OpenRouterAgentError("invalid-json", metadata); }
    if (policy.v2 && content && typeof content === "object") {
      const reportedAction = actionSchema.safeParse("action" in content ? content.action : undefined);
      if (reportedAction.success) metadata.action = reportedAction.data;
    }
    const decision = decisionSchema.safeParse(content);
    if (!decision.success) throw new OpenRouterAgentError("invalid-decision", metadata);
    if (policy.v2 && allowedActions(observation).includes(decision.data.action)) {
      if (policy.mustDeclare && decision.data.action !== "declare") throw new OpenRouterAgentError("missed-declaration", metadata);
      if (decision.data.action === "declare"
        && !validateDeclaration(observation.hand, decision.data.cardId ?? "", decision.data.groups, observation.state.wildRank).valid) {
        throw new OpenRouterAgentError("invalid-declaration", metadata);
      }
    }
    const normalizedDecision = validateOwnedCards(decision.data, observation, metadata);
    return {
      decision: normalizedDecision,
      modelId,
      usage: usage ?? { costUsd: null, promptTokens: null, completionTokens: null }
    };
  }
}
