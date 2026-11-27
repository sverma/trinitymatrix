import { afterEach, describe, expect, it, vi } from "vitest";
import { activityApi } from "./activity-api";
import { HttpApiError } from "./api";

describe("administrator Activity API", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps filter and cursor values encoded and uses the authenticated uncached transport", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await activityApi.events({ from: "2026-11-20T12:00:00Z", to: "2026-11-27T12:00:00Z", actorKind: "human", q: "asha+games@example.test" }, "auth", "page+two&other=false");
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    const parsed = new URL(url, "https://trinitymatrix.org");
    expect(parsed.pathname).toBe("/api/admin/activity/events");
    expect(parsed.searchParams.get("q")).toBe("asha+games@example.test");
    expect(parsed.searchParams.get("cursor")).toBe("page+two&other=false");
    expect(parsed.searchParams.has("other")).toBe(false);
    expect(parsed.searchParams.get("kind")).toBe("auth");
    expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("preserves a denied administrator status for the panel's access-expiry handling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Administrator access required." }), { status: 403 })));
    await expect(activityApi.overview({ from: "2026-11-20T12:00:00Z", to: "2026-11-27T12:00:00Z", actorKind: "all" })).rejects.toMatchObject({ status: 403, message: "Administrator access required." } satisfies Partial<HttpApiError>);
  });
});
