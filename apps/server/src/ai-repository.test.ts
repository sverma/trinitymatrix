import { describe, expect, it } from "vitest";
import { AI_CURRENT_IDENTITY_VERSION, AI_LEGACY_IDENTITY_VERSION, AI_PROMPT_VERSION, INITIAL_AI_ROSTER, aiIdentityId } from "./ai-repository";

// Published identity UUIDs must survive roster expansion and process restarts.
const identityIds = {
  "anthropic/claude-haiku-5.5": "589e6c6d-954c-5764-b7a2-46ba1567ae3b",
  "google/gemini-3.8-flash": "7ec15324-31dd-5741-af2d-53dc8364c62a",
  "deepseek/deepseek-v3.2": "b0b9a961-8394-5821-9bf8-acbd806983d3",
  "qwen/qwen3.8-flash": "1309b434-d3d5-5681-888e-6d16517b3d1f",
  "mistralai/mistral-small-2603": "fb4ad69b-212c-5636-bb04-e4b1cb1902ba",
  "openai/gpt-6-luna": "064ef4d1-cd96-5c2f-b656-88202c0a74e4",
  "meta-llama/llama-4-maverick": "13491002-b685-5cab-b13f-5dc853b22d45",
  "deepseek/deepseek-v4.1-flash": "00237283-f3e5-5bba-aed9-478da5bc3901"
};

describe("persistent AI roster identities", () => {
  it("extends the roster without rotating the prompt or any published identity", () => {
    expect(AI_LEGACY_IDENTITY_VERSION).toBe("trinity-v1");
    expect(AI_PROMPT_VERSION).toBe(AI_CURRENT_IDENTITY_VERSION);
    expect(INITIAL_AI_ROSTER.map(({ modelId }) => modelId)).toEqual(Object.keys(identityIds));
    expect(new Set(INITIAL_AI_ROSTER.map(({ displayName }) => displayName)).size).toBe(INITIAL_AI_ROSTER.length);
    expect(new Set(INITIAL_AI_ROSTER.map(({ modelId }) => aiIdentityId(modelId, AI_LEGACY_IDENTITY_VERSION))).size).toBe(INITIAL_AI_ROSTER.length);
    for (const [modelId, id] of Object.entries(identityIds)) expect(aiIdentityId(modelId, AI_LEGACY_IDENTITY_VERSION)).toBe(id);
  });

  it.each([
    { modelId: "openai/gpt-6-luna", modelName: "GPT-6 Luna", displayName: "Luna AI" },
    { modelId: "meta-llama/llama-4-maverick", modelName: "Llama 4 Maverick", displayName: "Llama AI" },
    { modelId: "deepseek/deepseek-v4.1-flash", modelName: "DeepSeek V4.1 Flash", displayName: "DeepSeek Flash AI" }
  ])("binds $displayName to the exact configured model slug", (identity) => {
    expect(INITIAL_AI_ROSTER.find(({ modelId }) => modelId === identity.modelId)).toEqual(identity);
  });

  it("keeps the new Flash identity separate from its retired suffixed model", () => {
    const retiredModelId = "deepseek/deepseek-v4.1-flash-1017";
    expect(aiIdentityId(retiredModelId, AI_LEGACY_IDENTITY_VERSION)).toBe("35d2355b-f6b3-50bf-a266-170f134edb33");
    expect(aiIdentityId(retiredModelId, AI_LEGACY_IDENTITY_VERSION)).not.toBe(aiIdentityId("deepseek/deepseek-v4.1-flash", AI_LEGACY_IDENTITY_VERSION));
    expect(INITIAL_AI_ROSTER.some(({ modelId }) => (modelId as string) === retiredModelId)).toBe(false);
  });
  it("creates deterministic separate competitive identities for each protocol revision", () => {
    for (const { modelId, displayName } of INITIAL_AI_ROSTER) {
      const current = aiIdentityId(modelId, AI_CURRENT_IDENTITY_VERSION);
      expect(current).not.toBe(aiIdentityId(modelId, AI_LEGACY_IDENTITY_VERSION));
      expect(current).toBe(aiIdentityId(modelId, AI_CURRENT_IDENTITY_VERSION));
      expect(aiIdentityId(modelId)).toBe(current);
      expect(current).not.toBe(aiIdentityId(modelId, "a-future-protocol-version"));
      expect(displayName.length).toBeLessThanOrEqual(24);
    }
  });
});
