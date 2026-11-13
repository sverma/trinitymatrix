import { z } from "zod";

export const playerCountSchema = z.union([z.literal(2), z.literal(6)]);
export type PlayerCount = z.infer<typeof playerCountSchema>;

export const matchTypeSchema = z.enum(["general", "private"]);
export type MatchType = z.infer<typeof matchTypeSchema>;

export const privateRoomCodeSchema = z.string().regex(/^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{6}$/);
export const privateRoomStatusSchema = z.enum(["waiting", "active", "completed", "cancelled"]);
export const privateRoomInvitationStatusSchema = z.enum(["pending", "accepted"]);

export const privateRoomSchema = z.object({
  roomCode: privateRoomCodeSchema,
  playerCount: playerCountSchema,
  status: privateRoomStatusSchema,
  creator: z.object({
    playerId: z.string().uuid(),
    displayName: z.string().trim().min(2).max(24)
  }).strict(),
  invites: z.array(z.object({
    seatNumber: z.number().int().min(1).max(5),
    email: z.string().trim().email().max(254).optional(),
    isCurrentUser: z.boolean().optional(),
    status: privateRoomInvitationStatusSchema,
    playerId: z.string().uuid().optional(),
    displayName: z.string().trim().min(2).max(24).optional()
  }).strict()).min(1).max(5),
  acceptedCount: z.number().int().min(1).max(6),
  requiredCount: playerCountSchema,
  createdAt: z.string().datetime({ offset: true }),
  gameName: z.string().regex(/^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{8}$/).optional()
}).strict().superRefine((room, context) => {
  if (room.invites.length !== room.playerCount - 1) {
    context.addIssue({ code: "custom", path: ["invites"], message: "A private room must have one invite per guest seat." });
  }
  const seats = new Set(room.invites.map(({ seatNumber }) => seatNumber));
  if (seats.size !== room.invites.length
    || Array.from({ length: room.playerCount - 1 }, (_, index) => index + 1).some((seat) => !seats.has(seat))) {
    context.addIssue({ code: "custom", path: ["invites"], message: "Private-room seats must be unique and contiguous." });
  }
  if (room.requiredCount !== room.playerCount
    || room.acceptedCount !== 1 + room.invites.filter(({ status }) => status === "accepted").length) {
    context.addIssue({ code: "custom", path: ["acceptedCount"], message: "Private-room acceptance totals are inconsistent." });
  }
  if ((room.status === "active" || room.status === "completed") && !room.gameName) {
    context.addIssue({ code: "custom", path: ["gameName"], message: "Started private rooms require a game name." });
  }
});
export type PrivateRoom = z.infer<typeof privateRoomSchema>;

export const privateInvitationSchema = z.object({
  roomCode: privateRoomCodeSchema,
  playerCount: playerCountSchema,
  creatorDisplayName: z.string().trim().min(2).max(24),
  status: privateRoomInvitationStatusSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type PrivateInvitation = z.infer<typeof privateInvitationSchema>;

export const profileBadgeIds = [
  "rookie",
  "strategist",
  "card-shark",
  "royal",
  "hot-streak",
  "diamond-hand",
  "champion",
  "night-owl"
] as const;
export const profileBadgeSchema = z.enum(profileBadgeIds);
export type ProfileBadgeId = z.infer<typeof profileBadgeSchema>;
export const profileBadges: readonly {
  id: ProfileBadgeId;
  label: string;
  symbol: string;
  description: string;
}[] = [
  { id: "rookie", label: "Rising player", symbol: "🌱", description: "Growing one hand at a time" },
  { id: "strategist", label: "Strategist", symbol: "🧠", description: "Plans every draw and discard" },
  { id: "card-shark", label: "Card shark", symbol: "🦈", description: "Always circling the open deck" },
  { id: "royal", label: "Table royalty", symbol: "👑", description: "Carries a champion's presence" },
  { id: "hot-streak", label: "Hot streak", symbol: "🔥", description: "Playing with unstoppable momentum" },
  { id: "diamond-hand", label: "Diamond hand", symbol: "💎", description: "Keeps calm under pressure" },
  { id: "champion", label: "Champion", symbol: "🏆", description: "Plays for the top of the ranking" },
  { id: "night-owl", label: "Night owl", symbol: "🦉", description: "Sharpest after the sun goes down" }
];

export const suitSchema = z.enum(["clubs", "diamonds", "hearts", "spades"]);
export type Suit = z.infer<typeof suitSchema>;

export const cardSchema = z.object({
  id: z.string().min(1),
  deck: z.number().int().min(1),
  suit: suitSchema.nullable(),
  rank: z.number().int().min(1).max(13).nullable(),
  printedJoker: z.boolean()
});
export type Card = z.infer<typeof cardSchema>;

export const publicPlayerSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  badgeId: profileBadgeSchema,
  actorKind: z.enum(["human", "ai"]).optional(),
  aiModelId: z.string().min(1).max(200).optional(),
  connected: z.boolean(),
  cardCount: z.number().int().nonnegative(),
  status: z.enum(["playing", "dropped", "declared"])
});
export type PublicPlayer = z.infer<typeof publicPlayerSchema>;

