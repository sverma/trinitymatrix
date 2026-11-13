import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { aiPracticeBindingSchema, aiPracticeCompletionSchema, aiPracticeMetricsSchema, PostgresAiPracticeStore } from "./ai-practice-repository";

const binding = {
  agentId: randomUUID(), modelId: "fixture/practice-model", protocolId: "fixture-protocol/3.0.0",
  curriculumId: "synthetic/1.0.0", curriculumHash: "a".repeat(64), rulesRevision: "rules/1.0.0"
};

describe("private AI practice persistence inputs", () => {
  it("accepts only bounded immutable identity and curriculum metadata", () => {
    expect(aiPracticeBindingSchema.parse(binding)).toEqual(binding);
    for (const patch of [{ agentId: "not-a-uuid" }, { curriculumHash: "invalid" }, { rulesRevision: "" }, { protocolId: "x".repeat(101) }, { prompt: "private" }]) {
      expect(() => aiPracticeBindingSchema.parse({ ...binding, ...patch })).toThrow();
    }
  });

  it("accepts fixed numeric practice summaries without allowing raw diagnostic fields", () => {
    const metrics = {
      requestedRounds: 2, completedRounds: 2, trainingEpisodes: 4, evaluationEpisodes: 2, completedEpisodes: 6,
      requests: 30, retries: 2, validDeclarations: 5, invalidActions: 2, providerErrors: 0,
      winningDecisionsMissed: 1, knownCostUsd: 0.005, unknownCostRequests: 0, maxLatencyMs: 3000, maxTurnDurationMs: 4500
    };
    expect(aiPracticeMetricsSchema.parse(metrics)).toEqual(metrics);
    for (const value of [-1, Number.NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, {}, []]) {
      expect(() => aiPracticeMetricsSchema.parse({ requests: value })).toThrow();
    }
    for (const field of ["prompt", "hands", "messages", "providerBody", "memory", "email", "episodes", "arbitraryMetric"]) {
      expect(() => aiPracticeMetricsSchema.parse({ [field]: "private" })).toThrow();
    }
  });

  it("bounds private model notes and rejects unsafe inputs before opening a transaction", async () => {
    const connect = vi.fn();
    const store = new PostgresAiPracticeStore({ connect } as unknown as Pool);
    const valid = { runId: randomUUID(), notes: "x".repeat(512), metrics: { requests: 1 }, promote: false };
    expect(aiPracticeCompletionSchema.parse(valid)).toEqual(valid);
    await expect(store.completeRun({ ...valid, notes: "x".repeat(513) })).rejects.toThrow();
    await expect(store.completeRun({ ...valid, metrics: { providerBody: "private" } } as never)).rejects.toThrow();
    await expect(store.beginRun({ ...binding, modelId: "" })).rejects.toThrow();
    await expect(store.failRun("not-a-uuid")).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});
