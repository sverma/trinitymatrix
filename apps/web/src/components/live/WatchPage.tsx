import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { BroadcastComment } from "@trinitymatrix/protocol";
import { cardLabel } from "@trinitymatrix/game-domain";
import { api, type AuthPlayer } from "../../api";
import { useLiveBroadcast } from "./useLiveBroadcast";
import { LiveVideo } from "./LiveVideo";
import { shareBroadcast, watchPath } from "./LiveDirectory";
import { WatchHand, watchCardAsset } from "./WatchHand";
import { broadcastPlayerName, broadcastTitle, broadcastMoveSummary } from "./broadcast-names";

function time(value: number) { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }

function WatchComments({ gameName, comments, canModerate, onComment }: { gameName: string; comments: readonly BroadcastComment[]; canModerate: boolean; onComment: (comment: BroadcastComment) => void }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ message: string; id: string } | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const characters = [...message].length;
  const send = async (event: FormEvent) => {
    event.preventDefault();
    const body = message.trim(); if (!body || characters > 280 || sendInFlight.current) return;
    sendInFlight.current = true;
    const input = pending?.message === body ? pending : { message: body, id: crypto.randomUUID() };
    setPending(input); setSending(true); setError(""); setNotice("");
    try {
      const response = await api.postBroadcastComment(gameName, body, input.id);
      if (response.comment) onComment(response.comment);
      setMessage(""); setPending(null);
      setNotice(response.delayed ? "Message queued. Seated players’ comments appear after the same two-minute delay." : "Message sent.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your message could not be sent. Retry to send it once."); }
    finally { sendInFlight.current = false; setSending(false); }
  };
  const moderate = async (comment: BroadcastComment, report: boolean) => {
    setAction(comment.id); setError(""); setNotice("");
    try {
      if (report) { await api.reportBroadcastComment(gameName, comment.id, reportReason.trim()); setReporting(null); setReportReason(""); setNotice("Report submitted for review."); }
      else { await api.deleteBroadcastComment(gameName, comment.id); onComment({ ...comment, deleted: true, message: "" }); setRemoving(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The message action could not be completed."); }
    finally { setAction(null); }
  };
  return <section className="watch-chat" aria-labelledby="watch-chat-title">
    <h2 id="watch-chat-title">Spectator chat</h2><p className="live-caption">Keep the table welcoming. Seated players’ messages also follow the two-minute delay.</p>
    <ol className="watch-comment-list" aria-label="Broadcast messages" aria-live="polite">{comments.map((comment) => <li key={comment.id}>
      <div className="watch-comment-header"><strong>{comment.displayName}</strong><time dateTime={new Date(comment.createdAt).toISOString()}>{time(comment.createdAt)}</time></div>
      <p>{comment.deleted ? "Message removed by a moderator." : comment.message}</p>
      {!comment.deleted && <div className="watch-comment-actions"><button type="button" onClick={() => { setReporting(comment.id); setReportReason(""); }}>Report</button>{canModerate && <button type="button" onClick={() => setRemoving(comment.id)}>Remove</button>}</div>}
      {reporting === comment.id && <div className="live-confirmation"><label>Reason for report<textarea maxLength={500} value={reportReason} onChange={(event) => setReportReason(event.target.value)} /></label><button type="button" className="secondary" onClick={() => setReporting(null)}>Cancel report</button><button type="button" className="primary" disabled={action !== null} onClick={() => void moderate(comment, true)}>Submit report</button></div>}
      {removing === comment.id && <div className="live-confirmation"><p>Remove this message from spectator chat?</p><button type="button" className="secondary" onClick={() => setRemoving(null)}>Keep message</button><button type="button" className="danger" disabled={action !== null} onClick={() => void moderate(comment, false)}>Confirm removal</button></div>}
    </li>)}</ol>
    {comments.length === 0 && <p className="live-empty">No messages yet. Start the conversation.</p>}
    <form onSubmit={send} className="watch-comment-form"><label htmlFor="broadcast-comment">Your spectator message</label><textarea id="broadcast-comment" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={1120} rows={3} disabled={sending} />
      <div><span className={characters > 280 ? "live-error" : "live-caption"}>{characters}/280 characters</span><button className="primary" disabled={sending || !message.trim() || characters > 280}>{sending ? "Sending…" : "Send message"}</button></div></form>
    {notice && <p role="status">{notice}</p>}{error && <p className="live-error" role="alert">{error}</p>}
  </section>;
}

export function WatchPage({ gameName, player: _player, onAuthenticationRequired }: { gameName: string; player: AuthPlayer; onAuthenticationRequired: () => void }) {
  const live = useLiveBroadcast(gameName, onAuthenticationRequired);
  const [now, setNow] = useState(Date.now);
  const [shared, setShared] = useState("");
  const [playing, setPlaying] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  const selectedIndex = useMemo(() => live.timeline.findIndex((entry) => entry.sequence === live.frame?.sequence), [live.timeline, live.frame?.sequence]);
  useEffect(() => {
    if (!playing || live.seeking || !live.paused) return;
    const next = live.timeline[selectedIndex + 1];
    if (!next) { setPlaying(false); return; }
    const timer = window.setTimeout(() => { void live.seek(next.sequence); }, 1_200);
    return () => window.clearTimeout(timer);
  }, [playing, live.paused, live.seeking, live.timeline, live.seek, selectedIndex]);
  if (live.loading) return <div className="live-empty" role="status">Opening the delayed broadcast…</div>;
  if (live.connection === "closed") return <section className="live-empty"><h1>Broadcast closed</h1><p>{live.error}</p><a href="/live">Find another table</a></section>;
  if (!live.detail) return <section className="live-empty"><h1>Broadcast unavailable</h1><p role="alert">{live.error || "This table is not available for spectators."}</p><button className="secondary" onClick={live.refresh}>Retry</button><a href="/live">Find another table</a></section>;
  const { broadcast, canModerate } = live.detail;
  const frame = live.frame;
  const countdown = Math.max(0, Math.ceil((broadcast.availableAt - (now + live.offset)) / 1_000));
  return <section className="watch-page" aria-labelledby="watch-title">
    <header className="watch-heading"><div><span className="eyebrow">All hands revealed · 2-minute minimum delay</span><h1 id="watch-title">{broadcastTitle(broadcast)}</h1><p>{broadcast.playerCount} players · <strong>{broadcast.viewerCount} watching</strong> · {live.connection === "reconnecting" ? "Reconnecting…" : broadcast.status === "ended" ? "Broadcast ended" : live.paused ? "Paused recording" : "Delayed live"}</p></div>
      <button className="secondary" onClick={() => { void shareBroadcast(gameName).then(setShared).catch(() => setShared(new URL(watchPath(gameName), window.location.origin).href)); }}>Share broadcast</button></header>
    {shared && <p role="status">Watch link: <a href={shared}>{shared}</a></p>}
    {live.error && <p role="alert" className="live-error">{live.error} <button onClick={live.refresh}>Refresh broadcast</button></p>}
    {live.connection === "reconnecting" && <p className="live-reconnecting" role="status">Connection lost. Released moves will be refreshed when the spectator connection returns.</p>}
    {!frame ? <div className="live-empty" role="status"><h2>The table is warming up</h2><p>{countdown > 0 ? `The first hands will be revealed in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}.` : "Waiting for the first released snapshot…"}</p><p>The delay is enforced by the server. Current hands and outcomes remain hidden until release.</p></div> : <>
      <div className="watch-playback" role="group" aria-label="Broadcast playback">
        <button className="secondary" disabled={selectedIndex <= 0 || live.seeking} onClick={() => { setPlaying(false); void live.seek(live.timeline[selectedIndex - 1]!.sequence); }}>Previous move</button>
        <button className="secondary" disabled={live.seeking} onClick={() => { if (!live.paused) live.pause(); else setPlaying((value) => !value); }}>{!live.paused ? "Pause table" : playing ? "Pause recording" : "Play recording"}</button>
        <button className="secondary" disabled={selectedIndex < 0 || selectedIndex >= live.timeline.length - 1 || live.seeking} onClick={() => { setPlaying(false); void live.seek(live.timeline[selectedIndex + 1]!.sequence); }}>Next move</button>
        <button className="primary" onClick={() => { setPlaying(false); live.goLive(); }}>Go to delayed live</button>
        <label>Released move<input aria-label="Replay position" type="range" min={0} max={Math.max(0, live.timeline.length - 1)} value={Math.max(0, selectedIndex)} disabled={live.timeline.length < 2 || live.seeking} onChange={(event) => { const target = live.timeline[Number(event.target.value)]; if (target) { setPlaying(false); void live.seek(target.sequence); } }} /></label>
        <span aria-live="polite">Move {frame.sequence} · played at {time(frame.capturedAt)}{live.seeking ? " · Loading…" : ""}</span>
      </div>
      {frame.winner && <div className="watch-winner" role="status"><strong>{broadcastPlayerName({ displayName: frame.winner.name, actorKind: frame.game.players.find((seat) => seat.id === frame.winner?.id)?.actorKind ?? "human" })} won.</strong> {frame.winner.reason === "declaration" ? `Validated declaration${frame.winner.score === undefined ? "." : ` · ${frame.winner.score} points.`}` : frame.winner.reason === "invalid-declaration" ? "The final opponent made an invalid declaration." : "The last remaining player won."}</div>}
      <div className="watch-layout"><div className="watch-board" aria-label="Delayed Trinity table">
        <div className="watch-table-state"><span>Closed deck <strong>{frame.game.stockCount} cards</strong></span><span>Wild rank <strong>{frame.game.wildRank}</strong></span><span>Open deck {frame.game.topDiscard ? <img src={watchCardAsset(frame.game.topDiscard)} alt={cardLabel(frame.game.topDiscard)} /> : <strong>Empty</strong>}</span></div>
        <div className={`watch-hands watch-seats-${broadcast.playerCount}`}>{frame.game.players.map((seat) => {
          const hand = frame.hands.find((hand) => hand.playerId === seat.id) ?? { cards: [] };
          const cards = hand.cards;
          const displayName = broadcastPlayerName(seat);
          return <section className={`watch-player-hand ${seat.id === frame.game.currentPlayerId && frame.game.phase === "playing" ? "current-turn" : ""}`} key={seat.id} aria-label={`${displayName}'s revealed hand`}>
            <header><strong>{displayName}</strong><span>{seat.actorKind === "ai" ? "AI player" : "Human"} · {seat.status === "playing" ? `${cards.length} cards` : seat.status}{seat.id === frame.game.currentPlayerId && frame.game.phase === "playing" ? " · Current turn" : ""}</span></header>
            {seat.aiModelId && <code>{seat.aiModelId}</code>}
            <WatchHand hand={hand} wildRank={frame.game.wildRank} displayName={displayName} />
          </section>;
        })}</div>
      </div><aside className="watch-move-feed" aria-labelledby="watch-moves-title"><h2 id="watch-moves-title">Released moves</h2>
        {live.moreTimeline && <button className="secondary" disabled={live.timelineLoading} onClick={() => void live.loadEarlier()}>{live.timelineLoading ? "Loading…" : "Load earlier moves"}</button>}
        <ol>{[...live.timeline].reverse().map((entry) => <li key={entry.sequence}><button className={entry.sequence === frame.sequence ? "active" : ""} aria-current={entry.sequence === frame.sequence ? "step" : undefined} onClick={() => { setPlaying(false); void live.seek(entry.sequence); }}><time>{time(entry.capturedAt)}</time><span>{broadcastMoveSummary(entry.event, broadcast.players)}</span></button></li>)}</ol>
      </aside></div>
    </>}
    <LiveVideo gameName={gameName} />
    <WatchComments gameName={gameName} comments={live.comments} canModerate={canModerate} onComment={live.addComment} />
  </section>;
}
