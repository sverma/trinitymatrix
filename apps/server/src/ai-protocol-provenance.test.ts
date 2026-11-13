import { describe, expect, it } from "vitest";
import { aiProtocolRevisionSchema, aiRequestCompletionSchema, aiRequestContextSchema } from "./ai-protocol-provenance";

const revision = { id: "trinity-v2", policyHash: "a".repeat(64), semver: "2.0.0", rulesRevision: "trinity-rules-v1",
  manifest: { promptSHA: "b".repeat(64), toolVersion: "own-hand-v1", responseContractVersion: "1", capabilities: { ownHandOnly: true } } };
describe("AI request provenance metadata", () => {
  it("accepts static protocol descriptors and optional legacy reservation/completion contexts", () => {
    expect(aiProtocolRevisionSchema.parse(revision)).toEqual(revision);
    expect(aiRequestContextSchema.parse({})).toEqual({});
    expect(aiRequestCompletionSchema.parse({})).toEqual({});
    expect(aiRequestContextSchema.parse({ protocolId: revision.id, toolsVersion: "own-hand-v1", declarationAvailable: null })).toMatchObject({ declarationAvailable: null });
    expect(aiRequestContextSchema.parse({ declarationAvailable: false })).toEqual({ declarationAvailable: false });
  });
  it.each(["prompt", "systemPrompt", "memory", "hands", "cards", "providerBody", "authorization", "apiKey"])("rejects private payload data under manifest key %s", (key) => {
    expect(() => aiProtocolRevisionSchema.parse({ ...revision, manifest: { nested: { [key]: "private data" } } })).toThrow();
  });
  it("rejects invalid versions, unbounded manifests and unexpected request data before any charge", () => {
    expect(() => aiProtocolRevisionSchema.parse({ ...revision, policyHash: "not-a-sha256" })).toThrow();
    expect(() => aiProtocolRevisionSchema.parse({ ...revision, semver: "latest" })).toThrow();
    expect(() => aiProtocolRevisionSchema.parse({ ...revision, manifest: { oversized: "x".repeat(501) } })).toThrow();
    expect(() => aiRequestContextSchema.parse({ gameRevision: -1 })).toThrow();
    expect(() => aiRequestContextSchema.parse({ hand: ["private"] })).toThrow();
    expect(() => aiRequestCompletionSchema.parse({ outcome: "arbitrary-provider-body" })).toThrow();
    expect(aiRequestCompletionSchema.parse({ action: "declare", outcome: "accepted" })).toEqual({ action: "declare", outcome: "accepted" });
  });
});
