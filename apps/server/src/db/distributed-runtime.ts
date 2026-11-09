import { isDeepStrictEqual } from "node:util";
import type { MatchType, PlayerCount, ProfileBadgeId } from "@trinitymatrix/protocol";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { calculateDeterministicElo, RepositoryConflictError, RepositoryNotFoundError } from "./repository";

type DatabasePool = Pick<Pool, "connect" | "query">;

export type GameOwnershipLease = Readonly<{
  matchId: string;
  ownerInstanceId: string;
  fencingToken: number;
  leaseExpiresAt: Date;
  protocolMin: number;
  protocolMax: number;
  draining: boolean;
}>;

export type DurableGameTransition = Readonly<{
  matchId: string;
  ownerInstanceId: string;
  fencingToken: number;
  expectedNextSequence: number;
  event: Readonly<{
    eventId: string;
    eventType: string;
    actorUserId: string | null;
    commandId: string | null;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
  }>;
  command: Readonly<{
    actorUserId: string;
    commandType: string;
    expectedRevision: number;
    payload: Readonly<Record<string, unknown>>;
    result: Readonly<Record<string, unknown>>;
  }> | null;
  nextDeadline: Readonly<{
    type: "turn" | "showdown";
    dueAt: Date;
    expectedRevision: number;
    payload: Readonly<Record<string, unknown>>;
  }> | null;
  completion?: Readonly<{
    matchType: MatchType;
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
    participantOutcomes: readonly Readonly<{
      userId: string;
      outcome: "won" | "lost" | "dropped";
    }>[];
  }> | null;
}>;

export type DurableTransitionResult = Readonly<{
  disposition: "committed" | "replayed";
  eventSequence: number;
  result: Readonly<Record<string, unknown>> | null;
}>;

export type OutboxMessage = Readonly<{
  outboxId: string;
  matchId: string;
  eventSequence: number;
  fencingToken: number;
  topic: string;
  routingKey: string;
  payload: Readonly<Record<string, unknown>>;
  publishAttempts: number;
}>;

export type RecoverableDeadline = Readonly<{
  matchId: string;
  type: "turn" | "showdown";
  dueAt: Date;
  expectedRevision: number;
  fencingToken: number;
  payload: Readonly<Record<string, unknown>>;
  ownerInstanceId: string;
}>;

export type RecoveredDeadline = Readonly<{
  deadline: RecoverableDeadline;
  lease: GameOwnershipLease;
}>;

export type DistributedRuntimeOperationalMetrics = Readonly<{
  outboxBacklog: number;
  oldestOutboxAgeMs: number;
  dueDeadlineCount: number;
  oldestDeadlineLagMs: number;
  orphanedGameCount: number;
  matchmakingQueueDepth: number;
  oldestMatchmakingQueueAgeMs: number;
}>;

export type MatchmakingTicket = Readonly<{
  ticketId: string;
  playerId: string;
  playerCount: 2 | 6;
  region: string;
  protocolVersion: number;
  enqueuedAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
}>;

export type MaterializedGameRecord = Readonly<{
  matchId: string;
  publicName: string;
  playerCount: PlayerCount;
  matchType: MatchType;
  status: "active" | "completed" | "abandoned";
  eventSequence: number;
  eventType: string;
  eventPayload: Readonly<Record<string, unknown>>;
  participants: readonly Readonly<{
    playerId: string;
    seatNumber: number;
    displayName: string;
    badgeId: ProfileBadgeId;
  }>[];
  privateRoomCode: string | null;
}>;

interface OwnershipRow extends QueryResultRow {
  match_id: string;
  owner_instance_id: string;
  fencing_token: string | number;
  lease_expires_at: Date;
  protocol_min: number;
  protocol_max: number;
  draining: boolean;
}

interface CommandRow extends QueryResultRow {
  actor_user_id: string;
  expected_revision: string | number;
  command_type: string;
  command_payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  event_sequence: string | number;
}

interface OutboxRow extends QueryResultRow {
  outbox_id: string;
  match_id: string;
  event_sequence: string | number;
  fencing_token: string | number;
  topic: string;
  routing_key: string;
  payload: Record<string, unknown>;
  publish_attempts: number;
}

interface DeadlineRow extends QueryResultRow {
  match_id: string;
  deadline_type: "turn" | "showdown";
  due_at: Date;
  expected_revision: string | number;
  fencing_token: string | number;
  payload: Record<string, unknown>;
  owner_instance_id: string;
}

interface RecoveredDeadlineRow extends DeadlineRow, OwnershipRow {}

interface OperationalMetricsRow extends QueryResultRow {
  outbox_backlog: string | number;
  oldest_outbox_age_ms: string | number;
  due_deadline_count: string | number;
  oldest_deadline_lag_ms: string | number;
  orphaned_game_count: string | number;
  matchmaking_queue_depth: string | number;
  oldest_matchmaking_queue_age_ms: string | number;
}

interface TicketRow extends QueryResultRow {
  ticket_id: string;
  player_id: string;
  player_count: 2 | 6;
  region: string;
  protocol_version: number;
  enqueued_at: Date;
  heartbeat_at: Date;
  expires_at: Date;
}

interface MaterializedGameRow extends QueryResultRow {
  match_id: string;
  public_name: string;
  player_count: PlayerCount;
  match_type: MatchType;
  status: MaterializedGameRecord["status"];
  event_sequence: string | number;
  event_type: string;
  event_payload: Record<string, unknown>;
  private_room_code: string | null;
}

interface MaterializedParticipantRow extends QueryResultRow {
  user_id: string;
  seat_number: number;
  display_name: string;
  badge_id: ProfileBadgeId;
}

interface ReadyPrivateRoomRow extends QueryResultRow {
  id: string;
  status: "waiting" | "active" | "completed" | "cancelled";
  match_id: string | null;
  player_count: PlayerCount;
  creator_user_id: string;
  accepted_player_ids: string[];
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

function mapOwnership(row: OwnershipRow): GameOwnershipLease {
  return {
    matchId: row.match_id,
    ownerInstanceId: row.owner_instance_id,
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: row.lease_expires_at,
    protocolMin: row.protocol_min,
    protocolMax: row.protocol_max,
    draining: row.draining
  };
}

function requireObject(value: unknown, label: string): asserts value is Readonly<Record<string, unknown>> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new RepositoryConflictError(`${label} must be a JSON object.`);
  }
}

function boundedBatchSize(value = 50): number {
  return Math.max(1, Math.min(250, Math.trunc(value)));
}

function matchmakingTtl(value = 90_000): number {
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 300_000) {
    throw new RepositoryConflictError("A matchmaking ticket TTL must be between 10 seconds and 5 minutes.");
  }
  return value;
}

