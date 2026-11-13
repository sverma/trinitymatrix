import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  BROADCAST_DELAY_MS, broadcastCommentBodySchema, broadcastFrameSchema, cardSchema, liveBroadcastSummarySchema,
  type BroadcastComment, type BroadcastFrame, type LiveBroadcastSummary
} from "@trinitymatrix/protocol";
import { rankingGameSnapshotSchema, type RankingGameSnapshot } from "./game";

export type BroadcastAccess = {
  broadcastId: string; matchId: string; gameName: string; participantIds: string[]; allAi: boolean; ended: boolean;
};
export type BroadcastDirectoryQuery = {
  composition: "all" | "human" | "ai" | "mixed"; status: "all" | "live" | "ended"; q?: string | undefined;
  cursor?: { createdAt: string; id: string }; limit: number;
};
export type BroadcastDetail = { broadcast: LiveBroadcastSummary; frame: BroadcastFrame | null; comments: BroadcastComment[] };
export type BroadcastReport = { id: string; broadcastName: string; comment: BroadcastComment; reason: string; createdAt: number };
export class BroadcastConflictError extends Error {}
export interface BroadcastRepository {
  enableForGame(snapshot: RankingGameSnapshot): Promise<void>;
  access(gameName: string, userId: string): Promise<BroadcastAccess | null>;
  directory(query: BroadcastDirectoryQuery, now?: Date): Promise<{ broadcasts: LiveBroadcastSummary[]; nextCursor: { createdAt: string; id: string } | null }>;
  detail(gameName: string, now?: Date): Promise<BroadcastDetail | null>;
  frame(gameName: string, sequence: number, now?: Date): Promise<BroadcastFrame | null>;
  timeline(gameName: string, beforeSequence: number | undefined, limit: number, now?: Date): Promise<{ frames: Pick<BroadcastFrame, "sequence" | "capturedAt" | "event">[]; nextCursor: string | null }>;
  addComment(gameName: string, userId: string, body: { message: string; clientMessageId: string }): Promise<{ availableAt: number; delayed: boolean; comment?: BroadcastComment }>;
  deleteComment(gameName: string, commentId: string, moderatorId: string): Promise<boolean>;
  reportComment(gameName: string, commentId: string, reporterId: string, reason: string): Promise<boolean>;
  reports(limit: number, cursor?: { createdAt: string; id: string }, now?: Date): Promise<{ reports: BroadcastReport[]; nextCursor: { createdAt: string; id: string } | null }>;
  resolveReport(id: string, moderatorId: string, removeComment: boolean): Promise<boolean>;
  close(gameName: string): Promise<string | null>;
}

type ArchiveEvent = { sequence: number; eventType: string; actorUserId: string | null; payload: unknown; occurredAt: Date; recordedAt: Date };
type ReleasedWinner = NonNullable<BroadcastFrame["winner"]>;
const eventLabels: Record<string, string> = {
  "game.started": "Game started", "game.draw": "Drew a card", "game.discard": "Discarded a card", "game.drop": "Left the game",
  "game.declare": "Declared a hand", "game.submit-hand": "Submitted a final hand", "game.turn-timed-out": "Turn timed out",
  "game.showdown-timed-out": "Final hand deadline reached"
};

