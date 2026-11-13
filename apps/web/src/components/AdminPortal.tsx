import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  type AuthPlayer,
  type AdminGame,
  type AdminGameDetail,
  type AdminOverview,
  type AdminUser
} from "../api";
import { AuthFlow } from "./AuthFlow";
import { AdminPasskeyGate } from "./AdminPasskeyGate";
import { AdminAiArena } from "./AdminAiArena";

type AdminSection = "overview" | "users" | "games" | "ai";
type MatchTypeFilter = "all" | "general" | "private";
type GameStatusFilter = "all" | AdminGame["status"];
const liveRefreshIntervalMs = 15_000;

const adminHostnames = new Set(["admin.staging.trinitymatrix.com", "admin.trinitymatrix.com"]);
export function isAdminLocation(location: Pick<Location, "hostname" | "pathname">) {
  return adminHostnames.has(location.hostname.toLowerCase())
    || /^\/admin(?:\/|$)/.test(location.pathname);
}

function formatDate(value?: number | string) {
  if (value === undefined) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function collection<K extends string, T>(response: T[] | Record<K, T[]>, key: K): T[] {
  return Array.isArray(response) ? response : response[key];
}

function matchTypeOf(game: AdminGame) {
  return game.matchType ?? "general";
}

function matchTypeLabel(game: AdminGame) {
  return matchTypeOf(game) === "private" ? "Private room" : "General match";
}

function statusLabel(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function installLiveRefresh(refresh: () => void) {
  let timer: number | null = null;
  const canRefresh = () => document.visibilityState === "visible" && navigator.onLine !== false;
  const stopTimer = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const refreshAndRestart = () => {
    stopTimer();
    if (!canRefresh()) return;
    refresh();
    timer = window.setInterval(() => {
      if (!canRefresh()) {
        stopTimer();
        return;
      }
      refresh();
    }, liveRefreshIntervalMs);
  };

  document.addEventListener("visibilitychange", refreshAndRestart);
  window.addEventListener("focus", refreshAndRestart);
  window.addEventListener("online", refreshAndRestart);
  window.addEventListener("offline", refreshAndRestart);
  refreshAndRestart();

  return () => {
    stopTimer();
    document.removeEventListener("visibilitychange", refreshAndRestart);
    window.removeEventListener("focus", refreshAndRestart);
    window.removeEventListener("online", refreshAndRestart);
    window.removeEventListener("offline", refreshAndRestart);
  };
}

function OverviewView() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let requestInFlight = false;
    let hasLoaded = false;
    const refresh = async () => {
      if (!active || requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await api.adminOverview();
        if (!active) return;
        hasLoaded = true;
        setError("");
        setOverview("overview" in response ? response.overview : response);
      } catch (reason) {
        if (active && !hasLoaded) setError(reason instanceof Error ? reason.message : "Could not load the admin overview.");
      } finally {
        requestInFlight = false;
      }
    };
    const uninstall = installLiveRefresh(() => { void refresh(); });
    return () => {
      active = false;
      uninstall();
    };
  }, []);

  if (error) return <div className="admin-card error-state" role="alert"><h2>Overview unavailable</h2><p>{error}</p></div>;
  if (!overview) return <div className="admin-card loading-inline" role="status">Loading overview…</div>;
  const metrics = [
    ["Registered users", overview.totalUsers],
    ["All games", overview.totalGames],
    ["Running general matches", overview.activeGeneralMatches ?? overview.activeGames ?? 0],
    ["Running private matches", overview.activePrivateMatches ?? 0],
    ["Waiting private rooms", overview.waitingPrivateRooms ?? 0],
    ["Completed games", overview.completedGames],
    ["Chat messages", overview.totalChatMessages]
  ].filter((metric): metric is [string, number] => typeof metric[1] === "number");
  return <section aria-labelledby="overview-title">
    <div className="section-heading admin-heading"><div><span className="eyebrow">Operations</span><h1 id="overview-title">Overview</h1></div></div>
    <div className="metric-grid">{metrics.map(([label, value]) => <article className="metric-card" key={label}><span>{label}</span><strong>{value.toLocaleString()}</strong></article>)}</div>
    <div className="admin-card admin-note"><h2>Staging guardrails</h2><p>User suspensions are audited. Game records and encrypted post-game chat are inspectable; financial controls are intentionally unavailable in this release.</p></div>
  </section>;
}

