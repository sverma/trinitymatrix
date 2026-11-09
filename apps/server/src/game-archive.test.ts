import { describe, expect, it, vi } from "vitest";
import type { ApplicationRepository } from "./db/repository";
import { PostgresGameArchive } from "./game-archive";
import { RankingGame } from "./game";

describe("PostgresGameArchive", () => {
  it("creates a match and records a complete initial replay snapshot", async () => {
    const game = new RankingGame([
      { id: "00000000-0000-4000-8000-000000000001", displayName: "Ayaan" },
      { id: "00000000-0000-4000-8000-000000000002", displayName: "Saurabh" }
    ], () => 0);
    const repository = {
      createMatch: vi.fn(async () => ({})),
      appendGameEvents: vi.fn(async () => []),
      completeMatchAndUpdateRatings: vi.fn(async () => ({}))
    } as unknown as ApplicationRepository;
    const archive = new PostgresGameArchive(repository);
    const occurredAt = new Date("2026-08-23T10:00:00.000Z");

    await archive.recordEvent({
      game: game.snapshot(),
      eventType: "game.started",
      actorPlayerId: null,
      commandId: null,
      command: null,
      occurredAt
    });

    expect(repository.createMatch).toHaveBeenCalledWith(expect.objectContaining({
      id: game.id,
      publicName: "amber-cobra-00000000",
      playerCount: 2
    }));
    expect(repository.appendGameEvents).toHaveBeenCalledWith(expect.objectContaining({
      matchId: game.id,
      expectedNextSequence: 1,
      events: [expect.objectContaining({ eventType: "game.started", occurredAt })]
    }));
  });

  it("derives winner, loser, and dropped outcomes from the final snapshot", async () => {
    const repository = {
      completeMatchAndUpdateRatings: vi.fn(async () => ({}))
    } as unknown as ApplicationRepository;
    const archive = new PostgresGameArchive(repository);
    const game = new RankingGame([
      { id: "00000000-0000-4000-8000-000000000001", displayName: "Ayaan" },
      { id: "00000000-0000-4000-8000-000000000002", displayName: "Saurabh" }
    ], () => 0);
    const snapshot = game.snapshot();
    snapshot.seats[1]!.status = "dropped";

    await archive.completeGame({
      game: snapshot,
      winnerId: snapshot.seats[0]!.id,
      reason: "player-dropped",
      endedAt: new Date("2026-08-23T10:05:00.000Z")
    });

    expect(repository.completeMatchAndUpdateRatings).toHaveBeenCalledWith(expect.objectContaining({
      participantOutcomes: [
        { userId: snapshot.seats[0]!.id, outcome: "won" },
        { userId: snapshot.seats[1]!.id, outcome: "dropped" }
      ]
    }));
  });

  it("archives private matches without changing public ratings and advances the room lifecycle", async () => {
    const repository = {
      startPrivateMatch: vi.fn(async () => ({})),
      completePrivateMatch: vi.fn(async () => ({})),
      completePrivateRoom: vi.fn(async () => undefined),
      completeMatchAndUpdateRatings: vi.fn(async () => ({}))
    } as unknown as ApplicationRepository;
    const archive = new PostgresGameArchive(repository);
    const game = new RankingGame([
      { id: "00000000-0000-4000-8000-000000000001", displayName: "Ayaan" },
      { id: "00000000-0000-4000-8000-000000000002", displayName: "Saurabh" }
    ], () => 0);
    const occurredAt = new Date("2026-08-24T08:30:00.000Z");
    await archive.recordEvent({
      game: game.snapshot(),
      matchType: "private",
      privateRoomCode: "amber-lotus-123456",
      eventType: "game.started",
      actorPlayerId: null,
      commandId: null,
      command: null,
      occurredAt
    });
    await archive.completeGame({
      game: game.snapshot(),
      matchType: "private",
      privateRoomCode: "amber-lotus-123456",
      winnerId: game.snapshot().seats[0]!.id,
      reason: "declaration",
      endedAt: new Date("2026-08-24T08:35:00.000Z")
    });

    expect(repository.startPrivateMatch).toHaveBeenCalledWith(expect.objectContaining({
      roomCode: "amber-lotus-123456",
      id: game.id,
      initialEvent: expect.objectContaining({ payload: { state: expect.any(Object) } })
    }));
    expect(repository.completePrivateMatch).toHaveBeenCalledOnce();
    expect(repository.completePrivateRoom).toHaveBeenCalledWith(expect.objectContaining({ matchId: game.id }));
    expect(repository.completeMatchAndUpdateRatings).not.toHaveBeenCalled();
  });
});
