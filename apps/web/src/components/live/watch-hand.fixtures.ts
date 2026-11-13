import type { Card } from "@trinitymatrix/protocol";
import type { RecordedWatchLayout } from "./watch-hand";

export function fixtureCard(rank: number, suit: NonNullable<Card["suit"]>, deck = 1): Card {
  return { id: `${deck}-${suit}-${rank}`, rank, suit, deck, printedJoker: false };
}
export const recordedCards = [
  fixtureCard(6, "hearts"), fixtureCard(7, "hearts"), fixtureCard(8, "hearts"),
  fixtureCard(2, "clubs"), fixtureCard(4, "clubs"), fixtureCard(6, "clubs"),
  fixtureCard(10, "diamonds"), fixtureCard(11, "diamonds"),
  fixtureCard(3, "spades"), fixtureCard(5, "spades"), fixtureCard(10, "hearts"), fixtureCard(9, "clubs"), fixtureCard(1, "diamonds")
];
export const recordedLayout: RecordedWatchLayout = {
  source: "recorded", groups: [recordedCards.slice(0, 3), recordedCards.slice(3, 6), recordedCards.slice(6, 8), recordedCards.slice(8)]
    .map((group) => group.map(({ id }) => id))
};
