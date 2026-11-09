import { randomInt, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  playerCountSchema,
  privateRoomCodeSchema,
  type PrivateInvitation,
  type PrivateRoom
} from "@trinitymatrix/protocol";
import type { Session } from "./auth";
import {
  RepositoryConflictError,
  RepositoryNotFoundError,
  type ApplicationRepository,
  type PrivateRoomRecord
} from "./db/repository";

export type PrivateMatchCoordinator = Readonly<{
  reservePrivateEntry(playerId: string, roomCode?: string): boolean | Promise<boolean>;
  releasePrivateEntry(playerId: string): void | Promise<void>;
  upsertPrivateRoom(room: PrivateRoom): void | Promise<void>;
  cancelPrivateRoom(room: PrivateRoom): void | Promise<void>;
}>;

const createRoomSchema = z.object({
  playerCount: playerCountSchema,
  inviteEmails: z.array(z.string().trim().email().max(254)).min(1).max(5)
}).strict().superRefine(({ playerCount, inviteEmails }, context) => {
  if (inviteEmails.length !== playerCount - 1) {
    context.addIssue({ code: "custom", message: "Invite exactly one email for every other player.", path: ["inviteEmails"] });
  }
  const normalized = inviteEmails.map((email) => email.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", message: "Invitation emails must be unique.", path: ["inviteEmails"] });
  }
});
const roomParamsSchema = z.object({ roomCode: privateRoomCodeSchema }).strict();

const adjectives = ["amber", "brisk", "calm", "clever", "coral", "golden", "lucky", "royal", "swift", "velvet"] as const;
const nouns = ["falcon", "forest", "lotus", "monsoon", "peacock", "river", "saffron", "summit", "tiger", "willow"] as const;

function createRoomCode(): string {
  const adjective = adjectives[randomInt(adjectives.length)]!;
  const noun = nouns[randomInt(nouns.length)]!;
  return `${adjective}-${noun}-${String(randomInt(1_000_000)).padStart(6, "0")}`;
}

function privateRoomProjection(
  room: PrivateRoomRecord,
  viewer: { playerId: string; email: string } | "coordinator" | "admin"
): PrivateRoom {
  const revealAll = viewer === "coordinator" || viewer === "admin" || viewer.playerId === room.creatorUserId;
  const viewerEmail = typeof viewer === "string" ? null : viewer.email.trim().toLowerCase();
  return {
    roomCode: room.roomCode,
    playerCount: room.playerCount,
    status: room.status,
    creator: { playerId: room.creatorUserId, displayName: room.creatorDisplayName },
    invites: room.invites.map((invite) => {
      const current = (typeof viewer !== "string" && invite.acceptedByUserId === viewer.playerId)
        || invite.email === viewerEmail;
      return {
        seatNumber: invite.seatNumber,
        status: invite.acceptedByUserId ? "accepted" as const : "pending" as const,
        ...(revealAll || current ? { email: invite.email } : {}),
        ...(current ? { isCurrentUser: true } : {}),
        ...(invite.acceptedByUserId ? { playerId: invite.acceptedByUserId } : {}),
        ...(invite.acceptedDisplayName ? { displayName: invite.acceptedDisplayName } : {})
      };
    }),
    acceptedCount: 1 + room.invites.filter(({ acceptedByUserId }) => acceptedByUserId).length,
    requiredCount: room.playerCount,
    createdAt: room.createdAt.toISOString(),
    ...(room.gameName ? { gameName: room.gameName } : {})
  };
}

export function coordinatorPrivateRoom(room: PrivateRoomRecord): PrivateRoom {
  return privateRoomProjection(room, "coordinator");
}

export function adminPrivateRoom(room: PrivateRoomRecord): PrivateRoom {
  return privateRoomProjection(room, "admin");
}

export function privateRoomForViewer(room: PrivateRoomRecord, session: Session): PrivateRoom {
  return privateRoomProjection(room, { playerId: session.playerId, email: session.profile.email });
}

function isAuthorized(room: PrivateRoomRecord, session: Session): boolean {
  const email = session.profile.email.trim().toLowerCase();
  return room.creatorUserId === session.playerId
    || room.invites.some((invite) => invite.email === email || invite.acceptedByUserId === session.playerId);
}

function invitationFor(room: PrivateRoomRecord, session: Session): PrivateInvitation | null {
  const invite = room.invites.find(({ email }) => email === session.profile.email.trim().toLowerCase());
  if (!invite || room.creatorUserId === session.playerId) return null;
  return {
    roomCode: room.roomCode,
    playerCount: room.playerCount,
    creatorDisplayName: room.creatorDisplayName,
    status: invite.acceptedByUserId ? "accepted" : "pending",
    createdAt: room.createdAt.toISOString()
  };
}

