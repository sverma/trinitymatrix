import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { liveName, videoInfo } from "./live.test-helpers";
import { BroadcastPublisher } from "./BroadcastPublisher";
const captureMocks = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("./video-capture", async (importOriginal) => ({ ...await importOriginal<typeof import("./video-capture")>(), captureBroadcast: captureMocks.capture }));

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (_mime: string) => true;
  state: RecordingState = "inactive";
  constructor(readonly stream: MediaStream, readonly options: MediaRecorderOptions) { super(); FakeRecorder.instances.push(this); }
  start(_timeslice: number) { this.state = "recording"; }
  stop() { this.state = "inactive"; this.dispatchEvent(new Event("stop")); }
  chunk(data: Blob) { const event = new Event("dataavailable"); Object.defineProperty(event, "data", { value: data }); this.dispatchEvent(event); }
}
const stopCapture = vi.fn();
const stream = { getVideoTracks: () => [] } as unknown as MediaStream;
beforeEach(() => {
  captureMocks.capture.mockReset().mockResolvedValue({ stream, stop: stopCapture }); stopCapture.mockClear();
  FakeRecorder.instances = []; vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => undefined);
  vi.spyOn(api, "liveVideo").mockResolvedValue(videoInfo());
  vi.spyOn(api, "startBroadcastVideo").mockResolvedValue({ id: "video1", uploadUrl: `/api/live/${liveName}/video/video1/chunks`, stopUrl: `/api/live/${liveName}/video/video1/stop`, availableAt: Date.now() + 120_000, limits: videoInfo().limits });
  vi.spyOn(api, "uploadBroadcastVideo").mockResolvedValue(undefined);
  vi.spyOn(api, "stopBroadcastVideo").mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("user-initiated video publishing", () => {
  it("requests capture only after a gesture, uploads serial chunks and stops capture on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BroadcastPublisher gameName={liveName} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled());
    expect(captureMocks.capture).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("Video source"), "camera");
    await user.click(screen.getByLabelText("Include microphone"));
    await user.click(screen.getByRole("button", { name: "Start video sharing" }));
    expect(captureMocks.capture).toHaveBeenCalledWith("camera", true, expect.any(AbortSignal));
    expect(await screen.findByRole("button", { name: "Stop video sharing" })).toBeInTheDocument();
    act(() => FakeRecorder.instances[0]!.chunk(new Blob(["synthetic media"])));
    await waitFor(() => expect(api.uploadBroadcastVideo).toHaveBeenCalledWith(expect.stringContaining("/video1/chunks"), 0, expect.any(Blob), expect.any(AbortSignal)));
    unmount(); expect(stopCapture).toHaveBeenCalled();
    expect(api.stopBroadcastVideo).toHaveBeenCalledWith(expect.stringContaining("/video1/stop"));
  });

  it("cleans up permission results arriving after the user cancels capture", async () => {
    const user = userEvent.setup(); let finish!: (value: { stream: MediaStream; stop: typeof stopCapture }) => void;
    captureMocks.capture.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<BroadcastPublisher gameName={liveName} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start video sharing" }));
    await user.click(screen.getByRole("button", { name: "Cancel capture request" }));
    expect(captureMocks.capture.mock.calls[0]![2].aborted).toBe(true);
    await act(async () => finish({ stream, stop: stopCapture }));
    expect(stopCapture).toHaveBeenCalled(); expect(api.startBroadcastVideo).not.toHaveBeenCalled();
  });

  it("stops acquired tracks if the server cannot allocate a video session", async () => {
    const user = userEvent.setup(); vi.mocked(api.startBroadcastVideo).mockRejectedValue(new Error("Another video session is already active."));
    render(<BroadcastPublisher gameName={liveName} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start video sharing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already active");
    expect(stopCapture).toHaveBeenCalled(); expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("stops tracks immediately and bounds a browser that never finishes recording", async () => {
    const user = userEvent.setup();
    render(<BroadcastPublisher gameName={liveName} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start video sharing" }));
    await screen.findByRole("button", { name: "Stop video sharing" });
    const recorder = FakeRecorder.instances[0]!;
    vi.spyOn(recorder, "stop").mockImplementation(() => { recorder.state = "inactive"; });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Stop video sharing" }));
    expect(stopCapture).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_001); });
    expect(screen.getByRole("alert")).toHaveTextContent("final video chunk");
    expect(api.stopBroadcastVideo).toHaveBeenCalledWith(expect.stringContaining("/video1/stop"));
    expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled();
  });

  it("stops a composite capture when the original screen track ends", async () => {
    const user = userEvent.setup();
    const originalScreen = new EventTarget();
    captureMocks.capture.mockResolvedValue({ stream, stop: stopCapture, sourceTracks: [originalScreen] });
    render(<BroadcastPublisher gameName={liveName} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start video sharing" }));
    await screen.findByRole("button", { name: "Stop video sharing" });
    act(() => originalScreen.dispatchEvent(new Event("ended")));
    expect(stopCapture).toHaveBeenCalled();
    await waitFor(() => expect(api.stopBroadcastVideo).toHaveBeenCalled());
  });

  it("uses fragmented MP4 when the browser cannot record WebM", async () => {
    const user = userEvent.setup();
    vi.spyOn(FakeRecorder, "isTypeSupported").mockImplementation((mime: string) => mime.startsWith("video/mp4"));
    const { unmount } = render(<BroadcastPublisher gameName={liveName} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Start video sharing" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start video sharing" }));
    await screen.findByRole("button", { name: "Stop video sharing" });
    expect(FakeRecorder.instances[0]!.options.mimeType).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    unmount();
  });
});
