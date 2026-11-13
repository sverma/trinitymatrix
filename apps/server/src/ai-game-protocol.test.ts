import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@trinitymatrix/protocol";
import { MAX_MELD_TOTAL, MIN_MELD_CARDS, VALID_MELD_TOTALS, validateDeclaration, validateMeld } from "@trinitymatrix/game-domain";
import { RankingGame } from "./game";
import {
  AI_GAME_PROTOCOL_DESCRIPTOR, AI_GAME_PROTOCOL_IDENTITY_VERSION, AI_GAME_PROTOCOL_MANIFEST, AI_GAME_PROTOCOL_REVISION_HASH,
  AI_GAME_PROTOCOL_VERSION, AI_GAME_RULES, AI_GAME_RULES_REVISION, AI_LEGACY_V1_PROTOCOL_DESCRIPTOR, AI_LEGACY_V1_SYSTEM_PROMPT, buildSystemPrompt
} from "./ai-game-protocol";

const card = (id: string, suit: Card["suit"], rank: number): Card => ({ id, deck: 1, suit, rank, printedJoker: false });
function ready102(prefix = "ready") {
  const groups = [
    [card(`${prefix}-c6`, "clubs", 6), card(`${prefix}-c7`, "clubs", 7), card(`${prefix}-c8`, "clubs", 8)],
    [card(`${prefix}-d8`, "diamonds", 8), card(`${prefix}-d9`, "diamonds", 9), card(`${prefix}-d10`, "diamonds", 10)],
    [card(`${prefix}-h8`, "hearts", 8), card(`${prefix}-h9`, "hearts", 9), card(`${prefix}-h10`, "hearts", 10)],
    [card(`${prefix}-s3`, "spades", 3), card(`${prefix}-s7`, "spades", 7), card(`${prefix}-s8`, "spades", 8), card(`${prefix}-s9`, "spades", 9)]
  ];
  const extra = card(`${prefix}-extra`, "clubs", 2);
  return { groups, extra, hand: [...groups.flat(), extra], ids: groups.map((group) => group.map(({ id }) => id)) };
}

