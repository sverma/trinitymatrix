import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { Writable } from "node:stream";
import { MediaManager, createMediaServer, loadMediaConfig, MAX_CHUNK_BYTES, MINIMUM_DELAY_MS, ffmpegArguments } from "../src/worker.mjs";
import { fixture, publish, releaseAll, secret, isError } from "./helpers.mjs";

test("configuration fixes the minimum delay and bounds resources", () => {
  assert.throws(() => loadMediaConfig({ BROADCAST_MEDIA_SECRET: "short" }));
  assert.throws(() => loadMediaConfig({ BROADCAST_MEDIA_SECRET: secret, MEDIA_STORAGE_PATH: "relative" }));
  assert.throws(() => loadMediaConfig({ BROADCAST_MEDIA_SECRET: secret, MEDIA_MAX_DURATION_SECONDS: "7201" }));
  const args = ffmpegArguments("/private/data", 7200000);
  assert.ok(args.includes("libx264")); assert.ok(args.includes("aac")); assert.ok(args.includes("independent_segments+temp_file"));
  assert.ok(args.includes("15")); assert.ok(args.includes("pipe:0")); assert.ok(!args.includes("http"));
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "pipe");
  assert.equal(args[args.indexOf("-format_whitelist") + 1], "matroska,webm,mov");
  assert.ok(!args.includes("-f") || args.indexOf("-f") > args.indexOf("-i"), "input format is restricted autodetection, not forced WebM");
});

