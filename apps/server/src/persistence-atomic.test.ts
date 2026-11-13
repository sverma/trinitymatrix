import { describe, expect, it, vi } from "vitest";
import { MemoryStateStore, RedisStateStore } from "./persistence";

describe("atomic state batches", () => {
  it("applies a Redis batch in one MSET script with namespaced keys", async () => {
    const redis = { get: vi.fn(async () => null), set: vi.fn(async () => "OK"), del: vi.fn(async () => 1), eval: vi.fn(async () => "OK") };
    const store = new RedisStateStore(redis, "test");
    await store.setMany([{ key: "game", value: { queue: ["player"] } }, { key: "consent", value: { optedIn: false } }]);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval.mock.calls[0]).toEqual([expect.stringContaining("redis.call('MSET', unpack(pairs))"), {
      keys: ["test:game", "test:consent"], arguments: ['{"queue":["player"]}', '{"optedIn":false}']
    }]);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("serializes every Redis entry before sending any mutation", async () => {
    const redis = { get: vi.fn(async () => null), set: vi.fn(async () => "OK"), del: vi.fn(async () => 1), eval: vi.fn(async () => "OK") };
    const store = new RedisStateStore(redis);
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    await expect(store.setMany([{ key: "game", value: "new" }, { key: "bad", value: cyclic }])).rejects.toThrow();
    expect(redis.eval).not.toHaveBeenCalled();
    await store.setMany([]); expect(redis.eval).not.toHaveBeenCalled();
  });

  it("never partially applies a memory batch if a later value cannot serialize", async () => {
    const store = new MemoryStateStore();
    await store.setMany([{ key: "game", value: "old" }, { key: "consent", value: false }]);
    await expect(store.setMany([{ key: "game", value: "new" }, { key: "consent", value: undefined }])).rejects.toThrow();
    expect(await store.get("game")).toBe("old"); expect(await store.get("consent")).toBe(false);
    await store.setMany([{ key: "game", value: "new" }, { key: "consent", value: true }]);
    expect(await store.get("game")).toBe("new"); expect(await store.get("consent")).toBe(true);
  });
});
