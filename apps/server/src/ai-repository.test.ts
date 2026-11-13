import { describe, expect, it } from "vitest";
import { AI_CURRENT_IDENTITY_VERSION, AI_LEGACY_IDENTITY_VERSION, AI_PROMPT_VERSION, INITIAL_AI_ROSTER, aiIdentityId } from "./ai-repository";
import { AI_GAME_PROTOCOL_IDENTITY_VERSION } from "./ai-game-protocol";
import { AI_VALIDATION_IDENTITY_VERSION } from "./ai-game-protocol-v3";

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
const v2IdentityIds = {
  "anthropic/claude-haiku-5.5": "ae685124-fcb5-5c08-b8cc-bf30f0fdc441",
  "google/gemini-3.8-flash": "04328d08-4fe6-5dca-a137-dce3be54686c",
  "deepseek/deepseek-v3.2": "34ae4d72-4323-52f2-bf18-b55d0de5501a",
  "qwen/qwen3.8-flash": "19f7488f-54fc-58c4-bc5c-ecc61e358ab9",
  "mistralai/mistral-small-2603": "503816b2-2877-5741-8863-d3becb302b32",
  "openai/gpt-6-luna": "fa1605f3-10a4-5a9d-a0fa-20833bdf151d",
  "meta-llama/llama-4-maverick": "b07891fc-374d-51d9-9109-edf01edaec66",
  "deepseek/deepseek-v4.1-flash": "0f39baa6-db36-505a-8a5e-b19844e34084",
  "openai/gpt-6.1-terra": "5fa51f82-f108-5744-a03c-2ef4d1fa37a8",
  "openai/gpt-5.4-mini": "da7b1d5a-f8ea-5042-964e-ecf84927323f",
  "nvidia/nemotron-3-ultra-550b-a55b": "0e9e9ff1-2cad-5b6e-af5f-656ac4a70443",
  "xiaomi/mimo-v2.6-flash": "bc6acb83-2fe6-547f-8655-fd03378d8205",
  "z-ai/glm-5": "1e6580e8-3353-5c36-99bf-2f563feeb67d"
};

describe("persistent AI roster identities", () => {
  it("keeps published legacy identities while defaulting new opponents to validation-only", () => {
    expect(AI_LEGACY_IDENTITY_VERSION).toBe("trinity-v1");
    expect(AI_PROMPT_VERSION).toBe(AI_CURRENT_IDENTITY_VERSION);
    expect(AI_CURRENT_IDENTITY_VERSION).toBe(AI_VALIDATION_IDENTITY_VERSION);
    expect(INITIAL_AI_ROSTER.map(({ modelId }) => modelId)).toEqual(expect.arrayContaining(Object.keys(identityIds)));
    expect(new Set(INITIAL_AI_ROSTER.map(({ displayName }) => displayName)).size).toBe(INITIAL_AI_ROSTER.length);
    expect(new Set(INITIAL_AI_ROSTER.map(({ modelId }) => aiIdentityId(modelId, AI_LEGACY_IDENTITY_VERSION))).size).toBe(INITIAL_AI_ROSTER.length);
    for (const [modelId, id] of Object.entries(identityIds)) expect(aiIdentityId(modelId, AI_LEGACY_IDENTITY_VERSION)).toBe(id);
  });

  it("retains every solver-assisted v2 identity and gives validation-only opponents separate IDs", () => {
    expect(AI_GAME_PROTOCOL_IDENTITY_VERSION).toBe("trinity-agent-protocol/2.0.0:a29df5da5bd4c9bf5ef9c3d71150b34ca6452e843c4c967a304087ade66eb5af");
    expect(Object.keys(v2IdentityIds)).toHaveLength(INITIAL_AI_ROSTER.length);
    for (const [modelId, id] of Object.entries(v2IdentityIds)) {
      expect(aiIdentityId(modelId, AI_GAME_PROTOCOL_IDENTITY_VERSION)).toBe(id);
      expect(aiIdentityId(modelId)).not.toBe(id);
    }
  });

  it.each([
    { modelId: "openai/gpt-6.1-terra", modelName: "GPT-6.1 Terra", displayName: "Terra AI" },
    { modelId: "openai/gpt-5.4-mini", modelName: "GPT-5.4 Mini", displayName: "GPT Mini AI" },
    { modelId: "nvidia/nemotron-3-ultra-550b-a55b", modelName: "Nemotron 3 Ultra", displayName: "Nemotron AI" },
    { modelId: "xiaomi/mimo-v2.6-flash", modelName: "MiMo V2.6 Flash", displayName: "MiMo AI" },
    { modelId: "z-ai/glm-5", modelName: "GLM 5", displayName: "GLM AI" },
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
      expect(current).not.toBe(aiIdentityId(modelId, AI_GAME_PROTOCOL_IDENTITY_VERSION));
      expect(current).toBe(aiIdentityId(modelId, AI_CURRENT_IDENTITY_VERSION));
      expect(aiIdentityId(modelId)).toBe(current);
      expect(current).not.toBe(aiIdentityId(modelId, "a-future-protocol-version"));
      expect(displayName.length).toBeLessThanOrEqual(24);
    }
  });
});