/** The only archive-to-viewer boundary. Never spread stored snapshots or commands. */
export function projectBroadcastFrame(event: ArchiveEvent, gameName: string, now: Date, winner?: ReleasedWinner): BroadcastFrame | null {
  const occurredAt = event.occurredAt.getTime();
  const recordedAt = event.recordedAt.getTime();
  const releasedAt = Math.max(occurredAt, recordedAt) + BROADCAST_DELAY_MS;
  if (!Number.isFinite(releasedAt) || releasedAt > now.getTime()) return null;
  const payload = event.payload && typeof event.payload === "object" ? event.payload as { state?: unknown } : {};
  const parsed = rankingGameSnapshotSchema.safeParse(payload.state);
  if (!parsed.success) return null;
  const state = parsed.data;
  if (state.publicName !== gameName || state.seats.length !== state.playerCount || state.hands.length !== state.playerCount
    || state.currentPlayerIndex >= state.seats.length
    || state.seats.length !== new Set(state.seats.map(({ id }) => id)).size
    || state.hands.length !== new Set(state.hands.map(({ playerId }) => playerId)).size
    || state.hands.some(({ playerId, cards }) => !state.seats.some(({ id }) => id === playerId) || cards.length > 14)
    || new Set(state.hands.flatMap(({ cards }) => cards.map(({ id }) => id))).size !== state.hands.reduce((count, { cards }) => count + cards.length, 0)) return null;
  const players = state.seats.map((seat) => ({
    id: seat.id, displayName: seat.displayName, badgeId: seat.badgeId, actorKind: seat.actorKind ?? "human",
    ...(seat.actorKind === "ai" && seat.aiModelId ? { aiModelId: seat.aiModelId } : {}),
    connected: seat.connected, status: seat.status, cardCount: state.hands.find(({ playerId }) => playerId === seat.id)!.cards.length
  }));
  const eventType = Object.hasOwn(eventLabels, event.eventType) ? event.eventType : "game.update";
  const actor = players.find(({ id }) => id === event.actorUserId);
  const frame = {
    sequence: event.sequence, capturedAt: occurredAt, releasedAt,
    game: {
      gameId: state.id, gameName, playerCount: state.playerCount, matchType: "general", players,
      currentPlayerId: players[state.currentPlayerIndex]?.id ?? "", topDiscard: state.discard.at(-1) ? cardSchema.parse(state.discard.at(-1)) : null,
      wildRank: state.wildRank, stockCount: state.stock.length, turnEndsAt: state.turnEndsAt, phase: state.phase,
      showdown: state.showdown ? {
        declarerId: state.showdown.declarerId, pendingPlayerIds: [...state.showdown.pendingPlayerIds],
        submittedPlayerIds: state.showdown.submissions.map(({ playerId }) => playerId), endsAt: state.showdown.endsAt, score: state.showdown.score
      } : null,
      revision: state.revision, toss: state.toss ? {
        winnerId: state.toss.winnerId, cards: state.toss.cards.map(({ playerId, card }) => ({ playerId, card: cardSchema.parse(card) }))
      } : null,
      broadcast: { gameName, delayMs: BROADCAST_DELAY_MS }
    },
    hands: state.hands.map(({ playerId, cards }) => ({ playerId, cards: cards.map((card) => cardSchema.parse(card)) })),
    event: { type: eventType, ...(actor ? { actorPlayerId: actor.id } : {}), summary: `${actor ? `${actor.displayName}: ` : ""}${eventLabels[eventType] ?? "Game updated"}` },
    ...(winner && state.phase === "finished" && players.some(({ id }) => id === winner.id) ? { winner } : {})
  };
  const safe = broadcastFrameSchema.safeParse(frame);
  return safe.success ? safe.data : null;
}

