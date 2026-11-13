import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBroadcastRoutes } from "./broadcast-routes";
import { BroadcastService } from "./broadcast-service";
import type { BroadcastRepository, BroadcastDetail } from "./broadcast-repository";

const gameName = "amber-lotus-12345678";
const viewerId = randomUUID(); const participantId = randomUUID(); const adminId = randomUUID();
const access = { broadcastId: randomUUID(), matchId: randomUUID(), gameName, participantIds: [participantId], allAi: false, ended: false };
const detail: BroadcastDetail = { broadcast: { gameName, gameId: access.matchId, title: "Table", playerCount: 2, composition: "mixed", players: [],
  status: "buffering", delayMs: 120_000, availableAt: 120_000, viewerCount: 0 }, frame: null, comments: [] };

describe("authenticated delayed broadcast routes", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
  function fixture() {
    const app = Fastify(); apps.push(app);
    const repository = {
      enableForGame: vi.fn(async () => undefined), access: vi.fn(async () => access),
      directory: vi.fn<BroadcastRepository["directory"]>(async () => ({ broadcasts: [detail.broadcast], nextCursor: null })),
      detail: vi.fn(async () => detail), frame: vi.fn(async () => null), timeline: vi.fn(async () => ({ frames: [], nextCursor: null })),
      addComment: vi.fn(async () => ({ availableAt: 120_000, delayed: true })), deleteComment: vi.fn(async () => true),
      reportComment: vi.fn(async () => true), reports: vi.fn(async () => ({ reports: [], nextCursor: null })),
      resolveReport: vi.fn(async () => true), close: vi.fn(async () => access.broadcastId)
    };
    const session = vi.fn(async (request) => {
      const user = request.headers["x-user"];
      return user === "participant" ? { playerId: participantId } : user === "admin" ? { playerId: adminId } : user === "viewer" ? { playerId: viewerId } : null;
    });
    const onClosed = vi.fn(async () => undefined);
    const service = new BroadcastService(repository);
    registerBroadcastRoutes(app, { repository, service, resolveSession: session,
      resolveAdminAccess: async (request) => request.headers["x-user"] === "admin" && request.headers["x-unlocked"] === "yes",
      allowedOrigins: new Set(["https://trinitymatrix.org"]), onClosed });
    return { app, repository, session, onClosed, service };
  }

  it("rejects unauthenticated watch, frame, timeline, chat, stream and admin requests", async () => {
    const { app, repository } = fixture();
    for (const suffix of ["", "/timeline", "/frames/1", "/events"]) {
      expect((await app.inject({ url: `/api/live/${gameName}${suffix}` })).statusCode).toBe(401);
    }
    expect((await app.inject({ url: "/api/live" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/admin/live/reports" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/live/${gameName}/comments`, payload: {} })).statusCode).toBe(401);
    expect(repository.detail).not.toHaveBeenCalled();
  });

  it("rejects foreign origins before accessing any broadcast data", async () => {
    const { app, repository } = fixture();
    const response = await app.inject({ url: `/api/live/${gameName}/events`, headers: { "x-user": "viewer", origin: "https://other.example" } });
    expect(response.statusCode).toBe(403);
    expect(repository.access).not.toHaveBeenCalled();
  });

  it("bounds directory search and binds opaque cursors to the same filters", async () => {
    const { app, repository } = fixture();
    repository.directory.mockResolvedValueOnce({ broadcasts: [detail.broadcast], nextCursor: { createdAt: new Date().toISOString(), id: randomUUID() } });
    const headers = { "x-user": "viewer" };
    const first = await app.inject({ url: "/api/live?composition=mixed&status=live&q=Table&limit=1", headers });
    expect(first.statusCode).toBe(200);
    expect(repository.directory).toHaveBeenCalledWith({ composition: "mixed", status: "live", q: "Table", limit: 1 });
    const cursor = encodeURIComponent(first.json().nextCursor);
    expect((await app.inject({ url: `/api/live?composition=human&status=live&q=Table&cursor=${cursor}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/live?q=${"a".repeat(81)}`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/live?limit=51", headers })).statusCode).toBe(400);
  });

  it("keeps unavailable future frames absent and validates timeline boundaries", async () => {
    const { app, repository } = fixture(); const headers = { "x-user": "viewer" };
    expect((await app.inject({ url: `/api/live/${gameName}/frames/900`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/live/${gameName}/timeline?beforeSequence=-1`, headers })).statusCode).toBe(400);
    expect((await app.inject({ url: `/api/live/${gameName}/timeline?beforeSequence=9&limit=2`, headers })).statusCode).toBe(200);
    expect(repository.timeline).toHaveBeenCalledWith(gameName, 9, 2);
  });

  it("uses the authenticated comment author, requires idempotency IDs and caps body length", async () => {
    const { app, repository } = fixture(); const headers = { "x-user": "participant" }; const clientMessageId = randomUUID();
    const valid = await app.inject({ method: "POST", url: `/api/live/${gameName}/comments`, headers, payload: { message: "Hello", clientMessageId } });
    expect(valid.json()).toEqual({ availableAt: 120_000, delayed: true });
    expect(repository.addComment).toHaveBeenCalledWith(gameName, participantId, { message: "Hello", clientMessageId });
    for (const body of [{ message: "Hello" }, { message: "x".repeat(281), clientMessageId }, { message: "Hello", clientMessageId, playerId: viewerId }]) {
      expect((await app.inject({ method: "POST", url: `/api/live/${gameName}/comments`, headers, payload: body })).statusCode).toBe(400);
    }
  });

  it("limits moderation and immediate closure to participants or unlocked administrators", async () => {
    const { app, repository, onClosed } = fixture(); const commentId = randomUUID();
    for (const user of ["viewer", "admin"]) {
      expect((await app.inject({ method: "DELETE", url: `/api/live/${gameName}/comments/${commentId}`, headers: { "x-user": user } })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `/api/live/${gameName}/close`, headers: { "x-user": user } })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: "DELETE", url: `/api/live/${gameName}/comments/${commentId}`, headers: { "x-user": "participant" } })).statusCode).toBe(204);
    expect(repository.deleteComment).toHaveBeenCalledWith(gameName, commentId, participantId);
    expect((await app.inject({ method: "POST", url: `/api/live/${gameName}/close`, headers: { "x-user": "admin", "x-unlocked": "yes" } })).statusCode).toBe(204);
    expect(onClosed).toHaveBeenCalledWith(access.broadcastId);
  });

  it("requires unlocked administrator access to reports and resolves with the real actor", async () => {
    const { app, repository } = fixture();
    expect((await app.inject({ url: "/api/admin/live/reports", headers: { "x-user": "participant" } })).statusCode).toBe(403);
    const headers = { "x-user": "admin", "x-unlocked": "yes" };
    expect((await app.inject({ url: "/api/admin/live/reports", headers })).json()).toEqual({ reports: [], nextCursor: null });
    const id = randomUUID();
    expect((await app.inject({ method: "POST", url: `/api/admin/live/reports/${id}/resolve`, headers, payload: { removeComment: true } })).statusCode).toBe(204);
    expect(repository.resolveReport).toHaveBeenCalledWith(id, adminId, true);
  });

  it("uses bounded SSE payloads and ends the response on service closure", async () => {
    const { app, service } = fixture();
    const release = vi.fn();
    vi.spyOn(service, "subscribe").mockImplementation((_name, _userId, send) => {
      send({ type: "viewers", viewerCount: 1 });
      send({ type: "closed", reason: "Broadcast ended" });
      return release;
    });
    const response = await app.inject({ url: `/api/live/${gameName}/events`, headers: { "x-user": "viewer" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.body).toContain('event: viewers\ndata: {"viewerCount":1}');
    expect(response.body).toContain('event: closed\ndata: {"reason":"Broadcast ended"}');
    expect(release).toHaveBeenCalled();
  });

  it("fails closed and returns safe errors when session validation fails", async () => {
    const { app, session } = fixture();
    session.mockRejectedValue(new Error("secret credentials"));
    const response = await app.inject({ url: `/api/live/${gameName}`, headers: { "x-user": "viewer" } });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("secret");
  });

  it("closes an active spectator stream in preClose before waiting for HTTP shutdown", async () => {
    const { app, service } = fixture();
    await app.ready();
    let attached!: () => void;
    const subscribed = new Promise<void>((resolve) => { attached = resolve; });
    const original = service.subscribe.bind(service);
    vi.spyOn(service, "subscribe").mockImplementation((...args) => { const release = original(...args); attached(); return release; });
    const response = app.inject({ url: `/api/live/${gameName}/events`, headers: { "x-user": "viewer" } });
    void response.then(() => undefined);
    await subscribed;
    await app.close();
    expect((await response).body).toContain("broadcast service is restarting");
  }, 1_000);
});
