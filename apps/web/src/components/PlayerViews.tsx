import { useEffect, useRef, useState } from "react";
import { profileBadges } from "@trinitymatrix/protocol";
import {
  api,
  type AuthPlayer,
  type GameReplay,
  type MatchHistoryEntry,
  type RealtimeChatMessage,
  type RankingEntry
} from "../api";
import { PostGameChat } from "./PostGameChat";
import { ReplayViewer } from "./ReplayViewer";

export type PlayerSection = "play" | "rankings" | "history";

function collection<K extends string, T>(response: T[] | Record<K, T[]>, key: K): T[] {
  return Array.isArray(response) ? response : response[key];
}

function formatDate(value: number | string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function badgeSymbol(entry: RankingEntry) {
  return profileBadges.find((badge) => badge.id === entry.badgeId)?.symbol ?? "♠";
}

function matchTypeLabel(matchType: MatchHistoryEntry["matchType"]) {
  return matchType === "private" ? "Private · Unranked" : "General · Ranked";
}

const historyRetryWindowMs = 30_000;
const historyRetryMaximumDelayMs = 2_000;

export function RankingsView({ playerId }: { playerId: string }) {
  const [rankings, setRankings] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    api.rankings().then((response) => {
      if (active) setRankings(collection(response, "rankings"));
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load the rankings.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  return <section className="portal-view" aria-labelledby="rankings-title">
    <div className="portal-hero compact-hero">
      <span className="eyebrow">Ranking arena</span>
      <h1 id="rankings-title">Leaderboard</h1>
      <p>Ratings move with completed ranking games. Wins break ties, followed by games played.</p>
    </div>
    {loading ? <div className="portal-panel loading-inline" role="status">Loading rankings…</div>
      : error ? <div className="portal-panel error-state" role="alert"><h2>Rankings unavailable</h2><p>{error}</p></div>
      : rankings.length === 0 ? <div className="portal-panel empty-state"><h2>No ranked games yet</h2><p>Complete the first match to start the leaderboard.</p></div>
      : <div className="portal-panel rankings-panel">
        <div className="podium" aria-label="Top ranked players">
          {rankings.slice(0, 3).map((entry) => <article key={entry.playerId} className={`podium-card place-${entry.rank}`}>
            <span className="podium-rank">#{entry.rank}</span>
            <span className="podium-badge" aria-hidden="true">{badgeSymbol(entry)}</span>
            <strong>{entry.displayName}</strong>
            <span>{entry.rating} rating</span>
          </article>)}
        </div>
        <div className="table-scroll">
          <table className="data-table rankings-table">
            <caption>Current ranking standings</caption>
            <thead><tr><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">Rating</th><th scope="col">Wins</th><th scope="col">Games</th><th scope="col">Win rate</th></tr></thead>
            <tbody>{rankings.map((entry) => {
              const winRate = entry.gamesPlayed === 0 ? 0 : Math.round((entry.wins / entry.gamesPlayed) * 100);
              return <tr key={entry.playerId} className={entry.playerId === playerId ? "current-player" : ""}>
                <td><strong>#{entry.rank}</strong></td>
                <th scope="row"><span className="table-player"><span aria-hidden="true">{badgeSymbol(entry)}</span>{entry.displayName}{entry.playerId === playerId && <small>You</small>}</span></th>
                <td>{entry.rating}</td><td>{entry.wins}</td><td>{entry.gamesPlayed}</td><td>{winRate}%</td>
              </tr>;
            })}</tbody>
          </table>
        </div>
      </div>}
  </section>;
}

function replayFrom(response: GameReplay | { replay: GameReplay }) {
  return "replay" in response ? response.replay : response;
}

function GameArchive({ entry, player, onBack, realtimeMessages, connectionGeneration }: {
  entry: MatchHistoryEntry;
  player: AuthPlayer;
  onBack: () => void;
  realtimeMessages: readonly RealtimeChatMessage[];
  connectionGeneration: number;
}) {
  const [replay, setReplay] = useState<GameReplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const backButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    backButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    let active = true;
    api.gameReplay(entry.gameName).then((response) => {
      if (active) setReplay(replayFrom(response));
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load the replay.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [entry.gameName]);

  return <section className="archive-view" aria-labelledby="archive-title">
    <button ref={backButtonRef} type="button" className="text-button back-button" onClick={onBack}>← Back to match history</button>
    <div className="portal-hero compact-hero archive-hero">
      <span className="eyebrow">Completed game · {matchTypeLabel(entry.matchType)}</span>
      <h1 id="archive-title">{entry.gameName}</h1>
      <p><strong className={`result-text result-${entry.result}`}>{entry.result}</strong> · {formatDate(entry.finishedAt)} · Winner: {entry.winnerName}</p>
    </div>
    {loading ? <div className="portal-panel loading-inline" role="status">Loading event replay…</div>
      : error ? <div className="portal-panel error-state" role="alert"><h2>Replay unavailable</h2><p>{error}</p></div>
      : replay && <ReplayViewer replay={replay} />}
    <PostGameChat
      key={entry.gameName}
      gameName={entry.gameName}
      playerId={player.id}
      realtimeMessages={realtimeMessages}
      connectionGeneration={connectionGeneration}
    />
  </section>;
}

export function MatchHistoryView({
  player,
  initialGameName = null,
  onArchiveClosed = () => undefined,
  realtimeMessages = [],
  connectionGeneration = 0
}: {
  player: AuthPlayer;
  initialGameName?: string | null;
  onArchiveClosed?: () => void;
  realtimeMessages?: readonly RealtimeChatMessage[];
  connectionGeneration?: number;
}) {
  const [games, setGames] = useState<MatchHistoryEntry[]>([]);
  const [selected, setSelected] = useState<MatchHistoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const replayButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  const returnFocusIndex = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;
    let retryAttempt = 0;
    const startedAt = Date.now();
    const abortController = new AbortController();

    const scheduleRetry = (load: () => void) => {
      const delay = Math.min(100 * (2 ** retryAttempt), historyRetryMaximumDelayMs);
      retryAttempt += 1;
      retryTimer = window.setTimeout(load, delay);
    };

    const load = () => {
      api.matchHistory(abortController.signal).then((response) => {
        if (!active) return;
        const history = collection(response, "games");
        setGames(history);
        const completedGame = initialGameName
          ? history.find(({ gameName }) => gameName === initialGameName)
          : undefined;
        if (completedGame) {
          setSelected(completedGame);
          setError("");
          setLoading(false);
          return;
        }
        if (initialGameName && Date.now() - startedAt < historyRetryWindowMs) {
          setError("");
          setLoading(true);
          scheduleRetry(load);
          return;
        }
        setError(initialGameName
          ? "Your completed match is still being saved. Open History again in a moment."
          : "");
        setLoading(false);
      }).catch((reason) => {
        if (!active || abortController.signal.aborted) return;
        if (initialGameName && Date.now() - startedAt < historyRetryWindowMs) {
          scheduleRetry(load);
          return;
        }
        setError(reason instanceof Error ? reason.message : "Could not load match history.");
        setLoading(false);
      });
    };

    setError("");
    setLoading(true);
    load();
    return () => {
      active = false;
      abortController.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [initialGameName]);

  useEffect(() => {
    if (selected || returnFocusIndex.current === null) return;
    const index = returnFocusIndex.current;
    returnFocusIndex.current = null;
    replayButtonRefs.current.get(index)?.focus();
  }, [selected]);

  if (selected) return <GameArchive
    entry={selected}
    player={player}
    realtimeMessages={realtimeMessages}
    connectionGeneration={connectionGeneration}
    onBack={() => { setSelected(null); onArchiveClosed(); }}
  />;

  return <section className="portal-view" aria-labelledby="history-title">
    <div className="portal-hero compact-hero">
      <span className="eyebrow">Your games</span>
      <h1 id="history-title">Match history</h1>
      <p>Review every completed result, replay its event stream, and leave a short post-game note.</p>
    </div>
    {loading ? <div className="portal-panel loading-inline" role="status">{initialGameName ? "Saving completed match…" : "Loading match history…"}</div>
      : error ? <div className="portal-panel error-state" role="alert"><h2>History unavailable</h2><p>{error}</p></div>
      : games.length === 0 ? <div className="portal-panel empty-state"><h2>No completed matches</h2><p>Your finished ranking games will appear here.</p></div>
      : <div className="history-list">{games.map((game, index) => <article className="history-card" key={game.gameName}>
        <div className={`result-mark result-${game.result}`} aria-label={`Result: ${game.result}`}>{game.result === "won" ? "W" : game.result === "lost" ? "L" : "D"}</div>
        <div className="history-main">
          <div><span className="eyebrow">{matchTypeLabel(game.matchType)} · {game.playerCount} players</span><h2>{game.gameName}</h2></div>
          <dl>
            <div><dt>Finished</dt><dd>{formatDate(game.finishedAt)}</dd></div>
            <div><dt>Winner</dt><dd>{game.winnerName}</dd></div>
            {typeof game.score === "number" && <div><dt>Score</dt><dd>{game.score}</dd></div>}
            {typeof game.rankDelta === "number" && <div><dt>Rating</dt><dd>{game.rankDelta > 0 ? "+" : ""}{game.rankDelta}</dd></div>}
          </dl>
        </div>
        <button
          ref={(node) => {
            if (node) replayButtonRefs.current.set(index, node);
            else replayButtonRefs.current.delete(index);
          }}
          type="button"
          className="secondary"
          onClick={() => {
            returnFocusIndex.current = index;
            setSelected(game);
          }}
        >Replay and chat</button>
      </article>)}</div>}
  </section>;
}
