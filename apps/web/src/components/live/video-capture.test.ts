import { afterEach, describe, expect, it, vi } from "vitest";
import { captureBroadcast, VideoUploadQueue } from "./video-capture";

class TestTrack extends EventTarget {
  stop = vi.fn();
  constructor(readonly kind: "video" | "audio") { super(); }
}
class TestStream {
  constructor(private tracks: TestTrack[] = []) {}
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  addTrack(track: TestTrack) { this.tracks.push(track); }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("bounded browser video capture", () => {
  it("uploads bytes serially in numbered chunks no larger than 512 KiB", async () => {
    const parts: Array<{ sequence: number; size: number; text: string }> = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.fn(async (sequence: number, chunk: Blob) => { if (sequence === 0) await first; parts.push({ sequence, size: chunk.size, text: await chunk.text() }); });
    const queue = new VideoUploadQueue(upload);
    const a = queue.enqueue(new Blob(["prefix"]));
    const b = queue.enqueue(new Blob(["x".repeat(600_000)]));
    await Promise.resolve(); expect(upload).toHaveBeenCalledTimes(1);
    release(); await Promise.all([a, b]);
    expect(parts.map((part) => part.sequence)).toEqual([0, 1, 2]);
    expect(parts.every((part) => part.size <= 512 * 1024)).toBe(true);
    expect(parts.map((part) => part.text).join("")).toBe(`prefix${"x".repeat(600_000)}`);
  });

  it("aborts queued work when the 2 MiB upload backlog is exceeded", async () => {
    const upload = vi.fn((_sequence: number, _chunk: Blob, signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    const queue = new VideoUploadQueue(upload);
    const first = queue.enqueue(new Blob([new Uint8Array(512 * 1024)]));
    const rejected = expect(first).rejects.toThrow("aborted");
    await Promise.resolve();
    await expect(queue.enqueue(new Blob([new Uint8Array(2 * 1024 * 1024)]))).rejects.toThrow("cannot keep up");
    await rejected;
    expect(queue.controller.signal.aborted).toBe(true);
    await expect(queue.enqueue(new Blob(["later"]))).rejects.toThrow("stopped");
  });

  it("stops an acquired screen immediately when a pending camera permission is cancelled", async () => {
    vi.stubGlobal("MediaStream", TestStream);
    const display = new TestTrack("video"); const camera = new TestTrack("video");
    let finishCamera!: (stream: TestStream) => void;
    const getDisplayMedia = vi.fn(async () => new TestStream([display]));
    const getUserMedia = vi.fn(() => new Promise<TestStream>((resolve) => { finishCamera = resolve; }));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getDisplayMedia, getUserMedia } });
    const controller = new AbortController();
    const capture = captureBroadcast("screen-camera", false, controller.signal);
    const rejected = expect(capture).rejects.toThrow("cancelled");
    await Promise.resolve(); controller.abort();
    expect(display.stop).toHaveBeenCalled();
    finishCamera(new TestStream([camera])); await rejected;
    expect(camera.stop).toHaveBeenCalled();
  });

  it("requests camera and microphone only when capture is explicitly invoked and stops both", async () => {
    vi.stubGlobal("MediaStream", TestStream);
    const camera = new TestTrack("video"); const microphone = new TestTrack("audio");
    const getUserMedia = vi.fn(async () => new TestStream([camera, microphone]));
    const getDisplayMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, getDisplayMedia } });
    expect(getUserMedia).not.toHaveBeenCalled();
    const captured = await captureBroadcast("camera", true);
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: true, video: expect.objectContaining({ frameRate: { ideal: 15, max: 15 } }) }));
    expect(getDisplayMedia).not.toHaveBeenCalled();
    captured.stop(); expect(camera.stop).toHaveBeenCalled(); expect(microphone.stop).toHaveBeenCalled();
  });
});
