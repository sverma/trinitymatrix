import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api";
import { FakeEventSource, liveComment, liveDetail, liveFrame, liveName, livePlayer } from "./live.test-helpers";
import { WatchPage } from "./WatchPage";
import { recordedCards, recordedLayout } from "./watch-hand.fixtures";
vi.mock("./LiveVideo", () => ({ LiveVideo: () => null }));

beforeEach(() => {
  FakeEventSource.instances = []; vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(api, "liveBroadcast").mockResolvedValue(liveDetail());
  vi.spyOn(api, "broadcastTimeline").mockResolvedValue({ frames: [liveFrame()], nextCursor: null });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("delayed table spectator page", () => {
  it.each(["v0", "v2"])("hides archived AI %s labels throughout the broadcast without altering human names", async (version) => {
    const frame = liveFrame();
    frame.game.players[0]!.displayName = "Asha · v2";
    const model = frame.game.players[1]!;
    model.displayName = `Model AI · ${version}`;
    frame.event = { type: "game.declare", actorPlayerId: model.id, summary: `${model.displayName}: Declared` };
    frame.winner = { id: model.id, name: model.displayName, reason: "declaration", score: 102 };
    const detail = liveDetail(frame);
    detail.broadcast = { ...detail.broadcast, players: detail.broadcast.players.map((player, index) => ({ ...player, displayName: frame.game.players[index]!.displayName })) };
    detail.broadcast.title = detail.broadcast.players.map(({ displayName }) => displayName).join(" · ");
    vi.mocked(api.liveBroadcast).mockResolvedValue(detail);
    vi.mocked(api.broadcastTimeline).mockResolvedValue({ frames: [frame], nextCursor: null });
    render(<WatchPage gameName={liveName} player={livePlayer} onAuthenticationRequired={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Asha · v2 · Model AI" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Model AI's revealed hand" })).toBeInTheDocument();
    expect(screen.getByText("Model AI won.")).toBeInTheDocument();
    expect(screen.getByText("Model AI: Declared")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Asha · v2's revealed hand" })).toBeInTheDocument();
    expect(screen.queryByText(model.displayName)).not.toBeInTheDocument();
  });

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

  it("keeps recorded grouping and progress tied to the selected delayed frame during live updates and DVR seeking", async () => {
    const user = userEvent.setup();
    const first = liveFrame(1);
    first.game.wildRank = 13;
    first.hands[0] = { playerId: livePlayer.id, cards: recordedCards, layout: { source: "recorded", groups: recordedLayout.groups.map((group) => [...group]) } };
    const next = { ...first, sequence: 2, game: { ...first.game, wildRank: 7, revision: 2 } };
    vi.mocked(api.liveBroadcast).mockResolvedValue(liveDetail(first));
    vi.mocked(api.broadcastTimeline).mockResolvedValue({ frames: [first], nextCursor: null });
    render(<WatchPage gameName={liveName} player={livePlayer} onAuthenticationRequired={vi.fn()} />);
    const hand = await screen.findByRole("region", { name: "Asha's revealed hand" });
    expect(within(hand).getByText("Recorded grouping")).toBeInTheDocument();
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("1 natural 21");
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("33 valid meld points");
    vi.mocked(api.broadcastTimeline).mockResolvedValue({ frames: [first, next], nextCursor: null });
    act(() => FakeEventSource.instances[0]!.emit("frame", { frame: next }));
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("0 natural 21");
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("36 valid meld points");
    await user.click(screen.getByRole("button", { name: "Previous move" }));
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("1 natural 21");
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("33 valid meld points");
    await user.click(screen.getByRole("button", { name: "Go to delayed live" }));
    expect(within(hand).getByLabelText("Asha's meld counts")).toHaveTextContent("0 natural 21");
    expect(within(hand).getByRole("list", { name: "Asha's cards" }).querySelectorAll("img")).toHaveLength(13);
    expect(api.liveBroadcast).toHaveBeenCalledTimes(1);
  });
});
