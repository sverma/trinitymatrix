import { describe, expect, it } from "vitest";
import type { Card } from "@trinitymatrix/protocol";
import {
  createDeck,
  organizeHand,
  shuffle,
  sortHand,
  validateDeclaration,
  validateMeld
} from "./index";

const card = (id: string, suit: Card["suit"], rank: number | null, printedJoker = false): Card => ({
  id,
  deck: 1,
  suit,
  rank,
  printedJoker
});

describe("deck", () => {
  it("creates two unique 54-card decks", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(108);
    expect(new Set(deck.map(({ id }) => id)).size).toBe(108);
  });

  it("shuffles without losing cards", () => {
    const deck = createDeck(1);
    const shuffled = shuffle(deck, () => 0);
    expect(shuffled).toHaveLength(54);
    expect(new Set(shuffled.map(({ id }) => id))).toEqual(new Set(deck.map(({ id }) => id)));
  });

  it("sorts by suit and rank", () => {
    const hand = [card("c9", "clubs", 9), card("c2", "clubs", 2), card("h3", "hearts", 3)];
    expect(sortHand(hand).map(({ id }) => id)).toEqual(["c2", "c9", "h3"]);
  });
});

describe("Trinity meld validation", () => {
  it("requires at least three distinct physical cards", () => {
    const c3 = card("c3", "clubs", 3);
    expect(validateMeld([c3, card("c6", "clubs", 6)], 13).valid).toBe(false);
    expect(validateMeld([c3, c3, card("c6", "clubs", 6)], 13).valid).toBe(false);
  });

  it("accepts same-suit cards totaling a permitted multiple of three", () => {
    expect(validateMeld([
      card("c3", "clubs", 3),
      card("c6", "clubs", 6),
      card("c9", "clubs", 9)
    ], 13)).toMatchObject({ valid: true, total: 18, suitPattern: "same-suit" });
  });

  it("accepts cards of all different suits", () => {
    expect(validateMeld([
      card("ca", "clubs", 1),
      card("s10", "spades", 10),
      card("hq", "hearts", 12)
    ], 13)).toMatchObject({ valid: true, total: 21, suitPattern: "different-suits" });
  });

  it("rejects a repeated suit in a mixed-suit meld", () => {
    expect(validateMeld([
      card("c3", "clubs", 3),
      card("d6", "diamonds", 6),
      card("c9", "clubs", 9)
    ], 13).valid).toBe(false);
  });

  it("rejects totals above 27 even when divisible by three", () => {
    expect(validateMeld([
      card("ck", "clubs", 13),
      card("cq", "clubs", 12),
      card("cj", "clubs", 11)
    ], 9).valid).toBe(false);
  });

  it("uses ace as 1 or 11 and marks a possible 21 as the Trinity meld", () => {
    const result = validateMeld([
      card("ha", "hearts", 1),
      card("h4", "hearts", 4),
      card("h6", "hearts", 6)
    ], 13);
    expect(result).toMatchObject({ valid: true, total: 21 });
    expect(result.validTotals).toContain(21);
  });

  it("lets wilds supply values and ignores their suits, but never resolves them as 21", () => {
    const printedResult = validateMeld([
      card("c8", "clubs", 8),
      card("c10", "clubs", 10),
      card("joker", null, null, true)
    ], 7);
    expect(printedResult).toMatchObject({ valid: true, total: 27, wildCount: 1 });
    expect(printedResult.validTotals).not.toContain(21);

    const selectedRankResult = validateMeld([
      card("h8", "hearts", 8),
      card("h10", "hearts", 10),
      card("s7", "spades", 7)
    ], 7);
    expect(selectedRankResult).toMatchObject({ valid: true, total: 27, wildCount: 1 });
    expect(selectedRankResult.validTotals).not.toContain(21);
  });

  it("does not grant the wild suit exemption to a malformed natural card", () => {
    expect(validateMeld([
      card("c3", "clubs", 3),
      card("missing-suit", null, 6),
      card("c9", "clubs", 9)
    ], 13)).toMatchObject({ valid: false, suitPattern: null, wildCount: 0 });
  });
});

