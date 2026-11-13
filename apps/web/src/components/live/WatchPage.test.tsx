import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { FakeEventSource, liveComment, liveDetail, liveFrame, liveName, livePlayer } from "./live.test-helpers";
import { WatchPage } from "./WatchPage";
vi.mock("./LiveVideo", () => ({ LiveVideo: () => null }));

beforeEach(() => {
  FakeEventSource.instances = []; vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(api, "liveBroadcast").mockResolvedValue(liveDetail());
  vi.spyOn(api, "broadcastTimeline").mockResolvedValue({ frames: [liveFrame()], nextCursor: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("delayed table spectator page", () => {
  it("renders every released hand and escapes chat text instead of injecting markup", async () => {
    const malicious = '<img src="unsafe" onerror="alert(1)">';
    vi.mocked(api.liveBroadcast).mockResolvedValue({ ...liveDetail(), comments: [liveComment(malicious)], canModerate: true });
    render(<WatchPage gameName={liveName} player={livePlayer} onAuthenticationRequired={vi.fn()} />);
    expect(await screen.findByRole("region", { name: "Asha's revealed hand" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Model AI's revealed hand" })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Asha's cards" })).getAllByRole("img")).toHaveLength(13);
    expect(screen.getByText(malicious)).toBeInTheDocument();
    expect(document.querySelector('img[src="unsafe"]')).toBeNull();
    expect(screen.getByText(/All hands revealed · 2-minute minimum delay/)).toBeInTheDocument();
    act(() => FakeEventSource.instances[0]!.emit("closed", { code: "closed", reason: "closed" }));
    expect(screen.getByRole("heading", { name: "Broadcast closed" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Asha's revealed hand" })).not.toBeInTheDocument();
  });

  it("reuses a comment id after a failed submission and does not prematurely reveal delayed player comments", async () => {
    const user = userEvent.setup();
    const send = vi.spyOn(api, "postBroadcastComment").mockRejectedValueOnce(new Error("Retry this message"))
      .mockResolvedValue({ delayed: true, availableAt: Date.now() + 120_000 });
    render(<WatchPage gameName={liveName} player={livePlayer} onAuthenticationRequired={vi.fn()} />);
    await user.type(await screen.findByLabelText("Your spectator message"), "My delayed message");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Message queued/)).toBeInTheDocument();
    expect(send.mock.calls[0]![2]).toBe(send.mock.calls[1]![2]);
    expect(within(screen.getByRole("list", { name: "Broadcast messages" })).queryByText("My delayed message")).not.toBeInTheDocument();
  });
});
