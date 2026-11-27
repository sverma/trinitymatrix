import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ActivityEvent, ActivityFilters, ActivityOverview, ActivitySession, ActivityUser } from "@trinitymatrix/protocol";
import { activityApi, type ActivityEventKind, type ActivityPageResult } from "../activity-api";
import { HttpApiError } from "../api";
import "./AdminActivity.css";

type Preset = "24h" | "7d" | "30d" | "custom";
type ActorKind = ActivityFilters["actorKind"];
type DailyMetric = "signIns" | "activeSeconds" | "matches" | "interactions";
const refreshIntervalMs = 15_000;
const dayMs = 86_400_000;
const emptyPage = <T,>(): ActivityPageResult<T> => ({ items: [], nextCursor: null });

export function activityDuration(seconds: number) {
  if (seconds < 1) return "0m";
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function when(value: string | null | undefined) {
  if (!value) return "Not observed";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not observed" : date.toLocaleString();
}

function label(value: string) {
  const labels: Record<string, string> = {
    "auth.login": "Signed in", "auth.sign-in": "Signed in", "auth.logout": "Signed out", "login": "Signed in", "logout": "Signed out",
    "page.view": "Viewed page", "match.won": "Won a match", "match.lost": "Lost a match", "match.dropped": "Dropped a match",
    "game.draw": "Drew a card", "game.discard": "Discarded a card", "game.declare": "Attempted declaration",
    "queue.join": "Joined queue", "queue.leave": "Left queue", "cards.group": "Grouped cards", "cards.sort": "Sorted cards"
  };
  return labels[value] ?? value.replace(/[._-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function localInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="admin-card activity-error" role="alert"><h2>Activity unavailable</h2><p>{message}</p>{onRetry && <button type="button" className="secondary" onClick={onRetry}>Try again</button>}</div>;
}

function DailyChart({ rows }: { rows: ActivityOverview["daily"] }) {
  const [metric, setMetric] = useState<DailyMetric>("signIns");
  const metricLabels: Record<DailyMetric, string> = { signIns: "Sign-ins", activeSeconds: "Estimated active time", matches: "Completed matches", interactions: "Interactions" };
  const maximum = Math.max(1, ...rows.map((row) => row[metric]));
  const hasData = rows.some((row) => row[metric] > 0);
  return <article className="admin-card activity-chart-card">
    <div className="activity-card-heading"><div><h2>Daily activity</h2><p>UTC calendar days</p></div>
      <label className="activity-chart-control">Daily metric<select value={metric} onChange={(event) => setMetric(event.target.value as DailyMetric)}>{Object.entries(metricLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    </div>
    {!hasData ? <p className="activity-empty">No {metricLabels[metric].toLowerCase()} recorded in this window.</p> : <div className="activity-chart-scroll activity-scroll-region" tabIndex={0} role="region" aria-label="Daily activity chart, scroll horizontally">
      <div className="activity-bars" style={{ gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(2.3rem, 1fr))` }} aria-hidden="true">{rows.map((row) => {
        const date = new Date(`${row.date}T00:00:00Z`);
        const day = Number.isNaN(date.getTime()) ? row.date : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
        const count = metric === "activeSeconds" ? activityDuration(row[metric]) : row[metric].toLocaleString();
        return <div className="activity-bar-column" key={row.date} title={`${row.date}: ${count}`}><span className="activity-bar-value">{count}</span><div className="activity-bar-track"><span style={{ height: `${Math.max(2, row[metric] / maximum * 100)}%` }} /></div><span className="activity-bar-date">{day}</span></div>;
      })}</div>
    </div>}
    <div className="visually-hidden"><table><caption>Daily activity in UTC</caption><thead><tr><th scope="col">Date</th><th scope="col">Sign-ins</th><th scope="col">Estimated active time</th><th scope="col">Completed matches</th><th scope="col">Interactions</th></tr></thead><tbody>{rows.map((row) => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.signIns}</td><td>{activityDuration(row.activeSeconds)}</td><td>{row.matches}</td><td>{row.interactions}</td></tr>)}</tbody></table></div>
  </article>;
}

function Breakdown({ overview }: { overview: ActivityOverview }) {
  return <div className="activity-breakdown-grid">
    <article className="admin-card"><h2>Pages and active time</h2>{overview.pages.length === 0 ? <p className="activity-empty">No page activity recorded.</p> : <ul className="activity-breakdown">{overview.pages.map((page) => <li key={page.page}><div><strong>{label(page.page)}</strong><small>{page.views.toLocaleString()} views</small></div><span>{activityDuration(page.activeSeconds)}</span></li>)}</ul>}</article>
    <article className="admin-card"><h2>Interaction breakdown</h2>{overview.actions.length === 0 ? <p className="activity-empty">No interactions recorded.</p> : <ul className="activity-breakdown">{overview.actions.map((action) => <li key={`${action.source}-${action.action}`}><div><strong>{label(action.action)}</strong><small>{action.source === "server" ? "Server verified" : "Browser reported"}</small></div><span>{action.count.toLocaleString()}</span></li>)}</ul>}</article>
  </div>;
}

function PeopleTable({ page, selected, onSelect, onMore, busy, error }: { page: ActivityPageResult<ActivityUser>; selected: string | undefined; onSelect: (person: ActivityUser) => void; onMore: () => void; busy: boolean; error: string }) {
  return <article className="admin-card activity-people">
    <div className="activity-card-heading"><div><h2>People and AI players</h2><p>Outcomes use completed game records. Dropped results are shown separately from losses.</p></div><span className="status-pill">{page.items.length.toLocaleString()} shown</span></div>
    {page.items.length === 0 ? <p className="activity-empty">No players match this activity window and filters.</p> : <div className="table-scroll activity-scroll-region" tabIndex={0} role="region" aria-label="Player activity table, scroll horizontally"><table className="data-table admin-table"><caption>Player activity in the selected window</caption><thead><tr><th scope="col">Player</th><th scope="col">Last seen</th><th scope="col">Sign-ins</th><th scope="col">Estimated active</th><th scope="col">Matches</th><th scope="col">Won</th><th scope="col">Lost</th><th scope="col">Dropped</th><th scope="col">Details</th></tr></thead><tbody>{page.items.map((person) => <tr key={person.userId} className={person.userId === selected ? "activity-selected-row" : undefined}>
      <th scope="row"><strong>{person.displayName}</strong><small className="activity-person-meta">{person.actorKind === "ai" ? "AI player" : person.email}</small></th>
      <td><span>{when(person.lastSeenAt)}</span><small className={`activity-presence activity-presence-${person.status}`}>{person.status === "active" ? "Recently active" : person.status === "idle" ? "Recently seen" : "No recent signal"}</small></td>
      <td>{person.actorKind === "ai" ? "—" : person.signIns.toLocaleString()}</td><td>{person.actorKind === "ai" ? "—" : activityDuration(person.activeSeconds)}</td><td>{person.matches.toLocaleString()}</td><td className="activity-win">{person.wins.toLocaleString()}</td><td>{person.losses.toLocaleString()}</td><td>{person.drops.toLocaleString()}</td>
      <td><button type="button" className="secondary compact" onClick={() => onSelect(person)} aria-label={`Inspect activity for ${person.displayName}`}>Inspect</button></td>
    </tr>)}</tbody></table></div>}
    {error && <p role="alert" className="activity-inline-error">{error}</p>}
    {page.nextCursor && <button type="button" className="secondary activity-load-more" disabled={busy} onClick={onMore}>{busy ? "Loading players…" : "Load more players"}</button>}
  </article>;
}

function SessionTable({ page, busy, error, onMore }: { page: ActivityPageResult<ActivitySession>; busy: boolean; error: string; onMore: () => void }) {
  return <article className="admin-card"><h2>Browser sessions</h2><p className="activity-muted">Time is limited to the selected activity window. Sessions resumed from before tracking began show their first observed time, not an inferred sign-in. Session credentials are never displayed.</p>
    {page.items.length === 0 ? <p className="activity-empty">No browser sessions recorded for this player in this window.</p> : <div className="table-scroll activity-scroll-region" tabIndex={0} role="region" aria-label="Browser sessions table, scroll horizontally"><table className="data-table admin-table"><caption>Recorded browser sessions</caption><thead><tr><th scope="col">Sign-in / first observed</th><th scope="col">Last seen</th><th scope="col">Status</th><th scope="col">Estimated active</th><th scope="col">Last page</th></tr></thead><tbody>{page.items.map((session) => <tr key={session.id}><td>{when(session.signedInAt ?? session.startedAt)}{!session.signedInAt && <small className="activity-person-meta">First observed · resumed session</small>}</td><td>{when(session.lastSeenAt)}</td><td>{session.endedAt ? `Signed out ${when(session.endedAt)}` : session.expiresAt && Date.parse(session.expiresAt) <= Date.now() ? "Expired" : "No sign-out recorded"}</td><td>{activityDuration(session.activeSeconds)}</td><td>{session.lastPage ? label(session.lastPage) : "—"}</td></tr>)}</tbody></table></div>}
    {error && <p role="alert" className="activity-inline-error">{error}</p>}{page.nextCursor && <button className="secondary activity-load-more" type="button" disabled={busy} onClick={onMore}>{busy ? "Loading sessions…" : "Load more sessions"}</button>}
  </article>;
}

function Timeline({ page, kind, onKind, onMore, busy, error }: { page: ActivityPageResult<ActivityEvent>; kind: ActivityEventKind; onKind: (kind: ActivityEventKind) => void; onMore: () => void; busy: boolean; error: string }) {
  return <article className="admin-card activity-timeline"><div className="activity-card-heading"><div><h2>Activity timeline</h2><p>Authentication and match results are verified by the server. UI interactions are browser reports.</p></div><label>Event category<select value={kind} onChange={(event) => onKind(event.target.value as ActivityEventKind)}><option value="all">All events</option><option value="auth">Sign-ins and sign-outs</option><option value="match">Match activity</option><option value="interaction">Interactions</option></select></label></div>
    {page.items.length === 0 ? <p className="activity-empty">No events match these filters.</p> : <ol className="activity-event-list">{page.items.map((event) => <li key={event.id}><div className="activity-event-top"><strong>{event.displayName}</strong><time dateTime={event.occurredAt}>{when(event.occurredAt)}</time></div><p>{label(event.action)}{event.gameName && <> · <span className="activity-game-name">{event.gameName}</span></>}{event.page && <> · {label(event.page)}</>}</p><div className="activity-event-tags"><span className={`activity-source activity-source-${event.source}`}>{event.source === "server" ? "Server verified" : "Browser reported"}</span><span>{event.actorKind === "ai" ? "AI player" : "Human"}</span>{event.outcome && <span className={`activity-outcome activity-outcome-${event.outcome}`}>{label(event.outcome)}</span>}</div></li>)}</ol>}
    {error && <p role="alert" className="activity-inline-error">{error}</p>}{page.nextCursor && <button type="button" className="secondary activity-load-more" disabled={busy} onClick={onMore}>{busy ? "Loading events…" : "Load more events"}</button>}
  </article>;
}

export function AdminActivity() {
  const [preset, setPreset] = useState<Preset>("7d");
  const [actorKind, setActorKind] = useState<ActorKind>("all");
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [customFrom, setCustomFrom] = useState(() => localInput(new Date(Date.now() - 7 * dayMs)));
  const [customTo, setCustomTo] = useState(() => localInput(new Date()));
  const [customRange, setCustomRange] = useState<{ from: string; to: string } | null>(null);
  const [filterError, setFilterError] = useState("");
  const [selectedUser, setSelectedUser] = useState<ActivityUser | null>(null);
  const [kind, setKind] = useState<ActivityEventKind>("all");
  const [refresh, setRefresh] = useState(0);
  const [overview, setOverview] = useState<ActivityOverview | null>(null);
  const [users, setUsers] = useState(emptyPage<ActivityUser>);
  const [events, setEvents] = useState(emptyPage<ActivityEvent>);
  const [sessions, setSessions] = useState(emptyPage<ActivitySession>);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [paginationError, setPaginationError] = useState({ users: "", events: "", sessions: "" });
  const [loadingMore, setLoadingMore] = useState<"users" | "events" | "sessions" | null>(null);
  const [olderPages, setOlderPages] = useState(false);
  const [appliedFilters, setAppliedFilters] = useState<ActivityFilters | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const lastScope = useRef("");
  const autoAllowed = !olderPages && preset !== "custom";

  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    const scope = JSON.stringify([preset, customRange, actorKind, query, selectedUser?.userId, kind]);
    const changedScope = scope !== lastScope.current;
    lastScope.current = scope;
    const now = Date.now();
    const window = preset === "custom" && customRange ? customRange : { from: new Date(now - (preset === "24h" ? dayMs : preset === "30d" ? 30 * dayMs : 7 * dayMs)).toISOString(), to: new Date(now).toISOString() };
    const filters: ActivityFilters = { ...window, actorKind, ...(selectedUser ? { userId: selectedUser.userId } : query ? { q: query } : {}) };
    inFlight.current = true;
    if (changedScope) { setOverview(null); setUsers(emptyPage()); setEvents(emptyPage()); setSessions(emptyPage()); }
    setLoading(true); setError(""); setRefreshError(""); setOlderPages(false); setLoadingMore(null);
    setPaginationError({ users: "", events: "", sessions: "" });
    Promise.all([
      activityApi.overview(filters, controller.signal), activityApi.users(filters, undefined, controller.signal),
      activityApi.events(filters, kind, undefined, controller.signal),
      selectedUser ? activityApi.sessions(filters, undefined, controller.signal) : Promise.resolve(emptyPage<ActivitySession>())
    ]).then(([nextOverview, nextUsers, nextEvents, nextSessions]) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setOverview(nextOverview); setUsers(nextUsers); setEvents(nextEvents); setSessions(nextSessions); setAppliedFilters(filters);
    }).catch((cause) => {
      if (controller.signal.aborted || current !== generation.current) return;
      const message = cause instanceof Error ? cause.message : "Could not load activity.";
      if (cause instanceof HttpApiError && (cause.status === 401 || cause.status === 403)) {
        setOverview(null); setUsers(emptyPage()); setEvents(emptyPage()); setSessions(emptyPage()); setError(message);
      } else if (!changedScope && overview) setRefreshError(message); else setError(message);
    }).finally(() => {
      if (current === generation.current) { inFlight.current = false; setLoading(false); }
    });
    return () => controller.abort();
    // Each request owns a generation and fixed range; stale results cannot mix filters.
  }, [preset, customRange, actorKind, query, selectedUser?.userId, kind, refresh]);

  useEffect(() => {
    const next = () => {
      if (autoAllowed && !inFlight.current && document.visibilityState === "visible" && navigator.onLine !== false) setRefresh((value) => value + 1);
    };
    const timer = window.setInterval(next, refreshIntervalMs);
    document.addEventListener("visibilitychange", next); window.addEventListener("online", next);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", next); window.removeEventListener("online", next); };
  }, [autoAllowed]);

  const reload = () => { setOlderPages(false); setRefresh((value) => value + 1); };
  const applyCustom = (event: FormEvent) => {
    event.preventDefault();
    const from = new Date(customFrom).getTime(); const to = new Date(customTo).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 90 * dayMs || to > Date.now() + 60_000) {
      setFilterError("Choose a valid start and end, no more than 90 days apart, ending no later than now."); return;
    }
    setFilterError(""); setPreset("custom"); setCustomRange({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  };
  const search = (event: FormEvent) => { event.preventDefault(); setSelectedUser(null); setQuery(searchInput.trim()); };
  const inspect = (person: ActivityUser) => { setSelectedUser(person); setSearchInput(""); setQuery(""); setKind("all"); };
  const more = async (target: "users" | "events" | "sessions") => {
    if (!appliedFilters || loadingMore || inFlight.current) return;
    const cursor = target === "users" ? users.nextCursor : target === "events" ? events.nextCursor : sessions.nextCursor;
    if (!cursor) return;
    const current = generation.current;
    inFlight.current = true;
    setOlderPages(true); setLoadingMore(target); setPaginationError((value) => ({ ...value, [target]: "" }));
    try {
      if (target === "users") { const page = await activityApi.users(appliedFilters, cursor); if (current === generation.current) setUsers((value) => ({ items: [...value.items, ...page.items], nextCursor: page.nextCursor })); }
      else if (target === "events") { const page = await activityApi.events(appliedFilters, kind, cursor); if (current === generation.current) setEvents((value) => ({ items: [...value.items, ...page.items], nextCursor: page.nextCursor })); }
      else { const page = await activityApi.sessions(appliedFilters, cursor); if (current === generation.current) setSessions((value) => ({ items: [...value.items, ...page.items], nextCursor: page.nextCursor })); }
    } catch (cause) {
      if (current !== generation.current) return;
      if (cause instanceof HttpApiError && (cause.status === 401 || cause.status === 403)) {
        setOverview(null); setUsers(emptyPage()); setEvents(emptyPage()); setSessions(emptyPage()); setAppliedFilters(null); setError(cause.message);
      } else setPaginationError((value) => ({ ...value, [target]: cause instanceof Error ? cause.message : "Could not load the next page." }));
    }
    finally { if (current === generation.current) { setLoadingMore(null); inFlight.current = false; } }
  };

  const summary = overview?.summary;
  const metrics: Array<[string, string]> = summary ? [
    ["Successful sign-ins", summary.signIns.toLocaleString()], ["Unique users", summary.uniqueUsers.toLocaleString()],
    ["Recently active", summary.activeUsers.toLocaleString()], ["Estimated active time", activityDuration(summary.activeSeconds)],
    ["Completed matches", summary.matches.toLocaleString()], ["Interactions", summary.interactions.toLocaleString()]
  ] : [];
  return <section className="admin-activity" aria-labelledby="activity-title">
    <div className="section-heading admin-heading"><div><span className="eyebrow">Platform insights</span><h1 id="activity-title">Activity</h1><p>Sign-ins, match outcomes and how people use TrinityMatrix.</p></div><div className="activity-live-status"><span className="status-pill">{loading ? "Updating…" : autoAllowed ? "Auto-refresh · 15 seconds" : olderPages ? "Refresh paused · older pages" : "Fixed custom window"}</span><button type="button" className="secondary compact" disabled={loading} onClick={reload}>Refresh activity</button></div></div>
    <div className="admin-card activity-filters">
      <div className="activity-window-buttons" role="group" aria-label="Activity time window">{(["24h", "7d", "30d", "custom"] as const).map((value) => <button type="button" key={value} className={preset === value ? "primary compact" : "secondary compact"} aria-pressed={preset === value} onClick={() => {
        setFilterError("");
        if (value === "custom") {
          setPreset("custom");
          const from = Date.parse(customFrom); const to = Date.parse(customTo);
          if (Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= 90 * dayMs && to <= Date.now() + 60_000) setCustomRange({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
          else setFilterError("Choose valid start and end dates, no more than 90 days apart.");
        } else setPreset(value);
      }}>{value === "24h" ? "24 hours" : value === "7d" ? "7 days" : value === "30d" ? "30 days" : "Custom dates"}</button>)}</div>
      <div className="activity-filter-fields"><label>Player type<select value={actorKind} onChange={(event) => { setActorKind(event.target.value as ActorKind); setSelectedUser(null); }}><option value="all">Humans and AI</option><option value="human">Humans only</option><option value="ai">AI only</option></select></label><form role="search" aria-label="Search activity players" onSubmit={search}><label htmlFor="activity-search">Name or email</label><div className="activity-search-row"><input id="activity-search" type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search players" autoComplete="off"/><button className="secondary compact" type="submit">Search activity</button>{query && <button type="button" className="text-button" onClick={() => { setQuery(""); setSearchInput(""); }}>Clear search</button>}</div></form></div>
      {preset === "custom" && <form className="activity-custom-range" onSubmit={applyCustom}><label>From (local time)<input type="datetime-local" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} required /></label><label>To (local time)<input type="datetime-local" value={customTo} onChange={(event) => setCustomTo(event.target.value)} required /></label><button type="submit" className="secondary compact">Apply dates</button></form>}
      {filterError && <p role="alert" className="activity-inline-error">{filterError}</p>}
    </div>
    {selectedUser && overview && !error && <div className="activity-selected-banner"><div><span className="eyebrow">Inspecting player</span><strong>{selectedUser.displayName}</strong><span>{selectedUser.actorKind === "ai" ? "AI player · game activity only" : selectedUser.email}</span></div><button type="button" className="secondary compact" onClick={() => setSelectedUser(null)}>Show all players</button></div>}
    {error ? <ErrorCard message={error} onRetry={reload}/> : !overview ? <div className="admin-card loading-inline" role="status">Loading activity…</div> : <>
      {refreshError && <div className="activity-refresh-error" role="alert"><p>Could not refresh activity: {refreshError}. The last successful results remain visible.</p><button type="button" className="secondary compact" onClick={reload}>Retry refresh</button></div>}
      <p className="activity-range">{when(overview.from)} — {when(overview.to)} <span>· Updated {when(overview.generatedAt)}</span></p>
      <div className="metric-grid activity-metrics">{metrics.map(([name, value]) => <article className="metric-card" key={name}><span>{name}</span><strong>{value}</strong></article>)}</div>
      {summary && <div className="activity-outcome-summary" aria-label="Recorded participant outcomes"><span className="activity-win">Won <strong>{summary.wins.toLocaleString()}</strong></span><span>Lost <strong>{summary.losses.toLocaleString()}</strong></span><span>Dropped <strong>{summary.drops.toLocaleString()}</strong></span></div>}
      <div className="activity-collection-note"><strong>How to read these numbers</strong><p>Sign-in and browsing telemetry starts {when(overview.trackingSince)} and is retained for {overview.retentionDays} days. Earlier match outcomes can still appear from game history. Active time is a server-bounded estimate from visible, recently active browser samples; it excludes long idle gaps and does not add simultaneous tabs together. AI players do not have browser sign-ins or active-time estimates.</p></div>
      <DailyChart rows={overview.daily}/><Breakdown overview={overview}/>
      <PeopleTable page={users} selected={selectedUser?.userId} onSelect={inspect} onMore={() => void more("users")} busy={loadingMore === "users"} error={paginationError.users}/>
      {selectedUser && selectedUser.actorKind === "human" && <SessionTable page={sessions} busy={loadingMore === "sessions"} error={paginationError.sessions} onMore={() => void more("sessions")}/>}
      <Timeline page={events} kind={kind} onKind={setKind} onMore={() => void more("events")} busy={loadingMore === "events"} error={paginationError.events}/>
    </>}
  </section>;
}
