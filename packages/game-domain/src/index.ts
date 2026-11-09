import type { Card, Suit } from "@trinitymatrix/protocol";

const suits: Suit[] = ["clubs", "diamonds", "hearts", "spades"];

export const MIN_MELD_CARDS = 3;
export const MAX_MELD_TOTAL = 27;
export const TRINITY_TOTAL = 21;
export const VALID_MELD_TOTALS = [3, 6, 9, 12, 15, 18, 21, 24, 27] as const;

export type RandomIndex = (maxExclusive: number) => number;

export function createDeck(deckCount = 2): Card[] {
  const cards: Card[] = [];
  for (let deck = 1; deck <= deckCount; deck += 1) {
    for (const suit of suits) {
      for (let rank = 1; rank <= 13; rank += 1) {
        cards.push({
          id: `${deck}-${suit}-${rank}`,
          deck,
          suit,
          rank,
          printedJoker: false
        });
      }
    }
    for (let joker = 1; joker <= 2; joker += 1) {
      cards.push({
        id: `${deck}-joker-${joker}`,
        deck,
        suit: null,
        rank: null,
        printedJoker: true
      });
    }
  }
  return cards;
}

export function shuffle<T>(items: readonly T[], randomIndex: RandomIndex): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (swapIndex < 0 || swapIndex > index || !Number.isInteger(swapIndex)) {
      throw new RangeError(`randomIndex returned ${swapIndex} for maximum ${index + 1}`);
    }
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

export function sortHand(hand: readonly Card[]): Card[] {
  const suitOrder = new Map<Suit, number>(suits.map((suit, index) => [suit, index]));
  return [...hand].sort((left, right) => {
    if (left.printedJoker !== right.printedJoker) return left.printedJoker ? -1 : 1;
    const leftSuit = left.suit ? suitOrder.get(left.suit)! : -1;
    const rightSuit = right.suit ? suitOrder.get(right.suit)! : -1;
    return leftSuit - rightSuit || (left.rank ?? 0) - (right.rank ?? 0) || left.deck - right.deck;
  });
}

export type MeldSuitPattern = "same-suit" | "different-suits";

export type MeldResult = Readonly<{
  valid: boolean;
  total: number | null;
  validTotals: readonly number[];
  suitPattern: MeldSuitPattern | null;
  wildCount: number;
}>;

function isWild(card: Card, wildRank: number): boolean {
  return card.printedJoker || card.rank === wildRank;
}

function cardValues(card: Card, wildRank: number): readonly number[] {
  if (isWild(card, wildRank)) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  if (card.rank === 1) return [1, 11];
  if (card.rank === 11 || card.rank === 12 || card.rank === 13) return [10];
  return card.rank === null ? [] : [card.rank];
}

function possibleTotals(cards: readonly Card[], wildRank: number): number[] {
  let totals = new Set([0]);
  for (const card of cards) {
    const next = new Set<number>();
    for (const total of totals) {
      for (const value of cardValues(card, wildRank)) {
        if (total + value <= MAX_MELD_TOTAL) next.add(total + value);
      }
    }
    totals = next;
  }
  return [...totals].sort((left, right) => left - right);
}

function suitPattern(cards: readonly Card[], wildRank: number): MeldSuitPattern | null {
  const naturalCards = cards.filter((card) => !isWild(card, wildRank));
  // Only wilds are exempt from the suit rule. Treat a malformed natural card
  // without a suit as invalid instead of silently granting it the exemption.
  if (naturalCards.some(({ suit }) => suit === null)) return null;
  const naturalSuits = naturalCards.map(({ suit }) => suit as Suit);
  const uniqueSuits = new Set(naturalSuits);
  if (uniqueSuits.size <= 1) return "same-suit";
  return uniqueSuits.size === naturalSuits.length ? "different-suits" : null;
}

/**
 * Validates the original Trinity rules supplied by the game author.
 *
 * A meld has at least three cards, follows either a same-suit or an
 * all-different-suits pattern (wilds are exempt), and totals a multiple of
 * three from 3 through 27. Aces may be 1 or 11; face cards are 10. Printed
 * jokers and cards matching the round's wild rank may represent values 1–11,
 * but a 21-point Trinity meld must contain no wilds.
 */