export const tossResultSchema = z.object({
  winnerId: z.string(),
  cards: z.array(z.object({ playerId: z.string(), card: cardSchema }).strict())
}).strict();
export type TossResult = z.infer<typeof tossResultSchema>;

export const publicGameNameSchema = z.string().regex(/^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{8}$/);

const gameCommandFields = {
  commandId: z.string().uuid(),
  gameId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative()
};

const handLayoutSchema = z.array(z.array(z.string().min(1)).min(1).max(14)).min(1).max(14)
  .superRefine((groups, context) => {
    const cardIds = groups.flat();
    if (new Set(cardIds).size !== cardIds.length) {
      context.addIssue({ code: "custom", message: "A hand layout cannot contain the same card twice." });
    }
  });

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("queue.join"), playerCount: playerCountSchema, broadcast: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("queue.leave") }).strict(),
  z.object({
    type: z.literal("game.draw"),
    ...gameCommandFields,
    source: z.enum(["stock", "discard"]),
    layout: handLayoutSchema.optional()
  }).strict(),
  z.object({
    type: z.literal("game.discard"),
    ...gameCommandFields,
    cardId: z.string().min(1),
    layout: handLayoutSchema.optional()
  }).strict(),
  z.object({ type: z.literal("game.drop"), ...gameCommandFields, layout: handLayoutSchema.optional() }).strict(),
  z.object({
    type: z.literal("game.submit-hand"),
    ...gameCommandFields,
    groups: z.array(z.array(z.string().min(1)).min(1)).min(1)
  }).strict(),
  z.object({
    type: z.literal("game.declare"),
    ...gameCommandFields,
    discardCardId: z.string().min(1),
    melds: z.array(z.array(z.string().min(1)).min(3)).min(1)
  }).strict(),
  z.object({ type: z.literal("ping"), at: z.number() }).strict()
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ShowdownPublicState = {
  declarerId: string;
  pendingPlayerIds: string[];
  submittedPlayerIds: string[];
  endsAt: number;
  score?: number | undefined;
};

export const showdownPublicStateSchema = z.object({
  declarerId: z.string(),
  pendingPlayerIds: z.array(z.string()),
  submittedPlayerIds: z.array(z.string()),
  endsAt: z.number(),
  score: z.number().int().nonnegative().optional()
}).strict().superRefine((showdown, context) => {
  const responders = [...showdown.pendingPlayerIds, ...showdown.submittedPlayerIds];
  if (new Set(showdown.pendingPlayerIds).size !== showdown.pendingPlayerIds.length
    || new Set(showdown.submittedPlayerIds).size !== showdown.submittedPlayerIds.length
    || new Set(responders).size !== responders.length
    || responders.includes(showdown.declarerId)) {
    context.addIssue({ code: "custom", message: "Showdown player ids must be unique and exclude the declarer." });
  }
});

export type GamePublicState = {
  gameId: string;
  gameName: string;
  playerCount: PlayerCount;
  matchType: MatchType;
  players: PublicPlayer[];
  currentPlayerId: string;
  topDiscard: Card | null;
  wildRank: number;
  stockCount: number;
  turnEndsAt: number;
  phase: "playing" | "showdown" | "finished";
  showdown: ShowdownPublicState | null;
  revision: number;
  toss: TossResult | null;
  broadcast?: { gameName: string; delayMs: number } | undefined;
};

