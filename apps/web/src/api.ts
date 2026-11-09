import type {
  Card,
  MatchType,
  PlayerCount,
  PrivateInvitation,
  PrivateRoom,
  ProfileBadgeId
} from "@trinitymatrix/protocol";

const jsonHeaders = { "Content-Type": "application/json" };

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
  if (!response.ok) throw new Error(body?.error ?? "The request failed.");
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
  rankings: () => jsonRequest<CollectionResponse<"rankings", RankingEntry>>("/api/rankings"),
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
