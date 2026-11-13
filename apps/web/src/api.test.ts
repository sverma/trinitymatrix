import { afterEach, describe, expect, it, vi } from "vitest";
import { api, sameOriginMediaPath } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("API response handling", () => {
  it("keeps media requests on the application origin and within binary upload limits", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(() => sameOriginMediaPath("https://foreign.example/api/live/table/video")).toThrow("invalid media address");
    expect(() => sameOriginMediaPath("/api/live/../../auth/logout")).toThrow("invalid media address");
    await expect(api.uploadBroadcastVideo("/api/live/table/video/chunks", 0, new Blob([new Uint8Array(512 * 1024 + 1)]))).rejects.toThrow("upload limits");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends explicit AI broadcast consent and omits the field when no consent is given", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ gameId: "fixture" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.startAiMatch(["agent1"]);
    await api.startAiMatch(["agent1"], true);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ agentIds: ["agent1"] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ agentIds: ["agent1"], broadcast: true });
  });
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
