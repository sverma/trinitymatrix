# TrinityMatrix

TrinityMatrix is a real-time, server-authoritative implementation of the original Trinity card game. It uses the mature RummyMatrix product structure as an architectural reference while replacing its meld and declaration rules with Trinity scoring.

## Community and license

TrinityMatrix's project-owned source code is licensed under **GNU AGPL version 3
only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full terms and
[NOTICE.md](NOTICE.md) for scope and provenance. Operators of modified versions
that interact with users over a network must prominently offer those users the
corresponding source, as required by section 13. Commercial use is permitted.

The community repository is [sverma/trinitymatrix](https://github.com/sverma/trinitymatrix).
The owner has confirmed redistribution rights for the inherited artwork.
See [release notes](docs/OPEN_SOURCE_RELEASE.md).

Contributions are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md), the
[game rules](docs/TRINITY_RULES.md), and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## Trinity rules implemented

- Each player is dealt 13 cards and draws before discarding or declaring.
- A meld contains at least 3 cards.
- A meld total must be one of `3, 6, 9, 12, 15, 18, 21, 24, 27`; totals above 27 are invalid.
- A meld contains natural cards of one suit, or natural cards whose suits are all different.
- Printed jokers and cards matching the round's selected wild rank are exempt from the suit restriction and may represent values 1 through 11.
- A 21-point Trinity meld must contain only natural cards; printed jokers and selected wild-rank cards cannot be used in it.
- Aces may be worth 1 or 11. Jacks, Queens, and Kings are worth 10.
- A declaration must place every card remaining after the final discard into valid melds and include at least one natural meld totaling exactly 21.
- A declaration's score is the sum of its meld totals.

See [the full rules and explicit assumptions](docs/TRINITY_RULES.md).

## Product scope

- Email OTP authentication with local code `123456` or Resend delivery
- Persistent player profiles, rankings, match history, replays, and post-game chat when PostgreSQL is enabled
- FIFO matchmaking and private invite-only tables for 2 or 6 human players
- Server-authoritative dealing, toss, turn timing, draw, discard, drop, reconnect, and declaration validation
- Accessible card grouping using click, keyboard, and drag-and-drop controls
- Live meld totals, 21-point highlighting, declaration score, turn sounds, and responsive layouts
- Redis-backed recovery of sessions, queues, and active games
- Optional PostgreSQL-backed durable history and distributed-game runtime
- PWA support, strict security headers, rate limiting, and local container deployment
- Unit, load, integration, browser, and accessibility tests

Model-backed AI opponents are available as an opt-in server feature. Humans
choose persistent, labelled AI identities tied to specific OpenRouter models.
Human-only, AI-only and mixed matches use independent ratings with the existing
rating formula. Administrators can start AI-only matches from the AI arena.
See [AI players and spending controls](docs/AI_PLAYERS.md) for setup and limits.

Opt-in public broadcasts include all hands after a server-enforced two-minute
delay, spectator chat, replay controls and optional screen/camera video.
See [live broadcasts and operations](docs/LIVE_BROADCASTS.md).

Cash games, wallets and payments remain out of scope.

For an Ubuntu VPS deployment, see
[the single-server deployment guide](deploy/single-server/README.md). This uses
Nginx HTTPS, production containers, private database/cache services, PostgreSQL
TLS, generated credentials, restart-on-boot, and daily database backups.

## Run locally

Requirements: Node.js 22+ and Redis on `127.0.0.1:6379`.

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:8180>. The development API runs on port `8181`. Enter any valid email address and use `123456` as the local OTP. Use a separate browser profile or isolated browser context for each player.

Without `DATABASE_URL`, the game uses Redis for live state and omits durable rankings, history, replay, and chat storage. For the complete local stack, including PostgreSQL, run:

```bash
docker compose up --build
```

The application is then available at <http://127.0.0.1:8180>. PostgreSQL is exposed on `127.0.0.1:5433`; Redis stays private to the Compose network. Both services use named local Docker volumes.

## Build and verify

```bash
npm run typecheck
npm run test:unit
npm run test:load
npm run build
```

Browser tests additionally require Redis, PostgreSQL, and Playwright Chromium:

```bash
npx playwright install chromium
npm run test:e2e
```

## Architecture

```text
apps/web                 React/Vite client and PWA
apps/server              Fastify HTTP/WebSocket service
apps/media               Private FFmpeg worker for delayed HLS broadcasts
packages/protocol        Shared runtime-validated messages and types
packages/game-domain     Trinity deck, meld, organization, and declaration logic
tests/e2e                Multi-browser player journeys and accessibility checks
tests/integration        Restart and distributed-runtime verification
tests/load               Controlled multiplayer load harness
```

The browser provides immediate feedback, but the server imports the same game-domain validator and remains authoritative for every declaration and outcome. See [the architecture notes](docs/ARCHITECTURE.md).

## Real email OTP

The optional email adapter uses Resend. Supply `AUTH_PROVIDER=resend`, `RESEND_API_KEY`, a verified `EMAIL_FROM`, a unique `OTP_HASH_SECRET`, and `AUTH_STATE_EPOCH`. Never commit secrets. HTTPS deployments must also enable secure cookies and configure an exact `ALLOWED_ORIGINS` list.

The policy pages intentionally remain visibly marked as drafts until complete operator metadata is supplied and `LEGAL_PUBLICATION_APPROVED=true`.
