import { describe, expect, it } from "vitest";
import type { AiAgentDecision, AiAgentObservation } from "./ai-openrouter";
import { AI_VALIDATION_TOOL_VERSION } from "./ai-game-protocol-v3";
import { validateAiProposal } from "./ai-proposal-validation";
import { missedWinDeclaration, missedWinHand14, missedWinWildRank } from "./ai-missed-win.fixture";

const playerId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
function observation(): AiAgentObservation {
  return { playerId, hand: structuredClone(missedWinHand14), state: {
    gameId: "00000000-0000-4000-8000-000000000003", gameName: "test-game", playerCount: 2, matchType: "general",
    players: [playerId, otherId].map((id) => ({ id, displayName: "Player", badgeId: "rookie", connected: true,
      cardCount: id === playerId ? 14 : 13, status: "playing" })),
    phase: "playing", currentPlayerId: playerId, topDiscard: null, stockCount: 60,
    wildRank: missedWinWildRank, revision: 4, turnEndsAt: Date.now() + 45000, showdown: null, toss: null
  } };
}
function decision(overrides: Partial<AiAgentDecision> = {}): AiAgentDecision {
  return { action: "declare", cardId: missedWinDeclaration.cardId, groups: structuredClone(missedWinDeclaration.groups), memory: "", ...overrides };
}

describe("proposal-only AI validation", () => {
  it("accepts a model-found winning declaration and a chosen discard from the same winning hand without hints", () => {
    expect(validateAiProposal(observation(), decision())).toEqual({ valid: true });
    expect(validateAiProposal(observation(), decision({ action: "discard", groups: [] }))).toEqual({ valid: true });
  });

  it("explains only an invalid proposed grouping even though another grouping would win", () => {
    const chosen = decision(); chosen.groups = [chosen.groups.flat()];
    const result = validateAiProposal(observation(), chosen);
    expect(result).toEqual({ valid: false, validation: { toolVersion: AI_VALIDATION_TOOL_VERSION, code: "invalid-declaration",
      message: "Meld 1 is invalid. Use 3+ cards, a permitted suit pattern, and a total from 3 to 27 in steps of 3." } });
    expect(JSON.stringify(result)).not.toMatch(/winning-card|groups|score|available|readyHand/);
  });

  it.each(["foreign-card", "repeated-card", "discard-in-groups"])("rejects an invalid reference without echoing private IDs: %s", (kind) => {
    const chosen = decision();
    if (kind === "foreign-card") chosen.groups[0]![0] = "PRIVATE_FOREIGN_CARD";
    if (kind === "repeated-card") chosen.groups[0]![1] = chosen.groups[0]![0]!;
    if (kind === "discard-in-groups") chosen.groups[0]![0] = chosen.cardId!;
    const result = validateAiProposal(observation(), chosen);
    expect(result).toMatchObject({ valid: false, validation: { code: kind === "discard-in-groups" ? "invalid-declaration" : "invalid-card-reference" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FOREIGN_CARD");
  });

  it("enforces draw-before-declare without discovering or revealing readiness", () => {
    const view = observation(); view.hand.pop(); view.state.players[0]!.cardCount = 13;
    expect(validateAiProposal(view, decision({ action: "draw-stock", cardId: null, groups: [] }))).toEqual({ valid: true });
    expect(validateAiProposal(view, decision())).toMatchObject({ valid: false, validation: { code: "invalid-decision" } });
    expect(validateAiProposal(view, decision({ action: "draw-discard", cardId: null, groups: [] })))
      .toMatchObject({ valid: false, validation: { code: "invalid-decision", message: "A draw-discard action requires a visible top discard." } });
  });

  it("requires every card in showdown but permits unmatched groups rather than proposing a layout", () => {
    const view = observation(); view.hand.pop(); view.state.phase = "showdown";
    view.state.showdown = { declarerId: otherId, pendingPlayerIds: [playerId], submittedPlayerIds: [], endsAt: Date.now() + 45000 };
    const chosen = decision({ action: "submit-hand", cardId: null, groups: view.hand.map(({ id }) => [id]) });
    expect(validateAiProposal(view, chosen)).toEqual({ valid: true });
    chosen.groups.pop();
    expect(validateAiProposal(view, chosen)).toMatchObject({ valid: false, validation: { code: "invalid-decision" } });
    view.state.showdown.pendingPlayerIds = [];
    expect(validateAiProposal(view, chosen)).toMatchObject({ valid: false, validation: { code: "invalid-decision" } });
  });

  it("rejects ordinary move layouts, off-turn moves and invalid shapes without substituting a move", () => {
    const view = observation();
    expect(validateAiProposal(view, decision({ action: "discard" }))).toMatchObject({ valid: false, validation: { code: "invalid-decision" } });
    view.state.currentPlayerId = otherId;
    expect(validateAiProposal(view, decision())).toMatchObject({ valid: false, validation: { code: "invalid-decision" } });
    expect(validateAiProposal(view, { ...decision(), groups: null } as unknown as AiAgentDecision))
      .toMatchObject({ valid: false, validation: { code: "invalid-decision" } });
  });
});
