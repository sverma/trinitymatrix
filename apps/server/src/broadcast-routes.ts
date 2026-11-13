import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { broadcastCommentBodySchema, publicGameNameSchema, type BroadcastEvent } from "@trinitymatrix/protocol";
import { BroadcastConflictError, type BroadcastAccess, type BroadcastRepository } from "./broadcast-repository";
import { BroadcastService } from "./broadcast-service";

type Session = { playerId: string };
export type BroadcastRoutesOptions = {
  repository: BroadcastRepository;
  resolveSession: (request: FastifyRequest) => Promise<Session | null>;
  resolveAdminAccess?: (request: FastifyRequest) => Promise<boolean>;
  canModerate?: (request: FastifyRequest, access: BroadcastAccess) => Promise<boolean>;
  allowedOrigins?: ReadonlySet<string>;
  isReady?: () => boolean;
  onClosed?: (broadcastId: string) => void | Promise<void>;
  service?: BroadcastService;
};
const paramsSchema = z.object({ name: publicGameNameSchema });
const pageCursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().uuid() }).strict();
const directorySchema = z.object({
  composition: z.enum(["all", "human", "ai", "mixed"]).default("all"), status: z.enum(["all", "live", "ended"]).default("all"),
  q: z.string().trim().max(80).optional(), cursor: z.string().max(1_024).optional(), limit: z.coerce.number().int().min(1).max(50).default(25)
}).strict();
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decode(value: string): unknown { try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; } }

