import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, GamePublicState } from "@trinitymatrix/protocol";
import { GameTable } from "./GameTable";

const turnSoundMocks = vi.hoisted(() => ({
  getTurnSoundsEnabled: vi.fn(() => true),
  setTurnSoundsEnabled: vi.fn(),
  unlockTurnSounds: vi.fn(async () => true),
  playTurnStarted: vi.fn(),
  playTurnEnded: vi.fn()
}));

vi.mock("../audio/turnSounds", () => turnSoundMocks);

const card = (id: string, suit: Card["suit"], rank: number, deck = 1): Card => ({
  id,
  deck,
  suit,
  rank,
  printedJoker: false
});

function game(cardCount: number): GamePublicState {
  return {
    gameId: "00000000-0000-4000-8000-000000000100",
    gameName: "amber-cobra-00000000",
    matchType: "general",
    playerCount: 2,
    players: [
      { id: "p1", displayName: "Asha", badgeId: "rookie", connected: true, cardCount, status: "playing" },
      { id: "p2", displayName: "Kabir", badgeId: "strategist", connected: true, cardCount: 13, status: "playing" }
    ],
    currentPlayerId: "p1",
    topDiscard: null,
    wildRank: 8,
    stockCount: 20,
    turnEndsAt: Date.now() + 45_000,
    phase: "playing",
    showdown: null,
    revision: 1,
    toss: null
  };
}

function saveLayout(hand: readonly Card[], groups: string[][], showCardId: string): void {
  window.sessionStorage.setItem("trinitymatrix:hand-layout:00000000-0000-4000-8000-000000000100:p1", JSON.stringify({
    gameId: "00000000-0000-4000-8000-000000000100",
    groups,
    showCardId
  }));
  expect(hand.map(({ id }) => id).sort()).toEqual([...groups.flat(), showCardId].sort());
}

const actions = {
  onDraw: vi.fn(),
  onDiscard: vi.fn(),
  onDeclare: vi.fn(),
  onSubmitHand: vi.fn((_groups: string[][]) => true),
  onDropGame: vi.fn(() => true),
  onReturnToLobby: vi.fn()
};

beforeEach(() => {
  window.sessionStorage.clear();
  Object.values(actions).forEach((mock) => mock.mockClear());
});