type Row = {
  id: string; match_id: string; public_name: string; created_at: Date; available_at: Date;
  player_count: 2 | 6; players: { id: string; displayName: string; badgeId: string; actorKind: "human" | "ai"; aiModelId: string | null }[];
  composition: "human" | "ai" | "mixed"; sequence: string | null; event_type: string | null; actor_user_id: string | null;
  payload: unknown; occurred_at: Date | null; recorded_at: Date | null; result_recorded_at: Date | null;
  winner_user_id: string | null; end_reason: ReleasedWinner["reason"] | null;
};
const selectBroadcast = `SELECT b.id,b.match_id,b.public_name,b.created_at,
  CASE WHEN b.result_recorded_at <= $1::timestamptz-interval '120 seconds' THEN b.result_recorded_at ELSE NULL END AS result_recorded_at,
  m.player_count,m.winner_user_id,m.end_reason,
  roster.players,roster.composition,initial.available_at,e.sequence,e.event_type,e.actor_user_id,e.payload,e.occurred_at,e.recorded_at
  FROM live_broadcasts b JOIN ranking_matches m ON m.id=b.match_id AND m.match_type='general'
  JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',p.user_id,'displayName',p.display_name,'badgeId',p.badge_id,
      'actorKind',u.actor_kind,'aiModelId',a.model_id) ORDER BY p.seat_number) AS players,
      CASE WHEN bool_and(u.actor_kind='ai') THEN 'ai' WHEN bool_and(u.actor_kind='human') THEN 'human' ELSE 'mixed' END AS composition
    FROM match_participants p JOIN app_users u ON u.id=p.user_id LEFT JOIN ai_agents a ON a.user_id=u.id WHERE p.match_id=b.match_id
  ) roster ON true
  JOIN LATERAL (SELECT GREATEST(occurred_at,recorded_at)+interval '120 seconds' AS available_at
    FROM game_events WHERE match_id=b.match_id AND sequence=1) initial ON true
  LEFT JOIN LATERAL (SELECT sequence,event_type,actor_user_id,payload,occurred_at,recorded_at FROM game_events
    WHERE match_id=b.match_id AND occurred_at <= $1::timestamptz-interval '120 seconds'
      AND recorded_at <= $1::timestamptz-interval '120 seconds' ORDER BY sequence DESC LIMIT 1) e ON true
  WHERE b.closed_at IS NULL`;

function rowFrame(row: Row, now: Date): BroadcastFrame | null {
  if (row.sequence === null || !row.occurred_at || !row.recorded_at) return null;
  const winner = row.result_recorded_at && row.result_recorded_at.getTime() + BROADCAST_DELAY_MS <= now.getTime()
    && row.winner_user_id && row.end_reason ? {
      id: row.winner_user_id, name: row.players.find(({ id }) => id === row.winner_user_id)?.displayName ?? "Player", reason: row.end_reason
    } : undefined;
  return projectBroadcastFrame({ sequence: Number(row.sequence), eventType: row.event_type ?? "game.update", actorUserId: row.actor_user_id,
    payload: row.payload, occurredAt: row.occurred_at, recordedAt: row.recorded_at }, row.public_name, now, winner);
}
function rowSummary(row: Row, frame: BroadcastFrame | null): LiveBroadcastSummary {
  return liveBroadcastSummarySchema.parse({ gameName: row.public_name, gameId: row.match_id,
    title: row.players.map(({ displayName }) => displayName).join(" · "), playerCount: row.player_count, composition: row.composition,
    players: row.players.map(({ aiModelId, ...player }) => ({ ...player, ...(aiModelId ? { aiModelId } : {}) })),
    status: !frame ? "buffering" : frame.game.phase === "finished" ? "ended" : "live",
    delayMs: BROADCAST_DELAY_MS, availableAt: row.available_at.getTime(), viewerCount: 0 });
}
type CommentRow = { id: string; author_user_id: string; display_name: string; message: string; created_at: Date; released_at: Date; deleted_at: Date | null };
function comment(row: CommentRow): BroadcastComment {
  return { id: row.id, playerId: row.author_user_id, displayName: row.display_name, message: row.deleted_at ? "" : row.message,
    createdAt: row.created_at.getTime(), releasedAt: row.released_at.getTime(), deleted: row.deleted_at !== null };
}

export class PostgresBroadcastRepository implements BroadcastRepository {
  constructor(private readonly pool: Pool) {}

