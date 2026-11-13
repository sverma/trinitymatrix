import { randomUUID } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerBroadcastMediaRoutes, type BroadcastMediaOptions } from "./broadcast-media-routes";
import type { BroadcastAccess } from "./broadcast-repository";

const ownerId = randomUUID(); const adminId = randomUUID(); const outsiderId = randomUUID();
const videoId = randomUUID(); const broadcastId = randomUUID(); const gameName = "amber-lotus-12345678";
const origin = "https://trinitymatrix.org";
const secret = "synthetic-test-media-secret-no-production-value";
const playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2.000000,\nsegments/segment-000001.ts\n";
type Video = { id: string; broadcast_id: string; publisher_id: string; status: "starting" | "live" | "stopped" | "interrupted";
  created_at: Date; last_seen_at: Date; ended_at: Date | null; display_name: string };

class VideoLedger {
  rows = new Map<string, Video>();
  release = vi.fn();
  query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (sql.includes("count(*)::text AS total")) {
      const active = [...this.rows.values()].filter(({ status }) => status === "starting" || status === "live");
      return { rows: [{ total: String(active.length), matching: String(active.filter((row) => row.broadcast_id === values[0]).length) }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO live_broadcast_video_sessions")) {
      this.add({ id: String(values[0]), broadcast_id: String(values[1]), publisher_id: String(values[2]), status: "starting" });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT v.*")) return { rows: [...this.rows.values()].filter((row) => row.broadcast_id === values[0] && (!values[1] || row.id === values[1])), rowCount: 1 };
    if (sql.startsWith("SELECT id FROM")) return { rows: [...this.rows.values()].filter((row) => row.broadcast_id === values[0] && ["starting", "live"].includes(row.status)).map(({ id }) => ({ id })), rowCount: 1 };
    if (sql.startsWith("UPDATE live_broadcast_video_sessions")) {
      let count = 0;
      for (const row of this.rows.values()) {
        if (sql.includes("last_seen_at<")) {
          if (!["starting", "live"].includes(row.status) || +row.last_seen_at >= Date.now() - 45_000) continue;
        } else if (row.id !== values[0]) continue;
        if (sql.includes("AND status IN") && !["starting", "live"].includes(row.status)) continue;
        row.status = sql.includes("status='interrupted'") ? "interrupted" : sql.includes("status='stopped'") ? "stopped" : "live";
        if (row.status === "live") row.last_seen_at = new Date(); else row.ended_at ??= new Date();
        count += 1;
      }
      return { rows: [], rowCount: count };
    }
    throw new Error("Unexpected video ledger query in fixture.");
  });
  add(overrides: Partial<Video> = {}) {
    const row: Video = { id: videoId, broadcast_id: broadcastId, publisher_id: ownerId, status: "live", created_at: new Date(Date.now() - 180_000),
      last_seen_at: new Date(), ended_at: null, display_name: "Publisher", ...overrides };
    this.rows.set(row.id, row); return row;
  }
  pool(): Pool { return { query: this.query, connect: async () => ({ query: this.query, release: this.release }) } as unknown as Pool; }
}

describe("authenticated broadcast video gateway", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); vi.useRealTimers(); });
  function fixture(overrides: Partial<BroadcastMediaOptions> = {}) {
    const app = Fastify(); apps.push(app); const ledger = new VideoLedger();
    const access: BroadcastAccess = { broadcastId, matchId: randomUUID(), gameName, participantIds: [ownerId], allAi: false, ended: false };
    const repository = { access: vi.fn(async () => access as BroadcastAccess | null) };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/streams" && init?.method === "POST") return Response.json({ id: JSON.parse(String(init.body)).id, availableAt: Date.now() + 120_000 }, { status: 201 });
      if (path.endsWith("/stop")) return Response.json({ stopped: true });
      if (path.endsWith("/chunks")) return Response.json({ accepted: true }, { status: 202 });
      if (path.endsWith("index.m3u8")) return new Response(playlist);
      if (path.endsWith(".ts")) return new Response(new Uint8Array([0x47, 1, 2, 3]));
      return Response.json({ id: path.split("/").at(-1), status: "live", availableAt: Date.now() - 1, ingestActive: true });
    });
    const resolveSession = vi.fn(async (request: FastifyRequest) => typeof request.headers["x-user"] === "string" ? { playerId: request.headers["x-user"] } : null);
    const api = registerBroadcastMediaRoutes(app, { pool: ledger.pool(), repository, resolveSession,
      resolveAdminAccess: async (request) => request.headers["x-user"] === adminId && request.headers["x-unlocked"] === "yes",
      allowedOrigins: new Set([origin]), isReady: () => true, enabled: true, mediaUrl: "http://private-media:8082", mediaSecret: secret,
      maximumStreams: 1, fetch: fetcher, ...overrides });
    return { app, ledger, access, repository, fetcher, resolveSession, api };
  }
  const headers = (id = outsiderId) => ({ "x-user": id, origin });
  const path = (suffix = "") => `/api/live/${gameName}/video${suffix}`;

  it("requires current authentication and a permitted origin for status, publishing and HLS", async () => {
    const { app, repository, fetcher } = fixture();
    for (const request of [{ url: path() }, { method: "POST" as const, url: path("/start") }, { url: path(`/${videoId}/index.m3u8`) }]) {
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect((await app.inject({ url: path(), headers: { ...headers(), origin: "https://untrusted.example" } })).statusCode).toBe(403);
    expect((await app.inject({ url: path(), headers: { ...headers(), "sec-fetch-site": "cross-site" } })).statusCode).toBe(403);
    expect(repository.access).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects missing/closed broadcasts before consulting the media worker", async () => {
    const { app, repository, fetcher } = fixture(); repository.access.mockResolvedValue(null);
    expect((await app.inject({ url: path(), headers: headers() })).statusCode).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("admits seated humans and only unlocked administrators for AI-only publishing", async () => {
    const { app, ledger, access } = fixture();
    expect((await app.inject({ method: "POST", url: path("/start"), headers: headers() })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: path("/start"), headers: { ...headers(adminId), "x-unlocked": "yes" } })).statusCode).toBe(403);
    access.allAi = true; access.participantIds = [randomUUID(), randomUUID()];
    expect((await app.inject({ method: "POST", url: path("/start"), headers: headers(adminId) })).statusCode).toBe(403);
    const started = await app.inject({ method: "POST", url: path("/start"), headers: { ...headers(adminId), "x-unlocked": "yes" } });
    expect(started.statusCode).toBe(201); expect(ledger.rows.get(started.json().id)?.publisher_id).toBe(adminId);
    expect(started.body).not.toContain(secret); expect(started.body).not.toContain("private-media");
  });

  it("reserves one publisher under the transaction lock and forwards only server-owned worker credentials", async () => {
    const { app, ledger, fetcher } = fixture();
    const started = await app.inject({ method: "POST", url: path("/start"), headers: headers(ownerId) });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ id: expect.any(String), uploadUrl: expect.stringMatching(/^\/api\/live\//), stopUrl: expect.stringMatching(/^\/api\/live\//), limits: { width: 854, height: 480, frameRate: 15, maxDurationSeconds: 7_200 } });
    const call = fetcher.mock.calls.find(([url]) => new URL(String(url)).pathname === "/streams")!;
    expect(call[1]).toMatchObject({ method: "POST", redirect: "error", headers: { "X-Trinity-Media-Key": secret } });
    expect(JSON.parse(String(call[1]!.body))).toEqual({ id: started.json().id, delayMs: 120_000 });
    expect(ledger.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect((await app.inject({ method: "POST", url: path("/start"), headers: headers(ownerId) })).statusCode).toBe(409);
    expect(fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/streams")).toHaveLength(1);
  });

  it("enforces the global slot cap across broadcasts and expires stale publisher reservations", async () => {
    const { app, ledger } = fixture(); const old = ledger.add({ broadcast_id: randomUUID() });
    expect((await app.inject({ method: "POST", url: path("/start"), headers: headers(ownerId) })).statusCode).toBe(409);
    old.last_seen_at = new Date(Date.now() - 46_000);
    expect((await app.inject({ method: "POST", url: path("/start"), headers: headers(ownerId) })).statusCode).toBe(201);
    expect(old.status).toBe("interrupted");
  });

  it("accepts bounded binary chunks only from the exact publisher and preserves sequence", async () => {
    const { app, ledger, fetcher } = fixture(); ledger.add();
    const binary = { "content-type": "application/octet-stream" };
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/chunks?sequence=7`), headers: { ...headers(), ...binary }, payload: Buffer.from([1]) })).statusCode).toBe(403);
    const payload = Buffer.from([1, 2, 3]);
    const uploaded = await app.inject({ method: "POST", url: path(`/${videoId}/chunks?sequence=7`), headers: { ...headers(ownerId), ...binary }, payload });
    expect(uploaded.statusCode).toBe(202);
    const [url, init] = fetcher.mock.calls.at(-1)!;
    expect(String(url)).toContain("/chunks?sequence=7"); expect(new Uint8Array(init!.body as ArrayBuffer)).toEqual(new Uint8Array(payload));
    for (const suffix of ["?sequence=-1", "?sequence=1.5", ""]) {
      expect((await app.inject({ method: "POST", url: path(`/${videoId}/chunks${suffix}`), headers: { ...headers(ownerId), ...binary }, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/chunks?sequence=8`), headers: { ...headers(ownerId), ...binary }, payload: Buffer.alloc(524_289) })).statusCode).toBe(413);
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/chunks?sequence=8`), headers: headers(ownerId), payload: { arbitrary: "json" } })).statusCode).toBe(400);
  });

  it("stops ingest after match completion and allows only the owner or unlocked admin to stop", async () => {
    const { app, ledger, access } = fixture(); const row = ledger.add();
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/stop`), headers: headers() })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/stop`), headers: headers(adminId) })).statusCode).toBe(403);
    access.ended = true;
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/chunks?sequence=1`), headers: { ...headers(ownerId), "content-type": "application/octet-stream" }, payload: Buffer.from([1]) })).statusCode).toBe(409);
    expect(row.status).toBe("stopped");
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/stop`), headers: { ...headers(adminId), "x-unlocked": "yes" } })).statusCode).toBe(200);
  });

  it("serves only authenticated relative delayed playlists and tightly validated binary segments", async () => {
    const { app, ledger, fetcher } = fixture(); ledger.add();
    const manifest = await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers() });
    expect(manifest.statusCode).toBe(200); expect(manifest.body).toBe(playlist);
    expect(manifest.headers["cache-control"]).toBe("no-store"); expect(manifest.headers["content-type"]).toContain("application/vnd.apple.mpegurl");
    const segment = await app.inject({ url: path(`/${videoId}/segments/segment-000001.ts`), headers: headers() });
    expect(segment.rawPayload).toEqual(Buffer.from([0x47, 1, 2, 3])); expect(segment.headers["content-type"]).toContain("video/mp2t");
    const requests = fetcher.mock.calls.length;
    for (const file of ["arbitrary.ts", "segment-000001.ts%3Ftoken=secret", "..%2Fsegment-000001.ts"]) {
      expect((await app.inject({ url: path(`/${videoId}/segments/${file}`), headers: headers() })).statusCode).toBe(400);
    }
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it.each([
    '#EXT-X-KEY:METHOD=AES-128,URI="https://external/key"', '#EXT-X-MAP:URI="internal/unreleased"',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="https://external/audio"', '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="segments/segment-000099.ts"',
    '#EXT-X-SESSION-DATA:DATA-ID="x",URI="https://external/data"', 'https://external/video.ts', '//external/video.ts', '../source.m3u8'
  ])("rejects URI-bearing tags or paths: %s", async (line) => {
    const { app, ledger, fetcher } = fixture(); ledger.add(); fetcher.mockResolvedValueOnce(new Response(`#EXTM3U\n${line}\n`));
    const result = await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers() });
    expect(result.statusCode).toBe(502); expect(result.body).not.toContain(line);
  });

  it("limits HLS to 25 unique viewers per video, shares tabs and reclaims a lease after 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(1_000_000);
    const { app, ledger } = fixture(); ledger.add(); const users = Array.from({ length: 26 }, () => randomUUID());
    for (const id of users.slice(0, 25)) expect((await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers(id) })).statusCode).toBe(200);
    expect((await app.inject({ url: path(`/${videoId}/segments/segment-000001.ts`), headers: headers(users[0]!) })).statusCode).toBe(200);
    expect((await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers(users[25]!) })).statusCode).toBe(429);
    await vi.advanceTimersByTimeAsync(29_999);
    expect((await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers(users[25]!) })).statusCode).toBe(429);
    await vi.advanceTimersByTimeAsync(1);
    expect((await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers(users[25]!) })).statusCode).toBe(200);
  });

  it("keeps viewer leases scoped to video identity and rechecks auth on every HLS request", async () => {
    const { app, ledger, resolveSession } = fixture(); ledger.add(); const other = ledger.add({ id: randomUUID(), status: "stopped" });
    for (let i = 0; i < 25; i++) await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers(randomUUID()) });
    expect((await app.inject({ url: path(`/${other.id}/index.m3u8`), headers: headers() })).statusCode).toBe(200);
    resolveSession.mockResolvedValueOnce(null);
    expect((await app.inject({ url: path(`/${other.id}/segments/segment-000001.ts`), headers: headers() })).statusCode).toBe(401);
  });

  it("keeps unknown worker failures private and releases failed start reservations", async () => {
    const { app, ledger, fetcher } = fixture(); fetcher.mockResolvedValueOnce(new Response(`private payload ${secret}`, { status: 500 }));
    const result = await app.inject({ method: "POST", url: path("/start"), headers: headers(ownerId) });
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain(secret);
    expect([...ledger.rows.values()].every(({ status }) => status === "interrupted")).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(true);
  });

  it("returns buffering for a missing worker artifact and bounds oversized response bodies", async () => {
    const { app, ledger, fetcher } = fixture(); ledger.add();
    fetcher.mockResolvedValueOnce(new Response("private failure", { status: 404 }));
    expect((await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers() })).statusCode).toBe(404);
    fetcher.mockResolvedValueOnce(new Response("x", { headers: { "content-length": "2097153" } }));
    expect((await app.inject({ url: path(`/${videoId}/segments/segment-000001.ts`), headers: headers() })).statusCode).toBe(502);
    fetcher.mockResolvedValueOnce(new Response("x".repeat(1_048_577)));
    expect((await app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers() })).statusCode).toBe(502);
  });

  it("does not reveal a playback URL before release or accept another worker session's state", async () => {
    const { app, ledger, fetcher } = fixture(); const row = ledger.add();
    fetcher.mockResolvedValueOnce(Response.json({ id: videoId, status: "live", availableAt: Date.now() + 120_000, ingestActive: true }));
    const pending = await app.inject({ url: path(), headers: headers(ownerId) });
    expect(pending.json()).toMatchObject({ enabled: true, canPublish: true, video: { id: videoId, playlistUrl: null } });
    fetcher.mockResolvedValueOnce(Response.json({ id: randomUUID(), status: "live", availableAt: 0, ingestActive: true }));
    expect((await app.inject({ url: path(), headers: headers() })).statusCode).toBe(502);
    fetcher.mockResolvedValueOnce(new Response(`private worker body ${secret}`, { status: 503 }));
    const failed = await app.inject({ url: path(), headers: headers() });
    expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain(secret);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const expired = await app.inject({ url: path(), headers: headers() });
    expect(expired.json().video).toMatchObject({ status: "expired", playlistUrl: null });
    expect(row.status).toBe("interrupted");
  });

  it("handles worker upload rejection and uncertain stop without continuing ingest", async () => {
    const { app, ledger, fetcher } = fixture(); const row = ledger.add();
    fetcher.mockResolvedValueOnce(new Response("private worker detail", { status: 429 }));
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/chunks?sequence=0`), headers: { ...headers(ownerId), "content-type": "application/octet-stream" }, payload: Buffer.from([1]) })).statusCode).toBe(429);
    fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect((await app.inject({ method: "POST", url: path(`/${videoId}/stop`), headers: headers(ownerId) })).statusCode).toBe(503);
    expect(row.status).toBe("stopped");
  });

  it.each([false, true])("aborts an in-flight worker %s body on preClose before HTTP shutdown", async (readingBody) => {
    const { app, ledger, fetcher } = fixture(); ledger.add(); let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }); let signal: AbortSignal | undefined;
    fetcher.mockImplementationOnce(async (_url, init) => {
      signal = init!.signal!; entered();
      if (!readingBody) return await new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("private abort detail")), { once: true }));
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { signal!.addEventListener("abort", () => controller.error(new Error("private abort detail")), { once: true }); } }));
    });
    const response = app.inject({ url: path(`/${videoId}/index.m3u8`), headers: headers() });
    void response.then(() => undefined); await started; await app.close();
    expect(signal?.aborted).toBe(true); const result = await response;
    expect(result.statusCode).toBe(503); expect(result.body).not.toContain("private");
  }, 1_000);

  it("returns disabled video capability without reaching the worker", async () => {
    const { app, fetcher } = fixture({ enabled: false });
    const result = await app.inject({ url: path(), headers: headers(ownerId) });
    expect(result.json()).toMatchObject({ enabled: false, canPublish: false, video: null }); expect(fetcher).not.toHaveBeenCalled();
  });
});
