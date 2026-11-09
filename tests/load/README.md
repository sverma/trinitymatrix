# TrinityMatrix WebSocket load players

This directory contains a controlled, protocol-level load harness for general ranked games. It creates complete two-player or six-player tables, keeps each game progressing with deterministic stock-draw/discard turns, optionally cycles WebSocket connections, and emits a machine-readable threshold report.

It is deliberately limited to these target sizes: **25, 50, 100, 250, or 500 concurrent games**.

## Safety boundaries

- The default target is `http://127.0.0.1:8181` and mock OTP is allowed only for a loopback target.
- A non-local target is disabled unless its exact canonical HTTPS origin is set in `TRINITY_LOAD_ALLOWED_ORIGIN` for that invocation.
- A non-local run requires both a file of unique, pre-issued synthetic sessions and an exact phrase binding approval to the allowlisted origin, table size, and player count.
- The harness never requests real OTP emails and has no authentication-bypass header or endpoint.
- Never use customer sessions. Generate synthetic sessions through an explicitly protected non-production bootstrap or another approved administrative preparation process, store the file with mode `0600`, and destroy it after the run.
- Start at 25 games, inspect the target environment's application, database, cache, network, and cost telemetry, then graduate through each target. Do not jump directly to 500.
- Use an isolated local Redis/Postgres namespace. Mock logins create synthetic profiles, and a failed/interrupted run may leave state that must not share a developer's normal dataset.

For localhost only, authentication goes through the real public mock-OTP routes. Players first bind to deterministic addresses inside `127.0.0.0/8`. Some macOS environments do not assign aliases such as `127.0.0.2`; only an `EADDRNOTAVAIL` bind failure falls back to `127.0.0.1`, and the WebSocket uses that same effective address. Arbitrary network errors still fail the player.

The isolated localhost load stack raises its mock-only OTP ceilings so the single-address macOS fallback can prepare every synthetic session. Those limits are never enabled with Resend and have no effect on non-local environments. No forwarded-IP header is used, and local address selection cannot activate for a non-local URL.

## Local run

Start the integrated server with Redis ready, `AUTH_PROVIDER=mock`, and the matching `MOCK_OTP_CODE` (default `123456`). The server origin—not a browser-only Vite origin—is preferred.

```sh
node tests/load/run.mjs \
  --base-url http://127.0.0.1:8181 \
  --player-count 2 \
  --games 25 \
  --ramp-up 60s \
  --hold 2m \
  --ramp-down 30s \
  --action-delay 2s \
  --reconnect-every 5s \
  --output tests/load/results/local-25x2.json
```

Six-player example:

```sh
node tests/load/run.mjs --player-count 6 --games 25 --ramp-up 2m --hold 5m
```

Each virtual player acts only when the authoritative state names it as the current player. A 13-card hand draws from stock; after the resulting hand/state update, a deterministic card ID is discarded. Commands carry unique IDs, the current game ID, and the expected server revision.

The default `--action-delay 2s` is the capacity-gate profile: active but closer to human pacing, producing roughly one command per active table every two seconds. Treat `--action-delay 25ms` as a separate burst/stress profile, label its artifact accordingly, and never use burst results as a substitute for the human-paced capacity gate. For a slower soak that better reflects deliberate card arrangement, use `3s` to `5s`.

During ramp-down the harness stops autoplay, drains controlled reconnects, and
drops players sequentially. A game is complete only after every participant has
a valid terminal outcome: N−1 players receive their own `game.left`, while the
remaining participant receives `game.ended` as the winner. Only then are its
sockets closed.

## Non-local preparation and run

Choose an approved non-production origin. Set it explicitly and print the required confirmation without making a network request:

```sh
export TRINITY_LOAD_ALLOWED_ORIGIN=https://load.example.test
node tests/load/run.mjs \
  --base-url https://load.example.test \
  --player-count 2 \
  --games 25 \
  --dry-run
```

The session file may be an array of cookie strings:

```json
[
  "rm_session=00000000-0000-4000-8000-000000000001",
  "rm_session=00000000-0000-4000-8000-000000000002"
]
```

It may also be `{ "sessions": [{ "cookie": "rm_session=..." }] }`. The file must contain exactly one unique synthetic player session for every virtual player (at least `games × player-count`). Cookie values are never included in logs or result JSON.

After an operator separately prepares those sessions:

```sh
node tests/load/run.mjs \
  --base-url https://load.example.test \
  --player-count 2 \
  --games 25 \
  --session-file /secure/trinitymatrix-load-sessions.json \
  --confirm-non-local "LOAD 25x2 ON https://load.example.test" \
  --ramp-up 5m \
  --hold 10m \
  --ramp-down 2m
```

The environment allowlist must exactly match the canonical `--base-url` origin. The confirmation is intentionally invalid if the origin, game count, or player count changes. `--dry-run` bypasses the session-file and confirmation requirements because it makes no network request, but it still requires the environment allowlist.

## Metrics and thresholds

The JSON result contains:

- requested configuration and phase timestamps;
- authentication, connection, game, command, cleanup, and reconnect counters;
- authentication, initial connection, matchmaking, move acknowledgement, reconnect, and heartbeat latency summaries;
- nearest-rank `p50`, `p90`, `p95`, and `p99` values;
- individual threshold decisions and an overall `success` boolean.

Controlled reconnect success is recorded only after the player receives a
restored `game.started` for the same game at an equal or newer revision. When
reconnects are enabled, the screening gate requires distinct-player coverage of
`max(10, ceil(players × 5%))` and exact attempt/success/failure accounting. A
zero-failure sample requires 59 attempts to support a 95%-confidence upper
bound below a 5% reconnect-failure probability; smaller clean samples remain
screening evidence, not statistical certification.

A move is acknowledged only when a newer authoritative `game.state` also
contains that command's observable effect: 14 cards after a draw, 13 cards and
an advanced turn after a discard, or the player's dropped status after a drop.
This prevents another player's move or a turn timer from falsely acknowledging
the command. Rejections and acknowledgement timeouts are counted separately.

Defaults:

| Threshold | Default |
| --- | ---: |
| Move p95 | 500 ms |
| Move p99 | 1,000 ms |
| Command failure rate | 1% |
| Initial connection failure rate | 1% |
| Reconnect failure rate | 5% |
| Unexpected disconnect rate | 1% |
| Games started | 100% of target |
| Games completed in ramp-down | 100% of target |
| Terminal participant outcomes | 100% of players, no mismatch/timeout |
| Reconnect coverage | max(10, 5% of players) when enabled |
| Premature endings, cleanup failures, protocol errors | 0 |

Override with `--max-p95-ms`, `--max-p99-ms`, `--max-command-failure-rate`, `--max-connect-failure-rate`, `--max-reconnect-failure-rate`, and `--max-unexpected-disconnect-rate`. A failed threshold or fatal runner error exits with status 1; invalid or unsafe configuration exits with status 2.

## Tests

```sh
node --test tests/load/*.test.mjs
```

The tests cover duration/config validation, non-local safety confirmation,
terminal outcomes, reconnect continuity/accounting, signal aborts, percentile
summaries, and artifact redaction. Except for the signal test's ephemeral
loopback listener, they do not contact localhost or any configured non-local
target.
