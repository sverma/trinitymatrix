import { useEffect, useMemo, useState } from "react";
import type { GameReplay, ReplayEvent, ReplayMeldGroup } from "../api";

function formatEventTime(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : date.toLocaleString();
}

function eventDetails(event: ReplayEvent) {
  if (event.payload === undefined || event.payload === null) return "No additional event data.";
  if (typeof event.payload === "string") return event.payload;
  return JSON.stringify(event.payload, null, 2);
}

function resultReason(reason: string | undefined): string {
  if (reason === "player-dropped") return "Won after the other player dropped";
  if (reason === "invalid-declaration") return "Won after an invalid declaration";
  return "Won with a server-validated declaration";
}

function meldProgress(progress: NonNullable<NonNullable<ReplayEvent["state"]>["players"]>[number]["progress"]): string {
  if (!progress) return "";
  const meldText = `${progress.validMeldCount} valid ${progress.validMeldCount === 1 ? "meld" : "melds"}`;
  const trinityText = `${progress.trinityMeldCount} at 21`;
  return `${progress.matchedCardCount} of ${progress.totalCardCount} cards grouped · ${meldText} · ${trinityText} · ${progress.score} points`;
}

function cardClasses(card: { suit: string | null; wild: boolean }): string {
  return [
    "replay-card",
    card.suit ? `suit-${card.suit}` : "printed-joker",
    card.wild ? "wild" : ""
  ].filter(Boolean).join(" ");
}

function ReplayGroup({ group, addedIds }: { group: ReplayMeldGroup; addedIds: ReadonlySet<string> }) {
  return <section className={`replay-meld meld-${group.kind}`} role="group" aria-label={`${group.label}, ${group.cards.length} cards`}>
    <span className="replay-meld-label">{group.label}</span>
    <span className="replay-meld-cards">
      {group.cards.map((card) => <span
        className={`${cardClasses(card)} ${addedIds.has(card.id) ? "new-card" : ""}`.trim()}
        key={card.id}
        title={card.wild ? `${card.label}, joker` : card.label}
      >{card.label}</span>)}
    </span>
  </section>;
}

