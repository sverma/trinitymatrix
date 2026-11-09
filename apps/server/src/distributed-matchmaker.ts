import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { WebSocket as WebSocketRuntime } from "ws";
import {
  matchTypeSchema,
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type MatchType,
  type PlayerCount,
  type PostGameChatMessage,
  type PrivateRoom,
  type ProfileBadgeId,
  type ServerMessage
} from "@trinitymatrix/protocol";
import { z } from "zod";
import { PostgresDistributedGameRuntime, type GameOwnershipLease, type MaterializedGameRecord } from "./db/distributed-runtime";
import { RepositoryConflictError, type ApplicationRepository, type PrivateRoomRecord } from "./db/repository";
import type {
  InstanceEnvelope,
  PlayerMessageEnvelope,
  PublishedEventEnvelope,
  ValkeyDistributedGameTransport
} from "./distributed-transport";
import type { GameLeaseSupervisor } from "./distributed-workers";
import { RankingGame, rankingGameSnapshotSchema, type GameResult, type RankingGameSnapshot } from "./game";
import { coordinatorPrivateRoom } from "./private-routes";

type Connection = {
  playerId: string;
  email?: string;
  displayName: string;
  badgeId?: ProfileBadgeId;
  socket: WebSocket;
};

type GameCommand = Extract<ClientMessage, { type: `game.${string}` }>;

type ReconnectMetrics = Readonly<{
  recordReconnectSuccess(): void;
  recordReconnectFailure(): void;
}>;

export const distributedGameplayProtocolVersion = 1;
export const distributedOwnershipLeaseDurationMs = 30_000;
const protocolVersion = distributedGameplayProtocolVersion;
const ownershipLeaseDurationMs = distributedOwnershipLeaseDurationMs;
const ticketTtlMs = 90_000;
const ticketHeartbeatMs = 30_000;

const acceptedResultSchema = z.object({
  accepted: z.literal(true),
  ended: z.object({
    winnerId: z.string().uuid(),
    winnerName: z.string(),
    reason: z.enum(["declaration", "invalid-declaration", "player-dropped"]),
    score: z.number().int().nonnegative().optional()
  }).strict().optional(),
  dropped: z.object({ playerId: z.string().uuid(), playerName: z.string(), reason: z.string() }).strict().optional(),
  left: z.object({ playerId: z.string().uuid(), playerName: z.string() }).strict().optional()
}).strict();

const committedGameplayPayloadSchema = z.object({
  state: rankingGameSnapshotSchema,
  matchType: matchTypeSchema,
  privateRoomCode: z.string().nullable(),
  result: acceptedResultSchema.nullable(),
  actorPlayerId: z.string().uuid().nullable()
}).strict();

const durableOutboxPayloadSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string(),
  matchId: z.string().uuid(),
  sequence: z.number().int().positive(),
  fencingToken: z.number().int().positive(),
  payload: committedGameplayPayloadSchema
}).strict();

function committedPayload(input: {
  game: RankingGameSnapshot;
  matchType: MatchType;
  privateRoomCode: string | null;
  result?: Extract<GameResult, { accepted: true }> | null;
  actorPlayerId?: string | null;
}) {
  return committedGameplayPayloadSchema.parse({
    state: input.game,
    matchType: input.matchType,
    privateRoomCode: input.privateRoomCode,
    result: input.result ?? null,
    actorPlayerId: input.actorPlayerId ?? null
  });
}

function publicState(game: RankingGame, matchType: MatchType) {
  return { ...game.publicState(), matchType };
}

function nextDeadline(game: RankingGame) {
  const state = game.publicState();
  if (state.phase === "finished") return null;
  return {
    type: state.phase === "showdown" ? "showdown" as const : "turn" as const,
    dueAt: new Date(state.turnEndsAt),
    expectedRevision: state.revision,
    payload: { matchId: game.id, phase: state.phase }
  };
}

function roomForConnection(room: PrivateRoom, connection: Connection): PrivateRoom {
  const email = connection.email?.trim().toLowerCase();
  const creator = room.creator.playerId === connection.playerId;
  return {
    ...room,
    invites: room.invites.map((invite) => {
      const current = invite.playerId === connection.playerId || Boolean(email && invite.email === email);
      return {
        seatNumber: invite.seatNumber,
        status: invite.status,
        ...(invite.email && (creator || current) ? { email: invite.email } : {}),
        ...(current ? { isCurrentUser: true } : {}),
        ...(invite.playerId ? { playerId: invite.playerId } : {}),
        ...(invite.displayName ? { displayName: invite.displayName } : {})
      };
    })
  };
}