export function registerBroadcastRoutes(app: FastifyInstance, options: BroadcastRoutesOptions): BroadcastService {
  const service = options.service ?? new BroadcastService(options.repository);
  app.addHook("preClose", async () => service.dispose());
  const resolve = async (request: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    const allowed = options.allowedOrigins ?? new Set([`${request.protocol}://${request.host}`]);
    if ((origin && !allowed.has(origin)) || request.headers["sec-fetch-site"] === "cross-site") {
      await reply.code(403).send({ error: "Origin not allowed." }); return null;
    }
    if (options.isReady && !options.isReady()) { await reply.code(503).send({ error: "The broadcast service is starting." }); return null; }
    try {
      const session = await options.resolveSession(request);
      if (!session) await reply.code(401).send({ error: "Authentication required." });
      return session;
    } catch { await reply.code(503).send({ error: "Authentication could not be verified." }); return null; }
  };
  const access = async (request: FastifyRequest, reply: FastifyReply, session: Session): Promise<BroadcastAccess | null> => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) { await reply.code(400).send({ error: "Invalid broadcast name." }); return null; }
    const result = await options.repository.access(parsed.data.name, session.playerId);
    if (!result) await reply.code(404).send({ error: "Broadcast not found." });
    return result;
  };
  const moderator = async (request: FastifyRequest, entry: BroadcastAccess, session: Session) =>
    entry.participantIds.includes(session.playerId) || await (options.canModerate?.(request, entry) ?? options.resolveAdminAccess?.(request) ?? Promise.resolve(false));
  const failure = (request: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (error instanceof BroadcastConflictError) return reply.code(409).send({ error: error.message });
    request.log.warn({ code: "BROADCAST_UNAVAILABLE" }, "Broadcast operation could not complete");
    return reply.code(503).send({ error: "The broadcast service is temporarily unavailable." });
  };
  const guard = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try { return await handler(request, reply); } catch (error) { return failure(request, reply, error); }
  };

  app.get("/api/live", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, guard(async (request, reply) => {
    if (!(await resolve(request, reply))) return;
    const query = directorySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid directory filters." });
    const { cursor: raw, ...filters } = query.data;
    const cursorSchema = pageCursorSchema.extend({ composition: directorySchema.shape.composition, status: directorySchema.shape.status, q: z.string().max(80) }).strict();
    const decoded = raw ? cursorSchema.safeParse(decode(raw)) : null;
    if (raw && (!decoded?.success || decoded.data.composition !== filters.composition || decoded.data.status !== filters.status || decoded.data.q !== (filters.q ?? ""))) {
      return reply.code(400).send({ error: "Invalid directory cursor." });
    }
    const result = await options.repository.directory({ ...filters, ...(decoded?.success ? { cursor: decoded.data } : {}) });
    return reply.send({ broadcasts: result.broadcasts.map((entry) => ({ ...entry, viewerCount: service.viewerCount(entry.gameName) })),
      nextCursor: result.nextCursor ? encode({ ...result.nextCursor, composition: filters.composition, status: filters.status, q: filters.q ?? "" }) : null, serverNow: Date.now() });
  }));

  app.get("/api/live/:name", guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    const result = await options.repository.detail(entry.gameName); if (!result) return reply.code(404).send({ error: "Broadcast not found." });
    return reply.send({ ...result, broadcast: { ...result.broadcast, viewerCount: service.viewerCount(entry.gameName) },
      serverNow: Date.now(), canModerate: await moderator(request, entry, session) });
  }));

  app.get("/api/live/:name/timeline", guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    const query = z.object({ beforeSequence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid timeline cursor." });
    return reply.send(await options.repository.timeline(entry.gameName, query.data.beforeSequence, query.data.limit));
  }));
  app.get("/api/live/:name/frames/:sequence", guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    const sequence = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).safeParse((request.params as { sequence: unknown }).sequence);
    if (!sequence.success) return reply.code(400).send({ error: "Invalid frame sequence." });
    const frame = await options.repository.frame(entry.gameName, sequence.data);
    return frame ? reply.send({ frame }) : reply.code(404).send({ error: "Frame is not available." });
  }));

  app.get("/api/live/:name/events", { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let unsubscribe: (() => void) | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const cleanup = () => { unsubscribe?.(); if (heartbeat) clearInterval(heartbeat); };
    const send = (event: BroadcastEvent): boolean => {
      if (reply.raw.destroyed || reply.raw.writableEnded || reply.raw.writableLength > 65_536) { cleanup(); reply.raw.destroy(); return false; }
      const { type, ...payload } = event;
      const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
      if (Buffer.byteLength(line) > 131_072) { reply.raw.destroy(); return false; }
      const accepted = reply.raw.write(line);
      if (type === "closed") { cleanup(); reply.raw.end(); return false; }
      if (!accepted) { cleanup(); reply.raw.destroy(); return false; }
      return true;
    };
    reply.raw.on("close", cleanup);
    try {
      unsubscribe = service.subscribe(entry.gameName, session.playerId, send, async () => {
        const current = await options.resolveSession(request);
        return current?.playerId === session.playerId && !!(await options.repository.access(entry.gameName, session.playerId));
      });
      if (reply.raw.destroyed || reply.raw.writableEnded) { cleanup(); return; }
      heartbeat = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) { cleanup(); return; }
        if (!reply.raw.write(": heartbeat\n\n")) { cleanup(); reply.raw.destroy(); }
      }, 15_000);
      heartbeat.unref();
    } catch { send({ type: "closed", reason: "Spectator connection limit reached. Please retry shortly." }); }
  }));

  app.post("/api/live/:name/comments", { bodyLimit: 4_096, config: { rateLimit: { max: 15, timeWindow: "1 minute" } } }, guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    const body = broadcastCommentBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a comment of at most 280 characters and a unique client message ID." });
    return reply.code(201).send(await options.repository.addComment(entry.gameName, session.playerId, body.data));
  }));
  app.delete("/api/live/:name/comments/:id", guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    if (!(await moderator(request, entry, session))) return reply.code(403).send({ error: "Broadcast moderator access required." });
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: "Invalid comment ID." });
    return await options.repository.deleteComment(entry.gameName, id.data, session.playerId) ? reply.code(204).send() : reply.code(404).send({ error: "Comment not found." });
  }));
  app.post("/api/live/:name/comments/:id/report", { bodyLimit: 4_096, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id);
    const body = z.object({ reason: z.preprocess((value) => typeof value === "string" && !value.trim() ? undefined : value,
      z.string().trim().min(1).max(500).default("Please review this comment.")) }).strict().safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.code(400).send({ error: "Invalid report." });
    return await options.repository.reportComment(entry.gameName, id.data, session.playerId, body.data.reason) ? reply.code(204).send() : reply.code(404).send({ error: "Comment not found." });
  }));
  app.post("/api/live/:name/close", guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    const entry = await access(request, reply, session); if (!entry) return;
    if (!(await moderator(request, entry, session))) return reply.code(403).send({ error: "Broadcast moderator access required." });
    const id = await options.repository.close(entry.gameName);
    service.close(entry.gameName);
    if (id && options.onClosed) {
      try { await options.onClosed(id); } catch { request.log.warn({ code: "BROADCAST_MEDIA_STOP_FAILED" }, "Closed broadcast media cleanup needs retry"); }
    }
    return reply.code(204).send();
  }));

  app.get("/api/admin/live/reports", guard(async (request, reply) => {
    if (!(await resolve(request, reply))) return;
    if (!(await options.resolveAdminAccess?.(request))) return reply.code(403).send({ error: "Administrator passkey access required." });
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(25), cursor: z.string().max(1_024).optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "Invalid report cursor." });
    const cursor = query.data.cursor ? pageCursorSchema.safeParse(decode(query.data.cursor)) : null;
    if (query.data.cursor && !cursor?.success) return reply.code(400).send({ error: "Invalid report cursor." });
    const result = await options.repository.reports(query.data.limit, cursor?.success ? cursor.data : undefined);
    return reply.send({ ...result, nextCursor: result.nextCursor ? encode(result.nextCursor) : null });
  }));
  app.post("/api/admin/live/reports/:id/resolve", { bodyLimit: 1_024 }, guard(async (request, reply) => {
    const session = await resolve(request, reply); if (!session) return;
    if (!(await options.resolveAdminAccess?.(request))) return reply.code(403).send({ error: "Administrator passkey access required." });
    const id = z.string().uuid().safeParse((request.params as { id: unknown }).id);
    const body = z.object({ removeComment: z.boolean() }).strict().safeParse(request.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: "Invalid report resolution." });
    return await options.repository.resolveReport(id.data, session.playerId, body.data.removeComment) ? reply.code(204).send() : reply.code(404).send({ error: "Report not found." });
  }));
  return service;
}