export function ReplayViewer({ replay }: { replay: GameReplay }) {
  const events = useMemo(
    () => [...replay.events].sort((left, right) => left.sequence - right.sequence),
    [replay.events]
  );
  const [eventIndex, setEventIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const finalIndex = Math.max(0, events.length - 1);
  const currentEvent = events[eventIndex];
  const previousEvent = eventIndex > 0 ? events[eventIndex - 1] : undefined;

  useEffect(() => {
    setEventIndex(0);
    setPlaying(false);
  }, [replay.gameName]);

  useEffect(() => {
    if (!playing || events.length < 2) return;
    const timer = window.setInterval(() => {
      setEventIndex((current) => {
        if (current >= finalIndex) {
          setPlaying(false);
          return finalIndex;
        }
        return current + 1;
      });
    }, Math.round(1_200 / speed));
    return () => window.clearInterval(timer);
  }, [events.length, finalIndex, playing, speed]);

  const moveTo = (index: number) => {
    setPlaying(false);
    setEventIndex(Math.max(0, Math.min(finalIndex, index)));
  };

  if (!currentEvent) {
    return <section className="portal-panel empty-state" aria-labelledby="replay-title">
      <span className="eyebrow">Replay</span>
      <h2 id="replay-title">No recorded events</h2>
      <p>This game does not have an event stream available yet.</p>
    </section>;
  }

  const state = currentEvent.state;
  return <section className="portal-panel replay-panel" aria-labelledby="replay-title">
    <div className="section-heading">
      <div>
        <span className="eyebrow">Event replay</span>
        <h2 id="replay-title">{replay.gameName}</h2>
      </div>
      <span className="status-pill">Event {eventIndex + 1} of {events.length}</span>
    </div>

    {replay.winnerName && <div className="replay-winner" aria-label={`Winner: ${replay.winnerName}`}>
      <span aria-hidden="true">🏆</span>
      <span><small>Winner</small><strong>{replay.winnerName}</strong></span>
      <span>{resultReason(replay.reason)}</span>
    </div>}

    <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      Replay event {eventIndex + 1} of {events.length}: {currentEvent.summary}
    </p>

    <div className="replay-stage">
      <div>
        <span className="event-type">{currentEvent.type.replace(/[._-]+/g, " ")}</span>
        <h3>{currentEvent.summary}</h3>
        <p>{currentEvent.actorName ? `${currentEvent.actorName} · ` : ""}{formatEventTime(currentEvent.at)}</p>
      </div>
      {state && <dl className="replay-state">
        {state.phase && <div><dt>Phase</dt><dd>{state.phase}</dd></div>}
        {state.currentPlayerName && <div><dt>Turn</dt><dd>{state.currentPlayerName}</dd></div>}
        {typeof state.stockCount === "number" && <div><dt>Closed deck</dt><dd>{state.stockCount} cards</dd></div>}
        {state.topDiscard !== undefined && <div><dt>Open deck</dt><dd>{state.topDiscard ?? "Empty"}</dd></div>}
        {typeof state.wildRank === "number" && <div><dt>Wild joker</dt><dd>{state.wildRank === 1 ? "Ace" : state.wildRank}</dd></div>}
      </dl>}
      {state?.players && state.players.length > 0 && <ul className="replay-players" aria-label="Player hand progression">
        {state.players.map((player, index) => {
          const previousPlayer = previousEvent?.state?.players?.find((candidate) =>
            player.playerId ? candidate.playerId === player.playerId : candidate.displayName === player.displayName);
          const previousCards = new Map((previousPlayer?.cards ?? []).map((card) => [card.id, card]));
          const currentIds = new Set((player.cards ?? []).map(({ id }) => id));
          const addedCards = (player.cards ?? []).filter(({ id }) => !previousCards.has(id));
          const removedCards = (previousPlayer?.cards ?? []).filter(({ id }) => !currentIds.has(id));
          const addedIds = new Set(addedCards.map(({ id }) => id));
          return <li className={player.isWinner ? "replay-player winner" : "replay-player"} key={player.playerId ?? `${player.displayName}-${index}`}>
            <div className="replay-player-heading">
              <span><strong>{player.displayName}</strong><small>{player.status ?? "playing"}{typeof player.cardCount === "number" ? ` · ${player.cardCount} cards` : ""}</small></span>
              {player.isWinner && <span className="winner-badge">Winner</span>}
            </div>
            {(addedCards.length > 0 || removedCards.length > 0) && <p className="replay-hand-change" aria-label={`${player.displayName}'s hand changed`}>
              {addedCards.length > 0 && <span className="cards-added">+ {addedCards.map(({ label }) => label).join(", ")}</span>}
              {removedCards.length > 0 && <span className="cards-removed">− {removedCards.map(({ label }) => label).join(", ")}</span>}
            </p>}
            {player.progress && <p className={`replay-progress ${player.progress.declarationReady ? "ready" : ""}`}>
              {player.progress.declarationReady && <strong>Valid declaration · </strong>}{meldProgress(player.progress)}
            </p>}
            {player.groups && player.groups.length > 0
              ? <div className="replay-hand-groups" aria-label={`${player.displayName}'s grouped cards`}>
                  {player.groups.map((group, groupIndex) => <ReplayGroup group={group} addedIds={addedIds} key={`${groupIndex}-${group.cards[0]?.id ?? "empty"}`} />)}
                </div>
              : player.cards && player.cards.length > 0 && <span className="replay-hand" aria-label={`${player.displayName}'s cards`}>
                  {player.cards.map((card) => <span className={cardClasses(card)} key={card.id}>{card.label}</span>)}
                </span>}
            {player.groups && <small className="layout-source">{player.layoutSource === "recorded"
              ? "Recorded player layout at the latest accepted move"
              : "Best meld view reconstructed for this historic hand"}</small>}
          </li>;
        })}
      </ul>}
      <details className="event-data">
        <summary>Event data</summary>
        <pre>{eventDetails(currentEvent)}</pre>
      </details>
    </div>

    <label className="timeline-label" htmlFor="replay-timeline">
      Replay timeline <span>{eventIndex + 1} / {events.length}</span>
    </label>
    <input
      id="replay-timeline"
      className="replay-timeline"
      type="range"
      min="0"
      max={finalIndex}
      value={eventIndex}
      aria-valuetext={`Event ${eventIndex + 1}: ${currentEvent.summary}`}
      onChange={(event) => moveTo(Number(event.target.value))}
    />

    <div className="replay-controls" aria-label="Replay controls">
      <button type="button" className="secondary compact" onClick={() => moveTo(0)} disabled={eventIndex === 0}>First</button>
      <button type="button" className="secondary compact" onClick={() => moveTo(eventIndex - 1)} disabled={eventIndex === 0}>Previous</button>
      <button
        type="button"
        className="primary compact replay-play"
        aria-pressed={playing}
        onClick={() => {
          if (eventIndex === finalIndex) setEventIndex(0);
          setPlaying((current) => !current);
        }}
      >{playing ? "Pause" : "Play"}</button>
      <button type="button" className="secondary compact" onClick={() => moveTo(eventIndex + 1)} disabled={eventIndex === finalIndex}>Next</button>
      <button type="button" className="secondary compact" onClick={() => moveTo(finalIndex)} disabled={eventIndex === finalIndex}>Last</button>
      <label className="speed-control">Speed
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
          <option value="0.5">0.5×</option>
          <option value="1">1×</option>
          <option value="2">2×</option>
        </select>
      </label>
    </div>

    <ol className="event-list" aria-label="Replay events">
      {events.map((event, index) => <li key={`${event.sequence}-${index}`} className={index === eventIndex ? "current" : ""}>
        <button type="button" aria-current={index === eventIndex ? "step" : undefined} onClick={() => moveTo(index)}>
          <span>{index + 1}</span>
          <span><strong>{event.summary}</strong><small>{event.type.replace(/[._-]+/g, " ")}</small></span>
        </button>
      </li>)}
    </ol>
  </section>;
}
