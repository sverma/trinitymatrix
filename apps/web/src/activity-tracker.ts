import { useEffect, useRef } from "react";
import { activityActionSchema, activityPageSchema, type ActivityAction, type ActivityIngest, type ActivityPage } from "@trinitymatrix/protocol";

export const activityHeartbeatIntervalMs = 15_000;
export const activityIdleThresholdMs = 60_000;
const maximumQueueSize = 20;
const maximumEventAgeMs = 60_000;
const requestTimeoutMs = 5_000;
type Pending = { event: ActivityIngest; queuedAt: number; attempts: number; freshGeneration: number };

/** Bounded first-party samples. Event contents never contain DOM/input/URL data. */
export class BrowserActivityTracker {
  private queue: Pending[] = [];
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private request: AbortController | null = null;
  private flightId: string | null = null;
  private lastInputAt = Date.now();
  private freshGeneration = 1;
  private acknowledgedFreshGeneration = 0;
  private lastSampleActive = false;
  private readonly recentlyRecorded = new Map<string, number>();

  constructor(private page: ActivityPage, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  get currentPage(): ActivityPage { return this.page; }

  start(): void {
    if (this.stopped || this.heartbeat) return;
    document.addEventListener("pointerdown", this.noteInput, { passive: true });
    document.addEventListener("keydown", this.noteInput, { passive: true });
    document.addEventListener("touchstart", this.noteInput, { passive: true });
    document.addEventListener("scroll", this.noteInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("focus", this.onFocus);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onVisibility);
    this.record("page.view");
    this.sample();
    this.heartbeat = setInterval(() => this.sample(), activityHeartbeatIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null; this.heartbeat = null;
    this.request?.abort(); this.request = null;
    this.queue = [];
    document.removeEventListener("pointerdown", this.noteInput);
    document.removeEventListener("keydown", this.noteInput);
    document.removeEventListener("touchstart", this.noteInput);
    document.removeEventListener("scroll", this.noteInput, { capture: true });
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("focus", this.onFocus);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onVisibility);
  }

  setPage(page: ActivityPage): void {
    if (this.stopped || !activityPageSchema.safeParse(page).success || this.page === page) return;
    this.page = page;
    this.freshGeneration++;
    this.record("page.view");
    this.sample();
  }

  record(action: ActivityAction, page: ActivityPage = this.page): void {
    if (this.stopped || !activityActionSchema.safeParse(action).success || !activityPageSchema.safeParse(page).success) return;
    // Semantic controls can fire rapidly; record at most once per second per
    // action/page without observing the selected cards or entered text.
    const key = `${page}:${action}`;
    const at = Date.now();
    if (at - (this.recentlyRecorded.get(key) ?? -Infinity) < 1_000) return;
    this.recentlyRecorded.set(key, at);
    this.lastInputAt = at;
    this.enqueue({ type: "interaction", eventId: crypto.randomUUID(), page, action });
  }

  private canSend(): boolean {
    return !this.stopped && navigator.onLine !== false && document.visibilityState === "visible" && document.hasFocus();
  }

  private readonly noteInput = () => { this.lastInputAt = Date.now(); };
  private readonly onFocus = () => { this.freshGeneration++; this.lastInputAt = Date.now(); this.sample(); this.schedule(); };
  private readonly onOnline = () => { this.freshGeneration++; this.sample(); this.schedule(); };
  private readonly onBlur = () => {
    this.freshGeneration++; this.lastSampleActive = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  };
  private readonly onVisibility = () => {
    this.freshGeneration++;
    if (this.canSend()) { this.sample(); this.schedule(); }
    else { this.lastSampleActive = false; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  };

  private sample(): void {
    if (!this.canSend()) return;
    const active = Date.now() - this.lastInputAt < activityIdleThresholdMs;
    if (active && !this.lastSampleActive) this.freshGeneration++;
    this.lastSampleActive = active;
    this.enqueue({ type: "heartbeat", eventId: crypto.randomUUID(), page: this.page,
      active, fresh: active && this.freshGeneration > this.acknowledgedFreshGeneration });
  }

  private enqueue(event: ActivityIngest): void {
    if (this.stopped) return;
    this.prune();
    if (event.type === "heartbeat") this.queue = this.queue.filter((item) => item.event.type !== "heartbeat" || item.event.eventId === this.flightId);
    if (this.queue.length >= maximumQueueSize) this.queue.splice(this.flightId ? 1 : 0, 1);
    this.queue.push({ event, queuedAt: Date.now(), attempts: 0, freshGeneration: this.freshGeneration });
    this.schedule();
  }

  private prune(): void {
    const at = Date.now();
    this.queue = this.queue.filter((item) => item.event.eventId === this.flightId || at - item.queuedAt <= maximumEventAgeMs);
  }

  private schedule(delay = 0): void {
    if (!this.canSend() || this.timer || this.flightId || !this.queue.length) return;
    // Deferral also prevents React StrictMode's disposable first effect from
    // sending an extra page view before its cleanup runs.
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  private async flush(): Promise<void> {
    if (!this.canSend() || this.flightId) return;
    this.prune();
    const item = this.queue[0];
    if (!item) return;
    this.flightId = item.event.eventId;
    item.attempts += 1;
    const controller = new AbortController(); this.request = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    let retry = false;
    try {
      const response = await this.fetcher("/api/activity", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.event), signal: controller.signal });
      if (response.status === 401 || response.status === 403) { this.stop(); return; }
      if (response.ok && item.event.type === "heartbeat" && item.event.fresh) {
        this.acknowledgedFreshGeneration = Math.max(this.acknowledgedFreshGeneration, item.freshGeneration);
      }
      retry = response.status >= 500;
    } catch { retry = !this.stopped; }
    finally {
      clearTimeout(timeout);
      this.request = null; this.flightId = null;
    }
    if (this.stopped) return;
    if (!retry || item.attempts >= 3 || Date.now() - item.queuedAt > maximumEventAgeMs) {
      this.queue = this.queue.filter(({ event }) => event.eventId !== item.event.eventId);
    }
    this.schedule(retry ? Math.min(3_000, item.attempts * 1_000) : 0);
  }
}

let currentTracker: BrowserActivityTracker | null = null;

/** The identifier controls lifecycle only and is never sent to analytics. */
export function useActivityTracking(playerId: string | null, page: ActivityPage): void {
  const pageRef = useRef(page); pageRef.current = page;
  useEffect(() => {
    if (!playerId) return;
    let tracker: BrowserActivityTracker;
    try {
      tracker = new BrowserActivityTracker(pageRef.current);
      currentTracker?.stop(); currentTracker = tracker;
      tracker.start();
    } catch {
      currentTracker?.stop(); currentTracker = null;
      return;
    }
    return () => { tracker.stop(); if (currentTracker === tracker) currentTracker = null; };
  }, [playerId]);
  useEffect(() => { if (playerId) { try { currentTracker?.setPage(page); } catch { /* Activity cannot block navigation. */ } } }, [page, playerId]);
}

export function recordActivity(action: ActivityAction, page?: ActivityPage): void {
  try { currentTracker?.record(action, page); } catch { /* Activity cannot block a game control. */ }
}

/** Scoped views such as a profile dialog and replay restore their parent page. */
export function useActivityPage(page: ActivityPage): void {
  useEffect(() => {
    const tracker = currentTracker;
    if (!tracker) return;
    const previous = tracker.currentPage;
    try { tracker.setPage(page); } catch { return; }
    return () => { if (tracker === currentTracker && tracker.currentPage === page) { try { tracker.setPage(previous); } catch { /* Best effort. */ } } };
  }, [page]);
}