  async enableForGame(snapshot: RankingGameSnapshot): Promise<void> {
    if (!snapshot.publicName) throw new BroadcastConflictError("A public game name is required.");
    await this.pool.query(
      `INSERT INTO live_broadcasts(id,match_id,public_name,result_recorded_at)
       SELECT $1,m.id,m.public_name,CASE WHEN m.status<>'active' THEN clock_timestamp() ELSE NULL END FROM ranking_matches m
       WHERE m.id=$2 AND m.public_name=$3 AND m.match_type='general'
       AND EXISTS (SELECT 1 FROM game_events WHERE match_id=m.id AND sequence=1 AND event_type='game.started')
       AND (SELECT array_agg(user_id ORDER BY user_id) FROM match_participants WHERE match_id=m.id)=(SELECT array_agg(x ORDER BY x) FROM unnest($4::uuid[]) x)
       ON CONFLICT (match_id) DO NOTHING`, [randomUUID(), snapshot.id, snapshot.publicName, snapshot.seats.map(({ id }) => id)]
    );
  }

  async access(gameName: string, userId: string): Promise<BroadcastAccess | null> {
    const result = await this.pool.query<Row>(`${selectBroadcast} AND b.public_name=$2
      AND EXISTS(SELECT 1 FROM app_users WHERE id=$3 AND suspended_at IS NULL)`, [new Date(), gameName, userId]);
    const row = result.rows[0];
    if (!row) return null;
    return { broadcastId: row.id, matchId: row.match_id, gameName: row.public_name, participantIds: row.players.map(({ id }) => id),
      allAi: row.composition === "ai", ended: rowFrame(row, new Date())?.game.phase === "finished" };
  }

  async directory(query: BroadcastDirectoryQuery, now = new Date()) {
    const result = await this.pool.query<Row>(`${selectBroadcast}
      AND ($2='all' OR roster.composition=$2)
      AND ($3='all' OR ($3='ended' AND e.payload->'state'->>'phase'='finished') OR ($3='live' AND COALESCE(e.payload->'state'->>'phase','playing')<>'finished'))
      AND ($4::text IS NULL OR position(lower($4) in lower(b.public_name))>0 OR EXISTS(SELECT 1 FROM match_participants p WHERE p.match_id=b.match_id AND position(lower($4) in lower(p.display_name))>0))
      AND ($5::timestamptz IS NULL OR (b.created_at,b.id)<($5::timestamptz,$6::uuid))
      ORDER BY b.created_at DESC,b.id DESC LIMIT $7`,
    [now, query.composition, query.status, query.q ?? null, query.cursor?.createdAt ?? null, query.cursor?.id ?? null, query.limit + 1]);
    const rows = result.rows.slice(0, query.limit);
    const last = rows.at(-1);
    return { broadcasts: rows.map((row) => rowSummary(row, rowFrame(row, now))),
      nextCursor: result.rows.length > query.limit && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null };
  }

  async detail(gameName: string, now = new Date()): Promise<BroadcastDetail | null> {
    const result = await this.pool.query<Row>(`${selectBroadcast} AND b.public_name=$2`, [now, gameName]);
    const row = result.rows[0];
    if (!row) return null;
    const comments = await this.pool.query<CommentRow>(
      `SELECT c.*,p.display_name FROM live_broadcast_comments c JOIN player_profiles p ON p.user_id=c.author_user_id
       JOIN app_users u ON u.id=c.author_user_id AND u.suspended_at IS NULL
       WHERE c.broadcast_id=$1 AND c.released_at<=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 100`, [row.id, now]
    );
    const frame = rowFrame(row, now);
    return { broadcast: rowSummary(row, frame), frame, comments: comments.rows.reverse().map(comment) };
  }

  async frame(gameName: string, sequence: number, now = new Date()): Promise<BroadcastFrame | null> {
    const row = (await this.pool.query<Row>(`${selectBroadcast} AND b.public_name=$2`, [now, gameName])).rows[0];
    if (!row) return null;
    const event = (await this.pool.query<{ sequence: string; event_type: string; actor_user_id: string | null; payload: unknown; occurred_at: Date; recorded_at: Date }>(
      `SELECT sequence,event_type,actor_user_id,payload,occurred_at,recorded_at FROM game_events WHERE match_id=$1 AND sequence=$2
       AND occurred_at<=$3::timestamptz-interval '120 seconds' AND recorded_at<=$3::timestamptz-interval '120 seconds'`, [row.match_id, sequence, now]
    )).rows[0];
    if (!event) return null;
    return rowFrame({ ...row, ...event }, now);
  }