export const gamePublicStateSchema = z.object({
  gameId: z.string().uuid(),
  gameName: publicGameNameSchema,
  playerCount: playerCountSchema,
  matchType: matchTypeSchema,
  players: z.array(publicPlayerSchema),
  currentPlayerId: z.string(),
  topDiscard: cardSchema.nullable(),
  wildRank: z.number().int().min(1).max(13),
  stockCount: z.number().int().nonnegative(),
  turnEndsAt: z.number(),
  phase: z.enum(["playing", "showdown", "finished"]),
  showdown: showdownPublicStateSchema.nullable(),
  revision: z.number().int().nonnegative(),
  toss: tossResultSchema.nullable(),
  broadcast: z.object({ gameName: publicGameNameSchema, delayMs: z.literal(120_000) }).strict().optional()
}).strict();

const postGameChatBodySchema = z.string().trim().min(1).refine((value) => [...value].length <= 280, {
  message: "Chat messages cannot exceed 280 characters."
});

export const postGameChatMessageSchema = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(24),
  message: postGameChatBodySchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type PostGameChatMessage = z.infer<typeof postGameChatMessageSchema>;

export const aiForfeitReasonCodeSchema = z.enum(["AI_UNAVAILABLE", "AI_INVALID_ACTION", "AI_BUDGET_EXHAUSTED"]);
export type AiForfeitReasonCode = z.infer<typeof aiForfeitReasonCodeSchema>;
export const aiForfeitNoticeSchema = z.object({ code: aiForfeitReasonCodeSchema, message: z.string().trim().min(1).max(300) }).strict();
export type AiForfeitNotice = z.infer<typeof aiForfeitNoticeSchema>;

export type ServerMessage =
  | { type: "session.ready"; playerId: string; displayName: string }
  | { type: "queue.status"; playerCount: PlayerCount; joined: number; required: number; broadcast?: boolean | undefined }
  | ({ type: "game.started"; hand: Card[] } & GamePublicState)
  | ({ type: "game.state" } & GamePublicState)
  | { type: "game.hand"; hand: Card[]; drawnCardId?: string | undefined }
  | { type: "game.declaration-rejected"; playerId: string; playerName: string; reason: string; dropped: true }
  | { type: "command.rejected"; commandId: string; code: string; message: string; revision: number }
  | { type: "game.player-dropped"; playerId: string; playerName: string; reasonCode?: AiForfeitReasonCode | undefined; reason?: string | undefined }
  | { type: "game.left"; gameId: string; outcome: "dropped" }
  | { type: "game.ended"; winnerId: string; winnerName: string; reason: "declaration" | "invalid-declaration" | "player-dropped"; score?: number | undefined }
  | { type: "chat.message"; gameName: string; message: PostGameChatMessage }
  | { type: "private.room-status"; room: PrivateRoom }
  | { type: "private.invitation"; invitation: PrivateInvitation }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; at: number };

export const serverMessageSchema: z.ZodType<ServerMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.ready"), playerId: z.string(), displayName: z.string() }).strict(),
  z.object({ type: z.literal("queue.status"), playerCount: playerCountSchema, joined: z.number().int(), required: z.number().int(), broadcast: z.boolean().optional() }).strict(),
  gamePublicStateSchema.extend({ type: z.literal("game.started"), hand: z.array(cardSchema) }).strict(),
  gamePublicStateSchema.extend({ type: z.literal("game.state") }).strict(),
  z.object({ type: z.literal("game.hand"), hand: z.array(cardSchema), drawnCardId: z.string().optional() }).strict(),
  z.object({
    type: z.literal("game.declaration-rejected"),
    playerId: z.string(),
    playerName: z.string(),
    reason: z.string(),
    dropped: z.literal(true)
  }).strict(),
  z.object({ type: z.literal("private.room-status"), room: privateRoomSchema }).strict(),
  z.object({ type: z.literal("private.invitation"), invitation: privateInvitationSchema }).strict(),
  z.object({ type: z.literal("game.player-dropped"), playerId: z.string(), playerName: z.string(),
    reasonCode: aiForfeitReasonCodeSchema.optional(), reason: z.string().min(1).max(300).optional() }).strict(),
  z.object({ type: z.literal("game.left"), gameId: z.string().uuid(), outcome: z.literal("dropped") }).strict(),
  z.object({ type: z.literal("command.rejected"), commandId: z.string(), code: z.string(), message: z.string(), revision: z.number().int() }).strict(),
  z.object({
    type: z.literal("game.ended"),
    winnerId: z.string(),
    winnerName: z.string(),
    reason: z.enum(["declaration", "invalid-declaration", "player-dropped"]),
    score: z.number().int().nonnegative().optional()
  }).strict(),
  z.object({
    type: z.literal("chat.message"),
    gameName: publicGameNameSchema,
    message: postGameChatMessageSchema
  }).strict(),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }).strict(),
  z.object({ type: z.literal("pong"), at: z.number() }).strict()
]);

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input);
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}

