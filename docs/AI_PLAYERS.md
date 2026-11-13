# Persistent model-backed AI players

AI players use actual OpenRouter model decisions for every draw, discard,
declaration and final layout. A local solver never replaces the chosen model.
The shared game engine validates the resulting command with exactly the same
Trinity rules as a human command. Invalid declarations are committed drops.

## Identities and initial roster

The initial roster was checked against OpenRouter's public catalog on
13 November 2026:

| Player | OpenRouter model ID |
| --- | --- |
| Haiku AI | `anthropic/claude-haiku-5.5` |
| Gemini AI | `google/gemini-3.8-flash` |
| DeepSeek AI | `deepseek/deepseek-v3.2` |
| Qwen AI | `qwen/qwen3.8-flash` |
| Mistral AI | `mistralai/mistral-small-2603` |

Model IDs and prompt version are immutable database fields. A new model/prompt
version requires a new player identity so its ranking does not silently inherit
another configuration's results. Provider-side weights behind a model slug can
still change; this is not a guarantee of reproducible model weights.

Each identity has a stable UUID, profile, bounded persistent memory and match
history. One identity occupies one active table at a time. Its roster entry says
when it is busy. There is no automatic background tournament or idle inference.
Humans can select one AI for a two-player table, or all five for a six-player
table. An unlocked administrator can select two AIs in **AI arena** to start an
AI-only match. Six-AI tables require provisioning an additional identity.

## Independent rankings

The existing rating formula is unchanged. Its input ratings and output records
are scoped to the match composition:

- `human`: every participant is human. Existing ratings are preserved here.
- `ai`: every participant is AI.
- `mixed`: the table contains both human and AI players.

One human may therefore have a human-only rating and a separate mixed rating.
An AI may have separate AI-only and mixed ratings. Private invite-only matches
remain unranked. Changing leaderboard tabs never combines these rating pools.

## Setup

Apply migration `0008_model_bound_ai_players.sql` before deploying the updated
production server. It backfills human ratings and adds the identity, scoped
rating and request-ledger tables without rewriting the older migrations.

Add to the private runtime environment (never commit the key):

```dotenv
AI_PLAYERS_ENABLED=true
OPENROUTER_API_KEY=YOUR_SERVER_ONLY_KEY
AI_DAILY_BUDGET_USD=10
```

PostgreSQL and the single-instance gameplay runtime are required for this
release. AI mode refuses a distributed-runtime configuration until its worker
coordination is implemented. Redis still persists active game state. Agent
identities/memory and ratings persist in PostgreSQL. On restart, registered AI
players reconnect to their restored tables and use the current authoritative
revision; in-flight requests may have consumed money and are not replayed.

The provider key stays on the server. Disabled AI mode works without a key.
When enabled without a key, the roster explains that OpenRouter is unconfigured
and refuses new games. Availability is refreshed from the model catalog every
five minutes. Only structured-output models within the configured price caps
are admitted, and there is no fallback to another model.

Requests prefer the lowest-latency eligible endpoint for the selected model.
Qwen reasoning is limited to 256 tokens. The selected DeepSeek and Mistral
models default to ordinary responses without extended reasoning. All retain
the same 1,200-token total output ceiling. These settings
avoid provider defaults consuming the turn deadline before returning a move;
they do not change model identity or substitute another decision engine.

After provisioning the new server, an operator can verify each model without
creating ranked games using the container's `dist/ops/ai-check.js` entry point.
These are real, paid requests, charged against the same shared budget ledger.
The diagnostic prints only model IDs, status, latency and usage cost; it does
not display credentials or private hands. Run it manually, not as a healthcheck.
Optional model IDs after the command restrict the check to those configured
roster entries. Retired identities and their billing/history records remain in
the database but are excluded from the current selectable roster.

## Budget and failure behaviour

The shared limit is at most **USD 10 per UTC day**, across all identities and
human/AI matches. Operators may set a smaller positive limit. Also set a
USD 10 daily limit on a dedicated OpenRouter key for provider-side enforcement
against unexpected billing or any use of that key outside TrinityMatrix.
The application's ledger covers its inference charges; account top-up fees,
taxes and unrelated account activity are not controlled by the game server.

Before each request, a PostgreSQL transaction reserves USD 0.05 under a global
advisory lock. All agents share that lock and ledger. Completed requests replace
their reservation with reported actual usage, rounded upward to six decimals.
Unknown billed costs, failures and interrupted requests retain their full
reservation. Midnight UTC opens the next daily pool, not an additional pool
per agent. No provider request occurs when the reservation cannot be made.

Requests are capped at 24 KB, 1,200 output tokens and 15 seconds, with endpoint
prices capped at USD 1/M input tokens and USD 5/M output tokens and zero
per-request charge. Public search/browser tools are not enabled. Actions and
card IDs are constrained to the current turn stage and the agent's own hand.
These constraints never choose a strategic action or validate declaration maths.

A transient provider/format error gets one correction retry using the same model
and a new budget reservation. Each call is capped by the remaining normal turn
deadline, with a one-second safety margin. After two failed attempts for the same
revision, requests pause and the normal human timeout rule handles that turn.
A technical forfeit occurs only after three consecutive failed AI turns, or an
unrecoverable access/configuration problem or exhausted shared budget. A completed
legal discard resets that failure streak. Invalid declarations still commit the
same immediate drop as human declarations. No other model or strategy engine
substitutes for the selected model. The normal showdown deadline handles missing
final layouts. Late replies for a stale revision are discarded.

Technical forfeits carry an explicit server-authored cause to the game result and
archive. Diagnostics record bounded error codes, stage, revision, request ID and
timing; they never log hands, model prompts, agent memory or provider response text.

## Information boundary

Each model receives its own hand, current public table state, a bounded public
state history and its own saved notes. It never receives opponents' hands,
stock order, another model's memory, emails, authentication cookies or API keys.
Human display names are replaced with seat labels in model observations.
No model-generated explanation or private reasoning is displayed to opponents.
Agent notes are private storage, not instructions to the host application.
AI profiles use a reserved, non-loginable email domain and cannot redeem OTPs.

## Verification

Adapter tests mock OpenRouter and do not incur model charges. Runtime tests
exercise actual game commands with a simulated model client. Isolated real
PostgreSQL tests cover rating migration/isolation, immutable identities,
restart memory and concurrent budget reservations. Operator qualification now
requires repeated full draw/discard cycles, rather than just one opening draw:

```sh
node dist/ops/ai-check.js --turns 10 MODEL_ID
```

It uses disposable in-memory games and fixture-local notes, and charges every
real request to the same shared ledger without creating ranked matches. The
report includes complete/missed turns, retries, error codes, timing and costs.

Run isolated database checks with:

```sh
AI_RATINGS_TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:PORT/trinity_ai_test \
  npm run test -w @trinitymatrix/server -- src/db/ai-ratings.integration.test.ts
```

The test database name must contain `test`; a fresh random schema is created and
dropped for each run. Never point this at the production database.
