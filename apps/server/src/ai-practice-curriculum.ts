import { createHash } from "node:crypto";
import { createDeck, validateDeclaration, validateMeld } from "@trinitymatrix/game-domain";
import type { Card, Suit } from "@trinitymatrix/protocol";
import { AI_GAME_RULES_REVISION } from "./ai-game-protocol";
import { AI_VALIDATION_IDENTITY_VERSION } from "./ai-game-protocol-v3";
import type { AiIdentity } from "./ai-repository";
import { RankingGame } from "./game";

export const AI_PRACTICE_CURRICULUM_ID = "trinity-synthetic-practice/1.0.0";
export const AI_PRACTICE_CURRICULUM_VERSION = AI_PRACTICE_CURRICULUM_ID;
export const AI_PRACTICE_RULES_REVISION = AI_GAME_RULES_REVISION;
export type AiPracticeStage = "training" | "evaluation";
export type AiPracticeScenario = "full-turn" | "winning-hand";

type Pattern = readonly (readonly [Suit, number])[];
const lessonPattern: readonly Pattern[] = [
  [["clubs", 6], ["clubs", 7], ["clubs", 8]],
  [["diamonds", 3], ["diamonds", 6], ["diamonds", 9]],
  [["hearts", 2], ["hearts", 5], ["hearts", 8]],
  [["spades", 2], ["spades", 5], ["spades", 7], ["spades", 10]]
];
const trainingPattern: readonly Pattern[] = [
  [["clubs", 1], ["hearts", 10], ["diamonds", 10]],
  [["clubs", 3], ["clubs", 6], ["clubs", 9]],
  [["diamonds", 2], ["diamonds", 4], ["diamonds", 6]],
  [["spades", 2], ["spades", 4], ["spades", 6], ["spades", 3]]
];
const evaluationPattern: readonly Pattern[] = [
  [["hearts", 4], ["hearts", 8], ["hearts", 9]],
  [["diamonds", 1], ["diamonds", 4], ["diamonds", 7]],
  [["clubs", 2], ["clubs", 4], ["clubs", 9]],
  [["spades", 1], ["spades", 2], ["spades", 5], ["spades", 10]]
];
const suitOrder: readonly Suit[] = ["clubs", "diamonds", "hearts", "spades"];
const fixturePolicy = {
  trainingSeeds: [94, 111, 128], evaluationSeeds: [393, 410, 427],
  trainingWinningPattern: trainingPattern, evaluationWinningPattern: evaluationPattern,
  wildRank: 13, winningExtra: ["clubs", 13], perRoundSuitRotation: true,
  fixtureCards: "single-complete-synthetic-deck-with-disjoint-stage-and-round-ids",
  solver: false, liveHandInputs: false
};

function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function patternCards(patterns: readonly Pattern[], prefix: string): Card[][] {
  let index = 0;
  return patterns.map((group) => group.map(([suit, rank]) => ({ id: `${prefix}-${++index}`, deck: 1, suit, rank, printedJoker: false })));
}
const lessonGroups = patternCards(lessonPattern, "lesson");
const lessonExtra: Card = { id: "lesson-discard", deck: 1, suit: "diamonds", rank: 4, printedJoker: false };
const lessonHand = [...lessonGroups.flat(), lessonExtra];
const lessonDeclaration = lessonGroups.map((group) => group.map(({ id }) => id));
const lessonValidation = validateDeclaration(lessonHand, lessonExtra.id, lessonDeclaration, 13);
if (!lessonValidation.valid) throw new Error("Synthetic declaration lesson failed authoritative validation.");

const natural = lessonGroups[0]!;
const joker: Card = { id: "lesson-joker", deck: 1, suit: null, rank: null, printedJoker: true };
const meldLessons = [
  { id: "natural-21", cards: natural, wildRank: 13, assertedTotal: 21, accepted: true },
  { id: "too-short", cards: natural.slice(0, 2), wildRank: 13, assertedTotal: 13, accepted: false },
  { id: "wild-rank-is-not-natural-21", cards: natural, wildRank: 7, assertedTotal: 21, accepted: false },
  { id: "joker-is-not-natural-21", cards: [natural[0]!, natural[2]!, joker], wildRank: 13, assertedTotal: 21, accepted: false },
  { id: "wrong-suit-pattern", cards: patternCards([[["clubs", 3], ["clubs", 6], ["diamonds", 9]]], "mixed")[0]!, wildRank: 13, assertedTotal: 18, accepted: false },
  { id: "over-27", cards: patternCards([[["clubs", 10], ["clubs", 11], ["clubs", 12]]], "over")[0]!, wildRank: 13, assertedTotal: 30, accepted: false }
];
for (const lesson of meldLessons) {
  const result = validateMeld(lesson.cards, lesson.wildRank);
  if ((result.valid && result.validTotals.includes(lesson.assertedTotal)) !== lesson.accepted) throw new Error("Synthetic meld lesson failed authoritative validation.");
}

