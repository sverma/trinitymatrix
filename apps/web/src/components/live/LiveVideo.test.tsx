import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { liveName, videoInfo } from "./live.test-helpers";
import { LiveVideo } from "./LiveVideo";

afterEach(() => vi.restoreAllMocks());
describe("delayed broadcast video viewer", () => {
  it("shows buffering without creating a video source before the server releases a playlist", async () => {
    vi.spyOn(api, "liveVideo").mockResolvedValue(videoInfo({ video: { id: "v1", status: "buffering", availableAt: Date.now() + 100_000, playlistUrl: null } }));
    render(<LiveVideo gameName={liveName} />);
    expect(await screen.findByText(/Video warming up/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Delayed broadcast video")).not.toBeInTheDocument();
  });

  it("uses native HLS when available and releases its source on unmount", async () => {
    const source = `/api/live/${liveName}/video/v1/index.m3u8`;
    vi.spyOn(api, "liveVideo").mockResolvedValue(videoInfo({ video: { id: "v1", status: "live", availableAt: Date.now() - 1, playlistUrl: source } }));
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { unmount } = render(<LiveVideo gameName={liveName} />);
    const video = await screen.findByLabelText("Delayed broadcast video");
    await waitFor(() => expect(video).toHaveAttribute("src", source));
    fireEvent.error(video);
    expect(screen.getByRole("alert")).toHaveTextContent("playback was interrupted");
    fireEvent.playing(video);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(play).toHaveBeenCalled(); unmount();
    expect(pause).toHaveBeenCalled(); expect(video).not.toHaveAttribute("src");
  });

  it("rejects a foreign playlist address rather than forwarding viewer credentials", async () => {
    vi.spyOn(api, "liveVideo").mockResolvedValue(videoInfo({ video: { id: "v1", status: "live", availableAt: Date.now() - 1, playlistUrl: "https://foreign.example/playlist.m3u8" } }));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    render(<LiveVideo gameName={liveName} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid media address");
    expect(screen.getByLabelText("Delayed broadcast video")).not.toHaveAttribute("src");
  });
});
