export interface StateStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  consumeChallenge<T>(
    key: string,
    expectedCodeHash: string,
    nowMs: number,
    maxAttempts: number
  ): Promise<{ status: "verified"; value: T } | { status: "invalid" | "missing" }>;
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
};

const consumeChallengeScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return {'missing', ''}
end

local decoded, challenge = pcall(cjson.decode, raw)
if not decoded or type(challenge) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {'missing', ''}
end

local now_ms = tonumber(ARGV[2])
local max_attempts = tonumber(ARGV[3])
local expires_at = tonumber(challenge.expiresAt)
local failed_attempts = tonumber(challenge.failedAttempts)
if not expires_at or not failed_attempts or expires_at <= now_ms or failed_attempts >= max_attempts then
  redis.call('DEL', KEYS[1])
  return {'invalid', ''}
end

if challenge.codeHash == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {'verified', raw}
end

challenge.failedAttempts = failed_attempts + 1
local remaining_ms = math.ceil(expires_at - now_ms)
local redis_ttl = redis.call('PTTL', KEYS[1])
if redis_ttl > 0 and redis_ttl < remaining_ms then
  remaining_ms = redis_ttl
end
if remaining_ms <= 0 then
  redis.call('DEL', KEYS[1])
  return {'invalid', ''}
end
redis.call('SET', KEYS[1], cjson.encode(challenge), 'PX', remaining_ms)
return {'invalid', ''}
`;

export class RedisStateStore implements StateStore {
  constructor(private readonly redis: RedisLike, private readonly namespace = "trinitymatrix:v1") {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(`${this.namespace}:${key}`);
    return value ? JSON.parse(value) as T : null;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs && ttlMs > 0) {
      await this.redis.set(`${this.namespace}:${key}`, serialized, { PX: Math.ceil(ttlMs) });
    } else {
      await this.redis.set(`${this.namespace}:${key}`, serialized);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`${this.namespace}:${key}`);
  }

  async consumeChallenge<T>(
    key: string,
    expectedCodeHash: string,
    nowMs: number,
    maxAttempts: number
  ): Promise<{ status: "verified"; value: T } | { status: "invalid" | "missing" }> {
    const result = await this.redis.eval(consumeChallengeScript, {
      keys: [`${this.namespace}:${key}`],
      arguments: [expectedCodeHash, String(nowMs), String(maxAttempts)]
    });
    if (!Array.isArray(result) || typeof result[0] !== "string") return { status: "missing" };
    if (result[0] !== "verified") {
      return { status: result[0] === "invalid" ? "invalid" : "missing" };
    }
    if (typeof result[1] !== "string") return { status: "missing" };
    return { status: "verified", value: JSON.parse(result[1]) as T };
  }
}

export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, { serialized: string; expiresAt: number | null }>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return JSON.parse(entry.serialized) as T;
  }

  async set(key: string, value: unknown, ttlMs?: number): Promise<void> {
    this.values.set(key, {
      serialized: JSON.stringify(value),
      expiresAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : null
    });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async consumeChallenge<T>(
    key: string,
    expectedCodeHash: string,
    nowMs: number,
    maxAttempts: number
  ): Promise<{ status: "verified"; value: T } | { status: "invalid" | "missing" }> {
    const entry = this.values.get(key);
    if (!entry) return { status: "missing" };
    if (entry.expiresAt !== null && entry.expiresAt <= nowMs) {
      this.values.delete(key);
      return { status: "invalid" };
    }
    const value = JSON.parse(entry.serialized) as {
      codeHash?: unknown;
      expiresAt?: unknown;
      failedAttempts?: unknown;
    };
    if (
      typeof value.codeHash !== "string"
      || typeof value.expiresAt !== "number"
      || typeof value.failedAttempts !== "number"
      || value.expiresAt <= nowMs
      || value.failedAttempts >= maxAttempts
    ) {
      this.values.delete(key);
      return { status: "invalid" };
    }
    if (value.codeHash === expectedCodeHash) {
      this.values.delete(key);
      return { status: "verified", value: value as T };
    }
    value.failedAttempts += 1;
    this.values.set(key, {
      serialized: JSON.stringify(value),
      expiresAt: entry.expiresAt
    });
    return { status: "invalid" };
  }
}