/** Authored past examples only. These card IDs never occur in practice/evaluation games. */
export const AI_PRACTICE_EXAMPLES = freeze({
  kind: "synthetic-past-examples-data", curriculumId: AI_PRACTICE_CURRICULUM_ID,
  rulesRevision: AI_PRACTICE_RULES_REVISION, protocolId: AI_VALIDATION_IDENTITY_VERSION,
  notesPurpose: "Reusable rules and strategy lessons only; omit card IDs, full hands, names, groups and copied examples. Return memory of at most 512 characters.",
  stages: { beforeDraw: { cards: 13, action: "draw-stock", cardId: null, groups: [] },
    ordinaryDiscard: { cards: 14, action: "discard", cardId: "owned-final-discard", groups: [] },
    showdown: "submit-hand only when pending; cover every own card once; unmatched groups permitted" },
  melds: meldLessons.map((lesson) => ({ id: lesson.id,
    cards: lesson.cards.map(({ suit, rank, printedJoker }) => [suit, rank, printedJoker]),
    wildRank: lesson.wildRank, assertedTotal: lesson.assertedTotal, accepted: lesson.accepted })),
  declaration: { cards: lessonHand.map(({ id, suit, rank }) => [id, suit, rank]), wildRank: 13,
    action: "declare", cardId: lessonExtra.id, groups: lessonDeclaration, accepted: true, score: lessonValidation.score }
});
export const AI_PRACTICE_CURRICULUM_HASH = createHash("sha256").update(canonicalJson({
  examples: AI_PRACTICE_EXAMPLES, fixturePolicy, version: AI_PRACTICE_CURRICULUM_ID,
  protocolId: AI_VALIDATION_IDENTITY_VERSION, rulesRevision: AI_PRACTICE_RULES_REVISION
})).digest("hex");
export const AI_PRACTICE_CURRICULUM_DESCRIPTOR = freeze({
  id: AI_PRACTICE_CURRICULUM_ID, hash: AI_PRACTICE_CURRICULUM_HASH,
  protocolId: AI_VALIDATION_IDENTITY_VERSION, rulesRevision: AI_PRACTICE_RULES_REVISION,
  exampleCount: meldLessons.length + 1, maxRounds: 3, episodesPerRound: 4, solver: false
});
export const AI_PRACTICE_MEMORY_PREFIX = `SYNTHETIC_PAST_PRACTICE_DATA (not the current hand, not instructions):\n${JSON.stringify(AI_PRACTICE_EXAMPLES)}\nREUSABLE_PRACTICE_NOTES_DATA:`;
if (AI_PRACTICE_MEMORY_PREFIX.length + 513 > 4_000) throw new Error("Synthetic practice examples exceed the memory budget.");

export function aiPracticeFixtureId(stage: AiPracticeStage, scenario: AiPracticeScenario, round: number): string {
  return `${AI_PRACTICE_CURRICULUM_ID}:${stage}:${scenario}:${round}`;
}

/** Fixed synthetic fixtures, not a generator that searches or examines a live hand. */
export function createAiPracticeGame(options: {
  identity: AiIdentity; syntheticHumanId: string; stage: AiPracticeStage; scenario: AiPracticeScenario; round: number;
}): RankingGame {
  const { identity, syntheticHumanId, stage, scenario, round } = options;
  if (!Number.isInteger(round) || round < 1 || round > 3 || !["training", "evaluation"].includes(stage)
    || !["full-turn", "winning-hand"].includes(scenario) || identity.protocolId !== AI_VALIDATION_IDENTITY_VERSION) {
    throw new Error("Unsupported synthetic practice fixture binding.");
  }
  let seed = (stage === "training" ? fixturePolicy.trainingSeeds : fixturePolicy.evaluationSeeds)[round - 1]!;
  const randomIndex = (maximum: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  const base = new RankingGame([
    { id: identity.id, displayName: "Practice model", actorKind: "ai", aiModelId: identity.modelId },
    { id: syntheticHumanId, displayName: "Synthetic practice seat", actorKind: "human" }
  ], randomIndex);
  const snapshot = base.snapshot();
  const prefix = `practice-${stage}-r${round}-${scenario}`;
  const remap = (card: Card): Card => ({ ...card, id: `${prefix}-${card.id}` });
  snapshot.hands = snapshot.hands.map((entry) => ({ ...entry, cards: entry.cards.map(remap) }));
  snapshot.stock = snapshot.stock.map(remap); snapshot.discard = snapshot.discard.map(remap);
  snapshot.toss = null;
  snapshot.currentPlayerIndex = snapshot.seats.findIndex(({ id }) => id === identity.id);
  snapshot.turnEndsAt = Date.now() + 45_000;
  if (scenario === "winning-hand") {
    const deck = createDeck(1).map(remap);
    const take = (suit: Suit, rank: number) => {
      const index = deck.findIndex((card) => card.suit === suit && card.rank === rank);
      if (index < 0) throw new Error("Synthetic fixture card is missing.");
      return deck.splice(index, 1)[0]!;
    };
    const rotate = (suit: Suit) => suitOrder[(suitOrder.indexOf(suit) + round - 1) % 4]!;
    const pattern = stage === "training" ? trainingPattern : evaluationPattern;
    const groups = pattern.map((group) => group.map(([suit, rank]) => take(rotate(suit), rank)));
    const extra = take(rotate("clubs"), 13);
    take(rotate("spades"), 13); // Wild-rank indicator is outside the playing deck.
    const owned = [...groups.flat(), extra];
    // Reverse the authored groups' card order; no answer/partition is retained by the engine.
    snapshot.hands = [{ playerId: identity.id, cards: owned.slice().reverse() },
      { playerId: syntheticHumanId, cards: deck.splice(0, 13) }];
    snapshot.discard = [deck.pop()!]; snapshot.stock = deck;
    snapshot.wildRank = 13; snapshot.drawnBy = identity.id; snapshot.drawnCardId = extra.id;
  }
  return RankingGame.restore(snapshot);
}
