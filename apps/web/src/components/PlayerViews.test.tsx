import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthPlayer } from "../api";
import { MatchHistoryView, RankingsView } from "./PlayerViews";

const player: AuthPlayer = {
  id: "p1",
  email: "asha@example.com",
  displayName: "Asha",
  badgeId: "strategist",
  phone: null,
  createdAt: 1,
  updatedAt: 1
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("player portal views", () => {
  it("loads an accessible leaderboard and identifies the current player", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ rankings: [
      { rank: 1, playerId: "p2", displayName: "Kabir", badgeId: "champion", rating: 1540, wins: 9, gamesPlayed: 12 },
      { rank: 2, playerId: "p1", displayName: "Asha", badgeId: "strategist", rating: 1480, wins: 7, gamesPlayed: 10 }
    ] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RankingsView playerId="p1" />);

    expect(await screen.findByRole("table", { name: "Current ranking standings" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /#2.*Asha.*You.*1480.*7.*10.*70%/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/rankings", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("opens a completed match with its event replay and post-game chat", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me/history") return new Response(JSON.stringify({ games: [{
        gameName: "rank-2048",
        finishedAt: "2026-08-23T08:02:00Z",
        playerCount: 2,
        result: "won",
        winnerName: "Asha",
        matchType: "private",
        score: 0,
        rankDelta: 18
      }] }), { status: 200 });
      if (url.endsWith("/replay")) return new Response(JSON.stringify({
        gameName: "rank-2048",
        players: [{ playerId: "p1", displayName: "Asha" }],
        events: [
          { sequence: 1, at: "2026-08-23T08:00:00Z", type: "game.started", summary: "Cards were dealt." },
          { sequence: 2, at: "2026-08-23T08:02:00Z", type: "game.ended", summary: "Asha won the game." }
        ]
      }), { status: 200 });
      if (url.endsWith("/chat")) return new Response(JSON.stringify({ messages: [], remaining: 3 }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MatchHistoryView player={player} />);

    const replayButton = await screen.findByRole("button", { name: "Replay and chat" });
    expect(screen.getByText("Private · Unranked · 2 players")).toBeInTheDocument();
    await user.click(replayButton);
    expect(screen.getByRole("button", { name: /back to match history/i })).toHaveFocus();
    expect(screen.getByText("Completed game · Private · Unranked")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Cards were dealt." })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Good game, in three messages" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Asha won the game." })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back to match history/i }));
    expect(screen.getByRole("heading", { name: "Match history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay and chat" })).toHaveFocus();
  });

  it("waits for a just-finished dropped game to reach durable history before opening replay", async () => {
    vi.useFakeTimers();
    let historyRequests = 0;
    const completedGame = {
      gameName: "swift-tiger-00000042",
      finishedAt: "2026-08-25T08:02:00Z",
      playerCount: 2,
      result: "dropped",
      winnerName: "Kabir",
      matchType: "general"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me/history") {
        historyRequests += 1;
        return new Response(JSON.stringify({ games: historyRequests === 1 ? [] : [completedGame] }), { status: 200 });
      }
      if (url.endsWith("/replay")) return new Response(JSON.stringify({
        gameName: completedGame.gameName,
        players: [{ playerId: "p1", displayName: "Asha" }],
        events: [{ sequence: 1, at: completedGame.finishedAt, type: "game.ended", summary: "Kabir won the game." }]
      }), { status: 200 });
      if (url.endsWith("/chat")) return new Response(JSON.stringify({ messages: [], remaining: 3 }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<MatchHistoryView player={player} initialGameName={completedGame.gameName} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("Saving completed match…");
    expect(historyRequests).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(historyRequests).toBe(2);
    expect(screen.getByText("Completed game · General · Ranked")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Good game, in three messages" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No completed matches" })).not.toBeInTheDocument();

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(historyRequests).toBe(2);
  });
});
