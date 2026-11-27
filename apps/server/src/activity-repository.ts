import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { activityActionSchema, activityFiltersSchema, activityIngestSchema, activityPageSchema,
  type ActivityAction, type ActivityEvent, type ActivityFilters, type ActivityIngest, type ActivityList,
  type ActivityOverview, type ActivityPage, type ActivitySession, type ActivityUser } from "@trinitymatrix/protocol";

export class ActivityQueryError extends Error {}
type ListOptions = { cursor?: string; limit?: number };
type EventOptions = ListOptions & { kind?: "all" | "auth" | "match" | "interaction" };
type SessionIdentity = { userId: string; sessionHash: string; expiresAt?: Date };
type Db = Pick<Pool, "query" | "connect">;
const identitySchema = z.object({ userId: z.string().uuid(), sessionHash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.date().optional() }).strict();
const cursorSchema = z.object({ at: z.string().datetime({ offset: true }), id: z.string().min(1).max(200), binding: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const iso = (value: Date | string | null | undefined): string | null => value == null ? null : new Date(value).toISOString();
const n = (value: unknown): number => Number(value ?? 0);

export interface ActivityRepository {
  recordLogin(input: SessionIdentity, now?: Date): Promise<void>;
  recordLogout(input: SessionIdentity, now?: Date): Promise<void>;
  recordServerInteraction(input: SessionIdentity & { action: ActivityAction; page?: ActivityPage }, now?: Date): Promise<void>;
  ingest(input: SessionIdentity & { event: ActivityIngest }, now?: Date): Promise<void>;
  overview(filters: ActivityFilters): Promise<ActivityOverview>;
  users(filters: ActivityFilters, options?: ListOptions): Promise<ActivityList<ActivityUser>>;
  events(filters: ActivityFilters, options?: EventOptions): Promise<ActivityList<ActivityEvent>>;
  sessions(filters: ActivityFilters, options?: ListOptions): Promise<ActivityList<ActivitySession>>;
  pruneRetention(now?: Date): Promise<void>;
}

/** Browser telemetry is metadata only. Public outcomes always come from game archival. */
export class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly pool: Db, private readonly clock: () => Date = () => new Date()) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async session(client: PoolClient, input: SessionIdentity, now: Date): Promise<string> {
    identitySchema.parse(input);
    const owner = await client.query("SELECT id FROM app_users WHERE id=$1 AND actor_kind='human' FOR UPDATE", [input.userId]);
    if (!owner.rowCount) throw new ActivityQueryError("Only human users have browser activity sessions.");
    const result = await client.query<{ id: string }>(
      `INSERT INTO activity_sessions(id,session_hash,user_id,started_at,last_seen_at,expires_at)
       SELECT $1,$2,u.id,$4,$4,$5 FROM app_users u WHERE u.id=$3 AND u.actor_kind='human'
       ON CONFLICT(session_hash) DO UPDATE SET last_seen_at=GREATEST(activity_sessions.last_seen_at,EXCLUDED.last_seen_at),
         expires_at=COALESCE(EXCLUDED.expires_at,activity_sessions.expires_at)
       WHERE activity_sessions.user_id=EXCLUDED.user_id AND activity_sessions.ended_at IS NULL RETURNING id`,
      [randomUUID(), input.sessionHash, input.userId, now, input.expiresAt ?? null]);
    if (!result.rows[0]) throw new ActivityQueryError("The analytics session is unavailable or does not belong to this user.");
    await client.query(`INSERT INTO activity_presence(user_id,last_seen_at) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET last_seen_at=GREATEST(activity_presence.last_seen_at,EXCLUDED.last_seen_at)`, [input.userId, now]);
    return result.rows[0].id;
  }

  async recordLogin(input: SessionIdentity, now = this.clock()): Promise<void> {
    await this.transaction(async (client) => {
      const id = await this.session(client, input, now);
      const changed = await client.query(`UPDATE activity_sessions SET signed_in_at=$2 WHERE id=$1 AND signed_in_at IS NULL RETURNING id`, [id, now]);
      if (changed.rowCount) await client.query(`INSERT INTO activity_events(event_id,user_id,session_id,kind,action,source,occurred_at)
        VALUES($1,$2,$3,'auth','login','server',$4)`, [randomUUID(), input.userId, id, now]);
    });
  }

  async recordLogout(input: SessionIdentity, now = this.clock()): Promise<void> {
    identitySchema.parse(input);
    await this.transaction(async (client) => {
      await client.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE", [input.userId]);
      const ended = await client.query<{ id: string }>(`UPDATE activity_sessions SET ended_at=$3,last_seen_at=GREATEST(last_seen_at,$3)
        WHERE session_hash=$1 AND user_id=$2 AND ended_at IS NULL RETURNING id`, [input.sessionHash, input.userId, now]);
      if (ended.rows[0]) await client.query(`INSERT INTO activity_events(event_id,user_id,session_id,kind,action,source,occurred_at)
        VALUES($1,$2,$3,'auth','logout','server',$4)`, [randomUUID(), input.userId, ended.rows[0].id, now]);
    });
  }

  async recordServerInteraction(input: SessionIdentity & { action: ActivityAction; page?: ActivityPage }, now = this.clock()): Promise<void> {
    const action = activityActionSchema.parse(input.action);
    const page = input.page === undefined ? null : activityPageSchema.parse(input.page);
    const identity = { userId: input.userId, sessionHash: input.sessionHash, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
    await this.transaction(async (client) => {
      const id = await this.session(client, identity, now);
      await client.query(`INSERT INTO activity_events(event_id,user_id,session_id,kind,action,source,page,occurred_at)
        VALUES($1,$2,$3,'interaction',$4,'server',$5,$6)`, [randomUUID(), input.userId, id, action, page, now]);
    });
  }

  async ingest(input: SessionIdentity & { event: ActivityIngest }, now = this.clock()): Promise<void> {
    const event = activityIngestSchema.parse(input.event);
    const identity = { userId: input.userId, sessionHash: input.sessionHash, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
    identitySchema.parse(identity);
    await this.transaction(async (client) => {
      // Take one account-wide lock before deduplication/credit so simultaneous
      // tabs or devices cannot each claim the same wall-clock interval.
      const user = await client.query(`SELECT id FROM app_users WHERE id=$1 AND actor_kind='human' FOR UPDATE`, [input.userId]);
      if (!user.rowCount) throw new ActivityQueryError("Only authenticated human users can submit browser activity.");
      const receipt = await client.query(`INSERT INTO activity_ingest_receipts(user_id,event_id,received_at) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING RETURNING event_id`, [input.userId, event.eventId, now]);
      if (!receipt.rowCount) return;
      const sessionId = await this.session(client, identity, now);
      await client.query(`UPDATE activity_sessions SET last_page=$2 WHERE id=$1`, [sessionId, event.page]);
      if (event.type === "interaction") {
        await client.query(`INSERT INTO activity_events(event_id,user_id,session_id,kind,action,source,page,occurred_at)
          VALUES($1,$2,$3,'interaction',$4,'browser',$5,$6) ON CONFLICT DO NOTHING`, [event.eventId, input.userId, sessionId, event.action, event.page, now]);
        return;
      }
      if (!event.active) return;
      const previous = (await client.query<{ last_active_sample_at: Date | null }>(`SELECT last_active_sample_at FROM activity_presence WHERE user_id=$1 FOR UPDATE`, [input.userId])).rows[0]?.last_active_sample_at;
      const elapsed = previous ? now.getTime() - previous.getTime() : 0;
      if (!event.fresh && elapsed > 0 && elapsed <= 45_000) {
        let start = previous!.getTime();
        while (start < now.getTime()) {
          const minute = Math.floor(start / 60_000) * 60_000;
          const end = Math.min(now.getTime(), minute + 60_000);
          await client.query(`INSERT INTO activity_time_buckets(user_id,session_id,page,minute_at,active_ms) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(user_id,session_id,page,minute_at) DO UPDATE SET active_ms=activity_time_buckets.active_ms+EXCLUDED.active_ms`,
          [input.userId, sessionId, event.page, new Date(minute), end - start]);
          start = end;
        }
      }
      if (!previous || now.getTime() >= previous.getTime()) await client.query(`UPDATE activity_presence SET last_active_sample_at=$2 WHERE user_id=$1`, [input.userId, now]);
    });
  }

  private filters(input: ActivityFilters): { filters: ActivityFilters; values: unknown[] } {
    const filters = activityFiltersSchema.parse(input);
    if (Date.parse(filters.to) > this.clock().getTime() + 60_000) throw new ActivityQueryError("Activity ranges cannot extend into the future.");
    return { filters, values: [filters.from, filters.to, filters.actorKind, filters.userId ?? null, filters.q?.toLowerCase() ?? ""] };
  }

  private ctes = `
    filtered_users AS (
      SELECT u.id AS user_id,u.email,u.actor_kind,p.display_name,u.created_at FROM app_users u JOIN player_profiles p ON p.user_id=u.id
      WHERE ($3::text='all' OR u.actor_kind=$3) AND ($4::uuid IS NULL OR u.id=$4)
        AND ($5::text='' OR strpos(lower(u.email||' '||p.display_name),$5)>0)
    ), engagement AS (
      SELECT t.user_id,t.session_id,t.page,t.minute_at,
        t.active_ms*GREATEST(0,EXTRACT(epoch FROM LEAST(t.minute_at+interval '1 minute',$2::timestamptz)-GREATEST(t.minute_at,$1::timestamptz)))/60 AS active_ms
      FROM activity_time_buckets t JOIN filtered_users u ON u.user_id=t.user_id
      WHERE t.minute_at<$2::timestamptz AND t.minute_at+interval '1 minute'>$1::timestamptz
    ), tracked_events AS (
      SELECT e.* FROM activity_events e JOIN filtered_users u ON u.user_id=e.user_id WHERE e.occurred_at>=$1 AND e.occurred_at<$2
    ), results AS (
      SELECT p.user_id,p.outcome,m.id AS match_id,m.public_name,m.ended_at,m.match_type FROM match_participants p
      JOIN ranking_matches m ON m.id=p.match_id JOIN filtered_users u ON u.user_id=p.user_id
      WHERE m.status='completed' AND m.ended_at>=$1 AND m.ended_at<$2
    ), game_actions AS (
      SELECT e.event_id,e.actor_user_id AS user_id,e.event_type,e.occurred_at,m.public_name
      FROM game_events e JOIN ranking_matches m ON m.id=e.match_id JOIN filtered_users u ON u.user_id=e.actor_user_id
      WHERE e.occurred_at>=$1 AND e.occurred_at<$2 AND e.event_type IN ('game.draw','game.discard','game.declare','game.drop','game.submit-hand')
    ), observed AS (
      SELECT user_id FROM tracked_events UNION SELECT user_id FROM engagement UNION SELECT user_id FROM results UNION SELECT user_id FROM game_actions
      UNION SELECT s.user_id FROM activity_sessions s JOIN filtered_users u ON u.user_id=s.user_id WHERE s.last_seen_at>=$1 AND s.started_at<$2
    )`;

  async overview(input: ActivityFilters): Promise<ActivityOverview> {
    const { filters, values } = this.filters(input);
    const results = await Promise.all([
      this.pool.query(`WITH ${this.ctes} SELECT
        (SELECT count(*) FROM tracked_events WHERE action='login' AND kind='auth') AS sign_ins,
        (SELECT count(*) FROM observed) AS unique_users,
        (SELECT count(*) FROM activity_presence p JOIN filtered_users u ON u.user_id=p.user_id
          WHERE p.last_active_sample_at>=$6::timestamptz-interval '60 seconds' AND EXISTS(SELECT 1 FROM activity_sessions s WHERE s.user_id=p.user_id AND s.ended_at IS NULL AND(s.expires_at IS NULL OR s.expires_at>$6))) AS active_users,
        (SELECT COALESCE(sum(active_ms),0)/1000 FROM engagement) AS active_seconds,
        (SELECT count(DISTINCT match_id) FROM results) AS matches,
        (SELECT count(*) FROM results WHERE outcome='won') AS wins,
        (SELECT count(*) FROM results WHERE outcome='lost') AS losses,
        (SELECT count(*) FROM results WHERE outcome='dropped') AS drops,
        (SELECT count(*) FROM tracked_events WHERE kind='interaction')+(SELECT count(*) FROM game_actions) AS interactions`, [...values, this.clock()]),
      this.pool.query(`WITH ${this.ctes}, days AS(SELECT day::date AS day FROM generate_series(date_trunc('day',$1::timestamptz AT TIME ZONE 'UTC'),date_trunc('day',($2::timestamptz-interval '1 millisecond') AT TIME ZONE 'UTC'),interval '1 day') day)
        SELECT day::text AS date,
        (SELECT count(*) FROM tracked_events WHERE kind='auth' AND action='login' AND (occurred_at AT TIME ZONE 'UTC')::date=day) AS sign_ins,
        (SELECT COALESCE(sum(active_ms),0)/1000 FROM engagement WHERE(minute_at AT TIME ZONE 'UTC')::date=day) AS active_seconds,
        (SELECT count(DISTINCT match_id) FROM results WHERE(ended_at AT TIME ZONE 'UTC')::date=day) AS matches,
        (SELECT count(*) FROM tracked_events WHERE kind='interaction' AND(occurred_at AT TIME ZONE 'UTC')::date=day)+(SELECT count(*) FROM game_actions WHERE(occurred_at AT TIME ZONE 'UTC')::date=day) AS interactions FROM days ORDER BY day`, values),
      this.pool.query(`WITH ${this.ctes}, pages AS(SELECT page FROM engagement UNION SELECT page FROM tracked_events WHERE page IS NOT NULL)
        SELECT page,(SELECT count(*) FROM tracked_events e WHERE e.page=p.page AND action='page.view') AS views,
        (SELECT COALESCE(sum(active_ms),0)/1000 FROM engagement e WHERE e.page=p.page) AS active_seconds FROM pages p ORDER BY active_seconds DESC,page`, values),
      this.pool.query(`WITH ${this.ctes} SELECT action,source,count(*) AS count FROM(
        SELECT action,source FROM tracked_events WHERE kind='interaction' UNION ALL SELECT event_type AS action,'server' AS source FROM game_actions
        ) all_actions GROUP BY action,source ORDER BY count DESC,action,source LIMIT 100`, values),
      this.pool.query<{ collection_started_at: Date; retention_days: number }>("SELECT collection_started_at,retention_days FROM activity_settings WHERE singleton")
    ]);
    const summary = results[0].rows[0]!;
    return { from: filters.from, to: filters.to, trackingSince: iso(results[4].rows[0]!.collection_started_at)!, retentionDays: n(results[4].rows[0]!.retention_days), generatedAt: this.clock().toISOString(),
      summary: { signIns: n(summary.sign_ins), uniqueUsers: n(summary.unique_users), activeUsers: n(summary.active_users), activeSeconds: Math.floor(n(summary.active_seconds)), matches: n(summary.matches), wins: n(summary.wins), losses: n(summary.losses), drops: n(summary.drops), interactions: n(summary.interactions) },
      daily: results[1].rows.map((r) => ({ date: r.date, signIns: n(r.sign_ins), activeSeconds: Math.floor(n(r.active_seconds)), matches: n(r.matches), interactions: n(r.interactions) })),
      pages: results[2].rows.map((r) => ({ page: r.page, views: n(r.views), activeSeconds: Math.floor(n(r.active_seconds)) })),
      actions: results[3].rows.map((r) => ({ action: r.action, count: n(r.count), source: r.source })) };
  }

  private page(input: ActivityFilters, options: ListOptions, extra = ""): { values: unknown[]; limit: number; binding: string; cursor: z.infer<typeof cursorSchema> | null } {
    const { filters, values } = this.filters(input);
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ActivityQueryError("Invalid activity page size.");
    const binding = createHash("sha256").update(JSON.stringify([filters.from, filters.to, filters.actorKind, filters.userId ?? null, filters.q ?? "", extra])).digest("hex");
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (options.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"))); }
      catch { throw new ActivityQueryError("Invalid activity cursor."); }
      if (cursor.binding !== binding) throw new ActivityQueryError("The activity cursor belongs to different filters.");
    }
    return { values, limit, binding, cursor };
  }
  private cursor(at: Date | string, id: string, binding: string): string {
    return Buffer.from(JSON.stringify({ at: iso(at), id, binding })).toString("base64url");
  }

  async users(input: ActivityFilters, options: ListOptions = {}): Promise<ActivityList<ActivityUser>> {
    const { values, limit, binding, cursor } = this.page(input, options);
    if (cursor && !z.string().uuid().safeParse(cursor.id).success) throw new ActivityQueryError("Invalid user activity cursor.");
    const result = await this.pool.query(`WITH ${this.ctes}, user_stats AS (
      SELECT u.*,
      GREATEST(p.last_seen_at,(SELECT max(e.occurred_at) FROM game_events e WHERE e.actor_user_id=u.user_id)) AS last_seen_at,
      p.last_active_sample_at,
      (SELECT max(s.signed_in_at) FROM activity_sessions s WHERE s.user_id=u.user_id) AS last_sign_in_at,
      (SELECT count(*) FROM tracked_events e WHERE e.user_id=u.user_id AND e.kind='auth' AND e.action='login') AS sign_ins,
      (SELECT count(*) FROM activity_sessions s WHERE s.user_id=u.user_id AND s.started_at<$2 AND s.last_seen_at>=$1) AS session_count,
      EXISTS(SELECT 1 FROM activity_sessions s WHERE s.user_id=u.user_id AND s.ended_at IS NULL AND(s.expires_at IS NULL OR s.expires_at>$9)) AS open_session,
      (SELECT COALESCE(sum(e.active_ms),0)/1000 FROM engagement e WHERE e.user_id=u.user_id) AS active_seconds,
      (SELECT count(*) FROM results r WHERE r.user_id=u.user_id) AS matches,
      (SELECT count(*) FROM results r WHERE r.user_id=u.user_id AND outcome='won') AS wins,
      (SELECT count(*) FROM results r WHERE r.user_id=u.user_id AND outcome='lost') AS losses,
      (SELECT count(*) FROM results r WHERE r.user_id=u.user_id AND outcome='dropped') AS drops,
      (SELECT count(*) FROM tracked_events e WHERE e.user_id=u.user_id AND e.kind='interaction')+(SELECT count(*) FROM game_actions e WHERE e.user_id=u.user_id) AS interactions
      FROM filtered_users u LEFT JOIN activity_presence p ON p.user_id=u.user_id
      WHERE u.user_id IN(SELECT user_id FROM observed) OR $4::uuid IS NOT NULL
    ), sorted AS(SELECT *,date_trunc('milliseconds',LEAST(COALESCE(last_seen_at,last_sign_in_at,created_at),$2::timestamptz)) AS sort_at FROM user_stats)
    SELECT * FROM sorted WHERE($6::timestamptz IS NULL OR(sort_at,user_id)<($6::timestamptz,$7::uuid)) ORDER BY sort_at DESC,user_id DESC LIMIT $8`,
    [...values, cursor?.at ?? null, cursor?.id ?? null, limit + 1, this.clock()]);
    const rows = result.rows.slice(0, limit);
    const now = this.clock().getTime();
    const items: ActivityUser[] = rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, email: r.email, actorKind: r.actor_kind,
      lastSeenAt: iso(r.last_seen_at), lastSignInAt: iso(r.last_sign_in_at),
      status: r.open_session && r.last_active_sample_at && now - new Date(r.last_active_sample_at).getTime() <= 60_000 ? "active" : r.open_session && r.last_seen_at && now - new Date(r.last_seen_at).getTime() <= 90_000 ? "idle" : "offline",
      signIns: n(r.sign_ins), sessionCount: n(r.session_count), activeSeconds: Math.floor(n(r.active_seconds)), matches: n(r.matches), wins: n(r.wins), losses: n(r.losses), drops: n(r.drops), interactions: n(r.interactions) }));
    const last = rows.at(-1);
    return { items, nextCursor: result.rows.length > limit && last ? this.cursor(last.sort_at, last.user_id, binding) : null };
  }

  async events(input: ActivityFilters, options: EventOptions = {}): Promise<ActivityList<ActivityEvent>> {
    const kind = options.kind ?? "all";
    if (!["all", "auth", "match", "interaction"].includes(kind)) throw new ActivityQueryError("Invalid activity event kind.");
    const { values, limit, binding, cursor } = this.page(input, options, kind);
    const result = await this.pool.query(`WITH ${this.ctes}, timeline AS (
      SELECT 'event:'||e.event_id::text||':'||e.user_id::text AS id,date_trunc('milliseconds',e.occurred_at) AS occurred_at,e.user_id,e.kind,e.action,e.source,e.page,NULL::text AS game_name,NULL::text AS outcome FROM tracked_events e
      UNION ALL SELECT 'result:'||r.match_id::text||':'||r.user_id::text,date_trunc('milliseconds',r.ended_at),r.user_id,'match','match.'||r.outcome,'server',NULL,r.public_name,r.outcome FROM results r
      UNION ALL SELECT 'game:'||e.event_id::text,date_trunc('milliseconds',e.occurred_at),e.user_id,'match',e.event_type,'server','table',e.public_name,NULL FROM game_actions e
    ) SELECT t.*,u.display_name,u.email,u.actor_kind FROM timeline t JOIN filtered_users u ON u.user_id=t.user_id
      WHERE($6::text='all' OR t.kind=$6) AND($7::timestamptz IS NULL OR(t.occurred_at,t.id)<($7::timestamptz,$8::text))
      ORDER BY t.occurred_at DESC,t.id DESC LIMIT $9`, [...values, kind, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
    const rows = result.rows.slice(0, limit);
    return { items: rows.map((r) => ({ id: r.id, occurredAt: iso(r.occurred_at)!, userId: r.user_id, displayName: r.display_name, email: r.email, actorKind: r.actor_kind,
      kind: r.kind, action: r.action, source: r.source, page: r.page, gameName: r.game_name, outcome: r.outcome })),
    nextCursor: result.rows.length > limit && rows.at(-1) ? this.cursor(rows.at(-1)!.occurred_at, rows.at(-1)!.id, binding) : null };
  }

  async sessions(input: ActivityFilters, options: ListOptions = {}): Promise<ActivityList<ActivitySession>> {
    const { values, limit, binding, cursor } = this.page(input, options);
    if (cursor && !z.string().uuid().safeParse(cursor.id).success) throw new ActivityQueryError("Invalid session activity cursor.");
    const result = await this.pool.query(`WITH ${this.ctes} SELECT s.id,s.user_id,s.started_at,s.signed_in_at,s.last_seen_at,s.ended_at,s.expires_at,s.last_page,
      u.display_name,u.email,u.actor_kind,(SELECT COALESCE(sum(e.active_ms),0)/1000 FROM engagement e WHERE e.session_id=s.id) AS active_seconds
      FROM activity_sessions s JOIN filtered_users u ON u.user_id=s.user_id WHERE s.started_at<$2 AND s.last_seen_at>=$1
      AND($6::timestamptz IS NULL OR(date_trunc('milliseconds',LEAST(s.last_seen_at,$2::timestamptz)),s.id)<($6::timestamptz,$7::uuid)) ORDER BY date_trunc('milliseconds',LEAST(s.last_seen_at,$2::timestamptz)) DESC,s.id DESC LIMIT $8`,
    [...values, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
    const rows = result.rows.slice(0, limit);
    return { items: rows.map((r) => ({ id: r.id, userId: r.user_id, displayName: r.display_name, email: r.email, actorKind: r.actor_kind, startedAt: iso(r.started_at)!,
      signedInAt: iso(r.signed_in_at), lastSeenAt: iso(r.last_seen_at)!, endedAt: iso(r.ended_at), expiresAt: iso(r.expires_at), activeSeconds: Math.floor(n(r.active_seconds)), lastPage: r.last_page })),
    nextCursor: result.rows.length > limit && rows.at(-1) ? this.cursor(new Date(Math.min(new Date(rows.at(-1)!.last_seen_at).getTime(), Date.parse(input.to))), rows.at(-1)!.id, binding) : null };
  }

  async pruneRetention(now = this.clock()): Promise<void> {
    // Small batches avoid a long retention transaction on the shared game DB.
    await this.pool.query(`DELETE FROM activity_ingest_receipts WHERE(user_id,event_id) IN(SELECT user_id,event_id FROM activity_ingest_receipts WHERE received_at<$1::timestamptz-interval '1 hour' ORDER BY received_at LIMIT 5000)`, [now]);
    await this.pool.query(`DELETE FROM activity_events WHERE(user_id,event_id) IN(SELECT user_id,event_id FROM activity_events WHERE occurred_at<$1::timestamptz-interval '90 days' ORDER BY occurred_at LIMIT 5000)`, [now]);
    await this.pool.query(`DELETE FROM activity_time_buckets WHERE(user_id,session_id,page,minute_at) IN(SELECT user_id,session_id,page,minute_at FROM activity_time_buckets WHERE minute_at<$1::timestamptz-interval '90 days' ORDER BY minute_at LIMIT 5000)`, [now]);
    await this.pool.query(`DELETE FROM activity_sessions WHERE id IN(SELECT id FROM activity_sessions WHERE last_seen_at<$1::timestamptz-interval '90 days' ORDER BY last_seen_at LIMIT 1000)`, [now]);
    await this.pool.query(`DELETE FROM activity_presence WHERE user_id IN(SELECT user_id FROM activity_presence WHERE last_seen_at<$1::timestamptz-interval '90 days' ORDER BY last_seen_at LIMIT 1000)`, [now]);
  }
}
