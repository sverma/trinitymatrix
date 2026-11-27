import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./auth";
import { activitySessionHash, registerActivityRoutes, type ActivityRepository, type ActivityRoutesOptions } from "./activity-routes";
import { ActivityQueryError } from "./activity-repository";

const userId = "00000000-0000-4000-8000-000000000111";
const secretSession = "never-expose-this-bearer-session";
const session: Session = { id: secretSession, playerId: userId, expiresAt: Date.now() + 60_000,
  profile: { id: userId, email: "admin@example.test", displayName: "Activity admin", badgeId: "rookie", phone: null, createdAt: 1, updatedAt: 1 } };
const range = "from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z&actorKind=all";
const adminHeaders = { "x-user": "admin", "x-unlocked": "yes" };
const apps: Array<ReturnType<typeof Fastify>> = [];
async function build(overrides: Partial<ActivityRoutesOptions> = {}, limit = false) {
  const app = Fastify({ logger: false }); apps.push(app);
  if (limit) await app.register(rateLimit, { global: false });
  const repository = {
    ingest: vi.fn<ActivityRepository["ingest"]>(async () => undefined),
    overview: vi.fn<ActivityRepository["overview"]>(async () => ({ from: "", to: "", trackingSince: "", retentionDays: 90, generatedAt: "",
      summary: { signIns: 0, uniqueUsers: 0, activeUsers: 0, activeSeconds: 0, matches: 0, wins: 0, losses: 0, drops: 0, interactions: 0 }, daily: [], pages: [], actions: [] })),
    users: vi.fn<ActivityRepository["users"]>(async () => ({ items: [], nextCursor: null })),
    events: vi.fn<ActivityRepository["events"]>(async () => ({ items: [], nextCursor: null })),
    sessions: vi.fn<ActivityRepository["sessions"]>(async () => ({ items: [], nextCursor: null }))
  };
  const options: ActivityRoutesOptions = { repository,
    resolveSession: async (request) => !request.headers["x-user"] ? null : request.headers["x-user"] === "admin" ? session
      : { ...session, profile: { ...session.profile, email: "human@example.test" } },
    resolveAdminAccess: async (request: FastifyRequest) => request.headers["x-unlocked"] === "yes",
    adminEmails: new Set(["admin@example.test"]), allowedOrigins: new Set(["https://trinitymatrix.org"]), isReady: () => true, ...overrides };
  registerActivityRoutes(app, options);
  return { app, repository };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("Activity authentication, privacy and bounds", () => {
  it("requires the allowlist and unlocked passkey for every admin view", async () => {
    const { app, repository } = await build();
    for (const resource of ["overview", "users", "events", "sessions"]) {
      const url = `/api/admin/activity/${resource}?${range}`;
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { "x-user": "human", "x-unlocked": "yes" } })).statusCode).toBe(403);
      expect((await app.inject({ url, headers: { "x-user": "admin" } })).statusCode).toBe(403);
      const allowed = await app.inject({ url, headers: adminHeaders });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers["cache-control"]).toBe("no-store");
      expect(allowed.body).not.toContain(secretSession);
    }
    expect(repository.overview).toHaveBeenCalledTimes(1);
  });

  it("binds ingestion to the authenticated user and a server-derived non-bearer hash", async () => {
    const { app, repository } = await build();
    const event = { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: true, fresh: true };
    expect((await app.inject({ method: "POST", url: "/api/activity", payload: event })).statusCode).toBe(401);
    const accepted = await app.inject({ method: "POST", url: "/api/activity", headers: adminHeaders, payload: event });
    expect(accepted.statusCode).toBe(204);
    expect(repository.ingest).toHaveBeenCalledWith({ userId, sessionHash: activitySessionHash(secretSession), event, expiresAt: new Date(session.expiresAt) });
    expect(activitySessionHash(secretSession)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(repository.ingest.mock.calls)).not.toContain(secretSession);
  });

  it("rejects private payloads, invented outcomes/durations and unbounded bodies", async () => {
    const { app, repository } = await build();
    const base = { type: "interaction", eventId: randomUUID(), page: "table", action: "cards.sort" };
    for (const payload of [{ ...base, userId: randomUUID() }, { ...base, email: "secret@test.invalid" }, { ...base, cardId: "private-card" },
      { ...base, duration: 3600 }, { ...base, action: "won" }, { ...base, page: "/watch/private?token=secret" }, { ...base, raw: "x".repeat(5000) }]) {
      const response = await app.inject({ method: "POST", url: "/api/activity", headers: adminHeaders, payload });
      expect([400, 413]).toContain(response.statusCode);
    }
    expect(repository.ingest).not.toHaveBeenCalled();
  });

  it("denies cross-site requests and handles authentication failures without leaking errors", async () => {
    const { app, repository } = await build();
    for (const headers of [{ ...adminHeaders, origin: "https://evil.invalid" }, { ...adminHeaders, "sec-fetch-site": "cross-site" }]) {
      expect((await app.inject({ url: `/api/admin/activity/users?${range}`, headers })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/activity", headers, payload: {} })).statusCode).toBe(403);
    }
    expect(repository.users).not.toHaveBeenCalled();
    const broken = await build({ resolveSession: async () => { throw new Error("private token and raw database failure"); } });
    const response = await broken.app.inject({ url: `/api/admin/activity/users?${range}`, headers: adminHeaders });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private token");
  });

  it("bounds windows/pagination and binds filters to each repository call", async () => {
    const { app, repository } = await build();
    for (const query of ["from=bad&to=bad", "from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z", `${range}&limit=101`, `${range}&kind=secret`, `${range}&raw=secret`]) {
      expect((await app.inject({ url: `/api/admin/activity/events?${query}`, headers: adminHeaders })).statusCode).toBe(400);
    }
    const response = await app.inject({ url: `/api/admin/activity/events?${range}&kind=match&limit=20&q=Asha&userId=${userId}&cursor=opaque`, headers: adminHeaders });
    expect(response.statusCode).toBe(200);
    expect(repository.events).toHaveBeenCalledWith({ from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", actorKind: "all", q: "Asha", userId }, { kind: "match", limit: 20, cursor: "opaque" });
    repository.events.mockRejectedValueOnce(new ActivityQueryError("bad cursor"));
    expect((await app.inject({ url: `/api/admin/activity/events?${range}`, headers: adminHeaders })).statusCode).toBe(400);
  });

  it("keeps Redis-only play available and reports missing durable data only to authorized administrators", async () => {
    const { app } = await build({ repository: null });
    const response = await app.inject({ method: "POST", url: "/api/activity", headers: adminHeaders,
      payload: { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: false } });
    expect(response.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/admin/activity/overview?${range}` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/admin/activity/overview?${range}`, headers: adminHeaders })).statusCode).toBe(503);
  });

  it("gates writes on readiness and redacts storage failures", async () => {
    const starting = await build({ isReady: () => false });
    const event = { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: true };
    expect((await starting.app.inject({ method: "POST", url: "/api/activity", headers: adminHeaders, payload: event })).statusCode).toBe(503);
    expect(starting.repository.ingest).not.toHaveBeenCalled();
    const broken = await build(); broken.repository.ingest.mockRejectedValueOnce(new Error("database password=secret"));
    const response = await broken.app.inject({ method: "POST", url: "/api/activity", headers: adminHeaders, payload: event });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("password");
  });

  it("enforces the browser ingestion rate limit", async () => {
    const { app } = await build({}, true);
    let status = 0;
    for (let index = 0; index <= 180; index++) status = (await app.inject({ method: "POST", url: "/api/activity", headers: adminHeaders,
      payload: { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: false } })).statusCode;
    expect(status).toBe(429);
  });
});
