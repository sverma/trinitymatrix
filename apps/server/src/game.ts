import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  cardSchema,
  playerCountSchema,
  profileBadgeSchema,
  tossResultSchema,
  type Card,
  type ClientMessage,
  type GamePublicState,
  type PlayerCount,
  type ProfileBadgeId,
  type PublicPlayer,
  type TossResult
} from "@trinitymatrix/protocol";
import { createDeck, shuffle, validateDeclaration } from "@trinitymatrix/game-domain";

export type GameSeat = {
  id: string;
  displayName: string;
  badgeId: ProfileBadgeId;
  connected: boolean;
  status: "playing" | "dropped" | "declared";
  detached: boolean;
};

export type GameResult =
  | {
    accepted: true;
    ended?: {
      winnerId: string;
      winnerName: string;
      reason: "declaration" | "invalid-declaration" | "player-dropped";
      score?: number | undefined;
    };
    dropped?: { playerId: string; playerName: string; reason: string };
    left?: { playerId: string; playerName: string };
  }
  | { accepted: false; code: string; message: string; commandId: string };

type GameCommand = Extract<ClientMessage, { type: `game.${string}` }>;

const turnDurationMs = 45_000;
const showdownDurationMs = 45_000;

function groupsCoverHand(hand: readonly Card[], groups: readonly (readonly string[])[]): boolean {
  const handIds = new Set(hand.map(({ id }) => id));
  const submittedIds = groups.flat();
  return hand.length === 13
    && handIds.size === 13
    && submittedIds.length === 13
    && new Set(submittedIds).size === 13
    && submittedIds.every((id) => handIds.has(id));
}

const gameNameAdjectives = [
  "amber", "brisk", "calm", "clever", "crimson", "golden", "lucky", "royal",
  "silver", "swift", "velvet", "vivid"
] as const;
const gameNameNouns = [
  "cobra", "comet", "falcon", "lotus", "meteor", "monsoon", "peacock", "tiger",
  "river", "saffron", "star", "thunder"
] as const;

export function createPublicGameName(randomIndex = (maximum: number) => randomInt(maximum)): string {
  const adjective = gameNameAdjectives[randomIndex(gameNameAdjectives.length)]!;
  const noun = gameNameNouns[randomIndex(gameNameNouns.length)]!;
  const suffix = String(randomIndex(100_000_000)).padStart(8, "0");
  return `${adjective}-${noun}-${suffix}`;
}

export const rankingGameSnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  publicName: z.string().regex(/^[a-z]+-[a-z]+-[0-9]{8}$/).optional(),
  playerCount: playerCountSchema,
  seats: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    badgeId: profileBadgeSchema.optional().default("rookie"),
    connected: z.boolean(),
    status: z.enum(["playing", "dropped", "declared"]).optional().default("playing"),
    detached: z.boolean().optional().default(false)
  }).strict()),
  hands: z.array(z.object({ playerId: z.string(), cards: z.array(cardSchema) }).strict()),
  stock: z.array(cardSchema),
  discard: z.array(cardSchema),
  currentPlayerIndex: z.number().int().nonnegative(),
  drawnBy: z.string().nullable(),
  drawnCardId: z.string().nullable(),
  seenCommands: z.array(z.string()),
  phase: z.enum(["playing", "showdown", "finished"]),
  showdown: z.object({
    declarerId: z.string(),
    pendingPlayerIds: z.array(z.string()),
    submissions: z.array(z.object({
      playerId: z.string(),
      groups: z.array(z.array(z.string().min(1)).min(1)).min(1)
    }).strict()),
    endsAt: z.number(),
    score: z.number().int().nonnegative().optional().default(0)
  }).strict().nullable().optional().default(null),
  turnEndsAt: z.number(),
  revision: z.number().int().positive(),
  wildRank: z.number().int().min(1).max(13),
  toss: tossResultSchema.nullable().optional().default(null)
}).strict();

export type RankingGameSnapshot = z.infer<typeof rankingGameSnapshotSchema>;
type ShowdownState = NonNullable<RankingGameSnapshot["showdown"]>;

export class RankingGame {
  readonly id: string;
  readonly publicName: string;
  readonly playerCount: PlayerCount;
  private readonly seats: GameSeat[];
  private readonly hands: Map<string, Card[]>;
  private stock: Card[];
  private discard: Card[];
  private currentPlayerIndex = 0;
  private drawnBy: string | null = null;
  private drawnCardId: string | null = null;
  private seenCommands = new Set<string>();
  private phase: GamePublicState["phase"] = "playing";
  private showdown: ShowdownState | null = null;
  private turnEndsAt = Date.now() + turnDurationMs;
  private revision = 1;
  readonly wildRank: number;
  readonly toss: TossResult | null;

