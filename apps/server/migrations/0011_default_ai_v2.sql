-- Agent cohort labels are separate from immutable historical prompt bindings.
-- Earlier identities keep their original UUID, protocol, memory and ratings.
UPDATE player_profiles p
SET display_name = left(regexp_replace(p.display_name, ' · v[0-9]+([.][0-9]+)*$', ''), 19) || ' · v0'
FROM ai_agents a
WHERE a.user_id=p.user_id AND a.prompt_version='trinity-v1'
  AND p.display_name NOT LIKE '% · v0';

-- The existing v2 cohort becomes the ordinary, unsuffixed player name.
UPDATE player_profiles p
SET display_name = regexp_replace(p.display_name, ' · v2$', '')
FROM ai_agents a
WHERE a.user_id=p.user_id
  AND a.prompt_version='trinity-agent-protocol/2.0.0:a29df5da5bd4c9bf5ef9c3d71150b34ca6452e843c4c967a304087ade66eb5af'
  AND p.display_name LIKE '% · v2';

ALTER TABLE ai_agents ALTER COLUMN prompt_version SET DEFAULT
  'trinity-agent-protocol/2.0.0:a29df5da5bd4c9bf5ef9c3d71150b34ca6452e843c4c967a304087ade66eb5af';