describe("GameTable", () => {
  it("labels general games as ranked and private games as unranked", () => {
    const general = game(13);
    const { rerender } = render(<GameTable {...actions} game={general} hand={[]} playerId="p1" notice="Connected." winner={null} />);
    expect(screen.getByText("General · ranked · 2 players")).toBeInTheDocument();

    rerender(<GameTable {...actions} game={{ ...general, matchType: "private" }} hand={[]} playerId="p1" notice="Connected." winner={null} />);
    expect(screen.getByText("Private · unranked · 2 players")).toBeInTheDocument();
  });

  it("plays distinct cues as the local turn starts and ends, with a mute control", async () => {
    Object.values(turnSoundMocks).forEach((mock) => mock.mockClear());
    const user = userEvent.setup();
    const initial = game(13);
    const { rerender } = render(<GameTable {...actions} game={initial} hand={[]} playerId="p1" notice="Connected." winner={null} />);

    expect(turnSoundMocks.playTurnStarted).toHaveBeenCalledOnce();
    expect(turnSoundMocks.playTurnEnded).not.toHaveBeenCalled();

    rerender(<GameTable {...actions} game={{
      ...initial,
      currentPlayerId: "p2",
      revision: 2,
      turnEndsAt: initial.turnEndsAt + 45_000
    }} hand={[]} playerId="p1" notice="Waiting." winner={null} />);
    expect(turnSoundMocks.playTurnEnded).toHaveBeenCalledOnce();

    rerender(<GameTable {...actions} game={{
      ...initial,
      currentPlayerId: "p1",
      revision: 3,
      turnEndsAt: initial.turnEndsAt + 90_000
    }} hand={[]} playerId="p1" notice="Your turn." winner={null} />);
    expect(turnSoundMocks.playTurnStarted).toHaveBeenCalledTimes(2);

    const soundToggle = screen.getByRole("button", { name: "Turn sounds" });
    expect(soundToggle).toHaveAttribute("aria-pressed", "true");
    await user.click(soundToggle);
    expect(turnSoundMocks.setTurnSoundsEnabled).toHaveBeenCalledWith(false);
    expect(soundToggle).toHaveAttribute("aria-pressed", "false");
  });

  it("recreates the original stable suit grouping without reordering ranks", async () => {
    const user = userEvent.setup();
    const hand = [
      card("heart-5", "hearts", 5),
      card("spade-9", "spades", 9),
      card("heart-2", "hearts", 2),
      card("spade-3", "spades", 3)
    ];
    const { container } = render(<GameTable {...actions} game={game(hand.length)} hand={hand} playerId="p1" notice="Connected." winner={null} />);

    await user.click(screen.getByRole("button", { name: "Sort by suit" }));
    const groups = container.querySelectorAll(".hand-group");
    expect(groups).toHaveLength(2);
    const spades = within(groups[0] as HTMLElement).getAllByRole("button", { name: /of spades/i });
    expect(spades[0]).toHaveAccessibleName(/9 of spades/i);
    expect(spades[1]).toHaveAccessibleName(/3 of spades/i);
  });

  it("labels groups from live meld validation instead of alternating decorative colors", () => {
    const hand = [
      card("heart-3", "hearts", 3),
      card("heart-4", "hearts", 4),
      card("heart-5", "hearts", 5),
      card("spade-9", "spades", 9),
      card("spade-10", "spades", 10),
      card("wild-8", "diamonds", 8),
      card("club-9", "clubs", 9),
      card("diamond-9", "diamonds", 9),
      card("heart-9", "hearts", 9),
      card("club-2", "clubs", 2),
      card("club-5", "clubs", 5),
      card("club-7", "clubs", 7),
      card("spade-1", "spades", 1),
      card("spade-13", "spades", 13)
    ];
    window.sessionStorage.setItem("trinitymatrix:hand-layout:00000000-0000-4000-8000-000000000100:p1", JSON.stringify({
      gameId: "00000000-0000-4000-8000-000000000100",
      groups: [
        ["heart-3", "heart-4", "heart-5"],
        ["spade-9", "spade-10", "wild-8"],
        ["club-9", "diamond-9", "heart-9"],
        ["club-2", "club-5", "club-7"],
        ["spade-1", "spade-13"]
      ],
      showCardId: null
    }));

    const { container } = render(<GameTable {...actions} game={game(hand.length)} hand={hand} playerId="p1" notice="Connected." winner={null} />);

    expect(screen.getByRole("group", { name: /group 1, 3 cards: valid · 12/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /group 2, 3 cards: valid · 27/i })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /group 2, 3 cards: trinity · 21/i })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /group 3, 3 cards: valid · 27/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /group 4, 3 cards: invalid meld/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /group 5, 2 cards: incomplete/i })).toBeInTheDocument();
    expect(container.querySelector(".hand-group:nth-child(2)")).toHaveClass("meld-meld");
    expect(container.querySelector(".hand-group:nth-child(4)")).toHaveClass("meld-invalid");
  });

  it("supports selected-card grouping and the confirmed show workflow", async () => {
    const user = userEvent.setup();
    const suits = ["clubs", "diamonds", "hearts", "spades"] as const;
    const hand = Array.from({ length: 14 }, (_, index) => card(
      `card-${index}`,
      suits[index % suits.length]!,
      (index % 13) + 1,
      index > 12 ? 2 : 1
    ));
    const { container } = render(<GameTable {...actions} game={game(14)} hand={hand} playerId="p1" notice="Your turn." winner={null} />);

    const playingCards = screen.getAllByRole("button", { name: /rearrange/i });
    await user.click(playingCards[0]!);
    await user.click(playingCards[1]!);
    await user.click(screen.getByRole("button", { name: "Group selected" }));
    expect(container.querySelectorAll(".hand-group")).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: /rearrange/i })[0]!);
    await user.click(screen.getByRole("button", { name: "Show selected" }));
    expect(screen.getByRole("dialog", { name: /use this as your final discard/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, prepare show" }));
    expect(screen.getByRole("button", { name: /staged to show/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel show" })).toBeInTheDocument();
  });

  it("keeps Declare disabled and explains the exact declaration rule that is still unmet", () => {
    const hand = [
      card("clubs-2", "clubs", 2),
      card("diamonds-2", "diamonds", 2),
      card("hearts-2", "hearts", 2),
      card("clubs-3", "clubs", 3),
      card("diamonds-3", "diamonds", 3),
      card("hearts-3", "hearts", 3),
      card("clubs-4", "clubs", 4),
      card("diamonds-4", "diamonds", 4),
      card("hearts-4", "hearts", 4),
      card("clubs-5", "clubs", 5),
      card("diamonds-5", "diamonds", 5),
      card("hearts-5", "hearts", 5),
      card("spades-5", "spades", 3),
      card("show-card", "spades", 13)
    ];
    saveLayout(hand, [
      ["clubs-2", "diamonds-2", "hearts-2"],
      ["clubs-3", "diamonds-3", "hearts-3"],
      ["clubs-4", "diamonds-4", "hearts-4"],
      ["clubs-5", "diamonds-5", "hearts-5", "spades-5"]
    ], "show-card");

    render(<GameTable {...actions} game={game(14)} hand={hand} playerId="p1" notice="Your turn." winner={null} />);

    expect(screen.getByRole("button", { name: "Declare" })).toBeDisabled();
    expect(screen.getByText("A declaration needs at least one natural meld totaling exactly 21; jokers and wild cards cannot be used in it.")).toBeInTheDocument();
  });

  it("enables Declare only when the staged hand passes shared declaration validation", async () => {
    const user = userEvent.setup();
    const groups = [
      ["clubs-a", "spades-10", "hearts-q"],
      ["hearts-3", "hearts-6", "hearts-9"],
      ["diamonds-2", "diamonds-4", "diamonds-6"],
      ["spades-2", "spades-4", "spades-6", "spades-9"]
    ];
    const hand = [
      card("clubs-a", "clubs", 1),
      card("spades-10", "spades", 10),
      card("hearts-q", "hearts", 12),
      card("hearts-3", "hearts", 3),
      card("hearts-6", "hearts", 6),
      card("hearts-9", "hearts", 9),
      card("diamonds-2", "diamonds", 2),
      card("diamonds-4", "diamonds", 4),
      card("diamonds-6", "diamonds", 6),
      card("spades-2", "spades", 2),
      card("spades-4", "spades", 4),
      card("spades-6", "spades", 6),
      card("spades-9", "spades", 9),
      card("show-card", "diamonds", 5)
    ];
    saveLayout(hand, groups, "show-card");

    render(<GameTable {...actions} game={game(14)} hand={hand} playerId="p1" notice="Your turn." winner={null} />);

    const declare = screen.getByRole("button", { name: "Declare" });
    expect(declare).toBeEnabled();
    await user.click(declare);
    expect(actions.onDeclare).toHaveBeenCalledWith("show-card", groups);
  });

  it("coordinates declarer and responder views through arrange, submit, and the final result", async () => {
    const user = userEvent.setup();
    const hand = Array.from({ length: 13 }, (_, index) => card(
      `response-${index}`,
      (["clubs", "diamonds", "hearts", "spades"] as const)[index % 4]!,
      (index % 13) + 1
    ));
    const showdownState: GamePublicState = {
      ...game(13),
      phase: "showdown",
      players: [
        { id: "p1", displayName: "Asha", badgeId: "rookie", connected: true, cardCount: 13, status: "declared" },
        { id: "p2", displayName: "Kabir", badgeId: "strategist", connected: true, cardCount: 13, status: "playing" }
      ],
      turnEndsAt: Date.now() - 5_000,
      showdown: {
        declarerId: "p1",
        pendingPlayerIds: ["p2"],
        submittedPlayerIds: [],
        endsAt: Date.now() + 30_000
      },
      revision: 8
    };
    const finalWinner = { id: "p1", name: "Asha", reason: "declaration" as const };

    const declarer = render(<GameTable {...actions} game={showdownState} hand={hand} playerId="p1" notice="Declaration accepted." winner={null} />);
    expect(screen.getByText("Waiting for 1 player")).toBeInTheDocument();
    expect(screen.getByText(/Your declaration was accepted/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Arrange your 13 cards/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Asha's turn/i)).not.toBeInTheDocument();
    expect(screen.queryByText("0s", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drop game" })).not.toBeInTheDocument();
    declarer.rerender(<GameTable {...actions} game={showdownState} hand={hand} playerId="p1" notice="Asha won." winner={finalWinner} />);
    expect(screen.getByRole("dialog", { name: "You won!" })).toBeInTheDocument();
    declarer.unmount();

    const responder = render(<GameTable {...actions} game={showdownState} hand={hand} playerId="p2" notice="Asha declared." winner={null} />);
    const prompt = screen.getByRole("dialog", { name: "Asha declared. Arrange your 13 cards." });
    expect(prompt).toHaveTextContent("Drawing and discarding have ended");
    expect(screen.getByRole("button", { name: /Closed deck/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Open deck/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Show here/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Arrange my hand" }));
    expect(screen.queryByRole("dialog", { name: /Arrange your 13 cards/i })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Your hand (13)" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Sort by suit" })).toBeEnabled();

    const responseCards = screen.getAllByRole("button", { name: /rearrange/i });
    await user.click(responseCards[0]!);
    await user.click(responseCards[1]!);
    await user.click(screen.getByRole("button", { name: "Group selected" }));
    await user.click(screen.getByRole("button", { name: "Submit arranged hand" }));
    expect(actions.onSubmitHand).toHaveBeenCalledOnce();
    const submittedGroups = actions.onSubmitHand.mock.calls[0]![0];
    expect(submittedGroups.flat().sort()).toEqual(hand.map(({ id }) => id).sort());
    expect(new Set(submittedGroups.flat()).size).toBe(hand.length);

    responder.rerender(<GameTable {...actions} game={{
      ...showdownState,
      showdown: { ...showdownState.showdown!, pendingPlayerIds: [], submittedPlayerIds: ["p2"] },
      revision: 9
    }} hand={hand} playerId="p2" notice="Hand submitted." winner={null} />);
    expect(screen.getAllByText("Finalizing result").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Submit arranged hand" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /rearrange/i })[0]).toBeDisabled();

    responder.rerender(<GameTable {...actions} game={showdownState} hand={hand} playerId="p2" notice="Asha won." winner={finalWinner} />);
    expect(screen.getByRole("dialog", { name: "Asha won" })).toBeInTheDocument();
  });

  it("replaces an expired showdown timer with a finalizing state instead of a frozen 0s turn", () => {
    const expired: GamePublicState = {
      ...game(13),
      phase: "showdown",
      showdown: {
        declarerId: "p1",
        pendingPlayerIds: ["p2"],
        submittedPlayerIds: [],
        endsAt: Date.now() - 1_000
      }
    };

    render(<GameTable {...actions} game={expired} hand={[]} playerId="p2" notice="Waiting." winner={null} />);

    expect(screen.getAllByText("Finalizing result").length).toBeGreaterThan(0);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByText("0s", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/turn$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Arrange your 13 cards/i })).not.toBeInTheDocument();
  });

  it("traps focus in cancellable game dialogs, closes them with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    const hand = Array.from({ length: 14 }, (_, index) => card(
      `card-${index}`,
      (["clubs", "diamonds", "hearts", "spades"] as const)[index % 4]!,
      (index % 13) + 1,
      index > 12 ? 2 : 1
    ));
    render(<GameTable {...actions} game={game(14)} hand={hand} playerId="p1" notice="Your turn." winner={null} />);

    await user.click(screen.getAllByRole("button", { name: /rearrange/i })[0]!);
    const showOpener = screen.getByRole("button", { name: "Show selected" });
    await user.click(showOpener);

    const keepArranging = screen.getByRole("button", { name: "No, keep arranging" });
    const prepareShow = screen.getByRole("button", { name: "Yes, prepare show" });
    expect(keepArranging).toHaveFocus();
    await user.tab({ shift: true });
    expect(prepareShow).toHaveFocus();
    await user.tab();
    expect(keepArranging).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: /use this as your final discard/i })).not.toBeInTheDocument();
    expect(showOpener).toHaveFocus();

    const dropOpener = screen.getByRole("button", { name: "Drop game" });
    await user.click(dropOpener);
    const keepPlaying = screen.getByRole("button", { name: "Keep playing" });
    const confirmDrop = screen.getByRole("button", { name: "Yes, drop and lose" });
    expect(keepPlaying).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmDrop).toHaveFocus();
    await user.tab();
    expect(keepPlaying).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Drop this game?" })).not.toBeInTheDocument();
    expect(dropOpener).toHaveFocus();
  });

  it("requires confirmation before dropping the game", async () => {
    const user = userEvent.setup();
    const hand = [card("heart-5", "hearts", 5)];
    render(<GameTable {...actions} game={game(hand.length)} hand={hand} playerId="p1" notice="Connected." winner={null} />);

    await user.click(screen.getByRole("button", { name: "Drop game" }));
    expect(screen.getByRole("dialog", { name: "Drop this game?" })).toHaveTextContent("Kabir will win immediately");
    await user.click(screen.getByRole("button", { name: "Keep playing" }));
    expect(actions.onDropGame).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Drop game" }));
    await user.click(screen.getByRole("button", { name: "Yes, drop and lose" }));
    expect(actions.onDropGame).toHaveBeenCalledOnce();
  });
});