function sendRepositoryError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof RepositoryNotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof RepositoryConflictError) return reply.code(409).send({ error: error.message });
  request.log.error({ err: error }, "Private match request failed");
  return reply.code(500).send({ error: "The private match request could not be completed." });
}

export async function registerPrivateMatchRoutes(app: FastifyInstance, options: Readonly<{
  repository: ApplicationRepository;
  matchmaker: PrivateMatchCoordinator;
  resolveSession: (request: FastifyRequest) => Promise<Session | null>;
  resolveAdminAccess: (request: FastifyRequest) => Promise<boolean>;
  adminEmails: ReadonlySet<string>;
  now?: () => Date;
  createId?: () => string;
}>): Promise<void> {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    const session = await options.resolveSession(request);
    if (!session) await reply.code(401).send({ error: "Authentication required." });
    return session;
  };

  app.post("/api/private-matches", {
    config: { rateLimit: { max: 20, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const body = createRoomSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? "Check the invitation emails." });
    const inviteEmails = body.data.inviteEmails.map((email) => email.toLowerCase());
    if (inviteEmails.includes(session.profile.email.trim().toLowerCase())) {
      return reply.code(409).send({ error: "You cannot invite your own email address." });
    }
    if (!(await options.matchmaker.reservePrivateEntry(session.playerId))) {
      return reply.code(409).send({ error: "Leave your queue or finish your current game or private room first." });
    }
    try {
      const room = await options.repository.createPrivateRoom({
        id: createId(),
        roomCode: createRoomCode(),
        creatorUserId: session.playerId,
        playerCount: body.data.playerCount,
        inviteEmails,
        createdAt: now()
      });
      await options.matchmaker.upsertPrivateRoom(coordinatorPrivateRoom(room));
      return reply.code(201).send({ room: privateRoomForViewer(room, session) });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    } finally {
      await options.matchmaker.releasePrivateEntry(session.playerId);
    }
  });

  app.get("/api/private-matches", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    try {
      const rooms = await options.repository.listPrivateRoomsForUser({
        userId: session.playerId,
        email: session.profile.email
      });
      return reply.send({
        invitations: rooms.flatMap((room) => {
          const invitation = invitationFor(room, session);
          return invitation ? [invitation] : [];
        }),
        createdRooms: rooms.filter(({ creatorUserId }) => creatorUserId === session.playerId)
          .map((room) => privateRoomForViewer(room, session)),
        joinedRooms: rooms.filter((room) => room.creatorUserId !== session.playerId
          && room.invites.some(({ acceptedByUserId }) => acceptedByUserId === session.playerId))
          .map((room) => privateRoomForViewer(room, session))
      });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/private-matches/:roomCode", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "The private invitation was not found." });
    try {
      const room = await options.repository.getPrivateRoomByCode(params.data.roomCode);
      if (!room || !isAuthorized(room, session)) return reply.code(404).send({ error: "The private invitation was not found." });
      return reply.send({ room: privateRoomForViewer(room, session) });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.post("/api/private-matches/:roomCode/accept", {
    config: { rateLimit: { max: 30, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "The private invitation was not found." });
    if (!(await options.matchmaker.reservePrivateEntry(session.playerId, params.data.roomCode))) {
      return reply.code(409).send({ error: "Leave your queue or finish your current game or private room first." });
    }
    try {
      const room = await options.repository.acceptPrivateRoomInvitation({
        roomCode: params.data.roomCode,
        userId: session.playerId,
        email: session.profile.email,
        acceptedAt: now()
      });
      await options.matchmaker.upsertPrivateRoom(coordinatorPrivateRoom(room));
      return reply.send({ room: privateRoomForViewer(room, session) });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    } finally {
      await options.matchmaker.releasePrivateEntry(session.playerId);
    }
  });

  app.post("/api/private-matches/:roomCode/cancel", {
    config: { rateLimit: { max: 20, timeWindow: "10 minutes" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const params = roomParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "The waiting private room was not found." });
    try {
      const room = await options.repository.cancelPrivateRoom({
        roomCode: params.data.roomCode,
        creatorUserId: session.playerId,
        cancelledAt: now()
      });
      await options.matchmaker.cancelPrivateRoom(coordinatorPrivateRoom(room));
      return reply.code(204).send();
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });

  app.get("/api/admin/private-matches", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!options.adminEmails.has(session.profile.email.trim().toLowerCase()) || !(await options.resolveAdminAccess(request))) {
      return reply.code(403).send({ error: "Administrator access required." });
    }
    try {
      const rooms = await options.repository.listWaitingPrivateRooms();
      return reply.send({ waitingRooms: rooms.map(adminPrivateRoom) });
    } catch (error) {
      return sendRepositoryError(request, reply, error);
    }
  });
}