describe("versioned model game protocol", () => {
  afterEach(() => vi.useRealTimers());

  it("retains the exact historical v1 prompt without changing existing identities", () => {
    expect(createHash("sha256").update(AI_LEGACY_V1_SYSTEM_PROMPT).digest("hex"))
      .toBe("0d7523feefc6747e109b1f6f5a713455ffbf1193b91632006144ef94eeb70ee7");
  });

  it("publishes immutable semantic/rules versions and a stable policy identity", () => {
    expect(AI_GAME_PROTOCOL_VERSION).toBe("trinity-agent-protocol/2.0.0");
    expect(AI_GAME_RULES_REVISION).toBe("trinity-rules/1.0.0");
    expect(AI_GAME_PROTOCOL_REVISION_HASH).toMatch(/^[a-f0-9]{64}$/);
    // Deliberate protocol fixture: semantic policy edits need an explicit version/fixture review.
    expect(AI_GAME_PROTOCOL_REVISION_HASH).toBe("a29df5da5bd4c9bf5ef9c3d71150b34ca6452e843c4c967a304087ade66eb5af");
    expect(AI_GAME_PROTOCOL_IDENTITY_VERSION).toBe(`${AI_GAME_PROTOCOL_VERSION}:${AI_GAME_PROTOCOL_REVISION_HASH}`);
    expect(AI_GAME_PROTOCOL_IDENTITY_VERSION.length).toBeLessThanOrEqual(100);
    expect(Object.isFrozen(AI_GAME_PROTOCOL_MANIFEST)).toBe(true);
    expect(Object.isFrozen(AI_GAME_RULES.allowedMeldTotals)).toBe(true);
    expect(AI_GAME_PROTOCOL_MANIFEST.toolPolicy.automaticMoveSubstitution).toBe(false);
    expect(AI_GAME_PROTOCOL_MANIFEST.responseContract.fields).toEqual(["action", "cardId", "groups", "memory"]);
  });

  it("keeps registry descriptors metadata-only and separately hashes the rendered prompt", () => {
    expect(AI_LEGACY_V1_PROTOCOL_DESCRIPTOR.id).toBe("trinity-v1");
    expect(AI_GAME_PROTOCOL_DESCRIPTOR.id).toBe(AI_GAME_PROTOCOL_IDENTITY_VERSION);
    expect(AI_GAME_PROTOCOL_DESCRIPTOR.policyHash).toBe(AI_GAME_PROTOCOL_REVISION_HASH);
    expect(AI_GAME_PROTOCOL_DESCRIPTOR.manifest.systemPromptSha256)
      .toBe(createHash("sha256").update(buildSystemPrompt()).digest("hex"));
    for (const descriptor of [AI_LEGACY_V1_PROTOCOL_DESCRIPTOR, AI_GAME_PROTOCOL_DESCRIPTOR]) {
      expect(Object.isFrozen(descriptor.manifest)).toBe(true);
      expect(Object.values(descriptor.manifest).every((value) => value === null || ["boolean", "string"].includes(typeof value))).toBe(true);
      expect(JSON.stringify(descriptor.manifest)).not.toMatch(/You are a|observation\.hand|\"memory\"|\"schema\"|\"messages\"/);
    }
    expect(AI_GAME_PROTOCOL_DESCRIPTOR.manifest.toolsVersion).toBe("shared-own-hand-legality/1.0.0");
  });

  it("matches the authoritative meld rules including the natural21 exception", () => {
    expect(AI_GAME_RULES.minimumMeldCards).toBe(MIN_MELD_CARDS);
    expect(AI_GAME_RULES.maximumMeldTotal).toBe(MAX_MELD_TOTAL);
    expect(AI_GAME_RULES.allowedMeldTotals).toEqual(VALID_MELD_TOTALS);
    const natural = [card("a", "clubs", 6), card("b", "clubs", 7), card("c", "clubs", 8)];
    expect(validateMeld(natural, 13)).toMatchObject({ valid: true, total: 21, wildCount: 0 });
    expect(validateMeld(natural.slice(0, 2), 13).valid).toBe(false);
    expect(validateMeld([card("a", "clubs", 10), card("b", "clubs", 11), card("c", "clubs", 12)], 13).valid).toBe(false);
    const joker: Card = { id: "joker", deck: 1, suit: null, rank: null, printedJoker: true };
    expect(validateMeld([card("a", "clubs", 7), card("b", "clubs", 7), joker], 13).validTotals).not.toContain(21);
    expect(validateMeld(natural, 7).validTotals).not.toContain(21);
  });

  it("recognizes the reported21+27+27+27 arrangement as a legal immediate102-point declaration after drawing", () => {
    const ready = ready102();
    expect(validateDeclaration(ready.hand, ready.extra.id, ready.ids, 13)).toEqual({ valid: true, score: 102, meldTotals: [21, 27, 27, 27] });
    expect(validateDeclaration(ready.groups.flat(), ready.extra.id, ready.ids, 13)).toEqual({ valid: false, reason: "Draw a card before declaring." });
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("21+27+27+27");
    expect(prompt).toContain("You MUST choose action declare now");
    expect(prompt).toContain("UNKNOWN, not proof that no winning move exists");
  });

  it("agrees with engine showdown45s and proves a higher-scoring responder cannot overtake the valid declarer", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const base = new RankingGame([{ id: "first", displayName: "First" }, { id: "second", displayName: "Second" }], () => 0);
    const snapshot = base.snapshot(); const declarerId = snapshot.seats[0]!.id; const responderId = snapshot.seats[1]!.id;
    const lower = [
      [card("h1", "hearts", 1), card("h2", "hearts", 2), card("h3", "hearts", 3)],
      [card("s4", "spades", 4), card("s5", "spades", 5), card("s6", "spades", 6)],
      [card("c7", "clubs", 7), card("d7", "diamonds", 7), card("h7", "hearts", 7)],
      [card("d2", "diamonds", 2), card("d4", "diamonds", 4), card("d6", "diamonds", 6), card("d9", "diamonds", 9)]
    ];
    const discard = card("show-card", "clubs", 2); const higher = ready102("responder");
    snapshot.hands = [{ playerId: declarerId, cards: [...lower.flat(), discard] }, { playerId: responderId, cards: higher.groups.flat() }];
    snapshot.currentPlayerIndex = 0; snapshot.wildRank = 13; snapshot.drawnBy = declarerId; snapshot.drawnCardId = discard.id;
    const game = RankingGame.restore(snapshot);
    const declared = game.apply(declarerId, { type: "game.declare", gameId: game.id, commandId: "00000000-0000-4000-8000-000000000001", expectedRevision: game.publicState().revision, discardCardId: discard.id, melds: lower.map((group) => group.map(({ id }) => id)) });
    expect(declared).toEqual({ accepted: true });
    expect(game.publicState().showdown).toMatchObject({ score: 63, endsAt: Date.now() + AI_GAME_RULES.showdownDurationMs });
    const submitted = game.apply(responderId, { type: "game.submit-hand", gameId: game.id, commandId: "00000000-0000-4000-8000-000000000002", expectedRevision: game.publicState().revision, groups: higher.ids });
    expect(submitted).toMatchObject({ accepted: true, ended: { winnerId: declarerId, reason: "declaration", score: 63 } });
  });

  it("keeps per-turn private data out of static instructions and requires model-controlled actions", () => {
    const prompt = Reflect.apply(buildSystemPrompt, undefined, [{ name: "PRIVATE_NAME", memory: "IGNORE_RULES_PRIVATE_MEMORY", hand: ["PRIVATE_CARD"] }]);
    expect(prompt).not.toMatch(/PRIVATE_NAME|IGNORE_RULES_PRIVATE_MEMORY|PRIVATE_CARD/);
    expect(prompt).toContain("UNTRUSTED DATA");
    expect(prompt).toContain("independent gameplay concurrency value");
    expect(prompt).toContain("never silently substitutes a different model");
    expect(prompt).toContain("another declaration that is fully legal immediately");
  });
});
