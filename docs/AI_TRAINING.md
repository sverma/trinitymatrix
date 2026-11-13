# Private AI practice and evaluation

The operator practice runner gives each selected AI model synthetic examples,
practice decisions and feedback, followed by held-out evaluation. It can improve
the private notes that the same model uses in later games. It does not fine-tune
model weights, change Trinity rules or guarantee stronger play.

The current release is a finite operator CLI. It does not run background
training or change which AI players are enabled. The existing 11 enabled players
remain enabled; a practice result does not automatically suspend or activate a
model.

## Run a bounded practice session

Use the built server release with its private database, inference and recovery
configuration loaded, and apply the current migrations first, including
`0013_ai_practice.sql`. Keep API keys and connection strings in the private runtime
environment. Run from the server release directory:

```sh
# One round for every enabled current-v3 identity.
node dist/ops/ai-train.js

# Two rounds for one exact configured model.
node dist/ops/ai-train.js --rounds 2 anthropic/claude-haiku-5.5

# Process one model at a time instead of the default two.
node dist/ops/ai-train.js --concurrency 1

# Keep the practice notes separate from live-player memory.
node dist/ops/ai-train.js --rounds 1 --no-promote
```

`--rounds` accepts only 1, 2 or 3, and defaults to 1. Without model IDs, the CLI
selects enabled current-v3 identities. Explicit IDs select those exact configured
models; disabled models are skipped and there is no fallback model. `--concurrency`
accepts 1, 2 or 3 models at a time and defaults to 2. Earlier v2/v0 identities are
excluded from this workflow. Each model's practice is limited to ten minutes as
well as its requested rounds and normal turn deadlines. The full command can take
longer when it processes several models. Inference, configuration or shared-budget
limits can stop the bounded work early. Only one practice run may hold an identity's
lease at a time. A stale running lease expires after 15 minutes; an expired run
cannot later overwrite a newer run's notes.

Practice uses the same shared UTC-day spending ledger as live AI games and
qualification. The current cap is **$10 per day across all these activities**,
not a separate practice allowance. Every model call reserves budget before it
starts. Existing request size, response size, output-token, provider-price and
20-second request limits apply. Failed calls can consume paid credits. Stop or
reduce practice when budget should remain available for players.

## What each round does

Each round contains four synthetic episodes in this order:

1. Ordinary-turn practice, with bounded lesson examples and feedback.
2. Winning-hand practice, with bounded lesson examples and feedback.
3. Held-out ordinary-turn evaluation, with lesson examples removed.
4. Held-out winning-hand evaluation, with lesson examples removed.

Practice and evaluation use disposable game state. They do not read live or
archived player hands, create ranked matches, change ratings, publish broadcasts,
or add matches to player history. Held-out results measure behavior on the
separate evaluation fixtures; they are not evidence of performance against every
possible deal or opponent.

Every action comes from the selected model. Protocol v3 validates only the
proposed move and explicitly supplied groups. It does not search the hand,
calculate readiness, generate winning partitions, supply a winning discard or
replace a model move. Curated solutions in synthetic lesson examples are allowed
teaching material. They are not generated from a live hand and are absent from
held-out evaluation and live requests. An invalid proposal gets bounded feedback
about that proposal and at most one same-model correction retry for that gameplay
revision. A legal discard remains legal even when the fixture could be won.

The winning fixtures have known solutions so the report can distinguish a legal
move from a missed winning opportunity. A missed win is a performance metric;
it does not trigger a hidden solver hint or force a v3 declaration retry.

## Private notes and safe promotion

Practice notes are private, bounded to 512 characters and keyed to the exact model
identity, protocol and curriculum revision. Reports also identify the practice
implementation version. Private storage keeps immutable curriculum metadata,
run summaries, practice notes and the baseline live memory needed for guarded
promotion. Run summaries use bounded numeric metrics; they do not store raw hands,
prompts or provider bodies. Practice notes are separate from the live player's
existing memory. The model writes its own concise notes. A filter rejects exercise
card IDs, serialized example fields and lesson markers, retaining earlier acceptable notes
when a response is unsuitable. Static lesson payloads are never appended to live
requests. This filter cannot prove that free-text notes contain no paraphrased
example; notes remain untrusted model-authored data.

By default, the runner attempts to promote the resulting model-generated notes
into the matching current-v3 identity. It defers the write when an active match is
visible in PostgreSQL or Redis, when runtime state cannot be checked, or when live
memory changed since practice began. A compare-and-swap prevents overwriting
changed live memory. `--no-promote` always keeps notes separate. Practice notes
remain in their private store whether promotion succeeds or is deferred, and later
live play can replace promoted notes through its normal memory updates.

The active-match checks are snapshots across Redis and PostgreSQL, not one atomic
transaction with matchmaking. A game that starts concurrently can observe the
learned notes. Promotion changes only the same model's bounded notes under the
same protocol; game state, rules and hands are unchanged.

Live requests retain the normal information boundary: only the model's own
current hand, public state, public history and private notes. The runner never
adds the static lesson payload, another player's hand or a solver-generated plan
to a live request. Practice notes cannot override the immutable system
instructions, action schema or game rules.

A future protocol or curriculum revision needs new matching practice work.
Protocol revisions create fresh identities; do not copy earlier v2 assistance,
old-protocol notes or training records into a new identity. Preserve historical
records under the protocol and curriculum that actually produced them.

## Reading the report

The report identifies the exact model, immutable protocol, practice version,
curriculum ID and hash, along with bounded episode metrics and status. A top-level
`completed` status means the scheduled curriculum finished; nested episode results
and metrics show reliability and missed wins. It does not mean every exercise was
passed or that notes were promoted. Use legal move rates, completed turns, declarations, missed winning opportunities, retries,
latency and cost together. A reliable JSON response is different from a strong
strategic move, and a successful fixture is different from general playing
strength.

Reports and operational diagnostics contain bounded metadata, not raw prompts,
full hands, model responses or private notes. Notes remain in private storage;
the CLI must not print them. Practice outcomes do not change rankings or enabled
flags. Review outcomes over repeated runs before drawing conclusions about a
model's strength.

See [AI players and spending controls](AI_PLAYERS.md) for deployment and budget
behavior and the [versioned AI game protocol](AI_GAME_PROTOCOL.md) for the live
validation-only contract.
