import type { Card } from "@trinitymatrix/protocol";
import { organizeHand, validateMeld } from "@trinitymatrix/game-domain";

export type RecordedWatchLayout = { source: "recorded"; groups: readonly (readonly string[])[] };
export type WatchHandInput = { cards: readonly Card[]; layout?: RecordedWatchLayout | undefined };
export type WatchMeldGroup = { kind: "trinity" | "meld" | "invalid" | "unmatched"; label: string; cards: readonly Card[]; total: number | null };
export type WatchHandView = {
  source: "recorded" | "suggested";
  unarranged: boolean;
  groups: WatchMeldGroup[];
  validMeldCount: number;
  invalidMeldCount: number;
  unmatchedCardCount: number;
  matchedCardCount: number;
  trinityCount: number;
  score: number;
};

/** Keys include values as well as IDs, so replay/wild-rank changes cannot reuse stale results. */
export function watchHandKey(cards: readonly Card[], wildRank: number, layout?: RecordedWatchLayout) {
  const values = cards.map((card) => [card.id, card.deck, card.suit, card.rank, card.printedJoker] as const)
    .sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify([wildRank, values, layout?.groups ?? null]);
}

function classify(cards: readonly Card[], wildRank: number, unmatched = false): WatchMeldGroup {
  if (unmatched) return { kind: "unmatched", label: "Unmatched cards", cards, total: null };
  if (cards.length < 3) return { kind: "invalid", label: "Invalid meld · need 3+", cards, total: null };
  const result = validateMeld(cards, wildRank);
  if (result.valid && result.wildCount === 0 && result.validTotals.includes(21)) return { kind: "trinity", label: "Natural 21 · Trinity", cards, total: 21 };
  if (result.valid) return { kind: "meld", label: "Valid meld", cards, total: result.total };
  return { kind: "invalid", label: "Invalid meld", cards, total: null };
}

export function buildWatchHand(cards: readonly Card[], wildRank: number, layout?: RecordedWatchLayout): WatchHandView {
  let unarranged = false;
  let groups: WatchMeldGroup[];
  if (layout) {
    const byId = new Map(cards.map((card) => [card.id, card]));
    const used = new Set<string>();
    const recorded = layout.groups.map((ids) => ids.flatMap((id) => {
      const card = byId.get(id);
      if (!card || used.has(id)) return [];
      used.add(id); return [card];
    })).filter((group) => group.length > 0);
    const remaining = cards.filter(({ id }) => !used.has(id));
    // Clients also archive the untouched single hand. It is not an attempted invalid meld.
    unarranged = recorded.length === 1 && recorded[0]!.length === cards.length && cards.length >= 13
      && !validateMeld(recorded[0]!, wildRank).valid;
    groups = recorded.map((group) => classify(group, wildRank, unarranged));
    if (remaining.length) groups.push(classify(remaining, wildRank, true));
  } else {
    const canonical = [...cards].sort((left, right) => left.id.localeCompare(right.id));
    groups = organizeHand(canonical, wildRank).map((group) => classify(group.cards, wildRank, group.kind === "unmatched"));
  }
  const valid = groups.filter(({ kind }) => kind === "trinity" || kind === "meld");
  return {
    source: layout ? "recorded" : "suggested", unarranged, groups,
    validMeldCount: valid.length,
    invalidMeldCount: groups.filter(({ kind }) => kind === "invalid").length,
    unmatchedCardCount: cards.length - valid.reduce((total, group) => total + group.cards.length, 0),
    matchedCardCount: valid.reduce((total, group) => total + group.cards.length, 0),
    trinityCount: valid.filter(({ kind }) => kind === "trinity").length,
    score: valid.reduce((total, group) => total + (group.total ?? 0), 0)
  };
}

/** Per-mounted-hand LRU: repeated chat/timer snapshots and DVR revisits do not rerun the organizer. */
export function createWatchHandCache(capacity = 32) {
  const entries = new Map<string, WatchHandView>();
  return {
    get(cards: readonly Card[], wildRank: number, layout?: RecordedWatchLayout) {
      const key = watchHandKey(cards, wildRank, layout);
      const view = entries.get(key) ?? buildWatchHand(cards, wildRank, layout);
      entries.delete(key); entries.set(key, view);
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
      return view;
    }
  };
}
