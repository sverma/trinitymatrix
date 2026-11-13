export type CaptureMode = "screen" | "camera" | "screen-camera";
export type CaptureHandle = { stream: MediaStream; stop: () => void; sourceTracks?: readonly MediaStreamTrack[] };
const maximumChunkBytes = 512 * 1024;

/** Bounded, serial uploads preserve the WebM byte stream across HTTP chunks. */
export class VideoUploadQueue {
  private chain: Promise<void> = Promise.resolve();
  private bytes = 0;
  private sequence = 0;
  private stopped = false;
  readonly controller = new AbortController();
  constructor(private readonly upload: (sequence: number, chunk: Blob, signal: AbortSignal) => Promise<void>, private readonly capacity = 2 * 1024 * 1024) {}
  enqueue(blob: Blob): Promise<void> {
    if (this.stopped || this.controller.signal.aborted) return Promise.reject(new Error("The video upload has stopped."));
    if (this.bytes + blob.size > this.capacity) {
      this.cancel();
      return Promise.reject(new Error("The connection cannot keep up with the video. Sharing stopped; try again on a faster connection."));
    }
    this.bytes += blob.size;
    const next = this.chain.then(async () => {
      for (let start = 0; start < blob.size; start += maximumChunkBytes) {
        if (this.controller.signal.aborted) throw new Error("The video upload has stopped.");
        await this.upload(this.sequence, blob.slice(start, start + maximumChunkBytes), this.controller.signal);
        this.sequence += 1;
      }
    }).finally(() => { this.bytes -= blob.size; });
    this.chain = next;
    void next.catch(() => { this.stopped = true; this.controller.abort(); });
    return next;
  }
  drain() { return this.chain; }
  cancel() { this.stopped = true; this.controller.abort(); }
}

export async function captureBroadcast(mode: CaptureMode, microphone: boolean, signal?: AbortSignal): Promise<CaptureHandle> {
  const devices = navigator.mediaDevices;
  if (!devices) throw new Error("This browser does not support video sharing.");
  const streams: MediaStream[] = [];
  let animation: number | null = null;
  const elements: HTMLVideoElement[] = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (animation !== null) cancelAnimationFrame(animation);
    for (const stream of streams) for (const track of stream.getTracks()) track.stop();
    for (const element of elements) { element.pause(); element.srcObject = null; }
    signal?.removeEventListener("abort", stop);
  };
  const collect = (stream: MediaStream) => {
    if (stopped || signal?.aborted) { for (const track of stream.getTracks()) track.stop(); throw new Error("Video sharing was cancelled."); }
    streams.push(stream); return stream;
  };
  if (signal?.aborted) throw new Error("Video sharing was cancelled.");
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const video = { width: { ideal: 854, max: 854 }, height: { ideal: 480, max: 480 }, frameRate: { ideal: 15, max: 15 } };
    let screen: MediaStream | null = null;
    let camera: MediaStream | null = null;
    let audio: MediaStream | null = null;
    if (mode !== "camera") screen = collect(await devices.getDisplayMedia({ video, audio: false }));
    if (mode !== "screen" || microphone) {
      camera = collect(await devices.getUserMedia({ video: mode !== "screen" ? video : false, audio: microphone }));
      if (microphone) audio = camera;
    }
    if (mode !== "screen-camera") {
      const source = mode === "camera" ? camera! : screen!;
      const output = new MediaStream([...source.getVideoTracks(), ...(audio?.getAudioTracks() ?? [])]);
      collect(output); return { stream: output, stop, sourceTracks: [...new Set(streams.flatMap((stream) => stream.getTracks()))] };
    }
    const makeVideo = async (source: MediaStream) => {
      const element = document.createElement("video"); element.muted = true; element.playsInline = true; element.srcObject = source; elements.push(element);
      await element.play(); return element;
    };
    const display = await makeVideo(screen!);
    const face = await makeVideo(camera!);
    const canvas = document.createElement("canvas"); canvas.width = 854; canvas.height = 480;
    const context = canvas.getContext("2d");
    if (!context || !canvas.captureStream) throw new Error("This browser cannot combine screen and camera video.");
    const paint = () => {
      if (stopped) return;
      context.fillStyle = "#071b25"; context.fillRect(0, 0, 854, 480);
      const ratio = Math.min(854 / (display.videoWidth || 854), 480 / (display.videoHeight || 480));
      const width = (display.videoWidth || 854) * ratio; const height = (display.videoHeight || 480) * ratio;
      context.drawImage(display, (854 - width) / 2, (480 - height) / 2, width, height);
      context.fillStyle = "#071b25"; context.fillRect(644, 344, 198, 124); context.drawImage(face, 648, 348, 190, 116);
      animation = requestAnimationFrame(paint);
    };
    paint();
    const output = canvas.captureStream(15);
    for (const track of audio?.getAudioTracks() ?? []) output.addTrack(track);
    collect(output);
    return { stream: output, stop, sourceTracks: [...new Set(streams.flatMap((stream) => stream.getTracks()))] };
  } catch (cause) { stop(); throw cause; }
}