function UsersView() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [paginationError, setPaginationError] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setPaginationError("");
    setUsers([]);
    setTotal(0);
    setNextCursor(null);
    api.adminUsers({ ...(query ? { q: query } : {}), limit: 25 }).then((response) => {
      if (!active) return;
      setUsers(response.users);
      setTotal(response.total);
      setNextCursor(response.nextCursor);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load users.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [query]);

  const searchUsers = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput("");
    setQuery("");
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setPaginationError("");
    try {
      const response = await api.adminUsers({ ...(query ? { q: query } : {}), limit: 25, cursor: nextCursor });
      setUsers((current) => [...current, ...response.users]);
      setTotal(response.total);
      setNextCursor(response.nextCursor);
    } catch (reason) {
      setPaginationError(reason instanceof Error ? reason.message : "Could not load more users.");
    } finally {
      setLoadingMore(false);
    }
  };

  const changeSuspension = async (user: AdminUser, suspended: boolean) => {
    setActionError("");
    setSaving(true);
    try {
      const response = await api.setAdminUserSuspension(user.id, suspended, suspended ? reason.trim() : null);
      setUsers((current) => current.map((candidate) => candidate.id === user.id
        ? { ...candidate, ...response.user }
        : candidate));
      setSelectedUser(null);
      setReason("");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update this user.");
    } finally {
      setSaving(false);
    }
  };

  const resultSummary = total === 0
    ? query ? `No users match “${query}”.` : "No registered users found."
    : query
      ? `Showing ${users.length} of ${total} users matching “${query}”.`
      : `Showing ${users.length} of ${total} registered users.`;

  return <section aria-labelledby="users-title">
    <div className="section-heading admin-heading"><div><span className="eyebrow">Accounts</span><h1 id="users-title">Users</h1></div><span className="status-pill">{loading ? "Loading…" : `${total.toLocaleString()} total`}</span></div>
    <form className="admin-search-form" role="search" aria-label="Search users" onSubmit={searchUsers}>
      <label htmlFor="admin-user-search">Search by name or email</label>
      <div>
        <input id="admin-user-search" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Name or email address" autoComplete="off" />
        <button type="submit" className="primary">Search</button>
        {(query || searchInput) && <button type="button" className="secondary" onClick={clearSearch}>Clear search</button>}
      </div>
    </form>
    {!loading && <p className="admin-result-summary" role="status" aria-live="polite">{resultSummary}</p>}
    {loading ? <div className="admin-card loading-inline" role="status">Loading users…</div>
      : error ? <div className="admin-card error-state" role="alert"><h2>Users unavailable</h2><p>{error}</p></div>
      : users.length === 0 ? <div className="admin-card empty-state"><p>{query ? "Try another name or email address." : "Player accounts will appear here after registration."}</p></div>
      : <><div className="admin-card table-scroll"><table className="data-table admin-table">
        <caption>Registered player accounts</caption>
        <thead><tr><th scope="col">Player</th><th scope="col">Email</th><th scope="col">Status</th><th scope="col">Games</th><th scope="col">Wins</th><th scope="col">Joined</th><th scope="col">Last seen</th><th scope="col">Action</th></tr></thead>
        <tbody>{users.map((user) => <tr key={user.id}><th scope="row">{user.displayName}</th><td>{user.email}</td><td><span className={`admin-status status-${user.status ?? "offline"}`}>{user.status ?? "offline"}</span></td><td>{user.gamesPlayed}</td><td>{user.wins}</td><td>{formatDate(user.createdAt)}</td><td>{formatDate(user.lastSeenAt)}</td><td><button type="button" className="secondary compact" onClick={() => { setSelectedUser(user); setReason(""); setActionError(""); }}>{user.status === "disabled" ? "Restore" : "Suspend"}</button></td></tr>)}</tbody>
      </table></div>
      {paginationError && <p className="field-error admin-pagination-error" role="alert">{paginationError}</p>}
      {nextCursor && <div className="admin-pagination"><button type="button" className="secondary" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? "Loading…" : `Show ${Math.min(25, total - users.length)} more users`}</button></div>}</>}
    {selectedUser && <div className="admin-card admin-action-panel" role="region" aria-labelledby="user-action-title">
      <h2 id="user-action-title">{selectedUser.status === "disabled" ? "Restore" : "Suspend"} {selectedUser.displayName}</h2>
      {selectedUser.status !== "disabled" && <label>Reason <textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="Required audit reason" /></label>}
      {actionError && <p className="field-error" role="alert">{actionError}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={() => setSelectedUser(null)} disabled={saving}>Cancel</button>
        <button type="button" className={selectedUser.status === "disabled" ? "primary" : "danger"} disabled={saving || (selectedUser.status !== "disabled" && reason.trim().length < 3)} onClick={() => void changeSuspension(selectedUser, selectedUser.status !== "disabled")}>{saving ? "Saving…" : "Confirm"}</button>
      </div>
    </div>}
  </section>;
}

