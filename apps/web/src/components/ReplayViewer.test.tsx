import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { GameReplay } from "../api";
import { ReplayViewer } from "./ReplayViewer";

const replay: GameReplay = {
  gameName: "rank-2048",
  players: [{ playerId: "p1", displayName: "Asha" }, { playerId: "p2", displayName: "Kabir" }],
  winnerName: "Asha",
  events: [
    { sequence: 1, at: "2026-08-23T08:00:00Z", type: "game.started", summary: "Cards were dealt." },
    { sequence: 2, at: "2026-08-23T08:00:05Z", type: "card.drawn", actorName: "Asha", summary: "Asha drew from the closed deck.", state: { currentPlayerName: "Asha", stockCount: 17 } },
    { sequence: 3, at: "2026-08-23T08:01:00Z", type: "game.ended", actorName: "Asha", summary: "Asha declared a valid hand." }
  ]
};

describe("ReplayViewer", () => {
  it("provides first, previous, play, next, last, speed, timeline, and event-list controls", async () => {
    const user = userEvent.setup();
    render(<ReplayViewer replay={replay} />);

    expect(screen.getByRole("heading", { name: "Cards were dealt." })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Replay event 1 of 3: Cards were dealt.");
    expect(screen.getByRole("heading", { name: "Cards were dealt." }).closest(".replay-stage")).not.toHaveAttribute("aria-live");
    expect(screen.getByRole("slider", { name: /replay timeline/i })).toHaveAttribute("max", "2");
    expect(screen.getByRole("combobox", { name: /speed/i })).toHaveValue("1");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Asha drew from the closed deck." })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Replay event 2 of 3: Asha drew from the closed deck.");
    expect(screen.getByText("17 cards")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Last" }));
    expect(screen.getByRole("heading", { name: "Asha declared a valid hand." })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "First" }));
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.selectOptions(screen.getByRole("combobox", { name: /speed/i }), "2");
    expect(screen.getByRole("combobox", { name: /speed/i })).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Play" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows grouped melds, hand progress, layout provenance, and an unmistakable winner", () => {
    const groupedReplay: GameReplay = {
      gameName: "amber-peacock-40920655",
      winnerName: "abhi",
      reason: "declaration",
      players: [{ playerId: "p1", displayName: "Saurabh" }, { playerId: "p2", displayName: "abhi" }],
      events: [{
        sequence: 1,
        at: "2026-08-26T06:44:59Z",
        type: "game.declare",
        actorName: "abhi",
        summary: "abhi declared",
        state: {
          phase: "showdown",
          wildRank: 9,
          players: [{
            playerId: "p2",
            displayName: "abhi",
            status: "declared",
            cardCount: 3,
            isWinner: true,
            layoutSource: "recorded",
            cards: [
              { id: "ca", deck: 1, suit: "clubs", rank: 1, printedJoker: false, label: "A♣", wild: false },
              { id: "s10", deck: 1, suit: "spades", rank: 10, printedJoker: false, label: "10♠", wild: false },
              { id: "hq", deck: 1, suit: "hearts", rank: 12, printedJoker: false, label: "Q♥", wild: false }
            ],
            groups: [{
              kind: "trinity",
              label: "Trinity · 21",
              total: 21,
              cards: [
                { id: "ca", deck: 1, suit: "clubs", rank: 1, printedJoker: false, label: "A♣", wild: false },
                { id: "s10", deck: 1, suit: "spades", rank: 10, printedJoker: false, label: "10♠", wild: false },
                { id: "hq", deck: 1, suit: "hearts", rank: 12, printedJoker: false, label: "Q♥", wild: false }
              ]
            }],
            progress: {
              matchedCardCount: 3,
              totalCardCount: 3,
              trinityMeldCount: 1,
              validMeldCount: 1,
              score: 21,
              declarationReady: true
            }
          }]
        }
      }]
    };

    render(<ReplayViewer replay={groupedReplay} />);

    expect(screen.getByLabelText("Winner: abhi")).toHaveTextContent("abhi");
    expect(screen.getByText(/3 of 3 cards grouped/i)).toBeInTheDocument();
    const trinity = screen.getByRole("group", { name: "Trinity · 21, 3 cards" });
    expect(within(trinity).getByText("A♣")).toBeInTheDocument();
    expect(within(trinity).getByText("10♠")).toBeInTheDocument();
    expect(within(trinity).getByText("Q♥")).toBeInTheDocument();
    expect(screen.getByText(/recorded player layout/i)).toBeInTheDocument();
  });
});
