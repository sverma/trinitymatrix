import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MediaManager, loadMediaConfig, MINIMUM_DELAY_MS } from "../src/worker.mjs";

export const secret = "test-media-secret-0123456789abcdef0123456789abcdef";
export function fakeEncoder() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.received = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) { child.received.push(Buffer.from(chunk)); callback(); } });
  let closed = false;
  const close = () => { if (!closed) { closed = true; child.emit("close", 0, null); } };
  child.stdin.once("finish", () => queueMicrotask(close));
  child.kill = () => { child.stdin.destroy(); queueMicrotask(close); return true; };
  return child;
}

export async function fixture(t, overrides = {}, options = {}) {
  const storagePath = await fs.mkdtemp(join(tmpdir(), "trinity-media-"));
  const clock = { wall: Date.now(), mono: 0, advance(ms) { this.wall += ms; this.mono += ms; } };
  const config = { ...loadMediaConfig({ BROADCAST_MEDIA_SECRET: secret, MEDIA_STORAGE_PATH: storagePath }), ...overrides };
  const encoders = [];
  const managerOptions = { now: () => clock.wall, monotonic: () => clock.mono,
    encoder: () => { const child = fakeEncoder(); encoders.push(child); return child; }, ...options };
  const manager = new MediaManager(config, managerOptions);
  await manager.init();
  const managers = [manager];
  t.after(async () => { for (const item of managers) await item.close(); await fs.rm(storagePath, { recursive: true, force: true }); });
  return { storagePath, config, clock, manager, encoders, managers, managerOptions,
    async create() { const id = randomUUID(); await manager.create(id, MINIMUM_DELAY_MS); return id; } };
}

export async function publish(manager, id, entries = [{ name: "segment-000000.ts", duration: 2, body: "encoded transport stream" }]) {
  const directory = manager.get(id).directory;
  for (const entry of entries) {
    try { await fs.writeFile(join(directory, entry.name), entry.body, { flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  await fs.writeFile(join(directory, "source.m3u8"), ["#EXTM3U", ...entries.flatMap((entry) => [`#EXTINF:${entry.duration},`, entry.name]), ""].join("\n"));
  await manager.status(id);
}

export function releaseAll(manager, id, clock) {
  const stream = manager.get(id);
  const wall = Math.max(...stream.data.segments.map((segment) => segment.releaseAt), (stream.data.endedAt ?? 0) + MINIMUM_DELAY_MS);
  const mono = Math.max(...stream.gates.values(), stream.endGate ?? 0);
  clock.wall = Math.max(clock.wall, wall);
  clock.mono = Math.max(clock.mono, mono);
}

export const isError = (status, code) => (error) => error.status === status && (!code || error.code === code);
