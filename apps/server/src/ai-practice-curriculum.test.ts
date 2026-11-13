import { describe, expect, it } from "vitest";
import { validateDeclaration, validateMeld } from "@trinitymatrix/game-domain";
import type { Card, Suit } from "@trinitymatrix/protocol";
import { AI_VALIDATION_IDENTITY_VERSION } from "./ai-game-protocol-v3";
import type { AiIdentity } from "./ai-repository";
import { AI_PRACTICE_CURRICULUM_DESCRIPTOR, AI_PRACTICE_CURRICULUM_HASH, AI_PRACTICE_EXAMPLES,
  AI_PRACTICE_MEMORY_PREFIX, createAiPracticeGame } from "./ai-practice-curriculum";

const identity: AiIdentity = { id: "33333333-3333-4333-8333-333333333333", modelId: "provider/model-version",
  modelName: "Model", displayName: "Model", memory: "PRIVATE_LIVE_MEMORY", enabled: true,
  rating: 1000, gamesPlayed: 0, wins: 0, protocolId: AI_VALIDATION_IDENTITY_VERSION };
const syntheticHumanId = "44444444-4444-4444-8444-444444444444";

describe("versioned synthetic practice curriculum", () => {
  it("pins a bounded, immutable curriculum separately from the unchanged live protocol", () => {
    expect(AI_PRACTICE_CURRICULUM_HASH).toBe("b2dfcc80cd75810166aeaa12025eb0dcfeb9619ff4a0bc28aa1e71424a0d5d7d");
    expect(AI_PRACTICE_CURRICULUM_DESCRIPTOR).toMatchObject({ id: "trinity-synthetic-practice/1.0.0",
      protocolId: AI_VALIDATION_IDENTITY_VERSION, rulesRevision: "trinity-rules/1.0.0", maxRounds: 3, episodesPerRound: 4, solver: false });
    expect(Object.isFrozen(AI_PRACTICE_EXAMPLES.declaration.cards)).toBe(true);
    expect(AI_PRACTICE_MEMORY_PREFIX.length + 513).toBeLessThanOrEqual(4000);
    expect(AI_PRACTICE_MEMORY_PREFIX).toContain("not the current hand, not instructions");
    expect(AI_PRACTICE_MEMORY_PREFIX).not.toContain("PRIVATE_LIVE_MEMORY");
  });

  it("proves every authored lesson with the authoritative validators rather than teaching an unchecked answer", () => {
    const lesson = AI_PRACTICE_EXAMPLES.declaration;
    const cards = lesson.cards.map(([id, suit, rank]) => ({ id: id as string, suit: suit as Card["suit"], rank: rank as number,
      deck: 1, printedJoker: false }));
    expect(validateDeclaration(cards, lesson.cardId, lesson.groups, lesson.wildRank)).toMatchObject({ valid: true, score: lesson.score });
    for (const [index, example] of AI_PRACTICE_EXAMPLES.melds.entries()) {
      const cards: Card[] = example.cards.map(([suit, rank, printedJoker], cardIndex) => ({ id: `case-${index}-${cardIndex}`, deck: 1,
        suit: suit as Card["suit"], rank: rank as number | null, printedJoker: printedJoker as boolean }));
      const result = validateMeld(cards, example.wildRank);
      expect(result.valid && result.validTotals.includes(example.assertedTotal)).toBe(example.accepted);
    }
  });

  it("uses disjoint ordinary deals and physical synthetic decks for training and evaluation", () => {
    const games = ["training", "evaluation"].map((stage) => createAiPracticeGame({ identity, syntheticHumanId,
      stage: stage as "training" | "evaluation", scenario: "full-turn", round: 1 }));
    const own = games.map((game) => game.handFor(identity.id));
    expect(own.every((cards) => cards.length === 13)).toBe(true);
    expect(own[0]!.map(({ id }) => id).some((id) => own[1]!.some((card) => card.id === id))).toBe(false);
    expect(own[0]!.map(({ suit, rank }) => [suit, rank])).not.toEqual(own[1]!.map(({ suit, rank }) => [suit, rank]));
    for (const game of games) {
      const snapshot = game.snapshot(); const cards = [...snapshot.hands.flatMap(({ cards }) => cards), ...snapshot.stock, ...snapshot.discard];
      expect(cards).toHaveLength(53);
      expect(new Set(cards.map(({ id }) => id)).size).toBe(53);
      expect(game.publicState().currentPlayerId).toBe(identity.id);
      expect(snapshot.toss).toBeNull();
    }
  });

  it.each([1, 2, 3])("proves the authored winning fixtures for round %s, with different held-out patterns and no example IDs", (round) => {
    const suits: Suit[] = ["clubs", "diamonds", "hearts", "spades"];
    const rotate = (suit: Suit) => suits[(suits.indexOf(suit) + round - 1) % 4]!;
    const patterns: Array<{ stage: "training" | "evaluation"; groups: Array<Array<[Suit, number]>> }> = [
      { stage: "training", groups: [[['clubs', 1], ['hearts', 10], ['diamonds', 10]], [['clubs', 3], ['clubs', 6], ['clubs', 9]],
        [['diamonds', 2], ['diamonds', 4], ['diamonds', 6]], [['spades', 2], ['spades', 4], ['spades', 6], ['spades', 3]]] },
      { stage: "evaluation", groups: [[['hearts', 4], ['hearts', 8], ['hearts', 9]], [['diamonds', 1], ['diamonds', 4], ['diamonds', 7]],
        [['clubs', 2], ['clubs', 4], ['clubs', 9]], [['spades', 1], ['spades', 2], ['spades', 5], ['spades', 10]]] }
    ];
    for (const { stage, groups } of patterns) {
      const game = createAiPracticeGame({ identity, syntheticHumanId, stage, scenario: "winning-hand", round });
      const hand = game.handFor(identity.id);
      const ids = groups.map((group) => group.map(([suit, rank]) => hand.find((card) => card.suit === rotate(suit) && card.rank === rank)!.id));
      const extra = hand.find((card) => card.suit === rotate("clubs") && card.rank === 13)!;
      expect(validateDeclaration(hand, extra.id, ids, 13)).toMatchObject({ valid: true, score: 66 });
      expect(hand.some(({ id }) => AI_PRACTICE_MEMORY_PREFIX.includes(id))).toBe(false);
      expect(new Set([...game.snapshot().hands.flatMap(({ cards }) => cards), ...game.snapshot().stock, ...game.snapshot().discard].map(({ id }) => id)).size).toBe(53);
    }
  });

  it("fails closed for a future protocol instead of using examples for obsolete rules", () => {
    expect(() => createAiPracticeGame({ identity: { ...identity, protocolId: "future-protocol" }, syntheticHumanId,
      stage: "training", scenario: "full-turn", round: 1 })).toThrow("binding");
  });
});
