import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { activityFiltersSchema, activityIngestSchema } from "@trinitymatrix/protocol";
import { PostgresActivityRepository } from "./activity-repository";

describe("activity boundary contracts", () => {
  it("accepts only bounded event metadata and rejects impersonation, duration and arbitrary payloads", () => {
    const event = { type: "heartbeat", eventId: randomUUID(), page: "lobby", active: true, fresh: true };
    expect(activityIngestSchema.parse(event)).toEqual(event);
    for (const extra of [{ userId: randomUUID() }, { sessionHash: "a".repeat(64) }, { duration: 999_999 }, { payload: { password: "private" } }, { page: "/watch/secret?token=private" }]) {
      expect(activityIngestSchema.safeParse({ ...event, ...extra }).success).toBe(false);
    }
    expect(activityIngestSchema.safeParse({ type: "interaction", eventId: randomUUID(), page: "table", action: "match.won" }).success).toBe(false);
  });

  it("rejects backwards, overlong and future ranges before querying", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    const repository = new PostgresActivityRepository(pool, () => new Date("2026-11-27T13:00:00Z"));
    const filter = { from: "2026-11-26T00:00:00Z", to: "2026-11-27T13:00:00Z", actorKind: "all" as const };
    expect(activityFiltersSchema.safeParse({ ...filter, from: filter.to }).success).toBe(false);
    expect(activityFiltersSchema.safeParse({ ...filter, from: "2026-01-01T00:00:00Z" }).success).toBe(false);
    await expect(repository.overview({ ...filter, to: "2026-11-28T00:00:00Z" })).rejects.toThrow();
    await expect(repository.users(filter, { limit: 101 })).rejects.toThrow();
    await expect(repository.events(filter, { cursor: "not-a-cursor" })).rejects.toThrow();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