  constructor(
    players: readonly { id: string; displayName: string; badgeId?: ProfileBadgeId }[],
    randomIndex = (maximum: number) => randomInt(maximum),
    restored?: RankingGameSnapshot
  ) {
    if (restored) {
      this.id = restored.id;
      this.publicName = restored.publicName ?? createPublicGameName(randomIndex);
      this.playerCount = restored.playerCount;
      this.seats = restored.seats.map((seat) => ({ ...seat, connected: false }));
      this.hands = new Map(restored.hands.map(({ playerId, cards }) => [playerId, [...cards]]));
      this.stock = [...restored.stock];
      this.discard = [...restored.discard];
      this.currentPlayerIndex = restored.currentPlayerIndex;
      this.drawnBy = restored.drawnBy;
      this.drawnCardId = restored.drawnCardId;
      this.seenCommands = new Set(restored.seenCommands);
      this.phase = restored.phase;
      this.showdown = restored.showdown;
      this.turnEndsAt = restored.turnEndsAt;
      this.revision = restored.revision;
      this.wildRank = restored.wildRank;
      this.toss = restored.toss;
      return;
    }
    if (players.length !== 2 && players.length !== 6) throw new Error("A ranking game requires exactly 2 or 6 players.");
    this.id = randomUUID();
    this.publicName = createPublicGameName(randomIndex);
    this.playerCount = players.length;

    const tossDeck = shuffle(createDeck(1).filter(({ printedJoker }) => !printedJoker), randomIndex);
    const tossCards = players.map((player) => ({ playerId: player.id, card: tossDeck.pop()! }));
    const suitStrength = { clubs: 1, diamonds: 2, hearts: 3, spades: 4 } as const;
    const tossStrength = ({ card }: (typeof tossCards)[number]) =>
      (card.rank === 1 ? 14 : card.rank ?? 0) * 10 + (card.suit ? suitStrength[card.suit] : 0);
    const tossWinner = tossCards.reduce((winner, candidate) =>
      tossStrength(candidate) > tossStrength(winner) ? candidate : winner);
    const winnerIndex = players.findIndex(({ id }) => id === tossWinner.playerId);
    const orderedPlayers = [...players.slice(winnerIndex), ...players.slice(0, winnerIndex)];
    this.seats = orderedPlayers.map((player) => ({
      ...player,
      badgeId: player.badgeId ?? "rookie",
      connected: true,
      status: "playing",
      detached: false
    }));
    this.toss = { winnerId: tossWinner.playerId, cards: tossCards };
    this.hands = new Map<string, Card[]>();
    const deckCount = players.length === 6 ? 2 : 1;
    const deck = shuffle(createDeck(deckCount), randomIndex);
    for (const player of players) this.hands.set(player.id, []);
    for (let cardNumber = 0; cardNumber < 13; cardNumber += 1) {
      for (const player of players) this.hands.get(player.id)!.push(deck.pop()!);
    }
    const wildCard = deck.pop()!;
    this.wildRank = wildCard.rank ?? 1;
    this.discard = [deck.pop()!];
    this.stock = deck;
    this.turnEndsAt = Date.now() + turnDurationMs + 3_000;
  }

  static restore(input: unknown): RankingGame {
    const snapshot = rankingGameSnapshotSchema.parse(input);
    if (snapshot.seats.length !== snapshot.playerCount || snapshot.currentPlayerIndex >= snapshot.seats.length) {
      throw new Error("The saved game has an invalid seat layout.");
    }
    const handIds = new Set(snapshot.hands.map(({ playerId }) => playerId));
    if (snapshot.seats.some(({ id }) => !handIds.has(id))) throw new Error("The saved game is missing a player hand.");
    if ((snapshot.phase === "showdown" && !snapshot.showdown)
      || (snapshot.phase === "playing" && snapshot.showdown)) {
      throw new Error("The saved game has an inconsistent showdown phase.");
    }
    if (snapshot.showdown) {
      const seatsById = new Map(snapshot.seats.map((seat) => [seat.id, seat]));
      const handsById = new Map(snapshot.hands.map(({ playerId, cards }) => [playerId, cards]));
      const submittedIds = snapshot.showdown.submissions.map(({ playerId }) => playerId);
      const allResponderIds = [...snapshot.showdown.pendingPlayerIds, ...submittedIds];
      const expectedResponderIds = snapshot.seats
        .filter(({ id, status }) => id !== snapshot.showdown!.declarerId && status === "playing")
        .map(({ id }) => id);
      if (seatsById.get(snapshot.showdown.declarerId)?.status !== "declared"
        || new Set(allResponderIds).size !== allResponderIds.length
        || allResponderIds.some((id) => seatsById.get(id)?.status !== "playing" || id === snapshot.showdown!.declarerId)
        || new Set(expectedResponderIds).size !== allResponderIds.length
        || expectedResponderIds.some((id) => !allResponderIds.includes(id))
        || snapshot.showdown.submissions.some(({ playerId, groups }) => !groupsCoverHand(handsById.get(playerId) ?? [], groups))
        || (snapshot.phase === "showdown" && snapshot.showdown.pendingPlayerIds.length === 0)
        || (snapshot.phase === "finished" && snapshot.showdown.pendingPlayerIds.length > 0)) {
        throw new Error("The saved game has an invalid showdown layout.");
      }
    }
    return new RankingGame(snapshot.seats.map(({ id, displayName, badgeId }) => ({ id, displayName, badgeId })), undefined, snapshot);
  }

