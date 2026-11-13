import { performance } from "node:perf_hooks";
import type { Card } from "@trinitymatrix/protocol";
import { MAX_MELD_TOTAL, MIN_MELD_CARDS, TRINITY_TOTAL, VALID_MELD_TOTALS, validateDeclaration } from "@trinitymatrix/game-domain";
import type { AiGameRulesFacts, AiImmediateDeclaration, AiReadyHand } from "./ai-game-protocol";

export const AI_RULES_TOOL_VERSION = "shared-own-hand-legality/1.0.0" as const;
const rulesRevision: AiGameRulesFacts["rulesRevision"] = "trinity-rules/1.0.0";
export type AiRulesInput = Readonly<{ hand: readonly Card[]; wildRank: number; visibleDiscard?: Card | null | undefined }>;
export type AiRulesLimits = Readonly<{ maxWorkUnits?: number; timeoutMs?: number }>;
const suits = ["clubs", "diamonds", "hearts", "spades"];
const totalMask = (1 << (MAX_MELD_TOTAL + 1)) - 1;
const permittedTotals = VALID_MELD_TOTALS.reduce((mask, total) => mask | (1 << total), 0);
const trinityBit = 1 << TRINITY_TOTAL;
const unknown = -2;

class RulesBudgetExceeded extends Error {}

export function unavailableAiRules(reason: "time-budget" | "tool-error"): AiGameRulesFacts {
  return { rulesRevision, toolVersion: AI_RULES_TOOL_VERSION, status: "unavailable", reason, readyHand: null, immediateDeclaration: null };
}

function validCard(card: Card): boolean {
  return typeof card?.id === "string" && card.id.length > 0 && card.id.length <= 200
    && Number.isInteger(card.deck) && card.deck >= 1
    && typeof card.printedJoker === "boolean"
    && (card.printedJoker ? card.rank === null && card.suit === null
      : Number.isInteger(card.rank) && card.rank! >= 1 && card.rank! <= 13 && suits.includes(card.suit ?? ""));
}

