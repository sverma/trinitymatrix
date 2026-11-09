# Contributing to TrinityMatrix

Welcome. Useful contributions include rule clarifications, accessibility,
mobile usability, translations, reproducible bug reports, and server reliability.
Read the [game rules](docs/TRINITY_RULES.md) and
[architecture](docs/ARCHITECTURE.md) before changing game behavior.

## Local setup

Use Node.js 22 or newer and npm. The full local stack is available through
`docker compose up --build` at `http://127.0.0.1:8180`. It uses mock OTP
`123456` for local development. For hot reload, run Redis locally, then run
`npm ci` and `npm run dev`. The development API listens on port 8181.

PostgreSQL is available through the local Compose stack at port 5433. The
browser suite starts its own application and needs ports 8180/8181 free; stop
the Compose `app` service before running it. Use test accounts and an isolated
Redis namespace. Never target the official hosted service with automated
gameplay, load tests, or authentication tests.

## Proposing a change

1. Search existing issues. For a substantial feature or a rule change, describe
   the intended behavior in an issue before implementation.
2. Make a focused branch from the current default branch.
3. Explain the observable behavior and any compatibility impact in the pull
   request. Include screenshots for visual changes when useful.
4. Add meaningful regression coverage for gameplay, security, or persistence
   changes. Keep documentation aligned with rule changes.
5. Run the relevant checks below and report which ones you ran.

```sh
npm run typecheck
npm run test:unit
npm run test:load
npm run build
```

For browser changes, install Chromium with `npx playwright install chromium`
and run `npm run test:e2e` with Redis and PostgreSQL available. Persistence and
reconnect changes may also need the integration tests described in `tests/`.

The server remains authoritative. Do not trust client-supplied card values,
identity, totals, or winning claims. Preserve exact card coverage, the 27-point
meld ceiling, and the natural-card-only 21 rule.

## Licensing and conduct

Contribute only material you have permission to submit under this project's
`AGPL-3.0-only` license. Your contributions remain yours; submitting a patch
offers it under that license without requiring copyright assignment. Preserve
third-party notices and document the source and license of new assets.

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Keep issues and reviews
respectful and focused on the work. Report vulnerabilities using
[SECURITY.md](SECURITY.md), rather than a public issue.
