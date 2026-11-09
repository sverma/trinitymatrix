type ValkeyEvalClient = {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
};

type RateLimitResult = { current: number; ttl: number };
type RateLimitCallback = (error: Error | null, result?: RateLimitResult) => void;
type StoreOptions = {
  continueExceeding?: boolean;
  exponentialBackoff?: boolean;
};
type ChildStoreOptions = StoreOptions & {
  routeInfo?: { method?: unknown; url?: unknown };
};

const incrementScript = `
local current = redis.call('INCR', KEYS[1])
local time_window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
local continue_exceeding = ARGV[3] == 'true'
local exponential_backoff = ARGV[4] == 'true'

if current == 1 or (continue_exceeding and current > maximum) then
  redis.call('PEXPIRE', KEYS[1], time_window)
elseif exponential_backoff and current > maximum then
  local exponent = current - maximum - 1
  time_window = math.min(time_window * (2 ^ exponent), 9007199254740991)
  redis.call('PEXPIRE', KEYS[1], time_window)
else
  time_window = redis.call('PTTL', KEYS[1])
end

return {current, time_window}
`;

function normalizeResult(result: unknown): RateLimitResult {
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("Valkey returned an invalid rate-limit result.");
  }
  const current = Number(result[0]);
  const ttl = Number(result[1]);
  if (!Number.isSafeInteger(current) || current < 1 || !Number.isFinite(ttl)) {
    throw new Error("Valkey returned an invalid rate-limit counter.");
  }
  return { current, ttl: Math.max(0, ttl) };
}

/**
 * Creates the callback-style store expected by @fastify/rate-limit while
 * keeping counters atomic and shared by every application replica.
 */
export function createValkeyRateLimitStore(
  client: ValkeyEvalClient,
  namespace: string
) {
  return class ValkeyRateLimitStore {
    private readonly continueExceeding: boolean;
    private readonly exponentialBackoff: boolean;

    constructor(
      options: StoreOptions,
      private readonly keyPrefix = `${namespace}:global:`
    ) {
      this.continueExceeding = options.continueExceeding === true;
      this.exponentialBackoff = options.exponentialBackoff === true;
    }

    incr(key: string, callback: RateLimitCallback, timeWindow: number, max: number): void {
      void client.eval(incrementScript, {
        keys: [`${this.keyPrefix}${key}`],
        arguments: [
          String(timeWindow),
          String(max),
          String(this.continueExceeding),
          String(this.exponentialBackoff)
        ]
      }).then(
        (result) => callback(null, normalizeResult(result)),
        (error: unknown) => callback(error instanceof Error ? error : new Error("Valkey rate-limit failure."))
      );
    }

    child(routeOptions: unknown): ValkeyRateLimitStore {
      const parsed = routeOptions as ChildStoreOptions;
      const method = String(parsed.routeInfo?.method ?? "UNKNOWN");
      const url = String(parsed.routeInfo?.url ?? "unknown");
      return new ValkeyRateLimitStore(
        parsed,
        `${namespace}:${method}:${url}:`
      );
    }
  };
}
