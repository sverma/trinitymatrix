import { describe, expect, it, vi } from "vitest";
import { createValkeyRateLimitStore } from "./valkey-rate-limit";

describe("shared Valkey rate-limit store", () => {
  it("uses an atomic server-side counter and isolates route namespaces", async () => {
    const evalCommand = vi.fn().mockResolvedValue([2, 59_000]);
    const Store = createValkeyRateLimitStore({ eval: evalCommand }, "trinitymatrix:test:limits");
    const global = new Store({});
    const route = global.child({
      routeInfo: { method: "POST", url: "/api/auth/request-otp" }
    });

    const result = await new Promise<{ current: number; ttl: number }>((resolve, reject) => {
      route.incr("203.0.113.10", (error, value) => {
        if (error || !value) reject(error ?? new Error("missing result"));
        else resolve(value);
      }, 60_000, 5);
    });

    expect(result).toEqual({ current: 2, ttl: 59_000 });
    expect(evalCommand).toHaveBeenCalledWith(expect.any(String), {
      keys: ["trinitymatrix:test:limits:POST:/api/auth/request-otp:203.0.113.10"],
      arguments: ["60000", "5", "false", "false"]
    });
  });

  it("fails closed when Valkey cannot increment the counter", async () => {
    const Store = createValkeyRateLimitStore({
      eval: vi.fn().mockRejectedValue(new Error("Valkey unavailable"))
    }, "trinitymatrix:test:limits");
    const store = new Store({});

    await expect(new Promise((resolve, reject) => {
      store.incr("198.51.100.5", (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }, 60_000, 5);
    })).rejects.toThrow("Valkey unavailable");
  });
});
