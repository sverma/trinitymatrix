import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PlayerCount } from "@trinitymatrix/protocol";
import { api, type AiPlayerRoster } from "../api";
import { BroadcastConsent } from "./BroadcastConsent";

export function AdminAiArena() {
  const [roster, setRoster] = useState<AiPlayerRoster | null>(null);
  const [playerCount, setPlayerCount] = useState<PlayerCount>(2);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [gameId, setGameId] = useState("");
  const [broadcast, setBroadcast] = useState(false);
  const [watchName, setWatchName] = useState("");
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.aiPlayers(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(response.players) || typeof response.enabled !== "boolean") throw new Error("The AI player list was incomplete. Please retry.");
      setRoster(response);
      const available = new Set(response.players.filter((agent) => agent.available).map((agent) => agent.id));
      setSelected((current) => current.filter((id) => available.has(id)));
      setError("");
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load AI players.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [refresh]);

  const availableCount = roster?.players.filter((agent) => agent.available).length ?? 0;
  const canStart = roster?.enabled && !loading && !starting && selected.length === playerCount;
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart || pending.current) return;
    pending.current = true;
    setStarting(true);
    setError("");
    setGameId("");
    const participants = [...selected];
    try {
      const response = await api.startAdminAiMatch(participants, broadcast);
      if (!response || typeof response.gameId !== "string" || !response.gameId) throw new Error("The AI match response was incomplete. Refresh availability before retrying.");
      if (!alive.current) return;
      setGameId(response.gameId);
      setWatchName(response.gameName ?? "");
      setSelected([]);
      setRoster((current) => current ? { ...current, players: current.players.map((agent) => participants.includes(agent.id)
        ? { ...agent, available: false, reason: "Already at a table" } : agent) } : current);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Could not start the AI-only match.");
    } finally {
      pending.current = false;
      if (alive.current) setStarting(false);
    }
  };

  return <section aria-labelledby="admin-ai-title">
    <div className="section-heading admin-heading"><div><span className="eyebrow">Model competition</span><h1 id="admin-ai-title">AI arena</h1></div></div>
    <div className="admin-card admin-note"><h2>Start an AI-only ranked match</h2><p>Select the model-backed players for one match. Results count toward AI-match ratings. Games start only when you request them.</p>
      {roster && Number.isFinite(roster.dailyBudgetUsd) && <p>The arena shares a ${roster.dailyBudgetUsd.toFixed(2)} daily AI spending limit with human-versus-AI games.</p>}
      <button className="secondary" type="button" disabled={loading || starting} onClick={() => setRefresh((value) => value + 1)}>Refresh AI availability</button>
    </div>
    {loading && <p role="status">Loading AI players…</p>}
    {error && <div className="admin-card error-state" role="alert"><p>{error}</p></div>}
    {gameId && <div className="admin-card" role="status"><p>AI match started; results appear in AI matches rankings.</p><p>Game ID: <code>{gameId}</code></p>{watchName && <a className="secondary watch-live-link" href={`/watch/${watchName}`} target="_blank" rel="noreferrer">Watch this broadcast</a>}</div>}
    {!loading && roster && (!roster.enabled || roster.players.length === 0) && <div className="admin-card empty-state"><h2>AI players are unavailable</h2><p>Check the configured models, provider access and remaining budget.</p></div>}
    {roster?.enabled && roster.players.length > 0 && <form className="mode-panel ai-mode-panel admin-ai-arena" onSubmit={start}>
      <BroadcastConsent checked={broadcast} onChange={setBroadcast} />
      <fieldset disabled={starting}>
        <legend>AI-only table size</legend>
        <div className="seat-grid">{([2, 6] as const).map((count) => <label key={count} className={`seat-option ${playerCount === count ? "selected" : ""}`}>
          <input type="radio" name="admin-ai-player-count" checked={playerCount === count} onChange={() => { setPlayerCount(count); setSelected([]); }} />
          <span className="seat-number">{count}</span><span>{count}-player AI match</span><small>All seats are model-backed players</small>
        </label>)}</div>
      </fieldset>
      <fieldset className="ai-roster" disabled={starting} aria-describedby="admin-ai-selection-help">
        <legend>Select {playerCount} AI players</legend>
        <p id="admin-ai-selection-help">{selected.length} of {playerCount} selected.</p>
        <div className="ai-player-grid">{roster.players.map((agent) => {
          const checked = selected.includes(agent.id);
          return <label key={agent.id} className={`ai-player-option ${checked ? "selected" : ""} ${!agent.available ? "unavailable" : ""}`}>
            <input type="checkbox" checked={checked} aria-label={`Select ${agent.displayName}`} disabled={!agent.available || (!checked && selected.length >= playerCount)}
              onChange={() => setSelected((current) => checked ? current.filter((id) => id !== agent.id) : [...current, agent.id])} />
            <span className="ai-player-label">AI player</span><strong>{agent.displayName}</strong><span>{agent.modelName}</span><code>{agent.modelId}</code>
            <span className="ai-availability">{agent.available ? "Available" : agent.reason || "Currently unavailable"}</span>
          </label>;
        })}</div>
        {availableCount < playerCount && <p className="ai-roster-note" role="status">This table needs {playerCount} available AI players; {availableCount} currently available.</p>}
      </fieldset>
      <button className="primary play-button" disabled={!canStart}>{starting ? "Starting AI-only match…" : "Start AI-only ranked match"}</button>
    </form>}
  </section>;
}
