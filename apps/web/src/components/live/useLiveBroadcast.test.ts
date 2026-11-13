import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, HttpApiError } from "../../api";
import { FakeEventSource, liveComment, liveDetail, liveFrame, liveName } from "./live.test-helpers";
import { useLiveBroadcast } from "./useLiveBroadcast";

beforeEach(() => {
  FakeEventSource.instances = []; vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(api, "liveBroadcast").mockResolvedValue(liveDetail());
  vi.spyOn(api, "broadcastTimeline").mockResolvedValue({ frames: [liveFrame(1), liveFrame(2)], nextCursor: null });
  vi.spyOn(api, "broadcastFrame").mockImplementation(async (_name, sequence) => ({ frame: liveFrame(sequence) }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("spectator-only broadcast connection", () => {
  it("follows released frames, freezes on pause, seeks over HTTP and resumes delayed live", async () => {
    const gameplaySocket = vi.fn(); vi.stubGlobal("WebSocket", gameplaySocket);
    const auth = vi.fn(); const { result, unmount } = renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(result.current.frame?.sequence).toBe(1));
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`/api/live/${liveName}/events`);
    expect(source.options).toEqual({ withCredentials: true });
    act(() => source.emit("frame", { frame: liveFrame(2) }));
    expect(result.current.frame?.sequence).toBe(2);
    act(() => result.current.pause());
    act(() => source.emit("frame", { frame: liveFrame(3) }));
    expect(result.current.frame?.sequence).toBe(2);
    await act(async () => result.current.seek(1));
    expect(result.current.frame?.sequence).toBe(1);
    act(() => result.current.goLive());
    expect(result.current.frame?.sequence).toBe(3);
    expect(gameplaySocket).not.toHaveBeenCalled();
    unmount(); expect(source.close).toHaveBeenCalled();
  });

  it("deduplicates messages, applies removals and updates unique viewer presence", async () => {
    const auth = vi.fn(); const { result } = renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;
    act(() => { source.emit("comment", { comment: liveComment() }); source.emit("comment", { comment: liveComment() }); source.emit("viewers", { viewerCount: 9 }); });
    expect(result.current.comments).toHaveLength(1);
    expect(result.current.detail?.broadcast.viewerCount).toBe(9);
    act(() => source.emit("comment", { comment: { ...liveComment(), message: "", deleted: true } }));
    expect(result.current.comments[0]?.deleted).toBe(true);
    act(() => source.emit("frame", { frame: { ...liveFrame(3), privateStockOrder: ["must not be accepted"] } }));
    expect(result.current.frame?.sequence).toBe(1);
    expect(result.current.error).toContain("could not be read");
  });

  it("refreshes missed released data after reconnect and closes revoked streams", async () => {
    const auth = vi.fn(); const { result } = renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const source = FakeEventSource.instances[0]!;
    act(() => source.fail()); expect(result.current.connection).toBe("reconnecting");
    await act(async () => undefined);
    vi.mocked(api.liveBroadcast).mockResolvedValue({ ...liveDetail(liveFrame(5)), comments: [liveComment("Missed during reconnect")] });
    act(() => source.open());
    await waitFor(() => expect(result.current.frame?.sequence).toBe(5));
    expect(result.current.comments[0]?.message).toBe("Missed during reconnect");
    act(() => source.emit("closed", { code: "closed", reason: "consent-withdrawn" }));
    expect(result.current.connection).toBe("closed"); expect(source.close).toHaveBeenCalled();
  });

  it("requests sign-in rather than opening a stream when HTTP authentication expires", async () => {
    const auth = vi.fn(); vi.mocked(api.liveBroadcast).mockRejectedValue(new HttpApiError("Authentication required.", 401));
    renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(auth).toHaveBeenCalled());
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("rechecks HTTP authentication when the event stream cannot reconnect", async () => {
    const auth = vi.fn(); renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    vi.mocked(api.liveBroadcast).mockRejectedValue(new HttpApiError("Session expired.", 401));
    act(() => FakeEventSource.instances[0]!.fail());
    await waitFor(() => expect(auth).toHaveBeenCalled());
  });

  it("reconnects after a service restart instead of claiming that participants withdrew", async () => {
    vi.useFakeTimers(); const auth = vi.fn();
    const { result } = renderHook(() => useLiveBroadcast(liveName, auth));
    await act(async () => undefined);
    const source = FakeEventSource.instances[0]!;
    act(() => source.emit("closed", { code: "restart", reason: "The broadcast service is restarting." }));
    expect(result.current.connection).toBe("reconnecting");
    expect(result.current.error).not.toContain("participants");
    vi.mocked(api.liveBroadcast).mockResolvedValue(liveDetail(liveFrame(5)));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.instances[1]!.open());
    expect(result.current.connection).toBe("connected");
    expect(result.current.frame?.sequence).toBe(5);
  });

  it("fills skipped SSE revisions from the released timeline", async () => {
    const auth = vi.fn(); const { result } = renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(result.current.timeline).toHaveLength(2));
    vi.mocked(api.broadcastTimeline).mockResolvedValue({ frames: [1, 2, 3, 4, 5].map(liveFrame), nextCursor: null });
    act(() => FakeEventSource.instances[0]!.emit("frame", { frame: liveFrame(5) }));
    await waitFor(() => expect(result.current.timeline.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]));
  });

  it("bounds service recovery attempts and permits an explicit retry", async () => {
    vi.useFakeTimers(); const auth = vi.fn();
    const { result } = renderHook(() => useLiveBroadcast(liveName, auth));
    await act(async () => undefined);
    vi.mocked(api.liveBroadcast).mockRejectedValue(new HttpApiError("Service unavailable.", 503));
    act(() => FakeEventSource.instances[0]!.emit("closed", { code: "unavailable", reason: "The broadcast service is temporarily unavailable." }));
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(api.liveBroadcast).toHaveBeenCalledTimes(9);
    expect(result.current.error).toContain("Automatic retries paused");
    vi.mocked(api.liveBroadcast).mockResolvedValue(liveDetail(liveFrame(6)));
    await act(async () => result.current.refresh());
    expect(result.current.frame?.sequence).toBe(6);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("keeps only the server's100-message released window in a long spectator session", async () => {
    const auth = vi.fn(); const { result } = renderHook(() => useLiveBroadcast(liveName, auth));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      for (let index = 0; index < 101; index++) {
        FakeEventSource.instances[0]!.emit("comment", { comment: { ...liveComment(`Message ${index}`), id: `${(index + 1).toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`, createdAt: 1_800_000_000_000 + index } });
      }
    });
    expect(result.current.comments).toHaveLength(100);
    expect(result.current.comments[0]?.message).toBe("Message 1");
  });

  it("ignores an earlier-moves response after changing to another broadcast", async () => {
    let finish!: (value: { frames: ReturnType<typeof liveFrame>[]; nextCursor: string | null }) => void;
    vi.mocked(api.broadcastTimeline).mockResolvedValueOnce({ frames: [liveFrame(2)], nextCursor: "2" })
      .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ frames: [], nextCursor: null });
    const auth = vi.fn();
    const { result, rerender } = renderHook(({ name }) => useLiveBroadcast(name, auth), { initialProps: { name: liveName } });
    await waitFor(() => expect(result.current.moreTimeline).toBe("2"));
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadEarlier(); });
    const nextName = `${liveName}-other`;
    vi.mocked(api.liveBroadcast).mockResolvedValue({ ...liveDetail(), broadcast: { ...liveDetail().broadcast, gameName: nextName }, frame: null });
    rerender({ name: nextName });
    await waitFor(() => expect(result.current.detail?.broadcast.gameName).toBe(nextName));
    await act(async () => { finish({ frames: [liveFrame(0)], nextCursor: "1" }); await pending; });
    expect(result.current.timeline).toEqual([]);
    expect(result.current.moreTimeline).toBeNull();
    expect(result.current.timelineLoading).toBe(false);
  });
});
