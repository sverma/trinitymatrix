import { WebSocket as WebSocketRuntime } from "ws";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { aiForfeitNoticeSchema, privateRoomSchema } from "@trinitymatrix/protocol";
import type {
  ClientMessage,
  MatchType,
  PlayerCount,
  PostGameChatMessage,
  PrivateRoom,
  ProfileBadgeId,
  ServerMessage
} from "@trinitymatrix/protocol";
import { RankingGame, rankingGameSnapshotSchema, type GameResult, type RankingGameSnapshot } from "./game";
import type { StateStore } from "./persistence";

export type GameplaySocket = { readyState: number; send(message: string): void; close(code?: number, reason?: string): void };
type Connection = {
  playerId: string;
  email?: string;
  displayName: string;
  badgeId?: ProfileBadgeId;
  actorKind?: "human" | "ai";
  aiModelId?: string;
  socket: GameplaySocket;
};

type GameCommand = Extract<ClientMessage, { type: `game.${string}` }>;

export type AiForfeitNotice = z.infer<typeof aiForfeitNoticeSchema>;

export type ArchivedGameEvent = Readonly<{
  game: RankingGameSnapshot;
  matchType?: MatchType;
  privateRoomCode?: string | null;
  eventType: "game.started" | GameCommand["type"] | "game.turn-timed-out" | "game.showdown-timed-out";
  actorPlayerId: string | null;
  commandId: string | null;
  command: GameCommand | null;
  aiFailure?: AiForfeitNotice;
  occurredAt: Date;
}>;

export interface GameArchive {
  startPrivateGame(event: ArchivedGameEvent): Promise<void>;
  recordEvent(event: ArchivedGameEvent): Promise<void>;
  completeGame(input: Readonly<{
    game: RankingGameSnapshot;
    matchType?: MatchType;
    privateRoomCode?: string | null;
    winnerId: string;
    reason: "declaration" | "invalid-declaration" | "player-dropped";
    endedAt: Date;
  }>): Promise<void>;
}

const turnDurationMs = 45_000;
const savedStateKey = "matchmaker:active-games";
const savedStateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  games: z.array(rankingGameSnapshotSchema),
  queues: z.object({
    twoPlayer: z.array(z.string()),
    sixPlayer: z.array(z.string())
  }).strict(),
  gameTypes: z.record(z.string(), z.enum(["general", "private"])).optional(),
  privateRoomCodes: z.record(z.string(), z.string()).optional(),
  privateRooms: z.array(privateRoomSchema).optional()
}).strict();

