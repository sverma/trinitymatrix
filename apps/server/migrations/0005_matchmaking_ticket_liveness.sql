-- Add liveness to distributed queue tickets without breaking the previous
-- writer during an expand/migrate/contract rollout. Defaults allow the v1
-- insert statement to coexist until all application tasks are upgraded.

ALTER TABLE distributed_matchmaking_tickets
  ADD COLUMN expires_at timestamptz NOT NULL
    DEFAULT (clock_timestamp() + interval '90 seconds'),
  ADD COLUMN heartbeat_at timestamptz NOT NULL
    DEFAULT clock_timestamp();

ALTER TABLE distributed_matchmaking_tickets
  ADD CONSTRAINT distributed_matchmaking_expiry_order CHECK (expires_at > enqueued_at) NOT VALID,
  ADD CONSTRAINT distributed_matchmaking_heartbeat_order CHECK (heartbeat_at >= enqueued_at) NOT VALID;

ALTER TABLE distributed_matchmaking_tickets
  VALIDATE CONSTRAINT distributed_matchmaking_expiry_order;

ALTER TABLE distributed_matchmaking_tickets
  VALIDATE CONSTRAINT distributed_matchmaking_heartbeat_order;

CREATE INDEX distributed_matchmaking_live_waiting_idx
  ON distributed_matchmaking_tickets(
    region, player_count, protocol_version, expires_at, enqueued_at, ticket_id
  )
  WHERE status = 'waiting';
