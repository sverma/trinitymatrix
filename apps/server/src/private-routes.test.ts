import Fastify, { type FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./auth";
import type { ApplicationRepository, PrivateRoomRecord } from "./db/repository";
import { Matchmaker } from "./matchmaker";
import { MemoryStateStore } from "./persistence";
import { registerPrivateMatchRoutes } from "./private-routes";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  send(value: string) { this.sent.push(value); }
  close() { this.readyState = 3; }
}

const creatorId = "11111111-1111-4111-8111-111111111111";
const inviteeId = "22222222-2222-4222-8222-222222222222";
const createdAt = new Date("2026-08-24T08:30:00.000Z");

function session(playerId: string, email: string, displayName: string): Session {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    playerId,
    expiresAt: Date.now() + 60_000,
    profile: {
      id: playerId,
      email,
      displayName,
      badgeId: "rookie",
      phone: null,
      createdAt: createdAt.getTime(),
      updatedAt: createdAt.getTime()
    }
  };
}

function room(overrides: Partial<PrivateRoomRecord> = {}): PrivateRoomRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    roomCode: "amber-lotus-123456",
    creatorUserId: creatorId,
    creatorDisplayName: "Asha",
    creatorEmail: "asha@example.com",
    playerCount: 2,
    status: "waiting",
    matchId: null,
    gameName: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    invites: [{
      email: "bela@example.com",
      seatNumber: 1,
      acceptedByUserId: null,
      acceptedDisplayName: null,
      acceptedAt: null
    }],
    ...overrides
  };
}

async function build(overrides: Partial<ApplicationRepository>) {
  const app = Fastify({ logger: false });
  const matchmaker = new Matchmaker(new MemoryStateStore());
  const repository = {
    listPrivateRoomsForUser: vi.fn(async () => []),
    listWaitingPrivateRooms: vi.fn(async () => []),
    getPrivateRoomByCode: vi.fn(async () => null),
    ...overrides
  } as unknown as ApplicationRepository;
  await registerPrivateMatchRoutes(app, {
    repository,
    matchmaker,
    resolveSession: async (request: FastifyRequest) => {
      if (request.headers["x-user"] === "creator") return session(creatorId, "asha@example.com", "Asha");
      if (request.headers["x-user"] === "invitee") return session(inviteeId, "bela@example.com", "Bela");
      if (request.headers["x-user"] === "outsider") {
        return session("44444444-4444-4444-8444-444444444444", "outsider@example.com", "Cora");
      }
      return null;
    },
    resolveAdminAccess: async () => false,
    adminEmails: new Set(),
    now: () => createdAt,
    createId: () => "33333333-3333-4333-8333-333333333333"
  });
  return { app, matchmaker, repository };
}

describe("private match routes", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("creates a room with normalized unique invitations and rejects self-invites", async () => {
    const createPrivateRoom = vi.fn(async (input) => room({
      playerCount: input.playerCount,
      invites: input.inviteEmails.map((email: string, index: number) => ({
        email,
        seatNumber: index + 1,
        acceptedByUserId: null,
        acceptedDisplayName: null,
        acceptedAt: null
      }))
    }));
    const { app, matchmaker } = await build({ createPrivateRoom });
    cleanups.push(async () => { matchmaker.shutdown(); await app.close(); });

    const created = await app.inject({
      method: "POST",
      url: "/api/private-matches",
      headers: { "x-user": "creator" },
      payload: { playerCount: 2, inviteEmails: [" Bela@Example.com "] }
    });
    const selfInvite = await app.inject({
      method: "POST",
      url: "/api/private-matches",
      headers: { "x-user": "creator" },
      payload: { playerCount: 2, inviteEmails: ["ASHA@example.com"] }
    });

    expect(created.statusCode).toBe(201);
    expect(createPrivateRoom).toHaveBeenCalledWith(expect.objectContaining({ inviteEmails: ["bela@example.com"] }));
    expect(created.json().room.roomCode).toMatch(/^[a-z]+-[a-z]+-\d{6}$/);
    expect(selfInvite.statusCode).toBe(409);
  });

  it("starts the existing game exactly once when the exact invitee accepts while both sockets are connected", async () => {
    const acceptedRoom = room({
      invites: [{
        email: "bela@example.com",
        seatNumber: 1,
        acceptedByUserId: inviteeId,
        acceptedDisplayName: "Bela",
        acceptedAt: createdAt
      }]
    });
    const acceptPrivateRoomInvitation = vi.fn(async () => acceptedRoom);
    const { app, matchmaker } = await build({ acceptPrivateRoomInvitation });
    cleanups.push(async () => { matchmaker.shutdown(); await app.close(); });
    const creatorSocket = new FakeSocket();
    const inviteeSocket = new FakeSocket();
    matchmaker.register({ playerId: creatorId, email: "asha@example.com", displayName: "Asha", socket: creatorSocket as unknown as WebSocket });
    matchmaker.register({ playerId: inviteeId, email: "bela@example.com", displayName: "Bela", socket: inviteeSocket as unknown as WebSocket });
    matchmaker.upsertPrivateRoom({
      roomCode: acceptedRoom.roomCode,
      playerCount: 2,
      status: "waiting",
      creator: { playerId: creatorId, displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "bela@example.com", status: "pending" }],
      acceptedCount: 1,
      requiredCount: 2,
      createdAt: createdAt.toISOString()
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/private-matches/${acceptedRoom.roomCode}/accept`,
      headers: { "x-user": "invitee" }
    });
    expect(response.statusCode).toBe(200);
    expect(acceptPrivateRoomInvitation).toHaveBeenCalledWith(expect.objectContaining({
      userId: inviteeId,
      email: "bela@example.com"
    }));
    const starts = (socket: FakeSocket) => socket.sent.map((value) => JSON.parse(value) as { type: string; matchType?: string })
      .filter(({ type }) => type === "game.started");
    expect(starts(creatorSocket)).toEqual([expect.objectContaining({ matchType: "private" })]);
    expect(starts(inviteeSocket)).toHaveLength(1);
  });

  it("returns the same 404 for an unknown code and a real room viewed by an outsider", async () => {
    const getPrivateRoomByCode = vi.fn(async () => room());
    const { app, matchmaker } = await build({ getPrivateRoomByCode });
    cleanups.push(async () => { matchmaker.shutdown(); await app.close(); });
    const response = await app.inject({
      method: "GET",
      url: "/api/private-matches/amber-lotus-123456",
      headers: { "x-user": "outsider" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "The private invitation was not found." });
  });
});
