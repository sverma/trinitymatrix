import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PlayerCount } from "@trinitymatrix/protocol";
import { api, type AiPlayerRoster } from "../api";
import { BroadcastConsent } from "./BroadcastConsent";

export function AiPlayers({ connected, privateTableOpen }: { connected: boolean; privateTableOpen: boolean }) {
  const [roster, setRoster] = useState<AiPlayerRoster | null>(null);
  const [playerCount, setPlayerCount] = useState<PlayerCount>(2);
  const [selected, setSelected] = useState<string[]>([]);
  const [broadcast, setBroadcast] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [created, setCreated] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const startPending = useRef(false);
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
      if (!Array.isArray(response.players) || typeof response.enabled !== "boolean") {
        throw new Error("The AI player list was incomplete. Please retry.");
      }
      setRoster(response);
      const available = new Set(response.players.filter((agent) => agent.available).map((agent) => agent.id));
      setSelected((current) => current.filter((id) => available.has(id)));
      setError("");
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load AI players.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [refresh]);

  const required = playerCount - 1;
  const availableCount = roster?.players.filter((agent) => agent.available).length ?? 0;
  const canStart = connected && !privateTableOpen && roster?.enabled && selected.length === required
    && !starting && !created && !loading;

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!canStart || startPending.current) return;
    startPending.current = true;
    setStarting(true);
    setError("");
    try {
      const result = await api.startAiMatch(selected, broadcast);
      if (!result || typeof result.gameId !== "string" || !result.gameId) {
        throw new Error("The AI table response was incomplete. Reconnect before trying again.");
      }
      if (alive.current) setCreated(true);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "Could not start the AI table.");
    } finally {
      startPending.current = false;
      if (alive.current) setStarting(false);
    }
  };

  return <form className="mode-panel ai-mode-panel" onSubmit={start} aria-labelledby="ai-players-title">
    <div className="ai-intro">
      <span className="eyebrow">Model-backed opponents</span>
      <h2 id="ai-players-title">Choose your AI players</h2>
      <p>Each player has a persistent identity tied to the model shown below. Your results here count toward mixed-match ratings.</p>
      <button type="button" className="secondary" disabled={loading || starting || created} onClick={() => setRefresh((value) => value + 1)}>Refresh availability</button>
    </div>
    {loading && <p className="ai-full-width" role="status">Loading AI players…</p>}
    {error && <div className="ai-full-width error-state" role="alert"><p>{error}</p><button type="button" className="secondary" disabled={starting || created} onClick={() => setRefresh((value) => value + 1)}>Refresh AI players</button></div>}
    {!loading && roster && (!roster.enabled || roster.players.length === 0)
      ? <div className="ai-full-width empty-state"><h3>AI players are unavailable</h3><p>Model-backed opponents will appear here when the arena is ready.</p></div>
      : roster && <>
        <fieldset disabled={starting || created}>
          <legend>AI table size</legend>
          <div className="seat-grid">
            {([2, 6] as const).map((count) => <label className={`seat-option ${playerCount === count ? "selected" : ""}`} key={count}>
              <input type="radio" name="ai-player-count" value={count} checked={playerCount === count} onChange={() => { setPlayerCount(count); setSelected([]); }} />
              <span className="seat-number">{count}</span><span>{count === 2 ? "One AI opponent" : "Five AI opponents"}</span><small>{count === 2 ? "You and one model-backed player" : "You and five different AI players"}</small>
            </label>)}
          </div>
        </fieldset>
        <fieldset className="ai-roster" disabled={starting || created} aria-describedby="ai-selection-help">
          <legend>Select {required === 1 ? "one AI player" : "five AI players"}</legend>
          <p id="ai-selection-help">{selected.length} of {required} selected. Unavailable players cannot join a new table.</p>
          <div className="ai-player-grid">
            {roster.players.map((agent) => {
              const checked = selected.includes(agent.id);
              return <label key={agent.id} className={`ai-player-option ${checked ? "selected" : ""} ${!agent.available ? "unavailable" : ""}`}>
                <input type={required === 1 ? "radio" : "checkbox"} name="ai-opponent" aria-label={`Select ${agent.displayName}`} checked={checked}
                  disabled={!agent.available || (required > 1 && !checked && selected.length >= required)}
                  onChange={() => setSelected((current) => required === 1 ? [agent.id] : checked ? current.filter((id) => id !== agent.id) : [...current, agent.id])} />
                <span className="ai-player-label">AI player</span>
                <strong>{agent.displayName}</strong>
                <span>{agent.modelName}</span>
                <code>{agent.modelId}</code>
                <small>{agent.rating} mixed rating · {agent.wins} wins · {agent.gamesPlayed} games</small>
                <span className="ai-availability">{agent.available ? "Available" : agent.reason || "Currently unavailable"}</span>
              </label>;
            })}
          </div>
          {availableCount < required && <p className="ai-roster-note" role="status">This table needs {required} available AI {required === 1 ? "player" : "players"}; {availableCount} currently available.</p>}
        </fieldset>
        <BroadcastConsent checked={broadcast} onChange={setBroadcast} />
        {created && <p className="ai-full-width" role="status">AI table created. Opening your game…</p>}
        <button className="primary play-button" disabled={!canStart}>{starting ? "Starting AI table…" : created ? "Opening AI table…" : `Play against ${required === 1 ? "selected AI" : "selected AIs"}`}</button>
        <p className="safety-note">{privateTableOpen ? "Open or cancel your existing private table before starting an AI match." : !connected ? "Waiting for your game connection…" : "Mixed matches · Ranked · AI players are labelled at the table"}</p>
      </>}
    {roster && Number.isFinite(roster.dailyBudgetUsd) && <p className="safety-note">The arena shares a ${roster.dailyBudgetUsd.toFixed(2)} daily AI spending limit. Player availability depends on the remaining budget.</p>}
  </form>;
}