  snapshot(): RankingGameSnapshot {
    return {
      version: 1,
      id: this.id,
      publicName: this.publicName,
      playerCount: this.playerCount,
      seats: this.seats.map((seat) => ({ ...seat })),
      hands: this.seats.map(({ id }) => ({ playerId: id, cards: this.handFor(id) })),
      stock: [...this.stock],
      discard: [...this.discard],
      currentPlayerIndex: this.currentPlayerIndex,
      drawnBy: this.drawnBy,
      drawnCardId: this.drawnCardId,
      seenCommands: [...this.seenCommands],
      phase: this.phase,
      showdown: this.showdown ? {
        ...this.showdown,
        pendingPlayerIds: [...this.showdown.pendingPlayerIds],
        submissions: this.showdown.submissions.map((submission) => ({
          playerId: submission.playerId,
          groups: submission.groups.map((group) => [...group])
        }))
      } : null,
      turnEndsAt: this.turnEndsAt,
      revision: this.revision,
      wildRank: this.wildRank,
      toss: this.toss
    };
  }

  get currentPlayerId(): string {
    return this.seats[this.currentPlayerIndex]!.id;
  }

  hasPlayer(playerId: string): boolean {
    return this.hands.has(playerId);
  }

  isAttached(playerId: string): boolean {
    return this.seats.find(({ id }) => id === playerId)?.detached === false;
  }

  setConnected(playerId: string, connected: boolean): void {
    const seat = this.seats.find(({ id }) => id === playerId);
    if (seat) seat.connected = connected;
  }

  private publicPlayers(): PublicPlayer[] {
    return this.seats.map((seat) => ({
      id: seat.id,
      displayName: seat.displayName,
      badgeId: seat.badgeId,
      connected: seat.connected,
      cardCount: seat.status === "playing" ? this.hands.get(seat.id)!.length : 0,
      status: seat.status
    }));
  }

  publicState(): GamePublicState {
    return {
      gameId: this.id,
      gameName: this.publicName,
      playerCount: this.playerCount,
      matchType: "general",
      players: this.publicPlayers(),
      currentPlayerId: this.currentPlayerId,
      topDiscard: this.discard.at(-1) ?? null,
      wildRank: this.wildRank,
      stockCount: this.stock.length,
      turnEndsAt: this.turnEndsAt,
      phase: this.phase,
      showdown: this.showdown ? {
        declarerId: this.showdown.declarerId,
        pendingPlayerIds: [...this.showdown.pendingPlayerIds],
        submittedPlayerIds: this.showdown.submissions.map(({ playerId }) => playerId),
        endsAt: this.showdown.endsAt,
        score: this.showdown.score
      } : null,
      revision: this.revision,
      toss: this.toss
    };
  }

  handFor(playerId: string): Card[] {
    return [...(this.hands.get(playerId) ?? [])];
  }

  private reject(command: GameCommand, code: string, message: string): GameResult {
    return { accepted: false, commandId: command.commandId, code, message };
  }

