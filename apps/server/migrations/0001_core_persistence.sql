CREATE TABLE app_users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  suspended_at timestamptz,
  suspension_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT app_users_email_normalized CHECK (email = lower(btrim(email))),
  CONSTRAINT app_users_email_length CHECK (char_length(email) BETWEEN 3 AND 320),
  CONSTRAINT app_users_email_unique UNIQUE (email),
  CONSTRAINT app_users_suspension_shape CHECK (
    (suspended_at IS NULL AND suspension_reason IS NULL)
    OR
    (suspended_at IS NOT NULL AND char_length(suspension_reason) BETWEEN 3 AND 500)
  )
);

CREATE TABLE player_profiles (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  badge_id text NOT NULL DEFAULT 'rookie',
  phone_country_code text,
  phone_national_number text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT player_profiles_display_name_length CHECK (char_length(display_name) BETWEEN 2 AND 24),
  CONSTRAINT player_profiles_badge CHECK (badge_id IN (
    'rookie', 'strategist', 'card-shark', 'royal', 'hot-streak', 'diamond-hand', 'champion', 'night-owl'
  )),
  CONSTRAINT player_profiles_phone_pair CHECK (
    (phone_country_code IS NULL AND phone_national_number IS NULL)
    OR
    (phone_country_code ~ '^\+[1-9][0-9]{0,2}$'
      AND phone_national_number ~ '^[0-9]{4,14}$'
      AND char_length(substring(phone_country_code FROM 2) || phone_national_number) <= 15)
  )
);

CREATE TABLE ranking_matches (
  id uuid PRIMARY KEY,
  public_name text NOT NULL,
  player_count smallint NOT NULL,
  status text NOT NULL DEFAULT 'active',
  winner_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  end_reason text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ranking_matches_player_count CHECK (player_count IN (2, 6)),
  CONSTRAINT ranking_matches_public_name_unique UNIQUE (public_name),
  CONSTRAINT ranking_matches_public_name_shape CHECK (public_name ~ '^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{8}$'),
  CONSTRAINT ranking_matches_status CHECK (status IN ('active', 'completed', 'abandoned')),
  CONSTRAINT ranking_matches_end_reason CHECK (
    end_reason IS NULL OR end_reason IN ('declaration', 'invalid-declaration', 'player-dropped', 'cancelled')
  ),
  CONSTRAINT ranking_matches_completion_shape CHECK (
    (status = 'active' AND winner_user_id IS NULL AND end_reason IS NULL AND ended_at IS NULL)
    OR
    (status = 'completed' AND winner_user_id IS NOT NULL AND end_reason IS NOT NULL AND ended_at IS NOT NULL)
    OR
    (status = 'abandoned' AND winner_user_id IS NULL AND end_reason = 'cancelled' AND ended_at IS NOT NULL)
  )
);

CREATE TABLE match_participants (
  match_id uuid NOT NULL REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  seat_number smallint NOT NULL,
  display_name text NOT NULL,
  badge_id text NOT NULL,
  outcome text,
  score_delta integer,
  rating_after integer,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, user_id),
  CONSTRAINT match_participants_seat_unique UNIQUE (match_id, seat_number),
  CONSTRAINT match_participants_seat_positive CHECK (seat_number >= 0 AND seat_number < 6),
  CONSTRAINT match_participants_display_name_length CHECK (char_length(display_name) BETWEEN 2 AND 24),
  CONSTRAINT match_participants_badge CHECK (badge_id IN (
    'rookie', 'strategist', 'card-shark', 'royal', 'hot-streak', 'diamond-hand', 'champion', 'night-owl'
  )),
  CONSTRAINT match_participants_outcome CHECK (outcome IS NULL OR outcome IN ('won', 'lost', 'dropped')),
  CONSTRAINT match_participants_result_shape CHECK (
    (outcome IS NULL AND score_delta IS NULL AND rating_after IS NULL)
    OR
    (outcome IS NOT NULL AND score_delta IS NOT NULL AND rating_after IS NOT NULL)
  )
);

ALTER TABLE ranking_matches
  ADD CONSTRAINT ranking_matches_winner_participant
  FOREIGN KEY (id, winner_user_id)
  REFERENCES match_participants(match_id, user_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE game_events (
  event_id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  actor_user_id uuid,
  command_id uuid,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT game_events_match_sequence_unique UNIQUE (match_id, sequence),
  CONSTRAINT game_events_match_command_unique UNIQUE (match_id, command_id),
  CONSTRAINT game_events_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT game_events_type_length CHECK (char_length(event_type) BETWEEN 1 AND 100),
  CONSTRAINT game_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT game_events_actor_participant
    FOREIGN KEY (match_id, actor_user_id)
    REFERENCES match_participants(match_id, user_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX game_events_match_order_idx ON game_events(match_id, sequence);

CREATE FUNCTION reject_game_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'game_events is append-only';
END;
$$;

CREATE TRIGGER game_events_reject_update
BEFORE UPDATE ON game_events
FOR EACH ROW EXECUTE FUNCTION reject_game_event_mutation();

CREATE TRIGGER game_events_reject_delete
BEFORE DELETE ON game_events
FOR EACH ROW EXECUTE FUNCTION reject_game_event_mutation();

CREATE TABLE admin_audit_log (
  audit_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  target_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT admin_audit_action_length CHECK (char_length(action) BETWEEN 3 AND 100),
  CONSTRAINT admin_audit_details_object CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX admin_audit_log_page_idx ON admin_audit_log(occurred_at DESC, audit_id DESC);
CREATE INDEX admin_audit_log_target_idx ON admin_audit_log(target_user_id, occurred_at DESC);

CREATE FUNCTION reject_admin_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$;

CREATE TRIGGER admin_audit_log_reject_update
BEFORE UPDATE ON admin_audit_log
FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE TRIGGER admin_audit_log_reject_delete
BEFORE DELETE ON admin_audit_log
FOR EACH ROW EXECUTE FUNCTION reject_admin_audit_mutation();

CREATE TABLE player_rankings (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  rating integer NOT NULL DEFAULT 1000,
  games_played integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  drops integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT player_rankings_rating_nonnegative CHECK (rating >= 0),
  CONSTRAINT player_rankings_counts_nonnegative CHECK (
    games_played >= 0 AND wins >= 0 AND losses >= 0 AND drops >= 0
  ),
  CONSTRAINT player_rankings_counts_balance CHECK (games_played = wins + losses + drops)
);

CREATE INDEX player_rankings_leaderboard_idx
  ON player_rankings(rating DESC, wins DESC, user_id ASC);

CREATE INDEX match_participants_user_history_idx
  ON match_participants(user_id, match_id);

CREATE INDEX ranking_matches_started_idx
  ON ranking_matches(started_at DESC, id DESC);
