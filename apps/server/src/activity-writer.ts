export async function waitForActivityWork(task: Promise<unknown>, timeoutMs = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([task, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  if (timer) clearTimeout(timer);
}

/** Bounded analytics writes never hold a sign-in/profile/logout response open. */
export class BestEffortActivityWriter {
  private readonly pending = new Set<Promise<void>>();
  private closed = false;
  constructor(private readonly report: (code: "unavailable" | "dropped") => void, private readonly maximumPending = 32) {}

  submit(write: () => Promise<unknown>): boolean {
    if (this.closed || this.pending.size >= this.maximumPending) { this.report("dropped"); return false; }
    const task = Promise.resolve().then(write).then(() => undefined, () => this.report("unavailable"));
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
    return true;
  }

  async close(timeoutMs = 1_000): Promise<void> {
    this.closed = true;
    await waitForActivityWork(Promise.allSettled([...this.pending]), timeoutMs);
  }
}
