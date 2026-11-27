import type { ActivityEvent, ActivityFilters, ActivityOverview, ActivitySession, ActivityUser } from "@trinitymatrix/protocol";
import { jsonRequest } from "./api";

export type ActivityPageResult<T> = { items: T[]; nextCursor: string | null };
export type ActivityEventKind = "all" | "auth" | "match" | "interaction";

function url(path: string, filters: ActivityFilters, extra: Record<string, string | number | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...filters, ...extra })) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return `/api/admin/activity/${path}?${params}`;
}

export const activityApi = {
  overview: (filters: ActivityFilters, signal?: AbortSignal) => jsonRequest<ActivityOverview>(url("overview", filters), signal ? { signal } : undefined),
  users: (filters: ActivityFilters, cursor?: string, signal?: AbortSignal) => jsonRequest<ActivityPageResult<ActivityUser>>(url("users", filters, { limit: 25, cursor }), signal ? { signal } : undefined),
  events: (filters: ActivityFilters, kind: ActivityEventKind = "all", cursor?: string, signal?: AbortSignal) => jsonRequest<ActivityPageResult<ActivityEvent>>(url("events", filters, { kind, limit: 25, cursor }), signal ? { signal } : undefined),
  sessions: (filters: ActivityFilters, cursor?: string, signal?: AbortSignal) => jsonRequest<ActivityPageResult<ActivitySession>>(url("sessions", filters, { limit: 25, cursor }), signal ? { signal } : undefined)
};
