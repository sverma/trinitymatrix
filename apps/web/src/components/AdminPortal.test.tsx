import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPortal, isAdminLocation } from "./AdminPortal";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin portal", () => {
  it("selects the admin hosts or the /admin route on a custom deployment host", () => {
    expect(isAdminLocation({ hostname: "admin.staging.trinitymatrix.com", pathname: "/" })).toBe(true);
    expect(isAdminLocation({ hostname: "admin.trinitymatrix.com", pathname: "/games" })).toBe(true);
    expect(isAdminLocation({ hostname: "localhost", pathname: "/admin" })).toBe(true);
    expect(isAdminLocation({ hostname: "127.0.0.1", pathname: "/admin/games" })).toBe(true);
    expect(isAdminLocation({ hostname: "trinitymatrix.org", pathname: "/admin" })).toBe(true);
    expect(isAdminLocation({ hostname: "trinitymatrix.org", pathname: "/administrator" })).toBe(false);
    expect(isAdminLocation({ hostname: "localhost", pathname: "/" })).toBe(false);
  });

  it("requires an enrolled passkey instead of accepting a shared administrator code", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({
        authenticated: true,
        isAdmin: true,
        adminUnlocked: false,
        player: { id: "admin-1", email: "admin@example.com", displayName: "Admin", badgeId: "strategist", phone: null, createdAt: 1, updatedAt: 1 }
      }), { status: 200 });
      if (url === "/api/admin/passkeys/status") return new Response(JSON.stringify({ configured: true, credentialCount: 1, unlocked: false }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPortal />);

    expect(await screen.findByRole("heading", { name: "Use your administrator passkey" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with passkey" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/administrator access code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI arena" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/ai/players")).toBe(false);
  });

  it("offers AI-only matches only inside the unlocked administrator workspace", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ authenticated: true, isAdmin: true, adminUnlocked: true, player: { id: "admin-1", email: "admin@example.com", displayName: "Admin", badgeId: "strategist", phone: null, createdAt: 1, updatedAt: 1 } }), { status: 200 });
      if (url === "/api/admin/overview") return new Response(JSON.stringify({ totalUsers: 0, totalGames: 0, activeGames: 0, completedGames: 0 }), { status: 200 });
      if (url === "/api/ai/players") return new Response(JSON.stringify({ enabled: false, players: [], dailyBudgetUsd: 10 }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPortal />);
    await user.click(await screen.findByRole("button", { name: "AI arena" }));
    expect(await screen.findByRole("heading", { name: "AI arena" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "AI players are unavailable" })).toBeInTheDocument();
  });

  it("shows a one-time bootstrap flow only before the first passkey exists", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({
        authenticated: true,
        isAdmin: true,
        adminUnlocked: false,
        player: { id: "admin-1", email: "admin@example.com", displayName: "Admin", badgeId: "strategist", phone: null, createdAt: 1, updatedAt: 1 }
      }), { status: 200 });
      if (url === "/api/admin/passkeys/status") return new Response(JSON.stringify({ configured: false, credentialCount: 0, unlocked: false }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPortal />);

    expect(await screen.findByRole("heading", { name: "Create your administrator passkey" })).toBeInTheDocument();
    expect(screen.getByLabelText("One-time bootstrap code")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Device label")).toBeRequired();
  });

  it("navigates overview, users, games, and complete game details", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ authenticated: true, isAdmin: true, adminUnlocked: true, player: { id: "p1", email: "asha@example.com", displayName: "Asha", badgeId: "rookie", phone: null, createdAt: 1, updatedAt: 1 } }), { status: 200 });
      if (url === "/api/admin/overview") return new Response(JSON.stringify({ totalUsers: 24, totalGames: 81, activeGames: 2, activeGeneralMatches: 1, activePrivateMatches: 1, waitingPrivateRooms: 3, completedGames: 79, totalChatMessages: 16 }), { status: 200 });
      if (url === "/api/admin/users?limit=25") return new Response(JSON.stringify({ users: [{ id: "p1", email: "asha@example.com", displayName: "Asha", status: "active", gamesPlayed: 10, wins: 7, createdAt: "2026-08-01T08:00:00Z" }], nextCursor: null, total: 1 }), { status: 200 });
      if (url === "/api/admin/games") return new Response(JSON.stringify({ games: [{ gameName: "rank-2048", matchType: "general", status: "finished", playerCount: 2, players: [{ playerId: "p1", displayName: "Asha" }, { playerId: "p2", displayName: "Kabir" }], winnerName: "Asha", startedAt: "2026-08-23T08:00:00Z", finishedAt: "2026-08-23T08:02:00Z", eventCount: 2, chatMessageCount: 1 }] }), { status: 200 });
      if (url === "/api/admin/games/rank-2048") return new Response(JSON.stringify({ game: { gameName: "rank-2048", matchType: "general", status: "finished", playerCount: 2, players: [{ playerId: "p1", displayName: "Asha" }, { playerId: "p2", displayName: "Kabir" }], winnerName: "Asha", startedAt: "2026-08-23T08:00:00Z", finishedAt: "2026-08-23T08:02:00Z" }, events: [{ sequence: 1, at: "2026-08-23T08:00:00Z", type: "game.started", summary: "Cards were dealt." }], chatMessages: [{ id: "m1", playerId: "p2", displayName: "Kabir", message: "Good game!", createdAt: "2026-08-23T08:03:00Z" }] }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPortal />);

    expect(await screen.findByText("24")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "users" }));
    expect(await screen.findByRole("cell", { name: "asha@example.com" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "games" }));
    await user.click(await screen.findByRole("button", { name: "Inspect general match rank-2048" }));
    expect(await screen.findByRole("heading", { name: "rank-2048" })).toBeInTheDocument();
    expect(screen.getByText("Cards were dealt.")).toBeInTheDocument();
    expect(screen.getByText("Good game!")).toBeInTheDocument();
    expect(screen.getAllByText("Kabir")).toHaveLength(2);
  });

  it("searches all users by email and loads subsequent result pages", async () => {
    const user = userEvent.setup();
    const asha = { id: "p1", email: "asha@example.com", displayName: "Asha", status: "active", gamesPlayed: 10, wins: 7, createdAt: "2026-08-01T08:00:00Z" };
    const saurabh = { id: "p2", email: "7vssv7@gmail.com", displayName: "Saurabh", status: "offline", gamesPlayed: 3, wins: 1, createdAt: "2026-08-02T08:00:00Z" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ authenticated: true, isAdmin: true, adminUnlocked: true, player: { id: "admin-1", email: "admin@example.com", displayName: "Admin", badgeId: "strategist", phone: null, createdAt: 1, updatedAt: 1 } }), { status: 200 });
      if (url === "/api/admin/overview") return new Response(JSON.stringify({ totalUsers: 51, totalGames: 14, activeGames: 0, completedGames: 14 }), { status: 200 });
      if (url === "/api/admin/users?limit=25") return new Response(JSON.stringify({ users: [asha], nextCursor: "page-2", total: 51 }), { status: 200 });
      if (url === "/api/admin/users?limit=25&cursor=page-2") return new Response(JSON.stringify({ users: [saurabh], nextCursor: null, total: 51 }), { status: 200 });
      if (url === "/api/admin/users?q=7vssv7%40gmail.com&limit=25") return new Response(JSON.stringify({ users: [saurabh], nextCursor: null, total: 1 }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPortal />);

    await screen.findByText("Registered users");
    await user.click(screen.getByRole("button", { name: "users" }));
    expect(await screen.findByText("Showing 1 of 51 registered users.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 25 more users" }));
    expect(await screen.findByRole("cell", { name: "7vssv7@gmail.com" })).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 51 registered users.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search by name or email"));
    await user.type(screen.getByLabelText("Search by name or email"), " 7vssv7@gmail.com ");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Showing 1 of 1 users matching “7vssv7@gmail.com”.")).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "asha@example.com" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByRole("cell", { name: "asha@example.com" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search by name or email")).toHaveValue("");
  });

  it("summarizes and filters general matches and private rooms with invitation details", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") return new Response(JSON.stringify({ authenticated: true, isAdmin: true, adminUnlocked: true, player: { id: "admin-1", email: "admin@example.com", displayName: "Admin", badgeId: "strategist", phone: null, createdAt: 1, updatedAt: 1 } }), { status: 200 });
      if (url === "/api/admin/overview") return new Response(JSON.stringify({ totalUsers: 50, totalGames: 14, activeGames: 5, activeGeneralMatches: 3, activePrivateMatches: 2, waitingPrivateRooms: 1, completedGames: 9, totalChatMessages: 7 }), { status: 200 });
      if (url === "/api/admin/games") return new Response(JSON.stringify({ games: [
        { gameName: "general-table-00000001", matchType: "general", status: "playing", playerCount: 2, players: [{ playerId: "p1", displayName: "Asha" }, { playerId: "p2", displayName: "Kabir" }], startedAt: "2026-08-24T08:00:00Z", eventCount: 4 },
        { gameName: "invite-room-123456", matchType: "private", status: "waiting", playerCount: 6, players: [{ playerId: "creator-1", displayName: "Mira" }], startedAt: "2026-08-24T08:05:00Z", eventCount: 0, creator: { playerId: "creator-1", displayName: "Mira", email: "mira@example.com" }, invites: [{ email: "accepted@example.com", status: "accepted" }, { email: "pending@example.com", status: "pending" }] },
        { gameName: "private-table-00000002", matchType: "private", status: "finished", playerCount: 2, players: [{ playerId: "p3", displayName: "Noor" }, { playerId: "p4", displayName: "Dev" }], winnerName: "Noor", startedAt: "2026-08-24T07:00:00Z", finishedAt: "2026-08-24T07:10:00Z", eventCount: 12 }
      ] }), { status: 200 });
      if (url === "/api/admin/games/invite-room-123456") return new Response(JSON.stringify({ game: { gameName: "invite-room-123456", matchType: "private", status: "waiting", playerCount: 6, players: [{ playerId: "creator-1", displayName: "Mira" }], startedAt: "2026-08-24T08:05:00Z", eventCount: 0, creator: { playerId: "creator-1", displayName: "Mira", email: "mira@example.com" }, invites: [{ email: "accepted@example.com", status: "accepted", playerId: "accepted-1", displayName: "Asha" }, { email: "pending@example.com", status: "pending" }] }, events: [], chatMessages: [], replayAvailable: false }), { status: 200 });
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminPortal />);

    expect(await screen.findByText("Running general matches")).toBeInTheDocument();
    expect(screen.getByText("Running general matches").closest("article")).toHaveTextContent("3");
    expect(screen.getByText("Running private matches").closest("article")).toHaveTextContent("2");
    expect(screen.getByText("Waiting private rooms").closest("article")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "games" }));
    expect(await screen.findByRole("heading", { name: "Matches and private rooms" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /general-table-00000001 General match Playing/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /invite-room-123456 Private room Waiting/ })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Match type"), "private");
    expect(screen.queryByRole("row", { name: /general-table-00000001/ })).not.toBeInTheDocument();
    expect(screen.getByText("2 of 3 shown")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Status"), "waiting");
    expect(screen.getByText("1 of 3 shown")).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /private-table-00000002/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Inspect private room invite-room-123456" }));
    expect(await screen.findByRole("heading", { name: "invite-room-123456" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Room creator" })).toBeInTheDocument();
    expect(screen.getByText("mira@example.com")).toBeInTheDocument();
    const invitations = screen.getByRole("list", { name: "Private room invitations" });
    expect(invitations.getElementsByTagName("li")).toHaveLength(2);
    expect(screen.getByText("accepted@example.com").closest("li")).toHaveTextContent("Accepted");
    expect(screen.getByText("pending@example.com").closest("li")).toHaveTextContent("Pending");
    expect(screen.queryByText("No invitations are recorded for this room.")).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for invited players")).toBeInTheDocument();
  });

  it("refreshes current activity only while visible and online without overlaps or loading flashes", async () => {
    vi.useFakeTimers();
    let visible = true;
    let online = true;
    let overviewRevision = 0;
    let gamesRevision = 0;
    let deferNextGamesRequest = false;
    let resolveDeferredGames: ((response: Response) => void) | null = null;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);

    const gamesResponse = (revision: number) => new Response(JSON.stringify({ games: [{
      gameName: `general-live-${revision}`,
      matchType: "general",
      status: "playing",
      playerCount: 2,
      players: [{ playerId: "p1", displayName: "Asha" }, { playerId: "p2", displayName: "Kabir" }],
      startedAt: "2026-08-24T08:00:00Z",
      eventCount: revision
    }] }), { status: 200 });
    const fetchMock = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url === "/api/session") return Promise.resolve(new Response(JSON.stringify({ authenticated: true, isAdmin: true, adminUnlocked: true, player: { id: "admin-1", email: "admin@example.com", displayName: "Admin", badgeId: "strategist", phone: null, createdAt: 1, updatedAt: 1 } }), { status: 200 }));
      if (url === "/api/admin/overview") {
        overviewRevision += 1;
        return Promise.resolve(new Response(JSON.stringify({ totalUsers: 50, totalGames: 20, activeGames: overviewRevision, activeGeneralMatches: overviewRevision, activePrivateMatches: 0, waitingPrivateRooms: 0, completedGames: 19 }), { status: 200 }));
      }
      if (url === "/api/admin/games") {
        gamesRevision += 1;
        if (deferNextGamesRequest) {
          deferNextGamesRequest = false;
          return new Promise((resolve) => { resolveDeferredGames = resolve; });
        }
        return Promise.resolve(gamesResponse(gamesRevision));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const flushAsyncWork = async () => {
      await act(async () => {
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      });
    };
    const requestCount = (url: string) => fetchMock.mock.calls.filter(([input]) => String(input) === url).length;

    render(<AdminPortal />);
    await flushAsyncWork();
    expect(requestCount("/api/admin/overview")).toBe(1);
    expect(screen.getByText("Running general matches").closest("article")).toHaveTextContent("1");

    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(requestCount("/api/admin/overview")).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await flushAsyncWork();
    expect(requestCount("/api/admin/overview")).toBe(2);
    expect(screen.getByText("Running general matches").closest("article")).toHaveTextContent("2");

    visible = false;
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requestCount("/api/admin/overview")).toBe(2);
    visible = true;
    fireEvent(document, new Event("visibilitychange"));
    await flushAsyncWork();
    expect(requestCount("/api/admin/overview")).toBe(3);
    fireEvent(window, new Event("focus"));
    await flushAsyncWork();
    expect(requestCount("/api/admin/overview")).toBe(4);

    online = false;
    fireEvent(window, new Event("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(requestCount("/api/admin/overview")).toBe(4);
    online = true;
    fireEvent(window, new Event("online"));
    await flushAsyncWork();
    expect(requestCount("/api/admin/overview")).toBe(5);

    fireEvent.click(screen.getByRole("button", { name: "games" }));
    await flushAsyncWork();
    expect(requestCount("/api/admin/games")).toBe(1);
    expect(screen.getByRole("row", { name: /general-live-1/ })).toBeInTheDocument();

    deferNextGamesRequest = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(requestCount("/api/admin/games")).toBe(2);
    expect(screen.queryByText("Loading games…")).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /general-live-1/ })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(requestCount("/api/admin/games")).toBe(2);

    await act(async () => { resolveDeferredGames?.(gamesResponse(2)); });
    await flushAsyncWork();
    expect(screen.getByRole("row", { name: /general-live-2/ })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await flushAsyncWork();
    expect(requestCount("/api/admin/games")).toBe(3);
  });
});