  apply(playerId: string, command: GameCommand): GameResult {
    if (!this.hasPlayer(playerId)) return this.reject(command, "NOT_A_PLAYER", "You are not seated in this game.");
    if (command.gameId !== this.id) return this.reject(command, "WRONG_GAME", "This command targets another game.");
    if (this.seenCommands.has(command.commandId)) return this.reject(command, "DUPLICATE", "That command was already processed.");
    if (command.expectedRevision !== this.revision) return this.reject(command, "STALE_STATE", "The game changed; please retry from the latest state.");
    if (this.phase === "finished") return this.reject(command, "GAME_FINISHED", "This game has finished.");
    if (this.phase === "showdown") {
      if (command.type !== "game.submit-hand") {
        return this.reject(command, "SHOWDOWN_IN_PROGRESS", "Arrange and submit your 13-card hand before the showdown ends.");
      }
      this.rememberCommand(command.commandId);
      return this.submitHand(playerId, command);
    }
    if (this.seats.find(({ id }) => id === playerId)?.status !== "playing") {
      return this.reject(command, "PLAYER_DROPPED", "You are watching this round after leaving active play.");
    }
    if (command.type !== "game.drop" && this.currentPlayerId !== playerId) {
      return this.reject(command, "NOT_YOUR_TURN", "Wait for your turn.");
    }

    this.rememberCommand(command.commandId);

    if (command.type === "game.drop") return this.dropVoluntarily(playerId);
    if (command.type === "game.draw") return this.draw(playerId, command);
    if (command.type === "game.discard") return this.discardCard(playerId, command);
    if (command.type === "game.submit-hand") {
      return this.reject(command, "SHOWDOWN_NOT_STARTED", "A hand can only be submitted after a valid show.");
    }
    return this.declare(playerId, command);
  }

  private rememberCommand(commandId: string): void {
    this.seenCommands.add(commandId);
    if (this.seenCommands.size > 500) this.seenCommands = new Set([...this.seenCommands].slice(-250));
  }

  private draw(playerId: string, command: Extract<GameCommand, { type: "game.draw" }>): GameResult {
    if (this.drawnBy) return this.reject(command, "ALREADY_DRAWN", "Discard a card before drawing again.");
    if (command.source === "discard" && this.discard.length === 0) {
      return this.reject(command, "EMPTY_DISCARD", "The discard pile is empty.");
    }
    if (command.source === "stock" && this.stock.length === 0) this.recycleDiscardPile();
    const card = command.source === "stock" ? this.stock.pop() : this.discard.pop();
    if (!card) return this.reject(command, "NO_CARD", "No card is available from that pile.");
    this.hands.get(playerId)!.push(card);
    this.drawnBy = playerId;
    this.drawnCardId = card.id;
    this.revision += 1;
    return { accepted: true };
  }

  private discardCard(playerId: string, command: Extract<GameCommand, { type: "game.discard" }>): GameResult {
    if (this.drawnBy !== playerId) return this.reject(command, "DRAW_REQUIRED", "Draw before discarding.");
    const hand = this.hands.get(playerId)!;
    const cardIndex = hand.findIndex(({ id }) => id === command.cardId);
    if (cardIndex < 0) return this.reject(command, "CARD_NOT_OWNED", "That card is not in your hand.");
    const [card] = hand.splice(cardIndex, 1);
    this.discard.push(card!);
    this.drawnBy = null;
    this.drawnCardId = null;
    this.advanceTurn();
    this.revision += 1;
    return { accepted: true };
  }

  private declare(playerId: string, command: Extract<GameCommand, { type: "game.declare" }>): GameResult {
    if (this.drawnBy !== playerId) return this.reject(command, "DRAW_REQUIRED", "Draw before declaring.");
    const result = validateDeclaration(this.hands.get(playerId)!, command.discardCardId, command.melds, this.wildRank);
    if (!result.valid) return this.dropInvalidDeclaration(playerId, command.discardCardId, result.reason);
    const hand = this.hands.get(playerId)!;
    const discardIndex = hand.findIndex(({ id }) => id === command.discardCardId);
    this.discard.push(hand.splice(discardIndex, 1)[0]!);
    this.seats.find(({ id }) => id === playerId)!.status = "declared";
    this.drawnBy = null;
    this.drawnCardId = null;
    const pendingPlayerIds = this.seats
      .filter(({ id, status }) => id !== playerId && status === "playing")
      .map(({ id }) => id);
    const endsAt = Date.now() + showdownDurationMs;
    this.showdown = {
      declarerId: playerId,
      pendingPlayerIds,
      submissions: [],
      endsAt,
      score: result.score
    };
    this.turnEndsAt = endsAt;
    this.phase = pendingPlayerIds.length > 0 ? "showdown" : "finished";
    this.revision += 1;
    const winner = this.seats.find(({ id }) => id === playerId)!;
    return pendingPlayerIds.length > 0
      ? { accepted: true }
      : { accepted: true, ended: { winnerId: winner.id, winnerName: winner.displayName, reason: "declaration", score: result.score } };
  }