test("playlist, guessed segments, ENDLIST and a wall-clock jump cannot bypass 120 physical seconds", async (t) => {
  const { manager, clock, create } = await fixture(t);
  const id = await create();
  await publish(manager, id);
  const stream = manager.get(id); const segment = stream.data.segments[0];
  assert.ok(segment.releaseAt >= segment.createdAt + MINIMUM_DELAY_MS);
  await assert.rejects(manager.playlist(id), isError(425));
  await assert.rejects(manager.segment(id, segment.name), isError(404));
  clock.wall += 1_000_000;
  await assert.rejects(manager.playlist(id), isError(425));
  await assert.rejects(manager.segment(id, segment.name), isError(404));
  clock.mono = 119999;
  await assert.rejects(manager.playlist(id), isError(425));
  clock.mono = 120000;
  const firstPlaylist = await manager.playlist(id);
  assert.match(firstPlaylist, /segments\/segment-000000.ts/);
  assert.doesNotMatch(firstPlaylist, /ENDLIST|source.m3u8|metadata/);
  const opened = await manager.segment(id, segment.name); await opened.handle.close();
  await manager.stop(id);
  assert.doesNotMatch(await manager.playlist(id), /ENDLIST/);
  clock.advance(119999);
  assert.doesNotMatch(await manager.playlist(id), /ENDLIST/);
  clock.advance(1);
  assert.match(await manager.playlist(id), /#EXT-X-ENDLIST/);
});

test("segments are gated separately and temporary files are never published", async (t) => {
  const { manager, clock, create } = await fixture(t); const id = await create();
  await publish(manager, id);
  const first = manager.get(id).data.segments[0];
  clock.advance(2000);
  await publish(manager, id, [
    { name: "segment-000000.ts", duration: 2, body: "encoded transport stream" },
    { name: "segment-000001.ts", duration: 2, body: "next encoded segment" },
    { name: "segment-000002.ts.tmp", duration: 2, body: "incomplete" }
  ]);
  assert.equal(manager.get(id).data.segments.length, 2);
  clock.wall = Math.max(clock.wall, first.releaseAt); clock.mono = 120000;
  const list = await manager.playlist(id);
  assert.match(list, /segment-000000/); assert.doesNotMatch(list, /segment-000001|tmp/);
  await assert.rejects(manager.segment(id, "segment-000001.ts"), isError(404));
  releaseAll(manager, id, clock);
  assert.match(await manager.playlist(id), /segment-000001/);
});

test("replacing a completed file, even with the same byte length, starts a new full segment gate", async (t) => {
  const f = await fixture(t); const id = await f.create(); await publish(f.manager, id);
  releaseAll(f.manager, id, f.clock); await f.manager.playlist(id);
  const filename = join(f.storagePath, id, "segment-000000.ts");
  await fs.writeFile(filename + ".new", "replacement safe stream");
  await fs.rename(filename + ".new", filename);
  await assert.rejects(f.manager.segment(id, "segment-000000.ts"), isError(404));
  await assert.rejects(f.manager.playlist(id), isError(425));
  f.clock.advance(119999); await assert.rejects(f.manager.segment(id, "segment-000000.ts"), isError(404));
  releaseAll(f.manager, id, f.clock);
  const opened = await f.manager.segment(id, "segment-000000.ts");
  assert.equal(await opened.handle.readFile("utf8"), "replacement safe stream"); await opened.handle.close();
});

test("strict sequences, upload locks, byte limits and token bucket preserve input order", async (t) => {
  const { manager, encoders, create, clock } = await fixture(t); const id = await create();
  await assert.rejects(manager.ingest(id, 1, async () => Buffer.from("bad")), isError(409));
  let release; const pending = manager.ingest(id, 0, () => new Promise((resolve) => { release = resolve; }));
  await assert.rejects(manager.ingest(id, 0, async () => Buffer.from("race")), isError(429, "upload-backpressure"));
  release(Buffer.alloc(MAX_CHUNK_BYTES)); await pending;
  await assert.rejects(manager.ingest(id, 0, async () => Buffer.from("duplicate")), isError(409));
  await assert.rejects(manager.ingest(id, 1, async () => Buffer.alloc(MAX_CHUNK_BYTES + 1)), isError(413));
  await manager.ingest(id, 1, async () => Buffer.alloc(MAX_CHUNK_BYTES));
  await assert.rejects(manager.ingest(id, 2, async () => Buffer.from("limited")), isError(429, "upload-rate"));
  clock.advance(1000); await manager.ingest(id, 2, async () => Buffer.from("after refill"));
  assert.equal(encoders[0].received.length, 3); assert.equal(manager.get(id).data.nextSequence, 3);
});

test("encoder backpressure delays acceptance; uncertain failed writes interrupt instead of being replayed", async (t) => {
  const f = await fixture(t); const id = await f.create(); const child = f.encoders[0];
  let writeCallback;
  child.stdin = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { writeCallback = callback; } });
  child.stdin.once("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
  child.stdin.on("error", () => queueMicrotask(() => child.emit("close", 1, null)));
  let accepted = false;
  const pending = f.manager.ingest(id, 0, async () => Buffer.from("waiting for encoder drain")).then(() => { accepted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepted, false); assert.equal(f.manager.get(id).data.nextSequence, 0);
  writeCallback(); await pending;
  assert.equal(accepted, true); assert.equal(f.manager.get(id).data.nextSequence, 1);
  const failed = f.manager.ingest(id, 1, async () => Buffer.from("possibly partially written"));
  await new Promise((resolve) => setImmediate(resolve));
  writeCallback(new Error("private encoder diagnostic must not escape"));
  await assert.rejects(failed, (error) => error.code === "encoder-unavailable" && !error.message.includes("private"));
  assert.equal(f.manager.get(id).data.status, "interrupted");
  await assert.rejects(f.manager.ingest(id, 1, async () => Buffer.from("unsafe retry")), isError(410));
});

test("restart interrupts ingest and holds unreleased segments for a fresh full delay", async (t) => {
  const f = await fixture(t); const id = await f.create(); await publish(f.manager, id);
  f.clock.advance(110000); await f.manager.close();
  const restarted = new MediaManager(f.config, f.managerOptions); f.managers.push(restarted); await restarted.init();
  assert.equal((await restarted.status(id)).ingestActive, false);
  await assert.rejects(restarted.ingest(id, 0, async () => Buffer.from("resume")), isError(410));
  f.clock.advance(119999); await assert.rejects(restarted.playlist(id), isError(425));
  f.clock.advance(1); assert.match(await restarted.playlist(id), /segment-000000/);
  await restarted.close();
  const replay = new MediaManager(f.config, f.managerOptions); f.managers.push(replay); await replay.init();
  assert.match(await replay.playlist(id), /segment-000000/);
});

test("restart never launches encoders for an unclean active recording", async (t) => {
  const f = await fixture(t); const id = await f.create(); await publish(f.manager, id);
  const restarted = new MediaManager(f.config, f.managerOptions); f.managers.push(restarted); await restarted.init();
  assert.equal(f.encoders.length, 1); assert.equal(restarted.get(id).data.status, "interrupted");
  assert.equal((await restarted.status(id)).ingestActive, false);
});

test("capacity reservations are atomic and idle/duration stops persist", async (t) => {
  const f = await fixture(t, { maxDurationMs: 10000, idleTimeoutMs: 5000 });
  const results = await Promise.allSettled([f.create(), f.create()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "stream-capacity");
  const id = results.find((result) => result.status === "fulfilled").value;
  f.clock.advance(5000); await f.manager.sweep();
  assert.equal(f.manager.get(id).data.status, "interrupted");
  assert.equal(f.encoders[0].stdin.writableEnded, true);
  const next = await f.create(); f.clock.advance(9000);
  await f.manager.ingest(next, 0, async () => Buffer.from("still below max"));
  f.clock.advance(1000); await f.manager.sweep();
  assert.equal(f.manager.get(next).data.status, "interrupted");
  const saved = JSON.parse(await fs.readFile(join(f.storagePath, next, "metadata.json"), "utf8"));
  assert.equal(saved.status, "interrupted"); assert.equal(saved.endedAt, f.clock.wall);
});

test("retention removes recordings and storage pressure evicts oldest ended recording first", async (t) => {
  const f = await fixture(t, { maxStorageBytes: 5_000_000, retentionMs: 200000 });
  const older = await f.create();
  await publish(f.manager, older, [{ name: "segment-000000.ts", duration: 2, body: Buffer.alloc(1600000) }]);
  await f.manager.stop(older); f.clock.advance(1);
  const newer = await f.create();
  await publish(f.manager, newer, [{ name: "segment-000000.ts", duration: 2, body: Buffer.alloc(1600000) }]);
  await f.manager.stop(newer); f.clock.advance(1);
  const live = await f.create();
  assert.equal(f.manager.get(older).data.status, "expired");
  assert.equal(f.manager.get(newer).data.status, "stopped");
  assert.equal((await fs.readdir(join(f.storagePath, older))).join(","), "metadata.json");
  await f.manager.stop(live); f.clock.advance(200001); await f.manager.sweep();
  assert.equal(f.manager.get(newer).data.status, "expired");
  await assert.rejects(f.manager.playlist(newer), isError(410));
});

test("metadata corruption and symlinks cannot turn files into playable segments", async (t) => {
  const f = await fixture(t); const id = await f.create();
  const target = join(f.storagePath, "private-secret"); await fs.writeFile(target, "not-video");
  await fs.symlink(target, join(f.storagePath, id, "segment-000000.ts"));
  await fs.writeFile(join(f.storagePath, id, "source.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment-000000.ts\n");
  assert.equal((await f.manager.status(id)).status, "starting");
  await assert.rejects(f.manager.segment(id, "segment-000000.ts"), isError(404));
  await f.manager.close();
  await fs.writeFile(join(f.storagePath, id, "metadata.json"), "broken");
  const reports = []; const restarted = new MediaManager(f.config, { ...f.managerOptions, report: (...args) => reports.push(args) });
  f.managers.push(restarted); await restarted.init();
  assert.equal(restarted.streams.size, 0); assert.equal(reports[0][0], "unreadable-stream-metadata");
});

async function httpFixture(t) {
  const f = await fixture(t); const server = createMediaServer(f.manager, secret);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...f, origin, server,
    fetch(path, options = {}) { return fetch(origin + path, { ...options, headers: { "X-Trinity-Media-Key": secret, ...options.headers } }); } };
}

test("HTTP auth applies to every resource; traversal/raw manifests and oversized bodies stay private", async (t) => {
  const f = await httpFixture(t);
  for (const path of ["/healthz", "/streams", `/streams/${randomUUID()}/index.m3u8`]) {
    const response = await fetch(f.origin + path); assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), new RegExp(secret));
  }
  assert.equal((await f.fetch("/healthz")).status, 200);
  const id = randomUUID();
  let response = await f.fetch("/streams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, delayMs: 119999 }) });
  assert.equal(response.status, 400);
  response = await f.fetch("/streams", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, delayMs: 120000 }) });
  assert.equal(response.status, 201); assert.equal((await response.json()).id, id);
  for (const suffix of ["source.m3u8", "metadata.json", "segments/segment-000000.ts.tmp", "segments/%2fetc%2fpasswd", "segments/%5csecret"]) {
    assert.equal((await f.fetch(`/streams/${id}/${suffix}`)).status, 404);
  }
  response = await f.fetch(`/streams/${id}/chunks?sequence=0`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "wrong" }); assert.equal(response.status, 415);
  response = await f.fetch(`/streams/${id}/chunks?sequence=0`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "first" }); assert.equal(response.status, 202);
  response = await f.fetch(`/streams/${id}/chunks?sequence=00`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: "bad sequence" }); assert.equal(response.status, 400);
  response = await f.fetch(`/streams/${id}/stop`, { method: "POST", body: Buffer.alloc(1025) }); assert.equal(response.status, 413);
  await publish(f.manager, id);
  assert.equal((await f.fetch(`/streams/${id}/index.m3u8`)).status, 425);
  assert.equal((await f.fetch(`/streams/${id}/segments/segment-000000.ts`)).status, 404);
  releaseAll(f.manager, id, f.clock);
  response = await f.fetch(`/streams/${id}/index.m3u8`); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
  response = await f.fetch(`/streams/${id}/segments/segment-000000.ts`); assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "video/mp2t");
  assert.equal(await response.text(), "encoded transport stream");
});

test("HTTP header and missing body limits reject promptly without forwarding bytes", async (t) => {
  const f = await httpFixture(t); const id = await f.create();
  const result = await new Promise((resolve, reject) => {
    const req = request(`${f.origin}/streams/${id}/chunks?sequence=0`, { method: "POST", headers: {
      "X-Trinity-Media-Key": secret, "Content-Type": "application/octet-stream", "Content-Length": MAX_CHUNK_BYTES + 1
    } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    req.once("error", reject); req.end();
  });
  assert.equal(result, 413); assert.equal(f.encoders[0].received.length, 0);
});
