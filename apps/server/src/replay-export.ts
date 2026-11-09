import { createHash } from "node:crypto";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const replaySchemaVersion = 1;

export function replayBucketName(value: string | undefined, required = false): string | null {
  const bucket = value?.trim();
  if (!bucket) {
    if (required) throw new Error("REPLAY_BUCKET is required for production PostgreSQL replay durability.");
    return null;
  }
  if (bucket.length < 3 || bucket.length > 63
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes("..")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error("REPLAY_BUCKET must be a valid DNS-compatible S3 bucket name.");
  }
  return bucket;
}

export type ReplayExportClaim = Readonly<{
  matchId: string;
  attempts: number;
}>;

type ReplayMatchRow = QueryResultRow & Readonly<{
  id: string;
  public_name: string;
  player_count: 2 | 6;
  match_type: "general" | "private";
  winner_user_id: string;
  end_reason: "declaration" | "invalid-declaration" | "player-dropped";
  started_at: Date;
  ended_at: Date;
}>;

type ReplayParticipantRow = QueryResultRow & Readonly<{
  user_id: string;
  seat_number: number;
  display_name: string;
  badge_id: string;
  outcome: "won" | "lost" | "dropped";
  score_delta: number;
  rating_after: number;
}>;

type ReplayEventRow = QueryResultRow & Readonly<{
  event_id: string;
  sequence: string | number;
  event_type: string;
  actor_user_id: string | null;
  command_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: Date;
  recorded_at: Date;
}>;

export type ReplayExportDocument = Readonly<{
  schemaVersion: 1;
  game: Readonly<{
    id: string;
    publicName: string;
    playerCount: 2 | 6;
    matchType: "general" | "private";
    winnerUserId: string;
    endReason: "declaration" | "invalid-declaration" | "player-dropped";
    startedAt: string;
    endedAt: string;
  }>;
  participants: readonly Readonly<{
    userId: string;
    seatNumber: number;
    displayName: string;
    badgeId: string;
    outcome: "won" | "lost" | "dropped";
    scoreDelta: number;
    ratingAfter: number;
  }>[];
  events: readonly Readonly<{
    eventId: string;
    sequence: number;
    eventType: string;
    actorUserId: string | null;
    commandId: string | null;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: string;
    recordedAt: string;
  }>[];
}>;

export type PreparedReplayExport = Readonly<{
  document: ReplayExportDocument;
  body: Uint8Array;
  contentSha256: string;
  checksumSha256: string;
  objectKey: string;
  eventCount: number;
}>;

export type StoredReplayObject = Readonly<{
  etag: string | null;
  versionId: string | null;
}>;

export interface ReplayObjectStore {
  putIfAbsent(input: {
    key: string;
    body: Uint8Array;
    contentSha256: string;
    checksumSha256: string;
  }): Promise<StoredReplayObject>;
}

