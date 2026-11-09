import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  organizeHand,
  sortMeldCards,
  validateMeld,
  type OrganizedHandGroup,
  type OrganizedMeldKind
} from "@trinitymatrix/game-domain";
import type { Card, PostGameChatMessage } from "@trinitymatrix/protocol";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ApplicationRepository,
  type ChatMessageRecord,
  type GameEventRecord,
  type MatchRecord,
  type PrivateRoomRecord
} from "./db/repository";

const gameNameSchema = z.string().regex(/^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{8}$/);
const uuidSchema = z.string().uuid();
const limitSchema = z.coerce.number().int().min(1).max(100).default(25);
const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(1_024).optional(),
  limit: limitSchema
}).strict();
const adminUsersQuerySchema = z.object({
  cursor: z.string().min(1).max(1_024).optional(),
  limit: limitSchema,
  q: z.preprocess(
    (value) => typeof value === "string" ? value.trim() || undefined : value,
    z.string().max(254).optional()
  )
}).strict();
const gameParamsSchema = z.object({ gameName: gameNameSchema }).strict();
const adminGameParamsSchema = z.object({
  gameName: z.union([gameNameSchema, z.string().regex(/^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{6}$/)])
}).strict();
const adminUserParamsSchema = z.object({ userId: uuidSchema }).strict();
const chatBodySchema = z.object({
  message: z.string().trim().min(1).refine((value) => [...value].length <= 280, {
    message: "Chat messages cannot exceed 280 characters."
  }),
  clientMessageId: uuidSchema.optional()
}).strict();
const suspensionBodySchema = z.discriminatedUnion("suspended", [
  z.object({ suspended: z.literal(true), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ suspended: z.literal(false), reason: z.null().optional() }).strict()
]);

const rankingCursorSchema = z.object({
  rating: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  userId: uuidSchema,
  rank: z.number().int().nonnegative()
}).strict();
const historyCursorSchema = z.object({
  startedAt: z.string().datetime({ offset: true }),
  matchId: uuidSchema
}).strict();
const chatCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  messageId: uuidSchema
}).strict();
const adminUserCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  userId: uuidSchema,
  query: z.string().max(254).nullable()
}).strict();
const adminGameCursorSchema = z.object({
  startedAt: z.string().datetime({ offset: true }),
  matchId: uuidSchema
}).strict();

export type DurableRouteSession = Readonly<{
  playerId: string;
  profile: Readonly<{ email: string; displayName: string }>;
}>;

export type DurableRoutesOptions = Readonly<{
  repository: ApplicationRepository;
  resolveSession: (request: FastifyRequest) => Promise<DurableRouteSession | null>;
  resolveAdminAccess?: (request: FastifyRequest) => Promise<boolean>;
  onUserSuspended?: (playerId: string) => void | Promise<void>;
  publishPostGameChatMessage?: (publication: Readonly<{
    gameName: string;
    participantPlayerIds: readonly string[];
    message: PostGameChatMessage;
  }>) => void | Promise<void>;
  adminEmails: ReadonlySet<string> | readonly string[];
  createId?: () => string;
  now?: () => Date;
}>;

type RankingPageCursor = z.infer<typeof rankingCursorSchema>;

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(value: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!value) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

function cursorHeader(reply: FastifyReply, cursor: unknown | null): void {
  if (cursor) reply.header("x-next-cursor", encodeCursor(cursor));
}

function normalizeAdminEmails(values: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return new Set([...values].map((email) => email.trim().toLowerCase()).filter(Boolean));
}

function sendValidationError(reply: FastifyReply) {
  return reply.code(400).send({ error: "The request parameters were not valid." });
}

function sendRepositoryError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof RepositoryNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof RepositoryConflictError) return reply.code(409).send({ error: error.message });
  request.log.error({ err: error }, "Durable data request failed");
  return reply.code(500).send({ error: "The request could not be completed." });
}

