import { useState } from "react";
import type { PlayerCount, PrivateRoom } from "@trinitymatrix/protocol";

export function Queue({ joined, required, playerCount, onLeave }: { joined: number; required: number; playerCount: PlayerCount; onLeave: () => void }) {
  return <main id="main-content" className="queue-shell">
    <section className="queue-card" aria-labelledby="queue-title">
      <div className="queue-orbit" aria-hidden="true"><span>{joined}</span></div>
      <span className="eyebrow">Ranking · Points · {playerCount} players</span>
      <h1 id="queue-title">Finding your table</h1>
      <p aria-live="polite">{joined} of {required} players are ready.</p>
      <progress className="progress-track" aria-label="Players found" value={joined} max={required}>{joined} of {required}</progress>
      <p className="muted">Keep this page open. Your cards will be dealt automatically when the table is full.</p>
      <button className="secondary" onClick={onLeave}>Leave queue</button>
    </section>
  </main>;
}

export function PrivateRoomQueue({
  room,
  playerId,
  onBack,
  onCancel
}: {
  room: PrivateRoom;
  playerId: string;
  onBack: () => void;
  onCancel: () => Promise<void>;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const isCreator = room.creator.playerId === playerId;
  const starting = room.status === "active";

  const cancel = async () => {
    setCancelling(true);
    setError("");
    try {
      await onCancel();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not cancel the private table.");
      setCancelling(false);
    }
  };

  return <main id="main-content" className="queue-shell private-queue-shell">
    <section className="queue-card private-queue-card" aria-labelledby="private-queue-title">
      <span className="eyebrow">Private · Unranked · {room.playerCount} players</span>
      <h1 id="private-queue-title">{starting ? "Starting your private table" : "Waiting for invited players"}</h1>
      <p className="private-room-code">Room <code>{room.roomCode}</code></p>
      <p aria-live="polite">{room.acceptedCount} of {room.requiredCount} players are ready.</p>
      <progress className="progress-track" aria-label="Invited players ready" value={room.acceptedCount} max={room.requiredCount}>{room.acceptedCount} of {room.requiredCount}</progress>

      <ol className="private-seat-list" aria-label="Private table seats">
        <li className="accepted"><span aria-hidden="true">✓</span><div><strong>{room.creator.displayName}</strong><small>Table creator</small></div><em>Ready</em></li>
        {room.invites.map((invite) => <li key={invite.seatNumber} className={invite.status}>
          <span aria-hidden="true">{invite.status === "accepted" ? "✓" : "…"}</span>
          <div>
            <strong>{invite.displayName ?? invite.email ?? `Invited player ${invite.seatNumber}`}</strong>
            {invite.displayName && invite.email
              ? <small>{invite.email}</small>
              : !invite.displayName && !invite.email
                ? <small>Seat {invite.seatNumber}</small>
                : invite.isCurrentUser ? <small>Your invited seat</small> : null}
          </div>
          <em>{invite.status === "accepted" ? "Ready" : "Invited"}</em>
        </li>)}
      </ol>

      <p className="muted">{starting
        ? "Everyone is ready. Cards will be dealt automatically."
        : "Keep this page open. The table starts automatically when every invited player accepts and connects."}</p>
      {error && <p className="form-error" role="alert">{error}</p>}

      {!starting && <div className="private-queue-actions">
        {!isCreator && <button type="button" className="secondary" onClick={onBack}>Back to lobby</button>}
        {isCreator && !confirmCancel && <button type="button" className="danger" onClick={() => setConfirmCancel(true)}>Cancel private table</button>}
        {isCreator && confirmCancel && <div className="cancel-private-confirmation" role="group" aria-labelledby="cancel-private-title">
          <strong id="cancel-private-title">Cancel this table for everyone?</strong>
          <p>Invited players will no longer be able to join.</p>
          <div><button type="button" className="secondary" disabled={cancelling} onClick={() => setConfirmCancel(false)}>Keep waiting</button><button type="button" className="danger" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Yes, cancel table"}</button></div>
        </div>}
      </div>}
    </section>
  </main>;
}
