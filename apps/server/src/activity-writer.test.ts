import { afterEach, describe, expect, it, vi } from "vitest";
import { BestEffortActivityWriter } from "./activity-writer";

describe("best-effort server activity writes", () => {
  afterEach(() => vi.useRealTimers());
  it("returns immediately and bounds pending analytics while the database stalls", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const report = vi.fn(); const writer = new BestEffortActivityWriter(report, 1);
    expect(writer.submit(() => pending)).toBe(true);
    expect(writer.submit(async () => undefined)).toBe(false);
    expect(report).toHaveBeenCalledWith("dropped");
    finish(); await writer.close();
  });
  it("handles failures without retaining or reporting raw error content", async () => {
    const report = vi.fn(); const writer = new BestEffortActivityWriter(report);
    writer.submit(async () => { throw new Error("private credential"); });
    await writer.close();
    expect(report).toHaveBeenCalledExactlyOnceWith("unavailable");
    expect(JSON.stringify(report.mock.calls)).not.toContain("credential");
    expect(writer.submit(async () => undefined)).toBe(false);
  });
  it("bounds shutdown waiting for unfinished telemetry", async () => {
    vi.useFakeTimers(); const writer = new BestEffortActivityWriter(() => undefined);
    writer.submit(() => new Promise(() => undefined));
    let closed = false; const done = writer.close(100).then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(100); await done;
    expect(closed).toBe(true);
  });
});
