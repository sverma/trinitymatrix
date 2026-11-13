import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

export const MINIMUM_DELAY_MS = 120_000;
export const MAX_CHUNK_BYTES = 524_288;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const segmentName = /^segment-[0-9]{6}\.ts$/;
const identityOf = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const active = (stream) => stream.data.endedAt === null && stream.data.status !== "expired";
async function settlesWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export class MediaError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function loadMediaConfig(environment = process.env) {
  const number = (name, fallback, minimum, maximum) => {
    const value = environment[name] === undefined ? fallback : Number(environment[name]);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const secret = environment.BROADCAST_MEDIA_SECRET;
  if (!secret || secret.length < 32 || secret.length > 256 || /\s/.test(secret)) throw new Error("BROADCAST_MEDIA_SECRET requires 32 to 256 non-whitespace characters.");
  const storagePath = environment.MEDIA_STORAGE_PATH ?? "/data/media";
  if (!isAbsolute(storagePath)) throw new Error("MEDIA_STORAGE_PATH must be absolute.");
  return {
    secret, storagePath,
    host: environment.MEDIA_HOST ?? "0.0.0.0",
    port: number("MEDIA_PORT", 8082, 1, 65535),
    maxStreams: number("MEDIA_MAX_STREAMS", 1, 1, 8),
    maxStorageBytes: number("MEDIA_MAX_STORAGE_BYTES", 2_147_483_648, 16_777_216, 21_474_836_480),
    maxDurationMs: number("MEDIA_MAX_DURATION_SECONDS", 7200, 1, 7200) * 1000,
    idleTimeoutMs: number("MEDIA_IDLE_TIMEOUT_SECONDS", 30, 5, 300) * 1000,
    retentionMs: number("MEDIA_RETENTION_SECONDS", 21_600, 120, 604_800) * 1000,
    ffmpegPath: environment.MEDIA_FFMPEG_PATH ?? "ffmpeg"
  };
}

export function ffmpegArguments(directory, maximumDurationMs) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "67108864",
    "-protocol_whitelist", "pipe", "-format_whitelist", "matroska,webm,mov", "-threads", "1", "-filter_threads", "1", "-re", "-i", "pipe:0",
    "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-r", "15", "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "baseline",
    "-pix_fmt", "yuv420p", "-threads", "1", "-b:v", "650k", "-maxrate", "800k", "-bufsize", "1600k",
    "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "2",
    "-t", String(maximumDurationMs / 1000), "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_playlist_type", "event", "-hls_segment_type", "mpegts", "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", join(directory, "segment-%06d.ts"), join(directory, "source.m3u8")
  ];
}

function nativeEncoder(config, directory) {
  return spawn(config.ffmpegPath, ffmpegArguments(directory, config.maxDurationMs), {
    stdio: ["pipe", "ignore", "pipe"], shell: false, cwd: directory,
    // Inference/database credentials and the media service secret never enter FFmpeg.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", AV_LOG_FORCE_NOCOLOR: "1" }
  });
}

async function writeEncoder(writable, buffer) {
  if (!writable || writable.destroyed || writable.writableEnded) throw new MediaError(410, "encoder-ended");
  await new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;
    const cleanup = () => { clearTimeout(timer); writable.off("drain", onDrain); writable.off("error", onError); writable.off("close", onClose); };
    const finish = () => { if (!settled && callbackDone && drained) { settled = true; cleanup(); resolve(); } };
    const onError = () => { if (!settled) { settled = true; cleanup(); reject(new MediaError(503, "encoder-unavailable")); } };
    const onClose = () => onError();
    const onDrain = () => { drained = true; finish(); };
    const timer = setTimeout(() => { if (!settled) { settled = true; cleanup(); reject(new MediaError(503, "encoder-backpressure")); } }, 5_000);
    writable.on("error", onError); writable.on("close", onClose); writable.on("drain", onDrain);
    try {
      drained = writable.write(buffer, (error) => { if (error) onError(); else { callbackDone = true; finish(); } });
      finish();
    } catch { onError(); }
  });
}

