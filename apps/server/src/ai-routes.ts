import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Session } from "./auth";
import type { AiPlayers } from "./ai-players";

export type AiPlayerRouteOptions = Readonly<{
  players: Pick<AiPlayers, "roster" | "startMatch"> | null;
  resolveSession: (request: FastifyRequest) => Promise<Session | null>;
  resolveAdminAccess: (request: FastifyRequest) => Promise<boolean>;
  adminEmails: ReadonlySet<string>;
  isReady: () => boolean;
  dailyBudgetUsd: number;
}>;

function selectionSchema(sizes: readonly number[]) {
  return z.object({
    agentIds: z.array(z.string().uuid().transform((value) => value.toLowerCase())).min(1).max(6)
  }).strict().superRefine(({ agentIds }, context) => {
    if (!sizes.includes(agentIds.length) || new Set(agentIds).size !== agentIds.length) {
      context.addIssue({ code: "custom", path: ["agentIds"], message: "Choose distinct AI players to fill the table." });
    }
  });
}

const humanSelection = selectionSchema([1, 5]);
const aiSelection = selectionSchema([2, 6]);

/** Authentication, readiness and rate limits also apply when model access is disabled. */
export function registerAiPlayerRoutes(app: FastifyInstance, options: AiPlayerRouteOptions): void {
  const resolve = async (request: FastifyRequest, reply: FastifyReply): Promise<Session | null> => {
    try {
      const session = await options.resolveSession(request);
      if (!session) await reply.code(401).send({ error: "Authentication required." });
      return session;
    } catch {
      request.log.warn({ code: "AI_SESSION_UNAVAILABLE" }, "AI request could not resolve its session");
      await reply.code(503).send({ error: "The game service is temporarily unavailable." });
      return null;
    }
  };

  const ready = (reply: FastifyReply): boolean => {
    if (options.isReady()) return true;
    void reply.code(503).send({ error: "The game service is starting. Please retry shortly." });
    return false;
  };

  app.get("/api/ai/players", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!(await resolve(request, reply))) return;
    if (!ready(reply)) return;
    if (!options.players) return reply.send({ enabled: false, players: [], dailyBudgetUsd: options.dailyBudgetUsd });
    try {
      return reply.send(await options.players.roster());
    } catch {
      request.log.warn({ code: "AI_ROSTER_UNAVAILABLE" }, "AI roster could not be loaded");
      return reply.code(503).send({ error: "AI players are temporarily unavailable. Please retry shortly." });
    }
  });

  const start = async (request: FastifyRequest, reply: FastifyReply, admin: boolean) => {
    const session = await resolve(request, reply);
    if (!session) return;
    if (admin) {
      if (!options.adminEmails.has(session.profile.email.trim().toLowerCase())) {
        return reply.code(403).send({ error: "Administrator access required." });
      }
      try {
        if (!(await options.resolveAdminAccess(request))) {
          return reply.code(403).send({ error: "Administrator passkey access required." });
        }
      } catch {
        request.log.warn({ code: "AI_ADMIN_ACCESS_UNAVAILABLE" }, "AI match could not verify administrator access");
        return reply.code(503).send({ error: "Administrator access could not be verified. Please retry." });
      }
    }
    const body = (admin ? aiSelection : humanSelection).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: admin
      ? "Choose exactly two or six distinct AI player IDs."
      : "Choose exactly one or five distinct AI player IDs." });
    if (!ready(reply)) return;
    if (!options.players) return reply.code(503).send({ error: "AI players are not configured for this deployment." });
    try {
      const gameId = await options.players.startMatch(admin ? null : session.playerId, body.data.agentIds);
      return reply.code(201).send({ gameId });
    } catch {
      // Raw errors can contain provider payloads, credentials or database details.
      request.log.warn({ code: "AI_MATCH_UNAVAILABLE" }, "AI match could not be started");
      return reply.code(409).send({ error: "A selected AI player is busy or the AI budget is unavailable. Refresh AI players and try again." });
    }
  };

  app.post("/api/ai/matches", {
    bodyLimit: 4_096,
    config: { rateLimit: { max: 3, timeWindow: "1 minute" } }
  }, (request, reply) => start(request, reply, false));

  app.post("/api/admin/ai/matches", {
    bodyLimit: 4_096,
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, (request, reply) => start(request, reply, true));
}
