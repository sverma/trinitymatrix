import { isDeepStrictEqual } from "node:util";
import type { MatchType, PlayerCount, ProfileBadgeId } from "@trinitymatrix/protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { PostGameChatCipher } from "./chat-crypto";

// Private production load identities use the reserved .test TLD and can only
// be created by the no-ingress canary task. Their durable events remain audit
// evidence, but they must never affect player rankings or normal admin totals.
const syntheticLoadEmailSqlPattern = "^tm-load-[a-f0-9]{32}-[0-9]{4}@example[.]test$";

export class RepositoryConflictError extends Error {
  override readonly name = "RepositoryConflictError";
}

export class RepositoryNotFoundError extends Error {
  override readonly name = "RepositoryNotFoundError";
}

export type UserProfileRecord = Readonly<{
  id: string;
  email: string;
  displayName: string;
  badgeId: ProfileBadgeId;
  phone: Readonly<{ countryCode: string; nationalNumber: string }> | null;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MatchParticipantRecord = Readonly<{
  userId: string;
  seatNumber: number;
  displayName: string;
  badgeId: ProfileBadgeId;
  outcome: "won" | "lost" | "dropped" | null;
  scoreDelta: number | null;
  ratingAfter: number | null;
}>;

export type MatchRecord = Readonly<{
  id: string;
  publicName: string;
  playerCount: PlayerCount;
  matchType?: MatchType;
  status: "active" | "completed" | "abandoned";
  winnerUserId: string | null;
  endReason: "declaration" | "invalid-declaration" | "player-dropped" | "cancelled" | null;
  startedAt: Date;
  endedAt: Date | null;
  participants: readonly MatchParticipantRecord[];
}>;

export type PrivateRoomInviteRecord = Readonly<{
  email: string;
  seatNumber: number;
  acceptedByUserId: string | null;
  acceptedDisplayName: string | null;
  acceptedAt: Date | null;
}>;

export type PrivateRoomRecord = Readonly<{
  id: string;
  roomCode: string;
  creatorUserId: string;
  creatorDisplayName: string;
  creatorEmail: string;
  playerCount: PlayerCount;
  status: "waiting" | "active" | "completed" | "cancelled";
  matchId: string | null;
  gameName: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  invites: readonly PrivateRoomInviteRecord[];
}>;

export type GameEventRecord = Readonly<{
  eventId: string;
  matchId: string;
  sequence: number;
  eventType: string;
  actorUserId: string | null;
  commandId: string | null;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}>;

export type RankingRecord = Readonly<{
  userId: string;
  displayName: string;
  badgeId: ProfileBadgeId;
  rating: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  drops: number;
}>;

export type ChatMessageRecord = Readonly<{
  id: string;
  matchId: string;
  authorUserId: string;
  clientMessageId: string;
  body: string;
  createdAt: Date;
}>;

export type AdminAuditRecord = Readonly<{
  auditId: string;
  actorUserId: string;
  targetUserId: string | null;
  action: string;
  details: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}>;

export type Page<Item, Cursor> = Readonly<{
  items: readonly Item[];
  nextCursor: Cursor | null;
}>;

export type RankingCursor = Readonly<{ rating: number; wins: number; userId: string }>;
export type MatchHistoryCursor = Readonly<{ startedAt: Date; matchId: string }>;
export type ChatCursor = Readonly<{ createdAt: Date; messageId: string }>;
export type GameEventCursor = Readonly<{ sequence: number }>;
export type AdminAuditCursor = Readonly<{ occurredAt: Date; auditId: string }>;
export type AdminUserCursor = Readonly<{ createdAt: Date; userId: string }>;
export type AdminUserPage = Page<UserProfileRecord, AdminUserCursor> & Readonly<{ total: number }>;
export type AdminOverview = Readonly<{
  users: number;
  suspendedUsers: number;
  activeMatches: number;
  activeGeneralMatches?: number;
  activePrivateMatches?: number;
  waitingPrivateRooms?: number;
  completedMatches: number;
  chatMessages: number;
}>;

export interface ApplicationRepository {
  upsertUserProfile(input: {
    id: string;
    email: string;
    displayName: string;
    badgeId: ProfileBadgeId;
    phone: { countryCode: string; nationalNumber: string } | null;
    now?: Date;
  }): Promise<UserProfileRecord>;
  getUserProfile(userId: string): Promise<UserProfileRecord | null>;
  createMatch(input: {
    id: string;
    publicName: string;
    playerCount: PlayerCount;
    matchType?: MatchType;
    startedAt: Date;
    participants: readonly {
      userId: string;
      seatNumber: number;
      displayName: string;
      badgeId: ProfileBadgeId;
    }[];
  }): Promise<MatchRecord>;
  startPrivateMatch(input: {
    roomCode: string;
    id: string;
    publicName: string;
    playerCount: PlayerCount;
    startedAt: Date;
    participants: readonly {
      userId: string;
      seatNumber: number;
      displayName: string;
      badgeId: ProfileBadgeId;
    }[];
    initialEvent: {
      eventId: string;
      payload: Readonly<Record<string, unknown>>;
    };
  }): Promise<MatchRecord>;
  createPrivateRoom(input: {
    id: string;
    roomCode: string;
    creatorUserId: string;
    playerCount: PlayerCount;
    inviteEmails: readonly string[];
    createdAt: Date;
  }): Promise<PrivateRoomRecord>;
  getPrivateRoomByCode(roomCode: string): Promise<PrivateRoomRecord | null>;
  listPrivateRoomsForUser(input: { userId: string; email: string }): Promise<readonly PrivateRoomRecord[]>;
  listWaitingPrivateRooms(): Promise<readonly PrivateRoomRecord[]>;
  listPrivateRoomsByMatchIds(matchIds: readonly string[]): Promise<readonly PrivateRoomRecord[]>;
  acceptPrivateRoomInvitation(input: {
    roomCode: string;
    userId: string;
    email: string;
    acceptedAt: Date;
  }): Promise<PrivateRoomRecord>;
  cancelPrivateRoom(input: { roomCode: string; creatorUserId: string; cancelledAt: Date }): Promise<PrivateRoomRecord>;
  activatePrivateRoom(input: { roomCode: string; matchId: string; startedAt: Date }): Promise<PrivateRoomRecord>;
  completePrivateRoom(input: { matchId: string; completedAt: Date }): Promise<void>;
  getMatch(matchId: string): Promise<MatchRecord | null>;
  getMatchByPublicName(publicName: string): Promise<MatchRecord | null>;
  appendGameEvents(input: {
    matchId: string;
    expectedNextSequence: number;
    events: readonly {
      eventId: string;
      eventType: string;
      actorUserId: string | null;
      commandId: string | null;
      payload: Readonly<Record<string, unknown>>;
      occurredAt: Date;
    }[];
  }): Promise<readonly GameEventRecord[]>;
  listGameEvents(input: {
    matchId: string;
    cursor?: GameEventCursor;
    limit?: number;
  }): Promise<Page<GameEventRecord, GameEventCursor>>;
  completeMatch(input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantResults: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
      scoreDelta: number;
      ratingAfter: number;
    }[];
  }): Promise<MatchRecord>;
  completeMatchAndUpdateRatings(input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantOutcomes: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
    }[];
  }): Promise<MatchRecord>;
  completePrivateMatch(input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantOutcomes: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
    }[];
  }): Promise<MatchRecord>;
  getRankingsForUsers(userIds: readonly string[]): Promise<readonly RankingRecord[]>;
  listRankings(input?: { cursor?: RankingCursor; limit?: number }): Promise<Page<RankingRecord, RankingCursor>>;
  listUserMatches(input: {
    userId: string;
    cursor?: MatchHistoryCursor;
    limit?: number;
  }): Promise<Page<MatchRecord, MatchHistoryCursor>>;
  addPostGameChatMessage(input: {
    id: string;
    matchId: string;
    authorUserId: string;
    clientMessageId: string;
    body: string;
    createdAt: Date;
  }): Promise<ChatMessageRecord>;
  listPostGameChat(input: {
    matchId: string;
    cursor?: ChatCursor;
    limit?: number;
  }): Promise<Page<ChatMessageRecord, ChatCursor>>;
  listAdminUsers(input?: {
    cursor?: AdminUserCursor;
    limit?: number;
    query?: string;
  }): Promise<AdminUserPage>;
  listAdminGames(input?: {
    cursor?: MatchHistoryCursor;
    limit?: number;
  }): Promise<Page<MatchRecord, MatchHistoryCursor>>;
  getAdminOverview(): Promise<AdminOverview>;
  getAdminGameByPublicName(publicName: string): Promise<MatchRecord | null>;
  setUserSuspended(input: {
    auditId: string;
    actorUserId: string;
    targetUserId: string;
    suspended: boolean;
    reason: string | null;
    occurredAt: Date;
  }): Promise<UserProfileRecord>;
  appendAdminAudit(input: {
    auditId: string;
    actorUserId: string;
    targetUserId: string | null;
    action: string;
    details: Readonly<Record<string, unknown>>;
    occurredAt: Date;
  }): Promise<AdminAuditRecord>;
  listAdminAuditLog(input?: {
    cursor?: AdminAuditCursor;
    targetUserId?: string;
    limit?: number;
  }): Promise<Page<AdminAuditRecord, AdminAuditCursor>>;
}