async function fileSize(path) {
  try { const stat = await fs.lstat(path); return stat.isFile() ? stat.size : 0; } catch { return 0; }
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else total += await fileSize(path);
  }
  return total;
}

function validMetadata(data, id) {
  return data && data.version === 1 && data.id === id && uuid.test(data.id) && data.delayMs >= MINIMUM_DELAY_MS
    && Number.isSafeInteger(data.delayMs) && Number.isFinite(data.createdAt) && Number.isFinite(data.lastInputAt)
    && (data.endedAt === null || Number.isFinite(data.endedAt)) && Number.isFinite(data.expiresAt)
    && ["starting", "live", "stopped", "interrupted", "expired"].includes(data.status)
    && Number.isSafeInteger(data.nextSequence) && data.nextSequence >= 0 && data.nextSequence <= 1_000_000
    && Number.isFinite(data.acceptedBytes) && data.acceptedBytes >= 0 && Array.isArray(data.segments) && data.segments.length <= 3602
    && data.segments.every((segment) => segmentName.test(segment.name) && Number.isFinite(segment.createdAt)
      && Number.isFinite(segment.releaseAt) && segment.releaseAt >= segment.createdAt + MINIMUM_DELAY_MS
      && Number.isFinite(segment.duration) && segment.duration > 0 && segment.duration <= 10
      && Number.isSafeInteger(segment.bytes) && segment.bytes > 0 && segment.bytes <= 2_097_152
      && typeof segment.fileIdentity === "string" && segment.fileIdentity.length <= 200
      && typeof segment.released === "boolean")
    && typeof data.endReleased === "boolean";
}

export class MediaManager {
  constructor(config, options = {}) {
    this.config = config;
    this.now = options.now ?? Date.now;
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.encoder = options.encoder ?? ((directory) => nativeEncoder(config, directory));
    this.report = options.report ?? (() => undefined);
    this.streams = new Map();
    this.sweeping = null;
    this.createChain = Promise.resolve();
    this.storageBytes = 0;
    this.closing = false;
  }