export interface ReplayExportLedger {
  claim(input: {
    workerId: string;
    leaseDurationMs: number;
    limit: number;
    now?: Date;
  }): Promise<readonly ReplayExportClaim[]>;
  load(matchId: string): Promise<ReplayExportDocument>;
  markExported(input: {
    matchId: string;
    workerId: string;
    contentSha256: string;
    objectKey: string;
    eventCount: number;
    etag: string | null;
    versionId: string | null;
    exportedAt?: Date;
  }): Promise<void>;
  reschedule(input: {
    matchId: string;
    workerId: string;
    retryAt: Date;
    error: string;
  }): Promise<void>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Replay data contains an unsupported JSON value.");
  const entries = Object.entries(value as Record<string, unknown>)
    // Code-unit ordering is independent of the process locale and therefore
    // produces the same content identity on every ECS host and test machine.
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function safeDatePath(endedAt: string): string {
  const date = new Date(endedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("The completed match has an invalid end timestamp.");
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function prepareReplayExport(document: ReplayExportDocument): PreparedReplayExport {
  if (document.participants.length !== document.game.playerCount) {
    throw new Error("The replay participant count does not match the completed game.");
  }
  const winners = document.participants.filter(({ outcome }) => outcome === "won");
  if (winners.length !== 1 || winners[0]?.userId !== document.game.winnerUserId) {
    throw new Error("The replay does not contain exactly one declared winner.");
  }
  if (document.events.length < 1
    || document.events.some(({ sequence }, index) => sequence !== index + 1)) {
    throw new Error("The replay event stream is empty or non-contiguous.");
  }
  const canonical = `${stableJson(document)}\n`;
  const body = Buffer.from(canonical, "utf8");
  const digest = createHash("sha256").update(body).digest();
  const contentSha256 = digest.toString("hex");
  const objectKey = [
    "replays",
    `v${replaySchemaVersion}`,
    safeDatePath(document.game.endedAt),
    document.game.publicName,
    `${contentSha256}.json`
  ].join("/");
  return {
    document,
    body,
    contentSha256,
    checksumSha256: digest.toString("base64"),
    objectKey,
    eventCount: document.events.length
  };
}

function boundedLimit(value: number): number {
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function isClaimConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

export class S3ReplayObjectStore implements ReplayObjectStore {
  private readonly client: S3Client;

  constructor(private readonly bucket: string, client?: S3Client) {
    this.client = client ?? new S3Client({});
  }

  async putIfAbsent(input: {
    key: string;
    body: Uint8Array;
    contentSha256: string;
    checksumSha256: string;
  }): Promise<StoredReplayObject> {
    try {
      const stored = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: "application/json",
        CacheControl: "private, immutable, max-age=31536000",
        ChecksumSHA256: input.checksumSha256,
        IfNoneMatch: "*",
        Metadata: {
          "content-sha256": input.contentSha256,
          "schema-version": String(replaySchemaVersion)
        }
      }));
      return { etag: stored.ETag ?? null, versionId: stored.VersionId ?? null };
    } catch (error) {
      if (!isClaimConflict(error)) throw error;
      const existing = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: input.key
      }));
      if (existing.Metadata?.["content-sha256"] !== input.contentSha256
        || existing.ContentLength !== input.body.byteLength) {
        throw new Error("An existing replay object failed the content identity check.");
      }
      return { etag: existing.ETag ?? null, versionId: existing.VersionId ?? null };
    }
  }
}

export class PostgresReplayExportLedger implements ReplayExportLedger {
  constructor(private readonly pool: Pick<Pool, "query" | "connect">) {}

  async claim(input: {
    workerId: string;
    leaseDurationMs: number;
    limit: number;
    now?: Date;
  }): Promise<readonly ReplayExportClaim[]> {
    const result = await this.pool.query<{ match_id: string; export_attempts: number }>(
      `WITH runtime_clock AS (
         SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now
       ), candidates AS (
         SELECT e.match_id
         FROM replay_exports e
         JOIN ranking_matches m ON m.id = e.match_id
         CROSS JOIN runtime_clock c
         WHERE e.exported_at IS NULL AND e.available_at <= c.now
           AND (e.locked_until IS NULL OR e.locked_until <= c.now)
           AND m.status = 'completed'
         ORDER BY e.available_at ASC, e.created_at ASC, e.match_id ASC
         FOR UPDATE OF e SKIP LOCKED
         LIMIT $1
       )
       UPDATE replay_exports e
       SET locked_by = $2,
           locked_until = c.now + ($3::bigint * interval '1 millisecond'),
           export_attempts = export_attempts + 1,
           updated_at = c.now
       FROM candidates candidate, runtime_clock c
       WHERE e.match_id = candidate.match_id
       RETURNING e.match_id, e.export_attempts`,
      [boundedLimit(input.limit), input.workerId, input.leaseDurationMs, input.now ?? null]
    );
    return result.rows.map((row) => ({ matchId: row.match_id, attempts: row.export_attempts }));
  }

