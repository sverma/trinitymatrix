import { useState } from "react";
import { api } from "../../api";
import { BroadcastPublisher } from "./BroadcastPublisher";
import { shareBroadcast, watchPath } from "./LiveDirectory";

export function BroadcastControls({ gameName }: { gameName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState("");
  const [share, setShare] = useState("");
  const [videoSharing, setVideoSharing] = useState(false);
  const close = async () => {
    if (closing) return;
    setClosing(true); setError("");
    try { await api.closeLiveBroadcast(gameName); setClosed(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Broadcast sharing could not be stopped."); }
    finally { setClosing(false); }
  };
  if (closed) return <aside className="broadcast-controls broadcast-stopped" role="status">Broadcast sharing stopped. This game continues privately.</aside>;
  return <details className="broadcast-controls">
    <summary>Broadcasting all hands · 2-minute delay{videoSharing ? " · Video sharing active" : ""}</summary>
    <p>Everyone at this table agreed to reveal all hands after a server-enforced delay of at least two minutes.</p>
    <div className="live-card-actions"><a href={watchPath(gameName)} target="_blank" rel="noreferrer">Open spectator view</a>
      <button className="secondary" type="button" onClick={() => { void shareBroadcast(gameName).then(setShare).catch(() => setShare(new URL(watchPath(gameName), window.location.origin).href)); }}>Share watch link</button>
      <button className="danger" type="button" onClick={() => setConfirming(true)}>Stop table broadcast</button></div>
    {share && <p role="status">Watch link: <a href={share}>{share}</a></p>}
    {error && <p className="live-error" role="alert">{error}</p>}
    {confirming && <div className="live-confirmation" role="group" aria-label="Stop broadcasting this table">
      <p>Stop sharing this table and its video with spectators? Your game will continue. This broadcast cannot be restarted.</p>
      <button className="secondary" type="button" disabled={closing} onClick={() => setConfirming(false)}>Keep broadcasting</button>
      <button className="danger" type="button" disabled={closing} onClick={() => void close()}>{closing ? "Stopping broadcast…" : "Yes, stop broadcasting"}</button>
    </div>}
    <BroadcastPublisher gameName={gameName} onSharingChange={setVideoSharing} />
  </details>;
}
