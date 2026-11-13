type RedisReader = { eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown> };

// Inspect membership inside Redis so private game snapshots never enter the
// practice runner or a model request. Unknown/corrupt state defers promotion.
export const practiceIdleScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, state = pcall(cjson.decode, raw)
if not ok or type(state) ~= 'table' or type(state.games) ~= 'table' or type(state.queues) ~= 'table' then return -1 end
for _, queue in pairs(state.queues) do
  if type(queue) ~= 'table' then return -1 end
  for _, id in ipairs(queue) do if id == ARGV[1] then return 1 end end
end
for _, game in ipairs(state.games) do
  if type(game) ~= 'table' or type(game.seats) ~= 'table' then return -1 end
  if game.phase ~= 'finished' then
    for _, seat in ipairs(game.seats) do if seat.id == ARGV[1] then return 1 end end
  end
end
return 0
`;

export async function isPracticePromotionIdle(redis: RedisReader, namespace: string, agentId: string): Promise<boolean> {
  try {
    return await redis.eval(practiceIdleScript, { keys: [`${namespace}:matchmaker:active-games`], arguments: [agentId] }) === 0;
  } catch { return false; }
}