function mapTicket(row: TicketRow): MatchmakingTicket {
  return {
    ticketId: row.ticket_id,
    playerId: row.player_id,
    playerCount: row.player_count,
    region: row.region,
    protocolVersion: row.protocol_version,
    enqueuedAt: row.enqueued_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

/**
 * PostgreSQL coordination boundary for the distributed game runtime.
 *
 * No WebSocket process is authoritative by identity alone. Every mutating
 * transaction verifies an unexpired lease and its monotonic fencing token.
 * A transition commits the command receipt, immutable event, outbox message,
 * and replacement deadline in one transaction before callers may acknowledge
 * it to a player.
 */
export class PostgresDistributedGameRuntime {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Reconnect and routing always rediscover a player's active match from
   * PostgreSQL. No gateway-local player-to-game map is authoritative.
   */
  async getActiveMatchIdForPlayer(playerId: string): Promise<string | null> {
    const result = await this.pool.query<{ match_id: string }>(
      `SELECT p.match_id
       FROM match_participants p
       JOIN ranking_matches m ON m.id = p.match_id
       JOIN LATERAL (
         SELECT payload
         FROM game_events
         WHERE match_id = m.id
         ORDER BY sequence DESC
         LIMIT 1
       ) e ON true
       WHERE p.user_id = $1 AND m.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(e.payload->'state'->'seats', '[]'::jsonb)) seat
           WHERE seat->>'id' = $1::text
             AND COALESCE((seat->>'detached')::boolean, false) = false
         )
       ORDER BY m.started_at DESC, m.id DESC
       LIMIT 1`,
      [playerId]
    );
    return result.rows[0]?.match_id ?? null;
  }

  /**
   * Load the latest immutable event and participants needed to materialize a
   * game after reconnect, failover, or deployment draining. Event payloads are
   * validated by the gameplay layer before becoming executable state.
   */
  async loadMaterializedGame(matchId: string): Promise<MaterializedGameRecord | null> {
    return inTransaction(this.pool, async (client) => {
      const match = await client.query<MaterializedGameRow>(
        `SELECT m.id AS match_id, m.public_name, m.player_count, m.match_type, m.status,
                e.sequence AS event_sequence, e.event_type, e.payload AS event_payload,
                r.room_code AS private_room_code
         FROM ranking_matches m
         JOIN LATERAL (
           SELECT sequence, event_type, payload
           FROM game_events
           WHERE match_id = m.id
           ORDER BY sequence DESC
           LIMIT 1
         ) e ON true
         LEFT JOIN private_match_rooms r ON r.match_id = m.id
         WHERE m.id = $1`,
        [matchId]
      );
      const row = match.rows[0];
      if (!row) return null;
      requireObject(row.event_payload, "The materialized event payload");
      const participants = await client.query<MaterializedParticipantRow>(
        `SELECT user_id, seat_number, display_name, badge_id
         FROM match_participants
         WHERE match_id = $1
         ORDER BY seat_number ASC`,
        [matchId]
      );
      if (participants.rows.length !== row.player_count) {
        throw new RepositoryConflictError("The materialized game has an incomplete seat layout.");
      }
      return {
        matchId: row.match_id,
        publicName: row.public_name,
        playerCount: row.player_count,
        matchType: row.match_type,
        status: row.status,
        eventSequence: Number(row.event_sequence),
        eventType: row.event_type,
        eventPayload: row.event_payload,
        participants: participants.rows.map((participant) => ({
          playerId: participant.user_id,
          seatNumber: participant.seat_number,
          displayName: participant.display_name,
          badgeId: participant.badge_id
        })),
        privateRoomCode: row.private_room_code
      };
    });
  }

  async getWaitingMatchmakingTicket(playerId: string, now?: Date): Promise<MatchmakingTicket | null> {
    const result = await this.pool.query<TicketRow>(
      `SELECT ticket_id, player_id, player_count, region, protocol_version,
              enqueued_at, heartbeat_at, expires_at
       FROM distributed_matchmaking_tickets
       WHERE player_id = $1 AND status = 'waiting'
         AND expires_at > COALESCE($2::timestamptz, clock_timestamp())
       LIMIT 1`,
      [playerId, now ?? null]
    );
    return result.rows[0] ? mapTicket(result.rows[0]) : null;
  }

  async countWaitingMatchmakingTickets(input: {
    playerCount: 2 | 6;
    region: string;
    protocolVersion: number;
    now?: Date;
  }): Promise<number> {
    const result = await this.pool.query<{ waiting: string | number }>(
      `SELECT count(*) AS waiting
       FROM distributed_matchmaking_tickets
       WHERE status = 'waiting' AND player_count = $1 AND region = $2
         AND protocol_version = $3
         AND expires_at > COALESCE($4::timestamptz, clock_timestamp())`,
      [input.playerCount, input.region, input.protocolVersion, input.now ?? null]
    );
    return Number(result.rows[0]?.waiting ?? 0);
  }

  async claimOwnership(input: {
    matchId: string;
    ownerInstanceId: string;
    protocolVersion: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<GameOwnershipLease> {
    if (!Number.isSafeInteger(input.protocolVersion) || input.protocolVersion < 1) {
      throw new RepositoryConflictError("The protocol version must be a positive safe integer.");
    }
    if (input.leaseDurationMs < 1_000 || input.leaseDurationMs > 120_000) {
      throw new RepositoryConflictError("Ownership leases must be between 1 and 120 seconds.");
    }
    return inTransaction(this.pool, async (client) => {
      const result = await client.query<OwnershipRow>(
        `WITH runtime_clock AS (
           SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now
         )
         INSERT INTO game_runtime_owners (
           match_id, owner_instance_id, fencing_token, lease_expires_at,
           protocol_min, protocol_max, draining, updated_at
         )
         SELECT $1, $2, 1,
                c.now + ($4::bigint * interval '1 millisecond'),
                $3, $3, false, c.now
         FROM runtime_clock c
         ON CONFLICT (match_id) DO UPDATE SET
           owner_instance_id = EXCLUDED.owner_instance_id,
           fencing_token = CASE
             WHEN game_runtime_owners.owner_instance_id = EXCLUDED.owner_instance_id
               AND game_runtime_owners.lease_expires_at > EXCLUDED.updated_at
             THEN game_runtime_owners.fencing_token
             ELSE game_runtime_owners.fencing_token + 1
           END,
           lease_expires_at = EXCLUDED.lease_expires_at,
           draining = false,
           updated_at = EXCLUDED.updated_at
         WHERE (
             game_runtime_owners.lease_expires_at <= EXCLUDED.updated_at
             OR (game_runtime_owners.owner_instance_id = EXCLUDED.owner_instance_id
                 AND game_runtime_owners.draining = false)
           )
           AND $3 BETWEEN game_runtime_owners.protocol_min AND game_runtime_owners.protocol_max
         RETURNING match_id, owner_instance_id, fencing_token, lease_expires_at,
                   protocol_min, protocol_max, draining`,
        [input.matchId, input.ownerInstanceId, input.protocolVersion, input.leaseDurationMs, input.now ?? null]
      );
      const row = result.rows[0];
      if (!row) throw new RepositoryConflictError("The game is owned by another live or protocol-incompatible instance.");

      // A takeover must atomically transfer the one current deadline to the
      // new fence. Deadline revision is defined as the post-transition event
      // sequence, so stale timers can be removed without firing against a newer
      // materialized state.
      await client.query(
        `WITH latest AS (
           SELECT COALESCE(MAX(sequence), 0) AS revision
           FROM game_events
           WHERE match_id = $1
         )
         UPDATE recoverable_game_deadlines d
         SET fencing_token = $2, claimed_by = NULL, claimed_until = NULL,
             updated_at = COALESCE($3::timestamptz, clock_timestamp())
         FROM latest l
         WHERE d.match_id = $1 AND d.completed_at IS NULL
           AND d.expected_revision = l.revision`,
        [input.matchId, Number(row.fencing_token), input.now ?? null]
      );
      await client.query(
        `WITH latest AS (
           SELECT COALESCE(MAX(sequence), 0) AS revision
           FROM game_events
           WHERE match_id = $1
         )
         DELETE FROM recoverable_game_deadlines d
         USING latest l
         WHERE d.match_id = $1 AND d.completed_at IS NULL
           AND d.expected_revision <> l.revision`,
        [input.matchId]
      );
      return mapOwnership(row);
    });
  }

  async renewOwnership(input: {
    matchId: string;
    ownerInstanceId: string;
    fencingToken: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<GameOwnershipLease> {
    const renewed = await this.renewOwnershipBatch({
      ownerInstanceId: input.ownerInstanceId,
      leases: [{ matchId: input.matchId, fencingToken: input.fencingToken }],
      leaseDurationMs: input.leaseDurationMs,
      ...(input.now ? { now: input.now } : {})
    });
    const row = renewed[0];
    if (!row) throw new RepositoryConflictError("The game ownership lease was lost.");
    return row;
  }

  async renewOwnershipBatch(input: {
    ownerInstanceId: string;
    leases: readonly { matchId: string; fencingToken: number }[];
    leaseDurationMs: number;
    now?: Date;
  }): Promise<readonly GameOwnershipLease[]> {
    if (input.leases.length === 0) return [];
    if (input.leases.length > 1_000) throw new RepositoryConflictError("A lease renewal batch cannot exceed 1000 games.");
    if (input.leaseDurationMs < 1_000 || input.leaseDurationMs > 120_000) {
      throw new RepositoryConflictError("Ownership leases must be between 1 and 120 seconds.");
    }
    const result = await this.pool.query<OwnershipRow>(
      `WITH runtime_clock AS (
         SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now
       ), requested AS (
         SELECT * FROM unnest($1::uuid[], $2::bigint[]) AS r(match_id, fencing_token)
       )
       UPDATE game_runtime_owners o
       SET lease_expires_at = c.now + ($4::bigint * interval '1 millisecond'),
           updated_at = c.now
       FROM requested r, runtime_clock c
       WHERE o.match_id = r.match_id
         AND o.owner_instance_id = $3
         AND o.fencing_token = r.fencing_token
         AND o.lease_expires_at > c.now
         AND o.draining = false
       RETURNING o.match_id, o.owner_instance_id, o.fencing_token, o.lease_expires_at,
                 o.protocol_min, o.protocol_max, o.draining`,
      [
        input.leases.map(({ matchId }) => matchId),
        input.leases.map(({ fencingToken }) => fencingToken),
        input.ownerInstanceId,
        input.leaseDurationMs,
        input.now ?? null
      ]
    );
    return result.rows.map(mapOwnership);
  }

  async beginDraining(input: {
    ownerInstanceId: string;
    now?: Date;
  }): Promise<number> {
    const result = await this.pool.query(
      `UPDATE game_runtime_owners
       SET draining = true, updated_at = COALESCE($2::timestamptz, clock_timestamp())
       WHERE owner_instance_id = $1 AND draining = false`,
      [input.ownerInstanceId, input.now ?? null]
    );
    return result.rowCount ?? 0;
  }

  async expireOwnedLeases(input: { ownerInstanceId: string; now?: Date }): Promise<number> {
    const result = await this.pool.query(
      `UPDATE game_runtime_owners
       SET lease_expires_at = LEAST(lease_expires_at, COALESCE($2::timestamptz, clock_timestamp())),
           draining = true,
           updated_at = COALESCE($2::timestamptz, clock_timestamp())
       WHERE owner_instance_id = $1`,
      [input.ownerInstanceId, input.now ?? null]
    );
    return result.rowCount ?? 0;
  }

  async getRoute(matchId: string, now?: Date): Promise<GameOwnershipLease | null> {
    const result = await this.pool.query<OwnershipRow>(
      `SELECT match_id, owner_instance_id, fencing_token, lease_expires_at,
              protocol_min, protocol_max, draining
       FROM game_runtime_owners
       WHERE match_id = $1
         AND lease_expires_at > COALESCE($2::timestamptz, clock_timestamp())
         AND draining = false`,
      [matchId, now ?? null]
    );
    return result.rows[0] ? mapOwnership(result.rows[0]) : null;
  }

  async commitTransition(input: DurableGameTransition, now?: Date): Promise<DurableTransitionResult> {
    requireObject(input.event.payload, "The event payload");
    if (input.command) {
      requireObject(input.command.payload, "The command payload");
      requireObject(input.command.result, "The command result");
      if (input.event.commandId === null) {
        throw new RepositoryConflictError("Command transitions require an event command id.");
      }
    } else if (input.event.commandId !== null) {
      throw new RepositoryConflictError("Timer transitions cannot supply a command id.");
    }
    if (input.nextDeadline) requireObject(input.nextDeadline.payload, "The deadline payload");
    if (input.completion) {
      const winners = input.completion.participantOutcomes.filter(({ outcome }) => outcome === "won");
      if (winners.length !== 1 || winners[0]?.userId !== input.completion.winnerUserId
        || new Set(input.completion.participantOutcomes.map(({ userId }) => userId)).size
          !== input.completion.participantOutcomes.length) {
        throw new RepositoryConflictError("A completed game requires one winner and one unique outcome per participant.");
      }
      if (input.nextDeadline) throw new RepositoryConflictError("A completed game cannot retain a recoverable deadline.");
    }

    return inTransaction(this.pool, async (client) => {
      const replayCommittedCommand = async (): Promise<DurableTransitionResult | null> => {
        if (!input.command || !input.event.commandId) return null;
        const replay = await client.query<CommandRow>(
          `SELECT actor_user_id, expected_revision, command_type, command_payload,
                  result_payload, event_sequence
           FROM durable_game_commands
           WHERE match_id = $1 AND command_id = $2`,
          [input.matchId, input.event.commandId]
        );
        const stored = replay.rows[0];
        if (!stored) return null;
        if (stored.actor_user_id !== input.command.actorUserId
          || Number(stored.expected_revision) !== input.command.expectedRevision
          || stored.command_type !== input.command.commandType
          || !isDeepStrictEqual(stored.command_payload, input.command.payload)) {
          throw new RepositoryConflictError("The command id is already bound to different input.");
        }
        return {
          disposition: "replayed",
          eventSequence: Number(stored.event_sequence),
          result: stored.result_payload
        };
      };

      // Exact idempotent retries are reads of an already committed result. They
      // remain safe after ownership transfer or match completion and must not
      // be converted into a false failure merely because the original lease
      // has since expired.
      const optimisticReplay = await replayCommittedCommand();
      if (optimisticReplay) return optimisticReplay;

      const ownership = await client.query<OwnershipRow>(
        `SELECT match_id, owner_instance_id, fencing_token, lease_expires_at,
                protocol_min, protocol_max, draining
         FROM game_runtime_owners
         WHERE match_id = $1 AND owner_instance_id = $2 AND fencing_token = $3
           AND lease_expires_at > COALESCE($4::timestamptz, clock_timestamp())
           AND draining = false
         FOR UPDATE`,
        [input.matchId, input.ownerInstanceId, input.fencingToken, now ?? null]
      );
      const lease = ownership.rows[0];
      if (!lease) {
        throw new RepositoryConflictError("The game ownership lease or fencing token is no longer valid.");
      }

      // The owner row is the per-game serialization lock. A duplicate may have
      // committed while this transaction waited for it, so repeat the receipt
      // lookup under the lock before checking revision or inserting anything.
      const serializedReplay = await replayCommittedCommand();
      if (serializedReplay) return serializedReplay;

      const match = await client.query<{ status: string; match_type: MatchType; participant_count: number }>(
        `SELECT m.status, m.match_type,
                (SELECT count(*)::int FROM match_participants p WHERE p.match_id = m.id) AS participant_count
         FROM ranking_matches m WHERE m.id = $1 FOR UPDATE`,
        [input.matchId]
      );
      if (!match.rows[0]) throw new RepositoryNotFoundError("The match does not exist.");
      if (match.rows[0].status !== "active") throw new RepositoryConflictError("Only active matches accept game transitions.");

      const sequence = await client.query<{ last_sequence: string | number }>(
        "SELECT COALESCE(MAX(sequence), 0) AS last_sequence FROM game_events WHERE match_id = $1",
        [input.matchId]
      );
      const nextSequence = Number(sequence.rows[0]?.last_sequence ?? 0) + 1;
      if (nextSequence !== input.expectedNextSequence) {
        throw new RepositoryConflictError(`Expected event sequence ${nextSequence}, received ${input.expectedNextSequence}.`);
      }
      if (input.nextDeadline && input.nextDeadline.expectedRevision !== nextSequence) {
        throw new RepositoryConflictError("The next deadline revision must equal the committed event sequence.");
      }

      await client.query(
        `INSERT INTO game_events (
           event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          input.event.eventId,
          input.matchId,
          nextSequence,
          input.event.eventType,
          input.event.actorUserId,
          input.event.commandId,
          JSON.stringify(input.event.payload),
          input.event.occurredAt
        ]
      );

      if (input.command && input.event.commandId) {
        await client.query(
          `INSERT INTO durable_game_commands (
             match_id, command_id, actor_user_id, expected_revision, fencing_token,
             command_type, command_payload, result_payload, event_sequence, accepted_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
          [
            input.matchId,
            input.event.commandId,
            input.command.actorUserId,
            input.command.expectedRevision,
            input.fencingToken,
            input.command.commandType,
            JSON.stringify(input.command.payload),
            JSON.stringify(input.command.result),
            nextSequence,
            input.event.occurredAt
          ]
        );
      }

      await client.query(
        `INSERT INTO game_event_outbox (
           outbox_id, match_id, event_sequence, fencing_token, topic,
           routing_key, payload, created_at, available_at
         ) VALUES (
           $1, $2, $3, $4, 'game.event', $2::uuid::text, $5::jsonb,
           COALESCE($6::timestamptz, clock_timestamp()),
           COALESCE($6::timestamptz, clock_timestamp())
         )`,
        [
          input.event.eventId,
          input.matchId,
          nextSequence,
          input.fencingToken,
          JSON.stringify({
            eventId: input.event.eventId,
            eventType: input.event.eventType,
            matchId: input.matchId,
            sequence: nextSequence,
            fencingToken: input.fencingToken,
            payload: input.event.payload
          }),
          now ?? null
        ]
      );

      await client.query("DELETE FROM recoverable_game_deadlines WHERE match_id = $1", [input.matchId]);
      if (input.nextDeadline) {
        await client.query(
          `INSERT INTO recoverable_game_deadlines (
             match_id, deadline_type, due_at, expected_revision, fencing_token, payload, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6::jsonb,
             COALESCE($7::timestamptz, clock_timestamp())
           )`,
          [
            input.matchId,
            input.nextDeadline.type,
            input.nextDeadline.dueAt,
            input.nextDeadline.expectedRevision,
            input.fencingToken,
            JSON.stringify(input.nextDeadline.payload),
            now ?? null
          ]
        );
      }

      if (input.completion) {
        const completion = input.completion;
        const lockedMatch = match.rows[0]!;
        if (lockedMatch.match_type !== completion.matchType
          || lockedMatch.participant_count !== completion.participantOutcomes.length) {
          throw new RepositoryConflictError("The completion result does not match the durable game participants or type.");
        }
        const participantIds = await client.query<{ user_id: string }>(
          `SELECT user_id FROM match_participants
           WHERE match_id = $1
           ORDER BY user_id ASC
           FOR UPDATE`,
          [input.matchId]
        );
        const expectedIds = new Set(completion.participantOutcomes.map(({ userId }) => userId));
        if (participantIds.rows.some(({ user_id }) => !expectedIds.has(user_id))) {
          throw new RepositoryConflictError("The completion result contains a player outside the durable game.");
        }
        const rankings = await client.query<{ user_id: string; rating: number }>(
          `SELECT user_id, rating FROM player_rankings
           WHERE user_id = ANY($1::uuid[])
           ORDER BY user_id ASC
           FOR UPDATE`,
          [[...expectedIds]]
        );
        if (rankings.rows.length !== completion.participantOutcomes.length) {
          throw new RepositoryConflictError("Every participant must have an initialized ranking.");
        }
        const ratingByUser = new Map(rankings.rows.map(({ user_id, rating }) => [user_id, rating]));
        const participantResults = completion.matchType === "general"
          ? calculateDeterministicElo(completion.participantOutcomes.map((participant) => ({
              ...participant,
              rating: ratingByUser.get(participant.userId) ?? 1000
            })))
          : completion.participantOutcomes.map((participant) => ({
              ...participant,
              scoreDelta: 0,
              ratingAfter: ratingByUser.get(participant.userId) ?? 1000
            }));
        for (const result of participantResults) {
          const participant = await client.query(
            `UPDATE match_participants
             SET outcome = $3, score_delta = $4, rating_after = $5
             WHERE match_id = $1 AND user_id = $2 AND outcome IS NULL`,
            [input.matchId, result.userId, result.outcome, result.scoreDelta, result.ratingAfter]
          );
          if (participant.rowCount !== 1) {
            throw new RepositoryConflictError("A participant result is missing or already recorded.");
          }
          if (completion.matchType === "general") {
            await client.query(
              `UPDATE player_rankings
               SET rating = $2,
                   games_played = games_played + 1,
                   wins = wins + $3,
                   losses = losses + $4,
                   drops = drops + $5,
                   updated_at = $6
               WHERE user_id = $1`,
              [
                result.userId,
                result.ratingAfter,
                result.outcome === "won" ? 1 : 0,
                result.outcome === "lost" ? 1 : 0,
                result.outcome === "dropped" ? 1 : 0,
                completion.endedAt
              ]
            );
          }
        }
        await client.query(
          `UPDATE ranking_matches
           SET status = 'completed', winner_user_id = $2, end_reason = $3, ended_at = $4
           WHERE id = $1 AND status = 'active'`,
          [input.matchId, completion.winnerUserId, completion.endReason, completion.endedAt]
        );
        if (completion.matchType === "private") {
          await client.query(
            `UPDATE private_match_rooms
             SET status = 'completed', completed_at = $2, updated_at = $2
             WHERE match_id = $1 AND status = 'active'`,
            [input.matchId, completion.endedAt]
          );
        }
      }

      return {
        disposition: "committed",
        eventSequence: nextSequence,
        result: input.command?.result ?? null
      };
    });
  }

  async claimOutbox(input: {
    workerId: string;
    leaseDurationMs: number;
    limit?: number;
    now?: Date;
  }): Promise<readonly OutboxMessage[]> {
    const result = await this.pool.query<OutboxRow>(
      `WITH runtime_clock AS (
         SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now
       ), candidates AS (
         SELECT pending.outbox_id
         FROM game_event_outbox pending, runtime_clock c
         WHERE pending.published_at IS NULL AND pending.available_at <= c.now
           AND (pending.locked_until IS NULL OR pending.locked_until <= c.now)
           -- A retrying or leased predecessor is a per-match ordering fence.
           -- SKIP LOCKED still lets other matches progress independently.
           AND NOT EXISTS (
             SELECT 1
             FROM game_event_outbox predecessor
             WHERE predecessor.match_id = pending.match_id
               AND predecessor.published_at IS NULL
               AND predecessor.event_sequence < pending.event_sequence
           )
         ORDER BY pending.available_at ASC, pending.created_at ASC, pending.outbox_id ASC
         FOR UPDATE OF pending SKIP LOCKED
         LIMIT $1
       )
       UPDATE game_event_outbox o
       SET locked_by = $2,
           locked_until = c.now + ($3::bigint * interval '1 millisecond'),
           publish_attempts = publish_attempts + 1
       FROM candidates candidate, runtime_clock c
       WHERE o.outbox_id = candidate.outbox_id
       RETURNING o.outbox_id, o.match_id, o.event_sequence, o.fencing_token, o.topic,
                 o.routing_key, o.payload, o.publish_attempts`,
      [boundedBatchSize(input.limit), input.workerId, input.leaseDurationMs, input.now ?? null]
    );
    return result.rows.map((row) => ({
      outboxId: row.outbox_id,
      matchId: row.match_id,
      eventSequence: Number(row.event_sequence),
      fencingToken: Number(row.fencing_token),
      topic: row.topic,
      routingKey: row.routing_key,
      payload: row.payload,
      publishAttempts: row.publish_attempts
    }));
  }

  async markOutboxPublished(input: { outboxId: string; workerId: string; publishedAt?: Date }): Promise<void> {
    await this.markOutboxPublishedBatch({
      outboxIds: [input.outboxId],
      workerId: input.workerId,
      ...(input.publishedAt ? { publishedAt: input.publishedAt } : {})
    });
  }

  async markOutboxPublishedBatch(input: {
    outboxIds: readonly string[];
    workerId: string;
    publishedAt?: Date;
  }): Promise<void> {
    if (input.outboxIds.length === 0) return;
    const result = await this.pool.query<{ updated_count: string | number }>(
      `WITH requested AS MATERIALIZED (
         SELECT DISTINCT requested_outbox_id AS outbox_id
         FROM unnest($1::uuid[]) AS requested_outbox(requested_outbox_id)
       ), eligible AS MATERIALIZED (
         SELECT o.outbox_id
         FROM game_event_outbox o
         JOIN requested r ON r.outbox_id = o.outbox_id
         WHERE o.locked_by = $2 AND o.published_at IS NULL
         FOR UPDATE OF o
       ), valid_batch AS MATERIALIZED (
         SELECT count(*) = cardinality($1::uuid[]) AS all_claims_owned
         FROM eligible
       ), updated AS (
         UPDATE game_event_outbox o
         SET published_at = COALESCE($3::timestamptz, clock_timestamp()),
             locked_by = NULL, locked_until = NULL, last_error = NULL
         FROM eligible e, valid_batch v
         WHERE v.all_claims_owned AND o.outbox_id = e.outbox_id
         RETURNING o.outbox_id
       )
       SELECT count(*) AS updated_count FROM updated`,
      [input.outboxIds, input.workerId, input.publishedAt ?? null]
    );
    if (Number(result.rows[0]?.updated_count ?? 0) !== input.outboxIds.length) {
      throw new RepositoryConflictError("One or more outbox claims were lost or already acknowledged.");
    }
  }

  async rescheduleOutbox(input: {
    outboxId: string;
    workerId: string;
    retryAt: Date;
    error: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE game_event_outbox
       SET available_at = $3, locked_by = NULL, locked_until = NULL, last_error = left($4, 1000)
       WHERE outbox_id = $1 AND locked_by = $2 AND published_at IS NULL`,
      [input.outboxId, input.workerId, input.retryAt, input.error]
    );
    if (result.rowCount !== 1) throw new RepositoryConflictError("The outbox claim was lost or already acknowledged.");
  }

  /**
   * Recover due timers whose previous owner expired or began draining.
   *
   * The owner transfer, monotonically increasing fence, deadline re-fence and
   * worker claim are one PostgreSQL transaction. This lets an idle table keep
   * progressing after task/AZ loss without waiting for a player reconnect or
   * command, while a stale process remains unable to commit under its old
   * fencing token.
   */
  async claimOrphanedDueDeadlines(input: {
    workerId: string;
    ownerInstanceId: string;
    protocolVersion: number;
    ownershipLeaseDurationMs: number;
    deadlineLeaseDurationMs: number;
    limit?: number;
    now?: Date;
  }): Promise<readonly RecoveredDeadline[]> {
    if (!Number.isSafeInteger(input.protocolVersion) || input.protocolVersion < 1) {
      throw new RepositoryConflictError("The protocol version must be a positive safe integer.");
    }
    if (input.ownershipLeaseDurationMs < 1_000 || input.ownershipLeaseDurationMs > 120_000) {
      throw new RepositoryConflictError("Ownership leases must be between 1 and 120 seconds.");
    }
    if (input.deadlineLeaseDurationMs < 1_000 || input.deadlineLeaseDurationMs > 120_000) {
      throw new RepositoryConflictError("Deadline claims must be between 1 and 120 seconds.");
    }
    const result = await this.pool.query<RecoveredDeadlineRow>(
      `WITH runtime_clock AS (
         SELECT COALESCE($7::timestamptz, clock_timestamp()) AS now
       ), candidates AS MATERIALIZED (
         SELECT d.match_id, d.deadline_type
         FROM recoverable_game_deadlines d
         JOIN game_runtime_owners o ON o.match_id = d.match_id
         JOIN ranking_matches m ON m.id = d.match_id
         CROSS JOIN runtime_clock c
         WHERE m.status = 'active'
           AND d.completed_at IS NULL AND d.due_at <= c.now
           AND (d.claimed_until IS NULL OR d.claimed_until <= c.now)
           AND (o.lease_expires_at <= c.now OR o.draining = true)
           AND $3 BETWEEN o.protocol_min AND o.protocol_max
           AND d.expected_revision = (
             SELECT MAX(e.sequence) FROM game_events e WHERE e.match_id = d.match_id
           )
         ORDER BY d.due_at ASC, d.match_id ASC, d.deadline_type ASC
         FOR UPDATE OF d, o SKIP LOCKED
         LIMIT $1
       ), recovered AS (
         UPDATE game_runtime_owners o
         SET owner_instance_id = $2,
             fencing_token = o.fencing_token + 1,
             lease_expires_at = c.now + ($4::bigint * interval '1 millisecond'),
             draining = false,
             updated_at = c.now
         FROM candidates candidate, runtime_clock c
         WHERE o.match_id = candidate.match_id
           AND (o.lease_expires_at <= c.now OR o.draining = true)
           AND $3 BETWEEN o.protocol_min AND o.protocol_max
         RETURNING o.match_id, o.owner_instance_id, o.fencing_token,
                   o.lease_expires_at, o.protocol_min, o.protocol_max, o.draining
       ), claimed AS (
         UPDATE recoverable_game_deadlines d
         SET fencing_token = recovered.fencing_token,
             claimed_by = $5,
             claimed_until = c.now + ($6::bigint * interval '1 millisecond'),
             updated_at = c.now
         FROM candidates candidate, recovered, runtime_clock c
         WHERE d.match_id = candidate.match_id
           AND d.deadline_type = candidate.deadline_type
           AND recovered.match_id = d.match_id
           AND d.completed_at IS NULL
         RETURNING d.match_id, d.deadline_type, d.due_at, d.expected_revision,
                   d.fencing_token, d.payload
       )
       SELECT claimed.match_id, claimed.deadline_type, claimed.due_at,
              claimed.expected_revision, claimed.fencing_token, claimed.payload,
              recovered.owner_instance_id, recovered.lease_expires_at,
              recovered.protocol_min, recovered.protocol_max, recovered.draining
       FROM claimed
       JOIN recovered ON recovered.match_id = claimed.match_id
       ORDER BY claimed.due_at ASC, claimed.match_id ASC`,
      [
        boundedBatchSize(input.limit),
        input.ownerInstanceId,
        input.protocolVersion,
        input.ownershipLeaseDurationMs,
        input.workerId,
        input.deadlineLeaseDurationMs,
        input.now ?? null
      ]
    );
    return result.rows.map((row) => ({
      deadline: {
        matchId: row.match_id,
        type: row.deadline_type,
        dueAt: row.due_at,
        expectedRevision: Number(row.expected_revision),
        fencingToken: Number(row.fencing_token),
        payload: row.payload,
        ownerInstanceId: row.owner_instance_id
      },
      lease: mapOwnership(row)
    }));
  }

  async claimDueDeadlines(input: {
    workerId: string;
    leaseDurationMs: number;
    limit?: number;
    now?: Date;
  }): Promise<readonly RecoverableDeadline[]> {
    const result = await this.pool.query<DeadlineRow>(
      `WITH runtime_clock AS (
         SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now
       ), candidates AS (
         SELECT d.match_id, d.deadline_type
         FROM recoverable_game_deadlines d
         JOIN game_runtime_owners o ON o.match_id = d.match_id
         CROSS JOIN runtime_clock c
         WHERE d.completed_at IS NULL AND d.due_at <= c.now
           AND (d.claimed_until IS NULL OR d.claimed_until <= c.now)
           AND o.lease_expires_at > c.now AND o.draining = false
           AND o.fencing_token = d.fencing_token
         ORDER BY d.due_at ASC, d.match_id ASC
         FOR UPDATE OF d SKIP LOCKED
         LIMIT $1
       )
       UPDATE recoverable_game_deadlines d
       SET claimed_by = $2,
           claimed_until = runtime_clock.now + ($3::bigint * interval '1 millisecond'),
           updated_at = runtime_clock.now
       FROM candidates candidate, game_runtime_owners o, runtime_clock
       WHERE d.match_id = candidate.match_id AND d.deadline_type = candidate.deadline_type
         AND o.match_id = d.match_id
       RETURNING d.match_id, d.deadline_type, d.due_at, d.expected_revision,
                 d.fencing_token, d.payload, o.owner_instance_id`,
      [boundedBatchSize(input.limit), input.workerId, input.leaseDurationMs, input.now ?? null]
    );
    return result.rows.map((row) => ({
      matchId: row.match_id,
      type: row.deadline_type,
      dueAt: row.due_at,
      expectedRevision: Number(row.expected_revision),
      fencingToken: Number(row.fencing_token),
      payload: row.payload,
      ownerInstanceId: row.owner_instance_id
    }));
  }

  async readOperationalMetrics(now?: Date): Promise<DistributedRuntimeOperationalMetrics> {
    const result = await this.pool.query<OperationalMetricsRow>(
      `WITH runtime_clock AS (
         SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
       )
       SELECT
         (SELECT count(*) FROM game_event_outbox WHERE published_at IS NULL) AS outbox_backlog,
         (SELECT COALESCE(EXTRACT(EPOCH FROM (c.now - MIN(created_at))) * 1000, 0)
            FROM game_event_outbox WHERE published_at IS NULL) AS oldest_outbox_age_ms,
         (SELECT count(*) FROM recoverable_game_deadlines
            WHERE completed_at IS NULL AND due_at <= c.now) AS due_deadline_count,
         (SELECT COALESCE(EXTRACT(EPOCH FROM (c.now - MIN(due_at))) * 1000, 0)
            FROM recoverable_game_deadlines
            WHERE completed_at IS NULL AND due_at <= c.now) AS oldest_deadline_lag_ms,
         (SELECT count(*)
            FROM game_runtime_owners o
            JOIN ranking_matches m ON m.id = o.match_id
            WHERE m.status = 'active' AND (o.lease_expires_at <= c.now OR o.draining = true))
           AS orphaned_game_count,
         (SELECT count(*) FROM distributed_matchmaking_tickets
            WHERE status = 'waiting' AND expires_at > c.now) AS matchmaking_queue_depth,
         (SELECT COALESCE(EXTRACT(EPOCH FROM (c.now - MIN(enqueued_at))) * 1000, 0)
            FROM distributed_matchmaking_tickets
            WHERE status = 'waiting' AND expires_at > c.now) AS oldest_matchmaking_queue_age_ms
       FROM runtime_clock c`,
      [now ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error("PostgreSQL did not return distributed runtime metrics.");
    return {
      outboxBacklog: Number(row.outbox_backlog),
      oldestOutboxAgeMs: Math.max(0, Number(row.oldest_outbox_age_ms)),
      dueDeadlineCount: Number(row.due_deadline_count),
      oldestDeadlineLagMs: Math.max(0, Number(row.oldest_deadline_lag_ms)),
      orphanedGameCount: Number(row.orphaned_game_count),
      matchmakingQueueDepth: Number(row.matchmaking_queue_depth),
      oldestMatchmakingQueueAgeMs: Math.max(0, Number(row.oldest_matchmaking_queue_age_ms))
    };
  }

  async enqueueMatchmakingTicket(input: {
    ticketId: string;
    playerId: string;
    playerCount: 2 | 6;
    region: string;
    protocolVersion: number;
    ttlMs?: number;
    now?: Date;
  }): Promise<MatchmakingTicket> {
    const ttlMs = matchmakingTtl(input.ttlMs);
    return inTransaction(this.pool, async (client) => {
      await client.query(
        `WITH runtime_clock AS (
           SELECT COALESCE($2::timestamptz, clock_timestamp()) AS now
         )
         UPDATE distributed_matchmaking_tickets t
         SET status = 'cancelled', claimed_by = NULL, claimed_until = NULL,
             updated_at = c.now
         FROM runtime_clock c
         WHERE t.player_id = $1 AND t.status = 'waiting' AND t.expires_at <= c.now`,
        [input.playerId, input.now ?? null]
      );
      const inserted = await client.query<TicketRow>(
        `WITH runtime_clock AS (
           SELECT COALESCE($7::timestamptz, clock_timestamp()) AS now
         )
         INSERT INTO distributed_matchmaking_tickets (
           ticket_id, player_id, player_count, region, protocol_version,
           status, enqueued_at, heartbeat_at, expires_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5, 'waiting', c.now, c.now,
                c.now + ($6::bigint * interval '1 millisecond'), c.now
         FROM runtime_clock c
         ON CONFLICT (player_id) WHERE status = 'waiting' DO UPDATE SET
           heartbeat_at = EXCLUDED.heartbeat_at,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at
         WHERE distributed_matchmaking_tickets.player_count = EXCLUDED.player_count
           AND distributed_matchmaking_tickets.region = EXCLUDED.region
           AND distributed_matchmaking_tickets.protocol_version = EXCLUDED.protocol_version
           AND distributed_matchmaking_tickets.expires_at > EXCLUDED.heartbeat_at
         RETURNING ticket_id, player_id, player_count, region, protocol_version,
                   enqueued_at, heartbeat_at, expires_at`,
        [
          input.ticketId,
          input.playerId,
          input.playerCount,
          input.region,
          input.protocolVersion,
          ttlMs,
          input.now ?? null
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new RepositoryConflictError("The player already has a different live matchmaking ticket.");
      return mapTicket(row);
    });
  }

  async heartbeatMatchmakingTicket(input: {
    ticketId: string;
    playerId: string;
    ttlMs?: number;
    now?: Date;
  }): Promise<MatchmakingTicket> {
    const [ticket] = await this.heartbeatMatchmakingTickets({
      tickets: [{ ticketId: input.ticketId, playerId: input.playerId }],
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      ...(input.now === undefined ? {} : { now: input.now })
    });
    if (!ticket) throw new RepositoryConflictError("The matchmaking ticket expired, was cancelled, or was matched.");
    return ticket;
  }

  async heartbeatMatchmakingTickets(input: {
    tickets: readonly Readonly<{ ticketId: string; playerId: string }>[];
    ttlMs?: number;
    now?: Date;
  }): Promise<readonly MatchmakingTicket[]> {
    if (input.tickets.length === 0) return [];
    if (input.tickets.length > 1_000) {
      throw new RepositoryConflictError("A matchmaking heartbeat batch cannot exceed 1000 tickets.");
    }
    const identities = new Set(input.tickets.map(({ ticketId, playerId }) => `${ticketId}:${playerId}`));
    if (identities.size !== input.tickets.length) {
      throw new RepositoryConflictError("A matchmaking heartbeat batch must contain unique ticket/player pairs.");
    }
    const result = await this.pool.query<TicketRow>(
      `WITH input_tickets(ticket_id, player_id) AS (
         SELECT batch.ticket_id, batch.player_id
         FROM unnest($1::uuid[], $2::uuid[]) AS batch(ticket_id, player_id)
       ), runtime_clock AS (
         SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now
       )
       UPDATE distributed_matchmaking_tickets t
       SET heartbeat_at = c.now,
           expires_at = c.now + ($3::bigint * interval '1 millisecond'),
           updated_at = c.now
       FROM runtime_clock c, input_tickets i
       WHERE t.ticket_id = i.ticket_id AND t.player_id = i.player_id
         AND t.status = 'waiting' AND t.expires_at > c.now
       RETURNING t.ticket_id, t.player_id, t.player_count, t.region, t.protocol_version,
                 t.enqueued_at, t.heartbeat_at, t.expires_at`,
      [
        input.tickets.map(({ ticketId }) => ticketId),
        input.tickets.map(({ playerId }) => playerId),
        matchmakingTtl(input.ttlMs),
        input.now ?? null
      ]
    );
    return result.rows.map(mapTicket);
  }

  async cancelMatchmakingTicket(input: {
    ticketId: string;
    playerId: string;
    now?: Date;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE distributed_matchmaking_tickets
       SET status = 'cancelled', claimed_by = NULL, claimed_until = NULL,
           updated_at = COALESCE($3::timestamptz, clock_timestamp())
       WHERE ticket_id = $1 AND player_id = $2 AND status = 'waiting'`,
      [input.ticketId, input.playerId, input.now ?? null]
    );
    return result.rowCount === 1;
  }

  async claimMatchmakingGroup(input: {
    coordinatorId: string;
    playerCount: 2 | 6;
    region: string;
    protocolVersion: number;
    leaseDurationMs: number;
    now?: Date;
  }): Promise<readonly MatchmakingTicket[]> {
    return inTransaction(this.pool, async (client) => {
      await client.query(
        `WITH runtime_clock AS (
           SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now
         )
         UPDATE distributed_matchmaking_tickets t
         SET status = 'cancelled', claimed_by = NULL, claimed_until = NULL,
             updated_at = c.now
         FROM runtime_clock c
         WHERE t.status = 'waiting' AND t.expires_at <= c.now`,
        [input.now ?? null]
      );
      const candidates = await client.query<TicketRow>(
        `WITH runtime_clock AS (
           SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now
         )
         SELECT ticket_id, player_id, player_count, region, protocol_version,
                enqueued_at, heartbeat_at, expires_at
         FROM distributed_matchmaking_tickets, runtime_clock c
         WHERE status = 'waiting' AND region = $1 AND player_count = $2
           AND protocol_version = $3
           AND expires_at > c.now
           AND (claimed_until IS NULL OR claimed_until <= c.now)
         ORDER BY enqueued_at ASC, ticket_id ASC
         FOR UPDATE OF distributed_matchmaking_tickets SKIP LOCKED
         LIMIT $2`,
        [input.region, input.playerCount, input.protocolVersion, input.now ?? null]
      );
      if (candidates.rows.length !== input.playerCount) return [];
      await client.query(
        `UPDATE distributed_matchmaking_tickets
         SET claimed_by = $2,
             claimed_until = COALESCE($4::timestamptz, clock_timestamp())
               + ($3::bigint * interval '1 millisecond'),
             updated_at = COALESCE($4::timestamptz, clock_timestamp())
         WHERE ticket_id = ANY($1::uuid[])`,
        [
          candidates.rows.map(({ ticket_id }) => ticket_id),
          input.coordinatorId,
          input.leaseDurationMs,
          input.now ?? null
        ]
      );
      return candidates.rows.map(mapTicket);
    });
  }

  async heartbeatMatchmakingClaim(input: {
    coordinatorId: string;
    ticketIds: readonly string[];
    leaseDurationMs: number;
    now?: Date;
  }): Promise<void> {
    const result = await this.pool.query(
      `WITH runtime_clock AS (
         SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now
       )
       UPDATE distributed_matchmaking_tickets t
       SET claimed_until = c.now + ($3::bigint * interval '1 millisecond'),
           updated_at = c.now
       FROM runtime_clock c
       WHERE t.ticket_id = ANY($1::uuid[]) AND t.status = 'waiting'
         AND t.claimed_by = $2 AND t.claimed_until > c.now AND t.expires_at > c.now`,
      [input.ticketIds, input.coordinatorId, input.leaseDurationMs, input.now ?? null]
    );
    if (result.rowCount !== input.ticketIds.length) {
      throw new RepositoryConflictError("One or more matchmaking claims expired or were cancelled.");
    }
  }

  async releaseMatchmakingClaim(input: {
    coordinatorId: string;
    ticketIds: readonly string[];
    now?: Date;
  }): Promise<number> {
    const result = await this.pool.query(
      `UPDATE distributed_matchmaking_tickets
       SET claimed_by = NULL, claimed_until = NULL,
           updated_at = COALESCE($3::timestamptz, clock_timestamp())
       WHERE ticket_id = ANY($1::uuid[]) AND status = 'waiting' AND claimed_by = $2`,
      [input.ticketIds, input.coordinatorId, input.now ?? null]
    );
    return result.rowCount ?? 0;
  }

  async startClaimedGeneralGame(input: {
    coordinatorId: string;
    ticketIds: readonly string[];
    matchId: string;
    publicName: string;
    playerCount: 2 | 6;
    ownerInstanceId: string;
    protocolVersion: number;
    ownershipLeaseDurationMs: number;
    startedAt: Date;
    now?: Date;
    participants: readonly {
      userId: string;
      seatNumber: number;
      displayName: string;
      badgeId: string;
    }[];
    initialEvent: {
      eventId: string;
      payload: Readonly<Record<string, unknown>>;
    };
    firstDeadline: {
      type: "turn" | "showdown";
      dueAt: Date;
      expectedRevision: number;
      payload: Readonly<Record<string, unknown>>;
    };
  }): Promise<GameOwnershipLease> {
    if (input.ticketIds.length !== input.playerCount
      || new Set(input.ticketIds).size !== input.playerCount
      || input.participants.length !== input.playerCount
      || new Set(input.participants.map(({ userId }) => userId)).size !== input.playerCount) {
      throw new RepositoryConflictError("A match start requires one unique ticket and participant per seat.");
    }
    requireObject(input.initialEvent.payload, "The initial event payload");
    requireObject(input.firstDeadline.payload, "The first deadline payload");
    if (input.firstDeadline.expectedRevision !== 1) {
      throw new RepositoryConflictError("The first deadline must target initial revision 1.");
    }

    return inTransaction(this.pool, async (client) => {
      const tickets = await client.query<TicketRow & { claimed_by: string | null; claimed_until: Date | null }>(
        `WITH runtime_clock AS (
           SELECT COALESCE($3::timestamptz, clock_timestamp()) AS now
         )
         SELECT ticket_id, player_id, player_count, region, protocol_version,
                enqueued_at, heartbeat_at, expires_at, claimed_by, claimed_until
         FROM distributed_matchmaking_tickets, runtime_clock c
         WHERE ticket_id = ANY($1::uuid[]) AND status = 'waiting'
           AND claimed_by = $2 AND claimed_until > c.now AND expires_at > c.now
         ORDER BY ticket_id ASC
         FOR UPDATE OF distributed_matchmaking_tickets`,
        [input.ticketIds, input.coordinatorId, input.now ?? null]
      );
      const expectedPlayers = new Set(input.participants.map(({ userId }) => userId));
      if (tickets.rows.length !== input.playerCount
        || tickets.rows.some((ticket) => ticket.player_count !== input.playerCount
          || ticket.protocol_version !== input.protocolVersion
          || !expectedPlayers.has(ticket.player_id))) {
        throw new RepositoryConflictError("The matchmaking claim expired or no longer matches these participants.");
      }

      await client.query(
        `INSERT INTO ranking_matches (
           id, public_name, player_count, match_type, started_at
         ) VALUES ($1, $2, $3, 'general', $4)`,
        [input.matchId, input.publicName, input.playerCount, input.startedAt]
      );
      for (const participant of input.participants) {
        await client.query(
          `INSERT INTO match_participants (
             match_id, user_id, seat_number, display_name, badge_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            input.matchId,
            participant.userId,
            participant.seatNumber,
            participant.displayName,
            participant.badgeId
          ]
        );
      }
      await client.query(
        `INSERT INTO game_events (
           event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
         ) VALUES ($1, $2, 1, 'game.started', NULL, NULL, $3::jsonb, $4)`,
        [input.initialEvent.eventId, input.matchId, JSON.stringify(input.initialEvent.payload), input.startedAt]
      );
      const ownership = await client.query<OwnershipRow>(
        `WITH runtime_clock AS (
           SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now
         )
         INSERT INTO game_runtime_owners (
           match_id, owner_instance_id, fencing_token, lease_expires_at,
           protocol_min, protocol_max, draining, updated_at
         )
         SELECT $1, $2, 1,
                c.now + ($3::bigint * interval '1 millisecond'),
                $4, $4, false, c.now
         FROM runtime_clock c
         RETURNING match_id, owner_instance_id, fencing_token, lease_expires_at,
                   protocol_min, protocol_max, draining`,
        [
          input.matchId,
          input.ownerInstanceId,
          input.ownershipLeaseDurationMs,
          input.protocolVersion,
          input.now ?? null
        ]
      );
      await client.query(
        `INSERT INTO game_event_outbox (
           outbox_id, match_id, event_sequence, fencing_token, topic,
           routing_key, payload, created_at, available_at
         ) VALUES (
           $1, $2, 1, 1, 'game.event', $2::uuid::text, $3::jsonb,
           COALESCE($4::timestamptz, clock_timestamp()),
           COALESCE($4::timestamptz, clock_timestamp())
         )`,
        [
          input.initialEvent.eventId,
          input.matchId,
          JSON.stringify({
            eventId: input.initialEvent.eventId,
            eventType: "game.started",
            matchId: input.matchId,
            sequence: 1,
            fencingToken: 1,
            payload: input.initialEvent.payload
          }),
          input.now ?? null
        ]
      );
      await client.query(
        `INSERT INTO recoverable_game_deadlines (
           match_id, deadline_type, due_at, expected_revision, fencing_token, payload, updated_at
         ) VALUES (
           $1, $2, $3, $4, 1, $5::jsonb,
           COALESCE($6::timestamptz, clock_timestamp())
         )`,
        [
          input.matchId,
          input.firstDeadline.type,
          input.firstDeadline.dueAt,
          input.firstDeadline.expectedRevision,
          JSON.stringify(input.firstDeadline.payload),
          input.now ?? null
        ]
      );
      const matched = await client.query(
        `UPDATE distributed_matchmaking_tickets
         SET status = 'matched', match_id = $2, claimed_by = NULL, claimed_until = NULL,
             updated_at = COALESCE($3::timestamptz, clock_timestamp())
         WHERE ticket_id = ANY($1::uuid[]) AND status = 'waiting' AND claimed_by = $4`,
        [input.ticketIds, input.matchId, input.now ?? null, input.coordinatorId]
      );
      if (matched.rowCount !== input.playerCount) {
        throw new RepositoryConflictError("The matchmaking claim changed while the game was starting.");
      }
      const row = ownership.rows[0];
      if (!row) throw new Error("PostgreSQL did not return the initial game ownership lease.");
      return mapOwnership(row);
    });
  }

  /**
   * Atomically turns a fully accepted private room into an owned, recoverable
   * game. The room activation, match, seats, initial event, outbox record,
   * ownership fence, and first deadline either all commit or all roll back.
   */
  async startReadyPrivateGame(input: {
    roomCode: string;
    matchId: string;
    publicName: string;
    playerCount: 2 | 6;
    ownerInstanceId: string;
    protocolVersion: number;
    ownershipLeaseDurationMs: number;
    startedAt: Date;
    now?: Date;
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
    firstDeadline: {
      type: "turn" | "showdown";
      dueAt: Date;
      expectedRevision: number;
      payload: Readonly<Record<string, unknown>>;
    };
  }): Promise<GameOwnershipLease> {
    if (input.participants.length !== input.playerCount
      || new Set(input.participants.map(({ userId }) => userId)).size !== input.playerCount
      || new Set(input.participants.map(({ seatNumber }) => seatNumber)).size !== input.playerCount
      || input.participants.some(({ seatNumber }) => seatNumber < 0 || seatNumber >= input.playerCount)) {
      throw new RepositoryConflictError("A private match start requires one unique participant per contiguous seat.");
    }
    requireObject(input.initialEvent.payload, "The initial event payload");
    requireObject(input.firstDeadline.payload, "The first deadline payload");
    if (input.firstDeadline.expectedRevision !== 1) {
      throw new RepositoryConflictError("The first deadline must target initial revision 1.");
    }

    return inTransaction(this.pool, async (client) => {
      const locked = await client.query<ReadyPrivateRoomRow>(
        `SELECT r.id, r.status, r.match_id, r.player_count, r.creator_user_id,
                ARRAY(
                  SELECT i.accepted_by_user_id
                  FROM private_match_invitations i
                  WHERE i.room_id = r.id AND i.accepted_by_user_id IS NOT NULL
                  ORDER BY i.seat_number
                ) AS accepted_player_ids
         FROM private_match_rooms r
         WHERE r.room_code = $1
         FOR UPDATE OF r`,
        [input.roomCode]
      );
      const room = locked.rows[0];
      if (!room) throw new RepositoryNotFoundError("The private room does not exist.");
      const expectedPlayers = new Set([room.creator_user_id, ...room.accepted_player_ids]);
      if (room.status !== "waiting" || room.match_id
        || room.player_count !== input.playerCount
        || expectedPlayers.size !== input.playerCount
        || input.participants.some(({ userId }) => !expectedPlayers.has(userId))) {
        throw new RepositoryConflictError("The private room is no longer ready to start.");
      }

      await client.query(
        `INSERT INTO ranking_matches (
           id, public_name, player_count, match_type, started_at
         ) VALUES ($1, $2, $3, 'private', $4)`,
        [input.matchId, input.publicName, input.playerCount, input.startedAt]
      );
      for (const participant of input.participants) {
        await client.query(
          `INSERT INTO match_participants (
             match_id, user_id, seat_number, display_name, badge_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.matchId, participant.userId, participant.seatNumber, participant.displayName, participant.badgeId]
        );
      }
      await client.query(
        `INSERT INTO game_events (
           event_id, match_id, sequence, event_type, actor_user_id, command_id, payload, occurred_at
         ) VALUES ($1, $2, 1, 'game.started', NULL, NULL, $3::jsonb, $4)`,
        [input.initialEvent.eventId, input.matchId, JSON.stringify(input.initialEvent.payload), input.startedAt]
      );
      const ownership = await client.query<OwnershipRow>(
        `WITH runtime_clock AS (
           SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now
         )
         INSERT INTO game_runtime_owners (
           match_id, owner_instance_id, fencing_token, lease_expires_at,
           protocol_min, protocol_max, draining, updated_at
         )
         SELECT $1, $2, 1,
                c.now + ($3::bigint * interval '1 millisecond'),
                $4, $4, false, c.now
         FROM runtime_clock c
         RETURNING match_id, owner_instance_id, fencing_token, lease_expires_at,
                   protocol_min, protocol_max, draining`,
        [
          input.matchId,
          input.ownerInstanceId,
          input.ownershipLeaseDurationMs,
          input.protocolVersion,
          input.now ?? null
        ]
      );
      await client.query(
        `INSERT INTO game_event_outbox (
           outbox_id, match_id, event_sequence, fencing_token, topic,
           routing_key, payload, created_at, available_at
         ) VALUES (
           $1, $2, 1, 1, 'game.event', $2::uuid::text, $3::jsonb,
           COALESCE($4::timestamptz, clock_timestamp()),
           COALESCE($4::timestamptz, clock_timestamp())
         )`,
        [
          input.initialEvent.eventId,
          input.matchId,
          JSON.stringify({
            eventId: input.initialEvent.eventId,
            eventType: "game.started",
            matchId: input.matchId,
            sequence: 1,
            fencingToken: 1,
            payload: input.initialEvent.payload
          }),
          input.now ?? null
        ]
      );
      await client.query(
        `INSERT INTO recoverable_game_deadlines (
           match_id, deadline_type, due_at, expected_revision, fencing_token, payload, updated_at
         ) VALUES (
           $1, $2, $3, $4, 1, $5::jsonb,
           COALESCE($6::timestamptz, clock_timestamp())
         )`,
        [
          input.matchId,
          input.firstDeadline.type,
          input.firstDeadline.dueAt,
          input.firstDeadline.expectedRevision,
          JSON.stringify(input.firstDeadline.payload),
          input.now ?? null
        ]
      );
      const activated = await client.query(
        `UPDATE private_match_rooms
         SET status = 'active', match_id = $2, started_at = $3, updated_at = $3
         WHERE id = $1 AND status = 'waiting' AND match_id IS NULL`,
        [room.id, input.matchId, input.startedAt]
      );
      if (activated.rowCount !== 1) {
        throw new RepositoryConflictError("The private room changed while the game was starting.");
      }
      const row = ownership.rows[0];
      if (!row) throw new Error("PostgreSQL did not return the initial private-game ownership lease.");
      return mapOwnership(row);
    });
  }
}
