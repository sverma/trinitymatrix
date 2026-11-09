-- Durable coordination primitives for horizontally scaled gameplay. This
-- migration is additive so the previous server version remains deployable
-- while the distributed runtime is rolled out behind a feature flag.

CREATE TABLE game_runtime_owners (
  match_id uuid PRIMARY KEY REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  owner_instance_id text NOT NULL,
  fencing_token bigint NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  protocol_min integer NOT NULL,
  protocol_max integer NOT NULL,
  draining boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT game_runtime_owner_id_length CHECK (char_length(owner_instance_id) BETWEEN 1 AND 200),
  CONSTRAINT game_runtime_fence_positive CHECK (fencing_token > 0),
  CONSTRAINT game_runtime_protocol_range CHECK (
    protocol_min > 0 AND protocol_max >= protocol_min
  )
);

CREATE INDEX game_runtime_owners_expiry_idx
  ON game_runtime_owners(lease_expires_at ASC, match_id ASC);

CREATE TABLE durable_game_commands (
  match_id uuid NOT NULL REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  expected_revision bigint NOT NULL,
  fencing_token bigint NOT NULL,
  command_type text NOT NULL,
  command_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  event_sequence bigint NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (match_id, command_id),
  CONSTRAINT durable_game_commands_actor_participant
    FOREIGN KEY (match_id, actor_user_id)
    REFERENCES match_participants(match_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT durable_game_commands_revision_positive CHECK (expected_revision > 0),
  CONSTRAINT durable_game_commands_fence_positive CHECK (fencing_token > 0),
  CONSTRAINT durable_game_commands_type_length CHECK (char_length(command_type) BETWEEN 1 AND 100),
  CONSTRAINT durable_game_commands_command_object CHECK (jsonb_typeof(command_payload) = 'object'),
  CONSTRAINT durable_game_commands_result_object CHECK (jsonb_typeof(result_payload) = 'object'),
  CONSTRAINT durable_game_commands_event
    FOREIGN KEY (match_id, event_sequence)
    REFERENCES game_events(match_id, sequence)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX durable_game_commands_actor_idx
  ON durable_game_commands(actor_user_id, accepted_at DESC);

CREATE TABLE game_event_outbox (
  outbox_id uuid PRIMARY KEY,
  match_id uuid NOT NULL,
  event_sequence bigint NOT NULL,
  fencing_token bigint NOT NULL,
  topic text NOT NULL,
  routing_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  locked_by text,
  locked_until timestamptz,
  published_at timestamptz,
  publish_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT game_event_outbox_event_unique UNIQUE (match_id, event_sequence),
  CONSTRAINT game_event_outbox_event
    FOREIGN KEY (match_id, event_sequence)
    REFERENCES game_events(match_id, sequence)
    ON DELETE RESTRICT,
  CONSTRAINT game_event_outbox_fence_positive CHECK (fencing_token > 0),
  CONSTRAINT game_event_outbox_topic_length CHECK (char_length(topic) BETWEEN 1 AND 100),
  CONSTRAINT game_event_outbox_routing_length CHECK (char_length(routing_key) BETWEEN 1 AND 200),
  CONSTRAINT game_event_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT game_event_outbox_attempts_nonnegative CHECK (publish_attempts >= 0),
  CONSTRAINT game_event_outbox_lock_shape CHECK (
    (locked_by IS NULL AND locked_until IS NULL)
    OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)
  )
);

CREATE INDEX game_event_outbox_pending_idx
  ON game_event_outbox(available_at ASC, created_at ASC, outbox_id ASC)
  WHERE published_at IS NULL;

CREATE TABLE recoverable_game_deadlines (
  match_id uuid NOT NULL REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  deadline_type text NOT NULL,
  due_at timestamptz NOT NULL,
  expected_revision bigint NOT NULL,
  fencing_token bigint NOT NULL,
  payload jsonb NOT NULL,
  claimed_by text,
  claimed_until timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, deadline_type),
  CONSTRAINT recoverable_game_deadlines_type CHECK (
    deadline_type IN ('turn', 'showdown')
  ),
  CONSTRAINT recoverable_game_deadlines_revision_positive CHECK (expected_revision > 0),
  CONSTRAINT recoverable_game_deadlines_fence_positive CHECK (fencing_token > 0),
  CONSTRAINT recoverable_game_deadlines_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT recoverable_game_deadlines_claim_shape CHECK (
    (claimed_by IS NULL AND claimed_until IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)
  )
);

CREATE INDEX recoverable_game_deadlines_due_idx
  ON recoverable_game_deadlines(due_at ASC, match_id ASC)
  WHERE completed_at IS NULL;

CREATE TABLE distributed_matchmaking_tickets (
  ticket_id uuid PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  player_count smallint NOT NULL,
  region text NOT NULL,
  protocol_version integer NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  match_id uuid REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  claimed_by text,
  claimed_until timestamptz,
  enqueued_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT distributed_matchmaking_player_count CHECK (player_count IN (2, 6)),
  CONSTRAINT distributed_matchmaking_region_length CHECK (char_length(region) BETWEEN 1 AND 32),
  CONSTRAINT distributed_matchmaking_protocol_positive CHECK (protocol_version > 0),
  CONSTRAINT distributed_matchmaking_status CHECK (status IN ('waiting', 'matched', 'cancelled')),
  CONSTRAINT distributed_matchmaking_lifecycle CHECK (
    (status = 'waiting' AND match_id IS NULL)
    OR (status = 'matched' AND match_id IS NOT NULL)
    OR (status = 'cancelled' AND match_id IS NULL)
  ),
  CONSTRAINT distributed_matchmaking_claim_shape CHECK (
    (claimed_by IS NULL AND claimed_until IS NULL)
    OR (claimed_by IS NOT NULL AND claimed_until IS NOT NULL)
  )
);

CREATE UNIQUE INDEX distributed_matchmaking_player_waiting_unique
  ON distributed_matchmaking_tickets(player_id)
  WHERE status = 'waiting';

CREATE INDEX distributed_matchmaking_waiting_idx
  ON distributed_matchmaking_tickets(region, player_count, protocol_version, enqueued_at, ticket_id)
  WHERE status = 'waiting';