interface ProfileRow extends QueryResultRow {
  id: string;
  email: string;
  display_name: string;
  badge_id: ProfileBadgeId;
  phone_country_code: string | null;
  phone_national_number: string | null;
  suspended_at: Date | null;
  suspension_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MatchRow extends QueryResultRow {
  id: string;
  public_name: string;
  player_count: PlayerCount;
  match_type: MatchType;
  status: MatchRecord["status"];
  winner_user_id: string | null;
  end_reason: MatchRecord["endReason"];
  started_at: Date;
  ended_at: Date | null;
}

interface PrivateRoomRow extends QueryResultRow {
  id: string;
  room_code: string;
  creator_user_id: string;
  creator_display_name: string;
  creator_email: string;
  player_count: PlayerCount;
  status: PrivateRoomRecord["status"];
  match_id: string | null;
  game_name: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface PrivateInviteRow extends QueryResultRow {
  room_id: string;
  invite_email: string;
  seat_number: number;
  accepted_by_user_id: string | null;
  accepted_display_name: string | null;
  accepted_at: Date | null;
}

interface ParticipantRow extends QueryResultRow {
  user_id: string;
  seat_number: number;
  display_name: string;
  badge_id: ProfileBadgeId;
  outcome: MatchParticipantRecord["outcome"];
  score_delta: number | null;
  rating_after: number | null;
}

interface EventRow extends QueryResultRow {
  event_id: string;
  match_id: string;
  sequence: string | number;
  event_type: string;
  actor_user_id: string | null;
  command_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

interface RankingRow extends QueryResultRow {
  user_id: string;
  display_name: string;
  badge_id: ProfileBadgeId;
  rating: number;
  games_played: number;
  wins: number;
  losses: number;
  drops: number;
}

interface ChatRow extends QueryResultRow {
  id: string;
  match_id: string;
  author_user_id: string;
  client_message_id: string;
  body_ciphertext: Buffer;
  body_iv: Buffer;
  body_auth_tag: Buffer;
  body_key_version: number;
  created_at: Date;
}

interface AdminAuditRow extends QueryResultRow {
  audit_id: string;
  actor_user_id: string;
  target_user_id: string | null;
  action: string;
  details: Record<string, unknown>;
  occurred_at: Date;
}

type DatabasePool = Pick<Pool, "connect" | "query">;

function boundedLimit(limit = 25): number {
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

export function calculateDeterministicElo(
  players: readonly { userId: string; rating: number; outcome: "won" | "lost" | "dropped" }[],
  kFactor = 32
): readonly { userId: string; outcome: "won" | "lost" | "dropped"; scoreDelta: number; ratingAfter: number }[] {
  if (players.length !== 2 && players.length !== 6) throw new RepositoryConflictError("Elo requires 2 or 6 players.");
  const winner = players.find(({ outcome }) => outcome === "won");
  if (!winner || players.filter(({ outcome }) => outcome === "won").length !== 1) {
    throw new RepositoryConflictError("Elo requires exactly one winner.");
  }
  const deltas = players.map((player) => {
    const expected = players
      .filter(({ userId }) => userId !== player.userId)
      .reduce((sum, opponent) => sum + 1 / (1 + 10 ** ((opponent.rating - player.rating) / 400)), 0)
      / (players.length - 1);
    const actual = player.outcome === "won" ? 1 : 0;
    return Math.round(kFactor * (actual - expected));
  });
  const roundingResidual = deltas.reduce((sum, delta) => sum + delta, 0);
  const winnerIndex = players.findIndex(({ userId }) => userId === winner.userId);
  deltas[winnerIndex] = deltas[winnerIndex]! - roundingResidual;
  return players.map((player, index) => ({
    userId: player.userId,
    outcome: player.outcome,
    scoreDelta: deltas[index]!,
    ratingAfter: Math.max(0, player.rating + deltas[index]!)
  }));
}

function mapProfile(row: ProfileRow): UserProfileRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    badgeId: row.badge_id,
    phone: row.phone_country_code && row.phone_national_number
      ? { countryCode: row.phone_country_code, nationalNumber: row.phone_national_number }
      : null,
    suspendedAt: row.suspended_at,
    suspensionReason: row.suspension_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapParticipant(row: ParticipantRow): MatchParticipantRecord {
  return {
    userId: row.user_id,
    seatNumber: row.seat_number,
    displayName: row.display_name,
    badgeId: row.badge_id,
    outcome: row.outcome,
    scoreDelta: row.score_delta,
    ratingAfter: row.rating_after
  };
}

function mapEvent(row: EventRow): GameEventRecord {
  return {
    eventId: row.event_id,
    matchId: row.match_id,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    commandId: row.command_id,
    payload: row.payload,
    occurredAt: row.occurred_at
  };
}

function mapRanking(row: RankingRow): RankingRecord {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    badgeId: row.badge_id,
    rating: row.rating,
    gamesPlayed: row.games_played,
    wins: row.wins,
    losses: row.losses,
    drops: row.drops
  };
}

function mapChat(row: ChatRow, cipher: PostGameChatCipher): ChatMessageRecord {
  return {
    id: row.id,
    matchId: row.match_id,
    authorUserId: row.author_user_id,
    clientMessageId: row.client_message_id,
    body: cipher.decrypt(
      {
        ciphertext: row.body_ciphertext,
        iv: row.body_iv,
        authTag: row.body_auth_tag,
        keyVersion: row.body_key_version
      },
      {
        messageId: row.id,
        matchId: row.match_id,
        authorUserId: row.author_user_id,
        clientMessageId: row.client_message_id
      }
    ),
    createdAt: row.created_at
  };
}

async function inTransaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresApplicationRepository implements ApplicationRepository {
  constructor(
    private readonly pool: DatabasePool,
    private readonly chatCipher: PostGameChatCipher
  ) {}

  async upsertUserProfile(input: {
    id: string;
    email: string;
    displayName: string;
    badgeId: ProfileBadgeId;
    phone: { countryCode: string; nationalNumber: string } | null;
    now?: Date;
  }): Promise<UserProfileRecord> {
    const email = input.email.trim().toLowerCase();
    const now = input.now ?? new Date();
    return inTransaction(this.pool, async (client) => {
      const user = await client.query<{ id: string }>(
        `INSERT INTO app_users (id, email, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (email) DO UPDATE SET updated_at = EXCLUDED.updated_at
         RETURNING id`,
        [input.id, email, now]
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error("PostgreSQL did not return the upserted user.");
      await client.query(
        `INSERT INTO player_profiles (
           user_id, display_name, badge_id, phone_country_code, phone_national_number, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           badge_id = EXCLUDED.badge_id,
           phone_country_code = EXCLUDED.phone_country_code,
           phone_national_number = EXCLUDED.phone_national_number,
           updated_at = EXCLUDED.updated_at`,
        [
          userId,
          input.displayName.trim(),
          input.badgeId,
          input.phone?.countryCode ?? null,
          input.phone?.nationalNumber ?? null,
          now
        ]
      );
      await client.query(
        "INSERT INTO player_rankings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
        [userId]
      );
      const profile = await this.selectProfile(client, userId);
      if (!profile) throw new Error("PostgreSQL did not return the upserted profile.");
      return profile;
    });
  }

  async getUserProfile(userId: string): Promise<UserProfileRecord | null> {
    return this.selectProfile(this.pool, userId);
  }

  private async selectProfile(
    queryable: Pick<DatabasePool, "query">,
    userId: string
  ): Promise<UserProfileRecord | null> {
    const result = await queryable.query<ProfileRow>(
      `SELECT u.id, u.email, p.display_name, p.badge_id,
              p.phone_country_code, p.phone_national_number,
              u.suspended_at, u.suspension_reason,
              u.created_at, p.updated_at
       FROM app_users u
       JOIN player_profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async createMatch(input: {
    id: string;
    publicName: string;
    playerCount: PlayerCount;
    matchType?: MatchType;
    startedAt: Date;
    participants: readonly {
      userId: string;
      seatNumber: number;
      displayName: string;
      badgeId: ProfileBadgeId;
    }[];
  }): Promise<MatchRecord> {
    this.validateNewMatch(input);
    return inTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ranking_matches (id, public_name, player_count, match_type, started_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [input.id, input.publicName, input.playerCount, input.matchType ?? "general", input.startedAt]
      );
      if (inserted.rowCount === 0) {
        const existing = await this.selectMatch(client, "id", input.id);
        if (!existing || !this.sameMatchCreation(existing, input)) {
          throw new RepositoryConflictError("The match id is already used by a different match.");
        }
        return existing;
      }
      for (const participant of input.participants) {
        await client.query(
          `INSERT INTO match_participants (
             match_id, user_id, seat_number, display_name, badge_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.id, participant.userId, participant.seatNumber, participant.displayName, participant.badgeId]
        );
      }
      const created = await this.selectMatch(client, "id", input.id);
      if (!created) throw new Error("PostgreSQL did not return the created match.");
      return created;
    });
  }

