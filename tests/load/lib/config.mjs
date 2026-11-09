import { resolve } from "node:path";

export const allowedGameTargets = Object.freeze([25, 50, 100, 250, 500]);
export const allowedPlayerCounts = Object.freeze([2, 6]);

const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const allowedOriginEnvironmentVariable = "TRINITY_LOAD_ALLOWED_ORIGIN";

function parseInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer.`);
  return parsed;
}

export function parseDuration(value, name) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(value).trim());
  if (!match) throw new Error(`${name} must be a duration such as 500ms, 30s, or 2m.`);
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  return Math.round(amount * multiplier);
}

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const separator = argument.indexOf("=");
    if (separator !== -1) {
      parsed.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const key = argument.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(key, true);
    } else {
      parsed.set(key, next);
      index += 1;
    }
  }
  return parsed;
}

function numberOption(args, key, fallback) {
  return args.has(key) ? Number(args.get(key)) : fallback;
}

export function confirmationPhrase(config) {
  return `LOAD ${config.games}x${config.playerCount} ON ${config.baseUrl.origin}`;
}

export function isLocalTarget(url) {
  return localHosts.has(url.hostname);
}

function configuredNonLocalOrigin(environment) {
  const raw = environment[allowedOriginEnvironmentVariable]?.trim();
  if (!raw) {
    throw new Error(`Non-local load tests require ${allowedOriginEnvironmentVariable} to name the exact allowed HTTPS origin.`);
  }
  let allowed;
  try {
    allowed = new URL(raw);
  } catch {
    throw new Error(`${allowedOriginEnvironmentVariable} must be a valid HTTPS origin.`);
  }
  if (allowed.protocol !== "https:" || allowed.username || allowed.password
    || allowed.pathname !== "/" || allowed.search || allowed.hash || isLocalTarget(allowed)) {
    throw new Error(`${allowedOriginEnvironmentVariable} must be a non-local HTTPS origin without credentials, path, query, or fragment.`);
  }
  if (raw !== allowed.origin) {
    throw new Error(`${allowedOriginEnvironmentVariable} must use canonical origin form: ${allowed.origin}`);
  }
  return allowed.origin;
}

export function parseLoadConfig(argv, cwd = process.cwd(), environment = process.env) {
  const args = parseArgs(argv);
  const known = new Set([
    "base-url", "player-count", "games", "ramp-up", "hold", "ramp-down",
    "match-timeout", "command-timeout", "action-delay", "reconnect-every",
    "session-file", "mock-otp-code", "output", "confirm-non-local", "dry-run",
    "max-p95-ms", "max-p99-ms", "max-command-failure-rate",
    "max-connect-failure-rate", "max-reconnect-failure-rate",
    "max-unexpected-disconnect-rate"
  ]);
  for (const key of args.keys()) {
    if (!known.has(key)) throw new Error(`Unknown option --${key}.`);
  }

  const baseUrl = new URL(String(args.get("base-url") ?? "http://127.0.0.1:8181"));
  if (!new Set(["http:", "https:"]).has(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error("--base-url must be an http(s) origin without credentials.");
  }
  if (baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("--base-url must not contain a path, query, or fragment.");
  }
  const local = isLocalTarget(baseUrl);
  if (!local) {
    const allowedOrigin = configuredNonLocalOrigin(environment);
    if (baseUrl.origin !== allowedOrigin) {
      throw new Error(`Non-local target ${baseUrl.origin} is not the origin allowlisted by ${allowedOriginEnvironmentVariable}.`);
    }
  }

  const playerCount = parseInteger(args.get("player-count") ?? 2, "--player-count");
  const games = parseInteger(args.get("games") ?? 25, "--games");
  if (!allowedPlayerCounts.includes(playerCount)) {
    throw new Error(`--player-count must be one of: ${allowedPlayerCounts.join(", ")}.`);
  }
  if (!allowedGameTargets.includes(games)) {
    throw new Error(`--games must be one of: ${allowedGameTargets.join(", ")}.`);
  }

  const config = {
    baseUrl,
    local,
    playerCount,
    games,
    players: games * playerCount,
    rampUpMs: parseDuration(args.get("ramp-up") ?? "60s", "--ramp-up"),
    holdMs: parseDuration(args.get("hold") ?? "120s", "--hold"),
    rampDownMs: parseDuration(args.get("ramp-down") ?? "30s", "--ramp-down"),
    matchTimeoutMs: parseDuration(args.get("match-timeout") ?? "60s", "--match-timeout"),
    commandTimeoutMs: parseDuration(args.get("command-timeout") ?? "5s", "--command-timeout"),
    actionDelayMs: parseDuration(args.get("action-delay") ?? "2s", "--action-delay"),
    reconnectEveryMs: parseDuration(args.get("reconnect-every") ?? "0ms", "--reconnect-every"),
    sessionFile: args.has("session-file") ? resolve(cwd, String(args.get("session-file"))) : null,
    mockOtpCode: String(args.get("mock-otp-code") ?? "123456"),
    output: resolve(cwd, String(args.get("output") ?? `tests/load/results/load-${Date.now()}.json`)),
    confirmation: typeof args.get("confirm-non-local") === "string" ? args.get("confirm-non-local") : "",
    dryRun: args.get("dry-run") === true,
    thresholds: {
      maxP95Ms: numberOption(args, "max-p95-ms", 500),
      maxP99Ms: numberOption(args, "max-p99-ms", 1_000),
      maxCommandFailureRate: numberOption(args, "max-command-failure-rate", 0.01),
      maxConnectFailureRate: numberOption(args, "max-connect-failure-rate", 0.01),
      maxReconnectFailureRate: numberOption(args, "max-reconnect-failure-rate", 0.05),
      maxUnexpectedDisconnectRate: numberOption(args, "max-unexpected-disconnect-rate", 0.01)
    }
  };

  for (const [name, duration] of Object.entries({
    rampUpMs: config.rampUpMs,
    holdMs: config.holdMs,
    rampDownMs: config.rampDownMs,
    matchTimeoutMs: config.matchTimeoutMs,
    commandTimeoutMs: config.commandTimeoutMs,
    actionDelayMs: config.actionDelayMs,
    reconnectEveryMs: config.reconnectEveryMs
  })) {
    if (!Number.isSafeInteger(duration) || duration < 0) throw new Error(`${name} must be a non-negative duration.`);
  }
  if (config.matchTimeoutMs === 0 || config.commandTimeoutMs === 0) {
    throw new Error("Match and command timeouts must be greater than zero.");
  }
  if (!/^\d{6}$/.test(config.mockOtpCode)) throw new Error("--mock-otp-code must contain six digits.");
  for (const [name, value] of Object.entries(config.thresholds)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  }
  for (const rate of [
    config.thresholds.maxCommandFailureRate,
    config.thresholds.maxConnectFailureRate,
    config.thresholds.maxReconnectFailureRate,
    config.thresholds.maxUnexpectedDisconnectRate
  ]) {
    if (rate > 1) throw new Error("Failure-rate thresholds must be between 0 and 1.");
  }
  if (local && !config.sessionFile && baseUrl.hostname !== "127.0.0.1") {
    throw new Error("Automated local mock authentication requires --base-url http://127.0.0.1:<port> for its loopback source pool.");
  }
  if (!local && !config.dryRun) {
    if (!config.sessionFile) throw new Error("Non-local runs require --session-file; real OTP delivery is never automated.");
    if (config.confirmation !== confirmationPhrase(config)) {
      throw new Error(`Non-local safety confirmation required: --confirm-non-local "${confirmationPhrase(config)}"`);
    }
  }
  return config;
}

export function publicConfig(config) {
  return {
    baseUrl: config.baseUrl.origin,
    local: config.local,
    playerCount: config.playerCount,
    games: config.games,
    players: config.players,
    rampUpMs: config.rampUpMs,
    holdMs: config.holdMs,
    rampDownMs: config.rampDownMs,
    matchTimeoutMs: config.matchTimeoutMs,
    commandTimeoutMs: config.commandTimeoutMs,
    actionDelayMs: config.actionDelayMs,
    reconnectEveryMs: config.reconnectEveryMs,
    authMode: config.local && !config.sessionFile ? "mock-otp" : "session-file",
    output: config.output,
    thresholds: config.thresholds
  };
}
