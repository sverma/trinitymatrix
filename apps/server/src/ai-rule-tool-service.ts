import { Worker } from "node:worker_threads";
import type { Card } from "@trinitymatrix/protocol";
import type { AiGameRulesFacts } from "./ai-game-protocol";
import { AI_RULES_TOOL_VERSION, unavailableAiRules, type AiRulesInput } from "./ai-rule-tools";

const maximumPendingJobs = 8;
export type AiRuleToolServiceOptions = { workerFactory?: () => Worker };
type Job = {
  id: number; input: AiRulesInput; expiresAt: number; resolve: (facts: AiGameRulesFacts) => void;
  timer: ReturnType<typeof setTimeout>; signal: AbortSignal | undefined; onAbort: () => void; finished: boolean;
};

export function aiRuleWorkerUrl(moduleUrl: string = import.meta.url): URL {
  const url = new URL(moduleUrl);
  if (url.pathname.endsWith(".ts")) return new URL("./ai-rule-worker-bootstrap.mjs", url);
  return new URL(/\/ops\/[^/]+\.js$/.test(url.pathname) ? "./ai-rule-worker.js" : "./ops/ai-rule-worker.js", url);
}

function ownedCard(card: Card): Card {
  if (!card || typeof card.id !== "string" || !card.id.length || card.id.length > 200
    || typeof card.deck !== "number" || typeof card.printedJoker !== "boolean"
    || (card.rank !== null && typeof card.rank !== "number") || (card.suit !== null && (typeof card.suit !== "string" || card.suit.length > 10))) {
    throw new Error("Invalid scoped card.");
  }
  return { id: card.id, deck: card.deck, rank: card.rank, suit: card.suit, printedJoker: card.printedJoker };
}
function scopedInput(input: AiRulesInput): AiRulesInput {
  return { hand: input.hand.map(ownedCard), wildRank: input.wildRank,
    ...(input.visibleDiscard ? { visibleDiscard: ownedCard(input.visibleDiscard) } : {}) };
}
function isFacts(value: unknown, input: AiRulesInput): value is AiGameRulesFacts {
  if (!value || typeof value !== "object") return false;
  const facts = value as Partial<AiGameRulesFacts>;
  if (facts.toolVersion !== AI_RULES_TOOL_VERSION || facts.rulesRevision !== "trinity-rules/1.0.0") return false;
  if (facts.status === "unavailable") return ["time-budget", "tool-error"].includes(facts.reason ?? "") && facts.readyHand === null && facts.immediateDeclaration === null && facts.afterDiscardDraw == null;
  if (facts.status !== "complete") return false;
  const plan = (value: unknown, cards: readonly Card[], hasDiscard: boolean) => {
    if (value === null) return true;
    if (!value || typeof value !== "object") return false;
    const item = value as { score?: unknown; groups?: unknown; cardId?: unknown };
    if (!Number.isInteger(item.score) || (item.score as number) < 0 || !Array.isArray(item.groups) || item.groups.length < 1 || item.groups.length > 4) return false;
    if (!item.groups.every((group: unknown) => Array.isArray(group) && group.length >= 3 && group.length <= 13 && group.every((id: unknown) => typeof id === "string" && id.length <= 200))) return false;
    const ids = (item.groups as string[][]).flat();
    if (ids.length !== 13 || new Set(ids).size !== 13) return false;
    const discard = hasDiscard ? item.cardId : undefined;
    if (hasDiscard && (typeof discard !== "string" || !cards.some(({ id }) => id === discard))) return false;
    const expected = cards.filter(({ id }) => id !== discard);
    return expected.length === 13 && expected.every(({ id }) => ids.includes(id));
  };
  if (input.hand.length === 14) return facts.readyHand === null && facts.afterDiscardDraw === undefined && plan(facts.immediateDeclaration, input.hand, true);
  return facts.immediateDeclaration === null && plan(facts.readyHand, input.hand, false)
    && (input.visibleDiscard ? plan(facts.afterDiscardDraw, [...input.hand, input.visibleDiscard], true) : facts.afterDiscardDraw === undefined);
}

