import { StrictMode, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityIngest, ActivityPage } from "@trinitymatrix/protocol";
import { BrowserActivityTracker, recordActivity, useActivityTracking } from "./activity-tracker";

describe("bounded authenticated browser activity", () => {
  let visible: "visible" | "hidden";
  let focused: boolean;
  let online: boolean;
  let trackers: BrowserActivityTracker[];
  const sent = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)) as ActivityIngest);
  const settle = async () => { await vi.advanceTimersByTimeAsync(1); };
  const start = (fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))) => {
    const tracker = new BrowserActivityTracker("lobby", fetcher); trackers.push(tracker); tracker.start(); return { tracker, fetcher };
  };
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-27T06:00:00Z"));
    visible = "visible"; focused = true; online = true; trackers = [];
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible);
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  });
  afterEach(() => { trackers.forEach((tracker) => tracker.stop()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("binds the default browser fetch to the global receiver required by native fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(function (this: typeof globalThis) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetcher);
    const tracker = new BrowserActivityTracker("lobby"); trackers.push(tracker); tracker.start();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.contexts.every((receiver) => receiver === globalThis)).toBe(true);
    expect(sent(fetcher)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "heartbeat", active: true, fresh: true }),
      expect.objectContaining({ type: "interaction", action: "page.view" })
    ]));
  });

  it("sends fixed semantic fields only and treats input as a timestamp without inspecting its contents", async () => {
    const { tracker, fetcher } = start(); await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "PRIVATE_PASSWORD_AND_CHAT" }));
    tracker.record("cards.group", "table"); await settle();
    const bodies = sent(fetcher);
    expect(bodies).toEqual(expect.arrayContaining([
      { type: "interaction", eventId: expect.any(String), page: "lobby", action: "page.view" },
      { type: "heartbeat", eventId: expect.any(String), page: "lobby", active: true, fresh: true },
      { type: "interaction", eventId: expect.any(String), page: "table", action: "cards.group" }
    ]));
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("PRIVATE_PASSWORD_AND_CHAT");
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe("/api/activity"); expect(options?.credentials).toBe("same-origin");
      expect(Object.keys(JSON.parse(String(options?.body))).sort()).toEqual(expect.arrayContaining(["eventId", "page", "type"]));
      const event = JSON.parse(String(options?.body)) as ActivityIngest;
      expect(Object.keys(event).length).toBe(event.type === "heartbeat" ? 5 : 4);
    }
    tracker.record("not-a-real-action" as never); tracker.setPage("/private/SECRET" as never); await settle();
    expect(JSON.stringify(sent(fetcher))).not.toMatch(/SECRET|not-a-real-action/);
  });

  it("reports idle after one minute and resumes active samples after interaction", async () => {
    const { fetcher } = start(); await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: false });
    document.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: true, fresh: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: true, fresh: false });
  });

  it("pauses hidden, unfocused and offline pages, and resumes safely", async () => {
    const { fetcher } = start(); await settle(); const initial = fetcher.mock.calls.length;
    visible = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(45_000); expect(fetcher).toHaveBeenCalledTimes(initial);
    visible = "visible"; focused = false; document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000); expect(fetcher).toHaveBeenCalledTimes(initial);
    focused = true; online = false; window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(15_000); expect(fetcher).toHaveBeenCalledTimes(initial);
    online = true; window.dispatchEvent(new Event("online")); await settle();
    expect(fetcher.mock.calls.length).toBeGreaterThan(initial);
  });

  it("resets the active-time baseline on a short hidden interval instead of crediting hidden time", async () => {
    const { fetcher } = start(); await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: true, fresh: false });
    visible = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(20_000);
    visible = "visible"; document.dispatchEvent(new Event("visibilitychange")); await settle();
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: true, fresh: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: true, fresh: false });
  });

  it("drops stale offline events rather than reporting them as fresh activity", async () => {
    const { tracker, fetcher } = start(); await settle();
    online = false; window.dispatchEvent(new Event("offline"));
    tracker.record("cards.sort", "table");
    await vi.advanceTimersByTimeAsync(61_000);
    online = true; window.dispatchEvent(new Event("online")); await settle();
    expect(sent(fetcher).some((event) => event.type === "interaction" && event.action === "cards.sort")).toBe(false);
    expect(sent(fetcher).filter((event) => event.type === "heartbeat").at(-1)).toMatchObject({ active: false });
  });

  it("retries each transient failure at most three times using the same event UUID", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    start(fetcher); await vi.advanceTimersByTimeAsync(12_000);
    const counts = new Map<string, number>();
    for (const event of sent(fetcher)) counts.set(event.eventId, (counts.get(event.eventId) ?? 0) + 1);
    expect([...counts.values()]).toEqual([3, 3]);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("stops collection on an expired or denied session without affecting the application", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }));
    const { tracker } = start(fetcher); await settle();
    tracker.record("cards.group", "table"); await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("drops rate-limited events without a retry storm", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 429 }));
    start(fetcher); await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds queued controls and never overlaps requests", async () => {
    let finish: (() => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Promise<Response>((resolve) => { finish = () => resolve(new Response(null, { status: 204 })); }))
      .mockImplementation(async () => new Response(null, { status: 204 }));
    const { tracker } = start(fetcher); await settle();
    const pages: ActivityPage[] = ["lobby", "table", "rankings", "history", "replay", "private", "live", "watch", "profile", "rules", "admin"];
    for (const page of pages) { tracker.record("cards.group", page); tracker.record("cards.sort", page); tracker.record("help.open", page); }
    expect(fetcher).toHaveBeenCalledTimes(1);
    finish!(); await settle();
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20);
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it("throttles a rapidly repeated semantic control", async () => {
    const { tracker, fetcher } = start(); await settle();
    for (let count = 0; count < 100; count++) tracker.record("cards.group", "table");
    await settle();
    expect(sent(fetcher).filter((event) => event.type === "interaction" && event.action === "cards.group")).toHaveLength(1);
  });

  it("collects only after authentication, survives StrictMode, and clears old-user retries on logout", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
    const { rerender, unmount } = renderHook(({ id }) => useActivityTracking(id, "lobby"), {
      initialProps: { id: null as string | null }, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    });
    await settle(); expect(fetcher).not.toHaveBeenCalled();
    rerender({ id: "human-account-A" }); await settle();
    expect(sent(fetcher).filter((event) => event.type === "interaction" && event.action === "page.view")).toHaveLength(1);
    expect(JSON.stringify(sent(fetcher))).not.toContain("human-account-A");
    const completed = fetcher.mock.calls.length;
    rerender({ id: null }); await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(completed);
    rerender({ id: "human-account-B" }); await settle();
    expect(fetcher.mock.calls.length).toBeGreaterThan(completed);
    unmount(); const after = fetcher.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(after);
  });

  it("sends one initial page view when an already authenticated app mounts in StrictMode", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
    const { unmount } = renderHook(() => useActivityTracking("human-account", "table"), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    });
    await settle();
    expect(sent(fetcher).filter((event) => event.type === "interaction" && event.action === "page.view")).toHaveLength(1);
    unmount();
  });

  it("keeps navigation and game controls working when collection cannot initialize", async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("activity UUID unavailable"); });
    const { unmount } = renderHook(() => useActivityTracking("human-account", "lobby"));
    expect(() => recordActivity("cards.group", "table")).not.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher).not.toHaveBeenCalled();
    unmount();
  });
});