  async init() {
    await fs.mkdir(this.config.storagePath, { recursive: true, mode: 0o700 });
    await fs.chmod(this.config.storagePath, 0o700);
    for (const entry of await fs.readdir(this.config.storagePath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue;
      const directory = join(this.config.storagePath, entry.name);
      try {
        if (await fileSize(join(directory, "metadata.json")) > 1_048_576) throw new Error("metadata-size");
        const data = JSON.parse(await fs.readFile(join(directory, "metadata.json"), "utf8"));
        if (!validMetadata(data, entry.name)) throw new Error("metadata-shape");
        const stream = this.runtime(data, directory);
        this.streams.set(data.id, stream);
        if (active(stream)) {
          data.status = "interrupted"; data.endedAt = this.now();
          data.expiresAt = this.now() + this.config.retentionMs;
        }
        // Unknown monotonic elapsed time is never inferred from a wall-clock jump.
        for (const segment of data.segments) if (!segment.released) {
          segment.releaseAt = Math.max(segment.releaseAt, this.now() + data.delayMs);
          stream.gates.set(segment.name, this.monotonic() + data.delayMs);
        }
        if (data.endedAt !== null && !data.endReleased) stream.endGate = this.monotonic() + data.delayMs;
        await this.scan(stream);
        await this.persist(stream);
      } catch { this.report("unreadable-stream-metadata", entry.name); }
    }
    await this.sweep();
  }

  runtime(data, directory) {
    return { data, directory, child: null, uploading: false, stopping: false, stopKind: null, stopPromise: null,
      closed: null, finishPromise: null, sourceIdentity: null, persistChain: Promise.resolve(), scanChain: Promise.resolve(), gates: new Map(), endGate: null,
      tokens: 1_048_576, tokenTime: this.monotonic(), evicted: false };
  }

  get(id) {
    const stream = this.streams.get(id);
    if (!stream) throw new MediaError(404, "stream-not-found");
    return stream;
  }

  async persist(stream) {
    const body = JSON.stringify(stream.data);
    stream.persistChain = stream.persistChain.catch(() => undefined).then(async () => {
      if (stream.evicted) return;
      const temporary = join(stream.directory, `metadata-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, body, { mode: 0o600 });
      await fs.rename(temporary, join(stream.directory, "metadata.json"));
    });
    return stream.persistChain;
  }

  async create(id, delayMs) {
    const creation = this.createChain.catch(() => undefined).then(() => this.createReserved(id, delayMs));
    this.createChain = creation;
    return creation;
  }

  async createReserved(id, delayMs) {
    if (!uuid.test(id) || !Number.isSafeInteger(delayMs) || delayMs !== MINIMUM_DELAY_MS) throw new MediaError(400, "invalid-stream-options");
    if (this.closing) throw new MediaError(503, "media-restarting");
    await this.sweep();
    if (this.streams.has(id)) throw new MediaError(409, "stream-already-exists");
    if ([...this.streams.values()].filter(active).length >= this.config.maxStreams) throw new MediaError(429, "stream-capacity");
    const ended = [...this.streams.values()].filter((stream) => !active(stream) && stream.data.status !== "expired")
      .sort((a, b) => a.data.endedAt - b.data.endedAt);
    while (this.storageBytes + 2_097_152 > this.config.maxStorageBytes && ended.length) {
      await this.expire(ended.shift()); this.storageBytes = await directorySize(this.config.storagePath);
    }
    if (this.storageBytes + 2_097_152 > this.config.maxStorageBytes) throw new MediaError(507, "storage-capacity");
    const createdAt = this.now();
    const data = { version: 1, id, delayMs, createdAt, lastInputAt: createdAt, endedAt: null,
      status: "starting", expiresAt: createdAt + this.config.maxDurationMs + this.config.retentionMs,
      nextSequence: 0, acceptedBytes: 0, segments: [], endReleased: false };
    const stream = this.runtime(data, join(this.config.storagePath, id));
    // Reserve identity and capacity synchronously before filesystem awaits.
    this.streams.set(id, stream);
    try {
      await fs.mkdir(stream.directory, { mode: 0o700 });
      await this.persist(stream);
      const child = this.encoder(stream.directory);
      stream.child = child;
      child.stdin?.on("error", () => undefined);
      let errorBytes = 0;
      child.stderr?.on("data", (chunk) => { errorBytes += chunk.length; if (errorBytes > 65_536) child.kill("SIGKILL"); });
      stream.closed = new Promise((resolve) => {
        child.once("error", () => resolve());
        child.once("close", () => resolve());
      });
      const ended = (status) => { void this.finish(stream, status).catch(() => this.report("stream-finalization-failed", id)); };
      child.once("error", () => ended("interrupted"));
      child.once("close", (code) => ended(code === 0 ? stream.stopKind ?? "interrupted" : "interrupted"));
      return { id, availableAt: createdAt + delayMs };
    } catch {
      data.status = "interrupted"; data.endedAt = this.now(); stream.endGate = this.monotonic() + delayMs;
      data.expiresAt = this.now() + this.config.retentionMs;
      await this.persist(stream).catch(() => undefined);
      throw new MediaError(503, "encoder-unavailable");
    }
  }

  async ingest(id, sequence, read) {
    const stream = this.get(id);
    if (!active(stream) || stream.stopping || this.closing) throw new MediaError(410, "stream-ended");
    if (!Number.isSafeInteger(sequence) || sequence !== stream.data.nextSequence) throw new MediaError(409, "chunk-sequence");
    if (stream.uploading) throw new MediaError(429, "upload-backpressure");
    if (this.now() - stream.data.createdAt >= this.config.maxDurationMs) { await this.stop(id); throw new MediaError(410, "duration-limit"); }
    stream.uploading = true;
    let writing = false;
    try {
      const buffer = await read();
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_CHUNK_BYTES) throw new MediaError(413, "chunk-size");
      const tokenNow = this.monotonic();
      stream.tokens = Math.min(1_048_576, stream.tokens + Math.max(0, tokenNow - stream.tokenTime) * 1048.576);
      stream.tokenTime = tokenNow;
      if (stream.tokens < buffer.length) throw new MediaError(429, "upload-rate");
      if (stream.data.acceptedBytes + buffer.length > this.config.maxStorageBytes) { await this.stop(id); throw new MediaError(413, "input-quota"); }
      stream.tokens -= buffer.length;
      writing = true;
      await writeEncoder(stream.child?.stdin, buffer);
      writing = false;
      if (!active(stream) || stream.stopping) throw new MediaError(410, "stream-ended");
      stream.data.nextSequence += 1;
      stream.data.acceptedBytes += buffer.length;
      stream.data.lastInputAt = this.now();
      stream.data.status = "live";
      await this.persist(stream);
      await this.scan(stream);
    } catch (error) {
      // Once bytes reached stdin an uncertain write cannot safely be replayed.
      if (writing && active(stream)) await this.stop(id, true).catch(() => undefined);
      throw error;
    } finally { stream.uploading = false; }
  }

  async scan(stream) {
    stream.scanChain = stream.scanChain.catch(() => undefined).then(async () => {
      if (stream.data.status === "expired" || stream.evicted) return;
      const source = join(stream.directory, "source.m3u8");
      const sourceStat = await fs.lstat(source).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!sourceStat) return;
      if (!sourceStat.isFile() || sourceStat.size > 1_048_576) throw new MediaError(503, "manifest-size");
      const sourceIdentity = identityOf(sourceStat);
      if (stream.sourceIdentity === sourceIdentity) return;
      let manifest;
      try { manifest = await fs.readFile(source, "utf8"); } catch (error) { if (error.code === "ENOENT") return; throw error; }
      let duration = null;
      let changed = false;
      const known = new Set(stream.data.segments.map((segment) => segment.name));
      for (const line of manifest.split(/\r?\n/)) {
        if (line.startsWith("#EXTINF:")) { duration = Number(line.slice(8).split(",")[0]); continue; }
        if (!segmentName.test(line) || !Number.isFinite(duration) || duration <= 0 || duration > 10) continue;
        if (known.has(line)) { duration = null; continue; }
        const stat = await fs.lstat(join(stream.directory, line)).catch(() => null);
        if (!stat?.isFile() || stat.size <= 0 || stat.size > 2_097_152) continue;
        if (stream.data.segments.length >= 3602) throw new MediaError(503, "segment-count");
        const createdAt = Math.max(this.now(), stat.ctimeMs, stat.birthtimeMs || 0);
        const completed = { name: line, duration, bytes: stat.size, createdAt, fileIdentity: identityOf(stat),
          releaseAt: createdAt + stream.data.delayMs, released: false };
        stream.data.segments.push(completed); known.add(line);
        stream.gates.set(line, this.monotonic() + stream.data.delayMs);
        duration = null; changed = true;
      }
      if (changed) { stream.data.segments.sort((a, b) => a.name.localeCompare(b.name)); await this.persist(stream); }
      stream.sourceIdentity = sourceIdentity;
    });
    return stream.scanChain;
  }

  released(stream, segment) {
    return segment.released || (this.now() >= segment.releaseAt && this.monotonic() >= (stream.gates.get(segment.name) ?? Infinity));
  }

  endedReleased(stream) {
    return stream.data.endReleased || (stream.data.endedAt !== null && this.now() >= stream.data.endedAt + stream.data.delayMs
      && this.monotonic() >= (stream.endGate ?? Infinity));
  }

  view(stream) {
    const first = stream.data.segments[0];
    const hasReleased = first && this.released(stream, first);
    const availableAt = first ? (first.released ? first.releaseAt : Math.max(first.releaseAt,
      this.now() + Math.max(0, (stream.gates.get(first.name) ?? Infinity) - this.monotonic()))) : stream.data.createdAt + stream.data.delayMs;
    const status = stream.data.status === "expired" ? "expired"
      : this.endedReleased(stream) ? stream.data.status
      : hasReleased ? "live" : stream.data.segments.length || stream.data.endedAt !== null ? "buffering" : "starting";
    return { id: stream.data.id, status, availableAt, ingestActive: active(stream) && !stream.stopping };
  }

  async status(id) { const stream = this.get(id); await this.scan(stream); return this.view(stream); }

  async playlist(id) {
    const stream = this.get(id);
    if (stream.data.status === "expired") throw new MediaError(410, "stream-expired");
    await this.scan(stream);
    const segments = [];
    // Publish a contiguous prefix only: a later segment never jumps ahead of an unreleased one.
    for (const segment of stream.data.segments) { if (!this.released(stream, segment)) break; segments.push(segment); }
    if (!segments.length) throw new MediaError(425, "video-buffering");
    let changed = false;
    for (const segment of segments) if (!segment.released) { segment.released = true; changed = true; }
    const ended = segments.length === stream.data.segments.length && this.endedReleased(stream);
    if (ended && !stream.data.endReleased) { stream.data.endReleased = true; changed = true; }
    if (changed) await this.persist(stream);
    return ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.max(2, ...segments.map((segment) => Math.ceil(segment.duration)))}`,
      "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-INDEPENDENT-SEGMENTS",
      ...segments.flatMap((segment) => [`#EXTINF:${segment.duration.toFixed(6)},`, `segments/${segment.name}`]),
      ...(ended ? ["#EXT-X-ENDLIST"] : []), ""].join("\n");
  }

  async segment(id, name) {
    if (!segmentName.test(name)) throw new MediaError(404, "segment-not-found");
    const stream = this.get(id);
    if (stream.data.status === "expired") throw new MediaError(410, "stream-expired");
    await this.scan(stream);
    const segment = stream.data.segments.find((candidate) => candidate.name === name);
    if (!segment || !this.released(stream, segment)) throw new MediaError(404, "segment-not-found");
    if (!segment.released) { segment.released = true; await this.persist(stream); }
    const handle = await fs.open(join(stream.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!handle) throw new MediaError(404, "segment-not-found");
    const stat = await handle.stat();
    const fileIdentity = identityOf(stat);
    if (!stat.isFile() || fileIdentity !== segment.fileIdentity) {
      await handle.close();
      if (stat.isFile() && stat.size > 0 && stat.size <= 2_097_152) {
        // Completed output is immutable. Any replacement must earn a fresh full delay.
        segment.createdAt = Math.max(this.now(), stat.ctimeMs, stat.birthtimeMs || 0);
        segment.releaseAt = segment.createdAt + stream.data.delayMs; segment.released = false;
        segment.bytes = stat.size; segment.fileIdentity = fileIdentity;
        stream.gates.set(name, this.monotonic() + stream.data.delayMs);
        await this.persist(stream);
      }
      throw new MediaError(404, "segment-not-found");
    }
    return { handle, bytes: stat.size };
  }

  async finish(stream, status) {
    if (stream.finishPromise) return stream.finishPromise;
    if (!active(stream)) return;
    stream.data.status = status;
    stream.data.endedAt = this.now();
    stream.data.expiresAt = this.now() + this.config.retentionMs;
    stream.endGate = this.monotonic() + stream.data.delayMs;
    stream.finishPromise = (async () => { await this.scan(stream); await this.persist(stream); })();
    return stream.finishPromise;
  }

  async stop(id, interrupted = false) {
    const stream = this.get(id);
    if (stream.stopPromise) return stream.stopPromise;
    if (!active(stream)) { await stream.finishPromise; return this.view(stream); }
    stream.stopping = true;
    stream.stopKind = interrupted ? "interrupted" : "stopped";
    stream.stopPromise = (async () => {
      stream.child?.stdin?.end();
      if (stream.closed) {
        const clean = await settlesWithin(stream.closed, 5_000);
        if (!clean) { stream.stopKind = "interrupted"; stream.child?.kill("SIGKILL"); interrupted = true; await settlesWithin(stream.closed, 500); }
      }
      await this.finish(stream, interrupted ? "interrupted" : "stopped");
      return this.view(stream);
    })();
    return stream.stopPromise;
  }

  async expire(stream) {
    if (active(stream)) await this.stop(stream.data.id, true);
    await stream.persistChain;
    stream.data.status = "expired"; stream.data.segments = []; stream.data.endReleased = true;
    for (const entry of await fs.readdir(stream.directory)) if (entry !== "metadata.json") await fs.rm(join(stream.directory, entry), { force: true, recursive: true });
    await this.persist(stream);
  }

  async sweep() {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      for (const stream of this.streams.values()) {
        if (active(stream) && (this.now() - stream.data.lastInputAt >= this.config.idleTimeoutMs
          || this.now() - stream.data.createdAt >= this.config.maxDurationMs)) await this.stop(stream.data.id, true);
        else if (stream.data.status !== "expired") await this.scan(stream);
        if (!active(stream) && stream.data.status !== "expired" && this.now() >= stream.data.expiresAt) await this.expire(stream);
      }
      this.storageBytes = await directorySize(this.config.storagePath);
      const headroom = [...this.streams.values()].filter(active).length * 2_097_152;
      const ended = [...this.streams.values()].filter((stream) => !active(stream) && stream.data.status !== "expired")
        .sort((a, b) => a.data.endedAt - b.data.endedAt);
      while (this.storageBytes + headroom > this.config.maxStorageBytes && ended.length) {
        await this.expire(ended.shift()); this.storageBytes = await directorySize(this.config.storagePath);
      }
      if (this.storageBytes + headroom > this.config.maxStorageBytes) for (const stream of this.streams.values()) {
        if (active(stream)) { await this.stop(stream.data.id, true); await this.expire(stream); }
      }
      // Expired tombstones block accidental ID reuse while bounded in time/count.
      const tombstones = [...this.streams.values()].filter((stream) => stream.data.status === "expired")
        .sort((a, b) => a.data.createdAt - b.data.createdAt);
      for (const stream of tombstones) if (this.streams.size > 1000 || this.now() - stream.data.createdAt > 604_800_000) {
        stream.evicted = true; await stream.persistChain; this.streams.delete(stream.data.id); await fs.rm(stream.directory, { recursive: true, force: true });
      }
      this.storageBytes = await directorySize(this.config.storagePath);
    })();
    try { await this.sweeping; } finally { this.sweeping = null; }
  }

  async close() {
    this.closing = true;
    await this.createChain.catch(() => undefined);
    await this.sweeping?.catch(() => undefined);
    await Promise.allSettled([...this.streams.values()].filter(active).map((stream) => this.stop(stream.data.id, true)));
    await Promise.allSettled([...this.streams.values()].map((stream) => stream.persistChain));
  }
}

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const fail = (status, code) => { cleanup(); request.pause(); request.closeAfterResponse = true; reject(new MediaError(status, code)); };
    const onData = (chunk) => { bytes += chunk.length; if (bytes > maximum) fail(413, "body-size"); else chunks.push(chunk); };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks, bytes)); };
    const onError = () => fail(400, "body-interrupted");
    const cleanup = () => { clearTimeout(timer); request.off("data", onData); request.off("end", onEnd); request.off("aborted", onError); request.off("error", onError); };
    const timer = setTimeout(() => fail(408, "body-timeout"), 10_000);
    request.on("data", onData); request.once("end", onEnd); request.once("aborted", onError); request.once("error", onError);
    const length = request.headers["content-length"];
    if (length && Number(length) > maximum) fail(413, "body-size");
  });
}

