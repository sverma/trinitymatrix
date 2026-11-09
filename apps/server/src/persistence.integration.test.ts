import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type RedisClientType } from "redis";
import { RedisStateStore } from "./persistence";
import { createValkeyRateLimitStore } from "./valkey-rate-limit";

const describeRedis = process.env.RUN_REDIS_INTEGRATION === "1" ? describe : describe.skip;

describeRedis("RedisStateStore atomic challenge consumption", () => {
  let firstClient: RedisClientType;
  let secondClient: RedisClientType;
  let first: RedisStateStore;
  let second: RedisStateStore;
  const namespace = `trinitymatrix:test:otp:${randomUUID()}`;

  beforeAll(async () => {
    firstClient = createClient({
      url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
      socket: { reconnectStrategy: false }
    });
    secondClient = firstClient.duplicate();
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    first = new RedisStateStore(firstClient, namespace);
    second = new RedisStateStore(secondClient, namespace);
  });

  afterAll(async () => {
    if (firstClient?.isOpen) firstClient.destroy();
    if (secondClient?.isOpen) secondClient.destroy();
  });

  it("allows exactly one verifier to consume a correct challenge across clients", async () => {
    const key = `auth:challenge:${randomUUID()}`;
    const expiresAt = Date.now() + 60_000;
    const challenge = {
      id: randomUUID(),
      email: "player@example.com",
      codeHash: "a".repeat(64),
      expiresAt,
      failedAttempts: 0
    };
    await first.set(key, challenge, 60_000);

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).consumeChallenge(
        key,
        challenge.codeHash,
        Date.now(),
        5
      )
    ));

    expect(results.filter((result) => result.status === "verified")).toHaveLength(1);
    await expect(first.get(key)).resolves.toBeNull();
  });

  it("atomically counts five simultaneous bad guesses in the epoch-prefixed key", async () => {
    const key = `auth:challenge:production-v1:${randomUUID()}`;
    const expiresAt = Date.now() + 60_000;
    await first.set(key, {
      id: randomUUID(),
      email: "player@example.com",
      codeHash: "b".repeat(64),
      expiresAt,
      failedAttempts: 0
    }, 60_000);

    await Promise.all(Array.from({ length: 5 }, (_, index) =>
      (index % 2 === 0 ? first : second).consumeChallenge(
        key,
        "c".repeat(64),
        Date.now(),
        5
      )
    ));

    await expect(first.get<{ failedAttempts: number }>(key)).resolves.toMatchObject({
      failedAttempts: 5
    });
    await expect(second.consumeChallenge(key, "b".repeat(64), Date.now(), 5)).resolves.toEqual({
      status: "invalid"
    });
    await expect(first.get(key)).resolves.toBeNull();
  });

  it("shares one atomic request ceiling across application replicas", async () => {
    const FirstStore = createValkeyRateLimitStore(firstClient, namespace);
    const SecondStore = createValkeyRateLimitStore(secondClient, namespace);
    const firstLimit = new FirstStore({});
    const secondLimit = new SecondStore({});
    const key = `ip:${randomUUID()}`;

    const increment = (index: number) => new Promise<{ current: number; ttl: number }>((resolve, reject) => {
      (index % 2 === 0 ? firstLimit : secondLimit).incr(key, (error, result) => {
        if (error || !result) reject(error ?? new Error("missing rate-limit result"));
        else resolve(result);
      }, 60_000, 10);
    });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => increment(index)));

    expect(results.map(({ current }) => current).sort((left, right) => left - right))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(results.every(({ ttl }) => ttl > 0 && ttl <= 60_000)).toBe(true);
  });
});
