import { useCallback, useEffect, useRef, useState } from "react";
import { broadcastCommentSchema, broadcastFrameSchema, type BroadcastComment, type BroadcastFrame } from "@trinitymatrix/protocol";
import { api, HttpApiError, type BroadcastTimelineEntry, type LiveBroadcastDetail } from "../../api";

export function mergeComments(current: readonly BroadcastComment[], incoming: readonly BroadcastComment[]) {
  const byId = new Map(current.map((comment) => [comment.id, comment]));
  for (const comment of incoming) byId.set(comment.id, comment);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-100);
}

function mergeTimeline(current: readonly BroadcastTimelineEntry[], incoming: readonly BroadcastTimelineEntry[], older = false) {
  const byId = new Map(current.map((frame) => [frame.sequence, frame]));
  for (const frame of incoming) byId.set(frame.sequence, frame);
  const sorted = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  return older ? sorted.slice(0, 300) : sorted.slice(-300);
}

export function useLiveBroadcast(gameName: string, onAuthenticationRequired: () => void) {
  const [detail, setDetail] = useState<LiveBroadcastDetail | null>(null);
  const [frame, setFrame] = useState<BroadcastFrame | null>(null);
  const [comments, setComments] = useState<BroadcastComment[]>([]);
  const [timeline, setTimeline] = useState<BroadcastTimelineEntry[]>([]);
  const [moreTimeline, setMoreTimeline] = useState<string | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "connected" | "reconnecting" | "closed">("connecting");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [offset, setOffset] = useState(0);
  const latest = useRef<BroadcastFrame | null>(null);
  const pausedRef = useRef(false);
  const seekId = useRef(0);
  const cache = useRef(new Map<number, BroadcastFrame>());
  const alive = useRef(true);
  const generation = useRef(0);
  const earlierLoading = useRef(false);
  const reload = useRef<() => void>(() => undefined);

  const addComment = useCallback((comment: BroadcastComment) => setComments((current) => mergeComments(current, [comment])), []);
  const remember = useCallback((next: BroadcastFrame) => {
    cache.current.set(next.sequence, next);
    if (cache.current.size > 100) cache.current.delete(cache.current.keys().next().value!);
    if (!latest.current || next.sequence >= latest.current.sequence) latest.current = next;
    setTimeline((current) => mergeTimeline(current, [next]));
    if (!pausedRef.current) setFrame(latest.current);
  }, []);

  useEffect(() => {
    alive.current = true;
    generation.current += 1; earlierLoading.current = false;
    let active = true;
    let source: EventSource | null = null;
    let reloadController: AbortController | null = null;
    let timelineController: AbortController | null = null;
    let loadingDetail = false;
    let acceptedDetail = false;
    let reconnectAttempts = 0;
    let timelineInFlight = false;
    let timelineQueued = false;
    let retryTimer: number | null = null;
    const began = Date.now();
    pausedRef.current = false; latest.current = null; cache.current.clear(); seekId.current += 1;
    setLoading(true); setError(""); setDetail(null); setFrame(null); setComments([]); setTimeline([]); setMoreTimeline(null); setTimelineLoading(false); setPaused(false); setSeeking(false); setConnection("connecting");
    const loadTimeline = async () => {
      if (!active) return;
      if (timelineInFlight) { timelineQueued = true; return; }
      timelineInFlight = true; timelineController = new AbortController();
      try {
        const value = await api.broadcastTimeline(gameName, undefined, timelineController.signal);
        if (!active) return;
        setTimeline((current) => mergeTimeline(current, value.frames)); setMoreTimeline(value.nextCursor);
      } catch { /* Detail and released frames remain usable while history is retried. */ }
      finally { timelineInFlight = false; if (active && timelineQueued) { timelineQueued = false; void loadTimeline(); } }
    };
    const accept = (value: LiveBroadcastDetail) => {
      acceptedDetail = true;
      setDetail(value); setOffset(value.serverNow - Date.now());
      setComments(mergeComments([], value.comments));
      if (value.frame) remember(value.frame);
      void loadTimeline();
    };
    const reconnect = (reason: string) => {
      if (!active || retryTimer !== null) return;
      setConnection("reconnecting"); setError(reason);
      if (reconnectAttempts >= 8) { setError(`${reason} Automatic retries paused. Refresh the broadcast to try again.`); return; }
      const delay = Math.min(10_000, 1_000 * 2 ** reconnectAttempts++);
      retryTimer = window.setTimeout(() => { retryTimer = null; void load(); }, delay);
    };
    const load = async () => {
      if (!active || loadingDetail) return;
      loadingDetail = true; reloadController = new AbortController();
      try {
        const value = await api.liveBroadcast(gameName, reloadController.signal);
        if (!active) return;
        accept(value); setError("");
        if (!source) {
          source = new EventSource(`/api/live/${encodeURIComponent(gameName)}/events`, { withCredentials: true });
          source.onopen = () => { if (active) { setConnection("connected"); void load(); } };
          source.onerror = () => { if (active) { setConnection("reconnecting"); void load(); } };
          source.addEventListener("frame", (raw) => {
            if (!active) return;
            try {
              const event = JSON.parse((raw as MessageEvent).data) as { frame: unknown };
              const released = broadcastFrameSchema.parse(event.frame);
              if (released.game.gameName !== gameName) return;
              reconnectAttempts = 0;
              remember(released);
              void loadTimeline();
              setDetail((current) => current ? { ...current, broadcast: { ...current.broadcast, status: released.winner || released.game.phase === "finished" ? "ended" : "live" } } : current);
            } catch { setError("A broadcast update could not be read. Reconnecting will refresh the table."); }
          });
          source.addEventListener("comment", (raw) => {
            try { const event = JSON.parse((raw as MessageEvent).data) as { comment: unknown }; if (active) addComment(broadcastCommentSchema.parse(event.comment)); } catch { /* A reconnect fetch reconciles missing messages. */ }
          });
          source.addEventListener("viewers", (raw) => {
            try {
              const event = JSON.parse((raw as MessageEvent).data) as { viewerCount: number };
              if (active && Number.isSafeInteger(event.viewerCount) && event.viewerCount >= 0) setDetail((current) => current ? { ...current, broadcast: { ...current.broadcast, viewerCount: event.viewerCount } } : current);
            } catch { /* Presence is refreshed with the next safe snapshot. */ }
          });
          source.addEventListener("closed", (raw) => {
            if (!active) return;
            let code: string | undefined; let reason = "This broadcast is no longer available.";
            try {
              const value = JSON.parse((raw as MessageEvent).data) as { code?: unknown; reason?: unknown };
              if (typeof value.code === "string") code = value.code;
              if (typeof value.reason === "string" && value.reason.trim()) reason = value.reason.slice(0, 500);
            } catch { /* An invalid close event is confirmed over HTTP before revoking the page. */ }
            source?.close(); source = null;
            if (code === "auth-required" || /authentication required|sign in again/i.test(reason)) { onAuthenticationRequired(); return; }
            if (code === "restart" || code === "unavailable" || (!code && /restarting|temporarily unavailable|connection limit/i.test(reason))) reconnect(reason);
            else if (code === "closed") { setConnection("closed"); setError(reason); }
            else reconnect(reason);
          });
        }
      } catch (cause) {
        if (!active || reloadController.signal.aborted) return;
        if (cause instanceof HttpApiError && cause.status === 401) onAuthenticationRequired();
        else if (cause instanceof HttpApiError && cause.status === 404 && acceptedDetail) { source?.close(); source = null; setConnection("closed"); setError("This broadcast is no longer available. Its participants have stopped sharing it."); }
        else if (cause instanceof HttpApiError && cause.status === 503 && acceptedDetail && !source) reconnect("The broadcast service is temporarily unavailable.");
        else if (cause instanceof HttpApiError && [404, 503].includes(cause.status) && Date.now() - began < 30_000 && !source) {
          setError("Preparing this broadcast. Waiting for its first saved table…");
          retryTimer = window.setTimeout(() => { retryTimer = null; void load(); }, 1_500);
        }
        else setError(cause instanceof Error ? cause.message : "The broadcast could not be loaded.");
      } finally { loadingDetail = false; if (active && retryTimer === null) setLoading(false); }
    };
    reload.current = () => { reconnectAttempts = 0; if (retryTimer !== null) { window.clearTimeout(retryTimer); retryTimer = null; } void load(); };
    void load();
    return () => { active = false; alive.current = false; generation.current += 1; source?.close(); reloadController?.abort(); timelineController?.abort(); if (retryTimer !== null) window.clearTimeout(retryTimer); seekId.current += 1; };
  }, [gameName, onAuthenticationRequired, addComment, remember]);

  const seek = useCallback(async (sequence: number) => {
    const requestId = ++seekId.current;
    pausedRef.current = true; setPaused(true); setSeeking(true); setError("");
    try {
      const next = cache.current.get(sequence) ?? (await api.broadcastFrame(gameName, sequence)).frame;
      if (!alive.current || requestId !== seekId.current) return;
      if (next.game.gameName !== gameName) throw new Error("That move belongs to another broadcast.");
      cache.current.set(next.sequence, next);
      if (cache.current.size > 100) cache.current.delete(cache.current.keys().next().value!);
      setFrame(next);
    } catch (cause) {
      if (alive.current && requestId === seekId.current) setError(cause instanceof Error ? cause.message : "That released move is unavailable.");
    } finally { if (alive.current && requestId === seekId.current) setSeeking(false); }
  }, [gameName]);
  const goLive = useCallback(() => { seekId.current += 1; pausedRef.current = false; setPaused(false); setSeeking(false); setFrame(latest.current); }, []);
  const pause = useCallback(() => { pausedRef.current = true; setPaused(true); }, []);
  const loadEarlier = useCallback(async () => {
    if (!moreTimeline || earlierLoading.current) return;
    const requestGeneration = generation.current;
    earlierLoading.current = true; setTimelineLoading(true);
    try {
      const response = await api.broadcastTimeline(gameName, Number(moreTimeline));
      if (alive.current && requestGeneration === generation.current) { setTimeline((current) => mergeTimeline(current, response.frames, true)); setMoreTimeline(response.nextCursor); }
    } catch (cause) { if (alive.current && requestGeneration === generation.current) setError(cause instanceof Error ? cause.message : "Earlier moves could not be loaded."); }
    finally { if (alive.current && requestGeneration === generation.current) { earlierLoading.current = false; setTimelineLoading(false); } }
  }, [gameName, moreTimeline]);
  return { detail, frame, comments, timeline, moreTimeline, timelineLoading, connection, error, loading, paused, seeking, offset,
    pause, seek, goLive, loadEarlier, addComment, refresh: () => reload.current() };
}