export function isJoker(card: Card, wildRank: number): boolean {
  return card.printedJoker || card.rank === wildRank;
}

export const BROADCAST_DELAY_MS = 120_000;
export const broadcastPlayerSchema = z.object({
  id: z.string().uuid(), displayName: z.string().min(1).max(24), badgeId: profileBadgeSchema,
  actorKind: z.enum(["human", "ai"]), aiModelId: z.string().min(1).max(200).optional()
}).strict();
export const liveBroadcastSummarySchema = z.object({
  gameName: publicGameNameSchema, gameId: z.string().uuid(), title: z.string().min(1).max(160),
  playerCount: playerCountSchema, composition: z.enum(["human", "ai", "mixed"]),
  players: z.array(broadcastPlayerSchema).min(2).max(6), status: z.enum(["buffering", "live", "ended"]),
  delayMs: z.literal(120_000), availableAt: z.number().int().nonnegative(), viewerCount: z.number().int().nonnegative()
}).strict();
export type LiveBroadcastSummary = z.infer<typeof liveBroadcastSummarySchema>;
export const broadcastFrameEventSchema = z.object({
  type: z.string().min(1).max(100), actorPlayerId: z.string().uuid().optional(), summary: z.string().max(200)
}).strict();
export const broadcastFrameSchema = z.object({
  sequence: z.number().int().positive(), capturedAt: z.number().int().nonnegative(), releasedAt: z.number().int().nonnegative(),
  game: gamePublicStateSchema,
  hands: z.array(z.object({ playerId: z.string().uuid(), cards: z.array(cardSchema).max(14) }).strict()).min(2).max(6),
  event: broadcastFrameEventSchema,
  winner: z.object({ id: z.string().uuid(), name: z.string().max(24),
    reason: z.enum(["declaration", "invalid-declaration", "player-dropped"]), score: z.number().int().nonnegative().optional()
  }).strict().optional()
}).strict();
export type BroadcastFrame = z.infer<typeof broadcastFrameSchema>;
export const broadcastCommentSchema = z.object({
  id: z.string().uuid(), playerId: z.string().uuid(), displayName: z.string().min(1).max(24),
  message: z.string().refine((value) => [...value].length <= 280), createdAt: z.number().int().nonnegative(), releasedAt: z.number().int().nonnegative(), deleted: z.boolean()
}).strict();
export type BroadcastComment = z.infer<typeof broadcastCommentSchema>;
export const broadcastCommentBodySchema = z.object({ message: postGameChatBodySchema, clientMessageId: z.string().uuid() }).strict();
export const liveBroadcastDirectorySchema = z.object({
  broadcasts: z.array(liveBroadcastSummarySchema).max(50), nextCursor: z.string().nullable(), serverNow: z.number()
}).strict();
export const liveBroadcastDetailSchema = z.object({
  broadcast: liveBroadcastSummarySchema, frame: broadcastFrameSchema.nullable(), comments: z.array(broadcastCommentSchema).max(100),
  serverNow: z.number(), canModerate: z.boolean()
}).strict();
export const broadcastTimelineSchema = z.object({
  frames: z.array(broadcastFrameSchema.pick({ sequence: true, capturedAt: true, event: true })).max(100), nextCursor: z.string().nullable()
}).strict();
export const broadcastFrameResponseSchema = z.object({ frame: broadcastFrameSchema }).strict();
export const broadcastCloseCodeSchema = z.enum(["closed", "restart", "unavailable", "auth-required"]);
export type BroadcastCloseCode = z.infer<typeof broadcastCloseCodeSchema>;
export type BroadcastEvent =
  | { type: "frame"; frame: BroadcastFrame }
  | { type: "comment"; comment: BroadcastComment }
  | { type: "viewers"; viewerCount: number }
  | { type: "closed"; reason: string; code?: BroadcastCloseCode | undefined };
export const broadcastEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("frame"), frame: broadcastFrameSchema }).strict(),
  z.object({ type: z.literal("comment"), comment: broadcastCommentSchema }).strict(),
  z.object({ type: z.literal("viewers"), viewerCount: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("closed"), reason: z.string().min(1).max(300), code: broadcastCloseCodeSchema.optional() }).strict()
]);
