import type { Card } from "@trinitymatrix/protocol";
import { createDeck, validateDeclaration, validateMeld } from "@trinitymatrix/game-domain";
import { describe, expect, it } from "vitest";
import { AI_RULES_TOOL_VERSION, checkAiRules } from "./ai-rule-tools";
import { missedWinDeclaration, missedWinHand13, missedWinHand14, missedWinWildRank } from "./ai-missed-win.fixture";

const card = (rank: number, suit: NonNullable<Card["suit"]>, deck = 1): Card => ({ id: `${deck}-${suit}-${rank}`, deck, rank, suit, printedJoker: false });
export const readyRulesHand: Card[] = [
  card(6, "hearts"), card(7, "hearts"), card(8, "hearts"),
  card(8, "clubs"), card(9, "clubs"), card(10, "clubs"),
  card(8, "diamonds"), card(9, "diamonds"), card(10, "diamonds"),
  card(2, "spades"), card(6, "spades"), card(9, "spades"), card(10, "spades")
];

/** Independent small exhaustive oracle: meld validity always comes from the game engine. */
function engineHasDeclaration(hand: readonly Card[], wildRank: number): boolean {
  const full = (1 << hand.length) - 1;
  const valid: Array<{ mask: number; trinity: boolean }> = [];
  for (let mask = 1; mask <= full; mask++) {
    const cards = hand.filter((_card, index) => (mask & (1 << index)) !== 0);
    if (cards.length < 3 || cards.length > 13) continue;
    const result = validateMeld(cards, wildRank);
    if (result.valid) valid.push({ mask, trinity: result.validTotals.includes(21) });
  }
  const memo = new Map<string, boolean>();
  const solve = (mask: number, needsTrinity: boolean): boolean => {
    if (!mask) return !needsTrinity;
    const key = `${mask}:${needsTrinity}`;
    if (memo.has(key)) return memo.get(key)!;
    const first = mask & -mask;
    for (const group of valid) {
      if (!(group.mask & first) || (group.mask & mask) !== group.mask) continue;
      if (solve(mask ^ group.mask, needsTrinity && !group.trinity)) { memo.set(key, true); return true; }
    }
    memo.set(key, false); return false;
  };
  if (hand.length === 13) return solve(full, true);
  return hand.some((_card, index) => solve(full ^ (1 << index), true));
}

