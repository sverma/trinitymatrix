# Distributed gameplay tranche

Status: the durable runtime is connected to the live HTTP/WebSocket server
behind `GAMEPLAY_RUNTIME_MODE=distributed`. Two real local server processes
have completed both a two-player game and a six-player game with clients split
across the gateways. The verification observed one durable event and outbox row
per revision, one command receipt per accepted command, one winner, zero-sum
ranked Elo, and no terminal deadline.

`APP_REPLICA_COUNT>1` requires distributed mode. Distributed mode in turn
requires `DATABASE_URL` and `DURABLE_DATA_REQUIRED=true`, so it cannot silently
fall back to the process-local runtime.

## Runtime selection

- `GAMEPLAY_RUNTIME_MODE=single` retains `src/matchmaker.ts` for localhost and
  staging compatibility. It is deliberately rejected when replica count is
  above one.
- `GAMEPLAY_RUNTIME_MODE=distributed` selects
  `src/distributed-matchmaker.ts`. PostgreSQL owns queue membership, active-game
  discovery, materialization, fencing, command serialization, events, terminal
  results, outbox records and deadlines.
- Valkey carries owner-routed commands and low-latency committed events. A
  reconnect reads PostgreSQL, so Pub/Sub loss cannot become state loss.
- WebSocket listeners are installed before `session.ready`; this ordering is
  tested because an immediate mobile `queue.join` previously exposed a race.
- Every authenticated WebSocket has a token bucket and a single-consumer,
  bounded command queue. Defaults allow 10 application messages/second with a
  burst of 20 and at most 8 active-plus-queued messages. Configure these with
  `WEBSOCKET_MESSAGE_RATE_PER_SECOND`, `WEBSOCKET_MESSAGE_BURST`, and
  `WEBSOCKET_MAX_BUFFERED_MESSAGES`. A client that exhausts the bucket or queue
  is closed with WebSocket policy code `1008`; native ping/pong control frames
  are unaffected. The protected load-metrics snapshot exposes separate
  `webSockets.rateLimitCloses` and `webSockets.backpressureCloses` counters.

## Implemented additive foundation

Migration `migrations/0004_distributed_game_runtime.sql` adds:

- `game_runtime_owners`: leased owner directory with monotonic fencing tokens,
  drain state, and protocol compatibility range;
- `durable_game_commands`: immutable command receipts and stored results keyed
  by `(match_id, command_id)` for exact idempotent replay;
- `game_event_outbox`: an event outbox committed with `game_events`, claimed by
  independent workers using expiring leases and `SKIP LOCKED`;
- `recoverable_game_deadlines`: externally claimable turn/showdown deadlines;
- `distributed_matchmaking_tickets`: globally ordered queue tickets with
  expiring coordinator claims and one waiting ticket per player.

Migration `migrations/0005_matchmaking_ticket_liveness.sql` additively gives
each waiting ticket an expiry and heartbeat. A reconnect refreshes and returns
the same compatible ticket; explicit cancellation or missing heartbeats prevent
claimed-but-disconnected players from becoming ghost matches.

`src/db/distributed-runtime.ts` provides the transaction boundary:

- `claimOwnership`, batched `renewOwnershipBatch`, `beginDraining`, and
  `getRoute`; takeover atomically clears stale deadline claims, refences the
  deadline whose expected revision equals the latest committed event sequence,
  and removes obsolete revisions;
- `commitTransition`, which verifies the live owner and fence, detects exact
  duplicate commands, then commits command, immutable event, outbox message,
  and replacement deadline in a single PostgreSQL transaction;
- leased `claimOutbox`/ack/reschedule and `claimDueDeadlines` operations;
- distributed queue enqueue/reconnect, player heartbeat/cancel, coordinator
  claim heartbeat/release, and expired-ticket cleanup operations;
- `startClaimedGeneralGame`, which commits the match, participants, initial
  event, first owner/fence, outbox, first deadline, and matched tickets in one
  transaction;
- `startReadyPrivateGame`, which performs the equivalent atomic transition for
  a fully accepted private room;
- active-player discovery and latest-event materialization for reconnect and
  takeover; detached players are excluded from active-game discovery; and
- terminal completion inside `commitTransition`, so participant outcomes,
  ranked Elo (or unchanged private ratings), match/private-room completion,
  command, event, outbox and deadline removal commit together.

`src/distributed-transport.ts` provides a modular Valkey delivery plane:

- a dedicated duplicated subscriber connection, never shared with Redis command
  or publish traffic;
- strict 64 KiB, protocol-v1 envelopes for owner-routed commands and deadlines,
  cross-instance player messages, and durable outbox events;
- exact per-instance channels plus shared player/event channels, with target
  verification and invalid-envelope reporting;
- no claim that Pub/Sub itself is durable: PostgreSQL remains authoritative and
  clients receive no command acknowledgement until the owner transaction commits.

Committed outbox envelopes use `deliverySemantics: "committed-event-log"` and
carry `ownershipFenceAtCommit`. They deliberately do not contain the
mutation-routing `fencingToken` field: the ownership fence is provenance, not a
delivery veto. Therefore
consumers must deduplicate/order committed events by `(matchId, eventSequence,
outboxId)` and must **not** discard a valid older-fence event merely because a
new owner has since taken over. Command and deadline envelopes, by contrast,
must match the current ownership fence before they may mutate state.

`src/distributed-workers.ts` provides independently testable worker loops:

- leased outbox claims, publish acknowledgement, and bounded exponential retry;
- recoverable deadline claims and at-least-once routing to the current owner;
- PostgreSQL-clock lease/deadline decisions and periodic owner-lease renewal in
  isolated batches of at most 1,000 games, avoiding one query per game and
  continuing independent batches after a pool failure;
- drain orchestration that marks the instance draining and expires its leases so
  another compatible instance takes ownership with a higher token.

Both migrations are additive: they do not remove columns used by the current
server, enabling an expand/migrate/contract rollout.

## Remaining production evidence gates

1. Run process-kill injection after receipt, during owner transfer and before
   outbox publication; prove reconnect and deadline redelivery from PostgreSQL.
2. Run mixed-version rolling-deployment tests. Runtime envelopes and ownership
   are protocol-v1 fenced, but an explicit public client hello/version range is
   still required before a future incompatible protocol is introduced.
3. Run the documented 25/50/100/250/500-game progression, then a multi-hour soak
   on a production-equivalent environment. The two-node journeys prove the
   correctness path, not 10,000-game capacity.
4. Execute and retain RDS, RDS Proxy, Valkey, task-loss and AZ failover drills.
5. Add production alarms for ownership-renewal failures, expired deadlines,
   outbox age/backlog, matchmaking expiry and reconnect failures.