/**
 * Live horizontally-scaled gameplay coordinator.
 *
 * PostgreSQL is authoritative for queue membership, routing, ownership,
 * commands, events, deadlines, and materialization. Valkey Pub/Sub only lowers
 * delivery latency; missed delivery is recovered by loading PostgreSQL during
 * reconnect. No mutable game is exposed to a client before commitTransition.
 */
export class DistributedMatchmaker {
  private readonly connections = new Map<string, Connection>();
  private readonly queueTickets = new Map<string, { ticketId: string; playerCount: PlayerCount }>();
  private readonly privateReservations = new Set<string>();
  private readonly ownerChains = new Map<string, Promise<void>>();
  private readonly waitingPrivateRooms = new Map<string, PrivateRoom>();
  private readonly deliveredEventSequences = new Map<string, number>();
  private readonly deliveredPlayerEventSequences = new Map<string, Map<string, number>>();
  private ticketHeartbeat: NodeJS.Timeout | null = null;
  private ticketHeartbeatInFlight: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly runtime: PostgresDistributedGameRuntime,
    private readonly repository: ApplicationRepository,
    private readonly transport: Pick<ValkeyDistributedGameTransport, "routeCommand" | "publishPlayerMessage">,
    private readonly leases: GameLeaseSupervisor,
    readonly instanceId: string,
    private readonly region: string,
    private readonly reportError: (error: unknown) => void,
    private readonly reconnectMetrics?: ReconnectMetrics
  ) {}

  async restore(): Promise<void> {
    if (this.ticketHeartbeat) return;
    this.ticketHeartbeat = setInterval(() => {
      if (this.ticketHeartbeatInFlight) return;
      const heartbeat = this.heartbeatTickets();
      this.ticketHeartbeatInFlight = heartbeat;
      void heartbeat
        .catch(this.reportError)
        .finally(() => {
          if (this.ticketHeartbeatInFlight === heartbeat) this.ticketHeartbeatInFlight = null;
        });
    }, ticketHeartbeatMs);
    this.ticketHeartbeat.unref();
  }

  async replaceWaitingPrivateRooms(rooms: readonly PrivateRoom[]): Promise<void> {
    this.waitingPrivateRooms.clear();
    for (const room of rooms) {
      if (room.status !== "waiting") continue;
      this.waitingPrivateRooms.set(room.roomCode, room);
      if (room.acceptedCount === room.requiredCount) void this.tryStartPrivateRoom(room).catch(this.reportError);
    }
  }

  async register(connection: Connection): Promise<void> {
    const previous = this.connections.get(connection.playerId);
    if (previous && previous.socket !== connection.socket) previous.socket.close(4001, "Session opened in another window");
    this.connections.set(connection.playerId, connection);
    this.sendLocal(connection.playerId, {
      type: "session.ready",
      playerId: connection.playerId,
      displayName: connection.displayName
    });

    const activeMatchId = await this.runtime.getActiveMatchIdForPlayer(connection.playerId);
    if (activeMatchId) {
      try {
        await this.ensureRoute(activeMatchId);
        await this.sendMaterializedGame(connection.playerId, activeMatchId);
        this.reconnectMetrics?.recordReconnectSuccess();
      } catch (error) {
        this.reconnectMetrics?.recordReconnectFailure();
        throw error;
      }
      return;
    }

    const ticket = await this.runtime.getWaitingMatchmakingTicket(connection.playerId);
    if (ticket) {
      this.queueTickets.set(connection.playerId, { ticketId: ticket.ticketId, playerCount: ticket.playerCount });
      await this.sendQueueStatus(connection.playerId, ticket.playerCount);
    }

    const rooms = await this.repository.listPrivateRoomsForUser({
      userId: connection.playerId,
      email: connection.email ?? ""
    });
    for (const record of rooms.filter(({ status }) => status === "waiting")) {
      const room = coordinatorPrivateRoom(record);
      this.waitingPrivateRooms.set(room.roomCode, room);
      this.notifyRoomLocally(room, connection.playerId);
    }
  }

  async disconnect(playerId: string, socket: WebSocket): Promise<void> {
    const current = this.connections.get(playerId);
    if (current?.socket !== socket) return;
    this.connections.delete(playerId);
    if (!this.shuttingDown) await this.leaveQueue(playerId, false);
  }

  async handle(playerId: string, message: ClientMessage): Promise<void> {
    if (message.type === "ping") {
      this.sendLocal(playerId, { type: "pong", at: message.at });
      return;
    }
    if (message.type === "queue.join") {
      await this.joinQueue(playerId, message.playerCount);
      return;
    }
    if (message.type === "queue.leave") {
      await this.leaveQueue(playerId, true);
      return;
    }
    await this.routeGameCommand(playerId, message);
  }

  async reservePrivateEntry(playerId: string): Promise<boolean>;
  async reservePrivateEntry(playerId: string, roomCode: string): Promise<boolean>;
  async reservePrivateEntry(playerId: string, _roomCode?: string): Promise<boolean> {
    if (this.privateReservations.has(playerId)) return false;
    const [activeMatchId, ticket] = await Promise.all([
      this.runtime.getActiveMatchIdForPlayer(playerId),
      this.runtime.getWaitingMatchmakingTicket(playerId)
    ]);
    if (activeMatchId || ticket) return false;
    this.privateReservations.add(playerId);
    return true;
  }

  releasePrivateEntry(playerId: string): void {
    this.privateReservations.delete(playerId);
  }

  async upsertPrivateRoom(room: PrivateRoom): Promise<void> {
    this.waitingPrivateRooms.set(room.roomCode, room);
    await this.bestEffortPublishPrivateRoom(room);
    if (room.status === "waiting" && room.acceptedCount === room.requiredCount) {
      await this.tryStartPrivateRoom(room);
    }
  }

  async cancelPrivateRoom(room: PrivateRoom): Promise<void> {
    this.waitingPrivateRooms.delete(room.roomCode);
    await this.bestEffortPublishPrivateRoom(room);
  }

  updateProfile(playerId: string, displayName: string, badgeId: ProfileBadgeId): void {
    const connection = this.connections.get(playerId);
    if (connection) {
      connection.displayName = displayName;
      connection.badgeId = badgeId;
    }
  }

  async broadcastPostGameChat(
    participantPlayerIds: readonly string[],
    gameName: string,
    message: PostGameChatMessage
  ): Promise<void> {
    const match = await this.repository.getMatchByPublicName(gameName);
    if (!match) throw new Error("Cannot publish chat for an unknown match.");
    await Promise.all([...new Set(participantPlayerIds)].map((targetPlayerId) => this.publishPlayerMessage(
      match.id,
      1,
      targetPlayerId,
      { type: "chat.message", gameName, message }
    )));
  }

  async suspendPlayer(playerId: string): Promise<void> {
    await this.leaveQueue(playerId, false);
    const matchId = await this.runtime.getActiveMatchIdForPlayer(playerId);
    if (matchId) {
      const materialized = await this.runtime.loadMaterializedGame(matchId);
      const snapshot = materialized ? rankingGameSnapshotSchema.safeParse(materialized.eventPayload.state) : null;
      if (snapshot?.success && snapshot.data.phase !== "finished") {
        await this.routeGameCommand(playerId, {
          type: "game.drop",
          commandId: randomUUID(),
          gameId: matchId,
          expectedRevision: snapshot.data.revision
        });
      }
    }
    this.connections.get(playerId)?.socket.close(1008, "Account suspended");
  }

  async onInstanceEnvelope(envelope: InstanceEnvelope): Promise<void> {
    if (envelope.kind === "game.deadline") {
      await this.enqueueOwnerWork(envelope.matchId, () => this.applyDeadline(envelope));
      return;
    }
    const parsed = parseClientMessage(envelope.command);
    if (!parsed.type.startsWith("game.")) throw new Error("A routed gameplay command was not a game command.");
    await this.enqueueOwnerWork(envelope.matchId, () => this.applyCommand(
      envelope.playerId,
      parsed as GameCommand,
      envelope.fencingToken
    ));
  }

  onPublishedEvent(envelope: PublishedEventEnvelope): void {
    const durable = durableOutboxPayloadSchema.parse(envelope.eventPayload);
    if (durable.matchId !== envelope.matchId || durable.sequence !== envelope.eventSequence
      || durable.fencingToken !== envelope.ownershipFenceAtCommit) {
      throw new RepositoryConflictError("The published event envelope does not match its durable outbox payload.");
    }
    const delivered = this.deliveredEventSequences.get(envelope.matchId) ?? 0;
    if (envelope.eventSequence <= delivered) return;
    this.deliveredEventSequences.set(envelope.matchId, envelope.eventSequence);
    const { state, matchType, result } = durable.payload;
    const game = RankingGame.restore(state);
    const deliveredPlayers = new Set<string>();
    for (const seat of state.seats) {
      if (seat.detached && result?.left?.playerId !== seat.id) continue;
      if (!this.connections.has(seat.id)) continue;
      if (envelope.eventSequence <= this.deliveredPlayerEventSequence(envelope.matchId, seat.id)) continue;
      this.rememberPlayerEventSequence(envelope.matchId, seat.id, envelope.eventSequence);
      deliveredPlayers.add(seat.id);
      if (durable.eventType === "game.started") {
        this.sendLocal(seat.id, {
          type: "game.started",
          ...publicState(game, matchType),
          hand: game.handFor(seat.id)
        });
      } else {
        this.sendLocal(seat.id, { type: "game.hand", hand: game.handFor(seat.id) });
        this.sendLocal(seat.id, { type: "game.state", ...publicState(game, matchType) });
      }
      if (result?.dropped) this.sendLocal(seat.id, {
        type: "game.declaration-rejected",
        ...result.dropped,
        dropped: true
      });
      if (result?.left) this.sendLocal(seat.id, {
        type: "game.player-dropped",
        playerId: result.left.playerId,
        playerName: result.left.playerName
      });
      if (result?.ended) this.sendLocal(seat.id, { type: "game.ended", ...result.ended });
    }
    if (result?.left && deliveredPlayers.has(result.left.playerId)) {
      this.sendLocal(result.left.playerId, { type: "game.left", gameId: state.id, outcome: "dropped" });
    }
    if (result?.ended) {
      for (const seat of state.seats) this.queueTickets.delete(seat.id);
      if (durable.payload.privateRoomCode) this.waitingPrivateRooms.delete(durable.payload.privateRoomCode);
      // Retain the terminal sequence for the life of this process so a delayed
      // pre-finish outbox publication can never resurrect an older table.
      // That global terminal watermark makes the match's per-player delivery
      // watermarks redundant after terminal fanout has completed.
      this.deliveredPlayerEventSequences.delete(envelope.matchId);
    }
  }

  onPlayerMessage(envelope: PlayerMessageEnvelope): void {
    this.sendLocal(envelope.targetPlayerId, parseServerMessage(envelope.serverMessage));
  }

  async flush(): Promise<void> {
    await Promise.all(this.ownerChains.values());
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.ticketHeartbeat) clearInterval(this.ticketHeartbeat);
    this.ticketHeartbeat = null;
    await this.ticketHeartbeatInFlight?.catch(() => undefined);
    this.ticketHeartbeatInFlight = null;
    for (const connection of this.connections.values()) connection.socket.close(1001, "Server shutting down");
  }

  private async heartbeatTickets(): Promise<void> {
    const tickets = [...this.queueTickets]
      .filter(([playerId]) => this.connections.has(playerId))
      .map(([playerId, ticket]) => ({ playerId, ticketId: ticket.ticketId }));
    for (let offset = 0; offset < tickets.length; offset += 1_000) {
      const batch = tickets.slice(offset, offset + 1_000);
      const renewed = await this.runtime.heartbeatMatchmakingTickets({
        tickets: batch,
        ttlMs: ticketTtlMs
      });
      const live = new Set(renewed.map(({ ticketId, playerId }) => `${ticketId}:${playerId}`));
      for (const { ticketId, playerId } of batch) {
        if (live.has(`${ticketId}:${playerId}`)) continue;
        if (this.queueTickets.get(playerId)?.ticketId === ticketId) this.queueTickets.delete(playerId);
      }
    }
  }

  private async joinQueue(playerId: string, playerCount: PlayerCount): Promise<void> {
    if (this.privateReservations.has(playerId)) {
      this.sendLocal(playerId, { type: "error", code: "PRIVATE_ROOM_PENDING", message: "Finish or cancel your private room first." });
      return;
    }
    const connection = this.connections.get(playerId);
    if (connection?.email) {
      const privateRooms = await this.repository.listPrivateRoomsForUser({
        userId: playerId,
        email: connection.email
      });
      if (privateRooms.some(({ status }) => status === "waiting" || status === "active")) {
        this.sendLocal(playerId, { type: "error", code: "PRIVATE_ROOM_PENDING", message: "Finish or cancel your private room first." });
        return;
      }
    }
    if (await this.runtime.getActiveMatchIdForPlayer(playerId)) {
      this.sendLocal(playerId, { type: "error", code: "ALREADY_IN_GAME", message: "You already have an active game." });
      return;
    }
    const ticket = await this.runtime.enqueueMatchmakingTicket({
      ticketId: randomUUID(),
      playerId,
      playerCount,
      region: this.region,
      protocolVersion,
      ttlMs: ticketTtlMs
    });
    this.queueTickets.set(playerId, { ticketId: ticket.ticketId, playerCount });
    await this.sendQueueStatus(playerId, playerCount);
    await this.tryCreateMatches(playerCount);
  }

  private async leaveQueue(playerId: string, notify: boolean): Promise<void> {
    const local = this.queueTickets.get(playerId);
    const ticket = local ?? await this.runtime.getWaitingMatchmakingTicket(playerId);
    if (!ticket) return;
    await this.runtime.cancelMatchmakingTicket({
      ticketId: ticket.ticketId,
      playerId
    });
    this.queueTickets.delete(playerId);
    if (notify) this.sendLocal(playerId, {
      type: "queue.status",
      playerCount: ticket.playerCount,
      joined: 0,
      required: ticket.playerCount
    });
  }

  private async sendQueueStatus(playerId: string, playerCount: PlayerCount): Promise<void> {
    const waiting = await this.runtime.countWaitingMatchmakingTickets({
      playerCount,
      region: this.region,
      protocolVersion
    });
    this.sendLocal(playerId, {
      type: "queue.status",
      playerCount,
      joined: Math.min(waiting, playerCount),
      required: playerCount
    });
  }

  private async tryCreateMatches(playerCount: PlayerCount): Promise<void> {
    while (!this.shuttingDown) {
      const claimed = await this.runtime.claimMatchmakingGroup({
        coordinatorId: this.instanceId,
        playerCount,
        region: this.region,
        protocolVersion,
        leaseDurationMs: 10_000
      });
      if (claimed.length === 0) return;
      try {
        const profiles = await Promise.all(claimed.map(({ playerId }) => this.repository.getUserProfile(playerId)));
        if (profiles.some((profile) => !profile || profile.suspendedAt)) {
          throw new RepositoryConflictError("A claimed matchmaking player is missing or suspended.");
        }
        const game = new RankingGame(profiles.map((profile) => ({
          id: profile!.id,
          displayName: profile!.displayName,
          badgeId: profile!.badgeId
        })));
        const snapshot = game.snapshot();
        const startedAt = new Date();
        const lease = await this.runtime.startClaimedGeneralGame({
          coordinatorId: this.instanceId,
          ticketIds: claimed.map(({ ticketId }) => ticketId),
          matchId: game.id,
          publicName: game.publicName,
          playerCount,
          ownerInstanceId: this.instanceId,
          protocolVersion,
          ownershipLeaseDurationMs,
          startedAt,
          participants: snapshot.seats.map((seat, seatNumber) => ({
            userId: seat.id,
            seatNumber,
            displayName: seat.displayName,
            badgeId: seat.badgeId
          })),
          initialEvent: {
            eventId: randomUUID(),
            payload: committedPayload({ game: snapshot, matchType: "general", privateRoomCode: null })
          },
          firstDeadline: nextDeadline(game)!
        });
        this.leases.track(lease);
        for (const profile of profiles) this.queueTickets.delete(profile!.id);
      } catch (error) {
        await this.runtime.releaseMatchmakingClaim({
          coordinatorId: this.instanceId,
          ticketIds: claimed.map(({ ticketId }) => ticketId)
        });
        throw error;
      }
    }
  }

  private async tryStartPrivateRoom(room: PrivateRoom): Promise<void> {
    if (room.status !== "waiting" || room.acceptedCount !== room.requiredCount
      || room.invites.some((invite) => invite.status !== "accepted" || !invite.playerId)) return;
    const playerIds = [room.creator.playerId, ...room.invites.map(({ playerId }) => playerId!)];
    const profiles = await Promise.all(playerIds.map((playerId) => this.repository.getUserProfile(playerId)));
    if (profiles.some((profile) => !profile || profile.suspendedAt)) {
      throw new RepositoryConflictError("A private-room player is missing or suspended.");
    }
    const game = new RankingGame(profiles.map((profile) => ({
      id: profile!.id,
      displayName: profile!.displayName,
      badgeId: profile!.badgeId
    })));
    const snapshot = game.snapshot();
    const lease = await this.runtime.startReadyPrivateGame({
      roomCode: room.roomCode,
      matchId: game.id,
      publicName: game.publicName,
      playerCount: room.playerCount,
      ownerInstanceId: this.instanceId,
      protocolVersion,
      ownershipLeaseDurationMs,
      startedAt: new Date(),
      participants: snapshot.seats.map((seat, seatNumber) => ({
        userId: seat.id,
        seatNumber,
        displayName: seat.displayName,
        badgeId: seat.badgeId
      })),
      initialEvent: {
        eventId: randomUUID(),
        payload: committedPayload({ game: snapshot, matchType: "private", privateRoomCode: room.roomCode })
      },
      firstDeadline: nextDeadline(game)!
    });
    this.leases.track(lease);
    this.waitingPrivateRooms.delete(room.roomCode);
    await this.bestEffortPublishPrivateRoom({ ...room, status: "active", gameName: game.publicName });
  }

  private async routeGameCommand(playerId: string, command: GameCommand): Promise<void> {
    const activeMatchId = await this.runtime.getActiveMatchIdForPlayer(playerId);
    if (!activeMatchId) {
      this.sendLocal(playerId, { type: "error", code: "NO_ACTIVE_GAME", message: "Join a queue before playing." });
      return;
    }
    if (activeMatchId !== command.gameId) {
      this.sendLocal(playerId, {
        type: "command.rejected",
        commandId: command.commandId,
        code: "WRONG_GAME",
        message: "This command targets another game.",
        revision: command.expectedRevision
      });
      return;
    }
    const route = await this.ensureRoute(activeMatchId);
    if (route.ownerInstanceId === this.instanceId) {
      await this.enqueueOwnerWork(activeMatchId, () => this.applyCommand(playerId, command, route!.fencingToken));
      return;
    }
    const receivers = await this.transport.routeCommand({
      matchId: activeMatchId,
      fencingToken: route.fencingToken,
      targetInstanceId: route.ownerInstanceId,
      playerId,
      clientProtocolVersion: protocolVersion,
      command
    });
    if (receivers < 1) {
      this.sendLocal(playerId, { type: "error", code: "OWNER_UNAVAILABLE", message: "The game is recovering. Please retry your move." });
    }
  }

  private async applyCommand(playerId: string, command: GameCommand, fencingToken: number): Promise<void> {
    const materialized = await this.requireMaterialized(command.gameId);
    const game = RankingGame.restore(materialized.eventPayload.state);
    const result = game.apply(playerId, command);
    if (!result.accepted) {
      if (result.code === "DUPLICATE") {
        const replay = await this.runtime.commitTransition({
          matchId: command.gameId,
          ownerInstanceId: this.instanceId,
          fencingToken,
          // Zero can never be the next event sequence; if the command receipt
          // is missing this fails before any write instead of fabricating an
          // event from already-advanced state.
          expectedNextSequence: 0,
          event: {
            eventId: randomUUID(),
            eventType: command.type,
            actorUserId: playerId,
            commandId: command.commandId,
            payload: committedPayload({
              game: game.snapshot(),
              matchType: materialized.matchType,
              privateRoomCode: materialized.privateRoomCode
            }),
            occurredAt: new Date()
          },
          command: {
            actorUserId: playerId,
            commandType: command.type,
            expectedRevision: command.expectedRevision,
            payload: command,
            result: {}
          },
          nextDeadline: null
        });
        if (replay.disposition === "replayed") {
          await this.sendMaterializedGame(playerId, command.gameId);
          return;
        }
      }
      await this.publishPlayerMessage(command.gameId, fencingToken, playerId, {
        type: "command.rejected",
        commandId: result.commandId,
        code: result.code,
        message: result.message,
        revision: game.publicState().revision
      });
      return;
    }
    const snapshot = game.snapshot();
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload = committedPayload({
      game: snapshot,
      matchType: materialized.matchType,
      privateRoomCode: materialized.privateRoomCode,
      result,
      actorPlayerId: playerId
    });
    const committed = await this.runtime.commitTransition({
      matchId: command.gameId,
      ownerInstanceId: this.instanceId,
      fencingToken,
      expectedNextSequence: materialized.eventSequence + 1,
      event: {
        eventId,
        eventType: command.type,
        actorUserId: playerId,
        commandId: command.commandId,
        payload,
        occurredAt
      },
      command: {
        actorUserId: playerId,
        commandType: command.type,
        expectedRevision: command.expectedRevision,
        payload: command,
        result
      },
      nextDeadline: nextDeadline(game),
      completion: result.ended ? {
        matchType: materialized.matchType,
        winnerUserId: result.ended.winnerId,
        endReason: result.ended.reason,
        endedAt: occurredAt,
        participantOutcomes: snapshot.seats.map((seat) => ({
          userId: seat.id,
          outcome: seat.id === result.ended!.winnerId
            ? "won" as const
            : seat.status === "dropped" ? "dropped" as const : "lost" as const
        }))
      } : null
    });
    if (committed.disposition === "replayed") {
      await this.sendMaterializedGame(playerId, command.gameId);
      return;
    }
    if (result.ended) this.leases.forget(command.gameId);
  }

  private async ensureRoute(matchId: string): Promise<GameOwnershipLease> {
    const current = await this.runtime.getRoute(matchId);
    if (current) return current;
    const claimed = await this.runtime.claimOwnership({
      matchId,
      ownerInstanceId: this.instanceId,
      protocolVersion,
      leaseDurationMs: ownershipLeaseDurationMs
    });
    this.leases.track(claimed);
    return claimed;
  }

  private async applyDeadline(envelope: Extract<InstanceEnvelope, { kind: "game.deadline" }>): Promise<void> {
    const route = await this.runtime.getRoute(envelope.matchId);
    if (!route || route.ownerInstanceId !== this.instanceId || route.fencingToken !== envelope.fencingToken) return;
    const materialized = await this.requireMaterialized(envelope.matchId);
    if (materialized.eventSequence !== envelope.expectedRevision) return;
    const game = RankingGame.restore(materialized.eventPayload.state);
    if (game.publicState().revision !== envelope.expectedRevision) return;
    const timedOutPlayerId = game.currentPlayerId;
    const result = game.timeout();
    if (!result?.accepted) return;
    const snapshot = game.snapshot();
    const occurredAt = new Date();
    await this.runtime.commitTransition({
      matchId: envelope.matchId,
      ownerInstanceId: this.instanceId,
      fencingToken: envelope.fencingToken,
      expectedNextSequence: materialized.eventSequence + 1,
      event: {
        eventId: randomUUID(),
        eventType: envelope.deadlineType === "showdown" ? "game.showdown-timed-out" : "game.turn-timed-out",
        actorUserId: envelope.deadlineType === "showdown" ? null : timedOutPlayerId,
        commandId: null,
        payload: committedPayload({
          game: snapshot,
          matchType: materialized.matchType,
          privateRoomCode: materialized.privateRoomCode,
          result
        }),
        occurredAt
      },
      command: null,
      nextDeadline: nextDeadline(game),
      completion: result.ended ? {
        matchType: materialized.matchType,
        winnerUserId: result.ended.winnerId,
        endReason: result.ended.reason,
        endedAt: occurredAt,
        participantOutcomes: snapshot.seats.map((seat) => ({
          userId: seat.id,
          outcome: seat.id === result.ended!.winnerId
            ? "won" as const
            : seat.status === "dropped" ? "dropped" as const : "lost" as const
        }))
      } : null
    });
    if (result.ended) this.leases.forget(envelope.matchId);
  }

  private async requireMaterialized(matchId: string): Promise<MaterializedGameRecord & {
    eventPayload: z.infer<typeof committedGameplayPayloadSchema>;
  }> {
    const materialized = await this.runtime.loadMaterializedGame(matchId);
    if (!materialized) throw new Error("The routed game no longer exists.");
    const payload = committedGameplayPayloadSchema.parse(materialized.eventPayload);
    if (payload.state.id !== matchId || payload.state.revision !== materialized.eventSequence
      || payload.matchType !== materialized.matchType || payload.privateRoomCode !== materialized.privateRoomCode) {
      throw new RepositoryConflictError("The latest durable game event cannot be safely materialized.");
    }
    return { ...materialized, eventPayload: payload };
  }

  private async sendMaterializedGame(playerId: string, matchId: string): Promise<void> {
    let materialized = await this.requireMaterialized(matchId);
    let reloads = 0;
    // A live event can arrive while the materialized SELECT is in flight. Only
    // reload when it is strictly newer: equality must still hydrate a
    // replacement socket, which has not seen the prior socket's initialization.
    while (materialized.eventSequence < Math.max(
      this.deliveredEventSequences.get(matchId) ?? 0,
      this.deliveredPlayerEventSequence(matchId, playerId)
    )) {
      if (reloads >= 3) {
        throw new RepositoryConflictError("Reconnect hydration could not catch up with live event delivery.");
      }
      reloads += 1;
      materialized = await this.requireMaterialized(matchId);
    }
    const game = RankingGame.restore(materialized.eventPayload.state);
    if (!game.hasPlayer(playerId)) throw new RepositoryConflictError("The reconnecting player is not seated in this game.");
    this.sendLocal(playerId, {
      type: "game.started",
      ...publicState(game, materialized.matchType),
      hand: game.handFor(playerId)
    });
    const result = materialized.eventPayload.result;
    // If this task already fanned out the terminal event, its retained global
    // watermark protects against every older publication. Do not recreate the
    // per-player map that terminal fanout just released. A terminal SELECT that
    // wins before publication still needs its player watermark until fanout.
    if (!(result?.ended
      && (this.deliveredEventSequences.get(matchId) ?? 0) >= materialized.eventSequence)) {
      this.rememberPlayerEventSequence(matchId, playerId, materialized.eventSequence);
    }
    if (result?.ended) this.sendLocal(playerId, { type: "game.ended", ...result.ended });
    if (result?.left?.playerId === playerId) {
      this.sendLocal(playerId, { type: "game.left", gameId: matchId, outcome: "dropped" });
    }
  }

  private deliveredPlayerEventSequence(matchId: string, playerId: string): number {
    return this.deliveredPlayerEventSequences.get(matchId)?.get(playerId) ?? 0;
  }

  private rememberPlayerEventSequence(matchId: string, playerId: string, eventSequence: number): void {
    const players = this.deliveredPlayerEventSequences.get(matchId) ?? new Map<string, number>();
    players.set(playerId, Math.max(players.get(playerId) ?? 0, eventSequence));
    this.deliveredPlayerEventSequences.set(matchId, players);
  }

  private enqueueOwnerWork(matchId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.ownerChains.get(matchId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.ownerChains.set(matchId, current);
    void current.finally(() => {
      if (this.ownerChains.get(matchId) === current) this.ownerChains.delete(matchId);
    }).catch(this.reportError);
    return current;
  }

  private async publishPrivateRoom(room: PrivateRoom): Promise<void> {
    const recipients = new Set([room.creator.playerId, ...room.invites.flatMap(({ playerId }) => playerId ? [playerId] : [])]);
    await Promise.all([...recipients].map(async (targetPlayerId) => {
      // Only the creator may see every invitation email. An accepted invitee
      // is identified by player id, so its own address can be projected
      // without depending on which gateway currently holds its socket.
      const projection = roomForConnection(room, {
        playerId: targetPlayerId,
        displayName: "Player",
        socket: {} as WebSocket
      });
      await this.publishPlayerMessage(room.creator.playerId, 1, targetPlayerId, {
        type: "private.room-status",
        room: projection
      });
    }));
  }

  private async bestEffortPublishPrivateRoom(room: PrivateRoom): Promise<void> {
    try {
      await this.publishPrivateRoom(room);
    } catch (error) {
      // The room mutation is already durable. Clients recover the room via the
      // HTTP list endpoint and active games via PostgreSQL materialization.
      this.reportError(error);
    }
  }

  private notifyRoomLocally(room: PrivateRoom, playerId: string): void {
    const connection = this.connections.get(playerId);
    if (!connection) return;
    const projection = roomForConnection(room, connection);
    this.sendLocal(playerId, { type: "private.room-status", room: projection });
    const invite = projection.invites.find((candidate) => candidate.isCurrentUser);
    if (invite) this.sendLocal(playerId, {
      type: "private.invitation",
      invitation: {
        roomCode: room.roomCode,
        playerCount: room.playerCount,
        creatorDisplayName: room.creator.displayName,
        status: invite.status,
        createdAt: room.createdAt
      }
    });
  }

  private async publishPlayerMessage(
    matchId: string,
    fencingToken: number,
    targetPlayerId: string,
    serverMessage: ServerMessage
  ): Promise<void> {
    const receivers = await this.transport.publishPlayerMessage({
      matchId,
      fencingToken,
      sourceInstanceId: this.instanceId,
      targetPlayerId,
      eventId: randomUUID(),
      serverMessage
    });
    if (receivers < 1) throw new Error("The player message had no active Valkey subscribers.");
  }

  private sendLocal(playerId: string, message: ServerMessage): void {
    const socket = this.connections.get(playerId)?.socket;
    if (socket?.readyState === WebSocketRuntime.OPEN) socket.send(JSON.stringify(message));
  }
}

export function distributedPrivateRoom(record: PrivateRoomRecord): PrivateRoom {
  return coordinatorPrivateRoom(record);
}