export function validateMeld(cards: readonly Card[], wildRank: number): MeldResult {
  const wildCount = cards.filter((card) => isWild(card, wildRank)).length;
  if (cards.length < MIN_MELD_CARDS || new Set(cards.map(({ id }) => id)).size !== cards.length) {
    return { valid: false, total: null, validTotals: [], suitPattern: null, wildCount };
  }

  const pattern = suitPattern(cards, wildRank);
  if (!pattern) return { valid: false, total: null, validTotals: [], suitPattern: null, wildCount };

  const allowed = new Set<number>(VALID_MELD_TOTALS);
  const validTotals = possibleTotals(cards, wildRank)
    .filter((total) => allowed.has(total) && (wildCount === 0 || total !== TRINITY_TOTAL));
  if (validTotals.length === 0) {
    return { valid: false, total: null, validTotals, suitPattern: pattern, wildCount };
  }

  // A natural 21 is chosen explicitly because it is the declaration anchor.
  // Wild-containing melds cannot retain 21 in validTotals, so they resolve to
  // their highest other valid total and can never be classified as Trinity.
  const total = validTotals.includes(TRINITY_TOTAL) ? TRINITY_TOTAL : validTotals.at(-1)!;
  return { valid: true, total, validTotals, suitPattern: pattern, wildCount };
}

export type OrganizedMeldKind = "trinity" | "meld" | "unmatched";

export type OrganizedHandGroup = Readonly<{
  kind: OrganizedMeldKind;
  cards: readonly Card[];
  total: number | null;
}>;

type MeldCandidate = Readonly<{
  mask: number;
  kind: Exclude<OrganizedMeldKind, "unmatched">;
  size: number;
  total: number;
}>;

type MeldSelection = Readonly<{
  masks: readonly MeldCandidate[];
  matchedCards: number;
  trinityMelds: number;
  points: number;
}>;

function bitCount(value: number): number {
  let count = 0;
  for (let remaining = value; remaining > 0; remaining &= remaining - 1) count += 1;
  return count;
}

function selectionScore(selection: MeldSelection): readonly number[] {
  return [selection.matchedCards, selection.trinityMelds > 0 ? 1 : 0, selection.points, -selection.masks.length];
}

function betterSelection(left: MeldSelection, right: MeldSelection): MeldSelection {
  const leftScore = selectionScore(left);
  const rightScore = selectionScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) return leftScore[index]! > rightScore[index]! ? left : right;
  }
  return left;
}

function cardsForMask(cards: readonly Card[], mask: number): Card[] {
  return cards.filter((_, index) => (mask & (1 << index)) !== 0);
}

function meldCandidate(cards: readonly Card[], wildRank: number, mask: number): MeldCandidate | null {
  const result = validateMeld(cards, wildRank);
  if (!result.valid || result.total === null) return null;
  return {
    mask,
    kind: result.validTotals.includes(TRINITY_TOTAL) ? "trinity" : "meld",
    size: cards.length,
    total: result.total
  };
}

export function sortMeldCards(cards: readonly Card[], kind: OrganizedMeldKind, wildRank?: number): Card[] {
  if (kind === "unmatched" || wildRank === undefined) return sortHand(cards);
  return [...cards].sort((left, right) => {
    const leftWild = isWild(left, wildRank) ? 1 : 0;
    const rightWild = isWild(right, wildRank) ? 1 : 0;
    if (leftWild !== rightWild) return leftWild - rightWild;
    return (left.suit ?? "").localeCompare(right.suit ?? "")
      || (left.rank ?? 14) - (right.rank ?? 14)
      || left.deck - right.deck;
  });
}