export class Matchmaker {
  private readonly connections = new Map<string, Connection>();
  private readonly queues = new Map<PlayerCount, string[]>([[2, []], [6, []]]);
  private readonly games = new Map<string, RankingGame>();
  private readonly playerGames = new Map<string, string>();
  private readonly gameTypes = new Map<string, MatchType>();
  private readonly privateRoomCodes = new Map<string, string>();
  private readonly privateRooms = new Map<string, PrivateRoom>();
  private readonly privateEntryReservations = new Map<string, string | null>();
  private readonly privateStartAttempts = new Map<string, Promise<void>>();
  private readonly gameTimers = new Map<string, NodeJS.Timeout>();
  private persistChain: Promise<void> = Promise.resolve();
  private readonly archiveChains = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly store: StateStore,
    private readonly reportPersistenceError: (error: unknown) => void = () => undefined,
    private readonly archive?: GameArchive
  ) {}

  private archiveWork(gameId: string, work: (archive: GameArchive) => Promise<void>): Promise<void> {
    if (!this.archive) return Promise.resolve();
    const previous = this.archiveChains.get(gameId) ?? Promise.resolve();
    const task = previous.then(async () => {
      let attempt = 0;
      while (true) {
        try {
          await work(this.archive!);
          return;
        } catch (error) {
          this.reportPersistenceError(error);
          const retryDelayMs = Math.min(30_000, 250 * (2 ** Math.min(attempt, 7)));
          attempt += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    });
    this.archiveChains.set(gameId, task);
    void task.then(() => {
      if (this.archiveChains.get(gameId) === task) this.archiveChains.delete(gameId);
    });
    return task;
  }

  async restore(): Promise<void> {
    const stored = await this.store.get<unknown>(savedStateKey);
    if (!stored) return;
    const snapshot = savedStateSchema.parse(stored);
    this.queues.set(2, [...snapshot.queues.twoPlayer]);
    this.queues.set(6, [...snapshot.queues.sixPlayer]);
    for (const [gameId, matchType] of Object.entries(snapshot.gameTypes ?? {})) this.gameTypes.set(gameId, matchType);
    for (const [gameId, roomCode] of Object.entries(snapshot.privateRoomCodes ?? {})) this.privateRoomCodes.set(gameId, roomCode);
    for (const room of snapshot.privateRooms ?? []) this.privateRooms.set(room.roomCode, room);
    for (const gameSnapshot of snapshot.games) {
      if (gameSnapshot.phase === "finished") continue;
      const game = RankingGame.restore(gameSnapshot);
      this.games.set(game.id, game);
      if (!this.gameTypes.has(game.id)) this.gameTypes.set(game.id, "general");
      for (const player of game.publicState().players) {
        if (game.isAttached(player.id)) this.playerGames.set(player.id, game.id);
      }
      this.armTimer(game);
    }
  }

  register(connection: Connection): void {
    const previous = this.connections.get(connection.playerId);
    if (previous && previous.socket !== connection.socket) previous.socket.close(4001, "Session opened in another window");
    this.connections.set(connection.playerId, connection);
    this.send(connection.playerId, {
      type: "session.ready",
      playerId: connection.playerId,
      displayName: connection.displayName
    });
    const game = this.gameFor(connection.playerId);
    if (game) {
      game.setConnected(connection.playerId, true);
      this.sendStarted(connection.playerId, game);
      this.broadcastState(game);
      this.persist();
      return;
    }
    this.notifyPrivateRoomsFor(connection);
    this.tryStartPrivateRoomsFor(connection.playerId);
    if (this.playerGames.has(connection.playerId)) return;
    for (const playerCount of [2, 6] as const) {
      if (this.queues.get(playerCount)!.includes(connection.playerId)) {
        this.broadcastQueue(playerCount);
        this.createMatches(playerCount);
        break;
      }
    }
  }

  replaceWaitingPrivateRooms(rooms: readonly PrivateRoom[]): void {
    for (const [code, room] of this.privateRooms) {
      if (room.status === "waiting") this.privateRooms.delete(code);
    }
    for (const room of rooms) {
      if (room.status === "waiting") this.privateRooms.set(room.roomCode, room);
    }
    for (const connection of this.connections.values()) this.notifyPrivateRoomsFor(connection);
    for (const room of rooms) this.tryStartPrivateRoom(room.roomCode);
    this.persist();
  }

  canEnterPrivateRoom(playerId: string, roomCode?: string): boolean {
    if (this.privateEntryReservations.has(playerId)) return false;
    if (this.playerGames.has(playerId)) return false;
    if ([...this.queues.values()].some((queue) => queue.includes(playerId))) return false;
    return ![...this.privateRooms.values()].some((room) => room.status === "waiting"
      && room.roomCode !== roomCode
      && (room.creator.playerId === playerId || room.invites.some((invite) => invite.playerId === playerId)));
  }

  reservePrivateEntry(playerId: string, roomCode?: string): boolean {
    if (!this.canEnterPrivateRoom(playerId, roomCode)) return false;
    this.privateEntryReservations.set(playerId, roomCode ?? null);
    return true;
  }

  releasePrivateEntry(playerId: string): void {
    this.privateEntryReservations.delete(playerId);
  }

  upsertPrivateRoom(room: PrivateRoom): void {
    this.privateRooms.set(room.roomCode, room);
    this.broadcastPrivateRoom(room);
    this.tryStartPrivateRoom(room.roomCode);
    this.persist();
  }

  cancelPrivateRoom(room: PrivateRoom): void {
    this.privateRooms.set(room.roomCode, room);
    this.broadcastPrivateRoom(room);
    this.privateRooms.delete(room.roomCode);
    this.persist();
  }

  private roomParticipantIds(room: PrivateRoom): string[] {
    return [room.creator.playerId, ...room.invites.flatMap((invite) => invite.playerId ? [invite.playerId] : [])];
  }

  private notifyPrivateRoomsFor(connection: Connection): void {
    const email = connection.email?.trim().toLowerCase();
    for (const room of this.privateRooms.values()) {
      if (room.status !== "waiting") continue;
      const invite = email ? room.invites.find((candidate) => candidate.email === email) : undefined;
      if (room.creator.playerId !== connection.playerId && !invite && !this.roomParticipantIds(room).includes(connection.playerId)) continue;
      this.send(connection.playerId, { type: "private.room-status", room: this.privateRoomForRecipient(room, connection) });
      if (invite) this.send(connection.playerId, {
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
  }

  private broadcastPrivateRoom(room: PrivateRoom): void {
    const recipients = new Set(this.roomParticipantIds(room));
    for (const connection of this.connections.values()) {
      if (room.invites.some((invite) => invite.email === connection.email?.trim().toLowerCase())) {
        recipients.add(connection.playerId);
      }
    }
    for (const playerId of recipients) {
      const connection = this.connections.get(playerId);
      if (!connection) continue;
      this.send(playerId, {
        type: "private.room-status",
        room: this.privateRoomForRecipient(room, connection)
      });
      const email = connection.email?.trim().toLowerCase();
      const invite = room.invites.find((candidate) => candidate.playerId === playerId
        || Boolean(email && candidate.email === email));
      if (invite) this.send(playerId, {
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
  }

  private privateRoomForRecipient(room: PrivateRoom, connection: Connection): PrivateRoom {
    const email = connection.email?.trim().toLowerCase();
    const creator = room.creator.playerId === connection.playerId;
    return {
      ...room,
      invites: room.invites.map((invite) => {
        const current = Boolean(email && invite.email === email) || invite.playerId === connection.playerId;
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

  private tryStartPrivateRoomsFor(playerId: string): void {
    for (const room of this.privateRooms.values()) {
      if (room.status === "waiting" && this.roomParticipantIds(room).includes(playerId)) this.tryStartPrivateRoom(room.roomCode);
    }
  }

  private tryStartPrivateRoom(roomCode: string): void {
    const room = this.privateRooms.get(roomCode);
    if (!room || room.status !== "waiting" || room.acceptedCount !== room.requiredCount
      || room.invites.some((invite) => invite.status !== "accepted" || !invite.playerId)
      || this.privateStartAttempts.has(roomCode)) return;
    const participantIds = this.roomParticipantIds(room);
    if (participantIds.length !== room.playerCount || new Set(participantIds).size !== room.playerCount) return;
    const players = participantIds.map((id) => this.connections.get(id));
    if (players.some((connection) => !connection || connection.socket.readyState !== WebSocketRuntime.OPEN)) return;
    if (participantIds.some((id) => this.playerGames.has(id)
      || [...this.queues.values()].some((queue) => queue.includes(id)))) return;
    const connected = players as Connection[];
    const game = new RankingGame(connected.map(({ playerId: id, displayName, badgeId }) => ({
      id,
      displayName,
      badgeId: badgeId ?? "rookie"
    })));
    const started = game.snapshot();
    const event: ArchivedGameEvent = {
      game: started,
      matchType: "private",
      privateRoomCode: room.roomCode,
      eventType: "game.started",
      actorPlayerId: null,
      commandId: null,
      command: null,
      occurredAt: new Date()
    };
    const activate = () => {
      const latest = this.privateRooms.get(roomCode);
      if (!latest || latest.status !== "waiting") return;
      this.games.set(game.id, game);
      this.gameTypes.set(game.id, "private");
      this.privateRoomCodes.set(game.id, room.roomCode);
      for (const player of connected) this.playerGames.set(player.playerId, game.id);
      const activeRoom: PrivateRoom = { ...latest, status: "active", gameName: game.publicState().gameName };
      this.privateRooms.set(room.roomCode, activeRoom);
      this.broadcastPrivateRoom(activeRoom);
      for (const player of connected) this.sendStarted(player.playerId, game);
      if (!this.shuttingDown) this.armTimer(game);
      this.persist();
    };
    if (!this.archive) {
      activate();
      return;
    }
    const attempt = this.archive.startPrivateGame(event)
      .then(activate)
      .catch((error) => this.reportPersistenceError(error))
      .finally(() => {
        if (this.privateStartAttempts.get(roomCode) === attempt) this.privateStartAttempts.delete(roomCode);
      });
    this.privateStartAttempts.set(roomCode, attempt);
  }

  updateProfile(playerId: string, displayName: string, badgeId: ProfileBadgeId): void {
    const connection = this.connections.get(playerId);
    if (connection) {
      connection.displayName = displayName;
      connection.badgeId = badgeId;
    }
  }

  broadcastPostGameChat(
    participantPlayerIds: readonly string[],
    gameName: string,
    message: PostGameChatMessage
  ): void {
    const event: ServerMessage = { type: "chat.message", gameName, message };
    for (const playerId of new Set(participantPlayerIds)) this.send(playerId, event);
  }

  suspendPlayer(playerId: string): void {
    this.leaveQueue(playerId);
    const game = this.gameFor(playerId);
    if (game && game.publicState().phase === "playing") {
      this.applyGameCommand(playerId, {
        type: "game.drop",
        commandId: randomUUID(),
        gameId: game.id,
        expectedRevision: game.publicState().revision
      });
    }
    this.connections.get(playerId)?.socket.close(1008, "Account suspended");
  }

  disconnect(playerId: string, socket: GameplaySocket): void {
    const current = this.connections.get(playerId);
    if (current?.socket !== socket) return;
    this.connections.delete(playerId);
    if (this.shuttingDown) return;
    this.leaveQueue(playerId);
    const game = this.gameFor(playerId);
    if (game) {
      game.setConnected(playerId, false);
      this.broadcastState(game);
      this.persist();
    }
  }

  handle(playerId: string, message: ClientMessage): void {
    if (message.type === "ping") {
      this.send(playerId, { type: "pong", at: message.at });
      return;
    }
    if (message.type === "queue.join") {
      this.joinQueue(playerId, message.playerCount);
      return;
    }
    if (message.type === "queue.leave") {
      this.leaveQueue(playerId);
      return;
    }
    this.applyGameCommand(playerId, message);
  }

  /** Only the caller's own hand and public information leave this boundary. */
  agentView(playerId: string) {
    const game = this.gameFor(playerId);
    return game ? { playerId, state: game.publicState(), hand: game.handFor(playerId) } : null;
  }

  isPlayerAvailable(playerId: string): boolean {
    return this.connections.get(playerId)?.socket.readyState === WebSocketRuntime.OPEN && this.canEnterPrivateRoom(playerId);
  }

  /** Selected AI tables never enroll opponents in the public human queue. */
  startSelectedMatch(playerIds: readonly string[]): string {
    if ((playerIds.length !== 2 && playerIds.length !== 6) || new Set(playerIds).size !== playerIds.length) {
      throw new Error("Select distinct players for a two- or six-player table.");
    }
    if (playerIds.some((id) => !this.isPlayerAvailable(id))) {
      throw new Error("A selected player is busy, queued, or disconnected. Refresh and retry.");
    }
    return this.startMatch(playerIds.map((id) => this.connections.get(id)!)).id;
  }

  executeAgentCommand(playerId: string, command: GameCommand, notice?: AiForfeitNotice): GameResult | null {
    if (this.connections.get(playerId)?.actorKind !== "ai") throw new Error("An AI connection is required.");
    if (notice && command.type !== "game.drop") throw new Error("An AI forfeit notice requires a drop command.");
    return this.applyGameCommand(playerId, command, notice ? aiForfeitNoticeSchema.parse(notice) : undefined);
  }

  private startMatch(players: readonly Connection[]): RankingGame {
    const game = new RankingGame(players.map(({ playerId: id, displayName, badgeId, actorKind, aiModelId }) => ({
      id, displayName, badgeId: badgeId ?? "rookie",
      ...(actorKind ? { actorKind } : {}), ...(aiModelId ? { aiModelId } : {})
    })));
    this.games.set(game.id, game);
    this.gameTypes.set(game.id, "general");
    for (const player of players) this.playerGames.set(player.playerId, game.id);
    const started = game.snapshot();
    void this.archiveWork(game.id, (archive) => archive.recordEvent({
      game: started, matchType: "general", privateRoomCode: null, eventType: "game.started",
      actorPlayerId: null, commandId: null, command: null, occurredAt: new Date()
    }));
    for (const player of players) this.sendStarted(player.playerId, game);
    this.armTimer(game);
    this.persist();
    return game;
  }

  private joinQueue(playerId: string, playerCount: PlayerCount): void {
    if (this.playerGames.has(playerId)) {
      this.send(playerId, { type: "error", code: "ALREADY_IN_GAME", message: "You already have an active game." });
      return;
    }
    if (this.privateEntryReservations.has(playerId) || !this.canEnterPrivateRoom(playerId)) {
      this.send(playerId, { type: "error", code: "PRIVATE_ROOM_PENDING", message: "Finish or cancel your private room first." });
      return;
    }
    this.leaveQueue(playerId, false);
    const queue = this.queues.get(playerCount)!;
    if (!queue.includes(playerId)) queue.push(playerId);
    this.broadcastQueue(playerCount);
    this.createMatches(playerCount);
    this.persist();
  }

  private leaveQueue(playerId: string, notify = true): void {
    for (const [count, queue] of this.queues) {
      const next = queue.filter((queuedId) => queuedId !== playerId);
      if (next.length !== queue.length) {
        this.queues.set(count, next);
        if (notify) this.broadcastQueue(count);
        this.persist();
      }
    }
  }

  private createMatches(playerCount: PlayerCount): void {
    const queue = this.queues.get(playerCount)!;
    while (queue.length >= playerCount) {
      const candidateIds = queue.slice(0, playerCount);
      const players = candidateIds
        .map((id) => this.connections.get(id))
        .filter((connection): connection is Connection => Boolean(connection));
      if (players.length !== playerCount) break;
      queue.splice(0, playerCount);
      this.startMatch(players);
    }
    this.broadcastQueue(playerCount);
  }

  private applyGameCommand(playerId: string, command: GameCommand, aiFailure?: AiForfeitNotice): GameResult | null {
    const game = this.gameFor(playerId);
    if (!game) {
      this.send(playerId, { type: "error", code: "NO_ACTIVE_GAME", message: "Join a queue before playing." });
      return null;
    }
    const result = game.apply(playerId, command);
    if (!result.accepted) {
      this.send(playerId, {
        type: "command.rejected",
        commandId: result.commandId,
        code: result.code,
        message: result.message,
        revision: game.publicState().revision
      });
      return result;
    }
    const archived = game.snapshot();
    // Archive work is serialized and may not execute until after finishGame has
    // released the in-memory game. Capture classification while it is still
    // authoritative so a private game can never fall back to ranked/general.
    const matchType = this.gameTypes.get(game.id) ?? "general";
    const privateRoomCode = this.privateRoomCodes.get(game.id) ?? null;
    void this.archiveWork(game.id, (archive) => archive.recordEvent({
      game: archived,
      matchType,
      privateRoomCode,
      eventType: command.type,
      actorPlayerId: playerId,
      commandId: command.commandId,
      command,
      ...(aiFailure && result.left ? { aiFailure } : {}),
      occurredAt: new Date()
    }));
    this.broadcastHands(game);
    this.broadcastState(game);
    if (result.dropped) {
      this.broadcast(game, {
        type: "game.declaration-rejected",
        ...result.dropped,
        dropped: true
      });
    }
    if (result.left) {
      this.broadcast(game, {
        type: "game.player-dropped",
        playerId: result.left.playerId,
        playerName: result.left.playerName,
        ...(aiFailure ? { reasonCode: aiFailure.code, reason: aiFailure.message } : {})
      });
    }
    if (result.ended) {
      this.finishGame(game, archived, result.ended, result.left);
      return result;
    } else {
      this.armTimer(game);
    }
    if (result.left) {
      this.playerGames.delete(result.left.playerId);
      this.send(result.left.playerId, { type: "game.left", gameId: game.id, outcome: "dropped" });
    }
    this.persist();
    return result;
  }

  private sendStarted(playerId: string, game: RankingGame): void {
    this.send(playerId, {
      type: "game.started",
      ...game.publicState(),
      matchType: this.gameTypes.get(game.id) ?? "general",
      hand: game.handFor(playerId)
    });
  }

  private broadcastQueue(playerCount: PlayerCount): void {
    const queue = this.queues.get(playerCount)!;
    const status: ServerMessage = { type: "queue.status", playerCount, joined: queue.length, required: playerCount };
    for (const playerId of queue) this.send(playerId, status);
  }

  private broadcastHands(game: RankingGame): void {
    for (const player of game.publicState().players) {
      if (this.playerGames.get(player.id) === game.id) {
        this.send(player.id, { type: "game.hand", hand: game.handFor(player.id) });
      }
    }
  }

  private broadcastState(game: RankingGame): void {
    this.broadcast(game, {
      type: "game.state",
      ...game.publicState(),
      matchType: this.gameTypes.get(game.id) ?? "general"
    });
  }

  private broadcast(game: RankingGame, message: ServerMessage): void {
    for (const player of game.publicState().players) {
      if (this.playerGames.get(player.id) === game.id) this.send(player.id, message);
    }
  }

  private send(playerId: string, message: ServerMessage): void {
    const socket = this.connections.get(playerId)?.socket;
    if (socket?.readyState === WebSocketRuntime.OPEN) socket.send(JSON.stringify(message));
  }

  private gameFor(playerId: string): RankingGame | undefined {
    const gameId = this.playerGames.get(playerId);
    return gameId ? this.games.get(gameId) : undefined;
  }

  private finishGame(
    game: RankingGame,
    archived: RankingGameSnapshot,
    ended: NonNullable<Extract<GameResult, { accepted: true }>["ended"]>,
    left?: NonNullable<Extract<GameResult, { accepted: true }>["left"]>
  ): void {
    const endedAt = new Date();
    const matchType = this.gameTypes.get(game.id) ?? "general";
    const privateRoomCode = this.privateRoomCodes.get(game.id) ?? null;
    void this.archiveWork(game.id, (archive) => archive.completeGame({
      game: archived,
      matchType,
      privateRoomCode,
      winnerId: ended.winnerId,
      reason: ended.reason,
      endedAt
    }));
    if (privateRoomCode) {
      const privateRoom = this.privateRooms.get(privateRoomCode);
      if (privateRoom) {
        const completedRoom: PrivateRoom = { ...privateRoom, status: "completed" };
        this.privateRooms.set(privateRoomCode, completedRoom);
        this.broadcastPrivateRoom(completedRoom);
      }
    }
    this.broadcast(game, { type: "game.ended", ...ended });
    this.clearTimer(game.id);
    this.releaseGame(game);
    if (left) this.send(left.playerId, { type: "game.left", gameId: game.id, outcome: "dropped" });
    // A completed round is authoritative in memory as soon as the final
    // command or showdown deadline is accepted. Durable archival remains
    // ordered and retries in the background without holding clients or timers.
    this.persist();
  }

  private armTimer(game: RankingGame): void {
    this.clearTimer(game.id);
    const stateBeforeWait = game.publicState();
    if (stateBeforeWait.phase === "finished") return;
    const wait = Math.max(0, stateBeforeWait.turnEndsAt - Date.now());
    this.gameTimers.set(game.id, setTimeout(() => {
      const stateBeforeTimeout = game.publicState();
      const timedOutPlayerId = stateBeforeTimeout.currentPlayerId;
      const result = game.timeout();
      const archived = game.snapshot();
      const matchType = this.gameTypes.get(game.id) ?? "general";
      const privateRoomCode = this.privateRoomCodes.get(game.id) ?? null;
      void this.archiveWork(game.id, (archive) => archive.recordEvent({
        game: archived,
        matchType,
        privateRoomCode,
        eventType: stateBeforeTimeout.phase === "showdown" ? "game.showdown-timed-out" : "game.turn-timed-out",
        actorPlayerId: stateBeforeTimeout.phase === "showdown" ? null : timedOutPlayerId,
        commandId: null,
        command: null,
        occurredAt: new Date()
      }));
      this.broadcastHands(game);
      this.broadcastState(game);
      if (result?.accepted && result.ended) {
        this.finishGame(game, archived, result.ended, result.left);
        return;
      }
      this.persist();
      this.armTimer(game);
    }, Math.min(wait, turnDurationMs)));
  }

  private clearTimer(gameId: string): void {
    const timer = this.gameTimers.get(gameId);
    if (timer) clearTimeout(timer);
    this.gameTimers.delete(gameId);
  }

  private releaseGame(game: RankingGame): void {
    this.games.delete(game.id);
    this.gameTypes.delete(game.id);
    this.privateRoomCodes.delete(game.id);
    for (const player of game.publicState().players) this.playerGames.delete(player.id);
  }

  private persist(): void {
    const snapshot = {
      version: 2 as const,
      games: [...this.games.values()]
        .filter((game) => game.publicState().phase !== "finished")
        .map((game) => game.snapshot()),
      queues: {
        twoPlayer: [...this.queues.get(2)!],
        sixPlayer: [...this.queues.get(6)!]
      },
      gameTypes: Object.fromEntries(this.gameTypes),
      privateRoomCodes: Object.fromEntries(this.privateRoomCodes),
      privateRooms: [...this.privateRooms.values()].filter((room) => room.status === "waiting")
    };
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.store.set(savedStateKey, snapshot))
      .catch((error) => this.reportPersistenceError(error));
  }

  async flush(): Promise<void> {
    await Promise.all(this.privateStartAttempts.values());
    this.persist();
    await Promise.all([this.persistChain, ...this.archiveChains.values()]);
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const timer of this.gameTimers.values()) clearTimeout(timer);
    this.gameTimers.clear();
    for (const connection of this.connections.values()) connection.socket.close(1001, "Server shutting down");
  }
}
