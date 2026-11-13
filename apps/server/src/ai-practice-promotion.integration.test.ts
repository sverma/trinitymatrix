import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPracticePromotionIdle } from "./ai-practice-promotion";

const redisUrl = process.env.AI_PRACTICE_TEST_REDIS_URL;
describe.skipIf(!redisUrl)("real Redis practice membership guard", () => {
  const namespace = `trinitymatrix:practice-test:${randomUUID()}`;
  const key = `${namespace}:matchmaker:active-games`;
  const agentId = randomUUID();
  const redis = createClient({ url: redisUrl!, socket: { connectTimeout: 5_000, reconnectStrategy: false } });
  redis.on("error", () => undefined);
  beforeAll(async () => { await redis.connect(); });
  afterAll(async () => { if (redis.isReady) { await redis.del(key); await redis.quit(); } else if (redis.isOpen) redis.destroy(); });

  it("checks actual queue/game membership without returning hands and defers corrupt snapshots", async () => {
    expect(await isPracticePromotionIdle(redis, namespace, agentId)).toBe(true);
    const state = { version: 2, games: [] as unknown[], queues: { twoPlayer: [] as string[], sixPlayer: [] as string[] } };
    state.queues.sixPlayer.push(agentId);
    await redis.set(key, JSON.stringify(state));
    expect(await isPracticePromotionIdle(redis, namespace, agentId)).toBe(false);
    state.queues.sixPlayer = [];
    state.games = [{ phase: "playing", seats: [{ id: agentId }], hands: "PRIVATE_HAND_SENTINEL" }];
    await redis.set(key, JSON.stringify(state));
    expect(await isPracticePromotionIdle(redis, namespace, agentId)).toBe(false);
    expect(await isPracticePromotionIdle(redis, namespace, randomUUID())).toBe(true);
    state.games = [{ phase: "finished", seats: [{ id: agentId }] }];
    await redis.set(key, JSON.stringify(state));
    expect(await isPracticePromotionIdle(redis, namespace, agentId)).toBe(true);
    for (const corrupt of ["not-json", "{}", '{"games":[{}],"queues":{}}']) {
      await redis.set(key, corrupt);
      expect(await isPracticePromotionIdle(redis, namespace, agentId)).toBe(false);
    }
  });
});
