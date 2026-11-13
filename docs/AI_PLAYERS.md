# Persistent model-backed AI players

AI players use actual OpenRouter model decisions for every draw, discard,
declaration and final layout. Protocol v2 prioritizes winning at the earliest
legal opportunity: declare a ready hand instead of waiting for more points.
A shared rules tool checks only the player's own hand and public state and may
provide a legal declaration candidate. The selected model still returns every
action; the server never automatically plays the candidate.

The shared game engine applies the same Trinity rules and penalties to humans
and AI. V2 also checks model responses before dispatch, like client-side legality
checks. A declaration committed to the engine still incurs the normal drop if
invalid. See the [versioned AI game protocol](AI_GAME_PROTOCOL.md) for the winning
objective, tool boundary and request contract.

## Identities and configured roster

Fourteen model families are configured for the default v2 cohort. Current players
use ordinary model names, and the pickers retain protocol metadata. Earlier
agents are labelled `· v0` outside broadcasts. Broadcast names, generated table
titles, winners and move feeds omit agent version suffixes, including archived
broadcasts. Configuration does not imply that a model has passed operator qualification or is available:

| Player family | OpenRouter model ID |
| --- | --- |
| Haiku AI | `anthropic/claude-haiku-5.5` |
| Gemini AI | `google/gemini-3.8-flash` |
| DeepSeek AI | `deepseek/deepseek-v3.2` |
| Qwen AI | `qwen/qwen3.8-flash` |
| Mistral AI | `mistralai/mistral-small-2603` |
| Luna AI | `openai/gpt-6-luna` |
| Llama AI | `meta-llama/llama-4-maverick` |
| DeepSeek Flash AI | `deepseek/deepseek-v4.1-flash` |
| Terra AI | `openai/gpt-6.1-terra` |
| GPT Mini AI | `openai/gpt-5.4-mini` |
| Nemotron AI | `nvidia/nemotron-3-ultra-550b-a55b` |
| MiMo AI | `xiaomi/mimo-v2.6-flash` |
| Solar AI | `upstage/solar-pro4` |
| GLM AI | `z-ai/glm-5` |

Operators qualify models before making them available. New cohorts inherit the
latest existing model identity's enabled/suspended state, and provisioning never
overwrites an existing cohort's availability flag. Disabled models stay disabled
through upgrades. The unsuffixed DeepSeek Flash slug
has its own identity; the retired `deepseek/deepseek-v4.1-flash-1017` identity and
its history are retained outside the selectable roster.

Model IDs and prompt versions are immutable database fields. V2 stores its
semantic protocol version and policy hash in the version binding. A policy
revision creates a separate deterministic identity for each model. Earlier profiles,
memory, ratings and results remain intact under the public v0 label. Their
original `trinity-v1` prompt binding remains immutable for audit and recovery.
V2 is the default for identity generation, provisioning and new database rows.
This presentation change reuses the existing v2 identities and their running
ratings; it does not create another cohort or reset ratings. Human-only and
existing human mixed ratings are preserved.
Provider-side weights behind a model slug can
still change; this is not a guarantee of reproducible model weights.

Each identity has a stable UUID, profile, bounded persistent memory and match
history. One identity occupies one active table at a time. Its roster entry says
when it is busy. There is no automatic background tournament or idle inference.
Only the current cohort can join new games. An active legacy (v0) participant
remains registered with its original `trinity-v1` protocol until that game ends, including across
a server restart. It is excluded from new-match selection.
Humans can select one available AI for a two-player table, or any five available
AIs for a six-player table. An unlocked administrator can select any two or any
six available AIs in **AI arena** to start an AI-only match.

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

Run the migration CLI before deploying the updated production server. Migration
`0008_model_bound_ai_players.sql` adds identities, scoped ratings and the ledger;
`0010_ai_protocol_provenance.sql` adds the immutable protocol registry and nullable
request provenance. Existing migration files and historical results are retained.

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
Legacy games keep their original instructions rather than switching policy in
the middle of a match.

The provider key stays on the server. Disabled AI mode works without a key.
When enabled without a key, the roster explains that OpenRouter is unconfigured
and refuses new games. Availability is refreshed from the model catalog every
five minutes. Only structured-output models within the configured price caps
are admitted, and there is no fallback to another model.

Requests prefer the lowest-latency eligible endpoint for the selected model.
Qwen reasoning is limited to 256 tokens. Haiku and DeepSeek optional extended
reasoning is explicitly disabled; Mistral defaults to ordinary responses. The added Terra, GPT Mini, Nemotron, MiMo, Solar and GLM bindings disable optional
reasoning. All retain
the same 1,600-token total output ceiling. Gemini uses its supported low
reasoning effort. These settings
avoid provider defaults consuming the turn deadline before returning a move;
they do not change model identity or substitute another decision engine.