  async timeline(gameName: string, beforeSequence: number | undefined, limit: number, now = new Date()) {
    const result = await this.pool.query<{ sequence: string; event_type: string; actor_user_id: string | null; payload: unknown; occurred_at: Date; recorded_at: Date }>(
      `SELECT e.sequence,e.event_type,e.actor_user_id,e.payload,e.occurred_at,e.recorded_at FROM game_events e
       JOIN live_broadcasts b ON b.match_id=e.match_id JOIN ranking_matches m ON m.id=b.match_id AND m.match_type='general'
       WHERE b.public_name=$1 AND b.closed_at IS NULL AND ($2::bigint IS NULL OR e.sequence<$2)
       AND e.occurred_at<=$3::timestamptz-interval '120 seconds' AND e.recorded_at<=$3::timestamptz-interval '120 seconds'
       ORDER BY e.sequence DESC LIMIT $4`, [gameName, beforeSequence ?? null, now, limit + 1]
    );
    const released = result.rows.slice(0, limit).flatMap((row) => {
      const frame = projectBroadcastFrame({ sequence: Number(row.sequence), eventType: row.event_type, actorUserId: row.actor_user_id,
        payload: row.payload, occurredAt: row.occurred_at, recordedAt: row.recorded_at }, gameName, now);
      return frame ? [{ sequence: frame.sequence, capturedAt: frame.capturedAt, event: frame.event }] : [];
    });
    return { frames: released, nextCursor: result.rows.length > limit && released.length ? String(released.at(-1)!.sequence) : null };
  }

