-- Private practice state is deliberately separate from game results, public
-- ratings, request billing and the live agent's memory.
CREATE TABLE ai_practice_curricula (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 100),
  curriculum_hash text NOT NULL CHECK (curriculum_hash ~ '^[0-9a-f]{64}$'),
  protocol_id text NOT NULL REFERENCES ai_protocol_revisions(id) ON DELETE RESTRICT,
  rules_revision text NOT NULL CHECK (char_length(rules_revision) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id,curriculum_hash,protocol_id,rules_revision)
);

CREATE FUNCTION reject_ai_practice_curriculum_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI practice curriculum bindings are immutable';
END;
$$;
CREATE TRIGGER ai_practice_curricula_immutable BEFORE UPDATE OR DELETE ON ai_practice_curricula
  FOR EACH ROW EXECUTE FUNCTION reject_ai_practice_curriculum_mutation();

CREATE TABLE ai_practice_memory (
  agent_id uuid NOT NULL,
  model_id text NOT NULL,
  protocol_id text NOT NULL,
  curriculum_id text NOT NULL,
  curriculum_hash text NOT NULL,
  rules_revision text NOT NULL,
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes)<=512),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent_id,curriculum_id),
  FOREIGN KEY (agent_id,model_id) REFERENCES ai_agents(user_id,model_id) ON DELETE RESTRICT,
  FOREIGN KEY (curriculum_id,curriculum_hash,protocol_id,rules_revision)
    REFERENCES ai_practice_curricula(id,curriculum_hash,protocol_id,rules_revision) ON DELETE RESTRICT
);

-- Results contain a fixed numeric summary only. Full synthetic hands, prompts,
-- provider messages and response bodies are not stored here.
CREATE FUNCTION ai_practice_metrics_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value)='object' AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(value) item WHERE item.key NOT IN (
      'requestedRounds','completedRounds','trainingEpisodes','evaluationEpisodes','completedEpisodes',
      'requests','retries','validDeclarations','invalidActions','providerErrors','winningDecisionsMissed',
      'knownCostUsd','unknownCostRequests','maxLatencyMs','maxTurnDurationMs'
    ) OR jsonb_typeof(item.value)<>'number'
      OR CASE WHEN jsonb_typeof(item.value)='number' THEN (item.value::text)::numeric<0
        OR (item.value::text)::numeric>9007199254740991 ELSE false END
  );
$$;

CREATE TABLE ai_practice_runs (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL,
  model_id text NOT NULL,
  protocol_id text NOT NULL,
  curriculum_id text NOT NULL,
  curriculum_hash text NOT NULL,
  rules_revision text NOT NULL,
  baseline_live_memory text NOT NULL CHECK (char_length(baseline_live_memory)<=4000),
  baseline_practice_revision bigint NOT NULL CHECK (baseline_practice_revision>=0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','expired')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
  completed_at timestamptz,
  notes text CHECK (char_length(notes)<=512),
  metrics jsonb CHECK (ai_practice_metrics_valid(metrics)),
  promotion_requested boolean NOT NULL DEFAULT false,
  notes_promoted boolean NOT NULL DEFAULT false,
  promotion_reason text CHECK (promotion_reason IN ('promotion-disabled','no-notes','not-current-protocol','active-match','live-memory-changed')),
  FOREIGN KEY (agent_id,model_id) REFERENCES ai_agents(user_id,model_id) ON DELETE RESTRICT,
  FOREIGN KEY (curriculum_id,curriculum_hash,protocol_id,rules_revision)
    REFERENCES ai_practice_curricula(id,curriculum_hash,protocol_id,rules_revision) ON DELETE RESTRICT,
  CHECK (expires_at>started_at),
  CHECK (
    (status='running' AND completed_at IS NULL AND notes IS NULL AND metrics IS NULL
      AND NOT promotion_requested AND NOT notes_promoted AND promotion_reason IS NULL)
    OR (status='completed' AND completed_at IS NOT NULL AND notes IS NOT NULL AND metrics IS NOT NULL
      AND ((notes_promoted AND promotion_requested AND promotion_reason IS NULL) OR (NOT notes_promoted AND promotion_reason IS NOT NULL)))
    OR (status IN ('failed','expired') AND completed_at IS NOT NULL AND notes IS NULL AND metrics IS NULL
      AND NOT promotion_requested AND NOT notes_promoted AND promotion_reason IS NULL)
  )
);
CREATE UNIQUE INDEX ai_practice_one_running_per_agent ON ai_practice_runs(agent_id) WHERE status='running';
CREATE INDEX ai_practice_runs_agent_history ON ai_practice_runs(agent_id,started_at DESC,id DESC);

CREATE FUNCTION protect_ai_practice_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.model_id IS DISTINCT FROM OLD.model_id
    OR NEW.protocol_id IS DISTINCT FROM OLD.protocol_id OR NEW.curriculum_id IS DISTINCT FROM OLD.curriculum_id
    OR NEW.curriculum_hash IS DISTINCT FROM OLD.curriculum_hash OR NEW.rules_revision IS DISTINCT FROM OLD.rules_revision
  ) THEN
    RAISE EXCEPTION 'AI practice identity and curriculum bindings are immutable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ai_agents a JOIN ai_protocol_revisions p ON p.id=a.prompt_version
    WHERE a.user_id=NEW.agent_id AND a.model_id=NEW.model_id AND a.prompt_version=NEW.protocol_id AND p.rules_revision=NEW.rules_revision) THEN
    RAISE EXCEPTION 'AI practice requires the exact agent, model, protocol and rules binding';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_practice_memory_binding BEFORE INSERT OR UPDATE ON ai_practice_memory
  FOR EACH ROW EXECUTE FUNCTION protect_ai_practice_binding();
CREATE TRIGGER ai_practice_runs_binding BEFORE INSERT OR UPDATE ON ai_practice_runs
  FOR EACH ROW EXECUTE FUNCTION protect_ai_practice_binding();

CREATE FUNCTION protect_ai_practice_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'AI practice run history is immutable'; END IF;
  IF OLD.status<>'running' THEN RAISE EXCEPTION 'A finished AI practice run is immutable'; END IF;
  IF NEW.baseline_live_memory IS DISTINCT FROM OLD.baseline_live_memory
    OR NEW.baseline_practice_revision IS DISTINCT FROM OLD.baseline_practice_revision
    OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'AI practice baselines and leases are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ai_practice_runs_immutable_history BEFORE UPDATE OR DELETE ON ai_practice_runs
  FOR EACH ROW EXECUTE FUNCTION protect_ai_practice_run();
