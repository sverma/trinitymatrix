-- Validation-only agents receive new identities and independent ratings.
-- Keep solver-assisted profiles recognizable without changing their immutable
-- protocol bindings, memory, operator flags, results or request ledger.
UPDATE player_profiles p
SET display_name = left(regexp_replace(p.display_name, ' · v[0-9]+([.][0-9]+)*$', ''), 19) || ' · v2'
FROM ai_agents a
WHERE a.user_id=p.user_id
  AND a.prompt_version='trinity-agent-protocol/2.0.0:a29df5da5bd4c9bf5ef9c3d71150b34ca6452e843c4c967a304087ade66eb5af'
  AND p.display_name NOT LIKE '% · v2';

ALTER TABLE ai_agents ALTER COLUMN prompt_version SET DEFAULT
  'trinity-agent-protocol/3.0.0:29e8318d2970426d179cb9c79c02577cc80b741b9b56083af80a56b4e8525fa1';

-- Readiness is solver-derived and has no meaning in validation-only play.
-- Older requests retain their original audit values, including true/false.
ALTER TABLE ai_model_requests ADD CONSTRAINT ai_validation_only_no_readiness
  CHECK (protocol_id NOT LIKE 'trinity-agent-protocol/3.0.0:%' OR declaration_available IS NULL);