/** An exact completion checker. It returns no move recommendation when the hand cannot win. */
export function checkAiRules(input: AiRulesInput, limits: AiRulesLimits = {}): AiGameRulesFacts {
  const began = performance.now();
  const timeoutMs = limits.timeoutMs ?? 250;
  const maximumWork = limits.maxWorkUnits ?? 2_000_000;
  let work = 0;
  const consume = (forceTimeCheck = false) => {
    if (++work > maximumWork || ((forceTimeCheck || (work & 255) === 0) && performance.now() - began >= timeoutMs)) throw new RulesBudgetExceeded();
  };
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maximumWork) || maximumWork <= 0) return unavailableAiRules("time-budget");
    if (!input || ![13, 14].includes(input.hand?.length) || !Number.isInteger(input.wildRank) || input.wildRank < 1 || input.wildRank > 13
      || !input.hand.every(validCard) || new Set(input.hand.map(({ id }) => id)).size !== input.hand.length) return unavailableAiRules("tool-error");
    const hand = [...input.hand].sort((left, right) => left.id.localeCompare(right.id));
    const visible = hand.length === 13 ? input.visibleDiscard : undefined;
    if (visible && (!validCard(visible) || hand.some(({ id }) => id === visible.id))) return unavailableAiRules("tool-error");
    const cards = visible ? [...hand, visible] : hand;
    const ownMask = (1 << hand.length) - 1;
    const fullMask = (1 << cards.length) - 1;
    const count = new Uint8Array(fullMask + 1);
    const wildCount = new Uint8Array(fullMask + 1);
    const naturalCount = new Uint8Array(fullMask + 1);
    const suitBits = new Uint8Array(fullMask + 1);
    const totals = new Uint32Array(fullMask + 1); totals[0] = 1;
    const candidates = Array.from({ length: cards.length }, () => [] as number[]);
    const naturalTrinities: number[] = [];
    const values = cards.map((card) => card.printedJoker || card.rank === input.wildRank ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
      : card.rank === 1 ? [1, 11] : [Math.min(10, card.rank!)]);
    const wild = cards.map((card) => card.printedJoker || card.rank === input.wildRank);
    const naturalSuit = cards.map((card, index) => wild[index] ? 0 : 1 << suits.indexOf(card.suit!));
    const suitCount = Array.from({ length: 16 }, (_, mask) => mask.toString(2).replaceAll("0", "").length);
    for (let mask = 1; mask <= fullMask; mask++) {
      consume();
      const bit = mask & -mask; const index = 31 - Math.clz32(bit); const previous = mask ^ bit;
      count[mask] = count[previous]! + 1;
      wildCount[mask] = wildCount[previous]! + Number(wild[index]);
      naturalCount[mask] = naturalCount[previous]! + Number(!wild[index]);
      suitBits[mask] = suitBits[previous]! | naturalSuit[index]!;
      let sums = 0;
      for (const value of values[index]!) sums |= totals[previous]! << value;
      totals[mask] = sums & totalMask;
      if (count[mask]! < MIN_MELD_CARDS || count[mask]! > 13 || totals[mask] === 0) continue;
      const uniqueSuits = suitCount[suitBits[mask]!]!;
      if (uniqueSuits > 1 && uniqueSuits !== naturalCount[mask]) continue;
      const allowed = totals[mask]! & permittedTotals & (wildCount[mask] ? ~trinityBit : totalMask);
      if (!allowed) continue;
      if (!wildCount[mask] && (allowed & trinityBit)) naturalTrinities.push(mask);
      for (let remaining = mask; remaining; remaining &= remaining - 1) {
        const cardBit = remaining & -remaining;
        candidates[31 - Math.clz32(cardBit)]!.push(mask);
      }
    }
    const choices = new Int32Array(fullMask + 1); choices.fill(unknown); choices[0] = 0;
    const partition = (mask: number): boolean => {
      consume();
      if (choices[mask] !== unknown) return choices[mask]! >= 0;
      if (count[mask]! < MIN_MELD_CARDS) { choices[mask] = -1; return false; }
      const index = 31 - Math.clz32(mask & -mask);
      for (const candidate of candidates[index]!) {
        consume();
        if ((candidate & mask) === candidate && partition(mask ^ candidate)) { choices[mask] = candidate; return true; }
      }
      choices[mask] = -1; return false;
    };
    const groupsFor = (target: number): string[][] | null => {
      for (const trinity of naturalTrinities) {
        consume();
        if ((trinity & target) !== trinity || !partition(target ^ trinity)) continue;
        const masks = [trinity];
        for (let remaining = target ^ trinity; remaining;) { const chosen = choices[remaining]!; masks.push(chosen); remaining ^= chosen; }
        return masks.map((mask) => cards.flatMap((card, index) => (mask & (1 << index)) ? [card.id] : []));
      }
      return null;
    };
    const declaration = (owned: readonly Card[], cardId: string, groups: string[][]): AiImmediateDeclaration => {
      const valid = validateDeclaration(owned, cardId, groups, input.wildRank);
      if (!valid.valid) throw new Error("Rules checker produced an unvalidated plan.");
      return { cardId, groups, score: valid.score };
    };
    const immediate = (): AiImmediateDeclaration | null => {
      for (let index = 0; index < cards.length; index++) {
        consume();
        const groups = groupsFor(fullMask ^ (1 << index));
        if (groups) return declaration(cards, cards[index]!.id, groups);
      }
      return null;
    };
    let readyHand: AiReadyHand | null = null;
    let immediateDeclaration: AiImmediateDeclaration | null = null;
    let afterDiscardDraw: AiImmediateDeclaration | null | undefined;
    if (hand.length === 13) {
      const groups = groupsFor(ownMask);
      if (groups) {
        let marker = "__rules_check_discard__";
        while (cards.some(({ id }) => id === marker)) marker += "_";
        const checked = declaration([...hand, { id: marker, deck: 1, suit: "clubs", rank: 2, printedJoker: false }], marker, groups);
        readyHand = { groups: checked.groups, score: checked.score };
      }
      if (visible) afterDiscardDraw = immediate();
    } else immediateDeclaration = immediate();
    consume(true);
    return { rulesRevision, toolVersion: AI_RULES_TOOL_VERSION, status: "complete", readyHand, immediateDeclaration,
      ...(visible ? { afterDiscardDraw: afterDiscardDraw ?? null } : {}) };
  } catch (error) { return unavailableAiRules(error instanceof RulesBudgetExceeded ? "time-budget" : "tool-error"); }
}
