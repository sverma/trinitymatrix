import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostGameChat } from "./PostGameChat";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PostGameChat", () => {
  it("enforces non-empty 280-character messages and the three-message player limit", async () => {
    const user = userEvent.setup();
    const existing = [
      { id: "m1", playerId: "p1", displayName: "Asha", message: "Well played!", createdAt: "2026-08-23T08:00:00Z" },
      { id: "m2", playerId: "p1", displayName: "Asha", message: "That last draw was close.", createdAt: "2026-08-23T08:00:05Z" }
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({
        message: { id: "m3", playerId: "p1", displayName: "Asha", message: "Good game!", createdAt: "2026-08-23T08:00:10Z" },
        remaining: 0
      }), { status: 200 });
      return new Response(JSON.stringify({ messages: existing, remaining: 1 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<PostGameChat gameName="rank 2048" playerId="p1" />);

    expect(await screen.findByText("Well played!")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 left")).toBeInTheDocument();
    const textarea = screen.getByRole("textbox", { name: "Your message" });
    expect(textarea).toHaveAttribute("maxlength", "280");

    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Write a message before sending");
    await user.type(textarea, "Good game!");
    expect(screen.getByText("10 / 280 characters")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Message limit reached" })).toBeDisabled();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/games/rank%202048/chat", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"message":"Good game!"')
    }));
    const postBody = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(postBody.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("merges live messages without duplicates and reconciles missed messages after reconnect", async () => {
    const first = {
      id: "m1",
      playerId: "p1",
      displayName: "Asha",
      message: "Well played!",
      createdAt: "2026-08-24T08:00:00.000Z"
    };
    const live = {
      id: "m2",
      playerId: "p2",
      displayName: "Kabir",
      message: "That was a close finish.",
      createdAt: "2026-08-24T08:01:00.000Z"
    };
    const missed = {
      id: "m3",
      playerId: "p2",
      displayName: "Kabir",
      message: "See you at the next table.",
      createdAt: "2026-08-24T08:02:00.000Z"
    };
    let requests = 0;
    const fetchMock = vi.fn(async () => {
      requests += 1;
      return new Response(JSON.stringify({
        messages: requests === 1 ? [first] : [first, live, missed],
        remaining: 2
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<PostGameChat
      gameName="bright-lion-20260824"
      playerId="p1"
      connectionGeneration={1}
    />);
    expect(await screen.findByText("Well played!")).toBeInTheDocument();

    const realtimeMessages = [{ gameName: "bright-lion-20260824", message: live }];
    rerender(<PostGameChat
      gameName="bright-lion-20260824"
      playerId="p1"
      realtimeMessages={realtimeMessages}
      connectionGeneration={1}
    />);

    const liveBody = await screen.findByText("That was a close finish.");
    expect(screen.getAllByText("That was a close finish.")).toHaveLength(1);
    const liveTime = liveBody.closest("li")?.querySelector("time");
    expect(liveTime).toHaveAttribute("datetime", live.createdAt);
    expect(liveTime).not.toHaveTextContent("Time unavailable");
    expect(screen.getByText(`New message from Kabir: ${live.message}`)).toBeInTheDocument();

    rerender(<PostGameChat
      gameName="bright-lion-20260824"
      playerId="p1"
      realtimeMessages={[...realtimeMessages, ...realtimeMessages]}
      connectionGeneration={2}
    />);

    expect(await screen.findByText("See you at the next table.")).toBeInTheDocument();
    expect(screen.getAllByText("That was a close finish.")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the chat idempotency key after an ambiguous failed submission", async () => {
    const user = userEvent.setup();
    const postBodies: Array<{ message: string; clientMessageId: string }> = [];
    let postAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return new Response(JSON.stringify({ messages: [], remaining: 3 }), { status: 200 });
      }
      postBodies.push(JSON.parse(String(init.body)));
      postAttempts += 1;
      if (postAttempts === 1) throw new TypeError("The response was lost");
      return new Response(JSON.stringify({
        message: {
          id: "m-retry",
          playerId: "p1",
          displayName: "Asha",
          message: "Good game!",
          createdAt: "2026-08-24T08:04:00.000Z"
        },
        remaining: 2
      }), { status: 201 });
    }));

    render(<PostGameChat gameName="bright-lion-20260824" playerId="p1" />);
    const textarea = await screen.findByRole("textbox", { name: "Your message" });
    await user.type(textarea, "Good game!");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("response was lost");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText("Message sent.")).toBeInTheDocument();
    expect(postBodies).toHaveLength(2);
    expect(postBodies[1]!.clientMessageId).toBe(postBodies[0]!.clientMessageId);
  });

  it("shows a socket-delivered message without waiting for the initial history request", async () => {
    const live = {
      id: "m-live",
      playerId: "p2",
      displayName: "Kabir",
      message: "Visible immediately.",
      createdAt: "2026-08-24T08:03:00.000Z"
    };
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    render(<PostGameChat
      gameName="bright-lion-20260824"
      playerId="p1"
      realtimeMessages={[{ gameName: "bright-lion-20260824", message: live }]}
    />);

    expect(await screen.findByText("Visible immediately.")).toBeInTheDocument();
    expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument();
  });

  it("finds a persisted message through active-tab polling when its socket event was missed", async () => {
    vi.useFakeTimers();
    const persisted: Array<{
      id: string;
      playerId: string;
      displayName: string;
      message: string;
      createdAt: string;
    }> = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: persisted, remaining: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PostGameChat gameName="bright-lion-20260824" playerId="p1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("No messages yet. You can be the first to say good game.")).toBeInTheDocument();

    persisted.push({
      id: "m-persisted",
      playerId: "p2",
      displayName: "Kabir",
      message: "Recovered without a socket event.",
      createdAt: "2026-08-24T08:05:00.000Z"
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(screen.getByText("Recovered without a socket event.")).toBeInTheDocument();
    expect(screen.getByText("New message from Kabir: Recovered without a socket event.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden, refreshes on return/focus/online, and aborts when unmounted", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 4) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify({ messages: [], remaining: 3 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<PostGameChat gameName="bright-lion-20260824" playerId="p1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    act(() => window.dispatchEvent(new Event("online")));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    unmount();
    expect(signals.at(-1)?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