export function createMediaServer(manager, secret) {
  const expected = Buffer.from(secret);
  let requests = 0;
  let readers = 0;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 12_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status, value) => {
      response.statusCode = status; response.setHeader("Content-Type", "application/json");
      if (request.closeAfterResponse || request.method !== "GET") response.setHeader("Connection", "close");
      response.end(JSON.stringify(value), () => { if (request.closeAfterResponse) request.destroy(); });
    };
    const provided = request.headers["x-trinity-media-key"];
    if (typeof provided !== "string" || Buffer.byteLength(provided) !== expected.length || !timingSafeEqual(Buffer.from(provided), expected)) {
      request.closeAfterResponse = true; return send(401, { error: "authentication-required" });
    }
    if (requests >= 32) { request.closeAfterResponse = true; return send(503, { error: "request-capacity" }); }
    requests += 1;
    let countedReader = false;
    const finished = () => { requests -= 1; if (countedReader) readers -= 1; };
    response.once("close", finished);
    try {
      if (/%(?:2f|5c|00)/i.test(request.url) || request.url.includes("..") || request.url.includes("\\")) throw new MediaError(404, "resource-not-found");
      const url = new URL(request.url, "http://media.internal");
      if (request.method === "GET" && url.pathname === "/healthz") return send(200, { ok: !manager.closing,
        activeStreams: [...manager.streams.values()].filter(active).length, storageBytes: manager.storageBytes });
      if (request.method === "POST" && url.pathname === "/streams") {
        if (!request.headers["content-type"]?.startsWith("application/json")) throw new MediaError(415, "json-required");
        let body; try { body = JSON.parse((await readBody(request, 4096)).toString("utf8")); } catch (error) { if (error instanceof MediaError) throw error; throw new MediaError(400, "invalid-json"); }
        if (!body || Object.keys(body).sort().join(",") !== "delayMs,id") throw new MediaError(400, "invalid-stream-options");
        return send(201, await manager.create(body.id, body.delayMs));
      }
      const match = url.pathname.match(/^\/streams\/([^/]+)(?:\/(chunks|stop|index\.m3u8|segments\/([^/]+)))?$/);
      if (!match || !uuid.test(match[1])) throw new MediaError(404, "resource-not-found");
      const id = match[1]; const resource = match[2];
      if (request.method === "GET" && !resource) return send(200, await manager.status(id));
      if (request.method === "POST" && resource === "chunks") {
        if (request.headers["content-type"] !== "application/octet-stream") throw new MediaError(415, "binary-required");
        const raw = url.searchParams.get("sequence");
        if (url.searchParams.size !== 1 || !raw || !/^(?:0|[1-9][0-9]{0,6})$/.test(raw)) throw new MediaError(400, "invalid-sequence");
        await manager.ingest(id, Number(raw), () => readBody(request, MAX_CHUNK_BYTES));
        return send(202, { accepted: true });
      }
      if (request.method === "POST" && resource === "stop") { await readBody(request, 1024); return send(200, await manager.stop(id)); }
      if (request.method === "GET" && resource === "index.m3u8") {
        const playlist = await manager.playlist(id);
        response.setHeader("Content-Type", "application/vnd.apple.mpegurl"); response.end(playlist); return;
      }
      if (request.method === "GET" && resource?.startsWith("segments/") && match[3]) {
        if (readers >= 16) throw new MediaError(503, "read-capacity");
        readers += 1; countedReader = true;
        const { handle, bytes } = await manager.segment(id, match[3]);
        response.setHeader("Content-Type", "video/mp2t"); response.setHeader("Content-Length", bytes);
        const source = createReadStream("", { fd: handle.fd, autoClose: false });
        const close = () => { source.destroy(); void handle.close().catch(() => undefined); };
        response.once("close", close); source.once("error", () => response.destroy()); source.once("end", close);
        source.pipe(response); return;
      }
      throw new MediaError(404, "resource-not-found");
    } catch (error) {
      if (!response.headersSent) send(error instanceof MediaError ? error.status : 503, { error: error instanceof MediaError ? error.code : "media-unavailable" });
      else response.destroy();
    }
  });
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 5_000;
  return server;
}
