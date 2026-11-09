# TrinityMatrix architecture

TrinityMatrix is an npm workspace with a shared rules package, a Fastify service, and a React client.

## Trust boundary

The client uses `@trinitymatrix/game-domain` to give immediate meld and declaration feedback. The server uses the same package to validate the submitted card identifiers against its private authoritative hand. Client-computed totals never determine an outcome.

## Packages

- `@trinitymatrix/protocol` defines cards, public game state, commands, events, profiles, and private-room payloads. Zod parsers reject unknown or malformed network messages.
- `@trinitymatrix/game-domain` owns deck creation, shuffling, card values, suit-pattern rules, meld totals, best-effort replay organization, and declaration validation.
- `@trinitymatrix/server` owns authentication, matchmaking, private rooms, WebSocket sessions, authoritative game state, persistence, replays, administration, and operational controls.
- `@trinitymatrix/web` owns the lobby, table, card arrangement, accessible interactions, history, replay, administration, and PWA behavior.

## Live state

Redis stores OTP challenges, authenticated sessions, queues, private waiting rooms, and active-game snapshots. Commands carry a UUID, game ID, and expected revision. The server rejects duplicate or stale commands, which protects reconnect and retry paths from applying a move twice.

PostgreSQL is optional for basic local play and required for durable profiles, rankings, match history, encrypted post-game chat, replay export bookkeeping, and the distributed runtime. The server runs migrations automatically outside production.

## Game flow

```text
authenticate → join queue/private room → toss and deal → draw → discard
                                                     ↘ stage final discard
                                                       validate declaration
                                                       ↙              ↘
                                                invalid/drop       showdown
                                                                    ↓
                                                            verified winner
```

The server sends only a player's own hand while broadcasting public state such as card counts, turn owner, top discard, timer, and wild rank.

## Security and operations

- Secure, HTTP-only session cookies
- Exact-origin checks for API and WebSocket traffic
- Content Security Policy and restrictive browser permissions
- Shared Redis-backed rate limits
- Bounded WebSocket payloads and inbound-message queues
- HMAC-protected OTP challenges with short expiry
- Optional encrypted chat persistence
- Passkey-gated administrator access when configured
- Graceful shutdown and health/readiness endpoints

The local `compose.yaml` is for development. The separate `deploy/single-server`
configuration supports the Ubuntu VPS at `trinitymatrix.org` with production
containers, Nginx HTTPS, PostgreSQL TLS, private Redis/PostgreSQL services,
generated secrets, systemd restart-on-boot, and daily database dumps. Single-server
replays remain in PostgreSQL; distributed production additionally requires S3.
Production sign-in uses Resend. An unconfigured installation can use
`AUTH_PROVIDER=disabled`, which returns HTTP 503 from both OTP endpoints.