  async startPrivateMatch(input: {
    roomCode: string;
    id: string;
    publicName: string;
    playerCount: PlayerCount;
    startedAt: Date;
    participants: readonly {
      userId: string;
      seatNumber: number;
      displayName: string;
      badgeId: ProfileBadgeId;
    }[];
    initialEvent: {
      eventId: string;
      payload: Readonly<Record<string, unknown>>;
    };
  }): Promise<MatchRecord> {
    const matchInput = { ...input, matchType: "private" as const };
    this.validateNewMatch(matchInput);
    if (!input.initialEvent.payload || Array.isArray(input.initialEvent.payload)) {
      throw new RepositoryConflictError("Game event payloads must be JSON objects.");
    }
    return inTransaction(this.pool, async (client) => {
      const locked = await client.query<{
        id: string;
        status: PrivateRoomRecord["status"];
        match_id: string | null;
        player_count: PlayerCount;
        accepted_count: string | number;
      }>(
        `SELECT r.id, r.status, r.match_id, r.player_count,
                (SELECT count(*) FROM private_match_invitations i
                 WHERE i.room_id = r.id AND i.accepted_by_user_id IS NOT NULL) AS accepted_count
         FROM private_match_rooms r
         WHERE r.room_code = $1
         FOR UPDATE OF r`,
        [input.roomCode]
      );
      const room = locked.rows[0];
      if (!room) throw new RepositoryNotFoundError("The private room does not exist.");
      if (room.status === "active" && room.match_id === input.id) {
        const existing = await this.selectMatch(client, "id", input.id);
        if (!existing || !this.sameMatchCreation(existing, matchInput)) {
          throw new RepositoryConflictError("The private room is linked to a different match.");
        }
        return existing;
      }
      if (room.status !== "waiting" || room.match_id
        || room.player_count !== input.playerCount
        || Number(room.accepted_count) !== input.playerCount - 1) {
        throw new RepositoryConflictError("The private room is no longer ready to start.");
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ranking_matches (id, public_name, player_count, match_type, started_at)
         VALUES ($1, $2, $3, 'private', $4)
         RETURNING id`,
        [input.id, input.publicName, input.playerCount, input.startedAt]
      );
      if (!inserted.rows[0]) throw new Error("PostgreSQL did not create the private match.");
      for (const participant of input.participants) {
        await client.query(
          `INSERT INTO match_participants (
             match_id, user_id, seat_number, display_name, badge_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.id, participant.userId, participant.seatNumber, participant.displayName, participant.badgeId]
        );
      }
      const activated = await client.query(
        `UPDATE private_match_rooms
         SET status = 'active', match_id = $2, started_at = $3, updated_at = $3
         WHERE id = $1 AND status = 'waiting'`,
        [room.id, input.id, input.startedAt]
      );
      if (activated.rowCount !== 1) throw new RepositoryConflictError("The private room is no longer ready to start.");
      await client.query(
        `INSERT INTO game_events (
           event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
         ) VALUES ($1, $2, 1, 'game.started', NULL, NULL, $3::jsonb, $4)`,
        [input.initialEvent.eventId, input.id, JSON.stringify(input.initialEvent.payload), input.startedAt]
      );
      const created = await this.selectMatch(client, "id", input.id);
      if (!created) throw new Error("PostgreSQL did not return the started private match.");
      return created;
    });
  }

  private async selectPrivateRoom(
    queryable: Pick<DatabasePool, "query">,
    key: "id" | "room_code",
    value: string
  ): Promise<PrivateRoomRecord | null> {
    const rooms = await queryable.query<PrivateRoomRow>(
      `SELECT r.id, r.room_code, r.creator_user_id, cp.display_name AS creator_display_name,
              cu.email AS creator_email, r.player_count, r.status, r.match_id,
              m.public_name AS game_name, r.created_at, r.updated_at, r.started_at, r.completed_at
       FROM private_match_rooms r
       JOIN app_users cu ON cu.id = r.creator_user_id
       JOIN player_profiles cp ON cp.user_id = r.creator_user_id
       LEFT JOIN ranking_matches m ON m.id = r.match_id
       WHERE r.${key} = $1`,
      [value]
    );
    const room = rooms.rows[0];
    if (!room) return null;
    const invitations = await queryable.query<PrivateInviteRow>(
      `SELECT i.room_id, i.invite_email, i.seat_number, i.accepted_by_user_id,
              p.display_name AS accepted_display_name, i.accepted_at
       FROM private_match_invitations i
       LEFT JOIN player_profiles p ON p.user_id = i.accepted_by_user_id
       WHERE i.room_id = $1
       ORDER BY i.seat_number ASC`,
      [room.id]
    );
    return {
      id: room.id,
      roomCode: room.room_code,
      creatorUserId: room.creator_user_id,
      creatorDisplayName: room.creator_display_name,
      creatorEmail: room.creator_email,
      playerCount: room.player_count,
      status: room.status,
      matchId: room.match_id,
      gameName: room.game_name,
      createdAt: room.created_at,
      updatedAt: room.updated_at,
      startedAt: room.started_at,
      completedAt: room.completed_at,
      invites: invitations.rows.map((invite) => ({
        email: invite.invite_email,
        seatNumber: invite.seat_number,
        acceptedByUserId: invite.accepted_by_user_id,
        acceptedDisplayName: invite.accepted_display_name,
        acceptedAt: invite.accepted_at
      }))
    };
  }

