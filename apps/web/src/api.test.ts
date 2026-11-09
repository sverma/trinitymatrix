import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("API response handling", () => {
  it("bypasses the browser cache for mutable JSON resources", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ rankings: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.rankings()).resolves.toEqual({ rankings: [] });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toEqual(expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
  });

  it("rejects an HTML SPA fallback and a bodyless conditional response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("<!doctype html><title>TrinityMatrix</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.matchHistory()).rejects.toThrow("invalid response");
    await expect(api.matchHistory()).rejects.toThrow("request failed");
  });

  it("rejects an incomplete private-room DTO before lobby state can merge it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    })));

    await expect(api.createPrivateMatch(2, ["guest@example.test"]))
      .rejects.toThrow("private table response was incomplete");
  });

  it("accepts an invitation without declaring an empty JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      room: { roomCode: "royal-peacock-003146" }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.acceptPrivateMatch("royal-peacock-003146");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private-matches/royal-peacock-003146/accept",
      expect.objectContaining({ method: "POST", cache: "no-store", credentials: "same-origin" })
    );
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("body");
  });

  it("cancels a private table without declaring an empty JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.cancelPrivateMatch("royal-peacock-003146");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/private-matches/royal-peacock-003146/cancel",
      { method: "POST", credentials: "same-origin" }
    );
  });
});
