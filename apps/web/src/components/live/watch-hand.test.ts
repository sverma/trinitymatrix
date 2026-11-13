import * as domain from "@trinitymatrix/game-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWatchHand, createWatchHandCache, type RecordedWatchLayout } from "./watch-hand";

import { fixtureCard, recordedCards, recordedLayout } from "./watch-hand.fixtures";

afterEach(() => vi.restoreAllMocks());
describe("released hand grouping", () => {
  it("preserves recorded order, invalid groups, natural21 and complete progress counts", () => {
    const view = buildWatchHand(recordedCards, 13, recordedLayout);
    expect(view.source).toBe("recorded");
    expect(view.groups.map(({ cards }) => cards.map(({ id }) => id))).toEqual(recordedLayout.groups);
    expect(view.groups.map(({ kind }) => kind)).toEqual(["trinity", "meld", "invalid", "invalid"]);
    expect(view.groups.map(({ total }) => total)).toEqual([21, 12, null, null]);
    expect(view).toMatchObject({ validMeldCount: 2, invalidMeldCount: 2, unmatchedCardCount: 7, matchedCardCount: 6, trinityCount: 1, score: 33 });
  });

  it.each(["wild rank", "printed joker"])("never calls a21 containing a%s a natural Trinity", (kind) => {
    const cards = [fixtureCard(6, "hearts"), kind === "wild rank" ? fixtureCard(7, "hearts") : { id: "joker", deck: 1, rank: null, suit: null, printedJoker: true }, fixtureCard(8, "hearts")];
    const view = buildWatchHand(cards, 7, { source: "recorded", groups: [cards.map(({ id }) => id)] });
    expect(view.trinityCount).toBe(0);
    expect(view.groups[0]).toMatchObject({ kind: "meld", total: 24 });
  });

  it("rejects recorded totals above27 and groups smaller than3 without replacing the layout", () => {
    const cards = [fixtureCard(11, "hearts"), fixtureCard(12, "hearts"), fixtureCard(13, "hearts"), fixtureCard(2, "clubs"), fixtureCard(4, "clubs")];
    const layout: RecordedWatchLayout = { source: "recorded", groups: [cards.slice(0, 3).map(({ id }) => id), cards.slice(3).map(({ id }) => id)] };
    const view = buildWatchHand(cards, 9, layout);
    expect(view.groups.map(({ kind }) => kind)).toEqual(["invalid", "invalid"]);
    expect(view.groups[1]?.label).toContain("need 3+");
    expect(view.groups.flatMap(({ cards }) => cards.map(({ id }) => id))).toEqual(cards.map(({ id }) => id));
    expect(view).toMatchObject({ validMeldCount: 0, invalidMeldCount: 2, unmatchedCardCount: 5 });
  });

  it("offers a suggestion only when recorded groups are absent and does not call an unmatched remainder invalid", () => {
    const cards = [fixtureCard(6, "hearts"), fixtureCard(7, "hearts"), fixtureCard(8, "hearts"), fixtureCard(13, "clubs")];
    const view = buildWatchHand(cards, 12);
    expect(view.source).toBe("suggested");
    expect(view).toMatchObject({ validMeldCount: 1, invalidMeldCount: 0, unmatchedCardCount: 1, trinityCount: 1 });
    expect(view.groups.map(({ kind }) => kind)).toEqual(["trinity", "unmatched"]);
  });

  it("keeps an untouched full hand neutral rather than inventing an invalid meld", () => {
    const cards = Array.from({ length: 13 }, (_, index) => fixtureCard(index + 1, "clubs"));
    const view = buildWatchHand(cards, 7, { source: "recorded", groups: [cards.map(({ id }) => id)] });
    expect(view.unarranged).toBe(true);
    expect(view.groups[0]?.label).toBe("Unmatched cards");
    expect(view).toMatchObject({ validMeldCount: 0, invalidMeldCount: 0, unmatchedCardCount: 13 });
  });

  it("retains every delayed card once when a recorded layout has stale IDs or a newly drawn card", () => {
    const cards = recordedCards.slice(0, 4);
    const view = buildWatchHand(cards, 13, { source: "recorded", groups: [[cards[2]!.id, "stale", cards[0]!.id, cards[2]!.id], [cards[1]!.id]] });
    expect(view.groups.map(({ cards }) => cards.map(({ id }) => id))).toEqual([[cards[2]!.id, cards[0]!.id], [cards[1]!.id], [cards[3]!.id]]);
  });

  it("reuses suggestions across equivalent snapshots and DVR revisits, but changes with cards or wild rank", () => {
    const organize = vi.spyOn(domain, "organizeHand");
    const cards = recordedCards.slice(0, 3);
    const cache = createWatchHandCache(4);
    const first = cache.get(cards, 13);
    expect(cache.get([...cards].reverse().map((card) => ({ ...card })), 13)).toBe(first);
    expect(organize).toHaveBeenCalledTimes(1);
    expect(cache.get(cards, 7).trinityCount).toBe(0);
    cache.get([...cards, fixtureCard(13, "clubs")], 13);
    expect(organize).toHaveBeenCalledTimes(3);
    expect(cache.get(cards, 13)).toBe(first);
    expect(organize).toHaveBeenCalledTimes(3);
    cache.get(cards, 13, { source: "recorded", groups: [[cards[2]!.id, cards[1]!.id, cards[0]!.id]] });
    expect(organize).toHaveBeenCalledTimes(3);
  });
});