function detailFrom(response: AdminGameDetail | { detail: AdminGameDetail }) {
  return "detail" in response ? response.detail : response;
}

function GameDetail({ gameName, onBack }: { gameName: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AdminGameDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.adminGame(gameName).then((response) => {
      if (active) setDetail(detailFrom(response));
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load game details.");
    });
    return () => { active = false; };
  }, [gameName]);

  return <section aria-labelledby="admin-game-title">
    <button type="button" className="text-button back-button" onClick={onBack}>← Back to games</button>
    {error ? <div className="admin-card error-state" role="alert"><h1 id="admin-game-title">Game unavailable</h1><p>{error}</p></div>
      : !detail ? <div className="admin-card loading-inline" role="status">Loading game details…</div>
      : <>
        <div className="section-heading admin-heading"><div><span className="eyebrow">{matchTypeLabel(detail.game)}</span><h1 id="admin-game-title">{detail.game.gameName}</h1></div><span className={`admin-status status-${detail.game.status}`}>{statusLabel(detail.game.status)}</span></div>
        <div className="metric-grid compact-metrics">
          <article className="metric-card"><span>Match type</span><strong className="metric-name">{matchTypeLabel(detail.game)}</strong></article>
          <article className="metric-card"><span>Seats</span><strong>{detail.game.playerCount}</strong></article>
          <article className="metric-card"><span>Events</span><strong>{detail.events?.length ?? detail.game.eventCount ?? 0}</strong></article>
          <article className="metric-card"><span>Chat messages</span><strong>{detail.chatMessages?.length ?? detail.game.chatMessageCount ?? 0}</strong></article>
          <article className="metric-card"><span>Winner</span><strong className="metric-name">{detail.game.winnerName ?? "Pending"}</strong></article>
        </div>
        {matchTypeOf(detail.game) === "private" && <div className="admin-detail-grid" aria-label="Private room access">
          <article className="admin-card">
            <h2>Room creator</h2>
            {detail.game.creator
              ? <dl className="detail-list">
                <div><dt>Name</dt><dd>{detail.game.creator.displayName}</dd></div>
                {detail.game.creator.email && <div><dt>Email</dt><dd>{detail.game.creator.email}</dd></div>}
              </dl>
              : <p>Creator details are unavailable.</p>}
          </article>
          <article className="admin-card">
            <h2>Invitations</h2>
            {detail.game.invites?.length
              ? <ul className="plain-list" aria-label="Private room invitations">{detail.game.invites.map((invite) => <li key={invite.email}>
                <span>{invite.email}</span>{" "}
                <span className={`admin-status status-${invite.status}`}>{statusLabel(invite.status)}</span>
              </li>)}</ul>
              : <p>No invitations are recorded for this room.</p>}
          </article>
        </div>}
        <div className="admin-detail-grid">
          <article className="admin-card"><h2>Players</h2><ul className="plain-list">{detail.game.players.map((player, index) => <li key={player.playerId ?? `${player.displayName}-${index}`}>{player.displayName}</li>)}</ul></article>
          <article className="admin-card"><h2>Timeline</h2><dl className="detail-list"><div><dt>Started</dt><dd>{detail.game.status === "waiting" ? "Waiting for invited players" : formatDate(detail.game.startedAt)}</dd></div><div><dt>Finished</dt><dd>{formatDate(detail.game.finishedAt)}</dd></div></dl></article>
        </div>
        {detail.events && <article className="admin-card"><h2>Recorded events</h2><ol className="admin-event-list">{detail.events.map((event) => <li key={event.sequence}><span>#{event.sequence}</span><strong>{event.summary}</strong><small>{event.type} · {formatDate(event.at)}</small></li>)}</ol></article>}
        {detail.chatMessages && <article className="admin-card"><h2>Post-game chat</h2><ol className="admin-chat-list">{detail.chatMessages.map((message) => <li key={message.id}><strong>{message.displayName}</strong><p>{message.message}</p><time>{formatDate(message.createdAt)}</time></li>)}</ol></article>}
      </>}
  </section>;
}

function GamesView() {
  const [games, setGames] = useState<AdminGame[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [matchTypeFilter, setMatchTypeFilter] = useState<MatchTypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<GameStatusFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let requestInFlight = false;
    let hasLoaded = false;
    const refresh = async () => {
      if (!active || requestInFlight) return;
      requestInFlight = true;
      try {
        const response = await api.adminGames();
        if (!active) return;
        hasLoaded = true;
        setError("");
        setGames(collection(response, "games"));
      } catch (reason) {
        if (active && !hasLoaded) setError(reason instanceof Error ? reason.message : "Could not load games.");
      } finally {
        if (active) setLoading(false);
        requestInFlight = false;
      }
    };
    const uninstall = installLiveRefresh(() => { void refresh(); });
    return () => {
      active = false;
      uninstall();
    };
  }, []);

  if (selected) return <GameDetail gameName={selected} onBack={() => setSelected(null)} />;
  const filteredGames = games.filter((game) =>
    (matchTypeFilter === "all" || matchTypeOf(game) === matchTypeFilter)
    && (statusFilter === "all" || game.status === statusFilter)
  );
  return <section aria-labelledby="games-title">
    <div className="section-heading admin-heading"><div><span className="eyebrow">Game operations</span><h1 id="games-title">Matches and private rooms</h1></div><span className="status-pill" aria-live="polite">{filteredGames.length} of {games.length} shown</span></div>
    {loading ? <div className="admin-card loading-inline" role="status">Loading games…</div>
      : error ? <div className="admin-card error-state" role="alert"><h2>Games unavailable</h2><p>{error}</p></div>
      : <>
        <div className="admin-card" role="group" aria-labelledby="game-filters-title">
          <h2 id="game-filters-title">Filter matches</h2>
          <div className="profile-grid">
            <label htmlFor="admin-match-type-filter">Match type<select id="admin-match-type-filter" value={matchTypeFilter} onChange={(event) => setMatchTypeFilter(event.target.value as MatchTypeFilter)}>
              <option value="all">All match types</option><option value="general">General matches</option><option value="private">Private rooms</option>
            </select></label>
            <label htmlFor="admin-match-status-filter">Status<select id="admin-match-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as GameStatusFilter)}>
              <option value="all">All statuses</option><option value="waiting">Waiting</option><option value="playing">Playing</option><option value="finished">Finished</option><option value="abandoned">Abandoned</option>
            </select></label>
          </div>
        </div>
        {filteredGames.length === 0
          ? <div className="admin-card empty-state" role="status"><h2>No matches found</h2><p>Change the match type or status filter to see other activity.</p></div>
          : <div className="admin-card table-scroll"><table className="data-table admin-table">
            <caption>General matches and private rooms</caption><thead><tr><th scope="col">Match or room</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Seats</th><th scope="col">Winner</th><th scope="col">Started</th><th scope="col">Events</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
            <tbody>{filteredGames.map((game) => <tr key={game.gameName}><th scope="row">{game.gameName}</th><td><span className={`admin-status status-${matchTypeOf(game)}`}>{matchTypeLabel(game)}</span></td><td><span className={`admin-status status-${game.status}`}>{statusLabel(game.status)}</span></td><td>{game.playerCount}</td><td>{game.winnerName ?? (game.status === "waiting" ? "Waiting" : "—")}</td><td>{game.status === "waiting" ? "Not started" : formatDate(game.startedAt)}</td><td>{game.eventCount ?? "—"}</td><td><button type="button" className="secondary compact" aria-label={`Inspect ${matchTypeLabel(game).toLowerCase()} ${game.gameName}`} onClick={() => setSelected(game.gameName)}>Inspect</button></td></tr>)}</tbody>
          </table></div>}
      </>}
  </section>;
}

function AdminWorkspace({ onLogout }: { onLogout: () => Promise<void> }) {
  const [section, setSection] = useState<AdminSection>("overview");
  return <div className="admin-layout">
    <aside className="admin-sidebar">
      <a className="wordmark admin-wordmark" href="/" aria-label="TrinityMatrix admin home"><span>TM</span><span>TrinityMatrix<small>Admin portal</small></span></a>
      <nav aria-label="Admin navigation">
        {(["overview", "users", "games", "ai"] as const).map((item) => <button type="button" key={item} className={section === item ? "active" : ""} aria-current={section === item ? "page" : undefined} onClick={() => setSection(item)}>{item === "ai" ? "AI arena" : item}</button>)}
      </nav>
      <button type="button" className="text-button" onClick={() => void onLogout()}>Sign out</button>
      <p>Audited staging operations</p>
    </aside>
    <main id="main-content" className="admin-content">
      {section === "overview" && <OverviewView />}
      {section === "users" && <UsersView />}
      {section === "games" && <GamesView />}
      {section === "ai" && <AdminAiArena />}
    </main>
  </div>;
}

export function AdminPortal() {
  const [player, setPlayer] = useState<AuthPlayer | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [loading, setLoading] = useState(true);

  const refreshSession = async () => {
    const session = await api.session();
    setPlayer(session.authenticated && session.player ? session.player : null);
    setIsAdmin(session.isAdmin === true);
    setAdminUnlocked(session.adminUnlocked === true);
  };

  useEffect(() => {
    refreshSession().catch(() => undefined).finally(() => setLoading(false));
  }, []);

  if (loading) return <main id="main-content" className="loading-screen"><div className="brand-mark">TM</div><p>Checking administrator access…</p></main>;
  if (!player) return <AuthFlow onAuthenticated={() => { void refreshSession(); }} />;
  if (!isAdmin) return <main id="main-content" className="auth-page"><section className="auth-panel" aria-labelledby="admin-denied-title"><span className="eyebrow">TrinityMatrix administration</span><h1 id="admin-denied-title">Administrator access required</h1><p>This signed-in email is not on the administrator allowlist.</p><button type="button" className="primary" onClick={() => void api.logout().then(() => { setPlayer(null); setIsAdmin(false); })}>Sign in with another email</button></section></main>;
  if (!adminUnlocked) return <AdminPasskeyGate onUnlocked={refreshSession} onLogout={async () => { await api.logout(); setPlayer(null); setIsAdmin(false); setAdminUnlocked(false); }} />;
  return <AdminWorkspace onLogout={async () => { await api.logout(); setPlayer(null); setIsAdmin(false); }} />;
}
