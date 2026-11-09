export type WebSocketInboundResult = "accepted" | "rate-limited" | "backpressure" | "closed";

export type WebSocketInboundGuardOptions = {
  messagesPerSecond: number;
  burst: number;
  maxBufferedMessages: number;
  now?: () => number;
  onTaskError?: (error: unknown) => void;
};

type InboundTask = () => Promise<void> | void;

/**
 * Per-connection admission control for application WebSocket messages.
 *
 * The token bucket bounds sustained and burst traffic. Accepted work then goes
 * through one serialized consumer, so a socket cannot execute concurrent game
 * commands or retain an unbounded chain of pending closures in memory.
 */
export class WebSocketInboundGuard {
  private readonly messagesPerMillisecond: number;
  private readonly burst: number;
  private readonly maxBufferedMessages: number;
  private readonly now: () => number;
  private readonly onTaskError: (error: unknown) => void;
  private readonly queue: InboundTask[] = [];
  private tokens: number;
  private refilledAt: number;
  private processing = false;
  private closed = false;

  constructor(options: WebSocketInboundGuardOptions) {
    if (!(options.messagesPerSecond > 0) || !Number.isFinite(options.messagesPerSecond)) {
      throw new Error("messagesPerSecond must be a positive finite number.");
    }
    if (!Number.isInteger(options.burst) || options.burst < 1) {
      throw new Error("burst must be a positive integer.");
    }
    if (!Number.isInteger(options.maxBufferedMessages) || options.maxBufferedMessages < 1) {
      throw new Error("maxBufferedMessages must be a positive integer.");
    }
    this.messagesPerMillisecond = options.messagesPerSecond / 1_000;
    this.burst = options.burst;
    this.maxBufferedMessages = options.maxBufferedMessages;
    this.now = options.now ?? Date.now;
    this.onTaskError = options.onTaskError ?? (() => undefined);
    this.tokens = options.burst;
    this.refilledAt = this.now();
  }

  get bufferedMessages(): number {
    return (this.processing ? 1 : 0) + this.queue.length;
  }

  enqueue(task: InboundTask): WebSocketInboundResult {
    if (this.closed) return "closed";

    // Never move the refill baseline backwards if the wall clock is adjusted.
    // A backward jump must not manufacture a later refill window.
    const now = Math.max(this.refilledAt, this.now());
    const elapsed = Math.max(0, now - this.refilledAt);
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.messagesPerMillisecond);
    this.refilledAt = now;
    if (this.tokens < 1) return "rate-limited";

    if (this.bufferedMessages >= this.maxBufferedMessages) return "backpressure";

    this.tokens -= 1;
    this.queue.push(task);
    void this.drain();
    return "accepted";
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  private async drain(): Promise<void> {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      while (!this.closed) {
        const task = this.queue.shift();
        if (!task) break;
        try {
          await task();
        } catch (error) {
          this.onTaskError(error);
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
