import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateInvitation, PrivateRoom } from "@trinitymatrix/protocol";
import { useGameSocket } from "./useGameSocket";

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  completesCloseHandshake = true;
  readonly send = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    if (!this.completesCloseHandshake) {
      this.readyState = FakeWebSocket.CLOSING;
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

function sentMessages(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.send.mock.calls.map(([message]) => JSON.parse(String(message)) as Record<string, unknown>);
}

describe("useGameSocket", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for session.ready before reporting an authenticated connection", () => {
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;

    act(() => socket.open());
    expect(result.current.connection).toBe("connecting");

    act(() => socket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" }));
    expect(result.current.connection).toBe("connected");
    expect(result.current.playerId).toBe("player-1");
    unmount();
  });

  it("stops retrying and requests sign-in after a policy close", () => {
    vi.useFakeTimers();
    const authenticationRequired = vi.fn();
    const { result, unmount } = renderHook(() => useGameSocket(true, authenticationRequired));
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      socket.close(1008, "Authentication required");
    });
    expect(result.current.connection).toBe("authentication-required");
    expect(authenticationRequired).toHaveBeenCalledWith("Authentication required");

    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it("stops retrying when this account opens a newer game window", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      socket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
      socket.close(4001, "Session opened in another window");
    });
    expect(result.current.connection).toBe("session-replaced");
    expect(result.current.notice).toBe("Session opened in another window");

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it("keeps a healthy socket open when the server acknowledges its heartbeat", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
      vi.advanceTimersByTime(20_000);
    });

    const ping = sentMessages(socket).findLast(({ type }) => type === "ping")!;
    expect(ping.at).toEqual(expect.any(Number));
    act(() => {
      socket.receive({ type: "pong", at: ping.at });
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current.connection).toBe("connected");
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    unmount();
  });

  it("reconnects a half-open socket that can send but no longer receives pong", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => {
      firstSocket.open();
      firstSocket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
      vi.advanceTimersByTime(20_000);
    });

    expect(sentMessages(firstSocket).filter(({ type }) => type === "ping")).toHaveLength(1);
    expect(firstSocket.readyState).toBe(FakeWebSocket.OPEN);
    firstSocket.completesCloseHandshake = false;
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.connection).toBe("disconnected");
    expect(result.current.notice).toBe("Connection became unresponsive. Reconnecting…");
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSING);
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1_000));
    const secondSocket = FakeWebSocket.instances[1]!;
    act(() => {
      secondSocket.open();
      secondSocket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
    });
    expect(result.current.connection).toBe("connected");
    expect(result.current.connectionGeneration).toBe(2);
    unmount();
  });

  it("validates the existing socket on mobile visibility and online recovery without parallel reconnects", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let visibilityState: DocumentVisibilityState = "visible";
    let online = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const firstSocket = FakeWebSocket.instances[0]!;
    act(() => {
      firstSocket.open();
      firstSocket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      online = false;
      window.dispatchEvent(new Event("offline"));
      vi.advanceTimersByTime(60_000);
    });
    expect(sentMessages(firstSocket).filter(({ type }) => type === "ping")).toHaveLength(0);

    act(() => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sentMessages(firstSocket).filter(({ type }) => type === "ping")).toHaveLength(0);

    act(() => {
      online = true;
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(sentMessages(firstSocket).filter(({ type }) => type === "ping")).toHaveLength(1);

    const recoveryPing = sentMessages(firstSocket).findLast(({ type }) => type === "ping")!;
    act(() => firstSocket.receive({ type: "pong", at: recoveryPing.at }));
    expect(result.current.connection).toBe("connected");
    expect(result.current.notice).toBe("Connected.");

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(sentMessages(firstSocket).filter(({ type }) => type === "ping")).toHaveLength(2);

    act(() => vi.advanceTimersByTime(10_000));
    act(() => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    unmount();
  });

  it("publishes each authoritative chat message once from the shared game socket", () => {
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;
    const event = {
      type: "chat.message",
      gameName: "bright-lion-20260824",
      message: {
        id: "10000000-0000-4000-8000-000000000001",
        playerId: "10000000-0000-4000-8000-000000000002",
        displayName: "Kabir",
        message: "Good game!",
        createdAt: "2026-08-24T08:00:00.000Z"
      }
    };

    act(() => {
      socket.open();
      socket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
      socket.receive(event);
      socket.receive(event);
    });

    expect(result.current.realtimeChatMessages).toEqual([{
      gameName: event.gameName,
      message: event.message
    }]);
    unmount();
  });

  it("increments the connection generation after a successful reconnect", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const firstSocket = FakeWebSocket.instances[0]!;

    act(() => {
      firstSocket.open();
      firstSocket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
    });
    expect(result.current.connectionGeneration).toBe(1);

    act(() => firstSocket.close());
    expect(result.current.connection).toBe("disconnected");
    act(() => vi.advanceTimersByTime(1_000));
    const secondSocket = FakeWebSocket.instances[1]!;
    act(() => {
      secondSocket.open();
      secondSocket.receive({ type: "session.ready", playerId: "player-1", displayName: "One" });
    });

    expect(result.current.connectionGeneration).toBe(2);
    unmount();
  });

  it("submits authoritative showdown groups with the current game revision", () => {
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      socket.receive({ type: "session.ready", playerId: "player-2", displayName: "Kabir" });
      socket.receive({
        type: "game.started",
        gameId: "00000000-0000-4000-8000-000000000100",
        gameName: "amber-cobra-00000000",
        matchType: "general",
        playerCount: 2,
        players: [
          { id: "player-1", displayName: "Asha", badgeId: "rookie", connected: true, cardCount: 13, status: "declared" },
          { id: "player-2", displayName: "Kabir", badgeId: "strategist", connected: true, cardCount: 13, status: "playing" }
        ],
        currentPlayerId: "player-1",
        topDiscard: null,
        wildRank: 8,
        stockCount: 20,
        turnEndsAt: Date.now() - 1_000,
        phase: "showdown",
        showdown: {
          declarerId: "player-1",
          pendingPlayerIds: ["player-2"],
          submittedPlayerIds: [],
          endsAt: Date.now() + 30_000
        },
        revision: 7,
        toss: null,
        hand: []
      });
    });

    act(() => {
      expect(result.current.submitHand([["one", "two", "three"], ["four"]])).toBe(true);
    });

    expect(sentMessages(socket).findLast(({ type }) => type === "game.submit-hand")).toEqual({
      type: "game.submit-hand",
      groups: [["one", "two", "three"], ["four"]],
      commandId: expect.any(String),
      gameId: "00000000-0000-4000-8000-000000000100",
      expectedRevision: 7
    });
    unmount();
  });

  it("attaches the visible hand layout to draw, discard, and drop actions for future replay", () => {
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;
    const gameId = "00000000-0000-4000-8000-000000000100";
    const layout = [["s2", "s3", "s4"], ["c9"]];

    act(() => {
      socket.open();
      socket.receive({ type: "session.ready", playerId: "player-1", displayName: "Asha" });
      socket.receive({
        type: "game.started",
        gameId,
        gameName: "amber-cobra-00000000",
        matchType: "general",
        playerCount: 2,
        players: [
          { id: "player-1", displayName: "Asha", badgeId: "rookie", connected: true, cardCount: 13, status: "playing" },
          { id: "player-2", displayName: "Kabir", badgeId: "strategist", connected: true, cardCount: 13, status: "playing" }
        ],
        currentPlayerId: "player-1",
        topDiscard: null,
        wildRank: 8,
        stockCount: 20,
        turnEndsAt: Date.now() + 30_000,
        phase: "playing",
        showdown: null,
        revision: 4,
        toss: null,
        hand: []
      });
    });
    act(() => {
      result.current.draw("stock", layout);
      result.current.discard("c9", layout);
      result.current.dropGame(layout);
    });

    for (const type of ["game.draw", "game.discard", "game.drop"]) {
      expect(sentMessages(socket).findLast((message) => message.type === type)).toMatchObject({
        type,
        gameId,
        expectedRevision: 4,
        layout
      });
    }
    unmount();
  });

  it("tracks authoritative private invitations and waiting-room seat updates", () => {
    const { result, unmount } = renderHook(() => useGameSocket(true));
    const socket = FakeWebSocket.instances[0]!;
    const room: PrivateRoom = {
      roomCode: "amber-table-123456",
      playerCount: 2,
      status: "waiting",
      creator: { playerId: "00000000-0000-4000-8000-000000000001", displayName: "Asha" },
      invites: [{ seatNumber: 1, email: "kabir@example.com", status: "pending" }],
      acceptedCount: 1,
      requiredCount: 2,
      createdAt: "2026-08-24T09:00:00.000Z"
    };
    const invitation: PrivateInvitation = {
      roomCode: room.roomCode,
      playerCount: 2,
      creatorDisplayName: "Asha",
      status: "pending",
      createdAt: room.createdAt
    };

    act(() => {
      socket.open();
      socket.receive({ type: "session.ready", playerId: room.creator.playerId, displayName: "Asha" });
      result.current.openPrivateRoom(room);
      socket.receive({ type: "private.invitation", invitation });
      socket.receive({ type: "private.invitation", invitation });
    });
    expect(result.current.privateRoom?.acceptedCount).toBe(1);
    expect(result.current.privateInvitations).toEqual([invitation]);

    const acceptedRoom: PrivateRoom = {
      ...room,
      invites: [{ seatNumber: 1, email: "kabir@example.com", status: "accepted", playerId: "00000000-0000-4000-8000-000000000002", displayName: "Kabir" }],
      acceptedCount: 2
    };
    act(() => socket.receive({ type: "private.room-status", room: acceptedRoom }));
    expect(result.current.privateRoom).toEqual(acceptedRoom);
    expect(result.current.privateRoomUpdates).toEqual([acceptedRoom]);

    act(() => socket.receive({ type: "private.room-status", room: { ...acceptedRoom, status: "cancelled" } }));
    expect(result.current.privateRoom).toBeNull();
    expect(result.current.notice).toBe("The private table was cancelled.");
    unmount();
  });
});
