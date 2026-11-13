CREATE TABLE ai_protocol_revisions (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 100),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  semver text NOT NULL CHECK (semver ~ '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$'),
  rules_revision text NOT NULL CHECK (char_length(rules_revision) BETWEEN 1 AND 100),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION reject_ai_protocol_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI protocol revision metadata is immutable';
END;
$$;
CREATE TRIGGER ai_protocol_revisions_immutable BEFORE UPDATE OR DELETE ON ai_protocol_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_ai_protocol_mutation();

ALTER TABLE ai_model_requests
  ADD COLUMN protocol_id text REFERENCES ai_protocol_revisions(id) ON DELETE RESTRICT,
  -- Also identifies disposable qualification games and requests whose live
  -- initial archive is still pending, so deliberately has no match-table FK.
  ADD COLUMN match_id uuid,
  ADD COLUMN game_revision bigint CHECK (game_revision >= 0),
  ADD COLUMN tools_version text CHECK (char_length(tools_version) BETWEEN 1 AND 100),
  ADD COLUMN server_revision text CHECK (char_length(server_revision) BETWEEN 1 AND 100),
  ADD COLUMN declaration_available boolean,
  ADD COLUMN action text CHECK (action IN ('draw-stock','draw-discard','discard','declare','submit-hand')),
  ADD COLUMN outcome text CHECK (outcome IN ('accepted','policy-rejected','server-rejected','provider-failed','stale','cancelled'));

CREATE INDEX ai_model_requests_match_revision_idx ON ai_model_requests(match_id,game_revision,created_at) WHERE match_id IS NOT NULL;

CREATE FUNCTION protect_ai_request_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.model_id IS DISTINCT FROM OLD.model_id
    OR NEW.protocol_id IS DISTINCT FROM OLD.protocol_id OR NEW.match_id IS DISTINCT FROM OLD.match_id
    OR NEW.game_revision IS DISTINCT FROM OLD.game_revision OR NEW.tools_version IS DISTINCT FROM OLD.tools_version
    OR NEW.server_revision IS DISTINCT FROM OLD.server_revision
    OR NEW.declaration_available IS DISTINCT FROM OLD.declaration_available THEN
    RAISE EXCEPTION 'AI request provenance is immutable';
  END IF;
  IF (OLD.action IS NOT NULL AND NEW.action IS DISTINCT FROM OLD.action)
    OR (OLD.outcome IS NOT NULL AND NEW.outcome IS DISTINCT FROM OLD.outcome) THEN
    RAISE EXCEPTION 'AI request outcome is write-once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_model_requests_protect_provenance BEFORE UPDATE ON ai_model_requests
  FOR EACH ROW EXECUTE FUNCTION protect_ai_request_provenance();
