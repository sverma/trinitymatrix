import type {
  Card,
  MatchType,
  PlayerCount,
  PrivateInvitation,
  PrivateRoom,
  ProfileBadgeId,
  LiveBroadcastSummary,
  BroadcastFrame,
  BroadcastComment
} from "@trinitymatrix/protocol";

const jsonHeaders = { "Content-Type": "application/json" };

export class HttpApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "HttpApiError"; }
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    credentials: "same-origin",
    // Player, game and administration resources are mutable per-session views.
    // A browser revalidation can otherwise turn a JSON retry into a bodyless 304.
    cache: "no-store"
  });
  if (response.status === 204) return undefined as T;

  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new HttpApiError(body?.error ?? "The request failed.", response.status);
  if (body === null) throw new Error("The game service returned an invalid response. Please retry.");
  return body;
}

function privateRoomResponse(value: unknown): { room: PrivateRoom } {
  if (!value || typeof value !== "object" || !("room" in value)) {
    throw new Error("The private table response was incomplete. Please retry.");
  }
  const room = (value as { room?: unknown }).room;
  if (!room || typeof room !== "object" || typeof (room as { roomCode?: unknown }).roomCode !== "string") {
    throw new Error("The private table response was incomplete. Please retry.");
  }
  return { room: room as PrivateRoom };
}

export type AuthPlayer = {
  id: string;
  email: string;
  displayName: string;
  badgeId: ProfileBadgeId;
  phone: { countryCode: string; nationalNumber: string } | null;
  createdAt: number;
  updatedAt: number;
};

export type ProfileUpdate = Pick<AuthPlayer, "displayName" | "badgeId" | "phone">;

export type AdminPasskeyStatus = {
  configured: boolean;
  credentialCount: number;
  unlocked: boolean;
};

export type AdminPasskeyOptions = {
  requestId: string;
  options: Record<string, unknown>;
};

export type RankingEntry = {
  rank: number;
  playerId: string;
  displayName: string;
  badgeId?: ProfileBadgeId;
  rating: number;
  wins: number;
  gamesPlayed: number;
  actorKind?: "human" | "ai";
  modelId?: string | null;
};

export type RankingComposition = "human" | "ai" | "mixed";

export type AiPlayerForfeit = {
  playerId: string;
  playerName: string;
  reasonCode: "AI_UNAVAILABLE" | "AI_INVALID_ACTION" | "AI_BUDGET_EXHAUSTED";
  reason: string;
};

export type AiPlayer = {
  id: string;
  displayName: string;
  modelId: string;
  modelName: string;
  available: boolean;
  reason?: string;
  rating: number;
  gamesPlayed: number;
  wins: number;
};

export type AiPlayerRoster = {
  enabled: boolean;
  players: AiPlayer[];
  dailyBudgetUsd: number;
};

export type MatchHistoryEntry = {
  gameName: string;
  gameId?: string;
  finishedAt: number | string;
  playerCount: number;
  result: "won" | "lost" | "dropped";
  winnerName: string;
  reason?: string;
  score?: number;
  rankDelta?: number;
  matchType?: MatchType;
};

export type ReplayPlayer = {
  playerId: string;
  displayName: string;
};

export type ReplayCard = Card & {
  label: string;
  wild: boolean;
};

export type ReplayMeldGroup = {
  kind: "trinity" | "meld" | "unmatched";
  label: string;
  total: number | null;
  cards: ReplayCard[];
};

export type ReplayEvent = {
  sequence: number;
  at: number | string;
  type: string;
  actorName?: string;
  summary: string;
  payload?: unknown;
  state?: {
    phase?: string;
    currentPlayerName?: string;
    stockCount?: number;
    topDiscard?: string | null;
    wildRank?: number;
    players?: Array<{
      playerId?: string;
      displayName: string;
      cardCount?: number;
      status?: string;
      isWinner?: boolean;
      cards?: ReplayCard[];
      layoutSource?: "recorded" | "suggested";
      groups?: ReplayMeldGroup[];
      progress?: {
        matchedCardCount: number;
        totalCardCount: number;
        trinityMeldCount: number;
        validMeldCount: number;
        score: number;
        declarationReady: boolean;
      };
    }>;
  };
};