/** Finds a deterministic best-effort Trinity meld view for a hand or replay. */
export function organizeHand(hand: readonly Card[], wildRank: number): OrganizedHandGroup[] {
  if (hand.length === 0) return [];
  if (hand.length > 14) throw new RangeError("A Trinity hand cannot contain more than 14 cards.");

  const candidates: MeldCandidate[] = [];
  const maximumMask = 1 << hand.length;
  for (let mask = 1; mask < maximumMask; mask += 1) {
    const size = bitCount(mask);
    if (size < MIN_MELD_CARDS) continue;
    const candidate = meldCandidate(cardsForMask(hand, mask), wildRank, mask);
    if (candidate) candidates.push(candidate);
  }

  const candidatesByCard = new Map<number, MeldCandidate[]>();
  for (const candidate of candidates) {
    for (let index = 0; index < hand.length; index += 1) {
      if ((candidate.mask & (1 << index)) === 0) continue;
      const existing = candidatesByCard.get(index) ?? [];
      existing.push(candidate);
      candidatesByCard.set(index, existing);
    }
  }

  const memo = new Map<number, MeldSelection>();
  const select = (remainingMask: number): MeldSelection => {
    if (remainingMask === 0) return { masks: [], matchedCards: 0, trinityMelds: 0, points: 0 };
    const cached = memo.get(remainingMask);
    if (cached) return cached;
    const firstBit = remainingMask & -remainingMask;
    const firstIndex = Math.log2(firstBit);
    let best = select(remainingMask ^ firstBit);
    for (const candidate of candidatesByCard.get(firstIndex) ?? []) {
      if ((candidate.mask & remainingMask) !== candidate.mask) continue;
      const tail = select(remainingMask ^ candidate.mask);
      best = betterSelection(best, {
        masks: [candidate, ...tail.masks],
        matchedCards: candidate.size + tail.matchedCards,
        trinityMelds: (candidate.kind === "trinity" ? 1 : 0) + tail.trinityMelds,
        points: candidate.total + tail.points
      });
    }
    memo.set(remainingMask, best);
    return best;
  };

  const selected = select(maximumMask - 1);
  const selectedMask = selected.masks.reduce((mask, candidate) => mask | candidate.mask, 0);
  const groups: OrganizedHandGroup[] = selected.masks
    .map((candidate) => ({
      kind: candidate.kind,
      total: candidate.total,
      cards: sortMeldCards(cardsForMask(hand, candidate.mask), candidate.kind, wildRank)
    }))
    .sort((left, right) => {
      const priority: Record<OrganizedMeldKind, number> = { trinity: 0, meld: 1, unmatched: 2 };
      return priority[left.kind] - priority[right.kind]
        || (right.total ?? 0) - (left.total ?? 0)
        || (left.cards[0]?.suit ?? "").localeCompare(right.cards[0]?.suit ?? "");
    });
  const unmatched = hand.filter((_, index) => (selectedMask & (1 << index)) === 0);
  if (unmatched.length > 0) groups.push({ kind: "unmatched", total: null, cards: sortHand(unmatched) });
  return groups;
}

export type DeclarationResult =
  | { valid: true; score: number; meldTotals: readonly number[] }
  | { valid: false; reason: string };

export function validateDeclaration(
  hand: readonly Card[],
  discardCardId: string,
  meldIds: readonly (readonly string[])[],
  wildRank: number
): DeclarationResult {
  if (hand.length !== 14) return { valid: false, reason: "Draw a card before declaring." };
  if (new Set(hand.map(({ id }) => id)).size !== hand.length) {
    return { valid: false, reason: "The cards in your hand are not uniquely identifiable." };
  }
  if (!hand.some((card) => card.id === discardCardId)) {
    return { valid: false, reason: "The declaration discard is not in your hand." };
  }

  const remaining = hand.filter((card) => card.id !== discardCardId);
  const submittedIds = meldIds.flat();
  if (submittedIds.length !== 13 || new Set(submittedIds).size !== 13) {
    return { valid: false, reason: "Every remaining card must appear exactly once." };
  }
  const remainingIds = new Set(remaining.map(({ id }) => id));
  if (!remaining.every((card) => submittedIds.includes(card.id))
    || !submittedIds.every((id) => remainingIds.has(id))) {
    return { valid: false, reason: "The submitted melds do not match your hand." };
  }

  const byId = new Map(remaining.map((card) => [card.id, card]));
  const results = meldIds.map((ids) => validateMeld(ids.map((id) => byId.get(id)!), wildRank));
  const invalidIndex = results.findIndex((result) => !result.valid);
  if (invalidIndex >= 0) {
    return { valid: false, reason: `Meld ${invalidIndex + 1} is invalid. Use 3+ cards, a permitted suit pattern, and a total from 3 to 27 in steps of 3.` };
  }
  if (!results.some((result) => result.validTotals.includes(TRINITY_TOTAL))) {
    return {
      valid: false,
      reason: "A declaration needs at least one natural meld totaling exactly 21; jokers and wild cards cannot be used in it."
    };
  }

  const meldTotals = results.map((result) => result.total!);
  return { valid: true, score: meldTotals.reduce((total, value) => total + value, 0), meldTotals };
}

export function cardLabel(card: Card): string {
  if (card.printedJoker) return "Printed joker";
  const rankNames: Record<number, string> = { 1: "Ace", 11: "Jack", 12: "Queen", 13: "King" };
  return `${rankNames[card.rank!] ?? card.rank} of ${card.suit}`;
}
