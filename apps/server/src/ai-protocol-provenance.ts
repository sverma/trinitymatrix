import { z } from "zod";

const version = z.string().min(1).max(100);
export const aiRequestContextSchema = z.object({
  protocolId: version.optional(), matchId: z.string().uuid().optional(),
  gameRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  toolsVersion: version.optional(), serverRevision: version.optional(), declarationAvailable: z.boolean().nullable().optional()
}).strict();
export type AiRequestContext = z.infer<typeof aiRequestContextSchema>;
export const aiRequestCompletionSchema = z.object({
  action: z.enum(["draw-stock", "draw-discard", "discard", "declare", "submit-hand"]).optional(),
  outcome: z.enum(["accepted", "policy-rejected", "server-rejected", "provider-failed", "stale", "cancelled"]).optional()
}).strict();
export type AiRequestCompletion = z.infer<typeof aiRequestCompletionSchema>;

const privateManifestKey = /^(?:prompt|systemPrompt|messages|memory|hand|hands|cards|observation|requestBody|responseBody|providerBody|authorization|apiKey|secret|accessToken|refreshToken|cookie|email)$/i;
function metadataOnly(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 500;
  if (Array.isArray(value)) return value.length <= 64 && value.every((item) => metadataOnly(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const entries = Object.entries(value);
  return entries.length <= 64 && entries.every(([key, nested]) => key.length <= 100 && !privateManifestKey.test(key) && metadataOnly(nested, depth + 1));
}
export const aiProtocolRevisionSchema = z.object({
  id: version, policyHash: z.string().regex(/^[0-9a-f]{64}$/),
  semver: z.string().max(100).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  rulesRevision: version,
  manifest: z.record(z.string(), z.unknown()).refine((value) => metadataOnly(value) && Buffer.byteLength(JSON.stringify(value), "utf8") <= 32_768,
    "Protocol manifests contain bounded version/hash/capability metadata only.")
}).strict();
export type AiProtocolRevision = z.infer<typeof aiProtocolRevisionSchema>;