export type GameReplay = {
  gameName: string;
  startedAt?: number | string;
  finishedAt?: number | string;
  winnerName?: string;
  reason?: string;
  players: ReplayPlayer[];
  events: ReplayEvent[];
};

export type ChatMessage = {
  id: string;
  playerId: string;
  displayName: string;
  message: string;
  createdAt: number | string;
};

export type RealtimeChatMessage = {
  gameName: string;
  message: ChatMessage;
};

export type AdminOverview = {
  totalUsers: number;
  totalGames: number;
  activeGames: number;
  completedGames: number;
  totalChatMessages?: number;
  activeGeneralMatches?: number;
  activePrivateMatches?: number;
  waitingPrivateRooms?: number;
};

export type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  status?: "active" | "disabled" | "online" | "offline";
  gamesPlayed: number;
  wins: number;
  createdAt: number | string;
  lastSeenAt?: number | string;
};

export type AdminUsersResponse = {
  users: AdminUser[];
  nextCursor: string | null;
  total: number;
};

export type AdminGame = {
  gameName: string;
  status: "waiting" | "playing" | "finished" | "abandoned";
  playerCount: number;
  players: Array<{ playerId?: string; displayName: string }>;
  winnerName?: string;
  startedAt: number | string;
  finishedAt?: number | string;
  eventCount?: number;
  chatMessageCount?: number;
  matchType?: MatchType;
  creator?: { playerId: string; displayName: string; email?: string };
  invites?: Array<{
    email: string;
    status: "pending" | "accepted";
    playerId?: string;
    displayName?: string;
  }>;
};

export type PrivateMatchOverview = {
  invitations: PrivateInvitation[];
  createdRooms: PrivateRoom[];
};

export type LiveDirectoryFilters = { composition?: "all" | "human" | "ai" | "mixed"; status?: "all" | "live" | "ended"; q?: string; cursor?: string };
export type LiveBroadcastDetail = { broadcast: LiveBroadcastSummary; frame: BroadcastFrame | null; comments: BroadcastComment[]; serverNow: number; canModerate: boolean };
export type BroadcastTimelineEntry = Pick<BroadcastFrame, "sequence" | "capturedAt" | "event">;
export type BroadcastVideoLimits = { width: number; height: number; frameRate: number; maxDurationSeconds: number };
export type BroadcastVideoInfo = {
  enabled: boolean; canPublish: boolean; serverNow: number; limits: BroadcastVideoLimits;
  video: null | { id: string; status: "starting" | "buffering" | "live" | "stopped" | "interrupted" | "expired"; availableAt: number; playlistUrl: string | null; publisherName?: string };
};
export type BroadcastVideoSession = { id: string; uploadUrl: string; stopUrl: string; availableAt: number; limits: BroadcastVideoLimits };
export type BroadcastReport = { id: string; broadcastName: string; comment: BroadcastComment; reason: string; createdAt: number };

function livePath(gameName: string) { return `/api/live/${encodeURIComponent(gameName)}`; }

/** Upload/playlist endpoints must remain on this origin; no credentials follow external URLs. */
export function sameOriginMediaPath(value: string): string {
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || url.username || url.password || !url.pathname.startsWith("/api/live/")) {
    throw new Error("The video service returned an invalid media address.");
  }
  return `${url.pathname}${url.search}`;
}

export type AdminGameDetail = {
  game: AdminGame;
  events?: ReplayEvent[];
  chatMessages?: ChatMessage[];
};

type CollectionResponse<K extends string, T> = T[] | Record<K, T[]>;

function gamePath(gameName: string, resource: "replay" | "chat") {
  return `/api/games/${encodeURIComponent(gameName)}/${resource}`;
}