function isParticipant(match: MatchRecord, playerId: string): boolean {
  return match.participants.some((participant) => participant.userId === playerId);
}

function publicPlayer(participant: MatchRecord["participants"][number]) {
  return {
    playerId: participant.userId,
    displayName: participant.displayName,
    badgeId: participant.badgeId
  };
}

const privatePayloadKey = /^(?:e-?mail|phone|phoneNumber|countryCode|nationalNumber|password|otp|token|accessToken|refreshToken|session|sessionId|cookie|authorization|ip|ipAddress)$/i;

function redactPrivatePayload(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactPrivatePayload(item, seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !privatePayloadKey.test(key))
    .map(([key, nested]) => [key, redactPrivatePayload(nested, seen)]));
}

function eventSummary(event: GameEventRecord, names: ReadonlyMap<string, string>): string {
  const actor = event.actorUserId ? names.get(event.actorUserId) : undefined;
  const label = event.eventType.replace(/[._-]+/g, " ").trim();
  return actor ? `${actor}: ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
}

type ReplayCard = Card & Readonly<{ label: string; wild: boolean }>;
type RecordedLayouts = Map<string, string[][]>;
type SuggestedLayoutCache = Map<string, OrganizedHandGroup[]>;

function storedCard(value: unknown): Card | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (typeof card.id !== "string") return null;
  if (card.printedJoker === true) {
    return {
      id: card.id,
      deck: typeof card.deck === "number" ? card.deck : 1,
      suit: null,
      rank: null,
      printedJoker: true
    };
  }
  if (typeof card.rank !== "number" || !["clubs", "diamonds", "hearts", "spades"].includes(String(card.suit))) return null;
  return {
    id: card.id,
    deck: typeof card.deck === "number" ? card.deck : 1,
    suit: card.suit as Card["suit"],
    rank: card.rank,
    printedJoker: false
  };
}

function replayCard(card: Card, wildRank: number): ReplayCard {
  if (card.printedJoker) return { ...card, label: "Joker", wild: true };
  const rank = ({ 1: "A", 11: "J", 12: "Q", 13: "K" } as Record<number, string>)[card.rank!] ?? String(card.rank);
  const suit = ({ clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" } as Record<string, string>)[card.suit!] ?? "";
  return { ...card, label: `${rank}${suit}`, wild: card.rank === wildRank };
}

function layoutGroups(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 14) return null;
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!Array.isArray(item) || item.length === 0 || item.length > 14) return null;
    const group: string[] = [];
    for (const id of item) {
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) return null;
      seen.add(id);
      group.push(id);
    }
    groups.push(group);
  }
  return groups;
}

function recordedLayoutFromCommand(payload: unknown): string[][] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const command = (payload as Record<string, unknown>).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const values = command as Record<string, unknown>;
  if (values.type === "game.declare") return layoutGroups(values.melds);
  if (values.type === "game.submit-hand") return layoutGroups(values.groups);
  return layoutGroups(values.layout);
}

function captureShowdownLayouts(snapshot: Record<string, unknown>, layouts: RecordedLayouts): void {
  const showdown = snapshot.showdown;
  if (!showdown || typeof showdown !== "object" || Array.isArray(showdown)) return;
  const submissions = (showdown as Record<string, unknown>).submissions;
  if (!Array.isArray(submissions)) return;
  for (const value of submissions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const submission = value as Record<string, unknown>;
    if (typeof submission.playerId !== "string") continue;
    const groups = layoutGroups(submission.groups);
    if (groups) layouts.set(submission.playerId, groups);
  }
}

function reconcileRecordedLayout(layout: readonly (readonly string[])[], cards: readonly Card[]): string[][] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const included = new Set<string>();
  const groups = layout.map((group) => group.filter((id) => {
    if (!cardsById.has(id) || included.has(id)) return false;
    included.add(id);
    return true;
  })).filter((group) => group.length > 0);
  const added = cards.filter(({ id }) => !included.has(id)).map(({ id }) => id);
  if (added.length > 0) groups.push(added);
  return groups;
}

function replayMeldKind(cards: readonly Card[], wildRank: number): OrganizedMeldKind {
  const result = validateMeld(cards, wildRank);
  if (!result.valid) return "unmatched";
  return result.validTotals.includes(21) ? "trinity" : "meld";
}

function replayMeldLabel(kind: OrganizedMeldKind): string {
  if (kind === "trinity") return "Trinity · 21";
  if (kind === "meld") return "Valid meld";
  return "Unmatched cards";
}

function replayGroups(
  cards: readonly Card[],
  wildRank: number,
  layout: string[][] | undefined,
  suggestedCache: SuggestedLayoutCache
) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const source = layout ? "recorded" as const : "suggested" as const;
  const cacheKey = `${wildRank}:${cards.map(({ id }) => id).sort().join(",")}`;
  const organized = layout
    ? reconcileRecordedLayout(layout, cards).map((group) => {
        const groupCards = group.map((id) => cardsById.get(id)).filter((card): card is Card => Boolean(card));
        const kind = replayMeldKind(groupCards, wildRank);
        return { kind, total: validateMeld(groupCards, wildRank).total, cards: sortMeldCards(groupCards, kind, wildRank) };
      })
    : suggestedCache.get(cacheKey) ?? organizeHand(cards, wildRank);
  if (!layout && !suggestedCache.has(cacheKey)) suggestedCache.set(cacheKey, organized);
  const groups = organized.map(({ kind, cards: groupCards }) => ({
    kind,
    label: replayMeldLabel(kind),
    total: validateMeld(groupCards, wildRank).total,
    cards: groupCards.map((card) => replayCard(card, wildRank))
  }));
  const matchedCardCount = groups
    .filter(({ kind }) => kind !== "unmatched")
    .reduce((total, group) => total + group.cards.length, 0);
  const trinityMeldCount = groups.filter(({ kind }) => kind === "trinity").length;
  const validMeldCount = groups.filter(({ kind }) => kind !== "unmatched").length;
  const score = groups.reduce((total, group) => total + (group.total ?? 0), 0);
  return {
    source,
    groups,
    progress: {
      matchedCardCount,
      totalCardCount: cards.length,
      trinityMeldCount,
      validMeldCount,
      score,
      declarationReady: cards.length === 13
        && matchedCardCount === 13
        && trinityMeldCount > 0
    }
  };
}

function replayState(
  value: unknown,
  layouts: RecordedLayouts,
  suggestedCache: SuggestedLayoutCache,
  winnerId: string | null
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const snapshot = value as Record<string, unknown>;
  const seats = Array.isArray(snapshot.seats) ? snapshot.seats : [];
  const hands = Array.isArray(snapshot.hands) ? snapshot.hands : [];
  const stock = Array.isArray(snapshot.stock) ? snapshot.stock : [];
  const discard = Array.isArray(snapshot.discard) ? snapshot.discard : [];
  const currentPlayerIndex = typeof snapshot.currentPlayerIndex === "number" ? snapshot.currentPlayerIndex : -1;
  const currentSeat = seats[currentPlayerIndex];
  const currentPlayerName = currentSeat && typeof currentSeat === "object" && !Array.isArray(currentSeat)
    ? (currentSeat as Record<string, unknown>).displayName
    : undefined;
  const wildRank = typeof snapshot.wildRank === "number" ? snapshot.wildRank : 1;
  captureShowdownLayouts(snapshot, layouts);
  const cardsByPlayer = new Map<string, Card[]>();
  for (const value of hands) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const hand = value as Record<string, unknown>;
    if (typeof hand.playerId !== "string" || !Array.isArray(hand.cards)) continue;
    cardsByPlayer.set(hand.playerId, hand.cards.map(storedCard).filter((card): card is Card => card !== null));
  }
  const players = seats.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const seat = value as Record<string, unknown>;
    if (typeof seat.id !== "string" || typeof seat.displayName !== "string") return [];
    const cards = cardsByPlayer.get(seat.id) ?? [];
    const recorded = layouts.get(seat.id);
    const arrangement = replayGroups(cards, wildRank, recorded, suggestedCache);
    if (recorded) layouts.set(seat.id, reconcileRecordedLayout(recorded, cards));
    return [{
      playerId: seat.id,
      displayName: seat.displayName,
      status: typeof seat.status === "string" ? seat.status : "playing",
      cardCount: cards.length,
      isWinner: seat.id === winnerId,
      cards: cards.map((card) => replayCard(card, wildRank)),
      layoutSource: arrangement.source,
      groups: arrangement.groups,
      progress: arrangement.progress
    }];
  });
  const topDiscardValue = storedCard(discard.at(-1));
  const topDiscard = topDiscardValue ? replayCard(topDiscardValue, wildRank) : null;
  return {
    ...(typeof snapshot.phase === "string" ? { phase: snapshot.phase } : {}),
    ...(typeof currentPlayerName === "string" ? { currentPlayerName } : {}),
    stockCount: stock.length,
    topDiscard: topDiscard?.label ?? null,
    ...(typeof snapshot.wildRank === "number" ? { wildRank: snapshot.wildRank } : {}),
    players
  };
}

function publicEvents(events: readonly GameEventRecord[], names: ReadonlyMap<string, string>, winnerId: string | null) {
  const layouts: RecordedLayouts = new Map();
  const suggestedCache: SuggestedLayoutCache = new Map();
  return events.map((event) => {
    const payload = redactPrivatePayload(event.payload);
    const commandLayout = recordedLayoutFromCommand(payload);
    if (event.actorUserId && commandLayout) layouts.set(event.actorUserId, commandLayout);
    const storedState = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).state
      : undefined;
    const state = replayState(storedState, layouts, suggestedCache, winnerId);
    return {
      sequence: event.sequence,
      at: event.occurredAt,
      type: event.eventType,
      ...(event.actorUserId && names.has(event.actorUserId) ? { actorName: names.get(event.actorUserId) } : {}),
      summary: eventSummary(event, names),
      payload,
      ...(state ? { state } : {})
    };
  });
}

function publicChat(message: ChatMessageRecord, match: MatchRecord): PostGameChatMessage {
  const author = match.participants.find(({ userId }) => userId === message.authorUserId);
  return {
    id: message.id,
    playerId: message.authorUserId,
    displayName: author?.displayName ?? "Player",
    message: message.body,
    createdAt: message.createdAt.toISOString()
  };
}

function publicAdminGame(match: MatchRecord, privateRoom?: PrivateRoomRecord) {
  const winner = match.participants.find(({ userId }) => userId === match.winnerUserId);
  return {
    gameName: match.publicName,
    status: match.status === "active" ? "playing" : match.status === "completed" ? "finished" : "abandoned",
    playerCount: match.playerCount,
    matchType: match.matchType ?? "general",
    players: match.participants.map(publicPlayer),
    ...(winner ? { winnerName: winner.displayName } : {}),
    startedAt: match.startedAt,
    ...(match.endedAt ? { finishedAt: match.endedAt } : {}),
    ...(privateRoom ? {
      roomCode: privateRoom.roomCode,
      creator: {
        playerId: privateRoom.creatorUserId,
        displayName: privateRoom.creatorDisplayName,
        email: privateRoom.creatorEmail
      },
      invites: privateRoom.invites.map((invite) => ({
        email: invite.email,
        status: invite.acceptedByUserId ? "accepted" as const : "pending" as const,
        ...(invite.acceptedByUserId ? { playerId: invite.acceptedByUserId } : {}),
        ...(invite.acceptedDisplayName ? { displayName: invite.acceptedDisplayName } : {})
      }))
    } : {})
  };
}

function publicAdminPrivateRoom(room: PrivateRoomRecord) {
  return {
    gameName: room.roomCode,
    roomCode: room.roomCode,
    status: "waiting" as const,
    playerCount: room.playerCount,
    matchType: "private" as const,
    creator: {
      playerId: room.creatorUserId,
      displayName: room.creatorDisplayName,
      email: room.creatorEmail
    },
    players: [
      { playerId: room.creatorUserId, displayName: room.creatorDisplayName, email: room.creatorEmail },
      ...room.invites.flatMap((invite) => invite.acceptedByUserId ? [{
        playerId: invite.acceptedByUserId,
        displayName: invite.acceptedDisplayName ?? "Player",
        email: invite.email
      }] : [])
    ],
    invites: room.invites.map((invite) => ({
      email: invite.email,
      status: invite.acceptedByUserId ? "accepted" as const : "pending" as const,
      ...(invite.acceptedByUserId ? { playerId: invite.acceptedByUserId } : {}),
      ...(invite.acceptedDisplayName ? { displayName: invite.acceptedDisplayName } : {})
    })),
    acceptedCount: 1 + room.invites.filter(({ acceptedByUserId }) => acceptedByUserId).length,
    requiredCount: room.playerCount,
    createdAt: room.createdAt
  };
}

async function loadAllGameEvents(repository: ApplicationRepository, matchId: string): Promise<readonly GameEventRecord[]> {
  const events: GameEventRecord[] = [];
  let cursor: { sequence: number } | undefined;
  // A match has a naturally bounded number of turns. This guard prevents a
  // corrupt cursor implementation from causing an unbounded HTTP request.
  for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
    const page = await repository.listGameEvents({ matchId, ...(cursor ? { cursor } : {}), limit: 100 });
    events.push(...page.items);
    if (!page.nextCursor) return events;
    if (cursor && page.nextCursor.sequence <= cursor.sequence) {
      throw new Error("The game-event cursor did not advance.");
    }
    cursor = page.nextCursor;
  }
  throw new Error("The replay is larger than the supported safety limit.");
}

async function loadAllChat(repository: ApplicationRepository, matchId: string): Promise<readonly ChatMessageRecord[]> {
  const messages: ChatMessageRecord[] = [];
  let cursor: { createdAt: Date; messageId: string } | undefined;
  // At most 18 messages exist in a six-player game, but cursor draining keeps
  // this correct if the repository page ceiling changes.
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await repository.listPostGameChat({ matchId, ...(cursor ? { cursor } : {}), limit: 100 });
    messages.push(...page.items);
    if (!page.nextCursor) return messages;
    cursor = page.nextCursor;
  }
  throw new Error("The post-game chat cursor did not terminate.");
}

export async function registerDurableDataRoutes(app: FastifyInstance, options: DurableRoutesOptions): Promise<void> {
  const repository = options.repository;
  const adminEmails = normalizeAdminEmails(options.adminEmails);
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());

  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<DurableRouteSession | null> => {
    const session = await options.resolveSession(request);
    if (!session) {
      await reply.code(401).send({ error: "Authentication required." });
      return null;
    }
    return session;
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<DurableRouteSession | null> => {
    const session = await requireSession(request, reply);
    if (!session) return null;
    if (!adminEmails.has(session.profile.email.trim().toLowerCase())) {
      await reply.code(403).send({ error: "Administrator access required." });
      return null;
    }
    if (options.resolveAdminAccess && !(await options.resolveAdminAccess(request))) {
      await reply.code(403).send({ error: "Administrator access code required." });
      return null;
    }
    return session;
  };

  app.get("/api/rankings", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const query = paginationQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply);
    const cursor = decodeCursor(query.data.cursor, rankingCursorSchema);
    if (query.data.cursor && !cursor) return sendValidationError(reply);
    try {
      const page = await repository.listRankings({
        ...(cursor ? { cursor: { rating: cursor.rating, wins: cursor.wins, userId: cursor.userId } } : {}),
        limit: query.data.limit
      });
      const startRank = cursor?.rank ?? 0;
      const rankings = page.items.map((entry, index) => ({
        rank: startRank + index + 1,
        playerId: entry.userId,
        displayName: entry.displayName,
        badgeId: entry.badgeId,
        rating: entry.rating,
        wins: entry.wins,
        gamesPlayed: entry.gamesPlayed
      }));
      const nextCursor: RankingPageCursor | null = page.nextCursor
        ? { ...page.nextCursor, rank: startRank + page.items.length }
        : null;
      cursorHeader(reply, nextCursor);
      return reply.send({ rankings });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/me/history", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const query = paginationQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply);
    const cursor = decodeCursor(query.data.cursor, historyCursorSchema);
    if (query.data.cursor && !cursor) return sendValidationError(reply);
    try {
      const page = await repository.listUserMatches({
        userId: session.playerId,
        ...(cursor ? { cursor: { startedAt: new Date(cursor.startedAt), matchId: cursor.matchId } } : {}),
        limit: query.data.limit
      });
      const games = page.items.flatMap((match) => {
        const publicName = "publicName" in match && typeof match.publicName === "string" ? match.publicName : null;
        const player = match.participants.find(({ userId }) => userId === session.playerId);
        if (!publicName || !player || match.status !== "completed" || !match.endedAt || !player.outcome) return [];
        const winner = match.participants.find(({ userId }) => userId === match.winnerUserId);
        return [{
          gameName: publicName,
          finishedAt: match.endedAt,
          playerCount: match.playerCount,
          matchType: match.matchType ?? "general",
          result: player.outcome,
          winnerName: winner?.displayName ?? "Player",
          ...(match.endReason ? { reason: match.endReason } : {}),
          ...(player.scoreDelta !== null ? { score: player.scoreDelta } : {})
        }];
      });
      cursorHeader(reply, page.nextCursor
        ? { startedAt: page.nextCursor.startedAt.toISOString(), matchId: page.nextCursor.matchId }
        : null);
      return reply.send({ games });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/games/:gameName/replay", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const params = gameParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply);
    try {
      const match = await repository.getMatchByPublicName(params.data.gameName);
      if (!match || match.status !== "completed" || !isParticipant(match, session.playerId)) {
        return reply.code(404).send({ error: "The completed game was not found." });
      }
      const events = await loadAllGameEvents(repository, match.id);
      const names = new Map(match.participants.map((participant) => [participant.userId, participant.displayName]));
      return reply.send({
        gameName: match.publicName,
        startedAt: match.startedAt,
        ...(match.endedAt ? { finishedAt: match.endedAt } : {}),
        ...(match.winnerUserId ? {
          winnerName: match.participants.find(({ userId }) => userId === match.winnerUserId)?.displayName ?? "Player"
        } : {}),
        ...(match.endReason ? { reason: match.endReason } : {}),
        players: match.participants.map(publicPlayer),
        events: publicEvents(events, names, match.winnerUserId)
      });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/games/:gameName/chat", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const params = gameParamsSchema.safeParse(request.params);
    const query = paginationQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return sendValidationError(reply);
    const cursor = decodeCursor(query.data.cursor, chatCursorSchema);
    if (query.data.cursor && !cursor) return sendValidationError(reply);
    try {
      const match = await repository.getMatchByPublicName(params.data.gameName);
      if (!match || match.status !== "completed" || !isParticipant(match, session.playerId)) {
        return reply.code(404).send({ error: "The completed game was not found." });
      }
      const page = await repository.listPostGameChat({
        matchId: match.id,
        ...(cursor ? { cursor: { createdAt: new Date(cursor.createdAt), messageId: cursor.messageId } } : {}),
        limit: query.data.limit
      });
      cursorHeader(reply, page.nextCursor
        ? { createdAt: page.nextCursor.createdAt.toISOString(), messageId: page.nextCursor.messageId }
        : null);
      const messages = page.items.map((message) => publicChat(message, match));
      const all = page.nextCursor || cursor ? await loadAllChat(repository, match.id) : page.items;
      const sent = all.filter(({ authorUserId }) => authorUserId === session.playerId).length;
      return reply.send({ messages, remaining: Math.max(0, 3 - sent) });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.post("/api/games/:gameName/chat", {
    config: { rateLimit: { max: 12, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const params = gameParamsSchema.safeParse(request.params);
    const body = chatBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return sendValidationError(reply);
    try {
      const match = await repository.getMatchByPublicName(params.data.gameName);
      if (!match || match.status !== "completed" || !isParticipant(match, session.playerId)) {
        return reply.code(404).send({ error: "The completed game was not found." });
      }
      const message = await repository.addPostGameChatMessage({
        id: createId(),
        matchId: match.id,
        authorUserId: session.playerId,
        clientMessageId: body.data.clientMessageId ?? createId(),
        body: body.data.message,
        createdAt: now()
      });
      const publishedMessage = publicChat(message, match);
      try {
        await options.publishPostGameChatMessage?.({
          gameName: match.publicName,
          participantPlayerIds: match.participants.map(({ userId }) => userId),
          message: publishedMessage
        });
      } catch (error) {
        // Persistence is authoritative. A transient socket delivery failure must
        // not turn an already-committed, idempotent POST into a client retry loop.
        request.log.error({ err: error, matchId: match.id, messageId: message.id }, "Post-game chat broadcast failed");
      }
      const all = await loadAllChat(repository, match.id);
      const sent = all.filter(({ authorUserId }) => authorUserId === session.playerId).length;
      return reply.code(201).send({ message: publishedMessage, remaining: Math.max(0, 3 - sent) });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/admin/overview", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    try {
      const overview = await repository.getAdminOverview();
      return reply.send({
        totalUsers: overview.users,
        totalGames: overview.activeMatches + overview.completedMatches,
        activeGames: overview.activeMatches,
        activeGeneralMatches: overview.activeGeneralMatches ?? overview.activeMatches,
        activePrivateMatches: overview.activePrivateMatches ?? 0,
        waitingPrivateRooms: overview.waitingPrivateRooms ?? 0,
        completedGames: overview.completedMatches,
        totalChatMessages: overview.chatMessages
      });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/admin/users", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const query = adminUsersQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply);
    const cursor = decodeCursor(query.data.cursor, adminUserCursorSchema);
    if (query.data.cursor && !cursor) return sendValidationError(reply);
    const normalizedQuery = query.data.q?.toLocaleLowerCase("en-US") ?? null;
    if (cursor && cursor.query !== normalizedQuery) return sendValidationError(reply);
    try {
      const page = await repository.listAdminUsers({
        ...(cursor ? { cursor: { createdAt: new Date(cursor.createdAt), userId: cursor.userId } } : {}),
        limit: query.data.limit,
        ...(query.data.q ? { query: query.data.q } : {})
      });
      const rankings = await repository.getRankingsForUsers(page.items.map(({ id }) => id));
      const rankingsByUser = new Map(rankings.map((ranking) => [ranking.userId, ranking]));
      const nextCursor = page.nextCursor
        ? encodeCursor({
          createdAt: page.nextCursor.createdAt.toISOString(),
          userId: page.nextCursor.userId,
          query: normalizedQuery
        })
        : null;
      if (nextCursor) reply.header("x-next-cursor", nextCursor);
      return reply.send({
        users: page.items.map((user) => {
          const ranking = rankingsByUser.get(user.id);
          return {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            status: user.suspendedAt ? "disabled" : "active",
            gamesPlayed: ranking?.gamesPlayed ?? 0,
            wins: ranking?.wins ?? 0,
            createdAt: user.createdAt,
            badgeId: user.badgeId
          };
        }),
        nextCursor,
        total: page.total
      });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/admin/games", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const query = paginationQuerySchema.safeParse(request.query);
    if (!query.success) return sendValidationError(reply);
    const cursor = decodeCursor(query.data.cursor, adminGameCursorSchema);
    if (query.data.cursor && !cursor) return sendValidationError(reply);
    try {
      const page = await repository.listAdminGames({
        ...(cursor ? { cursor: { startedAt: new Date(cursor.startedAt), matchId: cursor.matchId } } : {}),
        limit: query.data.limit
      });
      cursorHeader(reply, page.nextCursor
        ? { startedAt: page.nextCursor.startedAt.toISOString(), matchId: page.nextCursor.matchId }
        : null);
      const [waitingRooms, activePrivateRooms] = await Promise.all([
        query.data.cursor ? Promise.resolve([]) : repository.listWaitingPrivateRooms(),
        repository.listPrivateRoomsByMatchIds(page.items
          .filter((match) => match.matchType === "private")
          .map(({ id }) => id))
      ]);
      const roomByMatch = new Map(activePrivateRooms.flatMap((room) => room.matchId ? [[room.matchId, room] as const] : []));
      return reply.send({
        games: [
          ...waitingRooms.map(publicAdminPrivateRoom),
          ...page.items.map((match) => publicAdminGame(match, roomByMatch.get(match.id)))
        ]
      });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/admin/games/:gameName", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return;
    const params = adminGameParamsSchema.safeParse(request.params);
    if (!params.success) return sendValidationError(reply);
    try {
      const match = await repository.getAdminGameByPublicName(params.data.gameName);
      if (!match) {
        const room = await repository.getPrivateRoomByCode(params.data.gameName);
        if (!room || room.status !== "waiting") return reply.code(404).send({ error: "The game was not found." });
        return reply.send({
          game: publicAdminPrivateRoom(room),
          events: [],
          chatMessages: [],
          replayAvailable: false
        });
      }
      const privateRoom = match.matchType === "private"
        ? (await repository.listPrivateRoomsByMatchIds([match.id]))[0]
        : undefined;
      if (match.status !== "completed") {
        return reply.send({ game: publicAdminGame(match, privateRoom), events: [], chatMessages: [], replayAvailable: false });
      }
      const [events, chat] = await Promise.all([
        loadAllGameEvents(repository, match.id),
        loadAllChat(repository, match.id)
      ]);
      await repository.appendAdminAudit({
        auditId: createId(),
        actorUserId: session.playerId,
        targetUserId: null,
        action: "game.completed-detail-viewed",
        details: { gameName: match.publicName, eventCount: events.length, chatMessageCount: chat.length },
        occurredAt: now()
      });
      const names = new Map(match.participants.map((participant) => [participant.userId, participant.displayName]));
      return reply.send({
        game: publicAdminGame(match, privateRoom),
        events: publicEvents(events, names, match.winnerUserId),
        chatMessages: chat.map((message) => publicChat(message, match))
      });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  if (repository.setUserSuspended) {
    app.post("/api/admin/users/:userId/suspension", {
      config: { rateLimit: { max: 20, timeWindow: "10 minutes" } }
    }, async (request, reply) => {
      const session = await requireAdmin(request, reply);
      if (!session) return;
      const params = adminUserParamsSchema.safeParse(request.params);
      const body = suspensionBodySchema.safeParse(request.body);
      if (!params.success || !body.success) return sendValidationError(reply);
      if (params.data.userId === session.playerId && body.data.suspended) {
        return reply.code(409).send({ error: "Administrators cannot suspend their own account." });
      }
      try {
        const user = await repository.setUserSuspended({
          targetUserId: params.data.userId,
          suspended: body.data.suspended,
          reason: body.data.suspended ? body.data.reason : null,
          actorUserId: session.playerId,
          auditId: createId(),
          occurredAt: now()
        });
        if (body.data.suspended) await options.onUserSuspended?.(user.id);
        return reply.send({
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            status: user.suspendedAt ? "disabled" : "active"
          }
        });
      } catch (error) {
        return sendRepositoryError(request, reply, error);
      }
    });
  }
}
