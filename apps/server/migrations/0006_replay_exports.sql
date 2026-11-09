-- Durable, retryable replay export ledger. Match completion only enqueues a
-- small PostgreSQL row in the same transaction; network I/O to object storage
-- is performed later by horizontally safe background workers.

CREATE TABLE replay_exports (
  match_id uuid PRIMARY KEY REFERENCES ranking_matches(id) ON DELETE RESTRICT,
  export_schema_version smallint NOT NULL DEFAULT 1,
  content_sha256 text,
  object_key text,
  object_version_id text,
  object_etag text,
  event_count bigint,
  export_attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_by text,
  locked_until timestamptz,
  exported_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT replay_exports_schema_version_positive CHECK (export_schema_version > 0),
  CONSTRAINT replay_exports_hash_shape CHECK (
    content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT replay_exports_object_key_length CHECK (
    object_key IS NULL OR char_length(object_key) BETWEEN 1 AND 1024
  ),
  CONSTRAINT replay_exports_event_count_nonnegative CHECK (
    event_count IS NULL OR event_count >= 0
  ),
  CONSTRAINT replay_exports_attempts_nonnegative CHECK (export_attempts >= 0),
  CONSTRAINT replay_exports_lock_shape CHECK (
    (locked_by IS NULL AND locked_until IS NULL)
    OR (locked_by IS NOT NULL AND locked_until IS NOT NULL)
  ),
  CONSTRAINT replay_exports_result_shape CHECK (
    (exported_at IS NULL AND content_sha256 IS NULL AND object_key IS NULL AND event_count IS NULL)
    OR
    (exported_at IS NOT NULL AND content_sha256 IS NOT NULL AND object_key IS NOT NULL AND event_count IS NOT NULL
      AND locked_by IS NULL AND locked_until IS NULL)
  )
);

CREATE INDEX replay_exports_pending_idx
  ON replay_exports(available_at ASC, created_at ASC, match_id ASC)
  WHERE exported_at IS NULL;

CREATE FUNCTION enqueue_completed_match_replay_export() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO replay_exports (match_id)
    VALUES (NEW.id)
    ON CONFLICT (match_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ranking_matches_enqueue_replay_export
AFTER UPDATE OF status ON ranking_matches
FOR EACH ROW EXECUTE FUNCTION enqueue_completed_match_replay_export();

-- Existing completed matches are backfilled without changing their rows. The
-- INSERT is idempotent so a partially retried deployment is harmless.
INSERT INTO replay_exports (match_id)
SELECT id
FROM ranking_matches
WHERE status = 'completed'
ON CONFLICT (match_id) DO NOTHING;
