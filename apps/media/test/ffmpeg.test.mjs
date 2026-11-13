import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fixture, isError, releaseAll } from "./helpers.mjs";

async function command(binary, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Fixture command timed out.")); }, 20000);
    child.stdout.on("data", (chunk) => { if (stdout.length < 32768) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`Fixture command failed (${code}): ${stderr}`)); });
  });
}

for (const format of ["webm", "mp4"]) test(`real browser-format ${format} becomes 480p15 H264/AAC HLS, with physical segment release gates`, {
  skip: process.env.TRINITY_MEDIA_REAL_FFMPEG !== "1", timeout: 35000
}, async (t) => {
  const f = await fixture(t, {}, { encoder: undefined });
  const input = join(f.storagePath, `fixture.${format}`);
  const codecs = format === "webm"
    ? ["-c:v", "libvpx", "-threads", "1", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus", "-b:a", "48k", "-f", "webm"]
    : ["-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4"];
  await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "4", ...codecs, input]);
  const bytes = await fs.readFile(input);
  const id = await f.create();
  for (let offset = 0, sequence = 0; offset < bytes.length; offset += 131072, sequence++) {
    await f.manager.ingest(id, sequence, async () => bytes.subarray(offset, offset + 131072));
  }
  await f.manager.stop(id);
  const stream = f.manager.get(id);
  assert.equal(stream.data.status, "stopped", "FFmpeg exits cleanly after browser input closes");
  assert.ok(stream.data.segments.length >= 2, "real FFmpeg generated multiple completed two-second segments");
  const first = stream.data.segments[0]; const second = stream.data.segments[1];
  const physical = await fs.stat(join(stream.directory, first.name));
  assert.ok(first.releaseAt >= physical.ctimeMs + 120000);
  assert.ok(first.releaseAt >= physical.birthtimeMs + 120000);
  await assert.rejects(f.manager.playlist(id), isError(425));
  await assert.rejects(f.manager.segment(id, first.name), isError(404));
  f.clock.wall = first.releaseAt - 1; f.clock.mono = stream.gates.get(first.name) - 1;
  await assert.rejects(f.manager.playlist(id), isError(425));
  f.clock.advance(1);
  const initialPlaylist = await f.manager.playlist(id);
  assert.match(initialPlaylist, new RegExp(first.name));
  assert.doesNotMatch(initialPlaylist, new RegExp(second.name));
  assert.doesNotMatch(initialPlaylist, /ENDLIST/);
  await assert.rejects(f.manager.segment(id, second.name), isError(404));
  const opened = await f.manager.segment(id, first.name); await opened.handle.close();
  const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_streams", "-of", "json", join(stream.directory, first.name)]));
  const video = probe.streams.find((entry) => entry.codec_type === "video");
  const audio = probe.streams.find((entry) => entry.codec_type === "audio");
  assert.equal(video.codec_name, "h264"); assert.equal(video.width, 854); assert.equal(video.height, 480); assert.equal(video.r_frame_rate, "15/1");
  assert.equal(audio.codec_name, "aac");
  releaseAll(f.manager, id, f.clock);
  assert.match(await f.manager.playlist(id), /#EXT-X-ENDLIST/);
  t.diagnostic(`Verified ${stream.data.segments.length} real segments, H264 854x480 at 15fps + AAC; playlist, guessed-segment and final-playlist gates reject before physical completion +120000ms.`);
});
