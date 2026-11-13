import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { publicGameNameSchema } from "@trinitymatrix/protocol";
import type { BroadcastAccess, BroadcastRepository } from "./broadcast-repository";
const delayMs = 120_000;
const maximumChunkBytes = 524_288;
const maximumViewersPerVideo = 25;
const viewerLeaseMs = 30_000;
const limits = {
  width: 854,
  height: 480,
  frameRate: 15,
  maxDurationSeconds: 7_200
} as const;
const names = z.object({
  name: publicGameNameSchema
});
const ids = z.string().uuid();
type VideoRow = {
  id: string;
  broadcast_id: string;
  publisher_id: string;
  status: "starting" | "live" | "stopped" | "interrupted";
  created_at: Date;
  ended_at: Date | null;
  display_name: string;
};
type MediaState = {
  id: string;
  status: "starting" | "buffering" | "live" | "stopped" | "interrupted" | "expired";
  availableAt: number;
  ingestActive: boolean;
};
const mediaStateSchema = z.object({
  id: ids,
  status: z.enum(["starting", "buffering", "live", "stopped", "interrupted", "expired"]),
  availableAt: z.number().finite(),
  ingestActive: z.boolean()
});
class MediaFailure extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
async function bounded(response: Response, maximum: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > maximum) {
    await response.body?.cancel();
    throw new MediaFailure(502, "The video response was too large.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let size = 0;
  const pieces: Uint8Array[] = [];
  try {
    while (true) {
      const {
        done,
        value
      } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new MediaFailure(502, "The video response was too large.");
      }
      pieces.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(pieces, size);
}
export type BroadcastMediaOptions = {
  pool: Pool;
  repository: Pick<BroadcastRepository, "access">;
  resolveSession: (request: FastifyRequest) => Promise<{
    playerId: string;
  } | null>;
  resolveAdminAccess: (request: FastifyRequest) => Promise<boolean>;
  allowedOrigins: ReadonlySet<string>;
  isReady: () => boolean;
  enabled: boolean;
  mediaUrl?: string | undefined;
  mediaSecret?: string | undefined;
  maximumStreams: number;
  fetch?: typeof fetch;
};

/** Only this authenticated gateway can reach the private media worker. */
export function registerBroadcastMediaRoutes(app: FastifyInstance, options: BroadcastMediaOptions) {
  const fetcher = options.fetch ?? fetch;
  const requests = new Set<AbortController>();
  const releases = new WeakMap<Response, () => void>();
  const viewerLeases = new Map<string, Map<string, number>>();
  let stopping = false;
  const pruneViewers = () => {
    const now = Date.now();
    for (const [id, viewers] of viewerLeases) {
      for (const [userId, expiresAt] of viewers) if (expiresAt <= now) viewers.delete(userId);
      if (!viewers.size) viewerLeases.delete(id);
    }
  };
  const leaseTimer = setInterval(pruneViewers, 5_000);
  leaseTimer.unref();
  app.addHook("preClose", async () => {
    stopping = true;
    clearInterval(leaseTimer);
    viewerLeases.clear();
    for (const controller of requests) controller.abort();
    requests.clear();
  });
  const admitViewer = (id: string, userId: string) => {
    pruneViewers();
    const viewers = viewerLeases.get(id) ?? new Map<string, number>();
    if (!viewers.has(userId) && viewers.size >= maximumViewersPerVideo) {
      throw new MediaFailure(429, "This video has reached its 25-viewer limit. The table broadcast remains available.");
    }
    viewers.set(userId, Date.now() + viewerLeaseMs);
    viewerLeases.set(id, viewers);
  };
  const requestMedia = async (path: string, method = "GET", body?: Buffer | Record<string, unknown>, timeout = 12_000) => {
    if (stopping || !options.enabled || !options.mediaUrl || !options.mediaSecret) throw new MediaFailure(503, "Video broadcasting is unavailable.");
    const binary = Buffer.isBuffer(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
    requests.add(controller);
    const release = () => {
      clearTimeout(timer);
      requests.delete(controller);
    };
    try {
      const response = await fetcher(new URL(path, options.mediaUrl), {
        method,
        headers: {
          "X-Trinity-Media-Key": options.mediaSecret,
          ...(body ? {
            "Content-Type": binary ? "application/octet-stream" : "application/json"
          } : {})
        },
        ...(body ? {
          body: binary ? new Uint8Array(body).buffer : JSON.stringify(body)
        } : {}),
        signal: controller.signal,
        redirect: "error"
      });
      releases.set(response, release);
      return response;
    } catch (error) {
      release();
      throw error;
    }
  };
  const cancelMedia = async (response: Response) => {
    try {
      await response.body?.cancel();
    } finally {
      releases.get(response)?.();
      releases.delete(response);
    }
  };
  const readMedia = async (response: Response, maximum: number) => {
    try {
      return await bounded(response, maximum);
    } finally {
      releases.get(response)?.();
      releases.delete(response);
    }
  };
  const workerState = async (id: string): Promise<MediaState | null> => {
    const response = await requestMedia(`/streams/${id}`);
    if (response.status === 404) {
      await cancelMedia(response);
      return null;
    }
    if (!response.ok) {
      await cancelMedia(response);
      throw new MediaFailure(503, "The video service is temporarily unavailable.");
    }
    const parsed = mediaStateSchema.safeParse(JSON.parse((await readMedia(response, 8_192)).toString("utf8")));
    if (!parsed.success || parsed.data.id !== id) throw new MediaFailure(502, "The video service returned an invalid status.");
    return parsed.data;
  };
  const endSession = async (row: Pick<VideoRow, "id">) => {
    try {
      const response = await requestMedia(`/streams/${row.id}/stop`, "POST");
      const accepted = response.ok;
      await cancelMedia(response);
      if (!accepted) throw new MediaFailure(503, "The video service could not confirm that this session stopped.");
    } finally {
      await options.pool.query("UPDATE live_broadcast_video_sessions SET status='stopped',ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1 AND status IN ('starting','live')", [row.id]);
    }
  };
  const closeForBroadcast = async (broadcastId: string) => {
    const rows = await options.pool.query<VideoRow>("SELECT id FROM live_broadcast_video_sessions WHERE broadcast_id=$1 AND status IN ('starting','live')", [broadcastId]);
    for (const row of rows.rows) viewerLeases.delete(row.id);
    await Promise.allSettled(rows.rows.map(endSession));
  };
  const resolve = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins.has(origin) || request.headers["sec-fetch-site"] === "cross-site") throw new MediaFailure(403, "Origin not allowed.");
    if (!options.isReady()) throw new MediaFailure(503, "The broadcast service is starting.");
    const session = await options.resolveSession(request);
    if (!session) throw new MediaFailure(401, "Authentication required.");
    const params = names.safeParse(request.params);
    if (!params.success) throw new MediaFailure(400, "Invalid broadcast name.");
    const access = await options.repository.access(params.data.name, session.playerId);
    if (!access) throw new MediaFailure(404, "Broadcast not found.");
    return {
      session,
      access
    };
  };
  const canHost = async (request: FastifyRequest, access: BroadcastAccess, playerId: string) => !access.ended && (access.participantIds.includes(playerId) || access.allAi && (await options.resolveAdminAccess(request)));
  const video = async (access: BroadcastAccess, id?: string) => {
    const result = await options.pool.query<VideoRow>(`SELECT v.*,p.display_name FROM live_broadcast_video_sessions v JOIN player_profiles p ON p.user_id=v.publisher_id WHERE v.broadcast_id=$1 ${id ? "AND v.id=$2" : ""} ORDER BY v.created_at DESC,v.id DESC LIMIT 1`, id ? [access.broadcastId, id] : [access.broadcastId]);
    return result.rows[0] ?? null;
  };
  const requireVideoId = (request: FastifyRequest) => {
    const parsed = ids.safeParse((request.params as {
      id?: unknown;
    }).id);
    if (!parsed.success) throw new MediaFailure(400, "Invalid video session.");
    return parsed.data;
  };
  const guard = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof MediaFailure) return reply.code(error.status).send({
        error: error.message
      });
      request.log.warn({
        code: "BROADCAST_MEDIA_UNAVAILABLE"
      }, "Video operation could not complete");
      return reply.code(503).send({
        error: "Video is temporarily unavailable. Please retry."
      });
    }
  };
  if (!app.hasContentTypeParser("application/octet-stream")) app.addContentTypeParser("application/octet-stream", {
    parseAs: "buffer",
    bodyLimit: maximumChunkBytes
  }, (_request, body, done) => done(null, body));
  app.get("/api/live/:name/video", {
    config: {
      rateLimit: {
        max: 90,
        timeWindow: "1 minute"
      }
    }
  }, guard(async (request, reply) => {
    const {
      session,
      access
    } = await resolve(request, reply);
    const canPublish = options.enabled && (await canHost(request, access, session.playerId));
    if (!options.enabled) return reply.send({
      enabled: false,
      canPublish: false,
      video: null,
      limits,
      serverNow: Date.now()
    });
    const row = await video(access);
    let result = null;
    if (row) {
      const state = await workerState(row.id);
      if (!state && ["starting", "live"].includes(row.status)) await options.pool.query("UPDATE live_broadcast_video_sessions SET status='interrupted',ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1", [row.id]);else if (state && !state.ingestActive && ["starting", "live"].includes(row.status)) await options.pool.query("UPDATE live_broadcast_video_sessions SET status='stopped',ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1", [row.id]);
      const availableAt = state?.availableAt ?? row.created_at.getTime() + delayMs;
      const released = !!state && Date.now() >= availableAt && ["live", "stopped", "interrupted"].includes(state.status);
      result = {
        id: row.id,
        status: state?.status ?? "expired",
        availableAt,
        playlistUrl: released ? `/api/live/${access.gameName}/video/${row.id}/index.m3u8` : null,
        publisherName: row.display_name
      };
    }
    return reply.send({
      enabled: true,
      canPublish,
      video: result,
      limits,
      serverNow: Date.now()
    });
  }));
  app.post("/api/live/:name/video/start", {
    bodyLimit: 4_096,
    config: {
      rateLimit: {
        max: 4,
        timeWindow: "1 minute"
      }
    }
  }, guard(async (request, reply) => {
    const {
      session,
      access
    } = await resolve(request, reply);
    if (!(await canHost(request, access, session.playerId))) throw new MediaFailure(403, "Only a participating player or an administrator of an AI-only table can publish video.");
    if (!options.enabled) throw new MediaFailure(503, "Video broadcasting is unavailable.");
    const id = randomUUID();
    const client = await options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(803216147192::bigint)");
      await client.query("UPDATE live_broadcast_video_sessions SET status='interrupted',ended_at=clock_timestamp() WHERE status IN ('starting','live') AND last_seen_at<clock_timestamp()-interval '45 seconds'");
      const counts = await client.query<{
        total: string;
        matching: string;
      }>("SELECT count(*)::text AS total,count(*) FILTER(WHERE broadcast_id=$1)::text AS matching FROM live_broadcast_video_sessions WHERE status IN ('starting','live')", [access.broadcastId]);
      if (Number(counts.rows[0]?.matching) > 0) throw new MediaFailure(409, "This match already has a video publisher.");
      if (Number(counts.rows[0]?.total) >= options.maximumStreams) throw new MediaFailure(409, "All video broadcast slots are busy. The live table broadcast remains available.");
      await client.query("INSERT INTO live_broadcast_video_sessions(id,broadcast_id,publisher_id,status) VALUES($1,$2,$3,'starting')", [id, access.broadcastId, session.playerId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    try {
      const response = await requestMedia("/streams", "POST", {
        id,
        delayMs
      });
      if (!response.ok) {
        await cancelMedia(response);
        throw new MediaFailure(response.status === 409 ? 409 : 503, "The video service could not start this broadcast. Please retry shortly.");
      }
      const data = z.object({
        id: ids,
        availableAt: z.number().finite()
      }).parse(JSON.parse((await readMedia(response, 8_192)).toString("utf8")));
      if (data.id !== id) throw new MediaFailure(502, "The video service returned an invalid session.");
      return reply.code(201).send({
        id,
        uploadUrl: `/api/live/${access.gameName}/video/${id}/chunks`,
        stopUrl: `/api/live/${access.gameName}/video/${id}/stop`,
        availableAt: data.availableAt,
        limits
      });
    } catch (error) {
      await options.pool.query("UPDATE live_broadcast_video_sessions SET status='interrupted',ended_at=clock_timestamp() WHERE id=$1", [id]);
      try {
        await endSession({
          id
        });
      } catch {}
      throw error;
    }
  }));
  app.post("/api/live/:name/video/:id/chunks", {
    bodyLimit: maximumChunkBytes,
    config: {
      rateLimit: {
        max: 300,
        timeWindow: "1 minute"
      }
    }
  }, guard(async (request, reply) => {
    const {
      session,
      access
    } = await resolve(request, reply);
    const id = requireVideoId(request);
    const row = await video(access, id);
    if (!row) throw new MediaFailure(404, "Video session not found.");
    if (row.publisher_id !== session.playerId) throw new MediaFailure(403, "Only the video publisher can upload chunks.");
    if (!["starting", "live"].includes(row.status)) throw new MediaFailure(409, "This video session has ended.");
    if (access.ended) {
      await endSession(row);
      throw new MediaFailure(409, "The match ended. Your delayed broadcast will finish playing shortly.");
    }
    const sequence = z.coerce.number().int().min(0).max(1_000_000).safeParse((request.query as {
      sequence?: unknown;
    }).sequence);
    if (!sequence.success || !Buffer.isBuffer(request.body) || !request.body.length) throw new MediaFailure(400, "Invalid video chunk.");
    const response = await requestMedia(`/streams/${id}/chunks?sequence=${sequence.data}`, "POST", request.body, 15_000);
    if (!response.ok) {
      const status = response.status;
      await cancelMedia(response);
      if ([404, 409, 410, 413, 429].includes(status)) throw new MediaFailure(status, "The video upload could not continue. Stop and restart the broadcast.");
      throw new MediaFailure(503, "The video service is temporarily unavailable.");
    }
    await cancelMedia(response);
    await options.pool.query("UPDATE live_broadcast_video_sessions SET status='live',last_seen_at=clock_timestamp() WHERE id=$1 AND status IN ('starting','live')", [id]);
    return reply.code(202).send({
      accepted: true
    });
  }));
  app.post("/api/live/:name/video/:id/stop", {
    bodyLimit: 4_096,
    config: {
      rateLimit: {
        max: 20,
        timeWindow: "1 minute"
      }
    }
  }, guard(async (request, reply) => {
    const {
      session,
      access
    } = await resolve(request, reply);
    const row = await video(access, requireVideoId(request));
    if (!row) throw new MediaFailure(404, "Video session not found.");
    if (row.publisher_id !== session.playerId && !(await options.resolveAdminAccess(request))) throw new MediaFailure(403, "Only the publisher can stop this video.");
    await endSession(row);
    return reply.send({
      stopped: true
    });
  }));
  const serve = async (request: FastifyRequest, reply: FastifyReply, segment: boolean) => {
    const {
      session,
      access
    } = await resolve(request, reply);
    const id = requireVideoId(request);
    if (!(await video(access, id))) throw new MediaFailure(404, "Video session not found.");
    const file = segment ? (request.params as {
      file?: unknown;
    }).file : null;
    if (segment && (typeof file !== "string" || !/^segment-[0-9]{6}\.ts$/.test(file))) {
      throw new MediaFailure(400, "Invalid video segment.");
    }
    admitViewer(id, session.playerId);
    const path = segment ? `/streams/${id}/segments/${file}` : `/streams/${id}/index.m3u8`;
    const response = await requestMedia(path);
    if (!response.ok) {
      const status = response.status;
      await cancelMedia(response);
      throw new MediaFailure(status === 404 ? 404 : 503, status === 404 ? "Video is still buffering or has expired." : "Video is temporarily unavailable.");
    }
    const bytes = await readMedia(response, segment ? 2_097_152 : 1_048_576);
    if (!segment) {
      const lines = bytes.toString("utf8").split(/\r?\n/);
      // The worker emits a simple MPEG-TS event playlist. Attribute URI tags
      // could bypass this gateway's authenticated, delayed segment routes.
      const metadata = /^#(?:EXTM3U|EXT-X-VERSION:[0-9]+|EXT-X-TARGETDURATION:[0-9]+|EXT-X-MEDIA-SEQUENCE:[0-9]+|EXT-X-PLAYLIST-TYPE:(?:EVENT|VOD)|EXT-X-INDEPENDENT-SEGMENTS|EXT-X-ENDLIST|EXTINF:[0-9]+(?:\.[0-9]+)?,)$/;
      if (lines[0] !== "#EXTM3U" || lines.some(line => line !== "" && !metadata.test(line) && !/^segments\/segment-[0-9]{6}\.ts$/.test(line))) {
        throw new MediaFailure(502, "The video service returned an invalid playlist.");
      }
      reply.type("application/vnd.apple.mpegurl");
    } else reply.type("video/mp2t");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(bytes);
  };
  app.get("/api/live/:name/video/:id/index.m3u8", {
    config: {
      rateLimit: {
        max: 180,
        timeWindow: "1 minute"
      }
    }
  }, guard((request, reply) => serve(request, reply, false)));
  app.get("/api/live/:name/video/:id/segments/:file", {
    config: {
      rateLimit: {
        max: 600,
        timeWindow: "1 minute"
      }
    }
  }, guard((request, reply) => serve(request, reply, true)));
  return {
    closeForBroadcast
  };
}