export const api = {
  liveCapabilities: (signal?: AbortSignal) => jsonRequest<{ enabled: boolean; videoEnabled: boolean; delayMs: number }>("/api/live/capabilities", signal ? { signal } : undefined),
  liveDirectory: (filters: LiveDirectoryFilters = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value && value !== "all") query.set(key, value);
    return jsonRequest<{ broadcasts: LiveBroadcastSummary[]; nextCursor: string | null; serverNow: number }>(`/api/live${query.size ? `?${query}` : ""}`, signal ? { signal } : undefined);
  },
  liveBroadcast: (gameName: string, signal?: AbortSignal) => jsonRequest<LiveBroadcastDetail>(livePath(gameName), signal ? { signal } : undefined),
  closeLiveBroadcast: (gameName: string) => jsonRequest<void>(`${livePath(gameName)}/close`, { method: "POST" }),
  broadcastTimeline: (gameName: string, beforeSequence?: number, signal?: AbortSignal) => jsonRequest<{ frames: BroadcastTimelineEntry[]; nextCursor: string | null }>(
    `${livePath(gameName)}/timeline?limit=30${beforeSequence === undefined ? "" : `&beforeSequence=${beforeSequence}`}`, signal ? { signal } : undefined),
  broadcastFrame: (gameName: string, sequence: number, signal?: AbortSignal) => jsonRequest<{ frame: BroadcastFrame }>(`${livePath(gameName)}/frames/${sequence}`, signal ? { signal } : undefined),
  postBroadcastComment: (gameName: string, message: string, clientMessageId: string) => jsonRequest<{ comment?: BroadcastComment; availableAt: number; delayed: boolean }>(`${livePath(gameName)}/comments`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ message, clientMessageId })
  }),
  deleteBroadcastComment: (gameName: string, commentId: string) => jsonRequest<void>(`${livePath(gameName)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }),
  reportBroadcastComment: (gameName: string, commentId: string, reason: string) => jsonRequest<void>(`${livePath(gameName)}/comments/${encodeURIComponent(commentId)}/report`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ reason }) }),
  liveVideo: (gameName: string, signal?: AbortSignal) => jsonRequest<BroadcastVideoInfo>(`${livePath(gameName)}/video`, signal ? { signal } : undefined),
  startBroadcastVideo: (gameName: string) => jsonRequest<BroadcastVideoSession>(`${livePath(gameName)}/video/start`, { method: "POST", signal: AbortSignal.timeout(15_000) }),
  uploadBroadcastVideo: async (uploadUrl: string, sequence: number, chunk: Blob, signal?: AbortSignal) => {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || chunk.size < 1 || chunk.size > 512 * 1024) throw new Error("The video chunk is outside the upload limits.");
    const path = sameOriginMediaPath(uploadUrl);
    const separator = path.includes("?") ? "&" : "?";
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(`${path}${separator}sequence=${sequence}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream" }, body: chunk, cache: "no-store", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? "The video upload was interrupted.");
    }
  },
  stopBroadcastVideo: (stopUrl: string) => jsonRequest<void>(sameOriginMediaPath(stopUrl), { method: "POST", keepalive: true, signal: AbortSignal.timeout(10_000) }),
  broadcastReports: (cursor?: string) => jsonRequest<{ reports: BroadcastReport[]; nextCursor: string | null }>(`/api/admin/live/reports?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  resolveBroadcastReport: (reportId: string, removeComment: boolean) => jsonRequest<void>(`/api/admin/live/reports/${encodeURIComponent(reportId)}/resolve`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ removeComment }) }),
  session: () => jsonRequest<{ authenticated: boolean; player?: AuthPlayer; isAdmin?: boolean; adminUnlocked?: boolean }>("/api/session"),
  adminPasskeyStatus: () => jsonRequest<AdminPasskeyStatus>("/api/admin/passkeys/status"),
  adminPasskeyRegistrationOptions: (input: { deviceName: string; bootstrapCode?: string; recoveryCode?: string }) =>
    jsonRequest<AdminPasskeyOptions>("/api/admin/passkeys/registration/options", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input)
  }),
  verifyAdminPasskeyRegistration: (requestId: string, response: unknown) =>
    jsonRequest<{ recoveryCodes?: string[]; recoveryAcknowledgementToken?: string }>("/api/admin/passkeys/registration/verify", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ requestId, response })
    }),
  acknowledgeAdminRecoveryCodes: (acknowledgementToken: string) =>
    jsonRequest<void>("/api/admin/passkeys/registration/acknowledge-recovery", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ acknowledgementToken })
    }),
  adminPasskeyAuthenticationOptions: () => jsonRequest<AdminPasskeyOptions>("/api/admin/passkeys/authentication/options", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}"
  }),
  verifyAdminPasskeyAuthentication: (requestId: string, response: unknown) =>
    jsonRequest<void>("/api/admin/passkeys/authentication/verify", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ requestId, response })
    }),
  requestOtp: (email: string) => jsonRequest<{ challengeId: string; delivery: "mock" | "email" }>("/api/auth/request-otp", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email })
  }),
  verifyOtp: (challengeId: string, code: string, displayName: string) =>
    jsonRequest<{ player: AuthPlayer }>("/api/auth/verify-otp", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ challengeId, code, displayName })
    }),
  updateProfile: (profile: ProfileUpdate) => jsonRequest<{ player: AuthPlayer }>("/api/profile", {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(profile)
  }),
  privateMatches: () => jsonRequest<PrivateMatchOverview>("/api/private-matches"),
  privateMatch: async (roomCode: string) => privateRoomResponse(await jsonRequest<unknown>(
    `/api/private-matches/${encodeURIComponent(roomCode)}`
  )),
  createPrivateMatch: async (playerCount: PlayerCount, inviteEmails: string[]) => privateRoomResponse(
    await jsonRequest<unknown>("/api/private-matches", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ playerCount, inviteEmails })
    })
  ),
  acceptPrivateMatch: async (roomCode: string) => privateRoomResponse(await jsonRequest<unknown>(
    `/api/private-matches/${encodeURIComponent(roomCode)}/accept`,
    { method: "POST" }
  )),
  cancelPrivateMatch: async (roomCode: string) => {
    const response = await fetch(`/api/private-matches/${encodeURIComponent(roomCode)}/cancel`, {
      method: "POST",
      credentials: "same-origin"
    });
    if (response.ok) return;
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Could not cancel the private table.");
  },
  logout: () => fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }),
  rankings: (composition?: RankingComposition) => jsonRequest<CollectionResponse<"rankings", RankingEntry>>(
    `/api/rankings${composition ? `?composition=${composition}` : ""}`
  ),
  aiPlayers: (signal?: AbortSignal) => jsonRequest<AiPlayerRoster>("/api/ai/players", signal ? { signal } : undefined),
  startAiMatch: (agentIds: string[], broadcast = false) => jsonRequest<{ gameId: string; gameName?: string }>("/api/ai/matches", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ agentIds, ...(broadcast ? { broadcast: true } : {}) })
  }),
  startAdminAiMatch: (agentIds: string[], broadcast = false) => jsonRequest<{ gameId: string; gameName?: string }>("/api/admin/ai/matches", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ agentIds, ...(broadcast ? { broadcast: true } : {}) })
  }),
  matchHistory: (signal?: AbortSignal) => jsonRequest<CollectionResponse<"games", MatchHistoryEntry>>(
    "/api/me/history",
    signal ? { signal } : undefined
  ),
  gameReplay: (gameName: string) => jsonRequest<GameReplay | { replay: GameReplay }>(gamePath(gameName, "replay")),
  gameChat: (gameName: string) => jsonRequest<
    ChatMessage[] | { messages: ChatMessage[]; remaining?: number }
  >(gamePath(gameName, "chat")),
  postGameChat: (gameName: string, message: string, clientMessageId: string) => jsonRequest<
    { message: ChatMessage; remaining?: number } | { messages: ChatMessage[]; remaining?: number }
  >(gamePath(gameName, "chat"), {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ message, clientMessageId })
  }),
  adminOverview: () => jsonRequest<AdminOverview | { overview: AdminOverview }>("/api/admin/overview"),
  adminUsers: ({ q, limit, cursor }: { q?: string; limit?: number; cursor?: string } = {}) => {
    const parameters = new URLSearchParams();
    if (q) parameters.set("q", q);
    if (limit !== undefined) parameters.set("limit", String(limit));
    if (cursor) parameters.set("cursor", cursor);
    const query = parameters.toString();
    return jsonRequest<AdminUsersResponse>(`/api/admin/users${query ? `?${query}` : ""}`);
  },
  adminGames: () => jsonRequest<CollectionResponse<"games", AdminGame>>("/api/admin/games"),
  adminGame: (gameName: string) => jsonRequest<AdminGameDetail | { detail: AdminGameDetail }>(
    `/api/admin/games/${encodeURIComponent(gameName)}`
  ),
  setAdminUserSuspension: (userId: string, suspended: boolean, reason: string | null) =>
    jsonRequest<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(userId)}/suspension`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ suspended, reason })
    })
};