  private submitHand(playerId: string, command: Extract<GameCommand, { type: "game.submit-hand" }>): GameResult {
    const showdown = this.showdown!;
    if (!showdown.pendingPlayerIds.includes(playerId)) {
      return this.reject(command, "HAND_NOT_PENDING", "Your hand is not pending in this showdown.");
    }
    const hand = this.hands.get(playerId)!;
    if (!groupsCoverHand(hand, command.groups)) {
      return this.reject(command, "INVALID_HAND_SUBMISSION", "Submit every card in your 13-card hand exactly once.");
    }
    showdown.submissions.push({
      playerId,
      groups: command.groups.map((group) => [...group])
    });
    showdown.pendingPlayerIds = showdown.pendingPlayerIds.filter((id) => id !== playerId);
    this.revision += 1;
    if (showdown.pendingPlayerIds.length > 0) return { accepted: true };

    this.phase = "finished";
    const winner = this.seats.find(({ id }) => id === showdown.declarerId)!;
    return {
      accepted: true,
      ended: { winnerId: winner.id, winnerName: winner.displayName, reason: "declaration", score: showdown.score }
    };
  }

  private dropInvalidDeclaration(playerId: string, discardCardId: string, reason: string): GameResult {
    const hand = this.hands.get(playerId)!;
    const discardIndex = hand.findIndex(({ id }) => id === discardCardId);
    if (discardIndex >= 0) this.discard.push(hand.splice(discardIndex, 1)[0]!);
    const dropped = this.seats.find(({ id }) => id === playerId)!;
    dropped.status = "dropped";
    this.drawnBy = null;
    this.drawnCardId = null;
    this.revision += 1;

    const activePlayers = this.seats.filter(({ status }) => status === "playing");
    if (activePlayers.length === 1) {
      const winner = activePlayers[0]!;
      this.currentPlayerIndex = this.seats.findIndex(({ id }) => id === winner.id);
      this.phase = "finished";
      return {
        accepted: true,
        dropped: { playerId, playerName: dropped.displayName, reason },
        ended: { winnerId: winner.id, winnerName: winner.displayName, reason: "invalid-declaration" }
      };
    }

    this.advanceTurn();
    return { accepted: true, dropped: { playerId, playerName: dropped.displayName, reason } };
  }

  private dropVoluntarily(playerId: string): GameResult {
    const wasCurrentPlayer = this.currentPlayerId === playerId;
    const dropped = this.seats.find(({ id }) => id === playerId)!;
    dropped.status = "dropped";
    dropped.detached = true;
    if (this.drawnBy === playerId) {
      this.drawnBy = null;
      this.drawnCardId = null;
    }
    this.revision += 1;

    const activePlayers = this.seats.filter(({ status }) => status === "playing");
    if (activePlayers.length === 1) {
      const winner = activePlayers[0]!;
      this.currentPlayerIndex = this.seats.findIndex(({ id }) => id === winner.id);
      this.phase = "finished";
      return {
        accepted: true,
        left: { playerId, playerName: dropped.displayName },
        ended: { winnerId: winner.id, winnerName: winner.displayName, reason: "player-dropped" }
      };
    }

    if (wasCurrentPlayer) this.advanceTurn();
    return { accepted: true, left: { playerId, playerName: dropped.displayName } };
  }

  timeout(): GameResult | undefined {
    if (this.phase === "finished") return undefined;
    if (this.phase === "showdown") {
      const declarerId = this.showdown!.declarerId;
      this.showdown!.pendingPlayerIds = [];
      this.phase = "finished";
      this.revision += 1;
      const winner = this.seats.find(({ id }) => id === declarerId)!;
      return {
        accepted: true,
        ended: { winnerId: winner.id, winnerName: winner.displayName, reason: "declaration", score: this.showdown!.score }
      };
    }
    if (this.drawnBy === this.currentPlayerId && this.drawnCardId) {
      const hand = this.hands.get(this.currentPlayerId)!;
      const index = hand.findIndex(({ id }) => id === this.drawnCardId);
      if (index >= 0) this.discard.push(hand.splice(index, 1)[0]!);
    }
    this.drawnBy = null;
    this.drawnCardId = null;
    this.advanceTurn();
    this.revision += 1;
    return { accepted: true };
  }

  private advanceTurn(): void {
    do {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.seats.length;
    } while (this.seats[this.currentPlayerIndex]!.status !== "playing");
    this.turnEndsAt = Date.now() + turnDurationMs;
  }

  private recycleDiscardPile(): void {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop()!;
    this.stock = shuffle(this.discard, (maximum) => randomInt(maximum));
    this.discard = [top];
  }
}
