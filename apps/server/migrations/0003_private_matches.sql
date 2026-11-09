ALTER TABLE ranking_matches
  ADD COLUMN match_type text NOT NULL DEFAULT 'general';

ALTER TABLE app_users
  ADD CONSTRAINT app_users_id_email_unique UNIQUE (id, email);

ALTER TABLE ranking_matches
  ADD CONSTRAINT ranking_matches_type CHECK (match_type IN ('general', 'private'));

ALTER TABLE ranking_matches
  ADD CONSTRAINT ranking_matches_id_type_unique UNIQUE (id, match_type);

CREATE INDEX ranking_matches_active_type_idx
  ON ranking_matches(match_type, started_at DESC, id DESC)
  WHERE status = 'active';

CREATE TABLE private_match_rooms (
  id uuid PRIMARY KEY,
  room_code text NOT NULL UNIQUE,
  creator_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  player_count smallint NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  match_id uuid UNIQUE,
  match_type text NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT private_match_rooms_code_shape CHECK (
    room_code ~ '^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{6}$'
  ),
  CONSTRAINT private_match_rooms_player_count CHECK (player_count IN (2, 6)),
  CONSTRAINT private_match_rooms_status CHECK (status IN ('waiting', 'active', 'completed', 'cancelled')),
  CONSTRAINT private_match_rooms_type CHECK (match_type = 'private'),
  CONSTRAINT private_match_rooms_lifecycle CHECK (
    (status = 'waiting' AND match_id IS NULL AND started_at IS NULL AND completed_at IS NULL)
    OR (status = 'active' AND match_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND match_id IS NOT NULL AND started_at IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'cancelled' AND match_id IS NULL AND started_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX private_match_rooms_creator_idx
  ON private_match_rooms(creator_user_id, created_at DESC);
CREATE INDEX private_match_rooms_waiting_idx
  ON private_match_rooms(created_at ASC, id ASC)
  WHERE status = 'waiting';

CREATE TABLE private_match_invitations (
  room_id uuid NOT NULL REFERENCES private_match_rooms(id) ON DELETE RESTRICT,
  invite_email text NOT NULL,
  seat_number smallint NOT NULL,
  accepted_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (room_id, invite_email),
  CONSTRAINT private_match_invitations_seat_unique UNIQUE (room_id, seat_number),
  CONSTRAINT private_match_invitations_email_normalized CHECK (invite_email = lower(btrim(invite_email))),
  CONSTRAINT private_match_invitations_email_length CHECK (char_length(invite_email) BETWEEN 3 AND 254),
  CONSTRAINT private_match_invitations_seat CHECK (seat_number BETWEEN 1 AND 5),
  CONSTRAINT private_match_invitations_acceptance_shape CHECK (
    (accepted_by_user_id IS NULL AND accepted_at IS NULL)
    OR (accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX private_match_invitations_user_room_unique
  ON private_match_invitations(room_id, accepted_by_user_id)
  WHERE accepted_by_user_id IS NOT NULL;
CREATE INDEX private_match_invitations_open_email_idx
  ON private_match_invitations(invite_email, created_at DESC)
  WHERE accepted_by_user_id IS NULL;

ALTER TABLE private_match_invitations
  ADD CONSTRAINT private_match_invitations_exact_identity
  FOREIGN KEY (accepted_by_user_id, invite_email)
  REFERENCES app_users(id, email)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE private_match_rooms
  ADD CONSTRAINT private_match_rooms_match_is_private
  FOREIGN KEY (match_id, match_type)
  REFERENCES ranking_matches(id, match_type)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
