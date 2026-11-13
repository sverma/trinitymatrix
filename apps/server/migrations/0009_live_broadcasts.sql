CREATE TABLE live_broadcasts (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL UNIQUE REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  public_name text NOT NULL UNIQUE,
  delay_ms integer NOT NULL DEFAULT 120000 CHECK (delay_ms = 120000),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  closed_at timestamptz,
  result_recorded_at timestamptz,
  CHECK (public_name ~ '^[a-z][a-z0-9]{1,15}-[a-z][a-z0-9]{1,15}-[0-9]{8}$')
);
CREATE INDEX live_broadcasts_directory_idx ON live_broadcasts(created_at DESC, id DESC) WHERE closed_at IS NULL;
CREATE INDEX game_events_broadcast_release_idx ON game_events(match_id, recorded_at, occurred_at, sequence);

CREATE FUNCTION validate_live_broadcast() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ranking_matches WHERE id=NEW.match_id AND match_type='general' AND public_name=NEW.public_name) THEN
    RAISE EXCEPTION 'Only public general matches may be broadcast';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER live_broadcast_validate BEFORE INSERT OR UPDATE OF match_id, public_name ON live_broadcasts
  FOR EACH ROW EXECUTE FUNCTION validate_live_broadcast();

-- Completion receipt time is independent of the gameplay timestamp. This gate
-- prevents even a backdated completion from publishing its outcome immediately.
CREATE FUNCTION record_live_broadcast_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' AND OLD.status = 'active' THEN
    UPDATE live_broadcasts SET result_recorded_at=clock_timestamp() WHERE match_id=NEW.id AND result_recorded_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER live_broadcast_result_received AFTER UPDATE OF status ON ranking_matches
  FOR EACH ROW EXECUTE FUNCTION record_live_broadcast_result();

CREATE TABLE live_broadcast_comments (
  id uuid PRIMARY KEY,
  broadcast_id uuid NOT NULL REFERENCES live_broadcasts(id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  client_message_id uuid NOT NULL,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at timestamptz NOT NULL,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  UNIQUE (broadcast_id, author_user_id, client_message_id),
  CHECK (released_at >= created_at),
  CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL))
);
CREATE INDEX live_broadcast_comments_page_idx ON live_broadcast_comments(broadcast_id, released_at, created_at DESC, id DESC);
CREATE INDEX live_broadcast_comments_rate_idx ON live_broadcast_comments(author_user_id, created_at DESC);

CREATE TABLE live_broadcast_comment_reports (
  id uuid PRIMARY KEY,
  comment_id uuid NOT NULL REFERENCES live_broadcast_comments(id) ON DELETE RESTRICT,
  reporter_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  UNIQUE (comment_id, reporter_id)
);
CREATE INDEX live_broadcast_reports_pending_idx ON live_broadcast_comment_reports(created_at, id) WHERE resolved_at IS NULL;

CREATE TABLE live_broadcast_video_sessions (
  id uuid PRIMARY KEY,
  broadcast_id uuid NOT NULL REFERENCES live_broadcasts(id) ON DELETE RESTRICT,
  publisher_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('starting','live','stopped','interrupted')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz
);
CREATE UNIQUE INDEX live_broadcast_video_active_idx ON live_broadcast_video_sessions(broadcast_id) WHERE status IN ('starting','live');
