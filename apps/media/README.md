# Private delayed media worker

This service accepts one continuous browser WebM VP8/Opus or fragmented MP4 H264/AAC recording as ordered binary chunks, transcodes it to H264/AAC at 854×480 and 15 fps, and serves a reconstructed two-second HLS event playlist. Input autodetection permits only Matroska/WebM/MOV demuxers and the pipe protocol; playlists, network requests and external local file inputs are disallowed. It has no public ingress or raw recording endpoint. The application server authenticates uploads, manages broadcast consent, and proxies authorized delayed playback.

Every completed segment is withheld until **at least 120 seconds after its physical completion was observed on the server**. Both the playlist and direct segment route enforce the gate. Each gate requires wall time and monotonic elapsed time; a forward system-clock adjustment cannot release a segment early. FFmpeg writes temporary segments and renames completed files; the worker only discovers final files listed in FFmpeg's private manifest. Source timestamps and client-supplied timestamps cannot shorten the delay. `ENDLIST` and the public stopped status are delayed too.

## Internal API

Every request, including health checks, requires `X-Trinity-Media-Key: <BROADCAST_MEDIA_SECRET>`. Use a private Docker network; do not publish port 8082, this volume, or any FFmpeg files through nginx.

| Method/path | Request | Response |
| --- | --- | --- |
| `GET /healthz` | — | `200 {ok,activeStreams,storageBytes}` |
| `POST /streams` | JSON `{id: UUID, delayMs: 120000}` | `201 {id,availableAt}` |
| `POST /streams/:id/chunks?sequence=N` | `application/octet-stream`, 1–524288 bytes | `202 {accepted:true}` |
| `POST /streams/:id/stop` | Empty body | `200` stream status |
| `GET /streams/:id` | — | `200 {id,status,availableAt,ingestActive}` |
| `GET /streams/:id/index.m3u8` | — | Delayed event playlist; `425` while buffering |
| `GET /streams/:id/segments/segment-NNNNNN.ts` | — | Completed, released segment only; `404` otherwise |

`availableAt` is a server epoch timestamp in milliseconds. The initial value is a lower bound; the first physical segment may move it later. Status is `starting`, `buffering`, `live`, `stopped`, `interrupted`, or `expired`. **`ingestActive` is internal operational state and must not be forwarded as an undelayed public event.** No responses contain original browser chunks, source manifests, filesystem paths, child-process diagnostics, or credentials. Responses use private/no-store caching.

Upload sequence starts at 0 and increments only after a successful accepted write; duplicate and out-of-order chunks return `409`. Do not send overlapping uploads: they receive `429`. Backpressure propagates from FFmpeg to the HTTP response. If a write may have partially reached FFmpeg and fails, the recording ends as interrupted; replaying uncertain bytes would corrupt the stream. The browser must create a fresh recording/session after an encoder or worker restart. A `429` upload rate response leaves the sequence unchanged; retry the same buffered chunk after waiting.

## Limits and persistence

| Variable | Default | Bounds/meaning |
| --- | --- | --- |
| `BROADCAST_MEDIA_SECRET` | Required | 32–256 non-whitespace characters; shared only with the application server |
| `MEDIA_STORAGE_PATH` | `/data/media` | Absolute persistent volume path |
| `MEDIA_HOST` / `MEDIA_PORT` | `0.0.0.0` / `8082` | Private network bind |
| `MEDIA_MAX_STREAMS` | `1` | 1–8 simultaneous encoders; raise only after capacity testing |
| `MEDIA_MAX_STORAGE_BYTES` | `2147483648` | 16 MiB–20 GiB disk budget |
| `MEDIA_MAX_DURATION_SECONDS` | `7200` | 1–7200; enforced in worker and FFmpeg |
| `MEDIA_IDLE_TIMEOUT_SECONDS` | `30` | 5–300; ends abandoned input |
| `MEDIA_RETENTION_SECONDS` | `21600` | 120–604800; replay lifetime after stop |
| `MEDIA_FFMPEG_PATH` | `ffmpeg` | Executable path; no shell is used |

Chunks are limited to 512 KiB, with a 1 MiB burst and 1 MiB/second refill per stream. Only one in-flight upload is allowed per stream. There are at most 32 concurrent HTTP requests and 16 segment readers. Headers, request bodies, manifests, segment sizes/counts, FFmpeg diagnostics, duration, input bytes and disk usage are bounded. A maintenance sweep runs every second. Storage accounting includes unknown files; when space is needed, the oldest ended recordings expire first. If active data still exceeds the budget, recording is interrupted and removed. Allow a small temporary filesystem margin for an in-flight segment, metadata and the sweep interval.

Metadata is atomically replaced with mode 0600 in per-stream directories created with mode 0700. Restarted active recordings become interrupted; completed released segments remain replayable. Unreleased segments restart a conservative full 120-second hold because elapsed monotonic time across a process restart cannot be verified. Retention and interrupted status survive restart. Expiry removes video files and keeps a bounded UUID tombstone. No ingest is reattached to an old FFmpeg process.

The Docker image runs as the `node` user. Run it with a read-only root filesystem, a writable media volume owned by UID/GID 1000, a small `/tmp` tmpfs, no published host port, dropped capabilities, `no-new-privileges`, and explicit CPU/memory/PID limits. FFmpeg receives only PATH/LANG settings, never the media key or application credentials. The worker binds UUIDs and fixed segment filenames without path interpolation from uploads; segment opens reject symlinks.

## Verification

```sh
npm test --workspace @trinitymatrix/media
docker build -f apps/media/Dockerfile -t trinitymatrix-media:test .
docker run --rm --read-only --tmpfs /tmp:size=64m \
  -e TRINITY_MEDIA_REAL_FFMPEG=1 \
  --mount type=bind,src="$PWD/apps/media",dst=/test,readonly \
  --entrypoint node trinitymatrix-media:test --test /test/test/worker.test.mjs /test/test/ffmpeg.test.mjs
```

The integration tests create synthetic VP8/Opus WebM and fragmented H264/AAC MP4, pass actual chunks through the production FFmpeg command, check H264/AAC and 854×480/15 fps with ffprobe, and use an injected clock to test the exact server release boundary without waiting two minutes. Unit/HTTP tests cover authentication, traversal, direct-segment guessing, clock jumps, strict sequences, backpressure/rate limits, capacity, restart, expiry, symlinks and eviction.

Primary references: [FFmpeg HLS muxer](https://ffmpeg.org/ffmpeg-formats.html#hls-2), [Node stream backpressure](https://nodejs.org/api/stream.html#event-drain), [Node filesystem timestamps](https://nodejs.org/api/fs.html#class-fsstats).
