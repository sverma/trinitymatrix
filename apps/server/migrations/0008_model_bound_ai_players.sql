ALTER TABLE app_users
  ADD COLUMN actor_kind text NOT NULL DEFAULT 'human',
  ADD CONSTRAINT app_users_actor_kind CHECK (actor_kind IN ('human', 'ai')),
  ADD CONSTRAINT app_users_id_actor_kind_unique UNIQUE (id, actor_kind);

CREATE FUNCTION reject_actor_kind_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_kind IS DISTINCT FROM OLD.actor_kind THEN
    RAISE EXCEPTION 'A player identity cannot change between human and AI';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER app_users_immutable_actor_kind
BEFORE UPDATE ON app_users
FOR EACH ROW EXECUTE FUNCTION reject_actor_kind_change();

CREATE TABLE ai_agents (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL DEFAULT 'ai' CHECK (actor_kind = 'ai'),
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 3 AND 200),
  model_name text NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 200),
  prompt_version text NOT NULL DEFAULT 'trinity-v1' CHECK (char_length(prompt_version) BETWEEN 1 AND 100),
  memory text NOT NULL DEFAULT '' CHECK (char_length(memory) <= 4000),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ai_agents_identity_kind FOREIGN KEY (user_id, actor_kind)
    REFERENCES app_users(id, actor_kind) ON DELETE RESTRICT,
  CONSTRAINT ai_agents_user_model_unique UNIQUE (user_id, model_id)
);

CREATE FUNCTION reject_ai_model_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.model_id IS DISTINCT FROM OLD.model_id
    OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version THEN
    RAISE EXCEPTION 'An AI player is permanently bound to its model and prompt version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_agents_immutable_model
BEFORE UPDATE ON ai_agents
FOR EACH ROW EXECUTE FUNCTION reject_ai_model_change();

CREATE TABLE ai_model_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES ai_agents(user_id) ON DELETE RESTRICT,
  model_id text NOT NULL,
  budget_day date NOT NULL,
  reserved_usd numeric(12,6) NOT NULL CHECK (reserved_usd > 0),
  actual_usd numeric(12,6) CHECK (actual_usd >= 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT ai_model_requests_bound_model FOREIGN KEY (user_id, model_id)
    REFERENCES ai_agents(user_id, model_id) ON DELETE RESTRICT
);

CREATE INDEX ai_model_requests_budget_day_idx ON ai_model_requests(budget_day);

CREATE TABLE player_rankings_by_composition (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  composition text NOT NULL CHECK (composition IN ('human', 'ai', 'mixed')),
  rating integer NOT NULL DEFAULT 1000 CHECK (rating >= 0),
  games_played integer NOT NULL DEFAULT 0 CHECK (games_played >= 0),
  wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
  drops integer NOT NULL DEFAULT 0 CHECK (drops >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, composition),
  CONSTRAINT player_rankings_composition_counts CHECK (games_played = wins + losses + drops)
);

INSERT INTO player_rankings_by_composition
  (user_id, composition, rating, games_played, wins, losses, drops, updated_at)
SELECT user_id, 'human', rating, games_played, wins, losses, drops, updated_at
FROM player_rankings;

CREATE INDEX player_rankings_composition_leaderboard_idx
  ON player_rankings_by_composition(composition, rating DESC, wins DESC, user_id ASC);
