import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LiveBroadcastSummary } from "@trinitymatrix/protocol";
import { api, HttpApiError, type LiveDirectoryFilters } from "../../api";
import { broadcastPlayerName, broadcastTitle } from "./broadcast-names";

export function watchPath(gameName: string) { return `/watch/${encodeURIComponent(gameName)}`; }
export async function shareBroadcast(gameName: string) {
  const url = new URL(watchPath(gameName), window.location.origin).href;
  if (navigator.share) { await navigator.share({ title: "Watch TrinityMatrix", url }); return url; }
  if (!navigator.clipboard?.writeText) throw new Error(url);
  await navigator.clipboard.writeText(url);
  return url;
}

export function LiveDirectory({ onAuthenticationRequired }: { onAuthenticationRequired?: () => void } = {}) {
  const [filters, setFilters] = useState<LiveDirectoryFilters>({ composition: "all", status: "all", q: "" });
  const [search, setSearch] = useState("");
  const [broadcasts, setBroadcasts] = useState<LiveBroadcastSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [shared, setShared] = useState("");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    const controller = new AbortController();
    setLoading(true); setLoadingMore(false); setError(""); setBroadcasts([]); setCursor(null);
    api.liveDirectory(filters, controller.signal).then((response) => {
      if (controller.signal.aborted || generation.current !== request) return;
      setBroadcasts(response.broadcasts); setCursor(response.nextCursor);
    }).catch((cause) => { if (!controller.signal.aborted) { if (cause instanceof HttpApiError && cause.status === 401) onAuthenticationRequired?.(); setError(cause instanceof Error ? cause.message : "Broadcasts could not be loaded."); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, refresh, onAuthenticationRequired]);
  const more = async () => {
    if (!cursor || loadingMore) return;
    const request = generation.current; setLoadingMore(true); setError("");
    try {
      const result = await api.liveDirectory({ ...filters, cursor });
      if (request !== generation.current) return;
      setBroadcasts((current) => [...new Map([...current, ...result.broadcasts].map((entry) => [entry.gameName, entry])).values()]);
      setCursor(result.nextCursor === cursor ? null : result.nextCursor);
    } catch (cause) { if (request === generation.current) { if (cause instanceof HttpApiError && cause.status === 401) onAuthenticationRequired?.(); setError(cause instanceof Error ? cause.message : "More broadcasts could not be loaded."); } }
    finally { if (request === generation.current) setLoadingMore(false); }
  };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setFilters((current) => ({ ...current, q: search.trim() })); };
  return <section className="live-directory" aria-labelledby="live-directory-title">
    <div className="live-page-heading"><span className="eyebrow">TrinityMatrix broadcasts</span><h1 id="live-directory-title">Watch the tables.</h1><p>Follow consenting players with every hand revealed. Game state and video arrive at least two minutes after play.</p></div>
    <form className="live-filters" onSubmit={submitSearch} role="search" aria-label="Find a broadcast">
      <label>Search tables or players<input type="search" maxLength={80} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>Players<select value={filters.composition} onChange={(event) => setFilters((current) => ({ ...current, composition: event.target.value as NonNullable<LiveDirectoryFilters["composition"]> }))}>
        <option value="all">All players</option><option value="human">Humans only</option><option value="ai">AI only</option><option value="mixed">Humans and AI</option></select></label>
      <label>Status<select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as NonNullable<LiveDirectoryFilters["status"]> }))}>
        <option value="all">All broadcasts</option><option value="live">Live</option><option value="ended">Ended</option></select></label>
      <button className="primary" type="submit">Search</button><button className="secondary" type="button" onClick={() => setRefresh((current) => current + 1)}>Refresh</button>
    </form>
    {error && <p role="alert" className="live-error">{error}</p>}
    {shared && <p role="status">Share link: <a href={shared}>{shared}</a></p>}
    {loading ? <p role="status">Finding broadcasts…</p> : broadcasts.length === 0 ? <div className="live-empty"><h2>No broadcasts found</h2><p>Only public tables whose human players agreed to broadcast appear here. Try another filter or check again shortly.</p></div>
      : <div className="live-directory-grid">{broadcasts.map((broadcast) => <article className="live-directory-card" key={broadcast.gameName}>
        <div className="live-card-meta"><span className={`live-status live-${broadcast.status}`}>{broadcast.status === "buffering" ? "Starting delay" : broadcast.status === "live" ? "Delayed live" : "Ended"}</span><span>{broadcast.viewerCount} watching</span></div>
        <h2><a href={watchPath(broadcast.gameName)}>{broadcastTitle(broadcast)}</a></h2><p>{broadcast.playerCount} players · {broadcast.composition === "mixed" ? "Humans and AI" : broadcast.composition === "ai" ? "AI players" : "Human players"}</p>
        <ul className="live-roster">{broadcast.players.map((player) => <li key={player.id}><span>{broadcastPlayerName(player)}</span>{player.actorKind === "ai" && <small>AI</small>}</li>)}</ul>
        <p className="live-delay-label">All hands revealed · 2-minute minimum delay</p>
        <div className="live-card-actions"><a className="primary live-button-link" href={watchPath(broadcast.gameName)}>Watch table</a><button className="secondary" type="button" onClick={() => { void shareBroadcast(broadcast.gameName).then(setShared).catch(() => setShared(new URL(watchPath(broadcast.gameName), window.location.origin).href)); }}>Share</button></div>
      </article>)}</div>}
    {cursor && <button className="secondary live-load-more" type="button" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "Loading…" : "Load more broadcasts"}</button>}
  </section>;
}
