import { useMemo, useRef } from "react";
import type { Card } from "@trinitymatrix/protocol";
import { cardLabel } from "@trinitymatrix/game-domain";
import { createWatchHandCache, watchHandKey, type WatchHandInput } from "./watch-hand";

export function watchCardAsset(card: Card) {
  if (card.printedJoker) return `/assets/cards/${card.deck % 2 ? "red" : "black"}_of_jokers.png`;
  const rank = ({ 1: "ace", 11: "jack", 12: "queen", 13: "king" } as Record<number, string>)[card.rank!] ?? card.rank;
  return `/assets/cards/${rank}_of_${card.suit}.png`;
}

export function WatchHand({ hand, wildRank, displayName }: { hand: WatchHandInput; wildRank: number; displayName: string }) {
  const cache = useRef<ReturnType<typeof createWatchHandCache> | null>(null);
  if (!cache.current) cache.current = createWatchHandCache();
  const key = watchHandKey(hand.cards, wildRank, hand.layout);
  const view = useMemo(() => cache.current!.get(hand.cards, wildRank, hand.layout), [key]);
  return <>
    <p className="watch-layout-source">{view.source === "suggested" ? "Suggested grouping" : view.unarranged ? "Recorded hand order" : "Recorded grouping"}
      <span>{view.source === "suggested" ? "Calculated from this delayed hand; not the player’s arrangement." : "From the player’s latest recorded layout at this released move."}</span></p>
    <p className="watch-hand-progress" aria-label={`${displayName}'s meld counts`}>
      <span><strong>{view.matchedCardCount} of {hand.cards.length}</strong> cards in valid melds</span>
      <span><strong>{view.validMeldCount}</strong> valid {view.validMeldCount === 1 ? "meld" : "melds"}</span>
      <span><strong>{view.invalidMeldCount}</strong> invalid {view.invalidMeldCount === 1 ? "meld" : "melds"}</span>
      <span><strong>{view.unmatchedCardCount}</strong> unmatched {view.unmatchedCardCount === 1 ? "card" : "cards"}</span>
      <span><strong>{view.trinityCount}</strong> natural 21</span>
      <span><strong>{view.score}</strong> valid meld points</span>
    </p>
    {view.groups.length === 0 ? <p className="live-caption">No cards in this released hand.</p> : <ol className="watch-hand-groups" aria-label={`${displayName}'s cards`}>
      {view.groups.map((group, index) => <li className={`watch-hand-group watch-meld-${group.kind}`} key={`${index}-${group.cards[0]?.id}`}>
        <section role="group" aria-label={`Group ${index + 1}: ${group.label}, ${group.cards.length} cards`}>
          <header className="watch-meld-heading"><strong>{group.label}</strong><span>{group.cards.length} {group.cards.length === 1 ? "card" : "cards"} · {group.total === null ? "No valid meld total" : `${group.total} points`}</span></header>
          <ul className="watch-cards" aria-label={`Group ${index + 1} cards`} tabIndex={0}>{group.cards.map((card) => <li key={card.id}>
            <img src={watchCardAsset(card)} alt={cardLabel(card)} loading="lazy" />{(card.printedJoker || card.rank === wildRank) && <small>Wild</small>}
          </li>)}</ul>
        </section>
      </li>)}
    </ol>}
  </>;
}
