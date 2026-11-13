import { describe, expect, it, vi } from "vitest";
import { isPracticePromotionIdle } from "./ai-practice-promotion";

describe("practice promotion runtime guard", () => {
  it("accepts only an explicit idle result and never fetches private snapshots", async () => {
    const redis = { eval: vi.fn(async () => 0) };
    expect(await isPracticePromotionIdle(redis, "private:namespace", "agent-id")).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), { keys: ["private:namespace:matchmaker:active-games"], arguments: ["agent-id"] });
  });
  it.each([1, -1, null, "0", undefined])("defers unknown or busy state %j", async (value) => {
    expect(await isPracticePromotionIdle({ eval: async () => value }, "ns", "agent-id")).toBe(false);
  });
  it("defers when Redis is unavailable", async () => {
    expect(await isPracticePromotionIdle({ eval: async () => { throw new Error("unavailable"); } }, "ns", "agent-id")).toBe(false);
  });
});
