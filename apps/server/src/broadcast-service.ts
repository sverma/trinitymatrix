import type { BroadcastCloseCode, BroadcastEvent } from "@trinitymatrix/protocol";
import type { BroadcastDetail, BroadcastRepository } from "./broadcast-repository";

type Watcher = {
  userId: string; send: (event: BroadcastEvent) => boolean; revalidate: () => Promise<boolean>; checkedAt: number;
  frameKey: string; comments: Map<string, string>;
};
type Channel = { name: string; watchers: Set<Watcher>; timer: NodeJS.Timeout | null; flight: Promise<void> | null; failures: number };

/** One bounded database poll per watched game, independent of gameplay sockets. */
export class BroadcastService {
  private readonly channels = new Map<string, Channel>();
  private stopped = false;
  constructor(private readonly repository: Pick<BroadcastRepository, "detail">,
    private readonly options: { pollMs?: number; authIntervalMs?: number; maxWatchers?: number; maxPerUser?: number } = {}) {}

  viewerCount(name: string): number { return new Set([...this.channels.get(name)?.watchers ?? []].map(({ userId }) => userId)).size; }

  subscribe(name: string, userId: string, send: (event: BroadcastEvent) => boolean, revalidate: () => Promise<boolean>): () => void {
    if (this.stopped) throw new Error("Broadcast service is stopped.");
    const all = [...this.channels.values()].flatMap(({ watchers }) => [...watchers]);
    if (all.length >= (this.options.maxWatchers ?? 200) || all.filter((watcher) => watcher.userId === userId).length >= (this.options.maxPerUser ?? 3)) {
      throw new Error("Spectator connection limit reached.");
    }
    let channel = this.channels.get(name);
    if (!channel) {
      channel = { name, watchers: new Set(), timer: null, flight: null, failures: 0 };
      this.channels.set(name, channel);
    }
    const watcher: Watcher = { userId, send, revalidate, checkedAt: Date.now(), frameKey: "", comments: new Map() };
    channel.watchers.add(watcher);
    const current = channel;
    this.publishViewers(current);
    if (!current.watchers.has(watcher)) return () => undefined;
    void this.poll(current);
    if (!current.timer) {
      current.timer = setInterval(() => { void this.poll(current); }, this.options.pollMs ?? 1_000);
      current.timer.unref();
    }
    return () => this.remove(current, watcher);
  }

  private remove(channel: Channel, watcher: Watcher): void {
    if (!channel.watchers.delete(watcher)) return;
    if (!channel.watchers.size) {
      if (channel.timer) clearInterval(channel.timer);
      if (this.channels.get(channel.name) === channel) this.channels.delete(channel.name);
    } else this.publishViewers(channel);
  }

  private send(channel: Channel, watcher: Watcher, event: BroadcastEvent): void {
    try { if (!watcher.send(event)) this.remove(channel, watcher); }
    catch { this.remove(channel, watcher); }
  }
  private publishViewers(channel: Channel): void {
    const count = new Set([...channel.watchers].map(({ userId }) => userId)).size;
    for (const watcher of [...channel.watchers]) this.send(channel, watcher, { type: "viewers", viewerCount: count });
  }

  private async valid(watcher: Watcher): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([watcher.revalidate(), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3_000); timer.unref(); })]);
    } catch { return false; }
    finally { if (timer) clearTimeout(timer); }
  }

  private poll(channel: Channel): Promise<void> {
    if (channel.flight) return channel.flight;
    const flight = this.pollOnce(channel).finally(() => { if (channel.flight === flight) channel.flight = null; });
    channel.flight = flight;
    return flight;
  }

  private async pollOnce(channel: Channel): Promise<void> {
    if (this.stopped || this.channels.get(channel.name) !== channel) return;
    try {
      await Promise.all([...channel.watchers].map(async (watcher) => {
        if (Date.now() - watcher.checkedAt < (this.options.authIntervalMs ?? 10_000)) return;
        watcher.checkedAt = Date.now();
        if (!(await this.valid(watcher))) {
          this.send(channel, watcher, { type: "closed", code: "auth-required", reason: "Authentication required. Sign in again to watch." });
          this.remove(channel, watcher);
        }
      }));
      if (this.stopped || !channel.watchers.size || this.channels.get(channel.name) !== channel) return;
      const detail = await this.repository.detail(channel.name);
      if (this.stopped || this.channels.get(channel.name) !== channel) return;
      if (!detail) { this.close(channel.name, "This broadcast is no longer available."); return; }
      channel.failures = 0;
      this.publishDetail(channel, detail);
    } catch {
      channel.failures += 1;
      if (channel.failures >= 3) this.close(channel.name, "The broadcast service is temporarily unavailable.", "unavailable");
    }
  }

  private publishDetail(channel: Channel, detail: BroadcastDetail): void {
    const frameKey = detail.frame ? JSON.stringify(detail.frame) : "";
    for (const watcher of [...channel.watchers]) {
      if (detail.frame && frameKey !== watcher.frameKey) {
        watcher.frameKey = frameKey;
        this.send(channel, watcher, { type: "frame", frame: detail.frame });
      }
      if (!channel.watchers.has(watcher)) continue;
      for (const comment of detail.comments) {
        const key = JSON.stringify(comment);
        if (watcher.comments.get(comment.id) !== key) this.send(channel, watcher, { type: "comment", comment });
        watcher.comments.set(comment.id, key);
        if (!channel.watchers.has(watcher)) break;
      }
      // Each client retains only the current bounded page of chat fingerprints.
      const visible = new Set(detail.comments.map(({ id }) => id));
      for (const id of watcher.comments.keys()) if (!visible.has(id)) watcher.comments.delete(id);
    }
  }

  close(name: string, reason = "The broadcaster ended this broadcast.", code: BroadcastCloseCode = "closed"): void {
    const channel = this.channels.get(name);
    if (!channel) return;
    if (channel.timer) clearInterval(channel.timer);
    this.channels.delete(name);
    for (const watcher of [...channel.watchers]) this.send(channel, watcher, { type: "closed", code, reason });
    channel.watchers.clear();
  }

  dispose(): void {
    this.stopped = true;
    for (const name of [...this.channels.keys()]) this.close(name, "The broadcast service is restarting.", "restart");
  }
}
