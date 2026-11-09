import { createHash } from "node:crypto";
import type { ApplicationRepository } from "./db/repository";
import type { ArchivedGameEvent, GameArchive } from "./matchmaker";

function deterministicEventId(gameId: string, sequence: number): string {
  const bytes = Buffer.from(createHash("sha256").update(`${gameId}:${sequence}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const retryDelaysMs = [50, 150, 450, 1_350] as const;

async function retryTransient<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

export class PostgresGameArchive implements GameArchive {
  constructor(private readonly repository: ApplicationRepository) {}

  async startPrivateGame(event: ArchivedGameEvent): Promise<void> {
    if (event.matchType !== "private" || !event.privateRoomCode || event.eventType !== "game.started") {
      throw new Error("A private game start requires a private room and initial snapshot.");
    }
    await retryTransient(async () => {
      await this.repository.startPrivateMatch({
        roomCode: event.privateRoomCode!,
        id: event.game.id,
        publicName: event.game.publicName!,
        playerCount: event.game.playerCount,
        startedAt: event.occurredAt,
        participants: event.game.seats.map((seat, seatNumber) => ({
          userId: seat.id,
          seatNumber,
          displayName: seat.displayName,
          badgeId: seat.badgeId
        })),
        initialEvent: {
          eventId: deterministicEventId(event.game.id, event.game.revision),
          payload: { state: event.game }
        }
      });
    });
  }

  async recordEvent(event: ArchivedGameEvent): Promise<void> {
    if (event.matchType === "private" && event.eventType === "game.started") {
      await this.startPrivateGame(event);
      return;
    }
    await retryTransient(async () => {
      if (event.eventType === "game.started") {
        await this.repository.createMatch({
          id: event.game.id,
          publicName: event.game.publicName!,
          playerCount: event.game.playerCount,
          matchType: event.matchType ?? "general",
          startedAt: event.occurredAt,
          participants: event.game.seats.map((seat, seatNumber) => ({
            userId: seat.id,
            seatNumber,
            displayName: seat.displayName,
            badgeId: seat.badgeId
          }))
        });
      }
      await this.repository.appendGameEvents({
        matchId: event.game.id,
        expectedNextSequence: event.game.revision,
        events: [{
          eventId: deterministicEventId(event.game.id, event.game.revision),
          eventType: event.eventType,
          actorUserId: event.actorPlayerId,
          commandId: event.commandId,
          payload: {
            ...(event.command ? { command: event.command } : {}),
            state: event.game
          },
          occurredAt: event.occurredAt
        }]
      });
    });
  }

  async completeGame(input: Parameters<GameArchive["completeGame"]>[0]): Promise<void> {
    await retryTransient(async () => {
      const completion = {
        matchId: input.game.id,
        winnerUserId: input.winnerId,
        endReason: input.reason,
        endedAt: input.endedAt,
        participantOutcomes: input.game.seats.map((seat) => ({
          userId: seat.id,
          outcome: seat.id === input.winnerId ? "won" as const : seat.status === "dropped" ? "dropped" as const : "lost" as const
        }))
      };
      if (input.matchType === "private") {
        await this.repository.completePrivateMatch(completion);
        await this.repository.completePrivateRoom({ matchId: input.game.id, completedAt: input.endedAt });
      } else {
        await this.repository.completeMatchAndUpdateRatings(completion);
      }
    });
  }
}