  async addComment(gameName: string, userId: string, body: { message: string; clientMessageId: string }) {
    const valid = broadcastCommentBodySchema.parse(body);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,914522))", [userId]);
      const access = await client.query<{ id: string; participant: boolean; display_name: string }>(
        `SELECT b.id,EXISTS(SELECT 1 FROM match_participants WHERE match_id=b.match_id AND user_id=$2) AS participant,p.display_name
         FROM live_broadcasts b JOIN ranking_matches m ON m.id=b.match_id AND m.match_type='general'
         JOIN app_users u ON u.id=$2 AND u.suspended_at IS NULL JOIN player_profiles p ON p.user_id=u.id
         WHERE b.public_name=$1 AND b.closed_at IS NULL FOR SHARE OF b`, [gameName, userId]
      );
      const allowed = access.rows[0];
      if (!allowed) throw new BroadcastConflictError("This broadcast is unavailable.");
      let row = (await client.query<CommentRow>(
        "SELECT c.*,$4::text AS display_name FROM live_broadcast_comments c WHERE broadcast_id=$1 AND author_user_id=$2 AND client_message_id=$3",
        [allowed.id, userId, valid.clientMessageId, allowed.display_name]
      )).rows[0];
      if (!row) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM live_broadcast_comments WHERE author_user_id=$1 AND created_at>clock_timestamp()-interval '1 minute'", [userId]
        );
        if (Number(count.rows[0]?.count ?? 5) >= 5) throw new BroadcastConflictError("Please wait before sending another comment.");
        row = (await client.query<CommentRow>(
          `WITH stamp AS (SELECT date_trunc('milliseconds',clock_timestamp())
             + CASE WHEN $6::integer > 0 THEN interval '1 millisecond' ELSE interval '0 milliseconds' END AS t)
           INSERT INTO live_broadcast_comments(id,broadcast_id,author_user_id,client_message_id,message,created_at,released_at)
           SELECT $1,$2,$3,$4,$5,t,t+($6::integer*interval '1 millisecond') FROM stamp RETURNING *, $7::text AS display_name`,
          [randomUUID(), allowed.id, userId, valid.clientMessageId, valid.message, allowed.participant ? BROADCAST_DELAY_MS : 0, allowed.display_name]
        )).rows[0]!;
      }
      await client.query("COMMIT");
      // Spectator posts have no spoiler delay. Return their stored comment even
      // when the application clock trails PostgreSQL by a few milliseconds.
      const delayed = allowed.participant && row.released_at.getTime() > Date.now();
      return { availableAt: row.released_at.getTime(), delayed, ...(!delayed ? { comment: comment(row) } : {}) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async deleteComment(gameName: string, commentId: string, moderatorId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE live_broadcast_comments c SET deleted_at=COALESCE(c.deleted_at,clock_timestamp()),deleted_by=COALESCE(c.deleted_by,$3)
       FROM live_broadcasts b WHERE c.id=$2 AND c.broadcast_id=b.id AND b.public_name=$1 AND b.closed_at IS NULL RETURNING c.id`, [gameName, commentId, moderatorId]
    );
    return result.rowCount === 1;
  }

  async reportComment(gameName: string, commentId: string, reporterId: string, reason: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO live_broadcast_comment_reports(id,comment_id,reporter_id,reason)
       SELECT $1,c.id,$3,$4 FROM live_broadcast_comments c JOIN live_broadcasts b ON b.id=c.broadcast_id
       JOIN app_users u ON u.id=$3 AND u.suspended_at IS NULL
       WHERE b.public_name=$5 AND b.closed_at IS NULL AND c.id=$2 AND c.released_at<=clock_timestamp()
       ON CONFLICT (comment_id,reporter_id) DO UPDATE SET reason=live_broadcast_comment_reports.reason RETURNING id`,
      [randomUUID(), commentId, reporterId, reason, gameName]
    );
    return result.rowCount === 1;
  }

  async reports(limit: number, cursor?: { createdAt: string; id: string }, now = new Date()) {
    const result = await this.pool.query<CommentRow & { report_id: string; public_name: string; reason: string; report_created_at: Date }>(
      `SELECT c.*,p.display_name,r.id AS report_id,r.reason,r.created_at AS report_created_at,b.public_name
       FROM live_broadcast_comment_reports r JOIN live_broadcast_comments c ON c.id=r.comment_id
       JOIN live_broadcasts b ON b.id=c.broadcast_id JOIN player_profiles p ON p.user_id=c.author_user_id
       JOIN app_users u ON u.id=c.author_user_id AND u.suspended_at IS NULL
       WHERE r.resolved_at IS NULL AND c.released_at<=$1 AND ($2::timestamptz IS NULL OR (r.created_at,r.id)>($2::timestamptz,$3::uuid))
       ORDER BY r.created_at,r.id LIMIT $4`, [now, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return { reports: rows.map((row) => ({ id: row.report_id, broadcastName: row.public_name, comment: comment(row), reason: row.reason, createdAt: row.report_created_at.getTime() })),
      nextCursor: result.rows.length > limit && last ? { createdAt: last.report_created_at.toISOString(), id: last.report_id } : null };
  }

  async resolveReport(id: string, moderatorId: string, removeComment: boolean): Promise<boolean> {
    const result = await this.pool.query(
      `WITH resolved AS (UPDATE live_broadcast_comment_reports SET resolved_at=COALESCE(resolved_at,clock_timestamp()),resolved_by=COALESCE(resolved_by,$2) WHERE id=$1 RETURNING comment_id),
       removed AS (UPDATE live_broadcast_comments SET deleted_at=COALESCE(deleted_at,clock_timestamp()),deleted_by=COALESCE(deleted_by,$2)
         WHERE id IN(SELECT comment_id FROM resolved) AND $3 RETURNING id) SELECT comment_id FROM resolved`, [id, moderatorId, removeComment]
    );
    return result.rowCount === 1;
  }

  async close(gameName: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>("UPDATE live_broadcasts SET closed_at=clock_timestamp() WHERE public_name=$1 AND closed_at IS NULL RETURNING id", [gameName]);
    return result.rows[0]?.id ?? null;
  }
}