  async load(matchId: string): Promise<ReplayExportDocument> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
      const matchResult = await client.query<ReplayMatchRow>(
        `SELECT id, public_name, player_count, match_type, winner_user_id, end_reason,
                started_at, ended_at
         FROM ranking_matches
         WHERE id = $1 AND status = 'completed'`,
        [matchId]
      );
      const match = matchResult.rows[0];
      if (!match) throw new Error("The completed match is unavailable for replay export.");
      const participantResult = await client.query<ReplayParticipantRow>(
        `SELECT user_id, seat_number, display_name, badge_id, outcome, score_delta, rating_after
         FROM match_participants
         WHERE match_id = $1
         ORDER BY seat_number ASC`,
        [matchId]
      );
      const eventResult = await client.query<ReplayEventRow>(
        `SELECT event_id, sequence, event_type, actor_user_id, command_id, payload,
                occurred_at, recorded_at
         FROM game_events
         WHERE match_id = $1
         ORDER BY sequence ASC`,
        [matchId]
      );
      const document: ReplayExportDocument = {
        schemaVersion: replaySchemaVersion,
        game: {
          id: match.id,
          publicName: match.public_name,
          playerCount: match.player_count,
          matchType: match.match_type,
          winnerUserId: match.winner_user_id,
          endReason: match.end_reason,
          startedAt: match.started_at.toISOString(),
          endedAt: match.ended_at.toISOString()
        },
        participants: participantResult.rows.map((participant) => ({
          userId: participant.user_id,
          seatNumber: participant.seat_number,
          displayName: participant.display_name,
          badgeId: participant.badge_id,
          outcome: participant.outcome,
          scoreDelta: participant.score_delta,
          ratingAfter: participant.rating_after
        })),
        events: eventResult.rows.map((event) => ({
          eventId: event.event_id,
          sequence: Number(event.sequence),
          eventType: event.event_type,
          actorUserId: event.actor_user_id,
          commandId: event.command_id,
          payload: event.payload,
          occurredAt: event.occurred_at.toISOString(),
          recordedAt: event.recorded_at.toISOString()
        }))
      };
      await client.query("COMMIT");
      return document;
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markExported(input: {
    matchId: string;
    workerId: string;
    contentSha256: string;
    objectKey: string;
    eventCount: number;
    etag: string | null;
    versionId: string | null;
    exportedAt?: Date;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE replay_exports
       SET content_sha256 = $3, object_key = $4, event_count = $5,
           object_etag = $6, object_version_id = $7,
           exported_at = COALESCE($8::timestamptz, clock_timestamp()),
           locked_by = NULL, locked_until = NULL, last_error = NULL,
           updated_at = COALESCE($8::timestamptz, clock_timestamp())
       WHERE match_id = $1 AND locked_by = $2 AND exported_at IS NULL`,
      [
        input.matchId,
        input.workerId,
        input.contentSha256,
        input.objectKey,
        input.eventCount,
        input.etag,
        input.versionId,
        input.exportedAt ?? null
      ]
    );
    if (result.rowCount !== 1) throw new Error("The replay export claim was lost or already completed.");
  }

  async reschedule(input: {
    matchId: string;
    workerId: string;
    retryAt: Date;
    error: string;
  }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE replay_exports
       SET available_at = $3, locked_by = NULL, locked_until = NULL,
           last_error = left($4, 1000), updated_at = clock_timestamp()
       WHERE match_id = $1 AND locked_by = $2 AND exported_at IS NULL`,
      [input.matchId, input.workerId, input.retryAt, input.error]
    );
    if (result.rowCount !== 1) throw new Error("The replay export claim was lost or already completed.");
  }
}

export class ReplayExportWorker {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;

  constructor(
    private readonly ledger: ReplayExportLedger,
    private readonly store: ReplayObjectStore,
    private readonly workerId: string,
    private readonly reportError: (error: unknown, matchId?: string) => void,
    private readonly intervalMs = 2_000,
    private readonly leaseDurationMs = 120_000
  ) {}

  async runOnce(now?: Date): Promise<void> {
    const observedAt = now ?? new Date();
    const claims = await this.ledger.claim({
      workerId: this.workerId,
      leaseDurationMs: this.leaseDurationMs,
      limit: 10,
      ...(now ? { now } : {})
    });
    for (const claim of claims) {
      try {
        const prepared = prepareReplayExport(await this.ledger.load(claim.matchId));
        const stored = await this.store.putIfAbsent({
          key: prepared.objectKey,
          body: prepared.body,
          contentSha256: prepared.contentSha256,
          checksumSha256: prepared.checksumSha256
        });
        await this.ledger.markExported({
          matchId: claim.matchId,
          workerId: this.workerId,
          contentSha256: prepared.contentSha256,
          objectKey: prepared.objectKey,
          eventCount: prepared.eventCount,
          etag: stored.etag,
          versionId: stored.versionId,
          ...(now ? { exportedAt: now } : {})
        });
      } catch (error) {
        const exponent = Math.min(Math.max(claim.attempts - 1, 0), 10);
        const retryAt = new Date(observedAt.getTime() + Math.min(3_600_000, 1_000 * (2 ** exponent)));
        try {
          await this.ledger.reschedule({
            matchId: claim.matchId,
            workerId: this.workerId,
            retryAt,
            error: error instanceof Error ? error.message : "Unknown replay export error"
          });
        } catch (rescheduleError) {
          this.reportError(rescheduleError, claim.matchId);
        }
        this.reportError(error, claim.matchId);
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const schedule = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.inFlight = this.runOnce()
          .catch((error) => this.reportError(error))
          .finally(() => {
            this.inFlight = null;
            schedule();
          });
      }, this.intervalMs);
      this.timer.unref();
    };
    schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
