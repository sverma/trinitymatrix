import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { profileBadges, type PlayerCount, type PrivateInvitation, type PrivateRoom } from "@trinitymatrix/protocol";
import { api, type AuthPlayer, type ProfileUpdate, type RealtimeChatMessage } from "../api";
import { MatchHistoryView, RankingsView, type PlayerSection } from "./PlayerViews";
import { ProfileDialog } from "./ProfileDialog";
import { PolicyFooter } from "./PolicyPages";

type PlayMode = "general" | "private";

function mergeByRoomCode<T extends { roomCode: string }>(current: T[], incoming: readonly T[]) {
  const valid = (entry: T | null | undefined): entry is T =>
    Boolean(entry && typeof entry.roomCode === "string" && entry.roomCode.length > 0);
  const rooms = new Map(current.filter(valid).map((entry) => [entry.roomCode, entry]));
  for (const entry of incoming) {
    if (valid(entry)) rooms.set(entry.roomCode, entry);
  }
  return [...rooms.values()];
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

export function Lobby({
  player,
  onJoin,
  onLogout,
  onUpdateProfile,
  onOpenPrivateRoom = () => undefined,
  section = "play",
  onSectionChange = () => undefined,
  openGameName = null,
  onArchiveClosed = () => undefined,
  realtimeChatMessages = [],
  realtimePrivateInvitations = [],
  realtimePrivateRooms = [],
  connectionGeneration = 0
}: {
  player: AuthPlayer;
  onJoin: (count: PlayerCount) => void;
  onLogout: () => void;
  onUpdateProfile: (profile: ProfileUpdate) => Promise<void>;
  onOpenPrivateRoom?: (room: PrivateRoom) => void;
  section?: PlayerSection;
  onSectionChange?: (section: PlayerSection) => void;
  openGameName?: string | null;
  onArchiveClosed?: () => void;
  realtimeChatMessages?: readonly RealtimeChatMessage[];
  realtimePrivateInvitations?: readonly PrivateInvitation[];
  realtimePrivateRooms?: readonly PrivateRoom[];
  connectionGeneration?: number;
}) {
  const [playMode, setPlayMode] = useState<PlayMode>("general");
  const [playerCount, setPlayerCount] = useState<PlayerCount>(2);
  const [privatePlayerCount, setPrivatePlayerCount] = useState<PlayerCount>(2);
  const [inviteEmails, setInviteEmails] = useState([""]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [invitations, setInvitations] = useState<PrivateInvitation[]>([]);
  const [createdRooms, setCreatedRooms] = useState<PrivateRoom[]>([]);
  const [privateLoading, setPrivateLoading] = useState(true);
  const [privateError, setPrivateError] = useState("");
  const [privateNotice, setPrivateNotice] = useState("");
  const [privateAction, setPrivateAction] = useState<string | null>(null);
  const terminalPrivateRooms = useRef(new Set<string>());
  const latestRealtimeInvitations = useRef(realtimePrivateInvitations);
  latestRealtimeInvitations.current = realtimePrivateInvitations;
  const badge = profileBadges.find(({ id }) => id === player.badgeId) ?? profileBadges[0]!;

  useEffect(() => {
    let active = true;
    setPrivateLoading(true);
    api.privateMatches().then((overview) => {
      if (!active) return;
      setInvitations(mergeByRoomCode([], [...overview.invitations, ...latestRealtimeInvitations.current])
        .filter(({ roomCode }) => !terminalPrivateRooms.current.has(roomCode)));
      setCreatedRooms((current) => mergeByRoomCode(current, overview.createdRooms));
      setPrivateError("");
    }).catch((reason) => {
      if (active) setPrivateError(reason instanceof Error ? reason.message : "Could not load private tables.");
    }).finally(() => {
      if (active) setPrivateLoading(false);
    });
    return () => { active = false; };
  }, [connectionGeneration, player.id]);

  useEffect(() => {
    const activeInvitations = realtimePrivateInvitations.filter(
      (invitation) => !terminalPrivateRooms.current.has(invitation.roomCode),
    );
    if (activeInvitations.length > 0) {
      setInvitations((current) => mergeByRoomCode(current, activeInvitations));
    }
  }, [realtimePrivateInvitations]);

  useEffect(() => {
    const terminalRoomCodes = new Set(realtimePrivateRooms
      .filter(({ status }) => status === "cancelled" || status === "completed")
      .map(({ roomCode }) => roomCode));
    if (terminalRoomCodes.size > 0) {
      for (const roomCode of terminalRoomCodes) terminalPrivateRooms.current.add(roomCode);
      setInvitations((current) => current.filter(({ roomCode }) => !terminalRoomCodes.has(roomCode)));
    }
    const ownedRooms = realtimePrivateRooms.filter(({ creator }) => creator.playerId === player.id);
    if (ownedRooms.length > 0) setCreatedRooms((current) => mergeByRoomCode(current, ownedRooms));
  }, [player.id, realtimePrivateRooms]);

  const changePrivatePlayerCount = (count: PlayerCount) => {
    setPrivatePlayerCount(count);
    setInviteEmails((current) => Array.from({ length: count - 1 }, (_, index) => current[index] ?? ""));
    setPrivateError("");
    setPrivateNotice("");
  };

  const createPrivateRoom = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = inviteEmails.map((email) => email.trim().toLowerCase());
    setPrivateError("");
    setPrivateNotice("");
    if (normalized.length !== privatePlayerCount - 1 || normalized.some((email) => !validEmail(email))) {
      setPrivateError(`Enter ${privatePlayerCount === 2 ? "one valid email" : "five valid emails"} for the players you want to invite.`);
      return;
    }
    if (new Set(normalized).size !== normalized.length) {
      setPrivateError("Each invited player needs a different email address.");
      return;
    }
    if (normalized.includes(player.email.trim().toLowerCase())) {
      setPrivateError("You are already the table creator, so use another player's email.");
      return;
    }
    setPrivateAction("create");
    try {
      const { room } = await api.createPrivateMatch(privatePlayerCount, normalized);
      setCreatedRooms((current) => mergeByRoomCode(current, [room]));
      setInviteEmails(Array.from({ length: privatePlayerCount - 1 }, () => ""));
      setPrivateNotice("Private table created. Waiting for invited players.");
      onOpenPrivateRoom(room);
    } catch (reason) {
      setPrivateError(reason instanceof Error ? reason.message : "Could not create the private table.");
    } finally {
      setPrivateAction(null);
    }
  };

  const openPrivateRoom = async (roomCode: string, accept: boolean) => {
    setPrivateAction(roomCode);
    setPrivateError("");
    setPrivateNotice("");
    try {
      const { room } = accept ? await api.acceptPrivateMatch(roomCode) : await api.privateMatch(roomCode);
      setInvitations((current) => current.map((invitation) =>
        invitation.roomCode === roomCode ? { ...invitation, status: "accepted" } : invitation
      ));
      onOpenPrivateRoom(room);
    } catch (reason) {
      setPrivateError(reason instanceof Error ? reason.message : "Could not open the private table.");
    } finally {
      setPrivateAction(null);
    }
  };

  const visibleInvitations = useMemo(
    () => [...invitations].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [invitations]
  );
  const visibleCreatedRooms = useMemo(
    () => createdRooms.filter(({ status }) => status === "waiting" || status === "active"),
    [createdRooms]
  );
  const hasOpenPrivateCommitment = visibleCreatedRooms.length > 0
    || visibleInvitations.some(({ status }) => status === "accepted");

  return <main id="main-content" className="lobby-shell">
    <header className="app-header">
      <a className="wordmark" href="/" aria-label="TrinityMatrix home"><span>TM</span> TrinityMatrix</a>
      <nav className="player-nav" aria-label="Player navigation">
        {(["play", "rankings", "history"] as const).map((item) => <button type="button" key={item} className={section === item ? "active" : ""} aria-current={section === item ? "page" : undefined} onClick={() => onSectionChange(item)}>
          {item === "play" ? "Play" : item === "rankings" ? "Rankings" : "History"}
        </button>)}
      </nav>
      <button type="button" className="profile-chip profile-button" aria-label={`Open profile for ${player.displayName}`} onClick={() => setProfileOpen(true)}>
        <span className="profile-badge" aria-hidden="true">{badge.symbol}</span>
        <span>{player.displayName}<small>{badge.label}</small></span>
      </button>
      <button className="text-button" onClick={onLogout}>Sign out</button>
    </header>
    {section === "play" && <>
      {visibleInvitations.length > 0 && <section className="private-overview" aria-labelledby="private-invitations-title">
        <div className="section-heading">
          <div><span className="eyebrow">Invitations</span><h2 id="private-invitations-title">Private tables waiting for you</h2></div>
          <span className="status-pill">{visibleInvitations.filter(({ status }) => status === "pending").length} new</span>
        </div>
        <ul className="private-room-cards">
          {visibleInvitations.map((invitation) => <li key={invitation.roomCode}>
            <div><strong>{invitation.creatorDisplayName}</strong><span>{invitation.playerCount}-player private table · Unranked</span><small>{formatDate(invitation.createdAt)}</small></div>
            <button type="button" className={invitation.status === "pending" ? "primary" : "secondary"} disabled={privateAction !== null} onClick={() => void openPrivateRoom(invitation.roomCode, invitation.status === "pending")}>
              {privateAction === invitation.roomCode ? "Opening…" : invitation.status === "pending" ? "Accept invitation" : "Open waiting room"}
            </button>
          </li>)}
        </ul>
      </section>}

      <section className="lobby-intro">
        <span className="eyebrow">The 3 · 21 · 27 card game</span>
        <h1>Make every meld count.</h1>
        <p>Group all thirteen cards into same-suit or all-different-suit melds, then declare with at least one natural 21 containing no joker or wild card.</p>
      </section>

      <dl className="trinity-rule-signature lobby-rule-signature" aria-label="Trinity scoring essentials">
        <div><dt>3+</dt><dd><strong>Cards per meld</strong><span>Every total is a multiple of 3</span></dd></div>
        <div><dt>21</dt><dd><strong>Required to declare</strong><span>Natural cards only—no joker or wild</span></dd></div>
        <div><dt>27</dt><dd><strong>Maximum total</strong><span>Higher melds are invalid</span></dd></div>
      </dl>

      <div className="match-mode-switch" role="group" aria-label="Match type">
        <button type="button" className={playMode === "general" ? "active" : ""} aria-pressed={playMode === "general"} onClick={() => setPlayMode("general")}><strong>General match</strong><span>Ranked matchmaking</span></button>
        <button type="button" className={playMode === "private" ? "active" : ""} aria-pressed={playMode === "private"} onClick={() => setPlayMode("private")}><strong>Private table</strong><span>Invite-only · Unranked</span></button>
      </div>

      {privateLoading && <p className="private-load-status" role="status">Checking private invitations…</p>}
      {privateError && <p className="private-lobby-message error" role="alert">{privateError}</p>}
      {privateNotice && <p className="private-lobby-message" role="status">{privateNotice}</p>}

      {playMode === "general" ? <form className="mode-panel" onSubmit={(event) => { event.preventDefault(); onJoin(playerCount); }}>
        <div className="mode-summary"><span>Mode</span><strong>Ranking</strong></div>
        <div className="mode-summary"><span>Variant</span><strong>Points</strong></div>
        <fieldset><legend>Number of players</legend><div className="seat-grid">
          {([2, 6] as const).map((count) => <label className={`seat-option ${playerCount === count ? "selected" : ""}`} key={count}>
            <input type="radio" name="player-count" value={count} checked={playerCount === count} onChange={() => setPlayerCount(count)} />
            <span className="seat-number">{count}</span><span>{count === 2 ? "Head-to-head" : "Full table"}</span><small>{count === 2 ? "Focused and quick" : "Social and strategic"}</small>
          </label>)}
        </div></fieldset>
        <button className="primary play-button" disabled={hasOpenPrivateCommitment}>{hasOpenPrivateCommitment ? "Private table already open" : `Find a ${playerCount}-player match`}</button>
        <p className="safety-note">{hasOpenPrivateCommitment ? "Open or cancel your existing private table before joining ranked matchmaking." : "General · Ranked · Free play only · No bots · No payments"}</p>
      </form> : <form className="mode-panel private-mode-panel" noValidate onSubmit={createPrivateRoom}>
        <div className="mode-summary"><span>Mode</span><strong>Private</strong></div>
        <div className="mode-summary"><span>Rating</span><strong>Unranked</strong></div>
        <fieldset><legend>Private table size</legend><div className="seat-grid">
          {([2, 6] as const).map((count) => <label className={`seat-option ${privatePlayerCount === count ? "selected" : ""}`} key={count}>
            <input type="radio" name="private-player-count" value={count} checked={privatePlayerCount === count} onChange={() => changePrivatePlayerCount(count)} />
            <span className="seat-number">{count}</span><span>{count === 2 ? "One friend" : "Five friends"}</span><small>{count === 2 ? "You and one invited player" : "A complete six-player table"}</small>
          </label>)}
        </div></fieldset>
        <fieldset className="invite-fields" aria-describedby="invite-help">
          <legend>Invite {privatePlayerCount === 2 ? "1 player" : "5 players"} by email</legend>
          <p id="invite-help">Every invited player must sign in with the exact email entered here.</p>
          <div>{inviteEmails.map((email, index) => <label key={index} htmlFor={`private-invite-${index}`}>
            Invite {index + 1} email
            <input id={`private-invite-${index}`} type="email" inputMode="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => {
              const value = event.target.value;
              setInviteEmails((current) => current.map((entry, entryIndex) => entryIndex === index ? value : entry));
              setPrivateError(""); setPrivateNotice("");
            }} />
          </label>)}</div>
        </fieldset>
        <button className="primary play-button" disabled={privateAction !== null}>{privateAction === "create" ? "Creating table…" : `Create ${privatePlayerCount}-player private table`}</button>
        <p className="safety-note">Private · Unranked · Invite-only · Free play</p>
      </form>}

      {playMode === "private" && visibleCreatedRooms.length > 0 && <section className="private-overview created-private-rooms" aria-labelledby="created-private-title">
        <div className="section-heading"><div><span className="eyebrow">Your tables</span><h2 id="created-private-title">Open private waiting rooms</h2></div></div>
        <ul className="private-room-cards">{visibleCreatedRooms.map((room) => <li key={room.roomCode}>
          <div><strong>{room.playerCount}-player table</strong><span>{room.acceptedCount} of {room.requiredCount} ready</span><small>{room.roomCode}</small></div>
          <button type="button" className="secondary" disabled={privateAction !== null} onClick={() => void openPrivateRoom(room.roomCode, false)}>{privateAction === room.roomCode ? "Opening…" : "Open waiting room"}</button>
        </li>)}</ul>
      </section>}
    </>}
    {section === "rankings" && <RankingsView playerId={player.id} />}
    {section === "history" && <MatchHistoryView player={player} initialGameName={openGameName} onArchiveClosed={onArchiveClosed} realtimeMessages={realtimeChatMessages} connectionGeneration={connectionGeneration} />}
    <PolicyFooter compact />
    {profileOpen && <ProfileDialog player={player} onClose={() => setProfileOpen(false)} onSave={onUpdateProfile} />}
  </main>;
}
