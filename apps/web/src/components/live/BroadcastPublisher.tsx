import { useEffect, useRef, useState } from "react";
import { api, type BroadcastVideoSession } from "../../api";
import { useBroadcastVideo } from "./LiveVideo";
import { captureBroadcast, VideoUploadQueue, type CaptureHandle, type CaptureMode } from "./video-capture";

type ActiveCapture = { capture: CaptureHandle; recorder: MediaRecorder; queue: VideoUploadQueue; session: BroadcastVideoSession; deadline: number };

export function BroadcastPublisher({ gameName, onSharingChange }: { gameName: string; onSharingChange?: (sharing: boolean) => void }) {
  const { info, error: serviceError, refresh } = useBroadcastVideo(gameName);
  const [mode, setMode] = useState<CaptureMode>("screen");
  const [microphone, setMicrophone] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const preview = useRef<HTMLVideoElement>(null);
  const active = useRef<ActiveCapture | null>(null);
  const phase = useRef<"idle" | "starting" | "sharing" | "stopping">("idle");
  const generation = useRef(0);
  const captureController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);

  const stop = async () => {
    generation.current += 1; captureController.current?.abort();
    if (alive.current) setStarting(false);
    const value = active.current;
    if (!value) { if (phase.current === "starting") phase.current = "idle"; return; }
    phase.current = "stopping";
    active.current = null; value.capture.stop(); window.clearTimeout(value.deadline);
    setSharing(false); onSharingChange?.(false); setStopping(true);
    if (preview.current) preview.current.srcObject = null;
    try {
      if (value.recorder.state !== "inactive") await new Promise<void>((resolve, reject) => {
        const completed = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { value.recorder.removeEventListener("stop", completed); reject(new Error("The browser did not finish its final video chunk.")); }, 5_000);
        value.recorder.addEventListener("stop", completed, { once: true });
        try { value.recorder.stop(); } catch (cause) { clearTimeout(timer); value.recorder.removeEventListener("stop", completed); reject(cause); }
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([value.queue.drain(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The final video upload timed out.")), 20_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    } catch (cause) { value.queue.cancel(); if (alive.current) setError(cause instanceof Error ? cause.message : "Some video could not be uploaded."); }
    finally {
      await api.stopBroadcastVideo(value.session.stopUrl).catch(() => { if (alive.current) setError("The camera and screen have stopped. The server could not confirm the end of this video session."); });
      phase.current = "idle";
      if (alive.current) { setStopping(false); setNotice("Screen, camera and microphone sharing stopped."); refresh(); }
    }
  };
  stopRef.current = stop;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false; generation.current += 1; captureController.current?.abort();
      const value = active.current; active.current = null;
      if (value) { window.clearTimeout(value.deadline); value.capture.stop(); value.queue.cancel(); try { if (value.recorder.state !== "inactive") value.recorder.stop(); } catch { /* Tracks and uploads are already stopped. */ } void api.stopBroadcastVideo(value.session.stopUrl).catch(() => undefined); }
    };
  }, []);

  const start = async () => {
    if (phase.current !== "idle" || !info?.canPublish) return;
    phase.current = "starting";
    const request = ++generation.current; const controller = new AbortController(); captureController.current = controller;
    setStarting(true); setError(""); setNotice("");
    let capture: CaptureHandle | null = null;
    let session: BroadcastVideoSession | null = null;
    try {
      if (!window.MediaRecorder) throw new Error("This browser does not support video publishing.");
      // Capture is requested directly from this user gesture, never during load or polling.
      capture = await captureBroadcast(mode, microphone, controller.signal);
      if (!alive.current || request !== generation.current) { capture.stop(); return; }
      session = await api.startBroadcastVideo(gameName);
      if (!alive.current || request !== generation.current) { capture.stop(); await api.stopBroadcastVideo(session.stopUrl); return; }
      const queue = new VideoUploadQueue((sequence, chunk, signal) => api.uploadBroadcastVideo(session!.uploadUrl, sequence, chunk, signal));
      const mimeType = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"].find((value) => MediaRecorder.isTypeSupported(value));
      if (!mimeType) throw new Error("This browser cannot record a compatible video stream.");
      const recorder = new MediaRecorder(capture.stream, { mimeType, videoBitsPerSecond: 700_000, audioBitsPerSecond: 64_000 });
      const fail = (cause: unknown) => { if (alive.current) setError(cause instanceof Error ? cause.message : "Video sharing was interrupted."); void stopRef.current(); };
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size) void queue.enqueue(event.data).catch(fail); });
      recorder.addEventListener("error", () => fail(new Error("The browser stopped recording video.")));
      for (const track of capture.sourceTracks ?? capture.stream.getVideoTracks()) track.addEventListener("ended", () => { void stopRef.current(); }, { once: true });
      const deadline = window.setTimeout(() => { void stopRef.current(); }, Math.min(7_200, session.limits.maxDurationSeconds) * 1_000);
      active.current = { capture, session, queue, recorder, deadline };
      if (preview.current) preview.current.srcObject = capture.stream;
      recorder.start(1_000); phase.current = "sharing"; setSharing(true); onSharingChange?.(true); setNotice("Sharing started. Viewers will receive video after the two-minute delay.");
    } catch (cause) {
      if (active.current?.capture === capture) { window.clearTimeout(active.current.deadline); active.current.queue.cancel(); active.current = null; }
      capture?.stop(); if (session) await api.stopBroadcastVideo(session.stopUrl).catch(() => undefined);
      if (alive.current && request === generation.current) setError(cause instanceof Error ? cause.message : "Permission was denied or video sharing could not start.");
    } finally { if (alive.current && request === generation.current) { if (phase.current === "starting") phase.current = "idle"; setStarting(false); } }
  };

  if (info && (!info.enabled || !info.canPublish)) return null;
  return <section className="broadcast-publisher" aria-labelledby="broadcast-publisher-title">
    <h3 id="broadcast-publisher-title">Share video with your table broadcast</h3>
    <p>Choose what to share. Screen, camera and microphone permissions are requested only when you start. Viewers receive video after at least two minutes.</p>
    {(error || serviceError) && <p role="alert" className="live-error">{error || serviceError}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="live-publisher-options"><label>Video source<select disabled={starting || sharing || stopping} value={mode} onChange={(event) => setMode(event.target.value as CaptureMode)}>
      <option value="screen">Screen or browser tab</option><option value="camera">Camera</option><option value="screen-camera">Screen with camera overlay</option>
    </select></label><label className="live-checkbox"><input type="checkbox" checked={microphone} disabled={starting || sharing || stopping} onChange={(event) => setMicrophone(event.target.checked)} />Include microphone</label></div>
    <video ref={preview} muted autoPlay playsInline className={sharing ? "broadcast-preview" : "broadcast-preview hidden"} aria-label="Your local broadcast preview" />
    {sharing && <p className="live-caption">This immediate preview is visible only to you. Shared video remains delayed.</p>}
    <div className="live-publisher-actions">{sharing || starting ? <button type="button" className="danger" onClick={() => void stop()}>{starting ? "Cancel capture request" : "Stop video sharing"}</button>
      : <button type="button" className="primary" disabled={!info?.canPublish || stopping} onClick={() => void start()}>{stopping ? "Stopping video…" : "Start video sharing"}</button>}</div>
  </section>;
}
