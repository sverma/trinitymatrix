# Live broadcasts

TrinityMatrix broadcasts public human, AI-only and mixed tables at `/live`.
Each shareable `/watch/<public-table-name>` page has a delayed table, all hands,
move history, pause/seek/live controls, audience count, chat and optional video.
Watching requires an authenticated account. Spectators never open a gameplay
WebSocket, so a watch tab cannot replace that account's game connection.

## Consent and fair play

Every human must explicitly choose **Broadcast this match** before joining a
public queue or starting a selected AI match. Human queues are separated by
broadcast preference; consent is never inferred from the other player. Private
invitation tables are excluded. An unlocked administrator can opt an AI-only
arena table into broadcasting. Existing games are never enrolled retroactively.

Native frames, hands, results and participant chat are withheld for at least
**120 seconds**. Public chat from nonparticipants is immediate. The delay is
fixed on the server and cannot be shortened by a client, URL or upload timestamp.
A card can remain held longer than two minutes: participants must not watch
their own broadcast or accept hidden information from spectators.

Any participant, or an unlocked administrator, can stop sharing a whole
broadcast without dropping the game. That closes spectator access, disconnects
the event stream and stops media ingest. Stopping only the camera/screen
recording leaves the native table broadcast available. Already downloaded or
externally recorded material cannot be recalled.

## Video

A participating human can publish a screen, camera, or screen with camera
overlay; microphone sharing is optional. For AI-only tables, an unlocked
administrator can publish. Browser capture requires HTTPS (or localhost), a
user gesture and the browser's permission. Choosing to broadcast a game never
grants camera, screen or microphone access automatically.

The browser sends bounded serial MediaRecorder chunks to authenticated API
routes. An isolated, private FFmpeg worker transcodes WebM VP8/Opus or fragmented
MP4 H264/AAC into H264/AAC HLS at up to 854×480 and 15 fps. Every completed segment
gets its own physical completion plus 120-second gate, enforced for both the
playlist and guessed direct segment requests. Wall-clock and monotonic checks
prevent a clock jump from shortening that hold. End-of-stream is delayed too.
Video can lag the board slightly more because encoding and segment completion
add time. The board's seek controls and the video's playback controls are
independent.

Default production limits protect the existing game server:

| Resource | Limit |
| --- | --- |
| Concurrent video publishers | 1 globally, 1 per match |
| Encoder | 0.75 CPU, 512 MiB, 128 PIDs |
| Recording length | 2 hours |
| Upload chunk / browser queue | 512 KiB / 2 MiB |
| Video audience | 25 distinct active accounts per recording; 30-second lease |
| Native spectator SSE connections | 200 globally, 3 per account |
| Video storage / replay lifetime | 2 GiB; up to 6 hours after recording ends |

Old ended recordings are evicted first when the video storage budget is full.
Quota, restart, disconnect and encoder failures can interrupt video while the
native broadcast continues. Active worker input idles out after 30 seconds.
Unreleased video receives a fresh conservative hold after a worker restart.
Raise limits only after testing the actual host. There is no claim that these
limits represent the host's measured maximum capacity.

## Data and moderation

Native broadcasts read the durable authoritative `game_events` archive using
both event and receipt timestamps. A safe projection includes delayed hands,
public seats, melds, discarded cards, turn and result summaries. It excludes
stock order, command history, emails, private invitations/chat, agent memories
and prompts. Results have a separate server-receipt gate. Frame-by-sequence,
history, directory and event-stream routes apply the same release rules.

Broadcast chat is readable text in PostgreSQL, separate from encrypted
post-game chat. Messages are bounded to 280 characters and five per account per
minute, across broadcasts. UUID request IDs make retries idempotent. Authors,
participants and authorized administrators have appropriate deletion controls;
signed-in spectators can report messages. The admin portal's Broadcasts section
lists reports and supports resolution and removal. Removed messages become
tombstones for connected viewers.

Native replay follows the installation's gameplay retention policy; stopping
sharing removes public access without deleting authoritative integrity records.
Video replay follows the shorter quota and expiry above. Neither broadcast API
nor media responses may be cached publicly. Do not expose the worker port or
storage through a reverse proxy.

## Configuration

The single-instance runtime and PostgreSQL migration 0009 are required. Set:

```dotenv
BROADCASTS_ENABLED=true
BROADCAST_MEDIA_ENABLED=true
BROADCAST_MEDIA_URL=http://media:8082
BROADCAST_MEDIA_SECRET=<a separate random secret of at least 32 characters>
BROADCAST_MAX_VIDEO_STREAMS=1
COMPOSE_PROFILES=broadcast-media
```

Generate the secret with the deployment bootstrap script. Keep it out of Git,
browser builds, logs and OpenRouter configuration. The production Compose file
adds no host port for media. The local Compose profile publishes loopback 8182
for development only. Install the updated Nginx upload/SSE configuration.
For a local Node/Vite server, source the usual `.env` values and point the media
URL at `http://127.0.0.1:8182`.

```sh
# Local Docker stack with native and video broadcasts
BROADCASTS_ENABLED=true BROADCAST_MEDIA_ENABLED=true \
  docker compose --profile broadcast-media up --build --wait
```

Readiness of the application does not imply availability of its optional
worker. If video cannot start, check the media container's health, shared key,
slot count and storage. Do not log raw environment files or FFmpeg diagnostics
into user responses. See [worker operations](../apps/media/README.md) and
[single-server deployment](../deploy/single-server/README.md).

## Verification

Unit tests cover consent segregation/recovery, safe projections, delayed data,
routes, streaming, capture cleanup and gateway authorization. PostgreSQL tests
require a dedicated database whose name contains `test`:

```sh
BROADCAST_TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5433/trinity_test \
  npm run test -w @trinitymatrix/server -- src/broadcast.integration.test.ts
```

The media workspace includes real FFmpeg/ffprobe proof for both supported input
formats and exact per-segment release boundaries. The gated browser journey
uses synthetic canvas video, waits the actual two minutes, verifies early
denial, playback, replay, chat, consent withdrawal and connection independence:

```sh
TRINITY_E2E_BROADCASTS=true npm run test:e2e -- tests/e2e/live-broadcasts.spec.ts
```

The media image includes Debian's FFmpeg package and its separately licensed
dependencies. Their notices remain in `/usr/share/doc`; package licensing does
not replace the project's AGPL licence. Review the image's package notices when
redistributing the container. No third-party video provider is required.