After provisioning the new server, an operator can verify each model without
creating ranked games using the container's `dist/ops/ai-check.js` entry point.
These are real, paid requests, charged against the same shared budget ledger.
The ordinary-turn diagnostic uses a reproducible shuffled deal so it exercises
normal draws and discards, alongside the separate immediately winning fixture.
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

Requests are capped at 24 KB, 1,600 output tokens and 20 seconds, with endpoint
prices capped at USD 1/M input tokens and USD 5/M output tokens and zero
per-request charge. Public search/browser tools are not enabled. Actions and
card IDs are constrained to the current turn stage and the agent's own hand.
The own-hand rules tool additionally checks declaration legality. Its work is
bounded within the existing turn deadline; an unavailable check means unknown,
not proof that no winning declaration exists. The model still chooses the move.

A transient provider/format error gets one correction retry using the same model
and a new budget reservation. Each call is capped by the remaining normal turn
deadline, with a one-second safety margin. After two failed attempts for the same
revision, requests pause and the normal human timeout rule handles that turn.
A technical forfeit occurs only after three consecutive failed AI turns, or an
unrecoverable access/configuration problem or exhausted shared budget. A completed
legal discard resets that failure streak. A declaration dispatched to the engine
uses the same invalid-declaration drop penalty as a human command. No other model
substitutes for the selected model. The normal showdown deadline handles missing
final layouts. Late replies for a stale revision are discarded.

Technical forfeits carry an explicit server-authored cause to the game result and
archive. Diagnostics record bounded error codes, stage, revision, request ID and
timing; they never log hands, model prompts, agent memory or provider response text.

The immutable protocol registry stores policy hashes, semantic versions, the
rules revision and metadata-only capability manifests. Each new request can
record its bound protocol, match/game revision, tool version, server build,
whether a declaration was available, chosen action and validation outcome.
Unavailable tool results use an unknown (`null`) declaration flag. These audit
fields contain no raw prompts, hands, memory or provider bodies. Older requests
retain null provenance rather than being assigned an invented historical policy.
All versions continue to share the same UTC-day spending ledger.

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
restart memory and concurrent budget reservations. Operator qualification uses
each selectable identity's bound protocol and the same bounded rules worker as
runtime play. It supports both ordinary full turns and an immediate-win fixture:

```sh
node dist/ops/ai-check.js --turns 10 MODEL_ID
node dist/ops/ai-check.js --winning-hand MODEL_ID
```

It uses disposable in-memory games and fixture-local notes, and charges every
real request to the same shared ledger without creating ranked matches. The
report includes the protocol, scenario, complete/missed turns, rules checks,
available/missed winning decisions, policy rejections, retries, timing and costs.
Every reservation records protocol/game revision, tool version and declaration
availability; completion records the selected action and validation outcome.
Retired identities retained only for active-game recovery are excluded from CLI
selection. Profile memory and ratings are never changed.

`--winning-hand` starts with the sanitized 14-card hand from the missed-declaration
regression. It defaults to one turn, with at most two same-model attempts. A legal
discard is a failed policy decision in this scenario, not a passing turn; the
model must choose a valid declaration. `--turns 1..10` can explicitly repeat the
fixture. The rules tool's candidate is never automatically executed.

V2 rejects missed winning declarations and invalid declaration plans before
engine dispatch, then retries the same model within the normal deadline and
shared spending budget. Legacy full-turn fixtures preserve their old behavior:
an invalid declaration is a committed normal rule loss, recorded separately from
technical failures, and qualification continues with a fresh disposable game.
The authoritative engine's invalid-declaration penalty is unchanged.

The operator-only `--diagnose-schema` flag emits allowlisted error hints; provider
text and credentials are never printed. Qualification should also cover the
mandatory draw for a ready 13-card hand and resistance to instructions in names
or memory. Passing local tests alone does not qualify a remote model.

Run isolated database checks with:

```sh
AI_RATINGS_TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:PORT/trinity_ai_test \
  npm run test -w @trinitymatrix/server -- src/db/ai-ratings.integration.test.ts

AI_RATINGS_TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:PORT/trinity_ai_test \
  npm run test -w @trinitymatrix/server -- src/db/ai-protocol.integration.test.ts
```

The test database name must contain `test`; a fresh random schema is created and
dropped for each run. Run the suites sequentially because migrations share a
database-wide lock. Never point these tests at the production database.

New model candidates are selected from the live [OpenRouter model catalog](https://openrouter.ai/api/v1/models) for structured output and the existing price limits. Real provider qualification is required before activation; advertised schema support alone does not qualify a model.
