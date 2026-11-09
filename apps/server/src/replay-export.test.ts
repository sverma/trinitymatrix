import { describe, expect, it } from "vitest";
import {
  prepareReplayExport,
  replayBucketName,
  ReplayExportWorker,
  type ReplayExportDocument,
  type ReplayExportLedger,
  type ReplayObjectStore
} from "./replay-export";

const matchId = "00000000-0000-4000-8000-000000000001";
const firstUser = "00000000-0000-4000-8000-000000000002";
const secondUser = "00000000-0000-4000-8000-000000000003";

function replay(payload: Record<string, unknown> = { state: { revision: 1 }, command: { type: "start" } }): ReplayExportDocument {
  return {
    schemaVersion: 1,
    game: {
      id: matchId,
      publicName: "amber-lotus-12345678",
      playerCount: 2,
      matchType: "general",
      winnerUserId: firstUser,
      endReason: "declaration",
      startedAt: "2026-08-31T10:00:00.000Z",
      endedAt: "2026-08-31T10:15:00.000Z"
    },
    participants: [
      {
        userId: firstUser,
        seatNumber: 0,
        displayName: "Asha",
        badgeId: "rookie",
        outcome: "won",
        scoreDelta: 16,
        ratingAfter: 1016
      },
      {
        userId: secondUser,
        seatNumber: 1,
        displayName: "Bela",
        badgeId: "strategist",
        outcome: "lost",
        scoreDelta: -16,
        ratingAfter: 984
      }
    ],
    events: [{
      eventId: "00000000-0000-4000-8000-000000000004",
      sequence: 1,
      eventType: "game.started",
      actorUserId: null,
      commandId: null,
      payload,
      occurredAt: "2026-08-31T10:00:00.000Z",
      recordedAt: "2026-08-31T10:00:00.010Z"
    }]
  };
}

describe("replay export", () => {
  it("requires a valid replay bucket only when durable production startup asks for it", () => {
    expect(replayBucketName(undefined)).toBeNull();
    expect(replayBucketName("trinitymatrix-production-replays-123")).toBe("trinitymatrix-production-replays-123");
    expect(() => replayBucketName(undefined, true)).toThrow("REPLAY_BUCKET is required");
    expect(() => replayBucketName("Invalid_Bucket")).toThrow("valid DNS-compatible");
  });

  it("creates the same content hash and object key regardless of JSON object key order", () => {
    const first = prepareReplayExport(replay({ state: { revision: 1 }, command: { type: "start", seat: 0 } }));
    const second = prepareReplayExport(replay({ command: { seat: 0, type: "start" }, state: { revision: 1 } }));

    expect(first.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.contentSha256).toBe(second.contentSha256);
    expect(first.body).toEqual(second.body);
    expect(first.objectKey).toBe(
      `replays/v1/2026/08/amber-lotus-12345678/${first.contentSha256}.json`
    );
    expect(Buffer.from(first.checksumSha256, "base64").toString("hex")).toBe(first.contentSha256);
  });

  it("rejects incomplete streams and inconsistent winners before writing object storage", () => {
    expect(() => prepareReplayExport({ ...replay(), events: [] })).toThrow("empty or non-contiguous");
    expect(() => prepareReplayExport({
      ...replay(),
      participants: replay().participants.map((participant) => ({ ...participant, outcome: "lost" as const }))
    })).toThrow("exactly one declared winner");
  });

  it("exports a claim once and records the content identity after object persistence", async () => {
    const actions: string[] = [];
    let claimed = false;
    const ledger: ReplayExportLedger = {
      claim: async () => {
        if (claimed) return [];
        claimed = true;
        actions.push("claim");
        return [{ matchId, attempts: 1 }];
      },
      load: async () => {
        actions.push("load");
        return replay();
      },
      markExported: async (input) => {
        actions.push("mark");
        expect(input.contentSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(input.objectKey).toContain(input.contentSha256);
        expect(input.eventCount).toBe(1);
      },
      reschedule: async () => { throw new Error("should not retry"); }
    };
    const store: ReplayObjectStore = {
      putIfAbsent: async (input) => {
        actions.push("put");
        expect(input.body.byteLength).toBeGreaterThan(0);
        return { etag: "etag", versionId: "version" };
      }
    };
    const worker = new ReplayExportWorker(ledger, store, "worker-a", () => undefined);
    await worker.runOnce(new Date("2026-08-31T10:16:00.000Z"));
    await worker.runOnce(new Date("2026-08-31T10:16:01.000Z"));
    expect(actions).toEqual(["claim", "load", "put", "mark"]);
  });

  it("releases failed claims with bounded exponential retry without acknowledging export", async () => {
    const retryAt: Date[] = [];
    const errors: unknown[] = [];
    const ledger: ReplayExportLedger = {
      claim: async () => [{ matchId, attempts: 4 }],
      load: async () => replay(),
      markExported: async () => { throw new Error("should not mark"); },
      reschedule: async (input) => { retryAt.push(input.retryAt); }
    };
    const store: ReplayObjectStore = {
      putIfAbsent: async () => { throw new Error("S3 unavailable"); }
    };
    const now = new Date("2026-08-31T10:16:00.000Z");
    const worker = new ReplayExportWorker(ledger, store, "worker-a", (error) => errors.push(error));
    await worker.runOnce(now);
    expect(retryAt).toEqual([new Date(now.getTime() + 8_000)]);
    expect(errors).toHaveLength(1);
  });
});