describe("declaration validation", () => {
  const melds = [
    [card("ca", "clubs", 1), card("s10", "spades", 10), card("hq", "hearts", 12)],
    [card("h3", "hearts", 3), card("h6", "hearts", 6), card("h9", "hearts", 9)],
    [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6)],
    [card("s2", "spades", 2), card("s4", "spades", 4), card("s6", "spades", 6), card("s9", "spades", 9)]
  ];
  const discard = card("discard", "clubs", 5);

  it("accepts thirteen cards in valid melds including an exact 21", () => {
    expect(validateDeclaration(
      [...melds.flat(), discard],
      discard.id,
      melds.map((group) => group.map(({ id }) => id)),
      13
    )).toEqual({ valid: true, score: 72, meldTotals: [21, 18, 12, 21] });
  });

  it("requires at least one 21-point meld", () => {
    const groups = [
      [card("c3", "clubs", 3), card("c6", "clubs", 6), card("c9", "clubs", 9)],
      [card("h2", "hearts", 2), card("h4", "hearts", 4), card("h6", "hearts", 6)],
      [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6)],
      [card("s2", "spades", 2), card("s4", "spades", 4), card("s6", "spades", 6), card("s3", "spades", 3)]
    ];
    const result = validateDeclaration(
      [...groups.flat(), discard],
      discard.id,
      groups.map((group) => group.map(({ id }) => id)),
      13
    );
    expect(result).toEqual({
      valid: false,
      reason: "A declaration needs at least one natural meld totaling exactly 21; jokers and wild cards cannot be used in it."
    });
  });

  it("rejects duplicate hand identities before checking submitted coverage", () => {
    const hand = [...melds.flat(), discard];
    hand[1] = { ...hand[1]!, id: hand[0]!.id };
    expect(validateDeclaration(
      hand,
      discard.id,
      melds.map((group) => group.map(({ id }) => id)),
      13
    )).toEqual({ valid: false, reason: "The cards in your hand are not uniquely identifiable." });
  });

  it("rejects submitted identifiers that are not in the remaining hand", () => {
    const submitted = melds.map((group) => group.map(({ id }) => id));
    submitted[0]![0] = "not-in-hand";
    expect(validateDeclaration(
      [...melds.flat(), discard],
      discard.id,
      submitted,
      13
    )).toEqual({ valid: false, reason: "The submitted melds do not match your hand." });
  });

  it("does not satisfy the required 21 with a wild-containing meld", () => {
    const groups = [
      [card("c8", "clubs", 8), card("c10", "clubs", 10), card("joker", null, null, true)],
      [card("h3", "hearts", 3), card("h6", "hearts", 6), card("h9", "hearts", 9)],
      [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6)],
      [card("s2", "spades", 2), card("s4", "spades", 4), card("s6", "spades", 6), card("s3", "spades", 3)]
    ];
    expect(validateDeclaration(
      [...groups.flat(), discard],
      discard.id,
      groups.map((group) => group.map(({ id }) => id)),
      7
    )).toEqual({
      valid: false,
      reason: "A declaration needs at least one natural meld totaling exactly 21; jokers and wild cards cannot be used in it."
    });
  });

  it("scores a wild-containing meld at its highest non-21 total when another natural meld supplies 21", () => {
    const groups = [
      [card("ca", "clubs", 1), card("s10", "spades", 10), card("hq", "hearts", 12)],
      [card("c8", "clubs", 8), card("c10", "clubs", 10), card("joker", null, null, true)],
      [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6)],
      [card("s2", "spades", 2), card("s4", "spades", 4), card("s6", "spades", 6), card("s3", "spades", 3)]
    ];
    expect(validateDeclaration(
      [...groups.flat(), discard],
      discard.id,
      groups.map((group) => group.map(({ id }) => id)),
      7
    )).toEqual({ valid: true, score: 75, meldTotals: [21, 27, 12, 15] });
  });
});

describe("replay hand organization", () => {
  it("organizes a wild-containing meld as a regular meld even when it could total 21", () => {
    const organized = organizeHand([
      card("c8", "clubs", 8),
      card("c10", "clubs", 10),
      card("joker", null, null, true)
    ], 7);
    expect(organized).toHaveLength(1);
    expect(organized[0]).toMatchObject({ kind: "meld", total: 27 });
  });

  it("extracts valid melds and keeps every unmatched card", () => {
    const hand = [
      card("ca", "clubs", 1), card("s10", "spades", 10), card("hq", "hearts", 12),
      card("c3", "clubs", 3), card("c6", "clubs", 6), card("c9", "clubs", 9),
      card("d2", "diamonds", 2)
    ];
    const organized = organizeHand(hand, 13);
    expect(organized.some(({ kind }) => kind === "trinity")).toBe(true);
    expect(organized.flatMap(({ cards }) => cards.map(({ id }) => id)).sort()).toEqual(hand.map(({ id }) => id).sort());
  });

  it("rejects hands larger than the supported maximum", () => {
    expect(() => organizeHand(Array.from({ length: 15 }, (_, index) => card(`c${index}`, "clubs", (index % 13) + 1)), 9))
      .toThrow(/more than 14/i);
  });
});