/** One reusable worker, eight pending jobs, and a hard wall-clock deadline including queue time. */
export class AiRuleToolService {
  private worker: Worker | null = null;
  private generation = 0;
  private nextId = 1;
  private active: Job | null = null;
  private pending: Job[] = [];
  private termination: Promise<void> | null = null;
  private stopped = false;
  constructor(private readonly options: AiRuleToolServiceOptions = {}) {}

  compute(input: AiRulesInput, timeoutMs = 1_000, signal?: AbortSignal): Promise<AiGameRulesFacts> {
    if (this.stopped || signal?.aborted) return Promise.resolve(unavailableAiRules("tool-error"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(unavailableAiRules("time-budget"));
    if (this.pending.length >= maximumPendingJobs) return Promise.resolve(unavailableAiRules("tool-error"));
    if (!Array.isArray(input?.hand) || ![13, 14].includes(input.hand.length) || typeof input.wildRank !== "number") return Promise.resolve(unavailableAiRules("tool-error"));
    let scoped: AiRulesInput;
    try { scoped = scopedInput(input); } catch { return Promise.resolve(unavailableAiRules("tool-error")); }
    return new Promise((resolve) => {
      const budget = Math.min(10_000, Math.max(1, Math.floor(timeoutMs)));
      const job: Job = { id: this.nextId++, input: scoped, expiresAt: Date.now() + budget, resolve,
        timer: setTimeout(() => this.cancelJob(job, "time-budget"), budget), signal,
        onAbort: () => this.cancelJob(job, "tool-error"), finished: false };
      signal?.addEventListener("abort", job.onAbort, { once: true });
      this.pending.push(job); this.pump();
    });
  }

  private finish(job: Job, facts: AiGameRulesFacts): void {
    if (job.finished) return;
    job.finished = true; clearTimeout(job.timer); job.signal?.removeEventListener("abort", job.onAbort);
    this.pending = this.pending.filter((queued) => queued !== job);
    if (this.active === job) this.active = null;
    job.resolve(facts);
  }
  private cancelJob(job: Job, reason: "time-budget" | "tool-error"): void {
    if (job.finished) return;
    const running = this.active === job;
    this.finish(job, unavailableAiRules(reason));
    if (running) void this.recycleWorker(); else this.pump();
  }
  private recycleWorker(): Promise<void> {
    if (this.termination) return this.termination;
    const worker = this.worker; this.worker = null; this.generation += 1;
    if (!worker) { this.pump(); return Promise.resolve(); }
    const ending = worker.terminate().then(() => undefined, () => undefined).finally(() => {
      if (this.termination === ending) { this.termination = null; this.pump(); }
    });
    this.termination = ending;
    return ending;
  }
  private failure(generation: number): void {
    if (generation !== this.generation) return;
    if (this.active) this.finish(this.active, unavailableAiRules("tool-error"));
    void this.recycleWorker();
  }
  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const url = aiRuleWorkerUrl();
    const worker = this.options.workerFactory?.() ?? new Worker(url, { execArgv: [] });
    const generation = ++this.generation;
    worker.on("message", (message: { id?: number; facts?: unknown }) => {
      if (generation !== this.generation || !this.active || message?.id !== this.active.id) return;
      if (!isFacts(message.facts, this.active.input)) { this.failure(generation); return; }
      this.finish(this.active, message.facts); this.pump();
    });
    worker.on("error", () => this.failure(generation));
    worker.on("exit", () => this.failure(generation));
    worker.unref(); this.worker = worker;
    return worker;
  }
  private pump(): void {
    if (this.stopped || this.active || this.termination) return;
    let job = this.pending.shift();
    while (job && (job.finished || job.expiresAt <= Date.now())) {
      if (!job.finished) this.finish(job, unavailableAiRules("time-budget"));
      job = this.pending.shift();
    }
    if (!job) return;
    this.active = job;
    try { this.getWorker().postMessage({ id: job.id, input: job.input, timeoutMs: Math.min(250, Math.max(1, job.expiresAt - Date.now())) }); }
    catch { this.finish(job, unavailableAiRules("tool-error")); void this.recycleWorker(); }
  }
  async cancelAll(): Promise<void> {
    for (const job of [...this.pending]) this.finish(job, unavailableAiRules("tool-error"));
    if (this.active) this.finish(this.active, unavailableAiRules("tool-error"));
    await this.recycleWorker();
  }
  async stop(): Promise<void> { this.stopped = true; await this.cancelAll(); }
}
