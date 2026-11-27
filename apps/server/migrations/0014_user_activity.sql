-- Only bounded operational metadata is collected. Existing game history remains
-- authoritative for outcomes and is not modified by analytics retention.
CREATE TABLE activity_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  collection_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retention_days smallint NOT NULL DEFAULT 90 CHECK (retention_days=90)
);
INSERT INTO activity_settings(singleton) VALUES(true);

CREATE TABLE activity_sessions (
  id uuid PRIMARY KEY,
  session_hash text NOT NULL UNIQUE CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signed_in_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  expires_at timestamptz,
  last_page text CHECK (last_page IN ('lobby','table','rankings','history','replay','private','live','watch','profile','rules','admin'))
);
CREATE INDEX activity_sessions_user_seen ON activity_sessions(user_id,last_seen_at DESC,id DESC);
CREATE INDEX activity_sessions_seen ON activity_sessions(last_seen_at DESC,id DESC);

CREATE TABLE activity_presence (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL,
  last_active_sample_at timestamptz
);
CREATE TABLE activity_events (
  event_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES activity_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('auth','interaction')),
  action text NOT NULL CHECK (action IN ('login','logout','page.view','queue.join','queue.leave','ai.select','private.create','private.accept','private.cancel','watch.open','video.start','video.stop','profile.save','cards.group','cards.sort','declaration.attempt','sound.toggle','help.open')),
  source text NOT NULL CHECK (source IN ('browser','server')),
  page text CHECK (page IN ('lobby','table','rankings','history','replay','private','live','watch','profile','rules','admin')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,event_id)
);
CREATE INDEX activity_events_time ON activity_events(occurred_at DESC,event_id DESC);
CREATE INDEX activity_events_user_time ON activity_events(user_id,occurred_at DESC,event_id DESC);
CREATE INDEX activity_events_session ON activity_events(session_id);

CREATE TABLE activity_ingest_receipts (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,event_id)
);
CREATE INDEX activity_ingest_receipts_time ON activity_ingest_receipts(received_at);

-- One account's active intervals are serialized before allocation. Minute
-- buckets bound storage and permit page/session breakdown without raw inputs.
CREATE TABLE activity_time_buckets (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES activity_sessions(id) ON DELETE CASCADE,
  page text NOT NULL CHECK (page IN ('lobby','table','rankings','history','replay','private','live','watch','profile','rules','admin')),
  minute_at timestamptz NOT NULL CHECK (minute_at=date_trunc('minute',minute_at)),
  active_ms integer NOT NULL CHECK (active_ms>0 AND active_ms<=60000),
  PRIMARY KEY(user_id,session_id,page,minute_at)
);
CREATE INDEX activity_time_buckets_time ON activity_time_buckets(minute_at,user_id);
CREATE INDEX activity_time_buckets_session ON activity_time_buckets(session_id);

-- Metadata-only access paths; activity never selects archived private payloads.
CREATE INDEX game_events_activity_time ON game_events(occurred_at DESC,event_id DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX game_events_activity_actor ON game_events(actor_user_id,occurred_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX ranking_matches_activity_end ON ranking_matches(ended_at DESC,id DESC) WHERE status='completed';