describe("own-hand exact AI rules facts", () => {
  it("recognizes a102-point ready13-card hand without suggesting a move or exposing its validation marker", () => {
    const facts = checkAiRules({ hand: readyRulesHand, wildRank: 5 });
    expect(facts).toMatchObject({ status: "complete", toolVersion: AI_RULES_TOOL_VERSION, immediateDeclaration: null, readyHand: { score: 102 } });
    expect(facts).not.toHaveProperty("afterDiscardDraw");
    expect(new Set(facts.readyHand!.groups.flat())).toEqual(new Set(readyRulesHand.map(({ id }) => id)));
    expect(JSON.stringify(facts)).not.toContain("__rules_check_discard__");
  });

  it("returns only an engine-validated immediate declaration for14 cards", () => {
    const hand = [...readyRulesHand, card(3, "clubs")];
    const facts = checkAiRules({ hand, wildRank: 5 });
    expect(facts.status).toBe("complete"); expect(facts.readyHand).toBeNull();
    const plan = facts.immediateDeclaration!; expect(plan).not.toBeNull();
    expect(validateDeclaration(hand, plan.cardId, plan.groups, 5)).toEqual({ valid: true, score: plan.score, meldTotals: expect.any(Array) });
    expect(plan.groups.flat()).toHaveLength(13);
    expect(plan.groups.flat()).not.toContain(plan.cardId);
  });

  it("catches the sanitized missed-win regression before and after drawing", () => {
    expect(validateDeclaration(missedWinHand14, missedWinDeclaration.cardId, missedWinDeclaration.groups, missedWinWildRank)).toMatchObject({ valid: true, score: 102 });
    expect(checkAiRules({ hand: missedWinHand13, wildRank: missedWinWildRank })).toMatchObject({ status: "complete", readyHand: expect.any(Object), immediateDeclaration: null });
    const facts = checkAiRules({ hand: missedWinHand14, wildRank: missedWinWildRank });
    expect(facts.status).toBe("complete"); expect(facts.immediateDeclaration).not.toBeNull();
    const candidate = facts.immediateDeclaration!;
    expect(validateDeclaration(missedWinHand14, candidate.cardId, candidate.groups, missedWinWildRank)).toMatchObject({ valid: true, score: candidate.score });
  });

  it("checks only the known public discard draw and can see that draw enabling a declaration", () => {
    const hand = [...readyRulesHand.slice(0, 12), card(3, "clubs")];
    const visibleDiscard = readyRulesHand[12]!;
    const facts = checkAiRules({ hand, wildRank: 5, visibleDiscard });
    expect(facts.status).toBe("complete"); expect(facts.immediateDeclaration).toBeNull();
    expect(facts.afterDiscardDraw).not.toBeNull();
    const plan = facts.afterDiscardDraw!;
    expect(validateDeclaration([...hand, visibleDiscard], plan.cardId, plan.groups, 5).valid).toBe(true);
    expect(checkAiRules({ hand, wildRank: 5 })).not.toHaveProperty("afterDiscardDraw");
  });

  it("does not turn wild-containing21s into natural Trinity anchors", () => {
    const wilds = createDeck().filter((candidate) => candidate.printedJoker || candidate.rank === 7);
    const facts = checkAiRules({ hand: [...wilds, card(2, "clubs"), card(3, "diamonds")], wildRank: 7 });
    expect(facts).toMatchObject({ status: "complete", readyHand: null, immediateDeclaration: null });
  });

  it("handles ace1/11, face cards and mixed suit patterns with the authoritative rules", () => {
    const hand = [card(1, "hearts"), card(10, "clubs"), card(12, "diamonds"),
      card(2, "hearts"), card(3, "hearts"), card(4, "hearts"),
      card(6, "clubs"), card(7, "clubs"), card(8, "clubs"),
      card(1, "spades"), card(2, "spades"), card(3, "spades"), card(6, "spades")];
    const facts = checkAiRules({ hand, wildRank: 5 });
    expect(facts.status).toBe("complete"); expect(facts.readyHand).not.toBeNull();
    const groups = facts.readyHand!.groups;
    const byId = new Map(hand.map((value) => [value.id, value]));
    expect(groups.every((ids) => validateMeld(ids.map((id) => byId.get(id)!), 5).valid)).toBe(true);
    expect(groups.some((ids) => validateMeld(ids.map((id) => byId.get(id)!), 5).validTotals.includes(21))).toBe(true);
  });

  it("reports budget exhaustion as unknown, never a completed negative", () => {
    expect(checkAiRules({ hand: readyRulesHand, wildRank: 5 }, { maxWorkUnits: 1 })).toMatchObject({ status: "unavailable", reason: "time-budget", immediateDeclaration: null, readyHand: null });
    expect(checkAiRules({ hand: readyRulesHand, wildRank: 5 }, { timeoutMs: 0 })).toMatchObject({ status: "unavailable", reason: "time-budget" });
  });

  it("rejects malformed/duplicate ownership and does not mutate supplied own-hand data", () => {
    expect(checkAiRules({ hand: [...readyRulesHand.slice(0, 12), readyRulesHand[0]!], wildRank: 5 }).status).toBe("unavailable");
    expect(checkAiRules({ hand: readyRulesHand, wildRank: 0 }).status).toBe("unavailable");
    const before = JSON.stringify(readyRulesHand);
    checkAiRules({ hand: readyRulesHand, wildRank: 5, visibleDiscard: card(3, "clubs") });
    expect(JSON.stringify(readyRulesHand)).toBe(before);
    expect(checkAiRules({ hand: readyRulesHand, wildRank: 5, visibleDiscard: readyRulesHand[0]! }).status).toBe("unavailable");
  });

  it("agrees with exhaustive game-engine validity on deterministic positive and negative13/14-card hands", () => {
    let seed = 82397;
    const random = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
    const cases: Array<{ hand: Card[]; wildRank: number }> = [
      { hand: readyRulesHand, wildRank: 5 }, { hand: [...readyRulesHand, card(3, "clubs")], wildRank: 5 }
    ];
    for (let index = 0; index < 6; index++) {
      const deck = createDeck();
      for (let last = deck.length - 1; last > 0; last--) { const chosen = random(last + 1); [deck[last], deck[chosen]] = [deck[chosen]!, deck[last]!]; }
      cases.push({ hand: deck.slice(0, index % 2 ? 14 : 13), wildRank: random(13) + 1 });
    }
    for (const input of cases) {
      const facts = checkAiRules(input, { timeoutMs: 1_000 });
      expect(facts.status).toBe("complete");
      expect(Boolean(input.hand.length === 13 ? facts.readyHand : facts.immediateDeclaration)).toBe(engineHasDeclaration(input.hand, input.wildRank));
    }
  });
});
