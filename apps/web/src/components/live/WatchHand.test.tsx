import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import * as domain from "@trinitymatrix/game-domain";
import { WatchHand } from "./WatchHand";
import { recordedCards, recordedLayout } from "./watch-hand.fixtures";

describe("spectator grouped hand presentation", () => {
  it("shows labelled recorded group boundaries, point totals, card counts and non-color statuses", () => {
    render(<WatchHand hand={{ cards: recordedCards, layout: recordedLayout }} wildRank={13} displayName="Asha" />);
    expect(screen.getByText("Recorded grouping")).toBeInTheDocument();
    const summary = screen.getByLabelText("Asha's meld counts");
    for (const text of ["6 of 13", "2 valid melds", "2 invalid melds", "7 unmatched cards", "1 natural 21", "33 valid meld points"]) expect(summary).toHaveTextContent(text);
    const trinity = screen.getByRole("group", { name: "Group 1: Natural 21 · Trinity, 3 cards" });
    expect(trinity).toHaveTextContent("3 cards · 21 points");
    expect(within(trinity).getAllByRole("img")).toHaveLength(3);
    expect(screen.getByRole("group", { name: /Group 3: Invalid meld · need 3\+/ })).toHaveTextContent("2 cards · No valid meld total");
    expect(within(screen.getByRole("list", { name: "Asha's cards" })).getAllByRole("img")).toHaveLength(13);
  });

  it("labels suggestions honestly and memoizes unchanged hands across unrelated rerenders", () => {
    const organize = vi.spyOn(domain, "organizeHand");
    const cards = recordedCards.slice(0, 3);
    const { rerender } = render(<WatchHand hand={{ cards }} wildRank={13} displayName="Asha" />);
    expect(screen.getByText("Suggested grouping")).toBeInTheDocument();
    expect(screen.getByText(/not the player’s arrangement/)).toBeInTheDocument();
    rerender(<WatchHand hand={{ cards: cards.map((card) => ({ ...card })) }} wildRank={13} displayName="Asha updated" />);
    expect(organize).toHaveBeenCalledTimes(1);
    rerender(<WatchHand hand={{ cards }} wildRank={7} displayName="Asha updated" />);
    expect(organize).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Natural 21 · Trinity")).not.toBeInTheDocument();
    rerender(<WatchHand hand={{ cards }} wildRank={13} displayName="Asha updated" />);
    expect(organize).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Natural 21 · Trinity")).toBeInTheDocument();
    organize.mockRestore();
  });
});
