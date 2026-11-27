import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { activityFiltersSchema, activityIngestSchema, type ActivityFilters } from "@trinitymatrix/protocol";
import type { Session } from "./auth";
import { isAiPlayerEmail } from "./auth";
import { ActivityQueryError, type PostgresActivityRepository } from "./activity-repository";

export type ActivityRepository = Pick<PostgresActivityRepository, "ingest" | "overview" | "users" | "events" | "sessions">;
export type ActivityRoutesOptions = {
  repository: ActivityRepository | null;
  resolveSession: (request: FastifyRequest) => Promise<Session | null>;
  resolveAdminAccess: (request: FastifyRequest) => Promise<boolean>;
  adminEmails: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
  isReady: () => boolean;
};

/** The bearer session value is never persisted in analytics or returned to an administrator. */
export function activitySessionHash(sessionId: string): string {
  return createHash("sha256").update(`trinitymatrix:activity-session:v1:${sessionId}`).digest("hex");
}

const listSchema = z.object({
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});
const querySchema = activityFiltersSchema.safeExtend({
  cursor: listSchema.shape.cursor, limit: listSchema.shape.limit,
  kind: z.enum(["all", "auth", "match", "interaction"]).default("all")
});

export function registerActivityRoutes(app: FastifyInstance, options: ActivityRoutesOptions): void {
  const sessionFor = async (request: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if ((origin && !options.allowedOrigins.has(origin)) || request.headers["sec-fetch-site"] === "cross-site") {
      await reply.code(403).send({ error: "Origin not allowed." }); return null;
    }
    try {
      const session = await options.resolveSession(request);
      if (!session) await reply.code(401).send({ error: "Authentication required." });
      return session;
    } catch {
      request.log.warn({ code: "ACTIVITY_SESSION_UNAVAILABLE" }, "Activity authentication unavailable");
      await reply.code(503).send({ error: "Authentication could not be verified." }); return null;
    }
  };
  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    const session = await sessionFor(request, reply);
    if (!session) return null;
    if (!options.adminEmails.has(session.profile.email.trim().toLowerCase())) {
      await reply.code(403).send({ error: "Administrator access required." }); return null;
    }
    try {
      if (!(await options.resolveAdminAccess(request))) {
        await reply.code(403).send({ error: "Administrator passkey access required." }); return null;
      }
    } catch {
      await reply.code(503).send({ error: "Administrator access could not be verified." }); return null;
    }
    return session;
  };
  const ready = (reply: FastifyReply) => {
    if (options.isReady()) return true;
    void reply.code(503).send({ error: "The activity service is starting. Please retry shortly." }); return false;
  };

  app.post("/api/activity", {
    bodyLimit: 4_096,
    config: { rateLimit: { max: 180, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const session = await sessionFor(request, reply);
    if (!session) return;
    if (isAiPlayerEmail(session.profile.email)) return reply.code(403).send({ error: "Human session required." });
    const event = activityIngestSchema.safeParse(request.body);
    if (!event.success) return reply.code(400).send({ error: "Invalid activity event." });
    if (!ready(reply)) return;
    // Redis-only development installations can play normally without collecting analytics.
    if (!options.repository) return reply.code(204).send();
    try {
      await options.repository.ingest({ userId: session.playerId, sessionHash: activitySessionHash(session.id),
        event: event.data, expiresAt: new Date(session.expiresAt) });
      return reply.code(204).send();
    } catch {
      request.log.warn({ code: "ACTIVITY_INGEST_UNAVAILABLE" }, "Activity event could not be recorded");
      return reply.code(503).send({ error: "Activity tracking is temporarily unavailable." });
    }
  });

  for (const resource of ["overview", "users", "events", "sessions"] as const) {
    app.get(`/api/admin/activity/${resource}`, {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      if (!(await requireAdmin(request, reply))) return;
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "Choose a valid activity window of up to 90 days and supported filters." });
      if (!ready(reply)) return;
      if (!options.repository) return reply.code(503).send({ error: "Activity requires durable data storage." });
      const { cursor, limit, kind, ...filters } = parsed.data;
      try {
        const window = filters as ActivityFilters;
        if (resource === "overview") return reply.send(await options.repository.overview(window));
        if (resource === "users") return reply.send(await options.repository.users(window, { limit, ...(cursor ? { cursor } : {}) }));
        if (resource === "sessions") return reply.send(await options.repository.sessions(window, { limit, ...(cursor ? { cursor } : {}) }));
        return reply.send(await options.repository.events(window, { limit, kind, ...(cursor ? { cursor } : {}) }));
      } catch (error) {
        if (error instanceof ActivityQueryError || error instanceof z.ZodError) {
          return reply.code(400).send({ error: "The activity cursor or filters are no longer valid. Refresh this view." });
        }
        request.log.warn({ code: "ACTIVITY_READ_UNAVAILABLE" }, "Activity dashboard could not be loaded");
        return reply.code(503).send({ error: "Activity is temporarily unavailable. Please retry." });
      }
    });
  }
}
