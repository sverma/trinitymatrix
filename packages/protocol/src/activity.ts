import { z } from "zod";

export const activityPages = ["lobby", "table", "rankings", "history", "replay", "private", "live", "watch", "profile", "rules", "admin"] as const;
export const activityActions = ["page.view", "queue.join", "queue.leave", "ai.select", "private.create", "private.accept", "private.cancel", "watch.open", "video.start", "video.stop", "profile.save", "cards.group", "cards.sort", "declaration.attempt", "sound.toggle", "help.open"] as const;
export const activityPageSchema = z.enum(activityPages);
export const activityActionSchema = z.enum(activityActions);
export type ActivityPage = z.infer<typeof activityPageSchema>;
export type ActivityAction = z.infer<typeof activityActionSchema>;
export const activityIngestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat"), eventId: z.string().uuid(), page: activityPageSchema, active: z.boolean(), fresh: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("interaction"), eventId: z.string().uuid(), page: activityPageSchema, action: activityActionSchema }).strict()
]);
export type ActivityIngest = z.infer<typeof activityIngestSchema>;
export const activityFiltersSchema = z.object({
  from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }),
  actorKind: z.enum(["all", "human", "ai"]).default("all"), userId: z.string().uuid().optional(),
  q: z.string().trim().max(254).optional()
}).strict().superRefine((value, ctx) => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  if (!(duration > 0) || duration > 90 * 86_400_000) ctx.addIssue({ code: "custom", message: "Activity ranges must be positive and at most 90 days." });
});
export type ActivityFilters = z.infer<typeof activityFiltersSchema>;
export type ActivityActorKind = "human" | "ai";
export type ActivityList<T> = { items: T[]; nextCursor: string | null };
export type ActivityOverview = {
  from: string; to: string; trackingSince: string; retentionDays: number; generatedAt: string;
  summary: { signIns: number; uniqueUsers: number; activeUsers: number; activeSeconds: number; matches: number; wins: number; losses: number; drops: number; interactions: number };
  daily: Array<{ date: string; signIns: number; activeSeconds: number; matches: number; interactions: number }>;
  pages: Array<{ page: ActivityPage; views: number; activeSeconds: number }>;
  actions: Array<{ action: string; count: number; source: "browser" | "server" }>;
};
export type ActivityUser = {
  userId: string; displayName: string; email: string; actorKind: ActivityActorKind;
  lastSeenAt: string | null; lastSignInAt: string | null; status: "active" | "idle" | "offline";
  signIns: number; sessionCount: number; activeSeconds: number; matches: number; wins: number; losses: number; drops: number; interactions: number;
};
export type ActivityEvent = {
  id: string; occurredAt: string; userId: string; displayName: string; email: string; actorKind: ActivityActorKind;
  kind: "auth" | "match" | "interaction"; action: string; source: "browser" | "server";
  page: ActivityPage | null; gameName: string | null; outcome: "won" | "lost" | "dropped" | null;
};
export type ActivitySession = {
  id: string; userId: string; displayName: string; email: string; actorKind: ActivityActorKind;
  startedAt: string; signedInAt: string | null; lastSeenAt: string; endedAt: string | null; expiresAt: string | null;
  activeSeconds: number; lastPage: ActivityPage | null;
};