  async createPrivateRoom(input: {
    id: string;
    roomCode: string;
    creatorUserId: string;
    playerCount: PlayerCount;
    inviteEmails: readonly string[];
    createdAt: Date;
  }): Promise<PrivateRoomRecord> {
    const emails = input.inviteEmails.map((email) => email.trim().toLowerCase());
    if (emails.length !== input.playerCount - 1 || new Set(emails).size !== emails.length) {
      throw new RepositoryConflictError("Supply one unique invitation email for every other player.");
    }
    return inTransaction(this.pool, async (client) => {
      const creator = await client.query<{ email: string; suspended_at: Date | null }>(
        "SELECT email, suspended_at FROM app_users WHERE id = $1 FOR UPDATE",
        [input.creatorUserId]
      );
      const identity = creator.rows[0];
      if (!identity || identity.suspended_at) throw new RepositoryNotFoundError("The creator account is unavailable.");
      if (emails.includes(identity.email)) throw new RepositoryConflictError("You cannot invite your own email address.");
      const busy = await client.query<{ id: string }>(
        `SELECT r.id
         FROM private_match_rooms r
         WHERE r.status IN ('waiting', 'active')
           AND (r.creator_user_id = $1 OR EXISTS (
             SELECT 1 FROM private_match_invitations i
             WHERE i.room_id = r.id AND i.accepted_by_user_id = $1
           ))
         LIMIT 1
         FOR UPDATE OF r`,
        [input.creatorUserId]
      );
      if (busy.rows[0]) throw new RepositoryConflictError("Finish or cancel your current private match first.");
      const activeMatch = await client.query<{ id: string }>(
        `SELECT m.id FROM ranking_matches m
         JOIN match_participants p ON p.match_id = m.id
         WHERE p.user_id = $1 AND m.status = 'active'
         LIMIT 1 FOR UPDATE OF m`,
        [input.creatorUserId]
      );
      if (activeMatch.rows[0]) throw new RepositoryConflictError("You already have an active game.");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO private_match_rooms (
           id, room_code, creator_user_id, player_count, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (room_code) DO NOTHING
         RETURNING id`,
        [input.id, input.roomCode, input.creatorUserId, input.playerCount, input.createdAt]
      );
      if (!inserted.rows[0]) throw new RepositoryConflictError("That private room code is already in use.");
      for (const [index, email] of emails.entries()) {
        await client.query(
          `INSERT INTO private_match_invitations (room_id, invite_email, seat_number, created_at)
           VALUES ($1, $2, $3, $4)`,
          [input.id, email, index + 1, input.createdAt]
        );
      }
      const room = await this.selectPrivateRoom(client, "id", input.id);
      if (!room) throw new Error("PostgreSQL did not return the created private room.");
      return room;
    });
  }

  async getPrivateRoomByCode(roomCode: string): Promise<PrivateRoomRecord | null> {
    return this.selectPrivateRoom(this.pool, "room_code", roomCode);
  }

  private async loadPrivateRooms(ids: readonly string[]): Promise<readonly PrivateRoomRecord[]> {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const [rooms, invitations] = await Promise.all([
      this.pool.query<PrivateRoomRow>(
        `SELECT r.id, r.room_code, r.creator_user_id, cp.display_name AS creator_display_name,
                cu.email AS creator_email, r.player_count, r.status, r.match_id,
                m.public_name AS game_name, r.created_at, r.updated_at, r.started_at, r.completed_at
         FROM private_match_rooms r
         JOIN app_users cu ON cu.id = r.creator_user_id
         JOIN player_profiles cp ON cp.user_id = r.creator_user_id
         LEFT JOIN ranking_matches m ON m.id = r.match_id
         WHERE r.id = ANY($1::uuid[])`,
        [uniqueIds]
      ),
      this.pool.query<PrivateInviteRow>(
        `SELECT i.room_id, i.invite_email, i.seat_number, i.accepted_by_user_id,
                p.display_name AS accepted_display_name, i.accepted_at
         FROM private_match_invitations i
         LEFT JOIN player_profiles p ON p.user_id = i.accepted_by_user_id
         WHERE i.room_id = ANY($1::uuid[])
         ORDER BY i.room_id ASC, i.seat_number ASC`,
        [uniqueIds]
      )
    ]);
    const invitesByRoom = new Map<string, PrivateRoomInviteRecord[]>();
    for (const invite of invitations.rows) {
      const list = invitesByRoom.get(invite.room_id) ?? [];
      list.push({
        email: invite.invite_email,
        seatNumber: invite.seat_number,
        acceptedByUserId: invite.accepted_by_user_id,
        acceptedDisplayName: invite.accepted_display_name,
        acceptedAt: invite.accepted_at
      });
      invitesByRoom.set(invite.room_id, list);
    }
    const byId = new Map(rooms.rows.map((room) => [room.id, {
      id: room.id,
      roomCode: room.room_code,
      creatorUserId: room.creator_user_id,
      creatorDisplayName: room.creator_display_name,
      creatorEmail: room.creator_email,
      playerCount: room.player_count,
      status: room.status,
      matchId: room.match_id,
      gameName: room.game_name,
      createdAt: room.created_at,
      updatedAt: room.updated_at,
      startedAt: room.started_at,
      completedAt: room.completed_at,
      invites: invitesByRoom.get(room.id) ?? []
    } satisfies PrivateRoomRecord]));
    return ids.flatMap((id) => {
      const room = byId.get(id);
      return room ? [room] : [];
    });
  }

  async listPrivateRoomsForUser(input: { userId: string; email: string }): Promise<readonly PrivateRoomRecord[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT r.id, r.created_at
       FROM private_match_rooms r
       LEFT JOIN private_match_invitations i ON i.room_id = r.id
       WHERE r.status IN ('waiting', 'active')
         AND (r.creator_user_id = $1 OR i.invite_email = $2 OR i.accepted_by_user_id = $1)
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 100`,
      [input.userId, input.email.trim().toLowerCase()]
    );
    return this.loadPrivateRooms(result.rows.map(({ id }) => id));
  }

  async listWaitingPrivateRooms(): Promise<readonly PrivateRoomRecord[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM private_match_rooms
       WHERE status = 'waiting'
       ORDER BY created_at ASC, id ASC
       LIMIT 10000`
    );
    return this.loadPrivateRooms(result.rows.map(({ id }) => id));
  }

  async listPrivateRoomsByMatchIds(matchIds: readonly string[]): Promise<readonly PrivateRoomRecord[]> {
    if (matchIds.length === 0) return [];
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM private_match_rooms
       WHERE match_id = ANY($1::uuid[])
       ORDER BY created_at DESC, id DESC`,
      [[...new Set(matchIds)]]
    );
    return this.loadPrivateRooms(result.rows.map(({ id }) => id));
  }

  async acceptPrivateRoomInvitation(input: {
    roomCode: string;
    userId: string;
    email: string;
    acceptedAt: Date;
  }): Promise<PrivateRoomRecord> {
    const email = input.email.trim().toLowerCase();
    return inTransaction(this.pool, async (client) => {
      const eligibility = await client.query<{
        room_id: string;
        status: PrivateRoomRecord["status"];
        accepted_by_user_id: string | null;
        account_email: string;
        suspended_at: Date | null;
      }>(
        `SELECT r.id AS room_id, r.status, i.accepted_by_user_id,
                u.email AS account_email, u.suspended_at
         FROM private_match_rooms r
         JOIN private_match_invitations i ON i.room_id = r.id AND i.invite_email = $2
         JOIN app_users u ON u.id = $3
         WHERE r.room_code = $1
         FOR UPDATE OF r, i, u`,
        [input.roomCode, email, input.userId]
      );
      const invitation = eligibility.rows[0];
      // Deliberately use the same not-found response for an unknown room and a
      // room to which this exact authenticated email was not invited.
      if (!invitation || invitation.account_email !== email || invitation.suspended_at) {
        throw new RepositoryNotFoundError("The private invitation was not found.");
      }
      if (invitation.status !== "waiting") throw new RepositoryConflictError("This private room is no longer accepting players.");
      if (invitation.accepted_by_user_id === input.userId) {
        const existing = await this.selectPrivateRoom(client, "id", invitation.room_id);
        if (!existing) throw new RepositoryNotFoundError("The private invitation was not found.");
        return existing;
      }
      if (invitation.accepted_by_user_id) throw new RepositoryConflictError("This invitation has already been accepted.");
      const busy = await client.query<{ id: string }>(
        `SELECT r.id
         FROM private_match_rooms r
         WHERE r.status IN ('waiting', 'active')
           AND r.id <> $2
           AND (r.creator_user_id = $1 OR EXISTS (
             SELECT 1 FROM private_match_invitations i
             WHERE i.room_id = r.id AND i.accepted_by_user_id = $1
           ))
         LIMIT 1 FOR UPDATE OF r`,
        [input.userId, invitation.room_id]
      );
      if (busy.rows[0]) throw new RepositoryConflictError("Finish or cancel your current private match first.");
      const activeMatch = await client.query<{ id: string }>(
        `SELECT m.id FROM ranking_matches m
         JOIN match_participants p ON p.match_id = m.id
         WHERE p.user_id = $1 AND m.status = 'active'
         LIMIT 1 FOR UPDATE OF m`,
        [input.userId]
      );
      if (activeMatch.rows[0]) throw new RepositoryConflictError("You already have an active game.");
      await client.query(
        `UPDATE private_match_invitations
         SET accepted_by_user_id = $3, accepted_at = $4
         WHERE room_id = $1 AND invite_email = $2 AND accepted_by_user_id IS NULL`,
        [invitation.room_id, email, input.userId, input.acceptedAt]
      );
      await client.query("UPDATE private_match_rooms SET updated_at = $2 WHERE id = $1", [invitation.room_id, input.acceptedAt]);
      const accepted = await this.selectPrivateRoom(client, "id", invitation.room_id);
      if (!accepted) throw new Error("PostgreSQL did not return the accepted private room.");
      return accepted;
    });
  }

  async cancelPrivateRoom(input: {
    roomCode: string;
    creatorUserId: string;
    cancelledAt: Date;
  }): Promise<PrivateRoomRecord> {
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE private_match_rooms
         SET status = 'cancelled', updated_at = $3, completed_at = $3
         WHERE room_code = $1 AND creator_user_id = $2 AND status = 'waiting'
         RETURNING id`,
        [input.roomCode, input.creatorUserId, input.cancelledAt]
      );
      if (!updated.rows[0]) throw new RepositoryNotFoundError("The waiting private room was not found.");
      const room = await this.selectPrivateRoom(client, "id", updated.rows[0].id);
      if (!room) throw new Error("PostgreSQL did not return the cancelled private room.");
      return room;
    });
  }

  async activatePrivateRoom(input: { roomCode: string; matchId: string; startedAt: Date }): Promise<PrivateRoomRecord> {
    return inTransaction(this.pool, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE private_match_rooms r
         SET status = 'active', match_id = $2, started_at = $3, updated_at = $3
         WHERE r.room_code = $1 AND r.status = 'waiting'
           AND (SELECT count(*) FROM private_match_invitations i
                WHERE i.room_id = r.id AND i.accepted_by_user_id IS NOT NULL) = r.player_count - 1
         RETURNING r.id`,
        [input.roomCode, input.matchId, input.startedAt]
      );
      if (!updated.rows[0]) {
        const existing = await this.selectPrivateRoom(client, "room_code", input.roomCode);
        if (existing?.status === "active" && existing.matchId === input.matchId) return existing;
        throw new RepositoryConflictError("The private room is not ready to start.");
      }
      const room = await this.selectPrivateRoom(client, "id", updated.rows[0].id);
      if (!room) throw new Error("PostgreSQL did not return the active private room.");
      return room;
    });
  }

  async completePrivateRoom(input: { matchId: string; completedAt: Date }): Promise<void> {
    await this.pool.query(
      `UPDATE private_match_rooms
       SET status = 'completed', completed_at = $2, updated_at = $2
       WHERE match_id = $1 AND status = 'active'`,
      [input.matchId, input.completedAt]
    );
  }

  async getMatch(matchId: string): Promise<MatchRecord | null> {
    return this.selectMatch(this.pool, "id", matchId);
  }

  async getMatchByPublicName(publicName: string): Promise<MatchRecord | null> {
    return this.selectMatch(this.pool, "public_name", publicName);
  }

  private validateNewMatch(input: {
    publicName: string;
    playerCount: PlayerCount;
    participants: readonly { userId: string; seatNumber: number }[];
  }): void {
    if (!/^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-\d{8}$/.test(input.publicName)) {
      throw new RepositoryConflictError("The public match name must use adjective-noun-12345678 format.");
    }
    if (input.participants.length !== input.playerCount) {
      throw new RepositoryConflictError("Participant count must equal the match player count.");
    }
    const userIds = new Set(input.participants.map(({ userId }) => userId));
    const seats = new Set(input.participants.map(({ seatNumber }) => seatNumber));
    if (userIds.size !== input.playerCount || seats.size !== input.playerCount) {
      throw new RepositoryConflictError("Match participants and seats must be unique.");
    }
    for (let seat = 0; seat < input.playerCount; seat += 1) {
      if (!seats.has(seat)) throw new RepositoryConflictError("Match seats must be contiguous from zero.");
    }
  }

  private sameMatchCreation(
    match: MatchRecord,
    input: {
      publicName: string;
      playerCount: PlayerCount;
      matchType?: MatchType;
      startedAt: Date;
      participants: readonly { userId: string; seatNumber: number; displayName: string; badgeId: ProfileBadgeId }[];
    }
  ): boolean {
    if (match.publicName !== input.publicName || match.playerCount !== input.playerCount
      || match.matchType !== (input.matchType ?? "general")
      || match.startedAt.getTime() !== input.startedAt.getTime()) return false;
    const expected = [...input.participants].sort((a, b) => a.seatNumber - b.seatNumber);
    return match.participants.every((participant, index) => {
      const candidate = expected[index];
      return candidate !== undefined
        && participant.userId === candidate.userId
        && participant.seatNumber === candidate.seatNumber
        && participant.displayName === candidate.displayName
        && participant.badgeId === candidate.badgeId;
    });
  }

  private async selectMatch(
    queryable: Pick<DatabasePool, "query">,
    key: "id" | "public_name",
    value: string
  ): Promise<MatchRecord | null> {
    const matchResult = await queryable.query<MatchRow>(
      `SELECT id, public_name, player_count, match_type, status, winner_user_id, end_reason, started_at, ended_at
       FROM ranking_matches
       WHERE ${key} = $1`,
      [value]
    );
    const match = matchResult.rows[0];
    if (!match) return null;
    const participantResult = await queryable.query<ParticipantRow>(
      `SELECT user_id, seat_number, display_name, badge_id, outcome, score_delta, rating_after
       FROM match_participants
       WHERE match_id = $1
       ORDER BY seat_number ASC`,
      [match.id]
    );
    return {
      id: match.id,
      publicName: match.public_name,
      playerCount: match.player_count,
      matchType: match.match_type,
      status: match.status,
      winnerUserId: match.winner_user_id,
      endReason: match.end_reason,
      startedAt: match.started_at,
      endedAt: match.ended_at,
      participants: participantResult.rows.map(mapParticipant)
    };
  }

  async appendGameEvents(input: {
    matchId: string;
    expectedNextSequence: number;
    events: readonly {
      eventId: string;
      eventType: string;
      actorUserId: string | null;
      commandId: string | null;
      payload: Readonly<Record<string, unknown>>;
      occurredAt: Date;
    }[];
  }): Promise<readonly GameEventRecord[]> {
    if (!Number.isSafeInteger(input.expectedNextSequence) || input.expectedNextSequence < 1) {
      throw new RepositoryConflictError("The expected event sequence must be a positive safe integer.");
    }
    if (input.events.length === 0) return [];
    if (input.events.some(({ payload }) => !payload || Array.isArray(payload))) {
      throw new RepositoryConflictError("Game event payloads must be JSON objects.");
    }
    return inTransaction(this.pool, async (client) => {
      const match = await client.query<{ status: MatchRecord["status"] }>(
        "SELECT status FROM ranking_matches WHERE id = $1 FOR UPDATE",
        [input.matchId]
      );
      if (!match.rows[0]) throw new RepositoryNotFoundError("The match does not exist.");
      if (match.rows[0].status !== "active") throw new RepositoryConflictError("Only active matches accept game events.");

      const eventIds = input.events.map(({ eventId }) => eventId);
      const existing = await client.query<EventRow>(
        `SELECT event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
         FROM game_events
         WHERE event_id = ANY($1::uuid[])
         ORDER BY sequence ASC`,
        [eventIds]
      );
      if (existing.rows.length > 0) {
        const mapped = existing.rows.map(mapEvent);
        if (mapped.length === input.events.length && this.sameEvents(mapped, input)) return mapped;
        throw new RepositoryConflictError("One or more event ids are already used by different events.");
      }

      const sequence = await client.query<{ last_sequence: string | number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM game_events WHERE match_id = $1",
        [input.matchId]
      );
      const nextSequence = Number(sequence.rows[0]?.last_sequence ?? 0) + 1;
      if (nextSequence !== input.expectedNextSequence) {
        throw new RepositoryConflictError(`Expected event sequence ${nextSequence}, received ${input.expectedNextSequence}.`);
      }

      const inserted: GameEventRecord[] = [];
      for (const [index, event] of input.events.entries()) {
        const eventSequence = input.expectedNextSequence + index;
        const result = await client.query<EventRow>(
          `INSERT INTO game_events (
             event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           RETURNING event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at`,
          [
            event.eventId,
            input.matchId,
            eventSequence,
            event.eventType,
            event.actorUserId,
            event.commandId,
            JSON.stringify(event.payload),
            event.occurredAt
          ]
        );
        const row = result.rows[0];
        if (!row) throw new Error("PostgreSQL did not return the appended game event.");
        inserted.push(mapEvent(row));
      }
      return inserted;
    });
  }

  private sameEvents(
    stored: readonly GameEventRecord[],
    input: {
      matchId: string;
      expectedNextSequence: number;
      events: readonly {
        eventId: string;
        eventType: string;
        actorUserId: string | null;
        commandId: string | null;
        payload: Readonly<Record<string, unknown>>;
        occurredAt: Date;
      }[];
    }
  ): boolean {
    return stored.every((event, index) => {
      const expected = input.events[index];
      return expected !== undefined
        && event.eventId === expected.eventId
        && event.matchId === input.matchId
        && event.sequence === input.expectedNextSequence + index
        && event.eventType === expected.eventType
        && event.actorUserId === expected.actorUserId
        && event.commandId === expected.commandId
        && event.occurredAt.getTime() === expected.occurredAt.getTime()
        && isDeepStrictEqual(event.payload, expected.payload);
    });
  }

  async listGameEvents(input: {
    matchId: string;
    cursor?: GameEventCursor;
    limit?: number;
  }): Promise<Page<GameEventRecord, GameEventCursor>> {
    const limit = boundedLimit(input.limit);
    const parameters: unknown[] = input.cursor
      ? [input.matchId, input.cursor.sequence, limit + 1]
      : [input.matchId, limit + 1];
    const cursorClause = input.cursor ? "AND sequence > $2" : "";
    const limitPlaceholder = input.cursor ? "$3" : "$2";
    const result = await this.pool.query<EventRow>(
      `SELECT event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
       FROM game_events
       WHERE match_id = $1 ${cursorClause}
       ORDER BY sequence ASC
       LIMIT ${limitPlaceholder}`,
      parameters
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(mapEvent);
    const last = hasNext ? items.at(-1) : undefined;
    return { items, nextCursor: last ? { sequence: last.sequence } : null };
  }

  async completeMatch(input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantResults: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
      scoreDelta: number;
      ratingAfter: number;
    }[];
  }): Promise<MatchRecord> {
    return inTransaction(this.pool, (client) => this.completeMatchWithResults(client, input));
  }

  async completeMatchAndUpdateRatings(input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantOutcomes: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
    }[];
  }): Promise<MatchRecord> {
    if (input.participantOutcomes.find(({ outcome }) => outcome === "won")?.userId !== input.winnerUserId
      || input.participantOutcomes.filter(({ outcome }) => outcome === "won").length !== 1) {
      throw new RepositoryConflictError("A completed match must have exactly one winning participant.");
    }
    return inTransaction(this.pool, async (client) => {
      const matchLock = await client.query<{ id: string }>(
        "SELECT id FROM ranking_matches WHERE id = $1 FOR UPDATE",
        [input.matchId]
      );
      if (!matchLock.rows[0]) throw new RepositoryNotFoundError("The match does not exist.");
      const userIds = input.participantOutcomes.map(({ userId }) => userId);
      const rankings = await client.query<{ user_id: string; rating: number }>(
        `SELECT user_id, rating
         FROM player_rankings
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id ASC
         FOR UPDATE`,
        [userIds]
      );
      if (rankings.rows.length !== userIds.length) {
        throw new RepositoryConflictError("Every participant must have an initialized ranking.");
      }
      const ratings = new Map(rankings.rows.map(({ user_id, rating }) => [user_id, rating]));
      const participantResults = calculateDeterministicElo(input.participantOutcomes.map((participant) => ({
        ...participant,
        rating: ratings.get(participant.userId) ?? 1000
      })));
      return this.completeMatchWithResults(client, { ...input, participantResults });
    });
  }

  async completePrivateMatch(input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantOutcomes: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
    }[];
  }): Promise<MatchRecord> {
    if (input.participantOutcomes.find(({ outcome }) => outcome === "won")?.userId !== input.winnerUserId
      || input.participantOutcomes.filter(({ outcome }) => outcome === "won").length !== 1) {
      throw new RepositoryConflictError("A completed match must have exactly one winning participant.");
    }
    return inTransaction(this.pool, async (client) => {
      const match = await client.query<{ match_type: MatchType }>(
        "SELECT match_type FROM ranking_matches WHERE id = $1 FOR UPDATE",
        [input.matchId]
      );
      if (!match.rows[0]) throw new RepositoryNotFoundError("The match does not exist.");
      if (match.rows[0].match_type !== "private") {
        throw new RepositoryConflictError("Only private matches can use unranked completion.");
      }
      const rankings = await client.query<{ user_id: string; rating: number }>(
        `SELECT user_id, rating FROM player_rankings
         WHERE user_id = ANY($1::uuid[])
         ORDER BY user_id ASC FOR UPDATE`,
        [input.participantOutcomes.map(({ userId }) => userId)]
      );
      if (rankings.rows.length !== input.participantOutcomes.length) {
        throw new RepositoryConflictError("Every participant must have an initialized ranking.");
      }
      const ratingByUser = new Map(rankings.rows.map(({ user_id, rating }) => [user_id, rating]));
      return this.completeMatchWithResults(client, {
        ...input,
        participantResults: input.participantOutcomes.map((participant) => ({
          ...participant,
          scoreDelta: 0,
          ratingAfter: ratingByUser.get(participant.userId) ?? 1000
        }))
      }, false);
    });
  }

  private async completeMatchWithResults(client: PoolClient, input: {
    matchId: string;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantResults: readonly {
      userId: string;
      outcome: "won" | "lost" | "dropped";
      scoreDelta: number;
      ratingAfter: number;
    }[];
  }, updateRankings = true): Promise<MatchRecord> {
    if (input.participantResults.filter(({ outcome }) => outcome === "won").length !== 1
      || input.participantResults.find(({ outcome }) => outcome === "won")?.userId !== input.winnerUserId) {
      throw new RepositoryConflictError("A completed match must have exactly one winning participant.");
    }
    const locked = await client.query<{
        status: MatchRecord["status"];
        winner_user_id: string | null;
        end_reason: MatchRecord["endReason"];
        participant_count: number;
      }>(
        `SELECT m.status, m.winner_user_id, m.end_reason,
                (SELECT count(*)::int FROM match_participants p WHERE p.match_id = m.id) AS participant_count
         FROM ranking_matches m
         WHERE m.id = $1
         FOR UPDATE`,
        [input.matchId]
      );
      const match = locked.rows[0];
      if (!match) throw new RepositoryNotFoundError("The match does not exist.");
      if (match.status === "completed") {
        if (match.winner_user_id !== input.winnerUserId || match.end_reason !== input.endReason) {
          throw new RepositoryConflictError("The match is already completed with a different result.");
        }
        const existing = await this.selectMatch(client, "id", input.matchId);
        if (!existing) throw new RepositoryNotFoundError("The completed match does not exist.");
        return existing;
      }
      if (match.status !== "active") throw new RepositoryConflictError("Only active matches can be completed.");
      if (match.participant_count !== input.participantResults.length
        || new Set(input.participantResults.map(({ userId }) => userId)).size !== input.participantResults.length) {
        throw new RepositoryConflictError("A result is required for every unique match participant.");
      }

      for (const result of input.participantResults) {
        const updated = await client.query(
          `UPDATE match_participants
           SET outcome = $3, score_delta = $4, rating_after = $5
           WHERE match_id = $1 AND user_id = $2 AND outcome IS NULL`,
          [input.matchId, result.userId, result.outcome, result.scoreDelta, result.ratingAfter]
        );
        if (updated.rowCount !== 1) throw new RepositoryConflictError("A participant result is missing or already recorded.");

        if (updateRankings) {
          const wins = result.outcome === "won" ? 1 : 0;
          const drops = result.outcome === "dropped" ? 1 : 0;
          const losses = result.outcome === "lost" ? 1 : 0;
          await client.query(
            `INSERT INTO player_rankings (user_id, rating, games_played, wins, losses, drops, updated_at)
             VALUES ($1, $2, 1, $3, $4, $5, $6)
             ON CONFLICT (user_id) DO UPDATE SET
               rating = EXCLUDED.rating,
               games_played = player_rankings.games_played + 1,
               wins = player_rankings.wins + EXCLUDED.wins,
               losses = player_rankings.losses + EXCLUDED.losses,
               drops = player_rankings.drops + EXCLUDED.drops,
               updated_at = EXCLUDED.updated_at`,
            [result.userId, result.ratingAfter, wins, losses, drops, input.endedAt]
          );
        }
      }
      await client.query(
        `UPDATE ranking_matches
         SET status = 'completed', winner_user_id = $2, end_reason = $3, ended_at = $4
         WHERE id = $1`,
        [input.matchId, input.winnerUserId, input.endReason, input.endedAt]
      );
      const completed = await this.selectMatch(client, "id", input.matchId);
      if (!completed) throw new Error("PostgreSQL did not return the completed match.");
    return completed;
  }

  async listRankings(input: { cursor?: RankingCursor; limit?: number } = {}): Promise<Page<RankingRecord, RankingCursor>> {
    const limit = boundedLimit(input.limit);
    const cursor = input.cursor;
    const parameters: unknown[] = cursor
      ? [cursor.rating, cursor.wins, cursor.userId, limit + 1]
      : [limit + 1];
    const cursorClause = cursor
      ? `AND (
           r.rating < $1
           OR (r.rating = $1 AND r.wins < $2)
           OR (r.rating = $1 AND r.wins = $2 AND r.user_id > $3)
         )`
      : "";
    const limitPlaceholder = cursor ? "$4" : "$1";
    const result = await this.pool.query<RankingRow>(
      `SELECT r.user_id, p.display_name, p.badge_id, r.rating,
              r.games_played, r.wins, r.losses, r.drops
       FROM player_rankings r
       JOIN player_profiles p ON p.user_id = r.user_id
       JOIN app_users u ON u.id = r.user_id
       WHERE u.email !~ '${syntheticLoadEmailSqlPattern}' ${cursorClause}
       ORDER BY r.rating DESC, r.wins DESC, r.user_id ASC
       LIMIT ${limitPlaceholder}`,
      parameters
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(mapRanking);
    const last = hasNext ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { rating: last.rating, wins: last.wins, userId: last.userId } : null
    };
  }

  async getRankingsForUsers(userIds: readonly string[]): Promise<readonly RankingRecord[]> {
    if (userIds.length === 0) return [];
    const result = await this.pool.query<RankingRow>(
      `SELECT r.user_id, p.display_name, p.badge_id, r.rating,
              r.games_played, r.wins, r.losses, r.drops
       FROM player_rankings r
       JOIN player_profiles p ON p.user_id = r.user_id
       WHERE r.user_id = ANY($1::uuid[])
       ORDER BY r.user_id ASC`,
      [[...new Set(userIds)]]
    );
    return result.rows.map(mapRanking);
  }

  async listUserMatches(input: {
    userId: string;
    cursor?: MatchHistoryCursor;
    limit?: number;
  }): Promise<Page<MatchRecord, MatchHistoryCursor>> {
    const limit = boundedLimit(input.limit);
    const parameters: unknown[] = input.cursor
      ? [input.userId, input.cursor.startedAt, input.cursor.matchId, limit + 1]
      : [input.userId, limit + 1];
    const cursorClause = input.cursor ? "AND (m.started_at, m.id) < ($2, $3)" : "";
    const limitPlaceholder = input.cursor ? "$4" : "$2";
    const page = await this.pool.query<{ id: string; started_at: Date }>(
      `SELECT m.id, m.started_at
       FROM ranking_matches m
       JOIN match_participants p ON p.match_id = m.id
       WHERE p.user_id = $1 ${cursorClause}
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT ${limitPlaceholder}`,
      parameters
    );
    const hasNext = page.rows.length > limit;
    const rows = page.rows.slice(0, limit);
    const matches = await Promise.all(rows.map(({ id }) => this.selectMatch(this.pool, "id", id)));
    const items = matches.filter((match): match is MatchRecord => match !== null);
    const last = hasNext ? rows.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { startedAt: last.started_at, matchId: last.id } : null
    };
  }

  async addPostGameChatMessage(input: {
    id: string;
    matchId: string;
    authorUserId: string;
    clientMessageId: string;
    body: string;
    createdAt: Date;
  }): Promise<ChatMessageRecord> {
    const body = input.body.trim();
    if ([...body].length < 1 || [...body].length > 280) {
      throw new RepositoryConflictError("Chat messages must contain between 1 and 280 characters.");
    }
    return inTransaction(this.pool, async (client) => {
      const eligibility = await client.query<{ status: MatchRecord["status"] }>(
        `SELECT m.status
         FROM ranking_matches m
         JOIN match_participants p ON p.match_id = m.id AND p.user_id = $2
         WHERE m.id = $1
         FOR UPDATE OF m, p`,
        [input.matchId, input.authorUserId]
      );
      if (!eligibility.rows[0]) throw new RepositoryNotFoundError("The match or participant does not exist.");
      if (eligibility.rows[0].status !== "completed") {
        throw new RepositoryConflictError("Post-game chat opens only after a match is completed.");
      }
      const existing = await client.query<ChatRow>(
        `SELECT id, match_id, author_user_id, client_message_id,
                body_ciphertext, body_iv, body_auth_tag, body_key_version, created_at
         FROM post_game_chat_messages
         WHERE match_id = $1 AND author_user_id = $2 AND client_message_id = $3`,
        [input.matchId, input.authorUserId, input.clientMessageId]
      );
      if (existing.rows[0]) {
        const message = mapChat(existing.rows[0], this.chatCipher);
        if (message.body !== body) {
          throw new RepositoryConflictError("The chat idempotency key is already used by another message.");
        }
        return message;
      }
      const count = await client.query<{ message_count: number }>(
        `SELECT count(*)::int AS message_count
         FROM post_game_chat_messages
         WHERE match_id = $1 AND author_user_id = $2`,
        [input.matchId, input.authorUserId]
      );
      if ((count.rows[0]?.message_count ?? 0) >= 3) {
        throw new RepositoryConflictError("Each participant may send at most three post-game messages per match.");
      }
      const encrypted = this.chatCipher.encrypt(body, {
        messageId: input.id,
        matchId: input.matchId,
        authorUserId: input.authorUserId,
        clientMessageId: input.clientMessageId
      });
      const inserted = await client.query<ChatRow>(
        `INSERT INTO post_game_chat_messages (
           id, match_id, author_user_id, client_message_id,
           body_ciphertext, body_iv, body_auth_tag, body_key_version, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, match_id, author_user_id, client_message_id,
                   body_ciphertext, body_iv, body_auth_tag, body_key_version, created_at`,
        [
          input.id,
          input.matchId,
          input.authorUserId,
          input.clientMessageId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyVersion,
          input.createdAt
        ]
      );
      const message = inserted.rows[0];
      if (!message) throw new Error("PostgreSQL did not return the inserted chat message.");
      return mapChat(message, this.chatCipher);
    });
  }

  async listPostGameChat(input: {
    matchId: string;
    cursor?: ChatCursor;
    limit?: number;
  }): Promise<Page<ChatMessageRecord, ChatCursor>> {
    const limit = boundedLimit(input.limit);
    const parameters: unknown[] = input.cursor
      ? [input.matchId, input.cursor.createdAt, input.cursor.messageId, limit + 1]
      : [input.matchId, limit + 1];
    const cursorClause = input.cursor ? "AND (c.created_at, c.id) > ($2, $3)" : "";
    const limitPlaceholder = input.cursor ? "$4" : "$2";
    const result = await this.pool.query<ChatRow>(
      `SELECT c.id, c.match_id, c.author_user_id, c.client_message_id,
              c.body_ciphertext, c.body_iv, c.body_auth_tag, c.body_key_version, c.created_at
       FROM post_game_chat_messages c
       JOIN ranking_matches m ON m.id = c.match_id AND m.status = 'completed'
       WHERE c.match_id = $1 ${cursorClause}
       ORDER BY c.created_at ASC, c.id ASC
       LIMIT ${limitPlaceholder}`,
      parameters
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => mapChat(row, this.chatCipher));
    const last = hasNext ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { createdAt: last.createdAt, messageId: last.id } : null
    };
  }

  async listAdminUsers(input: {
    cursor?: AdminUserCursor;
    limit?: number;
    query?: string;
  } = {}): Promise<AdminUserPage> {
    const limit = boundedLimit(input.limit);
    const query = input.query?.trim() || undefined;
    const searchPattern = query ? `%${query.replace(/[\\%_]/g, "\\$&")}%` : undefined;
    const searchClause = searchPattern
      ? "(u.email ILIKE $1 ESCAPE E'\\\\' OR p.display_name ILIKE $1 ESCAPE E'\\\\')"
      : "TRUE";
    const totalResult = await this.pool.query<{ total: string | number }>(
      `SELECT count(*) AS total
       FROM app_users u
       JOIN player_profiles p ON p.user_id = u.id
       WHERE u.email !~ '${syntheticLoadEmailSqlPattern}' AND ${searchClause}`,
      searchPattern ? [searchPattern] : []
    );
    const total = Number(totalResult.rows[0]?.total ?? 0);
    const parameters: unknown[] = [];
    if (searchPattern) parameters.push(searchPattern);
    const searchPlaceholder = searchPattern ? "$1" : undefined;
    const predicates = [`u.email !~ '${syntheticLoadEmailSqlPattern}'`, searchPlaceholder
      ? `(u.email ILIKE ${searchPlaceholder} ESCAPE E'\\\\' OR p.display_name ILIKE ${searchPlaceholder} ESCAPE E'\\\\')`
      : "TRUE"];
    if (input.cursor) {
      const createdAtPlaceholder = `$${parameters.push(input.cursor.createdAt)}`;
      const userIdPlaceholder = `$${parameters.push(input.cursor.userId)}`;
      predicates.push(`(u.created_at, u.id) < (${createdAtPlaceholder}, ${userIdPlaceholder})`);
    }
    const limitPlaceholder = `$${parameters.push(limit + 1)}`;
    const result = await this.pool.query<ProfileRow>(
      `SELECT u.id, u.email, p.display_name, p.badge_id,
              p.phone_country_code, p.phone_national_number,
              u.suspended_at, u.suspension_reason,
              u.created_at, p.updated_at
       FROM app_users u
       JOIN player_profiles p ON p.user_id = u.id
       WHERE ${predicates.join(" AND ")}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ${limitPlaceholder}`,
      parameters
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(mapProfile);
    const last = hasNext ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { createdAt: last.createdAt, userId: last.id } : null,
      total
    };
  }

  async listAdminGames(input: {
    cursor?: MatchHistoryCursor;
    limit?: number;
  } = {}): Promise<Page<MatchRecord, MatchHistoryCursor>> {
    const limit = boundedLimit(input.limit);
    const parameters: unknown[] = input.cursor
      ? [input.cursor.startedAt, input.cursor.matchId, limit + 1]
      : [limit + 1];
    const cursorClause = input.cursor ? "AND (m.started_at, m.id) < ($1, $2)" : "";
    const limitPlaceholder = input.cursor ? "$3" : "$1";
    const page = await this.pool.query<{ id: string; started_at: Date }>(
      `SELECT m.id, m.started_at
       FROM ranking_matches m
       WHERE EXISTS (
         SELECT 1
         FROM match_participants visible_participant
         JOIN app_users visible_user ON visible_user.id = visible_participant.user_id
         WHERE visible_participant.match_id = m.id
           AND visible_user.email !~ '${syntheticLoadEmailSqlPattern}'
       ) ${cursorClause}
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT ${limitPlaceholder}`,
      parameters
    );
    const hasNext = page.rows.length > limit;
    const rows = page.rows.slice(0, limit);
    const loaded = await Promise.all(rows.map(({ id }) => this.selectMatch(this.pool, "id", id)));
    const items = loaded.filter((match): match is MatchRecord => match !== null);
    const last = hasNext ? rows.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { startedAt: last.started_at, matchId: last.id } : null
    };
  }

  async getAdminOverview(): Promise<AdminOverview> {
    const result = await this.pool.query<{
      users: string | number;
      suspended_users: string | number;
      active_matches: string | number;
      active_general_matches: string | number;
      active_private_matches: string | number;
      waiting_private_rooms: string | number;
      completed_matches: string | number;
      chat_messages: string | number;
    }>(
      `SELECT
         (SELECT count(*) FROM app_users WHERE email !~ '${syntheticLoadEmailSqlPattern}') AS users,
         (SELECT count(*) FROM app_users
          WHERE suspended_at IS NOT NULL AND email !~ '${syntheticLoadEmailSqlPattern}') AS suspended_users,
         (SELECT count(*) FROM ranking_matches visible_match
          WHERE status = 'active' AND EXISTS (
            SELECT 1 FROM match_participants visible_participant
            JOIN app_users visible_user ON visible_user.id = visible_participant.user_id
            WHERE visible_participant.match_id = visible_match.id
              AND visible_user.email !~ '${syntheticLoadEmailSqlPattern}'
          )) AS active_matches,
         (SELECT count(*) FROM ranking_matches visible_match
          WHERE status = 'active' AND match_type = 'general' AND EXISTS (
            SELECT 1 FROM match_participants visible_participant
            JOIN app_users visible_user ON visible_user.id = visible_participant.user_id
            WHERE visible_participant.match_id = visible_match.id
              AND visible_user.email !~ '${syntheticLoadEmailSqlPattern}'
          )) AS active_general_matches,
         (SELECT count(*) FROM ranking_matches visible_match
          WHERE status = 'active' AND match_type = 'private' AND EXISTS (
            SELECT 1 FROM match_participants visible_participant
            JOIN app_users visible_user ON visible_user.id = visible_participant.user_id
            WHERE visible_participant.match_id = visible_match.id
              AND visible_user.email !~ '${syntheticLoadEmailSqlPattern}'
          )) AS active_private_matches,
         (SELECT count(*) FROM private_match_rooms WHERE status = 'waiting') AS waiting_private_rooms,
         (SELECT count(*) FROM ranking_matches visible_match
          WHERE status = 'completed' AND EXISTS (
            SELECT 1 FROM match_participants visible_participant
            JOIN app_users visible_user ON visible_user.id = visible_participant.user_id
            WHERE visible_participant.match_id = visible_match.id
              AND visible_user.email !~ '${syntheticLoadEmailSqlPattern}'
          )) AS completed_matches,
         (SELECT count(*) FROM post_game_chat_messages visible_chat
          WHERE EXISTS (
            SELECT 1 FROM match_participants visible_participant
            JOIN app_users visible_user ON visible_user.id = visible_participant.user_id
            WHERE visible_participant.match_id = visible_chat.match_id
              AND visible_user.email !~ '${syntheticLoadEmailSqlPattern}'
          )) AS chat_messages`
    );
    const row = result.rows[0];
    if (!row) throw new Error("PostgreSQL did not return the admin overview.");
    return {
      users: Number(row.users),
      suspendedUsers: Number(row.suspended_users),
      activeMatches: Number(row.active_matches),
      activeGeneralMatches: Number(row.active_general_matches),
      activePrivateMatches: Number(row.active_private_matches),
      waitingPrivateRooms: Number(row.waiting_private_rooms),
      completedMatches: Number(row.completed_matches),
      chatMessages: Number(row.chat_messages)
    };
  }

  async getAdminGameByPublicName(publicName: string): Promise<MatchRecord | null> {
    return this.getMatchByPublicName(publicName);
  }

  async setUserSuspended(input: {
    auditId: string;
    actorUserId: string;
    targetUserId: string;
    suspended: boolean;
    reason: string | null;
    occurredAt: Date;
  }): Promise<UserProfileRecord> {
    const reason = input.reason?.trim() ?? null;
    if (input.suspended && (!reason || reason.length < 3 || reason.length > 500)) {
      throw new RepositoryConflictError("Suspending a user requires a reason between 3 and 500 characters.");
    }
    if (!input.suspended && reason !== null) {
      throw new RepositoryConflictError("Reinstating a user does not accept a suspension reason.");
    }
    return inTransaction(this.pool, async (client) => {
      const target = await client.query<{ id: string; suspended_at: Date | null; suspension_reason: string | null }>(
        "SELECT id, suspended_at, suspension_reason FROM app_users WHERE id = $1 FOR UPDATE",
        [input.targetUserId]
      );
      const previous = target.rows[0];
      if (!previous) throw new RepositoryNotFoundError("The target user does not exist.");
      const action = input.suspended ? "user.suspended" : "user.reinstated";
      const existingAudit = await client.query<AdminAuditRow>(
        `SELECT audit_id, actor_user_id, target_user_id, action, details, occurred_at
         FROM admin_audit_log
         WHERE audit_id = $1`,
        [input.auditId]
      );
      if (existingAudit.rows[0]) {
        const existing = existingAudit.rows[0];
        if (existing.actor_user_id !== input.actorUserId || existing.target_user_id !== input.targetUserId
          || existing.action !== action) {
          throw new RepositoryConflictError("The audit id is already used by a different admin action.");
        }
        const profile = await this.selectProfile(client, input.targetUserId);
        if (!profile) throw new RepositoryNotFoundError("The target profile does not exist.");
        return profile;
      }
      await client.query(
        `UPDATE app_users
         SET suspended_at = $2, suspension_reason = $3, updated_at = $4
         WHERE id = $1`,
        [input.targetUserId, input.suspended ? input.occurredAt : null, input.suspended ? reason : null, input.occurredAt]
      );
      await client.query(
        `INSERT INTO admin_audit_log (
           audit_id, actor_user_id, target_user_id, action, details, occurred_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [input.auditId, input.actorUserId, input.targetUserId, action, JSON.stringify({
          previousSuspended: previous.suspended_at !== null,
          suspended: input.suspended,
          reason: input.suspended ? reason : previous.suspension_reason
        }), input.occurredAt]
      );
      const profile = await this.selectProfile(client, input.targetUserId);
      if (!profile) throw new RepositoryNotFoundError("The target profile does not exist.");
      return profile;
    });
  }

  async appendAdminAudit(input: {
    auditId: string;
    actorUserId: string;
    targetUserId: string | null;
    action: string;
    details: Readonly<Record<string, unknown>>;
    occurredAt: Date;
  }): Promise<AdminAuditRecord> {
    if (!input.details || Array.isArray(input.details) || input.action.trim().length < 3 || input.action.trim().length > 100) {
      throw new RepositoryConflictError("Admin audit actions require a valid action and JSON-object details.");
    }
    const inserted = await this.pool.query<AdminAuditRow>(
      `INSERT INTO admin_audit_log (
         audit_id, actor_user_id, target_user_id, action, details, occurred_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (audit_id) DO NOTHING
       RETURNING audit_id, actor_user_id, target_user_id, action, details, occurred_at`,
      [
        input.auditId,
        input.actorUserId,
        input.targetUserId,
        input.action.trim(),
        JSON.stringify(input.details),
        input.occurredAt
      ]
    );
    const existing = inserted.rows[0] ?? (await this.pool.query<AdminAuditRow>(
      `SELECT audit_id, actor_user_id, target_user_id, action, details, occurred_at
       FROM admin_audit_log WHERE audit_id = $1`,
      [input.auditId]
    )).rows[0];
    if (!existing || existing.actor_user_id !== input.actorUserId || existing.target_user_id !== input.targetUserId
      || existing.action !== input.action.trim() || !isDeepStrictEqual(existing.details, input.details)) {
      throw new RepositoryConflictError("The audit id is already used by a different admin action.");
    }
    return {
      auditId: existing.audit_id,
      actorUserId: existing.actor_user_id,
      targetUserId: existing.target_user_id,
      action: existing.action,
      details: existing.details,
      occurredAt: existing.occurred_at
    };
  }

  async listAdminAuditLog(input: {
    cursor?: AdminAuditCursor;
    targetUserId?: string;
    limit?: number;
  } = {}): Promise<Page<AdminAuditRecord, AdminAuditCursor>> {
    const limit = boundedLimit(input.limit);
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    if (input.targetUserId) {
      parameters.push(input.targetUserId);
      conditions.push(`target_user_id = $${parameters.length}`);
    }
    if (input.cursor) {
      parameters.push(input.cursor.occurredAt, input.cursor.auditId);
      conditions.push(`(occurred_at, audit_id) < ($${parameters.length - 1}, $${parameters.length})`);
    }
    parameters.push(limit + 1);
    const result = await this.pool.query<AdminAuditRow>(
      `SELECT audit_id, actor_user_id, target_user_id, action, details, occurred_at
       FROM admin_audit_log
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY occurred_at DESC, audit_id DESC
       LIMIT $${parameters.length}`,
      parameters
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => ({
      auditId: row.audit_id,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      action: row.action,
      details: row.details,
      occurredAt: row.occurred_at
    }));
    const last = hasNext ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: last ? { occurredAt: last.occurredAt, auditId: last.auditId } : null
    };
  }
}
