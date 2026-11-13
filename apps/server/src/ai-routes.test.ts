import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./auth";
import { registerAiPlayerRoutes, type AiPlayerRouteOptions } from "./ai-routes";

const humanId = "00000000-0000-4000-8000-000000000100";
const gameId = "00000000-0000-4000-8000-000000000200";
const agentIds = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
const adminHeaders = { "x-user": "admin", "x-admin-unlocked": "yes" };

function session(email: string): Session {
  return {
    id: "00000000-0000-4000-8000-000000000300",
    playerId: humanId,
    expiresAt: Date.now() + 60_000,
    profile: { id: humanId, email, displayName: "Asha", badgeId: "rookie", phone: null, createdAt: 1, updatedAt: 1 }
  };
}

const apps: Array<ReturnType<typeof Fastify>> = [];
async function build(overrides: Partial<AiPlayerRouteOptions> = {}, enforceRateLimits = false) {
  const app = Fastify({ logger: false });
  apps.push(app);
  if (enforceRateLimits) await app.register(rateLimit, { global: false });
  const roster = {
    enabled: true, dailyBudgetUsd: 10, players: [{ id: agentIds[0]!, displayName: "Agent One", modelId: "provider/model-one",
      modelName: "Model One", available: true, rating: 1000, gamesPlayed: 0, wins: 0 }]
  };
  const players = {
    roster: vi.fn(async () => roster),
    startMatch: vi.fn(async (_humanId: string | null, _agentIds: readonly string[]) => gameId)
  };
  const resolveAdminAccess = vi.fn(async (request: FastifyRequest) => request.headers["x-admin-unlocked"] === "yes");
  registerAiPlayerRoutes(app, {
    players,
    resolveSession: async (request) => request.headers["x-user"] === "admin"
      ? session(" ADMIN@EXAMPLE.COM ")
      : request.headers["x-user"] === "human" ? session("human@example.com") : null,
    resolveAdminAccess,
    adminEmails: new Set(["admin@example.com"]),
    isReady: () => true,
    dailyBudgetUsd: 10,
    ...overrides
  });
  return { app, players, roster, resolveAdminAccess };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("AI player routes", () => {
  it("requires a signed-in session for both the roster and every match launcher", async () => {
    const { app, players } = await build();
    for (const url of ["/api/ai/players", "/api/ai/matches", "/api/admin/ai/matches"]) {
      const response = await app.inject({ method: url.endsWith("players") ? "GET" : "POST", url,
        ...(url.endsWith("players") ? {} : { payload: { agentIds: [agentIds[0]] } }) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "Authentication required." });
    }
    expect(players.roster).not.toHaveBeenCalled();
    expect(players.startMatch).not.toHaveBeenCalled();
  });

  it("returns a disabled roster without model access and refuses to start games", async () => {
    const { app } = await build({ players: null });
    const roster = await app.inject({ method: "GET", url: "/api/ai/players", headers: { "x-user": "human" } });
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toEqual({ enabled: false, players: [], dailyBudgetUsd: 10 });
    const response = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload: { agentIds: [agentIds[0]] } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("not configured");
  });

  it("gates roster reads and game creation on service readiness", async () => {
    const { app, players } = await build({ isReady: () => false });
    const roster = await app.inject({ method: "GET", url: "/api/ai/players", headers: { "x-user": "human" } });
    const human = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload: { agentIds: [agentIds[0]] } });
    const ai = await app.inject({ method: "POST", url: "/api/admin/ai/matches", headers: adminHeaders, payload: { agentIds: agentIds.slice(0, 2) } });
    expect([roster.statusCode, human.statusCode, ai.statusCode]).toEqual([503, 503, 503]);
    expect(players.roster).not.toHaveBeenCalled();
    expect(players.startMatch).not.toHaveBeenCalled();
  });

  it("requires both the administrator allowlist and an unlocked passkey before AI-only creation", async () => {
    const { app, players, resolveAdminAccess } = await build();
    const outsider = await app.inject({ method: "POST", url: "/api/admin/ai/matches", headers: { "x-user": "human", "x-admin-unlocked": "yes" }, payload: {} });
    expect(outsider.statusCode).toBe(403);
    expect(resolveAdminAccess).not.toHaveBeenCalled();
    const locked = await app.inject({ method: "POST", url: "/api/admin/ai/matches", headers: { "x-user": "admin" }, payload: { agentIds: agentIds.slice(0, 2) } });
    expect(locked.statusCode).toBe(403);
    expect(locked.json().error).toContain("passkey");
    expect(players.startMatch).not.toHaveBeenCalled();
  });

  it("rejects invalid UUIDs, duplicate identities, wrong table sizes and extra fields before starting", async () => {
    const { app, players } = await build();
    const humanBodies = [
      {}, { agentIds: [] }, { agentIds: ["provider/model-one"] }, { agentIds: agentIds.slice(0, 2) }, { agentIds },
      { agentIds: Array(5).fill(agentIds[0]) }, { agentIds: [agentIds[0]], modelId: "different-model" }
    ];
    for (const payload of humanBodies) {
      const response = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload });
      expect(response.statusCode).toBe(400);
    }
    for (const ids of [[agentIds[0]], agentIds.slice(0, 5), [agentIds[0], agentIds[0]], []]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/ai/matches", headers: adminHeaders, payload: { agentIds: ids } });
      expect(response.statusCode).toBe(400);
    }
    expect(players.startMatch).not.toHaveBeenCalled();
  });

  it("returns the selected roster and scopes human matches to the authenticated player only", async () => {
    const { app, players, roster } = await build();
    const response = await app.inject({ method: "GET", url: "/api/ai/players", headers: { "x-user": "human" } });
    expect(response.json()).toEqual(roster);
    for (const ids of [agentIds.slice(0, 1), agentIds.slice(0, 5)]) {
      const match = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload: { agentIds: ids } });
      expect(match.statusCode).toBe(201);
      expect(match.json()).toEqual({ gameId });
      expect(players.startMatch).toHaveBeenLastCalledWith(humanId, ids);
    }
  });

  it("launches two- and six-seat AI-only matches without occupying the administrator's seat", async () => {
    const { app, players } = await build();
    for (const ids of [agentIds.slice(0, 2), agentIds]) {
      const match = await app.inject({ method: "POST", url: "/api/admin/ai/matches", headers: adminHeaders, payload: { agentIds: ids } });
      expect(match.statusCode).toBe(201);
      expect(match.json()).toEqual({ gameId });
      expect(players.startMatch).toHaveBeenLastCalledWith(null, ids);
    }
  });

  it("conceals internal and provider errors in both HTTP responses and route logs", async () => {
    const { app, players } = await build();
    const secret = "PRIVATE DATABASE AND PROVIDER PROMPT CONTENT";
    const warn = vi.spyOn(app.log, "warn");
    players.roster.mockRejectedValueOnce(new Error(secret));
    const roster = await app.inject({ method: "GET", url: "/api/ai/players", headers: { "x-user": "human" } });
    players.startMatch.mockRejectedValueOnce(new Error(secret));
    const match = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload: { agentIds: [agentIds[0]] } });
    expect(roster.statusCode).toBe(503);
    expect(match.statusCode).toBe(409);
    expect(match.json().error).toContain("Refresh AI players");
    expect(JSON.stringify([roster.json(), match.json(), warn.mock.calls])).not.toContain(secret);
  });

  it("fails closed if session or administrator access verification is unavailable", async () => {
    const unavailable = new Error("sensitive repository details");
    const { app: sessionApp } = await build({ resolveSession: async () => { throw unavailable; } });
    const sessionResponse = await sessionApp.inject({ method: "GET", url: "/api/ai/players" });
    expect(sessionResponse.statusCode).toBe(503);
    expect(sessionResponse.body).not.toContain(unavailable.message);
    const { app: adminApp, players } = await build({ resolveAdminAccess: async () => { throw unavailable; } });
    const response = await adminApp.inject({ method: "POST", url: "/api/admin/ai/matches", headers: adminHeaders, payload: { agentIds: agentIds.slice(0, 2) } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(unavailable.message);
    expect(players.startMatch).not.toHaveBeenCalled();
  });

  it("limits human match-launch requests to three per minute", async () => {
    const { app, players } = await build({}, true);
    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload: { agentIds: [agentIds[0]] } });
      expect(response.statusCode).toBe(201);
    }
    const rejected = await app.inject({ method: "POST", url: "/api/ai/matches", headers: { "x-user": "human" }, payload: { agentIds: [agentIds[0]] } });
    expect(rejected.statusCode).toBe(429);
    expect(players.startMatch).toHaveBeenCalledTimes(3);
  });
});
