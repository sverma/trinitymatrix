import { useEffect, useRef, useState } from "react";
import { api, sameOriginMediaPath, type BroadcastVideoInfo } from "../../api";

export function useBroadcastVideo(gameName: string) {
  const [info, setInfo] = useState<BroadcastVideoInfo | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [serverOffset, setServerOffset] = useState(0);
  useEffect(() => {
    let active = true; let inFlight = false; let controller: AbortController | null = null;
    const load = async () => {
      if (!active || inFlight) return;
      inFlight = true; controller = new AbortController();
      try { const response = await api.liveVideo(gameName, controller.signal); if (active) { setInfo(response); setServerOffset(response.serverNow - Date.now()); setError(""); } }
      catch (cause) { if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Video is temporarily unavailable."); }
      finally { inFlight = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 3_000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, [gameName, refresh]);
  return { info, error, serverOffset, refresh: () => setRefresh((value) => value + 1) };
}

export function LiveVideo({ gameName }: { gameName: string }) {
  const { info, error, serverOffset, refresh } = useBroadcastVideo(gameName);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState("");
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now);
  const playlist = info?.video?.playlistUrl;
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !playlist) return;
    let active = true; let destroy: (() => void) | null = null;
    setPlaybackError("");
    const begin = async () => {
      try {
        const source = sameOriginMediaPath(playlist);
        if (element.canPlayType("application/vnd.apple.mpegurl")) { element.src = source; await element.play().catch(() => undefined); return; }
        const { default: Hls } = await import("hls.js");
        if (!active) return;
        if (!Hls.isSupported()) throw new Error("Video playback is not supported in this browser.");
        const hls = new Hls({ enableWorker: false, maxBufferLength: 30, backBufferLength: 60, xhrSetup: (xhr, url) => {
          if (new URL(url, window.location.origin).origin !== window.location.origin) throw new Error("External media addresses are not allowed.");
          xhr.withCredentials = true;
        } });
        destroy = () => hls.destroy(); hls.loadSource(source); hls.attachMedia(element);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { void element.play().catch(() => undefined); });
        hls.on(Hls.Events.ERROR, (_event, data) => { if (active && data.fatal) { setPlaybackError("Video playback was interrupted. Retry to reconnect."); hls.destroy(); } });
      } catch (cause) { if (active) setPlaybackError(cause instanceof Error ? cause.message : "Video playback could not start."); }
    };
    void begin();
    return () => { active = false; destroy?.(); element.pause(); element.removeAttribute("src"); element.load(); };
  }, [playlist, retry]);
  const remaining = info?.video ? Math.max(0, Math.ceil((info.video.availableAt - (now + serverOffset)) / 1_000)) : 0;
  if (info && (!info.enabled || (!info.video && !error))) return null;
  return <section className="live-video" aria-labelledby="live-video-title">
    <h2 id="live-video-title">Broadcast video <small>2-minute minimum delay</small></h2>
    {!info && !error && <p role="status">Checking for broadcast video…</p>}
    {(error || playbackError) && <p className="live-error" role="alert">{error || playbackError} <button className="secondary" onClick={() => { refresh(); setRetry((value) => value + 1); }}>Retry video</button></p>}
    {info?.video && <>
      <p className="live-video-state">{info.video.publisherName ? `${info.video.publisherName} · ` : ""}{info.video.status === "interrupted" ? "Publisher disconnected" : info.video.status === "stopped" || info.video.status === "expired" ? "Video has ended" : playlist ? "Delayed live video" : remaining > 0 ? `Video warming up · available in ${remaining}s` : "Waiting for the first delayed video segment…"}</p>
      {playlist && <video ref={videoRef} controls muted autoPlay playsInline aria-label="Delayed broadcast video" onError={() => setPlaybackError("Video playback was interrupted. Retry to reconnect.")} />}
      <p className="live-caption">Video has its own playback controls. The table and video both use the server-enforced broadcast delay.</p>
    </>}
  </section>;
}
